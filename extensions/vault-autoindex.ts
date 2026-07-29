/**
 * Configurable vault autoindex for pi-vault-mind.
 *
 * Watches configured markdown roots, chunks notes, embeds chunks through
 * pi-vault-mind's LanceDB pipeline, and removes stale rows when files change
 * or disappear. Vault files remain source of truth; no JSONL WAL is written.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
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
const DEFAULT_OPTIMIZE_AFTER_ROWS = 500;

type LogLevel = "quiet" | "summary" | "debug";
type MaintenanceMode = "off" | "safe";
type Coordinator = { owner: symbol; dataDir: string; startedAt: number };
const COORDINATORS_KEY = Symbol.for("my-smart-pi:vault-autoindex-coordinators");
const coordinators: Map<string, Coordinator> =
  ((globalThis as any)[COORDINATORS_KEY] ??= new Map<string, Coordinator>());

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
  logLevel?: LogLevel;
  optimizeAfterRows?: number;
  maintenanceMode?: MaintenanceMode;
};

type Config = Required<Pick<RawConfig, "watchRoots" | "collectionRules" | "collections" | "defaultCollection" | "debounceMs" | "maxChunkChars" | "logLevel" | "optimizeAfterRows" | "maintenanceMode">> & {
  vaultRoot: string;
  vaultMindConfigPath: string;
  statePath: string;
  lanceModulePath: string;
};

type State = {
  indexSignature?: string;
  files: Record<string, { mtimeMs: number; chunks: number }>;
};

const agentDir = () =>
  process.env.PI_AGENT_DIR || path.join(process.env.USERPROFILE || process.env.HOME || process.cwd(), ".pi", "agent");

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
    logLevel: raw.logLevel ?? "summary",
    optimizeAfterRows: Math.max(0, raw.optimizeAfterRows ?? DEFAULT_OPTIMIZE_AFTER_ROWS),
    maintenanceMode: raw.maintenanceMode ?? "safe",
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

const loadVmConfig = async (cfg: Config): Promise<any> => {
  const vmCfg = JSON.parse(fs.readFileSync(cfg.vaultMindConfigPath, "utf8")).vaultMind;
  const embedding = vmCfg?.embedding ?? {};

  // pi-vault-mind merges current defaults over legacy Ollama keys. Mirror that
  // normalization so autoindex writes same vector dimension that vm_search queries.
  if (embedding.provider === "ollama") {
    const ollamaHost = String(embedding.ollamaHost ?? "http://127.0.0.1:11434").replace(/\/$/, "");
    const model = embedding.model ?? embedding.ollamaModel ?? "embeddinggemma";
    const inferredDim = /^embeddinggemma(?::|$)/i.test(String(model)) ? 768 : undefined;
    vmCfg.embedding = {
      ...embedding,
      localUrl: embedding.localUrl ?? ollamaHost,
      model,
      dim: embedding.dim ?? inferredDim,
    };
  }

  return vmCfg;
};

const loadState = (cfg: Config): State => {
  try { return JSON.parse(fs.readFileSync(cfg.statePath, "utf8")); }
  catch { return { files: {} }; }
};

const saveState = (cfg: Config, state: State) => {
  fs.mkdirSync(path.dirname(cfg.statePath), { recursive: true });
  fs.writeFileSync(cfg.statePath, JSON.stringify(state, null, 1), "utf8");
};

const indexSignature = (cfg: Config, vmCfg: any): string => {
  const embedding = vmCfg.embedding ?? {};
  const compatibilityInput = JSON.stringify({
    schema: 3,
    dataDir: vmCfg.dataDir,
    embedding: {
      provider: embedding.provider,
      localUrl: embedding.localUrl,
      remoteUrl: embedding.remoteUrl,
      model: embedding.model,
      dim: embedding.dim,
      useTransformers: embedding.useTransformers,
    },
    maxChunkChars: cfg.maxChunkChars,
    defaultCollection: cfg.defaultCollection,
    collectionRules: cfg.collectionRules,
  });
  return createHash("sha256").update(compatibilityInput).digest("hex");
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
  let compatibilityValidated = false;
  let rebuildDeferredReason: string | undefined;
  let passive = false;
  let coordinatorKey: string | undefined;
  let rowsSinceOptimize = 0;
  let indexedFiles = 0;
  const owner = Symbol("vault-autoindex-owner");
  const failures: string[] = [];
  const watchers: fs.FSWatcher[] = [];
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  const log = (msg: string, level: LogLevel = "summary") => {
    if (cfg?.logLevel === "quiet" || (level === "debug" && cfg?.logLevel !== "debug")) return;
    console.log(`[my-smart-pi:autoindex] ${msg}`);
  };
  const canonicalDataDir = (vmCfg: any): string => {
    const configured = String(vmCfg.dataDir || "");
    const absolute = path.isAbsolute(configured)
      ? configured
      : path.resolve(path.dirname(cfg!.vaultMindConfigPath), configured);
    try { return fs.realpathSync.native(absolute).toLowerCase(); }
    catch { return path.resolve(absolute).toLowerCase(); }
  };
  const isWithin = (root: string, target: string): boolean => {
    const rel = path.relative(path.resolve(root), path.resolve(target));
    return rel === "" || (!path.isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${path.sep}`));
  };
  const isManagedMarkdown = (abs: string): boolean => {
    if (path.extname(abs).toLowerCase() !== ".md" || !cfg!.watchRoots.some((root) => isWithin(root, abs))) return false;
    if (!fs.existsSync(abs)) return true;
    try {
      const real = fs.realpathSync(abs);
      return path.extname(real).toLowerCase() === ".md" && cfg!.watchRoots.some((root) => isWithin(root, real));
    } catch {
      return false;
    }
  };
  const relOf = (abs: string) => path.relative(cfg!.vaultRoot, abs).split(path.sep).join("/");
  const collectionFor = (rel: string): string => {
    for (const rule of cfg!.collectionRules) {
      if (new RegExp(rule.pattern).test(rel)) return rule.collection;
    }
    return cfg!.defaultCollection;
  };

  const enqueue = (job: () => Promise<void>) => {
    queue = queue.then(job).catch((error) => {
      const message = error?.message ?? String(error);
      failures.push(message);
      if (failures.length > 100) failures.shift();
      log(`error: ${message}`);
    });
  };

  const managedTablesCompatible = async (vmCfg: any, state: State): Promise<boolean> => {
    const mod = await lance(cfg!);
    const conn = await mod.connect(vmCfg.dataDir);
    const existing = new Set(await conn.tableNames());
    const collectionsWithState = new Set(
      Object.keys(state.files).map((rel) => collectionFor(rel)),
    );
    const expectedDim = Number(vmCfg.embedding?.dim);

    for (const collection of cfg!.collections) {
      const tableName = `collection_${collection}`;
      if (!existing.has(tableName)) {
        if (collectionsWithState.has(collection)) {
          log(`compatibility failure: missing ${tableName}`);
          return false;
        }
        continue;
      }
      let lastError: unknown;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const table = await conn.openTable(tableName);
          const indices = await table.listIndices();
          const hasFts = indices.some((index: any) =>
            String(index?.indexType || "").toUpperCase() === "FTS" && Array.isArray(index?.columns) && index.columns.includes("fact"),
          );
          if (!hasFts) {
            log(`compatibility failure: ${tableName} has no FTS index on fact`);
            return false;
          }
          const schema = await table.schema();
          const vectorField = schema.fields.find((field: any) => field.name === "vector");
          const actualDim = Number((vectorField?.type as any)?.listSize);
          if (Number.isFinite(expectedDim) && expectedDim > 0 && actualDim !== expectedDim) {
            log(`compatibility failure: ${tableName} vector dimension ${actualDim}; expected ${expectedDim}`);
            return false;
          }
          await table.query().nearestToText("my-smart-pi-index-health-probe").limit(1).toArray();
          lastError = undefined;
          break;
        } catch (error) {
          lastError = error;
          if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
        }
      }
      if (lastError) {
        log(`compatibility failure: ${tableName}: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
        return false;
      }
    }
    return true;
  };

  const ensureIndexCompatibility = async (force = false): Promise<void> => {
    if (!force && compatibilityValidated) return;
    const vmCfg = await loadVmConfig(cfg!);
    const signature = indexSignature(cfg!, vmCfg);
    const state = loadState(cfg!);
    const signatureChanged = state.indexSignature !== signature;
    if (!force && !signatureChanged && await managedTablesCompatible(vmCfg, state)) {
      compatibilityValidated = true;
      return;
    }

    // Never drop or mutate live tables here. Lance handles may be shared by the
    // root and nested sessions; an automatic drop can invalidate all of them.
    const reason = force ? "forced rebuild requested" : signatureChanged
      ? "index configuration changed" : "managed table compatibility check failed";
    rebuildDeferredReason = `${reason}; rebuild required. Stop all Pi processes, back up ${vmCfg.dataDir}, and run an explicit offline repair. No tables were changed.`;
    compatibilityValidated = false;
    log(rebuildDeferredReason);
  };

  const deleteRowsFor = async (rel: string) => {
    const { connect } = await lance(cfg!);
    const vmCfg = await loadVmConfig(cfg!);
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
    const vmCfg = await loadVmConfig(cfg!);
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

  const optimizeIfDue = async () => {
    if (!cfg || cfg.maintenanceMode !== "safe" || cfg.optimizeAfterRows <= 0 || rowsSinceOptimize < cfg.optimizeAfterRows) return;
    const vmCfg = await loadVmConfig(cfg);
    const mod = await lance(cfg);
    const conn = await mod.connect(vmCfg.dataDir);
    const names = new Set(await conn.tableNames());
    for (const collection of cfg.collections) {
      const name = `collection_${collection}`;
      if (!names.has(name)) continue;
      const table = await conn.openTable(name);
      if (typeof table.optimize === "function") await table.optimize();
    }
    log(`maintenance optimized after ${rowsSinceOptimize} written row(s)`);
    rowsSinceOptimize = 0;
  };

  const optimizeExistingFtsBacklog = async () => {
    if (!cfg || cfg.maintenanceMode !== "safe" || cfg.optimizeAfterRows <= 0) return;
    try {
      const vmCfg = await loadVmConfig(cfg);
      const mod = await lance(cfg);
      const conn = await mod.connect(vmCfg.dataDir);
      const names = new Set(await conn.tableNames());
      for (const collection of cfg.collections) {
        const name = `collection_${collection}`;
        if (!names.has(name)) continue;
        const table = await conn.openTable(name);
        if (typeof table.listIndices !== "function" || typeof table.indexStats !== "function" || typeof table.optimize !== "function") continue;
        const indices = await table.listIndices();
        let backlog = 0;
        let indexedRows = 0;
        for (const index of indices) {
          const type = String(index?.indexType ?? index?.type ?? "").toUpperCase();
          if (type !== "FTS" && !String(index?.name ?? "").toLowerCase().includes("fts")) continue;
          const stats = await table.indexStats(index.name);
          backlog = Math.max(backlog, Number(stats?.numUnindexedRows ?? 0));
          indexedRows = Math.max(indexedRows, Number(stats?.numIndexedRows ?? 0));
        }
        if (backlog <= 0 || (indexedRows > 0 && backlog < cfg.optimizeAfterRows)) continue;
        log(`maintenance: optimizing ${collection} (${backlog} FTS delta rows)`);
        await table.optimize();
      }
    } catch (error) {
      log(`maintenance deferred: ${(error as Error).message}`);
    }
  };

  const removeFile = async (abs: string) => {
    const rel = relOf(abs);
    await deleteRowsFor(rel);
    const state = loadState(cfg!);
    delete state.files[rel];
    saveState(cfg!, state);
    log(`removed ${rel}`, "debug");
  };

  const scheduleIndex = (abs: string) => {
    enqueue(async () => {
      if (!cfg) return;
      await ensureIndexCompatibility();
      if (rebuildDeferredReason) return;
      if (!fs.existsSync(abs)) return removeFile(abs);
      const rel = relOf(abs);
      const mtimeMs = fs.statSync(abs).mtimeMs;
      const state = loadState(cfg);
      if (state.files[rel]?.mtimeMs === mtimeMs) return;
      const chunks = await indexFile(abs);
      state.files[rel] = { mtimeMs, chunks };
      saveState(cfg, state);
      rowsSinceOptimize += chunks;
      indexedFiles++;
      log(`indexed ${rel} (${chunks} chunk(s))`, "debug");
      await optimizeIfDue();
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
      const abs = path.resolve(cfg.vaultRoot, rel);
      if (isManagedMarkdown(abs) && !fs.existsSync(abs)) enqueue(() => removeFile(abs));
    }
  };

  const stop = () => {
    if (passive) return;
    for (const watcher of watchers) watcher.close();
    watchers.length = 0;
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    if (coordinatorKey && coordinators.get(coordinatorKey)?.owner === owner) coordinators.delete(coordinatorKey);
    coordinatorKey = undefined;
  };

  const start = async (_event: any, ctx: any) => {
    stop();
    try {
      cfg = loadConfig(ctx.cwd);
      const vmCfg = await loadVmConfig(cfg);
      coordinatorKey = canonicalDataDir(vmCfg);
      const active = coordinators.get(coordinatorKey);
      if (active && active.owner !== owner) {
        passive = true;
        log(`shared coordinator active for ${active.dataDir}`, "debug");
        return;
      }
      passive = false;
      coordinators.set(coordinatorKey, { owner, dataDir: coordinatorKey, startedAt: Date.now() });
    } catch (error) {
      log(`disabled: ${(error as Error).message}`);
      return;
    }

    let watched = 0;
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
        watched++;
      } catch (error) {
        log(`watch failed for ${root}: ${(error as Error).message}; startup scans still work`);
      }
    }
    enqueue(() => ensureIndexCompatibility());
    fullScan();
    await queue;
    await optimizeExistingFtsBacklog();
    const state = loadState(cfg);
    const rows = Object.values(state.files).reduce((sum, file) => sum + file.chunks, 0);
    log(`ready: ${watched}/${cfg.watchRoots.length} roots, ${Object.keys(state.files).length} files, ${rows} rows, collections ${cfg.collections.join(",")}`);
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
      await queue;
      failures.length = 0;
      if (params?.file && params?.force) {
        return { content: [{ type: "text", text: "Choose either file or force=true, not both." }], isError: true };
      }
      let requestedAbs: string | undefined;
      if (params?.file) {
        const requested = String(params.file);
        requestedAbs = path.resolve(cfg.vaultRoot, requested);
        if (path.isAbsolute(requested) || !isWithin(cfg.vaultRoot, requestedAbs) || !isManagedMarkdown(requestedAbs)) {
          return { content: [{ type: "text", text: `Rejected unmanaged vault path: ${requested}` }], isError: true };
        }
        if (!fs.existsSync(requestedAbs)) return { content: [{ type: "text", text: `Not found: ${requested}` }] };
      }
      if (rebuildDeferredReason) {
        return { content: [{ type: "text", text: rebuildDeferredReason }], isError: true };
      }
      if (params?.force) {
        enqueue(() => ensureIndexCompatibility(true));
        await queue;
        if (rebuildDeferredReason) {
          return { content: [{ type: "text", text: rebuildDeferredReason }], isError: true };
        }
      }
      if (requestedAbs) scheduleIndex(requestedAbs);
      else fullScan();
      await queue;
      if (failures.length) {
        return {
          content: [{ type: "text", text: `Index failed:\n${failures.map((message) => `- ${message}`).join("\n")}` }],
          isError: true,
        };
      }
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
