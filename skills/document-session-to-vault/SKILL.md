---
name: document-session-to-vault
description: Use when user asks to document, save, memorialize, or capture useful information from the current/past conversation into the Obsidian vault. Creates concise AI-authored notes under AI Mind/ only, with decisions, implementation details, validation, and next steps.
---

# Document Session to Vault

Use this skill when user says things like:

- "Document useful information from this session into vault"
- "Save this conversation to my vault"
- "Write up what we did"
- "Capture decisions / implementation notes"
- "Make this reusable for future sessions"

## Rules

- Write only under `AI Mind/`.
- Never create, edit, move, rename, or delete anything under `Vault Mind/`.
- If source material came from a specific `Vault Mind/` note, place result in matching `AI Mind/<category>/` and include:
  `Source: [[Vault Mind/<category>/<note>]]`
- For conversation-only notes, no source link required unless user names one.
- Prefer one concise durable note over transcript dump.
- Include exact paths, commands, tool names, config locations, validation results, and open risks.
- Use Obsidian Markdown: frontmatter, headings, bullets, wikilinks where useful.

## Destination

Choose destination by topic:

- code/project/tooling work → `AI Mind/Projects/<Title>.md`
- journal/planning/personal workflow → `AI Mind/Journal/<Title>.md`
- career → `AI Mind/Career/<Title>.md`
- finance → `AI Mind/Finance/<Title>.md`
- learning/research → `AI Mind/Learning/<Title>.md`
- relationships → `AI Mind/Relationships/<Title>.md`

If unsure, use `AI Mind/Projects/` for technical agent/tooling sessions.

## Workflow

1. Identify durable value from conversation:
   - user goal
   - decisions made
   - files created/changed
   - commands run
   - tools/extensions/skills/config affected
   - validation status
   - unresolved issues / next steps
2. If conversation history is long or partially evicted:
   - use visible context first
   - if needed, call `session_recall` or global vault collection tools to recover missing details
   - do not include unrelated personal info
3. Pick title and path.
4. If note already exists, read it and update/append carefully; otherwise create new note.
5. Write frontmatter:

```yaml
---
title: <Title>
date: YYYY-MM-DD
tags:
  - pi
  - session-notes
status: documented
---
```

6. Use structure:

```markdown
# <Title>

## Summary

Brief durable summary.

## Decisions

- Decision: rationale.

## Implemented / Changed

- `path`: what changed.

## Commands / Validation

```bash
command
```

Result: ...

## How To Use

- Tool/command/workflow steps.

## Open Questions / Next Steps

- ...
```

7. Reply with vault-relative path only plus short note about what was captured.

## Quality Bar

Good note should let a future agent resume or explain work without reading full transcript.
Do not preserve chat fluff, failed dead ends unless they prevent future mistakes, or giant raw logs.
