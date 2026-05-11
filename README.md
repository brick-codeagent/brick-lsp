# Brick LSP Extension

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](package.json)

Language Server Protocol (LSP) integration for Brick — inline diagnostics, go-to-definition, completions, hover information, document symbols, and reference finding.

## Installation

```bash
brick install ./extension-lsp
```

> **Prerequisites**: You need language servers installed for the languages you work with:
> - **TypeScript/JavaScript**: `npm install -g typescript-language-server typescript`
> - **Python**: `pip install python-lsp-server`
> - **Go**: `go install golang.org/x/tools/gopls@latest`

## Tools

| Tool | Parameters | Returns |
|------|-----------|---------|
| `lsp_hover` | filePath, line, character | Type info + documentation |
| `lsp_go_to_definition` | filePath, line, character | Definition location(s) |
| `lsp_completion` | filePath, line, character | Up to 30 completion items |
| `lsp_diagnostics` | filePath | Errors/warnings grouped by severity |
| `lsp_document_symbols` | filePath | Symbol tree (classes, functions, etc.) |
| `lsp_find_references` | filePath, line, character | All references grouped by file |

## Configuration

Override language server commands per extension:

```bash
brick config lsp servers '{"py": {"command": "ruff-lsp", "args": []}}'
```

This merges on top of the built-in defaults. Use any JSON key matching a file extension pattern to add or override a server.

### Default Language Servers

| Extension | Server | Language ID |
|-----------|--------|-------------|
| `.ts`, `.tsx` | `typescript-language-server --stdio` | typescript, typescriptreact |
| `.js`, `.jsx` | `typescript-language-server --stdio` | javascript, javascriptreact |
| `.py` | `pylsp` | python |
| `.go` | `gopls` | go |

## How It Works

- Lazy server startup — language servers are spawned on first use per file extension
- Per-server FIFO request queue prevents LSP race conditions
- Full-document sync (v1) — simpler than incremental updates
- Diagnostics cached from server push notifications
- All LSP communication via `vscode-jsonrpc` — no VS Code dependency
- Graceful shutdown on exit