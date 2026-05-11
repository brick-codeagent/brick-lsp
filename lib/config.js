/**
 * @import { LspServerConfig } from "./types.js"
 */

/**
 * Default language server map: file extension → server command + language ID.
 *
 * Keys are extension patterns (".ts", ".py", etc.).
 * Users can override any entry via BRICK_CFG_SERVERS env var.
 *
 * @type {Record<string, LspServerConfig>}
 */
const DEFAULT_SERVERS = {
  ".ts": {
    command: "typescript-language-server",
    args: ["--stdio"],
    languageId: "typescript",
  },
  ".tsx": {
    command: "typescript-language-server",
    args: ["--stdio"],
    languageId: "typescriptreact",
  },
  ".js": {
    command: "typescript-language-server",
    args: ["--stdio"],
    languageId: "javascript",
  },
  ".jsx": {
    command: "typescript-language-server",
    args: ["--stdio"],
    languageId: "javascriptreact",
  },
  ".py": {
    command: "pylsp",
    args: [],
    languageId: "python",
  },
  ".go": {
    command: "gopls",
    args: [],
    languageId: "go",
  },
};

/**
 * Install hints shown when a language server is not found.
 * @type {Record<string, string>}
 */
const INSTALL_HINTS = {
  typescript: "npm install -g typescript-language-server typescript",
  typescriptreact: "npm install -g typescript-language-server typescript",
  javascript: "npm install -g typescript-language-server typescript",
  javascriptreact: "npm install -g typescript-language-server typescript",
  python: "pip install python-lsp-server",
  go: "go install golang.org/x/tools/gopls@latest",
};

/**
 * Parse and merge user-provided server overrides from the BRICK_CFG_SERVERS
 * environment variable (JSON string of `Record<string, LspServerConfig>`).
 *
 * The user overrides are merged on top of DEFAULT_SERVERS so they can:
 *  - Add new language entries (e.g. ".rs" for Rust)
 *  - Override existing entries (e.g. change the Python server)
 *
 * @returns {Record<string, LspServerConfig>}
 */
export function getServerConfig() {
  const raw = process.env.BRICK_CFG_SERVERS;
  if (!raw) {
    return { ...DEFAULT_SERVERS };
  }

  try {
    /** @type {Record<string, LspServerConfig>} */
    const overrides = JSON.parse(raw);
    if (typeof overrides !== "object" || overrides === null) {
      return { ...DEFAULT_SERVERS };
    }

    const merged = { ...DEFAULT_SERVERS };
    for (const [ext, cfg] of Object.entries(overrides)) {
      if (
        cfg &&
        typeof cfg === "object" &&
        typeof cfg.command === "string"
      ) {
        merged[ext] = {
          command: cfg.command,
          args: Array.isArray(cfg.args) ? [...cfg.args] : [],
          languageId:
            typeof cfg.languageId === "string"
              ? cfg.languageId
              : ext.replace(/^\./, ""),
        };
      }
    }
    return merged;
  } catch {
    // Invalid JSON override — fall back to defaults
    return { ...DEFAULT_SERVERS };
  }
}

/**
 * Find the server config for a given file path.
 *
 * Iterates extension patterns in longest-first order so ".tsx" matches
 * before ".ts".
 *
 * @param {string} filePath
 * @returns {{ config: LspServerConfig, extension: string } | null}
 */
export function matchServer(filePath) {
  const servers = getServerConfig();

  // Sort extensions longest-first so ".tsx" beats ".ts"
  const extensions = Object.keys(servers).sort(
    (a, b) => b.length - a.length,
  );

  for (const ext of extensions) {
    if (filePath.endsWith(ext)) {
      return { config: servers[ext], extension: ext };
    }
  }

  return null;
}

/**
 * Get the install hint for a language ID.
 * Falls back to a generic message if no hint is registered.
 *
 * @param {string} languageId
 * @returns {string}
 */
export function getInstallHint(languageId) {
  return (
    INSTALL_HINTS[languageId] ??
    `Install a language server for "${languageId}" and add it to your PATH`
  );
}

/**
 * Get a list of supported file extensions for display in help text.
 * @returns {string[]}
 */
export function getSupportedExtensions() {
  return Object.keys(DEFAULT_SERVERS).sort();
}