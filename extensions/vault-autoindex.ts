/**
 * Configurable vault autoindex for pi-vault-mind.
 *
 * Watches configured markdown roots, chunks notes, embeds chunks through
 * pi-vault-mind's LanceDB pipeline, and removes stale rows when files change
 * or disappear. Vault files remain source of truth; no JSONL WAL is written.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);

const DEFAULT_WATCH_ROOTS = ["Vault Mind", "AI Mind"];
const DEFAULT_COLLECTION_RULES = [
  { pattern: "^(AI Mind|Vault Mind)/Projects/", collection: "projects" },
];
const DEFAULT_COLLECTION = "notes";
const DEFAULT_DEBOUNCE_MS = 2000;
const DEFAULT_MAX_CHUNK_CHARS = 1500;

type CollectionRule = { pattern: string; collection: string };
type RawConfig = {
  vaultAutoindex?: RawConfig;
  vaultRoot?: string;
  watchRoots?: string[];
  collectionRules?: CollectionRule[];
  collections?: string[];
  defaultCollection?: string;
  vaultMindConfigPath?: string;
  statePath?: string;
  lanceModulePath?: string;
  debounceMs?: number;
  maxChunkChars?: number;
};

type Config = Required<Pick<RawConfig, "watchRoots" | "collectionRules" | "collections" | "defaultCollection" | "debounceMs" | "maxChunkChars">> & {
  vaultRoot: string;
  vaultMindConfigPath: string;
  statePath: string;
  lanceModulePath: string;
};

type State = { files: Record<string, { mtimeMs: number; chunks: number }> };

const agentDir = () =>
  process.env.PI_CODING_AGENT_DIR ||
  process.env.PI_AGENT_DIR ||
  path.join(process.env.USERPROFILE || process.env.HOME || process.cwd(), ".pi", "agent");

const readJsonIfExists = (file: string): any | undefined => {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    console.log(`[my-smart-pi:autoindex] ignoring invalid config ${file}: ${(error as Error).message}`);
  }
  return undefined;
};

const findConfigFile = (cwd: string): string | undefined => {
  const candidates = [
    process.env.MY_SMART_PI_CONFIG,
    path.join(cwd, ".pi", "my-smart-pi.config.json"),
    path.join(cwd, "my-smart-pi.config.json"),
    path.join(agentDir(), "my-smart-pi.config.json"),
  ].filter(Boolean) as string[];
  return candidates.find((file) => fs.existsSync(file));
};

const resolveMaybeRelative = (base: string, value: string): string =>
  path.isAbsolute(value) ? value : path.join(base, value);

const resolveLanceModule = (raw: RawConfig, cwd: string): string => {
  const candidates = [
    raw.lanceModulePath,
    process.env.PI_VAULT_MIND_LANCE_JS,
    (() => {
      try { return require.resolve("pi-vault-mind/dist/src/lance.js"); } catch { return undefined; }
    })(),
    path.join(cwd, ".pi", "npm", "node_modules", "pi-vault-mind", "dist", "src", "lance.js"),
    path.join(agentDir(), "npm", "node_modules", "pi-vault-mind", "dist", "src", "lance.js"),
  ].filter(Boolean) as string[];
  const found = candidates.find((file) => fs.existsSync(file));
  if (!found) {
    throw new Error(
      "Could not find pi-vault-mind LanceDB helper. Install pi-vault-mind or set PI_VAULT_MIND_LANCE_JS / vaultAutoindex.lanceModulePath.",
    );
  }
  return found;
};

const loadConfig = (cwd: string): Config => {
  const configFile = findConfigFile(cwd);
  const loaded = configFile ? readJsonIfExists(configFile) ?? {} : {};
  const raw: RawConfig = loaded.vaultAutoindex ?? loaded;
  const vaultRoot = path.resolve(raw.vaultRoot || process.env.PI_VAULT_ROOT || cwd);
  const collectionRules = raw.collectionRules?.length ? raw.collectionRules : DEFAULT_COLLECTION_RULES;
  const defaultCollection = raw.defaultCollection || DEFAULT_COLLECTION;
  const ruleCollections = collectionRules.map((rule) => rule.collection);
  const collections = raw.collections?.length
    ? raw.collections
    : [...new Set([defaultCollection, ...ruleCollections])];
  return {
    vaultRoot,
    watchRoots: (raw.watchRoots?.length ? raw.watchRoots : DEFAULT_WATCH_ROOTS).map((root) => resolveMaybeRelative(vaultRoot, root)),
    collectionRules,
    collections,
    defaultCollection,
    vaultMindConfigPath: resolveMaybeRelative(vaultRoot, raw.vaultMindConfigPath || ".vault-mind/vault-mind.config.json"),
    statePath: resolveMaybeRelative(vaultRoot, raw.statePath || ".vault-mind/autoindex-state.json"),
    lanceModulePath: resolveLanceModule(raw, cwd),
    debounceMs: raw.debounceMs ?? DEFAULT_DEBOUNCE_MS,
    maxChunkChars: raw.maxChunkChars ?? DEFAULT_MAX_CHUNK_CHARS,
  };
};

let lanceMod: any;
let lancePath: string | undefined;
const lance = async (cfg: Config) => {
  if (!lanceMod || lancePath !== cfg.lanceModulePath) {
    lancePath = cfg.lanceModulePath;
    lanceMod = await import(pathToFileURL(cfg.lanceModulePath).href);
  }
  return lanceMod;
};

const loadVmConfig = (cfg: Config): any =>
  JSON.parse(fs.readFileSync(cfg.vaultMindConfigPath, "utf8")).vaultMind;

const loadState = (cfg: Config): State => {
  try { return JSON.parse(fs.readFileSync(cfg.statePath, "utf8")); }
  catch { return { files: {} }; }
};

const saveState = (cfg: Config, state: State) => {
  fs.mkdirSync(path.dirname(cfg.statePath), { recursive: true });
  fs.writeFileSync(cfg.statePath, JSON.stringify(state, null, 1), "utf8");
};

const stripFrontmatter = (text: string): { body: string; tags: string[] } => {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return { body: text, tags: [] };
  const fm = match[1];
  const tags: string[] = [];
  const inline = fm.match(/^tags:\s*\[([^\]]*)\]/m);
  if (inline) {
    for (const tag of inline[1].split(",")) if (tag.trim()) tags.push(tag.trim());
  } else {
    const block = fm.match(/^tags:\s*\r?\n((?:\s*-\s*.+\r?\n?)+)/m);
    if (block) {
      for (const line of block[1].split(/\r?\n/)) {
        const tag = line.replace(/^\s*-\s*/, "").trim();
        if (tag) tags.push(tag);
      }
    }
  }
  return { body: text.slice(match[0].length), tags };
};

