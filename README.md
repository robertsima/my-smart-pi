# my-smart-pi

Shareable Pi harness package for a smarter local/API coding-agent setup:

- tapered context compaction instead of late sawtooth-only compaction
- tool-output pruning after outputs have been consumed, with archived outputs readable by path
- lazy tool loading to keep active tool schemas small
- configurable Obsidian/vault autoindexing into `pi-vault-mind` collections

## Safety model

This repo is intended to be safe to share.

It includes only reusable harness code and example config. It does **not** include:

- API keys or auth files
- personal `~/.pi/agent/settings.json`
- vault contents
- LanceDB / `.vault-mind` state
- session logs
- tool-output archives

Review extensions before installing. Pi extensions run with local user permissions.

## Install

From GitHub:

```bash
pi install git:github.com/robertsima/my-smart-pi@harness-package
```

Or from a local checkout:

```bash
pi install /path/to/my-smart-pi
```

Then reload Pi:

```text
/reload
```

If you already have older copies of these extensions in `~/.pi/agent/extensions`, disable/remove duplicates before installing this package. Duplicate extension names can register duplicate hooks/tools.

## Package contents

```text
extensions/
  lazy-tools.ts        # keeps only core tools active; use load_tools to enable groups
  tapered-context.ts   # tapered compaction + tool-output archive/redaction
  vault-autoindex.ts   # configurable markdown autoindex into vault-mind collections
config/
  my-smart-pi.config.example.json
```

## Configuration

`vault-autoindex.ts` looks for config in this order:

1. `MY_SMART_PI_CONFIG` environment variable
2. `<cwd>/.pi/my-smart-pi.config.json`
3. `<cwd>/my-smart-pi.config.json`
4. `~/.pi/agent/my-smart-pi.config.json`

Copy the example and edit paths for your machine:

```bash
cp config/my-smart-pi.config.example.json ~/.pi/agent/my-smart-pi.config.json
```

Example:

```json
{
  "vaultAutoindex": {
    "vaultRoot": "D:/Vault",
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
- keeps a bounded raw tail that grows logarithmically
- merges older context into concise durable summaries
- archives old tool outputs and replaces consumed outputs with small stubs
- stubs include archive paths; the agent can `read` them if exact old output is needed

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

The extension also strips large embedding vectors from vault search/query results.

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

Use a local package install while developing:

```bash
pi install /absolute/path/to/my-smart-pi
/reload
```

## Notes

- This package intentionally does not manage authentication or model selection.
- Keep personal settings in `~/.pi/agent/settings.json` or project `.pi/settings.json`.
- Keep vault/user paths in local config, not in Git.
