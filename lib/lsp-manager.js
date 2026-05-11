/**
 * LSP manager — orchestrates LSP clients, document tracking, and query routing.
 *
 * Responsibilities:
 *  - Lazily starts LSP clients on first use per file extension
 *  - Routes queries to the correct client based on file extension
 *  - Manages document open/close lifecycle (didOpen before query, didClose
 *    after)
 *  - Caches and returns diagnostics
 *  - Handles errors with helpful messages (install hints, file-not-found, etc.)
 */
import { existsSync } from "node:fs";
import { LspClient } from "./lsp-client.js";
import { DocumentManager } from "./document-manager.js";
import {
  matchServer,
  getInstallHint,
  getSupportedExtensions,
} from "./config.js";
import {
  fileToUri,
  formatDiagnostics,
  formatLocation,
  formatCompletionItem,
  formatSymbol,
} from "./utils.js";

/**
 * @import { LspServerConfig } from "./types.js"
 * @import {
 *   Hover,
 *   Location,
 *   CompletionItem,
 *   CompletionList,
 *   SymbolInformation,
 *   Diagnostic,
 *   LocationLink,
 * } from "vscode-languageserver-protocol"
 */

export class LspManager {
  constructor() {
    /** @type {Map<string, LspClient>} */
    this._clients = new Map();

    /** @type {DocumentManager} */
    this._documents = new DocumentManager();
  }

  /**
   * Get or lazily start an LSP client for the given file path.
   *
   * @param {string} filePath - Absolute path to a source file
   * @returns {Promise<{client: LspClient, extension: string}>}
   */
  async _getOrStartClient(filePath) {
    const match = matchServer(filePath);
    if (!match) {
      const supported = getSupportedExtensions().join(", ");
      throw new Error(
        `No language server configured for "${filePath}". Supported extensions: ${supported}`,
      );
    }

    const { config, extension } = match;

    // Return existing client if already started
    const existing = this._clients.get(extension);
    if (existing && existing.isRunning) {
      return { client: existing, extension };
    }

    // Validate the server command exists on PATH
    await validateServerInstalled(
      config.command,
      extension,
      config.languageId,
    );

    // Start a new client
    const client = new LspClient({ config, extension });
    try {
      await client.start();
    } catch (err) {
      throw new Error(
        `Failed to start language server for "${extension}": ${err.message}`,
      );
    }

    this._clients.set(extension, client);
    return { client, extension };
  }

  /**
   * Ensure a document is open in the LSP server.
   *
   * @param {LspClient} client
   * @param {string} filePath
   * @returns {Promise<string>} - The document URI
   */
  async _ensureDocumentOpen(client, filePath) {
    const uri = fileToUri(filePath);

    if (!this._documents.has(uri)) {
      const config = matchServer(filePath);
      const languageId = config?.config.languageId ?? "plaintext";
      const doc = await this._documents.open(uri, languageId);
      client.didOpen(doc.textDocument);
    }

    return uri;
  }

  /**
   * Close a document in the LSP server.
   *
   * @param {LspClient} client
   * @param {string} uri
   */
  _closeDocument(client, uri) {
    if (this._documents.has(uri)) {
      client.didClose(uri);
      this._documents.close(uri);
    }
  }