const chunkNote = (body: string, maxChunkChars: number): string[] => {
  const sections = body.split(/(?=^#{1,3}\s)/m).map((section) => section.trim()).filter(Boolean);
  const chunks: string[] = [];
  for (const section of sections.length ? sections : [body.trim()]) {
    if (section.length <= maxChunkChars) {
      if (section) chunks.push(section);
      continue;
    }
    let current = "";
    for (const para of section.split(/\r?\n\r?\n/)) {
      if (current && current.length + para.length + 2 > maxChunkChars) {
        chunks.push(current);
        current = para;
      } else {
        current = current ? `${current}\n\n${para}` : para;
      }
    }
    if (current) chunks.push(current);
  }
  return chunks.filter((chunk) => chunk.length >= 20);
};

const sqlString = (value: string): string => value.replace(/'/g, "''");

export default async function (pi: any) {
  let cfg: Config | undefined;
  let queue: Promise<void> = Promise.resolve();
  const watchers: fs.FSWatcher[] = [];
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  const log = (msg: string) => console.log(`[my-smart-pi:autoindex] ${msg}`);
  const relOf = (abs: string) => path.relative(cfg!.vaultRoot, abs).split(path.sep).join("/");
  const collectionFor = (rel: string): string => {
    for (const rule of cfg!.collectionRules) {
      if (new RegExp(rule.pattern).test(rel)) return rule.collection;
    }
    return cfg!.defaultCollection;
  };

  const enqueue = (job: () => Promise<void>) => {
    queue = queue.then(job).catch((error) => log(`error: ${error?.message ?? error}`));
  };

  const deleteRowsFor = async (rel: string) => {
    const { connect } = await lance(cfg!);
    const vmCfg = loadVmConfig(cfg!);
    const conn = await connect(vmCfg.dataDir);
    const tableNames = await conn.tableNames();
    for (const collection of cfg!.collections) {
      const tableName = `collection_${collection}`;
      if (!tableNames.includes(tableName)) continue;
      const table = await conn.openTable(tableName);
      await table.delete(`source = '${sqlString(rel)}'`);
    }
  };

  const indexFile = async (abs: string): Promise<number> => {
    const rel = relOf(abs);
    const raw = fs.readFileSync(abs, "utf8");
    const { body, tags } = stripFrontmatter(raw);
    const chunks = chunkNote(body, cfg!.maxChunkChars);
    const { upsertEntry } = await lance(cfg!);
    const vmCfg = loadVmConfig(cfg!);
    await deleteRowsFor(rel);
    const title = path.basename(abs, ".md");
    const tag = tags[0] ?? rel.split("/")[1]?.toLowerCase() ?? "note";
    const domain = rel.startsWith("AI Mind/") ? "ai-note" : "vault-note";
    const collection = collectionFor(rel);
    for (let i = 0; i < chunks.length; i++) {
      await upsertEntry(vmCfg.dataDir, collection, {
        id: `note:${rel}#${i}`,
        domain,
        source: rel,
        fact: `${title}\n\n${chunks[i]}`,
        tag,
        artifact: "",
      }, vmCfg);
    }
    return chunks.length;
  };

  const removeFile = async (abs: string) => {
    const rel = relOf(abs);
    await deleteRowsFor(rel);
    const state = loadState(cfg!);
    delete state.files[rel];
    saveState(cfg!, state);
    log(`removed index for ${rel}`);
  };

  const scheduleIndex = (abs: string) => {
    enqueue(async () => {
      if (!cfg) return;
      if (!fs.existsSync(abs)) return removeFile(abs);
      const rel = relOf(abs);
      const mtimeMs = fs.statSync(abs).mtimeMs;
      const state = loadState(cfg);
      if (state.files[rel]?.mtimeMs === mtimeMs) return;
      const chunks = await indexFile(abs);
      state.files[rel] = { mtimeMs, chunks };
      saveState(cfg, state);
      log(`indexed ${rel} (${chunks} chunk(s))`);
    });
  };

  const fullScan = () => {
    if (!cfg) return;
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(abs);
        else if (entry.name.toLowerCase().endsWith(".md")) scheduleIndex(abs);
      }
    };
    for (const root of cfg.watchRoots) if (fs.existsSync(root)) walk(root);

    const state = loadState(cfg);
    for (const rel of Object.keys(state.files)) {
      const abs = path.join(cfg.vaultRoot, rel);
      const inScope = cfg.watchRoots.some((root) => abs.startsWith(path.resolve(root)));
      if (inScope && !fs.existsSync(abs)) enqueue(() => removeFile(abs));
    }
  };

  const stop = () => {
    for (const watcher of watchers) watcher.close();
    watchers.length = 0;
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
  };

  const start = (_event: any, ctx: any) => {
    stop();
    try {
      cfg = loadConfig(ctx.cwd);
    } catch (error) {
      log(`disabled: ${(error as Error).message}`);
      return;
    }

    for (const root of cfg.watchRoots) {
      if (!fs.existsSync(root)) {
        log(`watch root missing, skipped: ${root}`);
        continue;
      }
      try {
        watchers.push(fs.watch(root, { recursive: true }, (_event, filename) => {
          if (!filename || !filename.toString().toLowerCase().endsWith(".md")) return;
          const abs = path.join(root, filename.toString());
          const prev = timers.get(abs);
          if (prev) clearTimeout(prev);
          timers.set(abs, setTimeout(() => {
            timers.delete(abs);
            scheduleIndex(abs);
          }, cfg!.debounceMs));
        }));
        log(`watching ${root}`);
      } catch (error) {
        log(`watch failed for ${root}: ${(error as Error).message}; startup scans still work`);
      }
    }
    fullScan();
  };

  pi.on("session_start", start);
  pi.on("session_shutdown", stop);

  pi.registerTool({
    name: "vault_reindex",
    label: "Vault Reindex",
    description:
      "Force re-embedding of configured vault markdown notes into vault-mind collections. " +
      "With no arguments, rescans changed notes; pass file (vault-relative path) to reindex one note, or force=true to re-embed all notes.",
    promptSnippet: "vault_reindex(force=false)",
    parameters: {
      type: "object",
      properties: {
        file: { type: "string", description: "Vault-relative path of one markdown note to reindex." },
        force: { type: "boolean", description: "Reindex every note even if unchanged." },
      },
    },
    async execute(_id: string, params: { file?: string; force?: boolean }, _signal: AbortSignal, _onUpdate: unknown, ctx: any) {
      if (!cfg) cfg = loadConfig(ctx.cwd);
      if (params?.force) saveState(cfg, { files: {} });
      if (params?.file) {
        const abs = path.join(cfg.vaultRoot, params.file);
        if (!fs.existsSync(abs)) return { content: [{ type: "text", text: `Not found: ${params.file}` }] };
        scheduleIndex(abs);
      } else {
        fullScan();
      }
      await queue;
      const state = loadState(cfg);
      const total = Object.values(state.files).reduce((n, file) => n + file.chunks, 0);
      return {
        content: [{
          type: "text",
          text: `Index up to date: ${Object.keys(state.files).length} note(s), ${total} chunk(s) across collections ${cfg.collections.map((c) => `"${c}"`).join(", ")}.`,
        }],
      };
    },
  });
}
