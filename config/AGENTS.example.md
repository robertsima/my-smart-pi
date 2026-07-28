# AGENTS

## Purpose

Provide general-purpose technical assistance with optional vault knowledge management and agent orchestration.

Current user request takes priority over vault organization.

## Workspace

Configure these names for your vault before using:

- `<AI_WORKSPACE>/`: writable AI-authored notes, plans, prompts, agent tasks, and results
- `<USER_SOURCE>/`: read-only user-authored source material

Recommended default for an Obsidian vault:

- `AI Mind/`: writable AI workspace
- `Vault Mind/`: read-only user-authored source material

## Vault boundary

Never create, edit, rename, move, or delete anything under the user-authored source workspace. Store AI-generated notes under the AI workspace.

## Retrieval

Prefer vault-mind semantic search over raw grep/read when answering questions about prior notes, memories, or project knowledge.

Common collections:

- `notes`: personal/context notes
- `projects`: coding-project knowledge
- `main`: durable explicit memories/facts
- `session_memory`: archived Pi session chunks, if enabled

## Source mapping

When persistent AI work is based on a user-authored source note, create it in the corresponding category under the AI workspace and link the source note. Do not add backlinks by editing source notes.

Example:

```text
<UserSource>/Journal/2026-01-01.md
<AIWorkspace>/Journal/2026-01-01 - AI.md
```

## Note guidance

- Prefer concise, durable structures.
- Include exact file paths, commands, validation status, and next steps.
- Separate raw capture from conclusions when both are useful.
