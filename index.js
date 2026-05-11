/**
 * extension-lsp MCP server entry point.
 *
 * JSON-RPC 2.0 over stdio implementing the Model Context Protocol.
 * Exposes 6 tools that delegate to LspManager:
 *   lsp_hover, lsp_go_to_definition, lsp_completion,
 *   lsp_diagnostics, lsp_document_symbols, lsp_find_references
 */
import { createInterface } from "node:readline";
import { LspManager } from "./lib/lsp-manager.js";
import { getSupportedExtensions } from "./lib/config.js";

const manager = new LspManager();

// ─── JSON-RPC 2.0 helpers ──────────────────────────────────────────────────

/**
 * Create a JSON-RPC success response.
 * @param {string|number} id
 * @param {*} result
 * @returns {string}
 */
function success(id, result) {
  return JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n";
}

/**
 * Create a JSON-RPC error response.
 * @param {string|number} id
 * @param {number} code
 * @param {string} message
 * @returns {string}
 */
function error(id, code, message) {
  return (
    JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n"
  );
}

// ─── Tool definitions ──────────────────────────────────────────────────────

const SUPPORTED_EXTENSIONS = getSupportedExtensions();

const TOOLS = [
  {
    name: "lsp_hover",
    description:
      "Get type information and documentation for a symbol at a given position. Returns the hover content (type signature + docstring) from the language server.",
    inputSchema: {
      type: "object",
      properties: {
        filePath: {
          type: "string",
          description: "Absolute path to the file",
        },
        line: {
          type: "number",
          description: "Line number (1-based)",
        },
        character: {
          type: "number",
          description: "Character offset (1-based)",
        },
      },
      required: ["filePath", "line", "character"],
    },
  },
  {
    name: "lsp_go_to_definition",
    description:
      "Navigate to the definition of a symbol at a position. Returns one or more file:line:col locations where the symbol is defined.",
    inputSchema: {
      type: "object",
      properties: {
        filePath: { type: "string", description: "Absolute path to the file" },
        line: { type: "number", description: "Line number (1-based)" },
        character: {
          type: "number",
          description: "Character offset (1-based)",
        },
      },
      required: ["filePath", "line", "character"],
    },
  },
  {
    name: "lsp_completion",
    description:
      "Get code completion suggestions at a position. Returns up to 30 completion items with labels, kinds, and details.",
    inputSchema: {
      type: "object",
      properties: {
        filePath: { type: "string", description: "Absolute path to the file" },
        line: { type: "number", description: "Line number (1-based)" },
        character: {
          type: "number",
          description: "Character offset (1-based)",
        },
      },
      required: ["filePath", "line", "character"],
    },
  },
  {
    name: "lsp_diagnostics",
    description:
      "Get all diagnostics (errors, warnings, info, hints) for a file. Results are grouped by severity level.",
    inputSchema: {
      type: "object",
      properties: {
        filePath: {
          type: "string",
          description: "Absolute path to the file",
        },
      },
      required: ["filePath"],
    },
  },
  {
    name: "lsp_document_symbols",
    description:
      "Get the symbol tree (classes, functions, variables, etc.) defined in a file.",
    inputSchema: {
      type: "object",
      properties: {
        filePath: {
          type: "string",
          description: "Absolute path to the file",
        },
      },
      required: ["filePath"],
    },
  },
  {
    name: "lsp_find_references",
    description:
      "Find all references to a symbol at a position across the project. Results are grouped by file.",
    inputSchema: {
      type: "object",
      properties: {
        filePath: { type: "string", description: "Absolute path to the file" },
        line: { type: "number", description: "Line number (1-based)" },
        character: {
          type: "number",
          description: "Character offset (1-based)",
        },
      },
      required: ["filePath", "line", "character"],
    },
  },
];

// ─── Request handler ───────────────────────────────────────────────────────

