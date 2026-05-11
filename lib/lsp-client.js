/**
 * LSP client — manages one language server subprocess using vscode-jsonrpc.
 *
 * Lifecycle per server:
 *   1. spawn(command, args) → child process with stdio pipes
 *   2. createMessageConnection(reader, writer) via vscode-jsonrpc
 *   3. sendRequest('initialize') → get ServerCapabilities
 *   4. sendNotification('initialized')
 *   5. Per-document: sendNotification('textDocument/didOpen') → queries →
 *      sendNotification('textDocument/didClose')
 *   6. On shutdown: sendRequest('shutdown') → sendNotification('exit') →
 *      kill process
 *
 * A per-client FIFO request queue prevents race conditions when multiple
 * queries arrive before the previous one completes.
 */
import { spawn } from "node:child_process";
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from "vscode-jsonrpc/node.js";

/**
 * @import { LspServerConfig } from "./types.js"
 * @import {
 *   InitializeResult,
 *   Hover,
 *   Location,
 *   CompletionItem,
 *   CompletionList,
 *   Diagnostic,
 *   SymbolInformation,
 *   LocationLink,
 * } from "vscode-languageserver-protocol"
 */

/** Timeout for LSP requests (10 seconds). */
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * @typedef {Object} LspClientOptions
 * @property {LspServerConfig} config - Server command and args
 * @property {string} extension - File extension this server handles
 */

export class LspClient {
  /**
   * @param {LspClientOptions} options
   */
  constructor(options) {
    this.config = options.config;
    this.extension = options.extension;

    /** @type {import("node:child_process").ChildProcess | null} */
    this._process = null;
    this._connection = null;
    this._capabilities = null;
    this._started = false;
    this._closed = false;

    /** Per-server FIFO request queue */
    this._queue = [];
    this._processing = false;

    /** Pending diagnostics per URI */
    /** @type {Map<string, Diagnostic[]>} */
    this._diagnosticsCache = new Map();

    /** Resolver for pending diagnostic requests */
    /** @type {Map<string, (diags: Diagnostic[]) => void>} */
    this._diagnosticResolvers = new Map();
  }

  /**
   * Start the language server subprocess and establish the JSON-RPC
   * connection.
   *
   * @returns {Promise<InitializeResult>}
   */
  async start() {
    if (this._started) {
      throw new Error(
        `LSP client for "${this.extension}" is already started`,
      );
    }

    const { command, args } = this.config;

    // Spawn the language server subprocess
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    this._process = child;

    // Handle stderr (most language servers log to stderr)
    child.stderr?.on("data", (data) => {
      if (process.env.LSP_DEBUG) {
        process.stderr.write(`[lsp:${this.extension} stderr] ${data}`);
      }
    });

    // Handle unexpected process exit
    child.on("exit", (code, signal) => {
      this._started = false;
      this._closed = true;
      this._connection = null;

      // Reject any diagnostic resolvers still pending
      for (const [, resolver] of this._diagnosticResolvers) {
        resolver([]);
      }
      this._diagnosticResolvers.clear();

      if (process.env.LSP_DEBUG) {
        process.stderr.write(
          `[lsp:${this.extension}] process exited code=${code} signal=${signal}\n`,
        );
      }
    });

    child.on("error", (err) => {
      this._started = false;
      this._closed = true;
      if (process.env.LSP_DEBUG) {
        process.stderr.write(
          `[lsp:${this.extension}] process error: ${err.message}\n`,
        );
      }
    });

    // Create JSON-RPC connection over stdio
    const reader = new StreamMessageReader(child.stdout);
    const writer = new StreamMessageWriter(child.stdin);
    const connection = createMessageConnection(reader, writer);

    // Listen for diagnostics published by the server
    connection.onNotification(
      "textDocument/publishDiagnostics",
      (params) => {
        const uri = params.uri;
        const diagnostics = params.diagnostics ?? [];
        this._diagnosticsCache.set(uri, diagnostics);

        // Resolve any pending diagnostic request for this URI
        const resolver = this._diagnosticResolvers.get(uri);
        if (resolver) {
          this._diagnosticResolvers.delete(uri);
          resolver(diagnostics);
        }
      },
    );

    connection.listen();
    this._connection = connection;

    // Send initialize request
    const initResult = /** @type {InitializeResult} */ (
      await this._request("initialize", {
        processId: process.pid,
        clientInfo: {
          name: "brick-lsp",
          version: "0.1.0",
        },
        capabilities: {
          textDocument: {
            hover: {
              dynamicRegistration: false,
              contentFormat: ["markdown", "plaintext"],
            },
            completion: {
              dynamicRegistration: false,
              completionItem: { snippetSupport: false },
            },
            definition: { dynamicRegistration: false },
            references: { dynamicRegistration: false },
            documentSymbol: { dynamicRegistration: false },
            synchronization: {
              dynamicRegistration: false,
              didSave: false,
              willSave: false,
            },
          },
        },
        ...(this.config.initializationOptions
          ? { initializationOptions: this.config.initializationOptions }
          : {}),
      })
    );

    this._capabilities = initResult.capabilities;
    this._started = true;

    // Send initialized notification
    this._sendNotification("initialized");

    return initResult;
  }

