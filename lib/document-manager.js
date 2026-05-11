/**
 * Document manager — tracks open file state for each LSP server.
 *
 * The LSP protocol requires `didOpen`/`didChange`/`didClose` notifications
 * so the server can maintain a correct document state for features like
 * diagnostics, completions, and go-to-definition.
 *
 * We use `TextDocument` from `vscode-languageserver-textdocument` to
 * manage the document content and versioning.
 */
import { TextDocument } from "vscode-languageserver-textdocument";

/**
 * @import { LspServerConfig } from "./types.js"
 */

/**
 * @typedef {Object} TrackedDocument
 * @property {TextDocument} textDocument - The vscode TextDocument instance
 * @property {string} uri - Document URI
 * @property {string} languageId - Language identifier (e.g. "typescript")
 * @property {number} version - Document version counter
 */

/**
 * Manages document state across all tracked files.
 * Each file URI maps to one TrackedDocument.
 */
export class DocumentManager {
  constructor() {
    /** @type {Map<string, TrackedDocument>} */
    this._docs = new Map();
  }

  /**
   * Open (or reopen) a document by reading its content from the filesystem.
   *
   * @param {string} uri - file:// URI
   * @param {string} languageId - Language identifier
   * @returns {Promise<TrackedDocument>}
   */
  async open(uri, languageId) {
    const filePath = uri.startsWith("file://")
      ? decodeURIComponent(uri.slice(7))
      : uri;
    const content = await readFileContent(filePath);

    const textDocument = TextDocument.create(uri, languageId, 1, content);

    /** @type {TrackedDocument} */
    const doc = { textDocument, uri, languageId, version: 1 };
    this._docs.set(uri, doc);
    return doc;
  }

  /**
   * Get a tracked document by URI.
   *
   * @param {string} uri
   * @returns {TrackedDocument | undefined}
   */
  get(uri) {
    return this._docs.get(uri);
  }

  /**
   * Check if a document is currently open/tracked.
   *
   * @param {string} uri
   * @returns {boolean}
   */
  has(uri) {
    return this._docs.has(uri);
  }

  /**
   * Close (remove) a tracked document.
   *
   * @param {string} uri
   * @returns {boolean} - true if the document was tracked
   */
  close(uri) {
    return this._docs.delete(uri);
  }

  /**
   * Increment the version and update the document content.
   *
   * Uses the TextDocument's built-in version management so the server
   * receives correct version numbers in didChange notifications.
   *
   * @param {string} uri - file:// URI
   * @param {string} newContent - Full file content after change
   * @returns {TrackedDocument | undefined}
   */
  update(uri, newContent) {
    const doc = this._docs.get(uri);
    if (!doc) return undefined;

    doc.version++;
    const newDoc = TextDocument.create(
      uri,
      doc.languageId,
      doc.version,
      newContent,
    );
    doc.textDocument = newDoc;
    return doc;
  }

  /**
   * Get all currently tracked URIs.
   *
   * @returns {string[]}
   */
  allUris() {
    return [...this._docs.keys()];
  }

  /**
   * Close all tracked documents.
   */
  closeAll() {
    this._docs.clear();
  }

  /**
   * Get the number of tracked documents.
   *
   * @returns {number}
   */
  get size() {
    return this._docs.size;
  }
}

/**
 * Read file content from disk. Returns the file as a UTF-8 string.
 *
 * @param {string} filePath
 * @returns {Promise<string>}
 */
async function readFileContent(filePath) {
  const fs = await import("node:fs/promises");
  return fs.readFile(filePath, "utf-8");
}