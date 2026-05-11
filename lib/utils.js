/**
 * Convert an absolute file path to a file:// URI.
 *
 * Handles spaces and special characters via percent-encoding.
 *
 * @param {string} filePath - Absolute path like "/home/user/project/src/index.ts"
 * @returns {string} - URI like "file:///home/user/project/src/index.ts"
 */
export function fileToUri(filePath) {
  if (!filePath) {
    throw new Error("filePath is required");
  }

  // Normalize separators (though on Linux this is already /)
  const normalized = filePath.replace(/\\/g, "/");

  // Ensure leading slash
  const withLeadingSlash = normalized.startsWith("/")
    ? normalized
    : `/${normalized}`;

  return `file://${encodeUriPath(withLeadingSlash)}`;
}

/**
 * Percent-encode a file path for use in a file:// URI.
 * Encodes every character except /, -, _, ., :, and alphanumerics.
 *
 * @param {string} path
 * @returns {string}
 */
function encodeUriPath(path) {
  let encoded = "";
  for (const ch of path) {
    if (
      ch === "/" ||
      ch === "-" ||
      ch === "_" ||
      ch === "." ||
      ch === ":" ||
      (ch >= "a" && ch <= "z") ||
      (ch >= "A" && ch <= "Z") ||
      (ch >= "0" && ch <= "9")
    ) {
      encoded += ch;
    } else {
      encoded += encodeURIComponent(ch);
    }
  }
  return encoded;
}

/**
 * Convert a file:// URI back to an absolute file path.
 *
 * @param {string} uri - URI like "file:///home/user/project/src/index.ts"
 * @returns {string} - File path like "/home/user/project/src/index.ts"
 */
export function uriToFile(uri) {
  if (!uri || !uri.startsWith("file://")) {
    throw new Error(`Not a file URI: ${uri}`);
  }
  return decodeURIComponent(uri.slice(7));
}

/**
 * Format an LSP location into a human-readable string.
 *
 * @param {import("vscode-languageserver-protocol").Location} location
 * @returns {string} - e.g. "src/index.ts:10:5"
 */
export function formatLocation(location) {
  const path = uriToFile(location.uri);
  const { line, character } = location.range.start;
  return `${path}:${line + 1}:${character + 1}`;
}

/**
 * Format an LSP DiagnosticSeverity number into a label string.
 *
 * @param {number | undefined} severity - DiagnosticSeverity enum value
 * @returns {string}
 */
export function severityLabel(severity) {
  switch (severity) {
    case 1:
      return "ERROR";
    case 2:
      return "WARNING";
    case 3:
      return "INFO";
    case 4:
      return "HINT";
    default:
      return "DIAGNOSTIC";
  }
}

/**
 * Group LSP diagnostics by severity and format them as a string.
 *
 * @param {import("vscode-languageserver-protocol").Diagnostic[]} diagnostics
 * @returns {string}
 */
export function formatDiagnostics(diagnostics) {
  if (!diagnostics || diagnostics.length === 0) {
    return "No diagnostics.";
  }

  // Group by severity
  /** @type {Record<number, import("vscode-languageserver-protocol").Diagnostic[]>} */
  const groups = {};
  for (const d of diagnostics) {
    const sev = d.severity ?? 4;
    if (!groups[sev]) groups[sev] = [];
    groups[sev].push(d);
  }

  const lines = [];
  for (const sev of [1, 2, 3, 4]) {
    const items = groups[sev];
    if (!items) continue;
    lines.push(`─ ${severityLabel(sev)} (${items.length}) ─`);
    for (const d of items) {
      const pos = `  ${d.range.start.line + 1}:${d.range.start.character + 1}`;
      const msg = d.message.replace(/\n/g, " ");
      const code = d.code ? ` [${String(d.code)}]` : "";
      const source = d.source ? ` (${d.source})` : "";
      lines.push(`${pos}  ${msg}${code}${source}`);
    }
  }

  return lines.join("\n");
}

/**
 * Format a completion item for display.
 *
 * @param {import("vscode-languageserver-protocol").CompletionItem} item
 * @returns {string}
 */
export function formatCompletionItem(item) {
  const label = item.label;
  const detail = item.detail ? ` — ${item.detail}` : "";
  const kind = item.kind ? ` [${completionKindLabel(item.kind)}]` : "";
  return `${label}${kind}${detail}`;
}

/**
 * Map LSP CompletionItemKind number to a short label.
 *
 * @param {number} kind
 * @returns {string}
 */
function completionKindLabel(kind) {
  const labels = {
    1: "Text",
    2: "Method",
    3: "Function",
    4: "Constructor",
    5: "Field",
    6: "Variable",
    7: "Class",
    8: "Interface",
    9: "Module",
    10: "Property",
    11: "Unit",
    12: "Value",
    13: "Enum",
    14: "Keyword",
    15: "Snippet",
    16: "Color",
    17: "File",
    18: "Reference",
    19: "Folder",
    20: "EnumMember",
    21: "Constant",
    22: "Struct",
    23: "Event",
    24: "Operator",
    25: "TypeParameter",
  };
  return labels[kind] ?? "Unknown";
}

/**
 * Format a SymbolInformation or DocumentSymbol for display.
 *
 * @param {import("vscode-languageserver-protocol").SymbolInformation} symbol
 * @returns {string}
 */
export function formatSymbol(symbol) {
  const kind = symbol.kind ? ` [${symbolKindLabel(symbol.kind)}]` : "";
  const loc = symbol.location
    ? ` at ${formatLocation(symbol.location)}`
    : "";
  const container = symbol.containerName ? ` (in ${symbol.containerName})` : "";
  return `${symbol.name}${kind}${container}${loc}`;
}

/**
 * Map LSP SymbolKind number to a short label.
 *
 * @param {number} kind
 * @returns {string}
 */
function symbolKindLabel(kind) {
  const labels = {
    1: "File",
    2: "Module",
    3: "Namespace",
    4: "Package",
    5: "Class",
    6: "Method",
    7: "Property",
    8: "Field",
    9: "Constructor",
    10: "Enum",
    11: "Interface",
    12: "Function",
    13: "Variable",
    14: "Constant",
    15: "String",
    16: "Number",
    17: "Boolean",
    18: "Array",
    19: "Object",
    20: "Key",
    21: "Null",
    22: "EnumMember",
    23: "Struct",
    24: "Event",
    25: "Operator",
    26: "TypeParameter",
  };
  return labels[kind] ?? "Unknown";
}