  /**
   * Open a document in the language server (textDocument/didOpen).
   *
   * @param {import("vscode-languageserver-textdocument").TextDocument}
   *   textDocument
   */
  didOpen(textDocument) {
    if (!this._started) return;
    this._sendNotification("textDocument/didOpen", {
      textDocument: {
        uri: textDocument.uri,
        languageId: textDocument.languageId,
        version: textDocument.version,
        text: textDocument.getText(),
      },
    });
  }

  /**
   * Close a document in the language server (textDocument/didClose).
   *
   * @param {string} uri
   */
  didClose(uri) {
    if (!this._started) return;
    this._sendNotification("textDocument/didClose", {
      textDocument: { uri },
    });
    this._diagnosticsCache.delete(uri);
  }

  // ─── LSP Queries ──────────────────────────────────────────────────────────

  /**
   * Request hover info at a position.
   *
   * @param {string} uri
   * @param {number} line - 0-based line
   * @param {number} character - 0-based character
   * @returns {Promise<Hover | null>}
   */
  async hover(uri, line, character) {
    return this._request("textDocument/hover", {
      textDocument: { uri },
      position: { line, character },
    });
  }

  /**
   * Request go-to-definition at a position.
   *
   * @param {string} uri
   * @param {number} line
   * @param {number} character
   * @returns {Promise<Location | Location[] | LocationLink[] | null>}
   */
  async goToDefinition(uri, line, character) {
    return this._request("textDocument/definition", {
      textDocument: { uri },
      position: { line, character },
    });
  }

  /**
   * Request code completions at a position.
   *
   * @param {string} uri
   * @param {number} line
   * @param {number} character
   * @returns {Promise<CompletionItem[] | CompletionList | null>}
   */
  async completion(uri, line, character) {
    return this._request("textDocument/completion", {
      textDocument: { uri },
      position: { line, character },
    });
  }

  /**
   * Request document symbols for a file.
   *
   * @param {string} uri
   * @returns {Promise<SymbolInformation[] | null>}
   */
  async documentSymbols(uri) {
    return this._request("textDocument/documentSymbol", {
      textDocument: { uri },
    });
  }

  /**
   * Request all references for a symbol at a position.
   *
   * @param {string} uri
   * @param {number} line
   * @param {number} character
   * @returns {Promise<Location[] | null>}
   */
  async findReferences(uri, line, character) {
    return this._request("textDocument/references", {
      textDocument: { uri },
      position: { line, character },
      context: { includeDeclaration: true },
    });
  }

  /**
   * Get diagnostics for a document.
   *
   * If no cached diagnostics exist, sends didOpen to trigger the server
   * and waits for the textDocument/publishDiagnostics notification.
   *
   * @param {string} uri
   * @returns {Promise<import("vscode-languageserver-protocol").Diagnostic[]>}
   */
  async getDiagnostics(uri) {
    // Check cache first
    const cached = this._diagnosticsCache.get(uri);
    if (cached !== undefined) {
      return cached;
    }

    // Wait for server to push diagnostics
    const diagnostics = await new Promise((resolve) => {
      this._diagnosticResolvers.set(uri, resolve);

      // Safety timeout
      setTimeout(() => {
        if (this._diagnosticResolvers.has(uri)) {
          this._diagnosticResolvers.delete(uri);
          resolve([]);
        }
      }, REQUEST_TIMEOUT_MS);
    });

    return diagnostics;
  }

  // ─── Queue & Connection Management ────────────────────────────────────────

  /**
   * Send a JSON-RPC request via the FIFO queue.
   *
   * @param {string} method
   * @param {*} params
   * @returns {Promise<*>}
   */
  async _request(method, params) {
    return new Promise((resolve, reject) => {
      this._queue.push({ method, params, resolve, reject });
      this._processQueue();
    });
  }

  /**
   * Process queued requests sequentially (FIFO).
   */
  async _processQueue() {
    if (this._processing || this._queue.length === 0) return;

    this._processing = true;

    while (this._queue.length > 0) {
      const item = this._queue.shift();
      if (!item) continue;

      if (!this._connection) {
        item.reject(
          new Error(
            `LSP client for "${this.extension}" is not connected`,
          ),
        );
        continue;
      }

      try {
        const result = await this._connection.sendRequest(
          item.method,
          item.params,
          REQUEST_TIMEOUT_MS,
        );
        item.resolve(result);
      } catch (err) {
        item.reject(err);
      }
    }

    this._processing = false;
  }

  /**
   * Send a one-way notification (fire-and-forget, not queued).
   *
   * @param {string} method
   * @param {*} params
   */
  _sendNotification(method, params) {
    if (!this._connection) return;
    try {
      this._connection.sendNotification(method, params);
    } catch {
      // Notifications are fire-and-forget; ignore send errors
    }
  }

  /**
   * Shut down the language server gracefully.
   */
  async shutdown() {
    if (!this._started) return;

    try {
      await this._request("shutdown");
    } catch {
      // Ignore shutdown errors
    }

    try {
      this._sendNotification("exit");
    } catch {
      // Ignore exit errors
    }

    this._started = false;
    this._closed = true;

    if (this._connection) {
      this._connection.dispose();
      this._connection = null;
    }

    if (this._process && !this._process.killed) {
      // Give the process a moment to exit gracefully, then force kill
      setTimeout(() => {
        if (this._process && !this._process.killed) {
          this._process.kill("SIGTERM");
        }
      }, 2000).unref();
    }
  }

  /**
   * Check if the client is currently connected and ready.
   *
   * @returns {boolean}
   */
  get isRunning() {
    return this._started && !this._closed;
  }
}