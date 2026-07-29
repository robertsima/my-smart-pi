# my-smart-pi

Windows-first Pi harness for mixed API and local-agent work. Planner and verifier use API models; implementer and reviewer use one machine-local `llama.cpp` server. Package also installs vault memory, context management, web research, reusable skills, diagnostics, and automatic Obsidian indexing.

## Fastest new-environment setup

### 1. Install prerequisites

Required:

- Windows PowerShell 5.1 or newer
- Git
- current Node.js LTS and npm
- [Pi coding agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent), available as `pi`
- API credentials for models assigned to planner and verifier
- `llama.cpp` with `llama-server.exe` and at least one GGUF model

Optional, for vault semantic search:

- Obsidian vault
- Ollama with `embeddinggemma`

```powershell
ollama pull embeddinggemma
```

### 2. Clone and bootstrap

```powershell
New-Item -ItemType Directory -Force "$HOME\.pi\agent\git\github.com\robertsima" | Out-Null
git clone https://github.com/robertsima/my-smart-pi.git `
  "$HOME\.pi\agent\git\github.com\robertsima\my-smart-pi"
cd "$HOME\.pi\agent\git\github.com\robertsima\my-smart-pi"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\bootstrap.ps1
```

Bootstrap prompts for machine-specific values on first run and saves them in gitignored `bootstrap.local.json`. It:

- installs pinned Pi packages and npm dependencies;
- seeds missing configuration under `~/.pi/agent`;
- installs this repository as a Pi package;
- applies guardrails and long prompt-cache retention;
- adds managed routing instructions without replacing user prompt content;
- leaves existing user configuration intact where possible.

Safe to rerun. Existing config files are not blindly overwritten.

### 3. Configure model routing

Bootstrap creates these machine-local files:

```text
~/.pi/agent/agent-routing.local.json
~/.pi/agent/model-switcher.json
```

Edit `agent-routing.local.json`:

```json
{
  "roles": {
    "planner": { "model": "openai-codex/YOUR_API_MODEL", "thinking": "high" },
    "verifier": { "model": "openai-codex/YOUR_API_MODEL", "thinking": "high" },
    "implementer": { "model": "llama-local/YOUR_LOCAL_MODEL", "thinking": "medium" },
    "reviewer": { "model": "llama-local/YOUR_LOCAL_MODEL", "thinking": "medium" }
  },
  "local": {
    "switchKey": "qwen",
    "maxParallel": 1
  },
  "forbiddenModelPatterns": [
    "ollama/qwen"
  ]
}
```

Rules:

- planner and verifier must use API-bound providers;
- implementer and reviewer must use `llama-local/*` models;
- `local.switchKey` must match a key in `model-switcher.json`;
- one local child at a time is enforced (`local.maxParallel` must equal `1`);
- unavailable pinned models fail instead of silently falling back.

Edit `model-switcher.json` with real `llama-server.exe`, GGUF, host, port, context, and GPU-layer values. Switch keys are machine-local aliases such as `qwen`; they are not provider/model IDs.

If `settings.json` contains a non-empty `enabledModels` allowlist, add every routed model ID to it. If `enabledModels` is absent or empty, Pi uses normal provider discovery.

Apply profile:

```powershell
cd "$HOME\.pi\agent\git\github.com\robertsima\my-smart-pi"
npm run apply-profile
```

Profile application also disables overlapping `pi-model-discovery` and `pi-model-router` extension entry points while retaining those packages. Harness-owned routing remains authoritative. `routingPolicy.apiProviders` allowlists API-role providers (currently `openai-codex`).

### 4. Authenticate and verify

Start Pi and authenticate required API providers:

```powershell
pi
```

Use `/login` inside Pi when needed. Then run installed-runtime diagnostics from another terminal:

```powershell
cd "$HOME\.pi\agent\git\github.com\robertsima\my-smart-pi"
npm run doctor
npm test
```

- `npm run doctor` checks active Pi package loading, API-provider and local-role bindings, runtime extension synchronization, the exact Lance/Arrow/subagent/UI package tuple, duplicate Arrow runtimes, local switcher paths, nested Fleet patches, and read-only Lance/embedding health.
- `npm test` runs isolated profile-install tests, including role-boundary rejection, role rendering, extension exclusions, and UTF-8 preservation.

If Pi was already running, run `/reload` or restart it.

## Start using harness

Ask Pi for work normally. Routing contract determines specialist placement:

| Role | Default execution boundary | Purpose |
|---|---|---|
| planner | API model | design and written implementation contract |
| verifier | API model | independent validation; no fixing |
| implementer | local `llama.cpp` model | code changes after approach is settled |
| reviewer | local `llama.cpp` model | first-pass code review |

Examples:

```text
Plan and implement this feature, then verify it.
Use Qwen to implement this settled plan.
Run independent verification before calling this done.
```

Parent agent retrieves bounded project memory before delegation. Child prompts receive only relevant findings and source paths. Only the API planner/lead descriptor can delegate; verifier, implementer, and reviewer descriptors are leaves. Nesting is capped at depth 2. Local child launch starts the configured server through its switch key. `extensions/harness-routing-guard.ts` enforces one `llama-local` child process-wide while API children use the configured concurrency of four. Model metadata and resulting changes must be checked before delegated work is accepted.

The standard compact Pi chrome is used; `pi-open-tui` is removed from generated dependencies and active packages. The single Fleet surface shows the live Agent → Helper → Helper tree with status, model, current tool, turns, tokens, and elapsed time. Use `Tab`/`Shift+Tab` on an empty prompt to cycle rows, `Enter` to open a conversation, or `/fleet` to focus it directly. Existing conversation steer/stop controls remain available.

Detailed contract: [`docs/AGENT_ROUTING.md`](docs/AGENT_ROUTING.md).

## Optional: Obsidian vault memory

Run `/vm setup` inside Pi, then confirm vault and embedding settings under:

```text
~/.pi/agent/vault-mind.config.json
<VAULT>/.vault-mind/vault-mind.config.json
~/.pi/agent/my-smart-pi.config.json
```

Default collection split:

- `notes`: personal, journal, career, finance, learning, and workflow notes;
- `projects`: notes under project folders;
- `main`: explicit durable facts appended by agent tools.

### Automatic indexing

`extensions/vault-autoindex.ts` watches configured Markdown roots and performs a startup scan. Registry lives at:

```text
<VAULT>/.vault-mind/autoindex-state.json
```

Behavior:

- changed files are chunked and embedded after debounce;
- registry entry updates only after successful indexing;
- failed files retain old state and retry on later scans;
- index signature tracks data directory, embedding settings, chunk size, schema, and collection rules;
- startup validates vector dimensions and FTS usability even when signature is unchanged;
- incompatible managed LanceDB tables are never dropped live; indexing pauses with a rebuild-required message;
- `vault_reindex(force=true)` requests an explicit offline rebuild and does not mutate tables;
- one process-global coordinator per canonical Lance data directory owns the watcher and serialized write queue, so nested sessions do not duplicate indexing;
- startup emits one compact summary (per-file successes require `logLevel: "debug"`);
- safe public `table.optimize()` maintenance runs only after the configured written-row threshold (`maintenanceMode: "safe"`).

Ask Pi:

```text
Show vault indexing status.
Reindex changed vault notes.
Force-rebuild vault indexes.
Search notes and projects for <topic>.
```

Verify both semantic and full-text paths, not only row counts:

```text
Search notes for a known phrase using semantic mode.
Search projects for a known phrase using FTS mode.
Search both using hybrid mode.
```

If vector dimensions changed or required FTS indexes are missing, Pi reports that an offline rebuild is required and changes nothing. Stop all Pi processes before any manual repair, take a backup, then restart Pi and run changed-note reindex. Registry entries advance only after confirmed indexing success. `npm run doctor` is read-only: it verifies canonical `dataDir`, schemas and 768-vector fields, notes/projects row counts versus autoindex state, FTS metadata/backlog, real vector+FTS queries, the Ollama embedding endpoint/model/dimension, backups, and competing non-empty Lance directories.

## Common maintenance

### Reapply managed profile

```powershell
npm run apply-profile
npm run doctor
```

Profile owns:

- pinned package entries declared in `config/harness-profile.json`;
- generated specialist descriptors under `~/.pi/agent/agents`;
- generated `subagents.json` entries;
- package extension filters;
- marked routing block in `APPEND_SYSTEM.md`;
- narrowly scoped installed-runtime patches, including the reproducible `@tintinweb/pi-subagents@0.14.3` patch in `scripts/patch-pi-subagents-0.14.3.mjs`.

Pinned runtime tuple: `pi-vault-mind@0.16.25`, `@lancedb/lancedb@0.33.0`, `apache-arrow@18.1.0`, and `@tintinweb/pi-subagents@0.14.3`. `pi-open-tui` is removed so standard compact Pi chrome loads.

Machine-local model choices remain in `agent-routing.local.json` and `model-switcher.json`; do not commit them.

### Upgrade package install

```powershell
pi update
npm run apply-profile
npm run doctor
npm test
```

### Bootstrap another vault or machine

Clone repository on new machine and rerun `bootstrap.ps1`. Copy no absolute-path config from old machine. Re-enter local paths and model IDs in generated machine-local files.

## Troubleshooting

### Doctor reports duplicate discovery/router extensions

Run:

```powershell
npm run apply-profile
```

Then `/reload`. Profile converts matching package entries to object form with exclusion filters.

### Local model does not start

Check:

- switch key exists in `model-switcher.json`;
- `llama-server.exe` and GGUF paths exist;
- configured port is free;
- child count does not exceed `local.maxParallel`;
- server log at `~/.pi/agent/llama-switch.log`.

Harness never replaces missing pinned local model with parent API model.

### Profile rejects routed model

Either correct model ID or add it to non-empty `settings.json.enabledModels`. API and local provider prefixes must match routing boundary.

### Vault search returns no project results

1. Confirm Ollama embedding service is running.
2. Run forced rebuild through `vault_reindex(force=true)`.
3. Restart Pi when reset is reported, then run changed-note reindex.
4. Inspect `<VAULT>/.vault-mind/autoindex-state.json` only after tool reports success.
5. Test `semantic`, `fts`, and `hybrid` searches separately.

### UTF-8 text becomes mojibake

Reapply current profile. PowerShell profile reads and writes JSON, templates, and managed prompt content explicitly as UTF-8 without BOM.

## Repository map

```text
agents/                         specialist descriptor templates
config/harness-profile.json     managed packages, dependencies, filters, patches
config/agent-routing.example.json
config/model-switcher.example.json
docs/AGENT_ROUTING.md           full routing contract
extensions/vault-autoindex.ts   watched vault indexing and compatibility recovery
scripts/apply-harness-profile.ps1
scripts/doctor.ps1
scripts/test-harness-profile.ps1
bootstrap.ps1                   first-run and repeatable environment setup
```

## Security

Bootstrap and profile scripts install packages, edit `~/.pi/agent`, patch selected installed files, and may set user environment variables. Review scripts and profile before execution. Keep API credentials, local paths, private vault content, and machine-local routing files out of Git.