/**
 * Handle a parsed JSON-RPC request.
 * @param {{ jsonrpc: string, id: string|number, method: string, params?: * }} request
 */
async function handleRequest(request) {
  const { id, method, params } = request;

  switch (method) {
    // ── Lifecycle ────────────────────────────────────────────────────────

    case "initialize": {
      const protocolVersion = params?.protocolVersion ?? "2025-03-26";
      process.stdout.write(
        success(id, {
          protocolVersion,
          capabilities: {
            tools: {},
          },
          serverInfo: {
            name: "extension-lsp",
            version: "0.1.0",
          },
        }),
      );
      break;
    }

    case "notifications/initialized": {
      // No-op: LSP manager is lazily initialized
      break;
    }

    // ── Tool discovery ───────────────────────────────────────────────────

    case "tools/list": {
      process.stdout.write(success(id, { tools: TOOLS }));
      break;
    }

    // ── Tool execution ───────────────────────────────────────────────────

    case "tools/call": {
      const toolName = params?.name;
      const args = params?.arguments ?? {};

      try {
        const result = await executeTool(toolName, args);
        process.stdout.write(
          success(id, { content: [{ type: "text", text: result }] }),
        );
      } catch (err) {
        process.stdout.write(error(id, -32603, err.message));
      }
      break;
    }

    // ── Shutdown ─────────────────────────────────────────────────────────

    case "shutdown": {
      await manager.shutdown();
      process.stdout.write(success(id, null));
      break;
    }

    default:
      process.stdout.write(error(id, -32601, `Method not found: ${method}`));
  }
}

/**
 * Execute a tool by name with given arguments.
 *
 * @param {string} toolName
 * @param {Record<string, unknown>} args
 * @returns {Promise<string>}
 */
async function executeTool(toolName, args) {
  switch (toolName) {
    case "lsp_hover": {
      const { filePath, line, character } = /** @type {any} */ (args);
      return manager.hover(
        String(filePath),
        Number(line),
        Number(character),
      );
    }

    case "lsp_go_to_definition": {
      const { filePath, line, character } = /** @type {any} */ (args);
      return manager.goToDefinition(
        String(filePath),
        Number(line),
        Number(character),
      );
    }

    case "lsp_completion": {
      const { filePath, line, character } = /** @type {any} */ (args);
      return manager.completion(
        String(filePath),
        Number(line),
        Number(character),
      );
    }

    case "lsp_diagnostics": {
      const { filePath } = /** @type {any} */ (args);
      return manager.diagnostics(String(filePath));
    }

    case "lsp_document_symbols": {
      const { filePath } = /** @type {any} */ (args);
      return manager.documentSymbols(String(filePath));
    }

    case "lsp_find_references": {
      const { filePath, line, character } = /** @type {any} */ (args);
      return manager.findReferences(
        String(filePath),
        Number(line),
        Number(character),
      );
    }

    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}

// ─── Main loop ─────────────────────────────────────────────────────────────

const rl = createInterface({ input: process.stdin });

let buffer = "";
let pending = 0;

/**
 * Wrap handleRequest with pending-count tracking so we don't
 * exit before async handlers complete.
 */
function handleRequestSafe(request) {
  pending++;
  handleRequest(request)
    .catch((err) => {
      process.stdout.write(
        error(request.id ?? null, -32603, `Internal error: ${err.message}`),
      );
    })
    .finally(() => {
      pending--;
      if (rl.closed && pending === 0) {
        process.exit(0);
      }
    });
}

rl.on("line", (line) => {
  buffer += line;

  try {
    const request = JSON.parse(buffer);
    if (
      request &&
      typeof request === "object" &&
      request.jsonrpc &&
      request.method
    ) {
      buffer = "";
      handleRequestSafe(request);
    }
  } catch {
    // Not complete JSON yet, keep buffering
  }
});

rl.on("close", () => {
  if (pending === 0) {
    process.exit(0);
  }
});