# my-smart-pi

A ready-made setup for [Pi](https://github.com/earendil-works/pi-coding-agent) that gives you:

- **Local and cloud models side by side** — run Qwen on your own GPU, switch to GPT when you need it
- **Your Obsidian vault as memory** — notes get indexed automatically, and the agent searches them semantically instead of grepping around
- **Context that degrades gracefully** — long sessions compact smoothly instead of falling off a cliff

It's a bundle of Pi extensions plus the config to wire them together. One script sets it all up.

---

## Get running

```powershell
git clone https://github.com/robertsima/my-smart-pi.git
cd my-smart-pi
.\bootstrap.ps1
```

It'll ask you three things:

1. **Where's your vault?** — e.g. `D:\Vault`
2. **What else should Pi be allowed to touch?** — your code folders, usually
3. **Which vault folder should stay read-only?** — your hand-written notes, so the agent can read but never edit them

Your answers get saved, so from then on `.\bootstrap.ps1` with no arguments re-applies everything. Run it anytime something seems off — it's safe to repeat and it won't overwrite anything you've customised.

Then start Pi. (If it was already running, `/reload`.)

> **On a fresh machine, one more step:** if you want local models, open
> `~/.pi/agent/model-switcher.json` and replace `<PATH_TO_GGUF>` with the path to
> your actual `.gguf` file. Cloud models work without this.

Not on Windows? There's no bootstrap script yet — see [manual setup](#manual-setup).

---

## Where do I change things?

Everything lives in `~/.pi/agent/`. Here's the short version:

| To change… | Open… |
|---|---|
| Which model you start in | `settings.json` → `defaultModel` |
| Which models appear in the picker | `settings.json` → `enabledModels` |
| Your local llama models | `model-switcher.json` |
| **The embedding model** | `<your-vault>/.vault-mind/vault-mind.config.json` |
| Where your vault is / what gets indexed | `my-smart-pi.config.json` |
| What Pi is allowed to read and write | `extensions/guardrails.json` |
| The agent's standing instructions | `APPEND_SYSTEM.md` |

The rest of this section explains each one.

### Picking models — `settings.json`

```jsonc
{
  "defaultProvider": "openai-codex",
  "defaultModel": "gpt-5.5",
  "enabledModels": [
    "llama-local/qwen",        // from model-switcher.json
    "openai-codex/gpt-5.5"     // from your provider
  ]
}
```

Model names are always `provider/model`. Anything starting with `llama-local/`
comes from your `model-switcher.json`; the rest come from your cloud provider.

### Local models — `model-switcher.json`

Each entry is one way to launch llama-server. The key becomes the model name:

```jsonc
"models": {
  "qwen": {                          // -> you'd select "llama-local/qwen"
    "name": "Qwen3 30B Coder",
    "command": [
      "llama-server",
      "-m", "<PATH_TO_GGUF>",        // your model file
      "-ngl", "all",                 // how much to put on the GPU
      "--ctx-size", "65536",         // context window
      "-t", "8"                      // CPU threads
    ],
    "contextWindow": 65536           // keep this matching --ctx-size
  }
}
```

**Adding a model:** copy a block, rename the key, point `-m` at your file, then
add `llama-local/<yourkey>` to `enabledModels`.

**Running out of VRAM?** Lower `-ngl` (it's the number of layers on the GPU —
`"all"` or a number like `33`). The included `qwen-lc-cpu-moe` preset shows the
other lever: `--cpu-moe` pushes some layers to CPU so you can fit much more
context, at the cost of speed.

Three presets ship by default — a balanced one, a long-context one, and a
max-context one. They're tuned for one particular machine, so treat the thread
counts and layer numbers as starting points.

### Embeddings — `vault-mind.config.json`

This is the one that isn't in `~/.pi/agent/`. It lives **inside your vault**, at
`<your-vault>/.vault-mind/vault-mind.config.json`:

```jsonc
"embedding": {
  "provider": "ollama",
  "ollamaModel": "embeddinggemma",        // <- change this
  "ollamaHost": "http://127.0.0.1:11434"
}
```

> ⚠️ **Changing the embedding model means re-indexing.** Different models produce
> differently-shaped vectors, so your existing index won't match the new ones.
> Run `vault_reindex(force=true)` afterwards and give it time on a big vault.

### Your vault — `my-smart-pi.config.json`

Tells the harness where your notes are and which folders to index:

```jsonc
{
  "vaultAutoindex": {
    "vaultRoot": "D:/Vault",
    "watchRoots": ["Vault Mind", "AI Mind"],     // folders to index
    "collections": ["notes", "projects"],
    "collectionRules": [                          // sort notes into collections
      { "pattern": "^(AI Mind|Vault Mind)/Projects/", "collection": "projects" }
    ]
  },
  "globalVaultCollections": { "vaultRoot": "D:/Vault" }
}
```

Set `vaultRoot` in **both** places. Different vault layout? Just change
`watchRoots` and the rules — for a vault with `Notes/` and `Projects/` at the
top level, use `"watchRoots": ["Notes", "Projects"]` and match on `^Projects/`.

### Permissions — `extensions/guardrails.json`

A list of folders Pi may touch. Anything outside it is refused.

```jsonc
"pathAccess": {
  "mode": "block",        // "block" = refuse quietly, "ask" = prompt you
  "allowedPaths": [
    { "kind": "directory", "path": "D:\\Vault" },
    { "kind": "directory", "path": "D:\\Code" }
  ]
}
```

Three things worth knowing:

- **This has nothing to do with Windows permissions.** It's enforced by Pi
  itself, so running as administrator changes nothing here.
- **`"block"` refuses silently.** If a tool fails for no visible reason, this
  list is the first thing to check. Switch to `"ask"` if you'd rather be asked.
- **Keep the `/dev/null` entry.** Guardrails checks every shell redirect target
  as a path, and on Windows `2>/dev/null` resolves against the current drive —
  so a command run from `D:\` gets refused with
  `Access to D:\dev\null is blocked`. The grant is a `"file"` entry, so it
  resolves the same way and matches on whichever drive you're on.

If you run `npm install` through Pi, add your npm cache and temp folders too.

The second half of the file marks folders read-only — that's how "the agent can
read my notes but never edit them" is enforced. Note the slash styles differ
between the two halves (backslashes above, forward slashes in the read-only
rules); copy the existing style rather than tidying it up.

### Standing instructions — `APPEND_SYSTEM.md`

Plain markdown, appended to the agent's system prompt. Defines the vault
boundary, how to treat personal notes, and when to search memory instead of
grepping. Edit it like a document — it's meant to be read.

If this file goes missing you get **no error**; the agent just quietly stops
following your rules.

### The rest

- **`models-store.json`** and **`ollama-model-cache.json`** — catalogues of
  available models, refreshed automatically. You won't normally touch these, but
  if `models-store.json` ever becomes `{}`, model switching silently stops
  working because there's nothing to switch between.
- **`model-router.json`** *(optional)* — automatic fallback when you hit a rate
  limit, and per-turn model routing. If you're ever mysteriously stuck on one
  model, check whether a copy of this exists in your current project folder — a
  project-level one overrides the global.
- **`auth.json`** — your credentials. Managed by Pi, never in this repo, and
  **nothing here can regenerate it**. Back it up somewhere safe.

---

## What you get

| Extension | What it does |
|---|---|
| `tapered-context` | Compacts context gradually instead of all at once. Old tool output gets archived rather than dropped, and the agent can go read it if it needs to. |
| `lazy-tools` | Keeps the tool list small so the model isn't wading through dozens of schemas. Extra tools load on demand in groups (`vault`, `admin`, `web`, `context`). |
| `vault-autoindex` | Watches your notes and re-indexes them as you write. |
| `global-vault-collections` | Lets you search your vault from any folder, not just inside it. |
| `session-memory` | Remembers past sessions and can recall them semantically. |

Plus skills for Obsidian markdown, canvas, bases, and the Obsidian CLI.

---

## If something's broken

| What you're seeing | What it means |
|---|---|
| `No config found at ~/.pi/agent/model-switcher.json` | That file is missing. Re-run `bootstrap.ps1`, then set your GGUF path. |
| Model switching does nothing | Your model catalogue is empty. Re-run `bootstrap.ps1`. |
| Files won't open, no explanation | The path isn't in your guardrails allowlist. |
| `Access to D:\dev\null is blocked` | A `2>/dev/null` in a command. Your allowlist needs the `/dev/null` entry — see [Permissions](#permissions--extensionsguardrailsjson). |
| `400 ... unexpected tool_use_id found in tool_result blocks` | Something reordered the messages mid-tool-call. Fixed in `session-memory.ts`; if it comes back, suspect an extension's `context` handler. |
| Agent stops following your instructions | `APPEND_SYSTEM.md` is missing. Re-run `bootstrap.ps1`. |
| **Agent says it's the "Broadcaster" and won't run commands** | See below — this one's sneaky. |
| Stuck on one model | Check for a `.pi/model-router.json` in your project folder. |
| Weird LanceDB errors after an update | `apache-arrow` has to stay at 18.1.0. `bootstrap.ps1` pins it. |
| `Port 11435 in use` | An older Pi process is still running. Harmless — indexing still works. |
| `'pgrep' is not recognized` | A Unix command on Windows. Just noise. |

### "I'm the Broadcaster agent"

If your agent announces that it may only read, write and search — no `bash`, no
`grep`, output restricted to `Agent/Presentations/` — it isn't making that up,
and it isn't your `APPEND_SYSTEM.md`. It's being told so on every single turn.

`pi-vault-mind` includes four specialist sub-agents (Broadcaster, Miner, Manager,
Heavy-Lifter), each with its own restrictions. They're meant to be picked one at
a time. But a normal install loads all four, and the code that decides "which one
am I?" just takes the first it finds — which alphabetically is the Broadcaster,
the most restrictive of the bunch.

It's a pain to diagnose because the instruction goes into the system prompt,
which never gets written to your session log. Search your sessions and you'll
only find the agent's own replies, so it looks like it's imagining things. And
because it's re-applied every turn, restarting doesn't help.

The fix goes in your `packages` list, turning the `pi-vault-mind` entry from a
plain string into an object. `bootstrap.ps1` does this for you:

```jsonc
"packages": [
  {
    "source": "npm:pi-vault-mind",
    "skills": [
      "!skills/vault-mind-broadcaster/**",
      "!skills/vault-mind-heavy-lifter/**",
      "!skills/vault-mind-manager/**",
      "!skills/vault-mind-miner/**"
    ]
  }
]
```

With none of them loaded, nothing gets injected and your agent behaves normally.
Delete a line if you ever want to use that sub-agent deliberately.

> **It has to go here, not in a top-level `"skills"` list.** That list only
> controls loose skills you've dropped in `~/.pi/agent/skills/` — it never
> touches skills that came from an installed package, so putting the patterns
> there looks right and silently does nothing. Also never use an empty array:
> pi reads that as "disable every skill in this package".

There is a second leak: `pi-vault-mind`'s extension also exposes its whole
`skills/` directory through `resources_discover`, bypassing package filters.
`bootstrap.ps1` patches the installed `dist/src/index.js` to skip only the four
role skills there and disables the identity injector in normal sessions.

### Cache miss after a few minutes idle

Pi's default prompt cache retention is short. If you see notices like:

```text
Cache miss after 9m idle: 77k tokens re-billed
```

set long cache retention:

```powershell
[Environment]::SetEnvironmentVariable('PI_CACHE_RETENTION', 'long', 'User')
```

Then restart the terminal and Pi. `bootstrap.ps1` now does this automatically.
Long retention maps to OpenAI 24h prompt cache and Anthropic 1h prompt cache
where the provider/model supports it.

#### It can come back after you've fixed it

If the boundary returns in brand-new sessions even with the filter in place,
check your **vault**, not your config.

While the boundary was active, the agent wrote notes — into
`AI Mind/Agent/Presentations/`, because that's where the Broadcaster is told to
put things — and some of those notes describe the restriction as fact
("Broadcaster boundary blocks direct repo edit/commit"). Those notes get
auto-indexed, recalled into later sessions, and the agent reads its own old
description and puts the costume back on. The original cause is gone; the
residue re-infects.

Search your vault for the role name and reword anything you find:

```powershell
Get-ChildItem <vault> -Recurse -Include *.md |
  Select-String "Broadcaster" -SimpleMatch
```

Then re-index so the stale rows go away:

```text
vault_reindex(force=true)
```

Worth knowing generally: **anything the agent writes about its own limits
becomes training material for its future self.** A wrong note about
capabilities is stickier than a wrong config, because config gets fixed once
and notes get recalled forever.

### Two traps

**Don't copy an old `settings.json` onto a new install.** It wipes the package
list Pi just wrote and points at extensions that no longer exist. Run
`bootstrap.ps1` instead — it merges rather than replaces.

**Save config as UTF-8 *without* a BOM.** PowerShell's `Set-Content -Encoding utf8`
adds one, and Pi's JSON parser chokes on it — then falls back to empty config and
may overwrite your file with a stub. This is not hypothetical; it ate a working
`settings.json` during development.

**Don't leave several Pi instances running at once.** `settings.json` was
observed collapsing from 20 keys to 5 — losing the provider, model, and most of
`enabledModels` — while more than one Pi process was alive. The likeliest
explanation is one instance writing its older in-memory config over newer
changes on disk. Worth knowing before you go hunting for a config bug that isn't
there. `bootstrap.ps1` backs the file up before every write, so if this bites
you, the previous version is sitting next to it as `settings.json.bak-<time>`.

---

## Manual setup

No bootstrap script outside Windows yet. By hand:

```bash
pi install git:github.com/robertsima/my-smart-pi@main

cp config/guardrails/guardrails.example.json ~/.pi/agent/extensions/guardrails.json
cp config/my-smart-pi.config.example.json    ~/.pi/agent/my-smart-pi.config.json
cp config/model-switcher.example.json        ~/.pi/agent/model-switcher.json
cp config/APPEND_SYSTEM.example.md           ~/.pi/agent/APPEND_SYSTEM.md
```

Replace the `<PLACEHOLDER>` values in each, then `/reload`. Check it worked with
`pi list`.

You'll also want these packages, which bootstrap would have installed:
`pi-llama-switch`, `pi-caveman`, `@aliou/pi-guardrails`, `pi-web-access`,
`pi-context`, `pi-vault-mind`, `@kylebrodeur/pi-model-discovery`,
`@kylebrodeur/pi-model-router` — and `apache-arrow` pinned to exactly `18.1.0`.

Optional environment variables: `PI_VAULT_ROOT`, `MY_SMART_PI_CONFIG`,
`PI_VAULT_MIND_LANCE_JS`, `PI_TOOL_OUTPUT_ARCHIVE_DIR`.

---

## Recovering a broken setup

Every config file has a template in `config/`, so a wiped `~/.pi/agent/` is one
command away from working again:

```powershell
.\bootstrap.ps1
```

It only replaces files that are **missing or empty**. Anything you've customised
is left alone, and anything it does replace gets backed up first.

The one exception is `auth.json` — that's your credentials, it's deliberately not
in this repo, and nothing here can bring it back. Keep your own copy.

---

## Sharing and safety

This repo is safe to make public. It contains code and example config only — no
API keys, no vault contents, no search indexes, no session logs, and no personal
file paths. Your own paths live in `bootstrap.local.json`, which is gitignored.

Pi extensions run with your user's permissions, so read them before installing —
mine or anyone's.

## Working on it

```bash
git clone https://github.com/robertsima/my-smart-pi.git
cd my-smart-pi && git switch -c my-change

pi -e ./extensions/tapered-context.ts              # try one extension
pi install /absolute/path/to/my-smart-pi && /reload # try the whole thing
```
