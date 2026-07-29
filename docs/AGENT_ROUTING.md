# Model-Agnostic Agent Routing

`my-smart-pi` defines role behavior, limits, patches, and verification. It does not choose model IDs.

Machine-specific bindings live outside Git at:

```text
~/.pi/agent/agent-routing.local.json
```

Copy `config/agent-routing.example.json`, then bind planner, verifier, implementer, and reviewer roles to models already present in local Pi configuration. `settings.json`, `model-switcher.json`, and `enabledModels` remain authoritative and are preserved.

## Contract

- API-capable role handles planning and independent verification through a provider allowlisted by `routingPolicy.apiProviders`.
- Machine-local role handles bounded implementation and first-pass review.
- Pinned unavailable model errors; it never inherits parent silently.
- One machine-local child at once; `extensions/harness-routing-guard.ts` enforces this for foreground and background `Agent` calls.
- Model-specific capability observations belong in vault knowledge, not harness defaults.
- Local `forbiddenModelPatterns` rejects unwanted agent model families without hard-coding them in project.

## Apply

```powershell
Copy-Item .\config\agent-routing.example.json "$HOME\.pi\agent\agent-routing.local.json"
# Edit machine-local bindings.
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\apply-harness-profile.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\doctor.ps1
```

Restart Pi after applying. If auto-index resets incompatible managed Lance tables, restart Pi before rebuilding so it opens fresh database handles. Do not manually rename or drop managed tables.
