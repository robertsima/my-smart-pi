/**
 * lazy-tools — deferred tool loading for pi.
 *
 * Problem: pi ships every registered tool's full JSON schema in the startup
 * payload, and pi's _refreshToolRegistry auto-activates any newly registered
 * tool. A one-time shrink at session_start therefore does NOT stick: any
 * later registry refresh (model switch, resource reload) re-activates
 * everything. This version ENFORCES the active set on every before_agent_start
 * instead of shrinking once.
 *
 * Approach: keep a small core tool set active, advertise the rest as a compact
 * name + one-line catalog in the system prompt, let the model call `load_tools`
 * to pull in full schemas for what it needs. Also strips maintainer-only
 * package skills from the prompt (they bypass settings filtering because
 * pi-vault-mind injects them via resources_discover).
 * Uses only documented ExtensionAPI surface: registerTool, getAllTools,
 * getActiveTools, setActiveTools, session_start, before_agent_start.
 *
 * NOTE ON PROMPT CACHING: setActiveTools rebuilds the system prompt, which
 * changes the cached prefix and forces a full re-prefill on the next turn.
 * Enforcement only calls it when the active set actually differs, and
 * load_tools works in GROUPS so one expansion covers a whole task.
 */

// Always-active set. model_switch stays core so the llama-switch harness
// keeps working; context_checkpoint is cheap and frequently used. Global
// vault collection tools stay core so configured vault memory works from any cwd
// without first calling load_tools.
const CORE = [
  "read", "bash", "edit", "write", "ls", "grep", "find",
  "context_checkpoint",
  "model_switch",
  "load_tools",
  "vault_collection_search", "vault_collection_query",
  "vault_collection_list", "vault_collection_status",
];

// Named bundles so one call covers a task instead of N calls.
// Names verified against what the installed packages actually register.
const GROUPS: Record<string, string[]> = {
  vault: [
    "vm_search", "vm_query", "vm_append", "vm_stats", "vm_status",
    "vm_describe", "ask_intake", "tombstone_entry", "vault_reindex",
    "session_recall", "session_memory_status", "session_memory_read",
    "vault_collection_search", "vault_collection_query",
    "vault_collection_list", "vault_collection_status",
  ],
  admin: [
    "vm_configure", "vm_collection_manage", "vm_injector_manage",
    "discover_schema", "vm_sync", "vm_ingest", "vm_promote", "vm_export",
  ],
  web: ["web_search", "fetch_content", "get_search_content"],
  context: ["context_timeline", "context_compact"],
};

// Skills hidden from the <available_skills> prompt section. These are
// pi-vault-mind maintainer/release workflows, not runtime skills; they remain
// invocable explicitly via /skill:<name>. Remove a line to make it visible
// to the model again.
const HIDDEN_SKILLS = [
  "github-release-notes-file",
  "obsidian-guided-test-session",
  "obsidian-interactive-test",
  "obsidian-plugin-publish",
  "pi-vault-mind-release",
  "pre-test-release",
];

// Tools whose JSON results get heavy fields stripped before the model sees
// them. pi-vault-mind 0.16.25 serializes raw LanceDB rows including the
// 768-dim embedding "vector" array (~22k chars PER ENTRY) into search results.
const STRIP_RESULT_TOOLS = new Set([
  "vm_search", "vm_query", "session_recall", "session_memory_read",
  "vault_collection_search", "vault_collection_query",
]);

/** Recursively remove embedding vectors: any "vector" key, plus any key whose
 *  value is a long all-number array (defensive, in case fields get renamed). */
const stripVectors = (node: any): boolean => {
  let changed = false;
  if (Array.isArray(node)) {
    for (const item of node) changed = stripVectors(item) || changed;
  } else if (node && typeof node === "object") {
    for (const key of Object.keys(node)) {
      const val = node[key];
      const isNumberArray =
        Array.isArray(val) &&
        val.length > 32 &&
        val.every((x: any) => typeof x === "number");
      if (key === "vector" || isNumberArray) {
        delete node[key];
        changed = true;
      } else {
        changed = stripVectors(val) || changed;
      }
    }
  }
  return changed;
};

const firstLine = (s: string): string => {
  const t = (s || "").replace(/\s+/g, " ").trim();
  const cut = t.split(". ")[0];
  return (cut.length > 90 ? cut.slice(0, 90) + "…" : cut) || "(no description)";
};

const stripHiddenSkills = (prompt: string): string => {
  let out = prompt;
  for (const name of HIDDEN_SKILLS) {
    const re = new RegExp(
      `\\s*<skill>\\s*<name>${name}</name>[\\s\\S]*?</skill>`,
      "g"
    );
    out = out.replace(re, "");
  }
  return out;
};

