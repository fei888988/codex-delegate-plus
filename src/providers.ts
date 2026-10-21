import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, watchFile, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { config } from "./config.ts";

export interface Provider {
  id: string;
  name: string;
  websiteUrl?: string;
  apiKey?: string;
  auth?: "apiKey" | "chatgpt";
  sync?: boolean;
  account?: { email?: string; accountId: string };
  baseUrl?: string;
  model?: string;
  effort?: string;
  wireApi?: string;
  requiresOpenaiAuth?: boolean;
  httpHeaders?: Record<string, string>;
  queryParams?: Record<string, string>;
  extraToml?: string;
  notes?: string;
  source?: { type: "cc-switch"; id: string };
}
export interface Providers { defaultProvider: string | null; providers: Provider[] }
export const providersFile = process.env.CODEX_DELEGATE_PROVIDERS || join(homedir(), ".codex-delegate", "providers.json");
export const homesRoot = join(homedir(), ".codex-delegate", "homes");
export const ccswitchFile = join(homedir(), ".cc-switch", "cc-switch.db");
export interface ProviderPaths { homesRoot?: string; codexHome?: string; ccswitchFile?: string }
interface AuthFile { tokens?: { account_id?: string; refresh_token?: string; [key: string]: unknown }; last_refresh?: string; [key: string]: unknown }
// Imported credentials never become enumerable provider properties or JSON.
const importedAuth = new WeakMap<Provider, AuthFile>();
export function providerHome(p: Provider, root = homesRoot): string {
  if (!ID.test(p.id)) throw Error("Invalid provider id");
  return join(root, p.id);
}
const refreshTime = (a?: AuthFile) => { const time = Date.parse(a?.last_refresh ?? ""); return Number.isFinite(time) ? time : -Infinity; };
const maskAccount = (id: string) => `${id.slice(0, 4)}…${createHash("sha256").update(id).digest("hex").slice(0, 8)}`;
function readAuth(file: string): AuthFile | undefined {
  if (!existsSync(file)) return undefined;
  try { const a = JSON.parse(readFileSync(file, "utf8")); if (a && typeof a === "object" && !Array.isArray(a)) return a; } catch {}
  throw Error("Invalid account auth.json; re-import from cc-switch");
}
function atomicJson(file: string, value: unknown) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    renameSync(tmp, file);
    if (process.platform !== "win32") chmodSync(file, 0o600);
  } finally { rmSync(tmp, { force: true }); }
}
function displayAuth(p: Provider, paths: ProviderPaths): AuthFile | undefined {
  try { return importedAuth.get(p) ?? (p.auth === "chatgpt" ? readAuth(join(providerHome(p, paths.homesRoot), "auth.json")) : undefined); } catch { return undefined; }
}
export const PROVIDER_KEY = "CODEX_DELEGATE_PROVIDER_KEY";
const ID = /^(?!system$)[a-zA-Z0-9_-]{1,64}$/;
export const maskKey = (key?: string) => key ? key.length > 9 ? `${key.slice(0, 5)}…${key.slice(-4)}` : "…" : "";
export const maskedProviders = (doc: Providers, paths: ProviderPaths = {}) => ({ defaultProvider: doc.defaultProvider, providers: doc.providers.map(p => {
  const a = displayAuth(p, paths);
  const safe = validateProviders({ providers: [p] }).providers[0]!;
  return { ...safe, apiKey: maskKey(p.apiKey), hasKey: !!p.apiKey, lastRefresh: a?.last_refresh ?? null, hasTokens: !!a?.tokens?.refresh_token };
}) });

/** TOML basic strings, including control characters JSON escapes differently. */
export const tomlString = (s: string) => JSON.stringify(s).replace(/\x7f/g, "\\u007f");
type Value = string | number | boolean | Value[] | { [key: string]: Value };
export const tomlValue = (v: Value): string => typeof v === "string" ? tomlString(v) : Array.isArray(v) ? `[${v.map(tomlValue).join(",")}]` : typeof v === "object" ? `{${Object.entries(v).map(([k, x]) => `${tomlString(k)}=${tomlValue(x)}`).join(",")}}` : String(v);

