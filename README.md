# my-smart-pi

A reusable Pi harness: local + API model switching, Obsidian vault memory with
embeddings, and context management that degrades gracefully instead of falling
off a cliff.

This README is a setup guide. Start at [Quick start](#quick-start), then use
[Where do I change things?](#where-do-i-change-things) as your map.

---

## Quick start

**Windows:**

```powershell
git clone https://github.com/robertsima/my-smart-pi.git
cd my-smart-pi
.\bootstrap.ps1
```

First run asks three questions — your vault root, any extra directories Pi may
touch, and which vault subdirectory to keep read-only. Answers save to
`bootstrap.local.json` (gitignored), so every later run is zero-argument.

```powershell
.\bootstrap.ps1              # re-apply everything
.\bootstrap.ps1 -Reconfigure # change your answers
.\bootstrap.ps1 -SkipNpm     # skip dependency install (fast)
```

Then start Pi, or `/reload` if it was already running. Verify with `pi list` —
you should see `git:github.com/robertsima/my-smart-pi@main` alongside the npm
packages.

**Non-Windows** (no bootstrap script yet — do it by hand):

```bash
pi install git:github.com/robertsima/my-smart-pi@main
cp config/guardrails/guardrails.example.json ~/.pi/agent/extensions/guardrails.json
cp config/my-smart-pi.config.example.json    ~/.pi/agent/my-smart-pi.config.json
cp config/model-switcher.example.json        ~/.pi/agent/model-switcher.json
cp config/APPEND_SYSTEM.example.md           ~/.pi/agent/APPEND_SYSTEM.md
```

Replace the `<PLACEHOLDER>` values in each, then `/reload`.

### After a fresh install, do these two things

1. **Set your GGUF path.** A freshly seeded `model-switcher.json` points at
   `<PATH_TO_GGUF>`. No `llama-local/*` model works until you fix it.
2. **Check the guardrails allowlist.** Anything outside it is denied *with no
   prompt*. See [permissions](#permissions--what-pi-may-touch).

---

## Where do I change things?

| I want to… | File | Field |
|---|---|---|
| Change the default model | `~/.pi/agent/settings.json` | `defaultProvider`, `defaultModel` |
| Change which models show in the picker | `~/.pi/agent/settings.json` | `enabledModels[]` |
| Change thinking level | `~/.pi/agent/settings.json` | `defaultThinkingLevel` |
| **Add or tune a local llama model** | `~/.pi/agent/model-switcher.json` | `models.<key>` |
| **Point at a different GGUF file** | `~/.pi/agent/model-switcher.json` | `models.<key>.command` → `-m` |
| **Change the embedding model** | `<vaultRoot>/.vault-mind/vault-mind.config.json` | `vaultMind.embedding` |
| Auto-fallback / per-turn routing | `~/.pi/agent/model-router.json` | `profiles`, `rateLimitFallback` |
| API model catalog (costs, context sizes) | `~/.pi/agent/models-store.json` | auto-refreshed; rarely hand-edited |
| Change vault location | `~/.pi/agent/my-smart-pi.config.json` | `vaultRoot` (**both** sections) |
| Change which folders get indexed | `~/.pi/agent/my-smart-pi.config.json` | `watchRoots`, `collectionRules` |
| **What Pi may read/write** | `~/.pi/agent/extensions/guardrails.json` | `pathAccess.allowedPaths` |
| Make notes read-only | `~/.pi/agent/extensions/guardrails.json` | `policies.rules` |
| The agent's operating policy | `~/.pi/agent/APPEND_SYSTEM.md` | whole file |
| Compaction behaviour | `~/.pi/agent/settings.json` | `compaction`, `branchSummary` |
| Credentials | `~/.pi/agent/auth.json` | managed by Pi — never edit by hand |

---

## Config file reference

Everything lives in `~/.pi/agent/`. Each has a boilerplate under `config/` in
this repo, so a wiped agent directory is one `bootstrap.ps1` away from working.

### `settings.json` — Pi's main config

Provider, model, context, and the package list. **Merged, never overwritten** by
bootstrap: your provider/model/auth choices survive re-runs, and a timestamped
`.bak-` copy is written first.

```jsonc
{
  "defaultProvider": "openai-codex",   // which provider to start in
  "defaultModel": "gpt-5.5",           // which model within it
  "defaultThinkingLevel": "high",      // off | minimal | low | medium | high | xhigh | max
  "enabledModels": [                   // what appears in the Ctrl+P picker
    "llama-local/qwen",                //   <- key from model-switcher.json
    "openai-codex/gpt-5.5",            //   <- id from models-store.json
    "ollama/embeddinggemma:latest"
  ],
  "compaction": { "enabled": true, "reserveTokens": 8192, "keepRecentTokens": 16000 },
  "packages": [ /* ... */ ]
}
```

Model names are `provider/model`. The `llama-local/*` names come from the keys in
`model-switcher.json`; the API ones come from `models-store.json`.

### `model-switcher.json` — your local llama models

Each entry under `models` is a llama-server launch config. The key is the name
you reference as `llama-local/<key>`.

```jsonc
{
  "server": { "host": "127.0.0.1", "port": 8086 },
  "defaultModel": "qwen",
  "models": {
    "qwen": {                                  // -> llama-local/qwen
      "name": "Qwen3 30B Coder",
      "description": "Default / Balanced 54K", // shown in the picker
      "command": [
        "llama-server",
        "-m", "<PATH_TO_GGUF>",   // <- YOUR .gguf file goes here
        "-ngl", "all",            // layers on GPU ("all", or a number like 33)
        "--ctx-size", "65536",    // context window
        "-t", "8", "-tb", "16",   // CPU threads — match your core count
        "--temp", "0.7",
        "--port", "8086"
      ],
      "contextWindow": 65536,     // must match --ctx-size
      "maxTokens": 8192
    }
  }
}
```

**To add a model:** copy an existing block, rename the key, change `-m`, and add
`llama-local/<yourkey>` to `enabledModels` in `settings.json`.

**Tuning notes:** `-ngl` controls GPU offload — lower it if you run out of VRAM.
`--cpu-moe` (see the `qwen-lc-cpu-moe` preset) pushes mixture-of-experts layers
to CPU, trading speed for a much larger context. Keep `contextWindow` in sync
with `--ctx-size` or Pi will miscount your budget.

### `vault-mind.config.json` — embeddings and collections

**This one lives in your vault, not the agent dir:**
`<vaultRoot>/.vault-mind/vault-mind.config.json`. Its location is declared by
`vaultMindConfigPath` in `my-smart-pi.config.json`.

To change the embedding model:

```jsonc
"vaultMind": {
  "dataDir": "D:/Vault/.lancedb",
  "embedding": {
    "provider": "ollama",                     // embedding backend
    "ollamaModel": "embeddinggemma",          // <- CHANGE THE EMBEDDING MODEL HERE
    "ollamaHost": "http://127.0.0.1:11434"
  },
  "folders": { "inbox": "AI Mind", "journal": "AI Mind/Journal", /* ... */ }
}
```

> **Changing the embedding model invalidates your index.** Different models
> produce different vector dimensions, so existing LanceDB tables under
> `dataDir` will not match. Re-index with `vault_reindex(force=true)` after
> switching, and expect it to take a while on a large vault.

### `my-smart-pi.config.json` — vault paths and indexing

Read by `vault-autoindex.ts` and `global-vault-collections.ts`. Without it,
neither can find your vault.

```jsonc
{
  "vaultAutoindex": {
    "vaultRoot": "<YOUR_VAULT_ROOT>",
    "watchRoots": ["Vault Mind", "AI Mind"],   // folders to index
    "defaultCollection": "notes",
    "collections": ["notes", "projects"],
    "collectionRules": [                        // route by path -> collection
      { "pattern": "^(AI Mind|Vault Mind)/Projects/", "collection": "projects" }
    ],
    "debounceMs": 2000,
    "maxChunkChars": 1500
  },
  "globalVaultCollections": { "vaultRoot": "<YOUR_VAULT_ROOT>" }
}
```

Set `vaultRoot` in **both** sections. For a vault laid out as `Notes/` and
`Projects/`, use `"watchRoots": ["Notes", "Projects"]` with
`{ "pattern": "^Projects/", "collection": "projects" }`.

Config is resolved in this order: `MY_SMART_PI_CONFIG` env var →
`<cwd>/.pi/my-smart-pi.config.json` → `<cwd>/my-smart-pi.config.json` →
`~/.pi/agent/my-smart-pi.config.json`.

### `extensions/guardrails.json` — permissions

See [permissions](#permissions--what-pi-may-touch) below.

### `APPEND_SYSTEM.md` — the agent's operating policy

Appended to the system prompt. Defines the vault boundary, how to handle personal
notes, and when to reach for `vm_search` instead of grep. **Losing this file
produces no error** — the agent just quietly stops following your rules.

### `model-router.json` — automatic model selection *(optional)*

Global at `~/.pi/agent/model-router.json`, per-project at
`<cwd>/.pi/model-router.json` (project wins). Handles rate-limit fallback and
per-turn routing.

```jsonc
{
  "defaultProfile": "auto",
  "rateLimitFallback": {
    "enabled": true,
    "fallbackSequence": ["llama-local/qwen", "openai-codex/gpt-5.4-mini"]
  },
  "largeContextThreshold": 80000,
  "profiles": {
    "auto": {
      "default":  { "model": "llama-local/qwen", "thinking": "off" },
      "fallback": { "model": "openai-codex/gpt-5.4-mini", "thinking": "medium" }
    }
  }
}
```

If you're mysteriously pinned to one model, check for a project-scoped copy of
this file in your current working directory.

### `models-store.json` and `ollama-model-cache.json` — caches

Catalogs of available API and Ollama models, refreshed by
`@kylebrodeur/pi-model-discovery`. You rarely edit these — but if
`models-store.json` is empty (`{}`), **model switching silently does nothing**,
because there is no catalog to switch within.

### `auth.json` — credentials

Managed by Pi. **Never committed here, and nothing in this repo can regenerate
it.** Back it up separately.

---

## Permissions — what Pi may touch

`@aliou/pi-guardrails` reads `~/.pi/agent/extensions/guardrails.json`. This is a
**userland** allowlist: it is enforced by the extension, not by Windows, so being
an administrator makes no difference to it.

```jsonc
{
  "pathAccess": {
    "mode": "block",            // "block" = deny silently | "ask" = prompt
    "allowedPaths": [
      { "kind": "directory", "path": "D:\\Vault" },
      { "kind": "directory", "path": "C:\\Users\\you\\.pi" }
    ]
  },
  "policies": {
    "rules": [{
      "id": "vault-source-read-only",
      "patterns": [{ "pattern": "D:/Vault/Vault Mind" },
                   { "pattern": "D:/Vault/Vault Mind/**" }],
      "protection": "readOnly",
      "enabled": true
    }]
  }
}
```

Two things worth knowing:

- **`mode: "block"` denies with no prompt.** If a tool call fails for no visible
  reason, check this list first. Use `"ask"` if you'd rather be prompted.
- **A missing `guardrails.json` is worse than an empty one** — guardrails falls
  back to onboarding and blocks paths. This is the usual cause of "Pi suddenly
  lost its permissions" after a reinstall.

Add `AppData\Local\npm-cache` and `%TEMP%` to `allowedPaths` if you run
`npm install` through Pi.

Note the slash styles differ between the two sections in a known-working config:
`pathAccess.allowedPaths` uses Windows backslashes, `policies.patterns` uses
forward slashes. Copy that convention rather than normalising it.

---

## What the extensions do

| Extension | Behaviour |
|---|---|
| `tapered-context.ts` | Compacts earlier than Pi's default and keeps a bounded raw tail that grows logarithmically. Archives old tool outputs and leaves stubs containing the archive path, so the agent can `read` the original if needed. `/tapered-context [compact]` |
| `lazy-tools.ts` | Keeps a small always-active tool set and defers the rest behind `load_tools(names=["vault"])`. Groups: `vault`, `admin`, `web`, `context`. Also strips embedding vectors from search results. |
| `vault-autoindex.ts` | Watches `watchRoots` for changes, chunks notes by heading/paragraph, indexes into vault-mind collections, and prunes stale rows. `vault_reindex(force=false)` |
| `global-vault-collections.ts` | `vault_collection_search` / `_query` / `_list` / `_status` — vault memory from any working directory. |
| `session-memory.ts` | Archives settled sessions into a semantic store; adds `session_recall` and friends. State lives under the agent dir, not in this repo. |

Core tools (`read`, `bash`, `edit`, `write`, `ls`, `grep`, `find`,
`model_switch`, `load_tools`, and the vault collection tools) are always active.
If the agent claims it cannot run `bash`, that is not lazy-tools — see
troubleshooting.

Skills included: `defuddle`, `document-session-to-vault`, `json-canvas`,
`obsidian-bases`, `obsidian-cli`, `obsidian-markdown`.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| `[pi-llama-switch] No config found at ~/.pi/agent/model-switcher.json` | The file is missing. Re-run `bootstrap.ps1` to seed it, then set your GGUF path. |
| Model switching does nothing | `models-store.json` is `{}`. Re-run bootstrap; discovery repopulates it. |
| Paths denied with no prompt | `guardrails.json` missing, or the path isn't in `allowedPaths` with `mode: "block"`. |
| Agent ignores your rules | `APPEND_SYSTEM.md` is missing. It fails silently. |
| **Agent insists it's the "Broadcaster" (or Miner/Manager/Heavy-Lifter) and refuses to run `bash`** | pi-vault-mind's identity injector. See below. |
| Stuck on one model | Check for `<cwd>/.pi/model-router.json` overriding the global profile. |
| `Port 11435 in use` | An earlier Pi process still holds the vault-mind HTTP server. Indexing still works. |
| `'pgrep' is not recognized` | `pi-llama-switch` shells out to a Unix command. Harmless noise on Windows; llama-server detection won't work. |
| `archive snapshot error: ... ctx is stale` under `pi -p` | A shutdown race — Pi disposes the session before `agent_settled` lands. Interactive sessions are unaffected. `pi -p` is a poor smoke test here; it also trips "Agent is already processing". |
| LanceDB errors after an npm update | `apache-arrow` must stay at `18.1.0`. Tables written under 18 won't open against 21. Bootstrap pins it. |

### The forced identity boundary

If your agent announces that it is the **Broadcaster** — may read/write/edit and
search collections, must not run `bash`/`grep`/`find`, must write only under
`Agent/Presentations/` — it is not confabulating and it is not your
`APPEND_SYSTEM.md`. It is being told so, every single turn.

pi-vault-mind ships four per-role skills (`vault-mind-broadcaster`,
`-heavy-lifter`, `-manager`, `-miner`). Its identity injector hooks
`before_agent_start`, scans the loaded skills for one matching
`vault-mind-<role>`, and appends that role's `IDENTITY BOUNDARY` contract to the
**system prompt**.

Two things make this hard to diagnose:

- The system prompt is **not written to the session JSONL**, so grepping your
  sessions finds only the model's own replies — it looks self-inflicted.
- It is re-injected every turn, so it survives restarts, `/reload`, and
  restoring other config.

Those skills are meant to be chosen one at a time via `--agent vault-mind-<role>`.
A normal install discovers all four, and the detector takes the **first** match —
alphabetically `vault-mind-broadcaster`, the most restrictive of the set.

Fix, in `settings.json` (bootstrap adds this for you):

```jsonc
"skills": [
  "!vault-mind-broadcaster",
  "!vault-mind-heavy-lifter",
  "!vault-mind-manager",
  "!vault-mind-miner"
]
```

With no role skill loaded the detector returns nothing and no boundary is
injected. Exclude-only patterns are safe — when the include list is empty every
other path is kept, so nothing else is disabled. Drop a line to use that role
agent deliberately.

**Two things that will bite you:**

- **Never copy an old `settings.json` onto a new install.** It overwrites the
  `packages[]` entry `pi install` just wrote and re-introduces dead
  `extensions[]` paths. Run `bootstrap.ps1` instead.
- **Write config as UTF-8 without a BOM.** PowerShell 5.1's
  `Set-Content -Encoding utf8` emits one, and Pi's JSON parser rejects it with
  `Unexpected token '﻿'` — then falls back to empty config and may overwrite the
  file with a stub.

---

## Required packages

```json
[
  "npm:pi-llama-switch",  "npm:pi-caveman",
  "npm:@aliou/pi-guardrails", "npm:pi-web-access",
  "npm:pi-context", "npm:pi-vault-mind",
  "npm:@kylebrodeur/pi-model-discovery",
  "npm:@kylebrodeur/pi-model-router",
  "git:github.com/robertsima/my-smart-pi@main"
]
```

Bootstrap installs these and pins `apache-arrow` to `18.1.0`.

Environment variables, all optional:

```bash
PI_VAULT_ROOT=/path/to/vault
MY_SMART_PI_CONFIG=/path/to/my-smart-pi.config.json
PI_VAULT_MIND_LANCE_JS=/path/to/pi-vault-mind/dist/src/lance.js
PI_TOOL_OUTPUT_ARCHIVE_DIR=/path/to/tool-output-archive
```

---

## Safety model

Safe to share publicly. Contains harness code and sanitized example config only —
no API keys or auth files, no vault contents, no LanceDB/`.vault-mind` state, no
session logs, no tool-output archives, and no machine-specific allowlists.

Review extensions before installing; Pi extensions run with your user's
permissions.

## Development

```bash
git clone https://github.com/robertsima/my-smart-pi.git
cd my-smart-pi && git switch -c my-change

pi -e ./extensions/tapered-context.ts   # test one extension
pi install /absolute/path/to/my-smart-pi && /reload   # test the whole package
```

Keep personal paths in `bootstrap.local.json` or local config, never in Git.
`.gitignore` already excludes known state, index, and archive paths.