export default async function (pi: any) {
  // Desired active set: CORE plus whatever load_tools added this session.
  const active = new Set<string>(CORE);

  const allNames = (): string[] => pi.getAllTools().map((t: any) => t.name);

  /**
   * Make reality match `active`. Idempotent and cheap: only calls
   * setActiveTools (which rebuilds the system prompt) when the current
   * active set actually differs, so an unchanged set never churns the
   * prompt cache.
   */
  const enforce = () => {
    const registered = new Set(allNames());
    if (registered.size === 0) return;
    const desired = [...active].filter((n) => registered.has(n));
    const current: string[] = pi.getActiveTools();
    const currentSet = new Set(current);
    const same =
      currentSet.size === desired.length &&
      desired.every((n) => currentSet.has(n));
    if (!same) pi.setActiveTools(desired);
  };

  // pi-vault-mind registers its tools asynchronously AFTER session_start, and
  // pi auto-activates late-registered tools (re-inflating the system prompt
  // with their snippets/guidelines). Poll briefly after each session start so
  // the base prompt is clean again before the user's first message. enforce()
  // is a no-op when nothing changed, so this is nearly free.
  let watchdog: ReturnType<typeof setInterval> | undefined;
  const watch = () => {
    enforce();
    if (watchdog) clearInterval(watchdog);
    let ticks = 0;
    watchdog = setInterval(() => {
      enforce();
      if (++ticks >= 80 && watchdog) clearInterval(watchdog); // ~20s
    }, 250);
    (watchdog as any).unref?.();
  };

  pi.on("session_start", watch);
  pi.on("session_shutdown", () => {
    if (watchdog) clearInterval(watchdog);
  });

  pi.registerTool({
    name: "load_tools",
    label: "Load Tools",
    description:
      "Activate additional tools that are not currently loaded. Pass group names " +
      "(vault, admin, web, context) and/or individual tool names. The " +
      "requested tools become callable on your next step. Prefer loading a whole " +
      "group in one call rather than several separate calls.",
    promptSnippet: 'load_tools(names=["vault"])',
    promptGuidelines: [
      "Tools listed under <deferred_tools> are NOT callable until you load them with load_tools.",
      "Load a group in a single call, then proceed; avoid repeated load_tools calls.",
      "Do not call load_tools for tools that are already available to you.",
    ],
    parameters: {
      type: "object",
      properties: {
        names: {
          type: "array",
          items: { type: "string" },
          description:
            "Group names (vault, admin, web, context) and/or exact tool names.",
        },
      },
      required: ["names"],
    },
    async execute(_id: string, params: { names?: string[] }) {
      const registered = allNames();
      const want = new Set<string>();
      const unknown: string[] = [];

      for (const raw of params?.names ?? []) {
        const key = String(raw).trim();
        if (GROUPS[key]) {
          for (const n of GROUPS[key]) if (registered.includes(n)) want.add(n);
        } else if (registered.includes(key)) {
          want.add(key);
        } else {
          unknown.push(key);
        }
      }

      const added = [...want].filter((n) => !active.has(n));
      for (const n of want) active.add(n);
      if (added.length) enforce();

      const lines: string[] = [];
      lines.push(
        added.length
          ? `Loaded ${added.length} tool(s): ${added.join(", ")}. They are callable from your next step onward.`
          : "No new tools loaded (all requested tools were already active)."
      );
      if (unknown.length) lines.push(`Unknown (ignored): ${unknown.join(", ")}`);

      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  });

  /**
   * Strip raw embedding vectors from vault-mind search/query results.
   * Without this, each vm_search result carries ~22k chars of floats per hit.
   */
  pi.on("tool_result", async (event: any) => {
    if (!STRIP_RESULT_TOOLS.has(event.toolName) || event.isError) return;
    let changed = false;
    const content = event.content.map((block: any) => {
      if (block?.type !== "text" || typeof block.text !== "string") return block;
      try {
        const parsed = JSON.parse(block.text);
        if (!stripVectors(parsed)) return block;
        changed = true;
        return { ...block, text: JSON.stringify(parsed, null, 2) };
      } catch {
        return block; // not JSON (e.g. an error string) — leave untouched
      }
    });
    if (changed) return { content };
  });

  /**
   * Every turn: re-assert the active set (pi re-activates newly registered
   * tools on any registry refresh, e.g. after a model switch), strip hidden
   * skills, and advertise unloaded tools as a compact catalog — ~1 line per
   * tool instead of a full JSON schema.
   */
  pi.on("before_agent_start", async (event: any) => {
    enforce();

    let prompt = stripHiddenSkills(event.systemPrompt);

    const deferred = pi
      .getAllTools()
      .filter((t: any) => !active.has(t.name))
      .map((t: any) => `  ${t.name}: ${firstLine(t.description)}`);

    if (deferred.length > 0) {
      const GROUP_INFO: Record<string, string> = {
        vault:
          "embedding/semantic search and memory over the user's notes and project knowledge — use for anything the user wrote, did, or asked to remember",
        admin: "vault-mind administration and ingestion",
        web: "public internet only — never for the user's own notes or memory",
        context: "session context timeline and compaction",
      };
      const groupList = Object.entries(GROUPS)
        .map(([g, members]) => {
          const avail = members.filter((m) => !active.has(m));
          const info = GROUP_INFO[g] ? ` (${GROUP_INFO[g]})` : "";
          return avail.length ? `  ${g}${info}: ${avail.join(", ")}` : null;
        })
        .filter(Boolean)
        .join("\n");

      prompt +=
        `\n\n<deferred_tools>\n` +
        `These tools exist but are NOT currently callable. To use one, first call\n` +
        `load_tools with its group name (preferred) or its exact name.\n\n` +
        `Groups:\n${groupList}\n\nTools:\n${deferred.join("\n")}\n` +
        `</deferred_tools>\n`;
    }

    if (prompt === event.systemPrompt) return;
    return { systemPrompt: prompt };
  });
}
