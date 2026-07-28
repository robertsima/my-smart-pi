# my-smart-pi

Shareable Pi harness package for a smarter local/API coding-agent setup.

Included behavior:

- tapered context compaction instead of late sawtooth-only compaction
- tool-output pruning after outputs have been consumed, with archived outputs readable by path
- lazy tool loading to keep active tool schemas small
- configurable Obsidian/vault autoindexing into `pi-vault-mind` collections
- global vault collection tools usable from any cwd
- global session memory tooling
- local Obsidian / markdown / session-documentation skills
- sanitized example settings and guardrails config

## Safety model

This repo is intended to be safe to share publicly.

It includes reusable harness code and example config. It does **not** include actual user data:

- no API keys or auth files
- no personal `~/.pi/agent/settings.json`
- no vault contents
- no LanceDB / `.vault-mind` state
- no JSONL collection data
- no session logs
- no tool-output archives
- no machine-specific guardrails allowlist

Review extensions before installing. Pi extensions run with local user permissions.

## Install

Recommended after branch lands on `main`:

```bash
pi install git:github.com/robertsima/my-smart-pi@main
```

Current working branch:

```bash
pi install git:github.com/robertsima/my-smart-pi@harness-package
```

Or from local checkout:

```bash
pi install /path/to/my-smart-pi
```

Then reload Pi:

```text
/reload
```

If older copies of included extensions exist in `~/.pi/agent/extensions`, disable/remove duplicates before installing this package. Duplicate extension names can register duplicate hooks/tools.

## Package contents

```text
extensions/
  global-vault-collections.ts  # configured vault-mind search/query/list/status from any cwd
  lazy-tools.ts                # keeps only core tools active; use load_tools to enable groups
  session-memory.ts            # global semantic session memory + session recall tools
  tapered-context.ts           # tapered compaction + tool-output archive/redaction
  vault-autoindex.ts           # configurable markdown autoindex into vault-mind collections
skills/
  defuddle/
  document-session-to-vault/
  json-canvas/
  obsidian-bases/
  obsidian-cli/
  obsidian-markdown/
config/
  AGENTS.example.md
  my-smart-pi.config.example.json
  settings.example.json
  guardrails/guardrails.example.json
```

## Required / recommended Pi packages

This harness assumes these packages are installed when you want all features:

```json
[
  "npm:pi-llama-switch",
  "npm:pi-caveman",
  "npm:@aliou/pi-guardrails",
  "npm:pi-web-access",
  "npm:pi-context",
  "npm:pi-vault-mind",
  "npm:@kylebrodeur/pi-model-discovery",
  "npm:@kylebrodeur/pi-model-router",
  "git:github.com/robertsima/my-smart-pi@harness-package"
]
```

See `config/settings.example.json` for sanitized settings skeleton. Do not commit real auth/model secrets.

## Configuration

Both `vault-autoindex.ts` and `global-vault-collections.ts` look for config in this order:

1. `MY_SMART_PI_CONFIG` environment variable
2. `<cwd>/.pi/my-smart-pi.config.json`
3. `<cwd>/my-smart-pi.config.json`
4. `~/.pi/agent/my-smart-pi.config.json`

Copy example and edit paths for your machine:

```bash
cp config/my-smart-pi.config.example.json ~/.pi/agent/my-smart-pi.config.json
```

Example:

```json
{
  "vaultAutoindex": {
    "vaultRoot": "<YOUR_VAULT_ROOT>",
    "watchRoots": ["Vault Mind", "AI Mind"],
    "vaultMindConfigPath": ".vault-mind/vault-mind.config.json",
    "statePath": ".vault-mind/autoindex-state.json",
    "defaultCollection": "notes",
    "collections": ["notes", "projects"],
    "collectionRules": [
      { "pattern": "^(AI Mind|Vault Mind)/Projects/", "collection": "projects" }
    ],
    "debounceMs": 2000,
    "maxChunkChars": 1500
  },
  "globalVaultCollections": {
    "vaultRoot": "<YOUR_VAULT_ROOT>",
    "vaultMindConfigPath": ".vault-mind/vault-mind.config.json",
    "promptLabel": "main vault"
  }
}
```

Useful environment variables:

```bash
PI_VAULT_ROOT=/path/to/vault
MY_SMART_PI_CONFIG=/path/to/my-smart-pi.config.json
PI_VAULT_MIND_LANCE_JS=/path/to/pi-vault-mind/dist/src/lance.js
PI_TOOL_OUTPUT_ARCHIVE_DIR=/path/to/tool-output-archive
```

## Commands and tools

### Tapered context

```text
/tapered-context
/tapered-context compact
```

Behavior:

- compacts earlier than Pi default
- keeps bounded raw tail that grows logarithmically
- merges older context into concise durable summaries
- archives old tool outputs and replaces consumed outputs with small stubs
- stubs include archive paths; agent can `read` exact old output if needed

### Lazy tool loading

Core tool stays active:

```text
load_tools(names=["vault"])
```

Groups include:

- `vault`
- `admin`
- `web`
- `context`

Also strips large embedding vectors from vault search/query results.

### Vault autoindex

Tool:

```text
vault_reindex(force=false)
```

Behavior:

- watches configured markdown roots for create/edit/delete
- chunks notes by headings/paragraphs
- indexes into configured `pi-vault-mind` collections
- deletes stale LanceDB rows by `source` before reindexing
- prunes deleted files during startup scans

Requires `pi-vault-mind` installed and configured.

### Global vault collection tools

Tools:

```text
vault_collection_search
vault_collection_query
vault_collection_list
vault_collection_status
```

Use when working outside the vault cwd but needing configured vault-mind collections.

### Session memory

Included extension provides global archived session memory tooling. It stores generated session-memory state locally under the user's Pi agent directory, not in this repo.

## Guardrails

`config/guardrails/guardrails.example.json` shows sanitized path access and read-only source-note policy. Copy it into the location expected by `@aliou/pi-guardrails` and replace placeholders:

- `<YOUR_VAULT_ROOT>`
- `<YOUR_PI_AGENT_DIR>`
- `<YOUR_NODE_OR_NPM_DIR>`
- `<USER_AUTHORED_NOTES_DIR>`

Do not commit personal allowlists if they reveal private paths.

## Different vault structures

Change `watchRoots` and `collectionRules`.

Example for a vault with `Notes/` and `Projects/`:

```json
{
  "vaultAutoindex": {
    "vaultRoot": "/Users/me/Vault",
    "watchRoots": ["Notes", "Projects"],
    "defaultCollection": "notes",
    "collections": ["notes", "projects"],
    "collectionRules": [
      { "pattern": "^Projects/", "collection": "projects" }
    ]
  },
  "globalVaultCollections": {
    "vaultRoot": "/Users/me/Vault"
  }
}
```

## Development workflow

```bash
git clone https://github.com/robertsima/my-smart-pi.git
cd my-smart-pi
git switch -c my-change
# edit extensions/config docs
git status
```

Test an extension without installing package globally:

```bash
pi -e ./extensions/tapered-context.ts
```

Use local package install while developing:

```bash
pi install /absolute/path/to/my-smart-pi
/reload
```

## Notes

- This package intentionally does not manage authentication.
- Keep personal model defaults and auth in `~/.pi/agent/settings.json` or project `.pi/settings.json`.
- Keep vault/user paths in local config, not in Git.
- Keep generated data out of Git; `.gitignore` excludes known state/index/archive paths.
