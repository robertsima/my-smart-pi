<!-- my-smart-pi:agent-routing:start -->
# Harness agent routing

Model bindings are machine-local and preserve current Pi configuration:
{{LOCAL_ROUTING}}

- API-bound roles plan and independently verify. Local-bound roles implement and provide first-pass review.
- Start local server only with machine-local switch key `{{LOCAL_SWITCH_KEY}}`; never infer switch key from provider/model ID.
- Run at most one local child unless machine-local server config explicitly supports more.
- A pinned unavailable model must error; never accept fallback to parent.
- Verify child model metadata and actual changes before calling delegated work complete.
- Keep model capability observations in vault knowledge, not source-controlled harness defaults.

# Retrieval before delegation

- Before planning or delegating work on an existing coding project, parent must call `load_tools(names=["vault"])`, then `vm_search(collection="projects", query=<task and project>, mode="hybrid")`.
- Search `notes` too only when task needs personal/workflow context. Do not search unrelated personal material.
- Pass only relevant bounded findings and source paths into child prompt. Children remain isolated and do not independently search vault.
- Skip retrieval for unrelated one-shot tasks or when no prior project knowledge can matter.

# Tool efficiency

- Target grep first: `limit <= 50`, `context <= 3`. Avoid recursive dependency-tree searches unless exact package is named.
- Read <=250 lines per call; continue only when needed.
- Do not inherit parent context into children unless task requires it. Use focused prompts and bounded turns.
- In Git Bash on Windows, redirect to `/dev/null`, never `NUL`.
- Prefer `curl.exe` or Node scripts over nested inline PowerShell expressions containing `$`.
- Inside configured vault, use `vm_search`; outside it, use global collection search. Do not call both for same query.
<!-- my-smart-pi:agent-routing:end -->
