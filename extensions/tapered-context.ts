import type {
  CompactionPreparation,
  CompactionSettings,
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { prepareCompaction } from "@earendil-works/pi-coding-agent";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const EXT_NAME = "tapered-context";

const MIN_TRIGGER_TOKENS = 32_000;
const MAX_TRIGGER_TOKENS = 72_000;
const TRIGGER_GROWTH_TOKENS = 11_000;
const TRIGGER_WINDOW_SCALE = 65_000;

const MIN_KEEP_RECENT_TOKENS = 10_000;
const MAX_KEEP_RECENT_TOKENS = 28_000;
const KEEP_GROWTH_TOKENS = 7_000;
const KEEP_USAGE_SCALE = 50_000;
const MIN_DROP_TOKENS = 8_000;

const MIN_RESERVE_TOKENS = 8_192;

const SUMMARY_FOCUS = [
  "Use tapered memory: preserve current goal, constraints, decisions, validation state, changed files, exact paths, commands, and next step.",
  "Compress older context harder than recent discarded context. Keep durable facts and source pointers; drop process noise, repeated logs, and superseded attempts.",
  "If previous summary exists, merge it without expanding stale detail. Current active work and unresolved risks matter most.",
].join(" ");

const TOOL_OUTPUT_ARCHIVE_ROOT = join(
  process.env.PI_AGENT_DIR || join(process.env.USERPROFILE || process.env.HOME || process.cwd(), ".pi", "agent"),
  "tool-output-archive",
);

const TOOL_STUB_PREFIX = "[Tool output archived]";

type ToolOutputArchive = {
  path: string;
  chars: number;
  parts: number;
  isError: boolean;
};

function safePathPart(value: unknown): string {
  return String(value || "unknown")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "unknown";
}

function getTextFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (part && typeof part === "object" && (part as any).type === "text") return String((part as any).text ?? "");
      if (part && typeof part === "object" && (part as any).type === "image") return "[image content]";
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function toolOutputArchivePath(ctx: ExtensionContext, message: any): string {
  const sessionId = safePathPart(ctx.sessionManager.getSessionId?.() ?? ctx.sessionManager.getSessionFile?.() ?? "session");
  const timestamp = safePathPart(message.timestamp ?? Date.now());
  const tool = safePathPart(message.toolName ?? "tool");
  const call = safePathPart(message.toolCallId ?? `${timestamp}-${tool}`);
  return join(TOOL_OUTPUT_ARCHIVE_ROOT, sessionId, `${timestamp}-${tool}-${call}.md`);
}

async function ensureToolOutputArchived(ctx: ExtensionContext, message: any, archives: Map<string, ToolOutputArchive>): Promise<ToolOutputArchive | undefined> {
  if (!message || message.role !== "toolResult" || !message.toolCallId) return undefined;

  const existing = archives.get(message.toolCallId);
  if (existing) return existing;

  const text = getTextFromContent(message.content);
  if (text.startsWith(TOOL_STUB_PREFIX)) return undefined;

  const archivePath = toolOutputArchivePath(ctx, message);
  const contentParts = Array.isArray(message.content) ? message.content.length : (message.content ? 1 : 0);
  const payload = [
    `# Tool Output Archive`,
    ``,
    `- Tool: ${message.toolName ?? "unknown"}`,
    `- Tool call ID: ${message.toolCallId}`,
    `- Error: ${Boolean(message.isError)}`,
    `- Timestamp: ${message.timestamp ?? "unknown"}`,
    `- Content chars: ${text.length}`,
    `- Content parts: ${contentParts}`,
    ``,
    `## Content`,
    ``,
    "```text",
    text,
    "```",
    ``,
    `## Details JSON`,
    ``,
    "```json",
    JSON.stringify(message.details ?? null, null, 2),
    "```",
    ``,
  ].join("\n");

  await mkdir(dirname(archivePath), { recursive: true });
  await writeFile(archivePath, payload, "utf8");

  const archive = { path: archivePath, chars: text.length, parts: contentParts, isError: Boolean(message.isError) };
  archives.set(message.toolCallId, archive);
  return archive;
}

async function redactToolResult(ctx: ExtensionContext, message: any, archives: Map<string, ToolOutputArchive>): Promise<void> {
  const archive = await ensureToolOutputArchived(ctx, message, archives);
  if (!archive) return;

  message.content = [{
    type: "text",
    text: `${TOOL_STUB_PREFIX}\nTool ${message.toolName} output (${archive.chars} chars, ${archive.parts} part(s), error=${archive.isError}) was already consumed by a later assistant message. Full output archived at: ${archive.path}\nIf exact output is needed, call read on that path.`,
  }];
  message.details = { archivedPath: archive.path, archivedChars: archive.chars, archivedParts: archive.parts };
}

async function redactAllToolResults(ctx: ExtensionContext, messages: any[], archives: Map<string, ToolOutputArchive>): Promise<void> {
  for (const message of messages) {
    if (message?.role === "toolResult") await redactToolResult(ctx, message, archives);
  }
}

type TaperPolicy = {
  contextTokens: number;
  contextWindow: number;
  hardCeilingTokens: number;
  triggerTokens: number;
  keepRecentTokens: number;
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function positive(value: number | undefined | null, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function computeTaperPolicy(contextTokens: number, contextWindow: number | undefined, reserveTokens: number): TaperPolicy {
  const effectiveWindow = positive(contextWindow, 128_000);
  const effectiveReserve = Math.max(MIN_RESERVE_TOKENS, positive(reserveTokens, MIN_RESERVE_TOKENS));
  const hardCeilingTokens = Math.max(MIN_TRIGGER_TOKENS, effectiveWindow - effectiveReserve);

  const softTrigger = Math.round(
    MIN_TRIGGER_TOKENS + TRIGGER_GROWTH_TOKENS * Math.log2(1 + effectiveWindow / TRIGGER_WINDOW_SCALE),
  );
  const triggerTokens = Math.min(hardCeilingTokens, clamp(softTrigger, MIN_TRIGGER_TOKENS, MAX_TRIGGER_TOKENS));

  const usageForTail = Math.max(contextTokens, triggerTokens);
  const softKeep = Math.round(
    MIN_KEEP_RECENT_TOKENS + KEEP_GROWTH_TOKENS * Math.log2(1 + usageForTail / KEEP_USAGE_SCALE),
  );
  const maxSafeKeep = Math.max(MIN_KEEP_RECENT_TOKENS, Math.min(MAX_KEEP_RECENT_TOKENS, triggerTokens - MIN_DROP_TOKENS));
  const keepRecentTokens = clamp(softKeep, MIN_KEEP_RECENT_TOKENS, maxSafeKeep);

  return {
    contextTokens,
    contextWindow: effectiveWindow,
    hardCeilingTokens,
    triggerTokens,
    keepRecentTokens,
  };
}

function formatTokens(tokens: number): string {
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);
}

function replacePreparation(target: CompactionPreparation, source: CompactionPreparation): void {
  target.firstKeptEntryId = source.firstKeptEntryId;
  target.messagesToSummarize = source.messagesToSummarize;
  target.turnPrefixMessages = source.turnPrefixMessages;
  target.isSplitTurn = source.isSplitTurn;
  target.tokensBefore = source.tokensBefore;
  target.previousSummary = source.previousSummary;
  target.fileOps = source.fileOps;
  target.settings = source.settings;
}

function lastEntryIsCompaction(entries: SessionEntry[]): boolean {
  return entries[entries.length - 1]?.type === "compaction";
}

function triggerCompaction(ctx: ExtensionContext, reason: string, onSettled?: () => void): void {
  ctx.compact({
    customInstructions: SUMMARY_FOCUS,
    onComplete: (result) => {
      const after = result.estimatedTokensAfter ? ` -> ~${formatTokens(result.estimatedTokensAfter)}` : "";
      if (ctx.hasUI) ctx.ui.notify(`${EXT_NAME}: compacted ${reason}${after}`, "info");
      onSettled?.();
    },
    onError: (error) => {
      if (ctx.hasUI) ctx.ui.notify(`${EXT_NAME}: compaction failed: ${error.message}`, "error");
      onSettled?.();
    },
  });
}

export default function (pi: ExtensionAPI) {
  let previousTokens: number | null = null;
  let compactionQueued = false;
  const archivedToolOutputs = new Map<string, ToolOutputArchive>();

  pi.on("session_start", (_event, ctx) => {
    previousTokens = null;
    compactionQueued = false;
    if (ctx.hasUI) ctx.ui.setStatus(EXT_NAME, "taper on");
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (ctx.hasUI) ctx.ui.setStatus(EXT_NAME, undefined);
  });

  pi.on("session_before_compact", async (event, ctx) => {
    const policy = computeTaperPolicy(
      event.preparation.tokensBefore,
      ctx.model?.contextWindow,
      event.preparation.settings.reserveTokens,
    );

    const settings: CompactionSettings = {
      ...event.preparation.settings,
      keepRecentTokens: policy.keepRecentTokens,
    };

    const dynamicPreparation = prepareCompaction(event.branchEntries, settings);
    if (!dynamicPreparation) return;

    replacePreparation(event.preparation, dynamicPreparation);
    await redactAllToolResults(ctx, event.preparation.messagesToSummarize as any[], archivedToolOutputs);
    await redactAllToolResults(ctx, event.preparation.turnPrefixMessages as any[], archivedToolOutputs);

    if (ctx.hasUI) {
      ctx.ui.notify(
        `${EXT_NAME}: keep raw tail ~${formatTokens(policy.keepRecentTokens)} (before ${formatTokens(policy.contextTokens)})`,
        "info",
      );
    }
  });

  pi.on("session_compact", (_event, ctx) => {
    previousTokens = null;
    compactionQueued = false;
    if (ctx.hasUI) ctx.ui.setStatus(EXT_NAME, "taper on");
  });

  pi.on("tool_result", async (event, ctx) => {
    await ensureToolOutputArchived(ctx, {
      role: "toolResult",
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      content: event.content,
      details: event.details,
      isError: event.isError,
      timestamp: Date.now(),
    }, archivedToolOutputs);
  });

  pi.on("context", async (event, ctx) => {
    const messages = event.messages as any[];
    let lastAssistantIndex = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.role === "assistant") {
        lastAssistantIndex = i;
        break;
      }
    }
    if (lastAssistantIndex < 0) return;

    for (let i = 0; i < lastAssistantIndex; i++) {
      if (messages[i]?.role === "toolResult") await redactToolResult(ctx, messages[i], archivedToolOutputs);
    }

    return { messages };
  });

  pi.on("turn_end", (_event, ctx) => {
    const usage = ctx.getContextUsage();
    const currentTokens = usage?.tokens;
    if (!currentTokens || !Number.isFinite(currentTokens)) return;

    const reserveTokens = 8_192;
    const policy = computeTaperPolicy(currentTokens, ctx.model?.contextWindow, reserveTokens);

    if (ctx.hasUI) {
      ctx.ui.setStatus(
        EXT_NAME,
        `${formatTokens(currentTokens)}/${formatTokens(policy.triggerTokens)} keep ${formatTokens(policy.keepRecentTokens)}`,
      );
    }

    const crossed = previousTokens === null
      ? currentTokens > policy.triggerTokens
      : previousTokens <= policy.triggerTokens && currentTokens > policy.triggerTokens;
    previousTokens = currentTokens;

    if (!crossed || compactionQueued) return;

    const branch = ctx.sessionManager.getBranch();
    if (lastEntryIsCompaction(branch)) return;

    compactionQueued = true;
    triggerCompaction(ctx, `at ${formatTokens(currentTokens)} > ${formatTokens(policy.triggerTokens)}`, () => {
      compactionQueued = false;
    });
  });

  pi.registerCommand("tapered-context", {
    description: "Show tapered-context policy, or run `/tapered-context compact`.",
    handler: async (args, ctx) => {
      const usage = ctx.getContextUsage();
      const currentTokens = usage?.tokens ?? 0;
      const policy = computeTaperPolicy(currentTokens, ctx.model?.contextWindow, 8_192);
      const command = args.trim().toLowerCase();

      if (command === "compact") {
        compactionQueued = true;
        triggerCompaction(ctx, "manual tapered request", () => {
          compactionQueued = false;
        });
        return;
      }

      const lines = [
        `${EXT_NAME}: enabled`,
        `context now: ${formatTokens(currentTokens)}`,
        `soft trigger: ${formatTokens(policy.triggerTokens)}`,
        `raw tail kept after compaction: ~${formatTokens(policy.keepRecentTokens)}`,
        `hard ceiling: ${formatTokens(policy.hardCeilingTokens)} of ${formatTokens(policy.contextWindow)} window`,
        `tool output archive: ${TOOL_OUTPUT_ARCHIVE_ROOT}`,
        "command: /tapered-context compact",
      ];
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