  /**
   * Validate file exists.
   *
   * @param {string} filePath
   */
  _validateFile(filePath) {
    if (!filePath) {
      throw new Error("filePath is required");
    }
    if (!existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  /**
   * Get hover info (type + docstring) at a position.
   *
   * @param {string} filePath
   * @param {number} line - 1-based line number
   * @param {number} character - 1-based character offset
   * @returns {Promise<string>}
   */
  async hover(filePath, line, character) {
    this._validateFile(filePath);

    const { client } = await this._getOrStartClient(filePath);
    const uri = await this._ensureDocumentOpen(client, filePath);

    // Convert to 0-based for LSP
    const result = await client.hover(uri, line - 1, character - 1);

    this._closeDocument(client, uri);

    if (!result) {
      return "No hover information available.";
    }

    const parts = [];
    if (result.contents) {
      if (typeof result.contents === "string") {
        parts.push(result.contents);
      } else if (Array.isArray(result.contents)) {
        for (const item of result.contents) {
          if (typeof item === "string") {
            parts.push(item);
          } else if (item && typeof item.value === "string") {
            parts.push(item.value);
          }
        }
      } else if (
        result.contents &&
        typeof result.contents.value === "string"
      ) {
        parts.push(result.contents.value);
      }
    }

    if (result.range) {
      parts.push(
        `Range: ${result.range.start.line + 1}:${result.range.start.character + 1} – ${result.range.end.line + 1}:${result.range.end.character + 1}`,
      );
    }

    return parts.length > 0
      ? parts.join("\n\n")
      : "No hover information available.";
  }

  /**
   * Go to definition: find where a symbol is defined.
   *
   * @param {string} filePath
   * @param {number} line - 1-based
   * @param {number} character - 1-based
   * @returns {Promise<string>}
   */
  async goToDefinition(filePath, line, character) {
    this._validateFile(filePath);

    const { client } = await this._getOrStartClient(filePath);
    const uri = await this._ensureDocumentOpen(client, filePath);

    const result = await client.goToDefinition(
      uri,
      line - 1,
      character - 1,
    );

    this._closeDocument(client, uri);

    if (!result) {
      return "No definition found.";
    }

    // Handle single Location, array of Location, or array of LocationLink
    const locations = Array.isArray(result) ? result : [result];

    return locations.map(formatLocation).join("\n");
  }

  /**
   * Get code completion items at a position.
   *
   * @param {string} filePath
   * @param {number} line - 1-based
   * @param {number} character - 1-based
   * @returns {Promise<string>}
   */
  async completion(filePath, line, character) {
    this._validateFile(filePath);

    const { client } = await this._getOrStartClient(filePath);
    const uri = await this._ensureDocumentOpen(client, filePath);

    const result = await client.completion(uri, line - 1, character - 1);

    this._closeDocument(client, uri);

    if (!result) {
      return "No completions available.";
    }

    // CompletionList has an .items array; raw array is also valid
    const items = Array.isArray(result) ? result : result.items ?? [];

    if (items.length === 0) {
      return "No completions available.";
    }

    const formatted = items.slice(0, 30).map(formatCompletionItem);
    const summary =
      items.length > 30
        ? `\n... and ${items.length - 30} more`
        : "";

    return formatted.join("\n") + summary;
  }

  /**
   * Get diagnostics (errors, warnings, info) for a file.
   *
   * @param {string} filePath
   * @returns {Promise<string>}
   */
  async diagnostics(filePath) {
    this._validateFile(filePath);

    const { client } = await this._getOrStartClient(filePath);
    const uri = await this._ensureDocumentOpen(client, filePath);

    const diags = await client.getDiagnostics(uri);

    this._closeDocument(client, uri);

    return formatDiagnostics(diags);
  }

  /**
   * Get document symbols (structure/symbols tree) for a file.
   *
   * @param {string} filePath
   * @returns {Promise<string>}
   */
  async documentSymbols(filePath) {
    this._validateFile(filePath);

    const { client } = await this._getOrStartClient(filePath);
    const uri = await this._ensureDocumentOpen(client, filePath);

    const symbols = await client.documentSymbols(uri);

    this._closeDocument(client, uri);

    if (!symbols || symbols.length === 0) {
      return "No symbols found.";
    }

    return symbols.map(formatSymbol).join("\n");
  }

  /**
   * Find all references to a symbol at a position.
   *
   * @param {string} filePath
   * @param {number} line - 1-based
   * @param {number} character - 1-based
   * @returns {Promise<string>}
   */
  async findReferences(filePath, line, character) {
    this._validateFile(filePath);

    const { client } = await this._getOrStartClient(filePath);
    const uri = await this._ensureDocumentOpen(client, filePath);

    const references = await client.findReferences(
      uri,
      line - 1,
      character - 1,
    );

    this._closeDocument(client, uri);

    if (!references || references.length === 0) {
      return "No references found.";
    }

    // Group references by file
    /** @type {Map<string, string[]>} */
    const byFile = new Map();
    for (const ref of references) {
      const fileRef = formatLocation(ref);
      const filePathPart = fileRef.split(":")[0] ?? fileRef;
      const existing = byFile.get(filePathPart) ?? [];
      existing.push(fileRef);
      byFile.set(filePathPart, existing);
    }

    const lines = [];
    for (const [file, refs] of byFile) {
      lines.push(`─ ${file} ─`);
      for (const r of refs) {
        const pos = r.split(":").slice(1).join(":");
        lines.push(`  ${pos}`);
      }
    }

    return lines.join("\n");
  }

  /**
   * Shut down all LSP clients.
   */
  async shutdown() {
    const shutdowns = [];
    for (const [, client] of this._clients) {
      shutdowns.push(
        client.shutdown().catch(() => {
          /* ignore per-client shutdown errors */
        }),
      );
    }
    await Promise.all(shutdowns);
    this._clients.clear();
    this._documents.closeAll();
  }
}

/**
 * Validate that a language server command is available.
 *
 * Uses `which` (Unix) or `where` (Windows) to check PATH.
 *
 * @param {string} command
 * @param {string} extension
 * @param {string} languageId
 * @returns {Promise<void>}
 */
async function validateServerInstalled(command, extension, languageId) {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);

  const isWindows = process.platform === "win32";
  const checkCmd = isWindows ? "where" : "which";

  try {
    await execFileAsync(checkCmd, [command]);
  } catch {
    const hint = getInstallHint(languageId);
    throw new Error(
      `Language server "${command}" not found for ${extension} files.\nInstall: ${hint}`,
    );
  }
}