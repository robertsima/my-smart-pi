/**
 * Configurable global vault collection tools for pi-vault-mind.
 *
 * Lets agents search/query one configured vault-mind store from any cwd,
 * without cd'ing into the vault. No user data is bundled; paths come from
 * local config or env.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);

type RawConfig = {
  globalVaultCollections?: RawConfig;
  vaultAutoindex?: RawConfig;
  vaultRoot?: string;
  vaultMindConfigPath?: string;
  lanceModulePath?: string;
  promptLabel?: string;
};

type Config = {
  vaultRoot: string;
  vaultMindConfigPath: string;
  lanceModulePath: string;
  promptLabel: string;
};

const agentDir = () =>
  process.env.PI_AGENT_DIR || path.join(process.env.USERPROFILE || process.env.HOME || process.cwd(), ".pi", "agent");

const readJsonIfExists = (file: string): any | undefined => {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    console.log(`[my-smart-pi:global-vault] ignoring invalid config ${file}: ${(error as Error).message}`);
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
      "Could not find pi-vault-mind LanceDB helper. Install pi-vault-mind or set PI_VAULT_MIND_LANCE_JS / lanceModulePath.",
    );
  }
  return found;
};

const loadHarnessConfig = (cwd: string): Config => {
  const configFile = findConfigFile(cwd);
  const loaded = configFile ? readJsonIfExists(configFile) ?? {} : {};
  const raw: RawConfig = loaded.globalVaultCollections ?? loaded.vaultAutoindex ?? loaded;
  const vaultRoot = path.resolve(raw.vaultRoot || process.env.PI_VAULT_ROOT || cwd);
  return {
    vaultRoot,
    vaultMindConfigPath: resolveMaybeRelative(vaultRoot, raw.vaultMindConfigPath || ".vault-mind/vault-mind.config.json"),
    lanceModulePath: resolveLanceModule(raw, cwd),
    promptLabel: raw.promptLabel || path.basename(vaultRoot) || "configured vault",
  };
};

let cfg: Config | undefined;
let lanceMod: any;
let lancePath: string | undefined;

const lance = async () => {
  if (!cfg) throw new Error("Global vault collections are not configured.");
  if (!lanceMod || lancePath !== cfg.lanceModulePath) {
    lancePath = cfg.lanceModulePath;
    lanceMod = await import(`${pathToFileURL(cfg.lanceModulePath).href}?global-vault-collections`);
  }
  return lanceMod;
};

const loadConfig = (): any => {
  if (!cfg) throw new Error("Global vault collections are not configured.");
  return JSON.parse(fs.readFileSync(cfg.vaultMindConfigPath, "utf8"));
};
const loadVmConfig = (): any => loadConfig().vaultMind;
const collections = (): Record<string, any> => loadConfig().collections ?? {};
const absPath = (p: string): string => (path.isAbsolute(p) ? p : path.join(cfg!.vaultRoot, p));

const stripVectors = (node: any): any => {
  if (Array.isArray(node)) return node.map(stripVectors);
  if (node && typeof node === "object") {
    const out: any = {};
    for (const [key, value] of Object.entries(node)) {
      if (key === "vector") continue;
      if (Array.isArray(value) && value.length > 32 && value.every((x) => typeof x === "number")) continue;
      out[key] = stripVectors(value);
    }
    return out;
  }
  return node;
};

const countJsonl = (file: string): number => {
  try {
    if (!fs.existsSync(file)) return 0;
    return fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).length;
  } catch {
    return 0;
  }
};

export default async function (pi: any) {
  const ensureConfig = (ctx: any) => {
    if (!cfg) cfg = loadHarnessConfig(ctx.cwd);
    return cfg;
  };

  pi.on("session_start", (_event: any, ctx: any) => {
    try { cfg = loadHarnessConfig(ctx.cwd); }
    catch (error) { console.log(`[my-smart-pi:global-vault] disabled: ${(error as Error).message}`); }
  });

  pi.on("before_agent_start", async (event: any, ctx: any) => {
    try { ensureConfig(ctx); } catch { return; }
    const note =
      "\n\n[Global vault collections]\n" +
      `${cfg!.promptLabel} vault-mind collections are accessible from any working directory via ` +
      "vault_collection_search, vault_collection_query, vault_collection_list, and vault_collection_status. " +
      "Use these when vm_search/vm_query are unavailable or tied to another cwd.\n";
    if (event.systemPrompt.includes("[Global vault collections]")) return;
    return { systemPrompt: event.systemPrompt + note };
  });

  pi.registerTool({
    name: "vault_collection_search",
    label: "Vault Collection Search",
    description:
      "Global hybrid semantic + full-text search over configured vault-mind collections (notes, projects, main, session_memory, etc.) from any cwd.",
    promptSnippet: 'vault_collection_search(collection="notes", query="...", limit=5)',
    parameters: {
      type: "object",
      properties: {
        collection: { type: "string", description: "Collection name. Defaults to notes." },
        query: { type: "string", description: "Natural-language or keyword query." },
        limit: { type: "number", description: "Max results, default 5, max 20." },
      },
      required: ["query"],
    },
    async execute(_id: string, params: { collection?: string; query: string; limit?: number }, _signal: AbortSignal, _onUpdate: unknown, ctx: any) {
      ensureConfig(ctx);
      const collection = params.collection || "notes";
      if (!collections()[collection]) throw new Error(`Unknown vault collection: ${collection}`);
      const { searchHybridRanked } = await lance();
      const rows = await searchHybridRanked(
        loadVmConfig().dataDir,
        collection,
        params.query,
        Math.min(Math.max(params.limit ?? 5, 1), 20),
        loadVmConfig(),
      );
      return { content: [{ type: "text", text: JSON.stringify(stripVectors(rows), null, 2) }] };
    },
  });

  pi.registerTool({
    name: "vault_collection_query",
    label: "Vault Collection Query",
    description:
      "Global deterministic JSONL query over configured vault-mind collections. Best for exact IDs/tags in JSONL-backed collections; note autoindex collections may be vector-only.",
    promptSnippet: 'vault_collection_query(collection="main", query="decision", limit=10)',
    parameters: {
      type: "object",
      properties: {
        collection: { type: "string", description: "Collection name. Defaults to main." },
        query: { type: "string", description: "Case-insensitive substring query." },
        filters: { type: "object", description: "Exact field filters, e.g. {tag: 'career'}." },
        limit: { type: "number", description: "Max results, default 20, max 100." },
        offset: { type: "number", description: "Offset, default 0." },
      },
    },
    async execute(_id: string, params: { collection?: string; query?: string; filters?: Record<string, string>; limit?: number; offset?: number }, _signal: AbortSignal, _onUpdate: unknown, ctx: any) {
      ensureConfig(ctx);
      const collection = params.collection || "main";
      const def = collections()[collection];
      if (!def) throw new Error(`Unknown vault collection: ${collection}`);
      const schema = Array.isArray(def.schema)
        ? def.schema
        : Array.isArray(collections()[def.schema]?.schema)
          ? collections()[def.schema].schema
          : ["id", "domain", "source", "fact", "tag", "artifact"];
      const { queryCollection } = await lance();
      const rows = await queryCollection(
        absPath(def.path),
        schema,
        params.query,
        params.filters,
        Math.min(Math.max(params.limit ?? 20, 1), 100),
        Math.max(params.offset ?? 0, 0),
      );
      return { content: [{ type: "text", text: JSON.stringify(stripVectors(rows), null, 2) }] };
    },
  });

  pi.registerTool({
    name: "vault_collection_list",
    label: "Vault Collection List",
    description: "List configured vault-mind collections and JSONL row counts from any cwd.",
    parameters: { type: "object", properties: {} },
    async execute(_id: string, _params: unknown, _signal: AbortSignal, _onUpdate: unknown, ctx: any) {
      ensureConfig(ctx);
      const rows = Object.entries(collections()).map(([name, def]: [string, any]) => ({
        name,
        path: def.path,
        schema: def.schema,
        dedupField: def.dedupField,
        jsonlRows: typeof def.path === "string" ? countJsonl(absPath(def.path)) : 0,
      }));
      return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
    },
  });

  pi.registerTool({
    name: "vault_collection_status",
    label: "Vault Collection Status",
    description: "Show configured global vault LanceDB table status from any cwd.",
    parameters: { type: "object", properties: {} },
    async execute(_id: string, _params: unknown, _signal: AbortSignal, _onUpdate: unknown, ctx: any) {
      ensureConfig(ctx);
      const { getStatus } = await lance();
      const status = await getStatus(loadVmConfig().dataDir);
      return { content: [{ type: "text", text: JSON.stringify(status, null, 2) }] };
    },
  });
}