/** Deliberately small, strict TOML reader: unsupported syntax is reported with a line number. */
export function parseToml(text: string, ignoreUnrelated = false): Map<string, { keys: string[]; value: Value }> {
  const result = new Map<string, { keys: string[]; value: Value }>();
  let table: string[] = [];
  function keys(s: string): string[] {
    const parts = s.match(/"(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_-]+|\./g);
    if (!parts || parts.join("") !== s.replace(/\s+(?=(?:[^"]*"[^"]*")*[^"]*$)/g, "") || parts.length % 2 !== 1) throw Error();
    return parts.map((p, i) => { if (i % 2) { if (p !== ".") throw Error(); return ""; } return p.startsWith('"') ? JSON.parse(p) : p.startsWith("'") ? p.slice(1, -1) : p; }).filter((_, i) => !(i % 2));
  }
  function value(s: string): Value {
    let pos = 0;
    const ws = () => { while (/\s/.test(s[pos] ?? "") && pos < s.length) pos++; };
    function read(): Value {
      ws();
      const start = pos, c = s[pos++];
      if (c === '"' || c === "'") {
        while (pos < s.length) { const next = s[pos++]; if (next === c) return c === '"' ? JSON.parse(s.slice(start, pos).replace(/\\U([0-9a-fA-F]{8})/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))) : s.slice(start + 1, pos - 1); if (next === "\\" && c === '"') pos++; }
        throw Error();
      }
      if (c === "[" || c === "{") {
        const out: Value[] = [], obj: Record<string, Value> = Object.create(null), end = c === "[" ? "]" : "}";
        ws();
        while (s[pos] !== end) {
          if (c === "{") {
            const m = s.slice(pos).match(/^("(?:[^"\\]|\\.)*"|'[^']*'|[\w-]+)\s*=/);
            if (!m) throw Error();
            const k = keys(m[1]!)[0]!; pos += m[0].length;
            if (Object.hasOwn(obj, k)) throw Error(); obj[k] = read();
          } else out.push(read());
          ws(); if (s[pos] === end) break;
          if (s[pos++] !== ",") throw Error(); ws();
        }
        pos++; return c === "[" ? out : obj;
      }
      pos = start;
      const m = s.slice(pos).match(/^(true|false|[+-]?(?:\d[\d_]*)(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)(?=\s|,|\]|\}|$)/);
      if (!m) throw Error(); pos += m[0].length;
      return m[0] === "true" ? true : m[0] === "false" ? false : Number(m[0].replaceAll("_", ""));
    }
    const v = read(); ws(); if (pos !== s.length) throw Error(); return v;
  }
  for (const [i, raw] of text.split(/\r?\n/).entries()) {
    // Strip comments outside quoted strings.
    let quote = "", end = raw.length;
    for (let j = 0; j < raw.length; j++) {
      const c = raw[j];
      if (quote) { if (c === "\\" && quote === '"') j++; else if (c === quote) quote = ""; }
      else if (c === '"' || c === "'") quote = c;
      else if (c === "#") { end = j; break; }
    }
    const line = raw.slice(0, end).trim();
    if (!line) continue;
    try {
      if (line.startsWith("[")) {
        if (ignoreUnrelated && !/^\[\s*["']?model_providers["']?(?:\s*\.|\s*\])/.test(line)) { table = ["ignored"]; continue; }
        table = keys(line.slice(1, -1)); if (!line.endsWith("]") || line.startsWith("[[")) throw Error(); continue;
      }
      if (ignoreUnrelated && table[0] !== "model_providers" && (table.length || !/^(model|model_provider|model_reasoning_effort)\s*=/.test(line))) continue;
      const match = line.match(/^((?:"(?:[^"\\]|\\.)*"|'[^']*'|[^=])+?)\s*=\s*(.*)$/);
      if (!match) throw Error();
      const path = [...table, ...keys(match[1]!.trim())], id = JSON.stringify(path);
      if (ignoreUnrelated && path[0] === "model_providers" && !["base_url", "wire_api", "requires_openai_auth", "name", "http_headers", "query_params", "experimental_bearer_token"].includes(path[2]!)) continue;
      if (result.has(id)) throw Error();
      result.set(id, { keys: path, value: value(match[2]!) });
    } catch { throw new Error(`Unsupported or invalid TOML at line ${i + 1}`); }
  }
  return result;
}

export function validateProviders(input: unknown, previous: Providers = { defaultProvider: null, providers: [] }): Providers {
  const raw = input as any;
  if (!raw || !Array.isArray(raw.providers)) throw Error("providers must be an array");
  const rejectTokens = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Object.hasOwn(value, "tokens")) throw Error("tokens cannot be supplied; import accounts from cc-switch");
    for (const child of Object.values(value)) rejectTokens(child);
  };
  rejectTokens(raw);
  const providers: Provider[] = raw.providers.map((p: any) => {
    if (!p || typeof p.id !== "string" || !ID.test(p.id)) throw Error("Invalid provider id (1-64 letters, digits, '_' or '-'; 'system' is reserved)");
    if (Object.hasOwn(p, "tokens")) throw Error("tokens cannot be supplied; import accounts from cc-switch");
    if (p.auth !== undefined && !["apiKey", "chatgpt"].includes(p.auth)) throw Error("Invalid provider auth");
    if (typeof p.name !== "string" || !p.name.trim()) throw Error("Provider name is required");
    if (p.auth !== "chatgpt") {
      if (typeof p.baseUrl !== "string") throw Error("Provider baseUrl is required");
      let url: URL; try { url = new URL(p.baseUrl); } catch { throw Error("Invalid provider baseUrl"); }
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw Error("baseUrl must be an HTTP(S) URL without credentials");
    }
    if (p.wireApi !== undefined && (typeof p.wireApi !== "string" || !p.wireApi.trim())) throw Error("wireApi must be a nonempty string");
    if (p.requiresOpenaiAuth !== undefined && typeof p.requiresOpenaiAuth !== "boolean") throw Error("requiresOpenaiAuth must be boolean");
    const out: Provider = { id: p.id, name: p.name, ...(p.auth !== undefined ? { auth: p.auth } : {}), ...(p.auth === "chatgpt" ? {} : { baseUrl: p.baseUrl, wireApi: p.wireApi ?? "responses", requiresOpenaiAuth: p.requiresOpenaiAuth ?? false }) };
    for (const k of ["websiteUrl", "apiKey", "model", "effort", "extraToml", "notes"] as const) {
      if (p[k] !== undefined) { if (typeof p[k] !== "string") throw Error(`${k} must be a string`); out[k] = p[k]; }
    }
    const old = previous.providers.find(x => x.id === p.id);
    if (p.apiKey === undefined || (old?.apiKey && p.apiKey === maskKey(old.apiKey))) out.apiKey = old?.apiKey;
    for (const k of ["httpHeaders", "queryParams"] as const) {
      if (p[k] !== undefined) {
        if (!p[k] || typeof p[k] !== "object" || Array.isArray(p[k]) || Object.values(p[k]).some(v => typeof v !== "string")) throw Error(`${k} must map strings to strings`);
        out[k] = { ...p[k] };
      }
    }
    if (p.source !== undefined) {
      if (p.source?.type !== "cc-switch" || typeof p.source.id !== "string") throw Error("Invalid provider source");
      out.source = { type: "cc-switch", id: p.source.id };
    }
    if (p.sync !== undefined) {
      if (typeof p.sync !== "boolean" || out.source?.type !== "cc-switch") throw Error("sync requires a cc-switch source and a boolean");
      out.sync = p.sync;
    }
    if (p.account !== undefined) {
      if (typeof p.account?.accountId !== "string" || (p.account.email !== undefined && typeof p.account.email !== "string")) throw Error("Invalid account display info");
      out.account = { accountId: p.account.accountId, ...(p.account.email ? { email: p.account.email } : {}) };
    }
    if (out.auth === "chatgpt") {
      delete out.apiKey; delete out.httpHeaders; delete out.queryParams; delete out.extraToml;
    }
    if (out.extraToml) parseToml(out.extraToml);
    // A key belongs exclusively in the child environment, including when pasted into another field.
    if (out.apiKey && Object.entries(out).some(([k, v]) => k !== "apiKey" && JSON.stringify(v)?.includes(JSON.stringify(out.apiKey).slice(1, -1)))) throw Error("API key must appear only in apiKey");
    return out;
  });
  if (new Set(providers.map(p => p.id)).size !== providers.length) throw Error("Duplicate provider id");
  const defaultProvider = raw.defaultProvider ?? null;
  if (defaultProvider !== null && !providers.some(p => p.id === defaultProvider)) throw Error("Unknown default provider id");
  return { defaultProvider, providers };
}

export function loadProviders(file = providersFile): Providers {
  if (!existsSync(file)) return { defaultProvider: null, providers: [] };
  try { return validateProviders(JSON.parse(readFileSync(file, "utf8"))); }
  catch { throw Error("Invalid providers.json; correct it before selecting a provider"); }
}
export function saveProviders(doc: Providers, file = providersFile) {
  atomicJson(file, validateProviders(doc));
}
// Reads are fresh on every run; watching also invalidates consumers that cache the tool list.
export const watchProviders = (changed: () => void) => watchFile(providersFile, { interval: 2000, persistent: false }, changed);
export function selectProvider(doc: Providers, call?: string, tier?: string): Provider | undefined {
  const id = call ?? tier ?? doc.defaultProvider;
  if (!id || id === "system") return undefined;
  const p = doc.providers.find(p => p.id === id);
  if (!p) throw Error(`Unknown provider id '${id}'`);
  return p;
}
export const selectModel = (call: string | undefined, provider: Provider | undefined, tier: string | undefined, fallback?: string) => call ?? provider?.model ?? tier ?? fallback;
export const providerName = (p: Provider) => p.auth === "chatgpt" ? "openai" : `cdp_${p.id}`;
export function providerArgs(p?: Provider): string[] {
  if (!p) return [];
  if (p.auth === "chatgpt") return ["-c", 'model_provider="openai"', "-c", 'cli_auth_credentials_store="file"'];
  const prefix = `model_providers.${providerName(p)}`;
  const entries = new Map<string, string>();
  if (p.extraToml) for (const { keys, value } of parseToml(p.extraToml).values()) entries.set(keys.map(tomlString).join("."), tomlValue(value));
  entries.set("model_provider", tomlString(providerName(p)));
  for (const [k, v] of Object.entries({ name: p.name, base_url: p.baseUrl, wire_api: p.wireApi, requires_openai_auth: p.requiresOpenaiAuth, env_key: PROVIDER_KEY, http_headers: p.httpHeaders, query_params: p.queryParams })) {
    if (v !== undefined) entries.set(`${prefix}.${k}`, tomlValue(v));
  }
  const args = [...entries].flatMap(([k, v]) => ["-c", `${k}=${v}`]);
  if (p.apiKey && args.some(a => a.includes(p.apiKey!) || a.includes(JSON.stringify(p.apiKey).slice(1, -1)))) throw Error("API key cannot be included in provider overrides");
  return args;
}

export function extractCcswitch(config: string): Partial<Provider> {
  const entries = [...parseToml(config, true).values()];
  const top = (key: string) => entries.find(e => e.keys.length === 1 && e.keys[0] === key)?.value;
  const selected = top("model_provider");
  const result: any = {};
  if (typeof top("model") === "string") result.model = top("model");
  if (typeof top("model_reasoning_effort") === "string") result.effort = top("model_reasoning_effort");
  const fields: Record<string, string> = { base_url: "baseUrl", wire_api: "wireApi", requires_openai_auth: "requiresOpenaiAuth", name: "name", http_headers: "httpHeaders", query_params: "queryParams", experimental_bearer_token: "apiKey" };
  for (const { keys, value } of entries) {
    if (keys[0] !== "model_providers" || keys[1] !== selected || !fields[keys[2]!] || keys.length > 4) continue;
    const dest = fields[keys[2]!]!;
    if (keys.length === 3) result[dest] = value;
    else if (dest === "httpHeaders" || dest === "queryParams") (result[dest] ??= Object.create(null))[keys[3]!] = value;
  }
  return result;
}
export function readCcswitch(file = ccswitchFile): Provider[] {
  if (!existsSync(file)) return [];
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const rows = db.prepare("SELECT id,name,website_url,notes,settings_config,is_current FROM providers WHERE app_type='codex'").all();
    const companionRows = db.prepare("SELECT name,settings_config FROM providers WHERE app_type IN ('claude','claude-desktop')").all();
    const nonemptyKey = (value: unknown): string | undefined => typeof value === "string" && value.trim() ? value.trim() : undefined;
    const companionKey = (name: string, baseUrl: string | undefined): string | undefined => {
      if (!baseUrl) return;
      const target = new URL(baseUrl);
      // The local smart router shares one key across its Claude and Codex entry points.
      // Never infer credentials for remote servers or unrelated paths/providers.
      if (!["127.0.0.1", "localhost", "[::1]"].includes(target.hostname) || !/^\/codex(?:\/v1)?\/?$/.test(target.pathname)) return;
      const keys = new Set<string>();
      for (const row of companionRows) {
        if (row.name !== name) continue;
        try {
          const { env } = JSON.parse(String(row.settings_config));
          const source = new URL(env?.ANTHROPIC_BASE_URL);
          if (source.origin !== target.origin || !/^\/(?:v1\/?)?$/.test(source.pathname)) continue;
          const key = nonemptyKey(env.ANTHROPIC_AUTH_TOKEN) ?? nonemptyKey(env.ANTHROPIC_API_KEY);
          if (key) keys.add(key);
        } catch { /* Ignore malformed companion providers. */ }
      }
      return keys.size === 1 ? [...keys][0] : undefined;
    };
    // Broken rows are skipped independently; login credentials remain memory-only.
    return rows.flatMap((row): Provider[] => {
      try {
        const settings = JSON.parse(String(row.settings_config));
        const extracted = extractCcswitch(settings.config ?? "");
        const chatgpt = !extracted.baseUrl && settings.auth?.auth_mode === "chatgpt" && typeof settings.auth?.tokens?.account_id === "string" && !!settings.auth.tokens.refresh_token;
        if (!extracted.baseUrl && !chatgpt) return [];
        // Deterministic, safe local id; source.id retains the original identifier for upserts.
        const id = `cc_${createHash("sha256").update(String(row.id)).digest("hex").slice(0, 24)}`;
        const apiKey = chatgpt ? undefined : nonemptyKey(settings.auth?.OPENAI_API_KEY) ?? nonemptyKey(extracted.apiKey) ?? companionKey(String(row.name), extracted.baseUrl);
        const providers = validateProviders({ providers: [{ ...extracted, id, name: String(row.name), websiteUrl: row.website_url ?? undefined, notes: row.notes ?? undefined, ...(chatgpt ? { auth: "chatgpt", sync: true, account: { accountId: maskAccount(settings.auth.tokens.account_id), email: settings.auth.email ?? settings.auth.tokens.email } } : { apiKey }), source: { type: "cc-switch", id: String(row.id) } }] }).providers;
        if (chatgpt) importedAuth.set(providers[0]!, settings.auth);
        return providers;
      } catch { return []; }
    });
  } catch (e) {
    if (/no such table/i.test(String(e))) return [];
    throw Error("Unable to import cc-switch providers (invalid database or provider config)");
  } finally { db?.close(); }
}

export function importCcswitch(doc: Providers, available: Provider[], ids: string[], paths: ProviderPaths = {}): Providers {
  const providers = [...doc.providers];
  for (const id of ids) {
    const imported = available.find(p => p.source?.id === id || p.id === id);
    if (!imported) throw Error("Unknown cc-switch provider id");
    const index = providers.findIndex(p => p.source?.type === "cc-switch" && p.source.id === imported.source!.id);
    if (index < 0 && providers.some(p => p.id === imported.id)) throw Error("Imported provider id conflicts with existing provider");
    const next = { ...imported, ...(index >= 0 ? { id: providers[index]!.id, ...(imported.auth === "chatgpt" ? { sync: providers[index]!.sync ?? true } : {}) } : {}) };
    if (imported.auth === "chatgpt") {
      const incoming = importedAuth.get(imported);
      if (!incoming) throw Error("Missing account credentials; re-import from cc-switch");
      const file = join(providerHome(next, paths.homesRoot), "auth.json");
      const existing = readAuth(file);
      if (existing && existing.tokens?.account_id !== incoming.tokens?.account_id) throw Error("Account changed; remove the provider before re-importing");
      if (!existing || refreshTime(incoming) > refreshTime(existing)) atomicJson(file, incoming);
    }
    if (index >= 0) providers[index] = next;
    else providers.push(next);
  }
  return validateProviders({ ...doc, providers });
}

export function prepareProviderHome(p: Provider, paths: ProviderPaths = {}): string {
  const home = providerHome(p, paths.homesRoot);
  if (!readAuth(join(home, "auth.json"))) throw Error("Missing account auth.json; re-import from cc-switch");
  for (const name of ["config.toml", "AGENTS.md"]) {
    const source = join(paths.codexHome ?? config.codexHome, name), dest = join(home, name);
    if (existsSync(source)) copyFileSync(source, dest);
    else rmSync(dest, { force: true });
  }
  return home;
}

export function providerEnv(p?: Provider, extra: NodeJS.ProcessEnv = {}, paths: ProviderPaths = {}): NodeJS.ProcessEnv {
  const env = { ...process.env, ...extra };
  if (p?.auth === "chatgpt") {
    env.CODEX_HOME = providerHome(p, paths.homesRoot);
    delete env[PROVIDER_KEY];
    delete env.OPENAI_API_KEY;
    delete env.OPENAI_BASE_URL;
  } else if (p) env[PROVIDER_KEY] = p.apiKey ?? "";
  return env;
}

export function removeProviderAuth(p: Provider, paths: ProviderPaths = {}) {
  if (p.auth === "chatgpt") rmSync(join(providerHome(p, paths.homesRoot), "auth.json"), { force: true });
}

export function providerSecrets(p?: Provider, paths: ProviderPaths = {}): string[] {
  if (p?.auth !== "chatgpt") return p?.apiKey ? [p.apiKey] : [];
  const auth = readAuth(join(providerHome(p, paths.homesRoot), "auth.json"));
  return Object.values(auth?.tokens ?? {}).filter((v): v is string => typeof v === "string" && !!v);
}

/** The lock covers one reconciliation, not the whole model run. */
async function withProviderLock<T>(p: Provider, paths: ProviderPaths, action: () => T): Promise<T> {
  const home = providerHome(p, paths.homesRoot);
  mkdirSync(home, { recursive: true });
  const file = join(home, ".token-sync.lock"), owner = randomUUID(), deadline = Date.now() + 10000;
  for (;;) {
    try { writeFileSync(file, owner, { flag: "wx", mode: 0o600 }); break; }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw Error("Token sync lock unavailable");
      try { if (Date.now() - statSync(file).mtimeMs > 60000) rmSync(file); } catch {}
      if (Date.now() >= deadline) throw Error("Token sync lock timed out");
      await new Promise(r => setTimeout(r, 100));
    }
  }
  try { return action(); }
  finally { try { if (readFileSync(file, "utf8") === owner) rmSync(file); } catch {} }
}

type Location = "home" | "ccswitch" | "live";
export interface TokenSyncResult { winner: Location | null; locations: { location: Location; lastRefresh: string | null; updated: boolean }[] }
export async function syncTokens(p: Provider, paths: ProviderPaths = {}): Promise<TokenSyncResult> {
  if (p.auth !== "chatgpt") throw Error("Token sync requires a ChatGPT provider");
  if (p.sync !== true || p.source?.type !== "cc-switch") return { winner: null, locations: [] };
  try {
    return await withProviderLock(p, paths, () => {
      const homeFile = join(providerHome(p, paths.homesRoot), "auth.json");
      const home = readAuth(homeFile);
      const accountId = home?.tokens?.account_id;
      if (!accountId || (p.account && maskAccount(accountId) !== p.account.accountId)) throw Error("Account mismatch");
      const locations: { location: Location; auth: AuthFile; write: (winner: AuthFile) => void }[] = [];
      const addFile = (location: Location, file: string, auth?: AuthFile) => {
        if (auth?.tokens?.account_id !== accountId) return;
        locations.push({ location, auth, write: winner => {
          // Re-read to preserve unrelated edits and never overwrite a different account.
          const current = readAuth(file);
          if (current?.tokens?.account_id !== accountId) throw Error("Account changed during sync");
          if (refreshTime(current) > refreshTime(winner)) throw Error("Credentials changed during sync; retry");
          atomicJson(file, { ...current, tokens: winner.tokens, last_refresh: winner.last_refresh });
        } });
      };
      addFile("home", homeFile, home);
      let db: DatabaseSync | undefined;
      try {
        const dbFile = paths.ccswitchFile ?? ccswitchFile;
        if (existsSync(dbFile)) {
          db = new DatabaseSync(dbFile);
          db.exec("PRAGMA busy_timeout=5000; BEGIN IMMEDIATE");
          const row = db.prepare("SELECT settings_config FROM providers WHERE id=? AND app_type='codex'").get(p.source!.id);
          if (row) {
            const settings = JSON.parse(String(row.settings_config));
            if (settings.auth?.tokens?.account_id === accountId) locations.push({ location: "ccswitch", auth: settings.auth, write: winner => {
              settings.auth.tokens = winner.tokens; settings.auth.last_refresh = winner.last_refresh;
              db!.prepare("UPDATE providers SET settings_config=? WHERE id=? AND app_type='codex'").run(JSON.stringify(settings), p.source!.id);
            } });
          }
        }
        const liveFile = join(paths.codexHome ?? config.codexHome, "auth.json");
        addFile("live", liveFile, readAuth(liveFile));
        const newest = Math.max(...locations.map(l => refreshTime(l.auth)));
        const winners = locations.filter(l => refreshTime(l.auth) === newest);
        const winner = winners.length === 1 && newest > -Infinity ? winners[0] : undefined;
        const result: TokenSyncResult = { winner: winner?.location ?? null, locations: [] };
        for (const loc of locations) {
          const updated = !!winner && loc.auth.tokens?.refresh_token !== winner.auth.tokens?.refresh_token;
          if (updated) loc.write(winner!.auth);
          result.locations.push({ location: loc.location, lastRefresh: (updated ? winner!.auth : loc.auth).last_refresh ?? null, updated });
        }
        db?.exec("COMMIT");
        return result;
      } finally { db?.close(); }
    });
  } catch { throw Error("Token sync failed; check account files, cc-switch database access, and retry"); }
}

export async function testProvider(p: Provider, paths: ProviderPaths = {}) {
  const start = Date.now();
  if (p.auth === "chatgpt") {
    const home = providerHome(p, paths.homesRoot);
    if (!existsSync(join(home, "auth.json"))) return { ok: false, status: 0, ms: Date.now() - start, output: "Missing auth.json; re-import from cc-switch" };
    // Only return a known status phrase; arbitrary CLI output may contain credentials.
    return await new Promise<{ ok: boolean; status: number; ms: number; output: string }>(resolve => {
      execFile(config.codex.cmd, [...config.codex.args, ...providerArgs(p), "login", "status"], { env: providerEnv(p, {}, paths), timeout: 15000, maxBuffer: 8192, windowsHide: true }, (error, stdout, stderr) => {
        const status = /Logged in using ChatGPT/i.test(stdout + stderr) ? "Logged in using ChatGPT" : /not logged in/i.test(stdout + stderr) ? "Not logged in" : "Login status unavailable";
        resolve({ ok: !error, status: 0, ms: Date.now() - start, output: status });
      });
    });
  }
  try {
    const url = new URL(`${p.baseUrl!.replace(/\/+$/, "")}/models`);
    for (const [k, v] of Object.entries(p.queryParams ?? {})) url.searchParams.set(k, v);
    const options = { headers: { ...p.httpHeaders, ...(p.apiKey ? { Authorization: `Bearer ${p.apiKey}` } : {}) }, signal: AbortSignal.timeout(10000), redirect: "error" as const };
    let response = await fetch(url, options);
    let data: any = await response.json().catch(() => undefined);
    // Codex account gateways require a client version for model discovery.
    // Retry only that explicit validation error; preserve configured query values.
    if (response.status === 400 && !url.searchParams.has("client_version") && /client_version/.test(JSON.stringify(data?.error ?? ""))) {
      url.searchParams.set("client_version", "0.0.0");
      response = await fetch(url, options);
      data = await response.json().catch(() => undefined);
    }
    const models = Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : [];
    return { ok: response.ok, status: response.status, ms: Date.now() - start, ...(response.ok ? { models: models.map((m: any) => m?.id ?? m?.slug).filter((id: unknown) => typeof id === "string").slice(0, 20).map((s: string) => p.apiKey ? s.replaceAll(p.apiKey, "[REDACTED]") : s) } : { error: `HTTP ${response.status}` }) };
  } catch { return { ok: false, status: 0, ms: Date.now() - start, error: "Provider request failed or timed out" }; }
}
