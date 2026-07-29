#!/usr/bin/env node
// Read-only LanceDB/embedding health probe. Never drops, creates, indexes, or optimizes.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const agentDir = process.env.PI_AGENT_DIR || path.join(process.env.USERPROFILE || process.env.HOME, ".pi", "agent");
const vaultRoot = path.resolve(process.argv[2] || process.cwd());
const harnessPath = process.env.MY_SMART_PI_CONFIG || path.join(agentDir, "my-smart-pi.config.json");
const harness = fs.existsSync(harnessPath) ? JSON.parse(fs.readFileSync(harnessPath, "utf8")) : {};
const auto = harness.vaultAutoindex || harness;
const vmPath = path.resolve(vaultRoot, auto.vaultMindConfigPath || ".vault-mind/vault-mind.config.json");
const statePath = path.resolve(vaultRoot, auto.statePath || ".vault-mind/autoindex-state.json");
const failures = [], warnings = [], passes = [];
const pass = m => passes.push(m);
const warn = m => warnings.push(m);
const fail = m => failures.push(m);

if (!fs.existsSync(vmPath)) fail(`missing vault-mind config: ${vmPath}`);
let vm = {};
if (!failures.length) vm = JSON.parse(fs.readFileSync(vmPath, "utf8")).vaultMind || {};
const configuredDir = String(vm.dataDir || "");
const dataDir = path.resolve(path.dirname(vmPath), configuredDir);
let canonical = dataDir;
try { canonical = fs.realpathSync.native(dataDir); } catch {}
if (path.normalize(configuredDir) !== path.normalize(dataDir) && !path.isAbsolute(configuredDir)) warn(`dataDir is relative; canonical path is ${canonical}`);
pass(`canonical dataDir ${canonical}`);

let lancedb;
try {
  const direct = path.join(agentDir, "npm", "node_modules", "@lancedb", "lancedb", "dist", "index.js");
  const resolved = fs.existsSync(direct) ? direct : require.resolve("@lancedb/lancedb");
  lancedb = await import(pathToFileURL(resolved).href);
}
catch (e) { fail(`cannot load @lancedb/lancedb: ${e.message}`); }
let embedding;
const emb = vm.embedding || {};
if (emb.provider === "ollama") {
  const base = String(emb.localUrl || emb.ollamaHost || "http://127.0.0.1:11434").replace(/\/$/, "");
  const model = String(emb.model || emb.ollamaModel || "embeddinggemma");
  const expected = Number(emb.dim || (/^embeddinggemma(?::|$)/i.test(model) ? 768 : 0));
  try {
    let response = await fetch(`${base}/api/embed`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model, input: "my-smart-pi health probe" }), signal: AbortSignal.timeout(10000) });
    if (!response.ok) {
      response = await fetch(`${base}/api/embeddings`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model, prompt: "my-smart-pi health probe" }), signal: AbortSignal.timeout(10000) });
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    embedding = body.embeddings?.[0] || body.embedding;
    if (!Array.isArray(embedding)) throw new Error("response has no embedding vector");
    if (expected && embedding.length !== expected) fail(`embedding dimension ${embedding.length}; expected ${expected}`);
    else pass(`embedding ${base} model ${model} dimension ${embedding.length}`);
  } catch (e) { fail(`embedding endpoint/model failed: ${base} ${model}: ${e.message}`); }
} else fail(`embedding provider must remain ollama for embeddings; got ${String(emb.provider)}`);

if (lancedb && fs.existsSync(dataDir)) {
  try {
    const db = await lancedb.connect(dataDir);
    const names = await db.tableNames();
    const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : { files: {} };
    const rules = auto.collectionRules || [{ pattern: "^(AI Mind|Vault Mind)/Projects/", collection: "projects" }];
    const stateRows = { notes: 0, projects: 0 };
    for (const [source, item] of Object.entries(state.files || {})) {
      const collection = rules.find(r => new RegExp(r.pattern).test(source))?.collection || auto.defaultCollection || "notes";
      stateRows[collection] = (stateRows[collection] || 0) + Number(item.chunks || 0);
    }
    for (const collection of ["notes", "projects"]) {
      const name = `collection_${collection}`;
      if (!names.includes(name)) { fail(`missing table ${name}`); continue; }
      const table = await db.openTable(name);
      const schema = await table.schema();
      const vector = schema.fields.find(f => f.name === "vector");
      const dim = Number(vector?.type?.listSize);
      if (dim !== 768) fail(`${name} vector dimension ${dim}; expected 768`); else pass(`${name} schema vector[768]`);
      for (const required of ["id", "source", "fact", "vector"]) if (!schema.fields.some(f => f.name === required)) fail(`${name} missing field ${required}`);
      const rows = await table.countRows();
      pass(`${name} rows ${rows}; autoindex-state chunks ${stateRows[collection] || 0}`);
      if (rows !== (stateRows[collection] || 0)) warn(`${name} row/state delta ${rows - (stateRows[collection] || 0)}`);
      const indices = await table.listIndices();
      const fts = indices.find(i => String(i.indexType || "").toUpperCase() === "FTS" && i.columns?.includes("fact"));
      if (!fts) fail(`${name} missing FTS index on fact`);
      else {
        pass(`${name} FTS metadata ${fts.name || "present"}`);
        if (typeof table.indexStats === "function" && fts.name) {
          try {
            const stats = await table.indexStats(fts.name);
            const indexed = Number(stats?.numIndexedRows ?? stats?.indexedRows ?? 0);
            const unindexed = Number(stats?.numUnindexedRows ?? stats?.unindexedRows ?? rows - indexed);
            if (unindexed > 0 || indexed === 0) warn(`${name} FTS backlog indexed=${indexed} unindexed=${unindexed}`);
            else pass(`${name} FTS indexed rows ${indexed}`);
          } catch (e) { warn(`${name} FTS stats unavailable: ${e.message}`); }
        }
      }
      if (embedding?.length === 768) {
        await table.query().nearestTo(embedding).limit(1).toArray();
        pass(`${name} vector smoke query`);
      }
      await table.query().nearestToText("my-smart-pi health probe").limit(1).toArray();
      pass(`${name} FTS smoke query`);
    }
  } catch (e) { fail(`Lance smoke failed: ${e.message}`); }
} else if (!fs.existsSync(dataDir)) fail(`dataDir does not exist: ${dataDir}`);

const parent = path.dirname(dataDir);
if (fs.existsSync(parent)) {
  for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const full = path.join(parent, entry.name);
    if (/backup|\.bak|old/i.test(entry.name)) warn(`stale/backup Lance directory present: ${full}`);
  }
}
for (const candidate of [path.join(vaultRoot, ".vault-mind", "lancedb"), path.join(agentDir, ".vault-mind", "lancedb")]) {
  if (path.resolve(candidate) === path.resolve(dataDir) || !fs.existsSync(candidate)) continue;
  if (fs.readdirSync(candidate).length) warn(`competing non-empty Lance directory: ${candidate}`);
}
for (const m of passes) console.log(`PASS ${m}`);
for (const m of warnings) console.log(`WARN ${m}`);
for (const m of failures) console.log(`FAIL ${m}`);
process.exitCode = failures.length ? 1 : 0;
