import assert from "node:assert/strict";
import { after, test } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { once } from "node:events";
import { createServer } from "node:http";
import { buildArgs, runCodex } from "../src/codex.ts";
import { config } from "../src/config.ts";
import { APP_SERVER_ARGS, threadParams } from "../src/appserver.ts";
import { createDashboardServer } from "../src/dashboard.ts";
import { DEFAULT_POLICY, validatePolicy } from "../src/policy.ts";
import { listSessions, sessionProvider } from "../src/sessions.ts";
import { extractCcswitch, importCcswitch, loadProviders, maskedProviders, maskKey, parseToml, prepareProviderHome, providerArgs, providerEnv, providerHome, PROVIDER_KEY, readCcswitch, saveProviders, selectModel, selectProvider, syncTokens, testProvider, tomlString, validateProviders } from "../src/providers.ts";

const root = mkdtempSync(join(tmpdir(), "cdp-providers-"));
after(() => rmSync(root, { recursive: true, force: true }));
const key = "sk-abcdef123456wxyz";
const doc = () => validateProviders({ providers: [{ id: "relay", name: "Relay", baseUrl: "https://example.test/v1", apiKey: key, model: "custom-model" }] });

test("provider precedence, system escape hatch, unknown id, and model precedence", () => {
  const d = doc(); d.defaultProvider = "relay";
  d.providers.push({ ...d.providers[0]!, id: "other" });
  assert.equal(selectProvider(d)?.id, "relay");
  assert.equal(selectProvider(d, undefined, "other")?.id, "other");
  assert.equal(selectProvider(d, "relay", "other")?.id, "relay");
  assert.equal(selectProvider(d, "system", "other"), undefined);
  assert.equal(selectProvider(d, undefined, "system"), undefined);
  assert.throws(() => selectProvider(d, "missing"), /Unknown provider id/);
  const p = d.providers[0];
  assert.equal(selectModel("explicit", p, "tier", "fallback"), "explicit");
  // The policy tier wins; the provider's model only fills a tier that names none.
  assert.equal(selectModel(undefined, p, "tier"), "tier");
  assert.equal(selectModel(undefined, p, undefined, "fallback"), "custom-model");
  assert.equal(selectModel(undefined, undefined, "tier"), "tier");
  assert.equal(selectModel(undefined, undefined, undefined, "fallback"), "fallback");
  const policy = validatePolicy({ ...DEFAULT_POLICY, tiers: DEFAULT_POLICY.tiers.map(t => ({ ...t, provider: "relay" })) }, []);
  assert(policy.ok); assert.equal(policy.policy.tiers[0]!.provider, "relay");
});

test("only an explicitly selected provider overrides system configuration", () => {
  const d = doc();
  assert.equal(selectProvider(d), undefined);
  d.defaultProvider = "relay";
  assert.equal(selectProvider(d)?.id, "relay");
  assert.equal(selectProvider(d, "system"), undefined);
  assert.equal(selectProvider(d, undefined, "system"), undefined);
  assert.equal(selectProvider({ defaultProvider: null, providers: [] }), undefined);
  d.providers.push({ ...d.providers[0]!, id: "other" });
  d.defaultProvider = null;
  assert.equal(selectProvider(d), undefined);
  assert.equal(selectProvider(d, "other")?.id, "other");
  d.defaultProvider = "relay";
  assert.equal(selectProvider(d)?.id, "relay");
});

test("no provider keeps exec and app-server argv byte-identical, including resume", () => {
  const missing = loadProviders(join(root, "absent.json"));
  assert.deepEqual(missing, { defaultProvider: null, providers: [] });
  const p = selectProvider(missing);
  assert.deepEqual(providerArgs(p), []);
  assert.deepEqual([...APP_SERVER_ARGS, ...providerArgs(p)], ["app-server", "-c", 'approval_policy="never"']);
  assert.deepEqual(buildArgs({ prompt: "x", sandbox: "read-only", provider: p }), ["exec", "-s", "read-only", "--json", "--skip-git-repo-check", "-c", 'approval_policy="never"', "--", "-"]);
  assert.deepEqual(buildArgs({ prompt: "x", sandbox: "read-only", sessionId: "abc", provider: p }), ["exec", "resume", "abc", "-c", 'sandbox_mode="read-only"', "--json", "--skip-git-repo-check", "-c", 'approval_policy="never"', "--", "-"]);
  assert(!("modelProvider" in threadParams({ prompt: "x", sandbox: "read-only" })));
});

test("overrides quote TOML strings/maps and keep API key off argv", () => {
  const p = { ...doc().providers[0]!, name: 'Relay "quoted"\nC:\\path\t\u0000\u007f', httpHeaders: { "X.foo": 'a"b' }, queryParams: { "api-version": "2026" } };
  const args = providerArgs(p);
  assert(args.includes('model_provider="cdp_relay"'));
  assert(args.includes(`model_providers.cdp_relay.env_key="${PROVIDER_KEY}"`));
  assert(args.includes(`model_providers.cdp_relay.name=${tomlString(p.name)}`));
  assert(args.includes('model_providers.cdp_relay.http_headers={"X.foo"="a\\"b"}'));
  assert(args.includes('model_providers.cdp_relay.requires_openai_auth=false'));
  assert(!args.join(" ").includes(key));
  assert.equal(threadParams({ prompt: "x", sandbox: "read-only", provider: p }).modelProvider, "cdp_relay");
  assert.throws(() => providerArgs({ ...p, extraToml: `secret = "${key}"` }), /API key/);
  assert.throws(() => validateProviders({ providers: [{ ...p, httpHeaders: { Authorization: key } }] }), /API key/);
  const escapedKey = 'secret"with\\escapes';
  assert.throws(() => validateProviders({ providers: [{ ...p, apiKey: escapedKey, httpHeaders: { Authorization: escapedKey } }] }), /API key/);
  assert.throws(() => providerArgs({ ...p, apiKey: escapedKey, extraToml: `secret = ${tomlString(escapedKey)}` }), /API key/);
});

test("extraToml handles sections, quoted/dotted keys, comments, arrays, and rejects unsupported input", () => {
  const text = `# ignored\nrequest_timeout = 12\n[features]\n"a.b" = true # comment\nvalues = ["x#y", 'literal', 2, false]\n["custom table"]\nx = {"quoted-key" = "v"}`;
  const parsed = [...parseToml(text).values()];
  assert.deepEqual(parsed[1], { keys: ["features", "a.b"], value: true });
  assert.deepEqual(parsed[2]!.value, ["x#y", "literal", 2, false]);
  assert(providerArgs({ ...doc().providers[0]!, extraToml: text }).includes('"features"."a.b"=true'));
  for (const invalid of ['x = "unterminated', 'x = """multi', '[[tables]]', 'x = 2026-01-01', 'x = 1\nx = 2', 'x = nope', 'garbage']) assert.throws(() => parseToml(invalid), /line/);
});

test("masking and round-trip PUT preserve omitted/masked keys and allow explicit clear", () => {
  const d = doc(); const masked = maskedProviders(d);
  assert.equal(masked.providers[0]!.apiKey, "sk-ab…wxyz");
  assert.equal(masked.providers[0]!.hasKey, true);
  assert(!JSON.stringify(masked).includes(key));
  assert.equal(validateProviders(masked, d).providers[0]!.apiKey, key);
  assert.equal(validateProviders({ providers: [{ ...masked.providers[0], apiKey: undefined }] }, d).providers[0]!.apiKey, key);
  assert.equal(validateProviders({ providers: [{ ...masked.providers[0], apiKey: "" }] }, d).providers[0]!.apiKey, "");
  assert.equal(maskKey("short"), "…");
  const file = join(root, "providers.json"); saveProviders(d, file);
  assert.deepEqual(loadProviders(file), d);
});

const configText = `model_provider = "relay"\nmodel = "custom-model"\n[model_providers.other]\nbase_url = "https://wrong.test"\n[model_providers.relay]\nname = "TOML name"\nbase_url = 'https://example.test/v1'\nwire_api = "responses"\nrequires_openai_auth = false\nenv_key = "IGNORE_ME"\nhttp_headers = {"X-Test" = "hello"}\n[model_providers.relay.query_params]\n"api-version" = "2026"\n[mcp_servers.foo]\ncommand = "ignored"\n[[unrelated]]\ndate = 2026-01-01`;
test("cc-switch extraction and read-only SQLite import/upsert use only selected provider", () => {
  assert.deepEqual(extractCcswitch(configText), { model: "custom-model", name: "TOML name", baseUrl: "https://example.test/v1", wireApi: "responses", requiresOpenaiAuth: false, httpHeaders: Object.assign(Object.create(null), { "X-Test": "hello" }), queryParams: Object.assign(Object.create(null), { "api-version": "2026" }) });
  assert.deepEqual(readCcswitch(join(root, "no.db")), []);
  const file = join(root, "cc.db"); const db = new DatabaseSync(file);
  assert.deepEqual(readCcswitch(file), []);
  db.exec("CREATE TABLE providers (id TEXT, app_type TEXT, name TEXT, website_url TEXT, notes TEXT, settings_config TEXT, is_current INTEGER)");
  const insert = db.prepare("INSERT INTO providers VALUES (?,?,?,?,?,?,?)");
  insert.run("original/id", "codex", "UI name", "https://example.test", "notes", JSON.stringify({ auth: { OPENAI_API_KEY: key }, config: configText }), 1);
  insert.run("claude", "claude", "ignore", null, null, "{}", 0); db.close();
  const before = readFileSync(file); const available = readCcswitch(file);
  assert.equal(available.length, 1); assert.equal(available[0]!.apiKey, key);
  assert.equal(available[0]!.source!.id, "original/id");
  assert(!JSON.stringify(available).includes("IGNORE_ME"));
  let imported = importCcswitch({ defaultProvider: null, providers: [] }, available, ["original/id"]);
  imported.providers[0]!.id = "renamed"; imported.defaultProvider = "renamed";
  imported = importCcswitch(imported, available, [available[0]!.id]);
  assert.equal(imported.providers.length, 1); assert.equal(imported.providers[0]!.id, "renamed");
  assert.deepEqual(readFileSync(file), before);
});

test("cc-switch resolves local router companion keys and bearer tokens without mixing providers", () => {
  const file = join(root, "cc-key-sources.db");
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE providers (id TEXT, app_type TEXT, name TEXT, website_url TEXT, notes TEXT, settings_config TEXT, is_current INTEGER)");
  const insert = db.prepare("INSERT INTO providers VALUES (?,?,?,?,?,?,?)");
  const add = (id: string, name: string, url: string, authKey = "", bearer = "") => insert.run(id, "codex", name, null, null, JSON.stringify({ auth: { OPENAI_API_KEY: authKey }, config: `model_provider="r"\n[model_providers.r]\nbase_url=${tomlString(url)}${bearer ? `\nexperimental_bearer_token=${tomlString(bearer)}` : ""}` }), 0);
  const companion = (id: string, name: string, url: string, token: string) => insert.run(id, "claude-desktop", name, null, null, JSON.stringify({ env: { ANTHROPIC_BASE_URL: url, ANTHROPIC_AUTH_TOKEN: token } }), 0);
  add("router", "Router", "http://127.0.0.1:18787/codex/v1");
  companion("desktop", "Router", "http://127.0.0.1:18787", key);
  add("explicit", "Router", "http://127.0.0.1:18787/codex/v1", "own-key");
  add("bearer", "Bearer", "https://example.test/v1", "   ", "bearer-key");
  add("different-name", "Other", "http://127.0.0.1:18787/codex/v1");
  add("different-port", "Router", "http://127.0.0.1:18788/codex/v1");
  add("different-path", "Router", "http://127.0.0.1:18787/other/v1");
  add("remote", "Remote", "https://example.test/codex/v1");
  companion("remote-desktop", "Remote", "https://example.test", "remote-key");
  add("ambiguous", "Ambiguous", "http://127.0.0.1:18787/codex/v1");
  companion("ambiguous-1", "Ambiguous", "http://127.0.0.1:18787", "first-key");
  companion("ambiguous-2", "Ambiguous", "http://127.0.0.1:18787", "second-key");
  db.close();
  const before = readFileSync(file);
  const providers = readCcswitch(file);
  const get = (id: string) => providers.find(p => p.source?.id === id)!;
  assert.equal(get("router").apiKey, key);
  assert.equal(get("explicit").apiKey, "own-key");
  assert.equal(get("bearer").apiKey, "bearer-key");
  for (const id of ["different-name", "different-port", "different-path", "remote", "ambiguous"]) assert.equal(get(id).apiKey, undefined);
  const imported = importCcswitch({ defaultProvider: null, providers: [] }, providers, ["router"]);
  assert.equal(imported.providers[0]!.apiKey, key);
  assert.equal(maskedProviders(imported).providers[0]!.hasKey, true);
  assert(!JSON.stringify(maskedProviders(imported)).includes(key));
  assert.deepEqual(readFileSync(file), before);
});

test("dashboard provider routes mask keys, enforce write guards, retain keys and import", async () => {
  const file = join(root, "api-providers.json");
  const server = createDashboardServer({ providersFile: file, ccswitchFile: join(root, "cc.db") });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const headers = { "Content-Type": "application/json", Origin: base };
  try {
    assert.equal((await fetch(base + "/api/providers", { method: "PUT", body: "{}" })).status, 403);
    assert.equal((await fetch(base + "/api/providers", { method: "PUT", headers: { ...headers, Origin: "http://evil.test" }, body: "{}" })).status, 403);
    const put = await fetch(base + "/api/providers", { method: "PUT", headers, body: JSON.stringify(doc()) });
    assert.equal(put.status, 200); const masked: any = await put.json();
    assert.equal(masked.providers[0].hasKey, true); assert(!JSON.stringify(masked).includes(key));
    assert.equal((await fetch(base + "/api/providers", { method: "PUT", headers, body: JSON.stringify(masked) })).status, 200);
    assert.equal(loadProviders(file).providers[0]!.apiKey, key);
    const listing = await (await fetch(base + "/api/providers/ccswitch")).json() as any;
    assert.equal(listing.providers.length, 1); assert(!JSON.stringify(listing).includes(key));
    const imported = await fetch(base + "/api/providers/ccswitch/import", { method: "POST", headers, body: JSON.stringify({ ids: ["original/id"] }) });
    assert.equal(imported.status, 200); assert.equal(loadProviders(file).providers.length, 2);
    assert.equal((await fetch(base + "/api/providers/relay/test", { method: "POST" })).status, 403);
    assert.equal((await fetch(base + "/api/providers/missing/test", { method: "POST", headers })).status, 404);
    assert.equal((await fetch(base + "/api/providers", { method: "PUT", headers, body: '{"apiKey":"secret",' })).status, 400);
  } finally { server.close(); server.closeAllConnections(); }
});

test("provider models probe forwards credentials/maps and truncates ids; errors do not echo keys", async () => {
  const server = createServer((req, res) => {
    assert.equal(req.url, "/v1/models?version=1"); assert.equal(req.headers.authorization, `Bearer ${key}`); assert.equal(req.headers["x-test"], "yes");
    res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ data: Array.from({ length: 25 }, (_, i) => ({ id: `model-${i}` })) }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const p = { ...doc().providers[0]!, baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1/`, httpHeaders: { "X-Test": "yes" }, queryParams: { version: "1" } };
  try { const result = await testProvider(p); assert.equal(result.ok, true); assert.equal(result.status, 200); assert("models" in result); assert.equal(result.models.length, 20); }
  finally { server.close(); server.closeAllConnections(); }
  const failed = await testProvider(p); assert.equal(failed.ok, false); assert(!JSON.stringify(failed).includes(key));
});

test("models probe retries gateways requiring client_version and reads Codex model slugs", async () => {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(req.url!);
    assert.equal(req.headers.authorization, `Bearer ${key}`);
    res.setHeader("Content-Type", "application/json");
    if (!req.url!.includes("client_version=")) {
      res.writeHead(400); res.end(JSON.stringify({ error: { message: "query client_version: Field required" } }));
    } else res.end(JSON.stringify({ models: [{ slug: "gpt-router" }] }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  try {
    const result = await testProvider({ ...doc().providers[0]!, baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`, queryParams: { version: "1" } });
    assert.equal(result.ok, true);
    assert.deepEqual("models" in result && result.models, ["gpt-router"]);
    assert.deepEqual(requests, ["/v1/models?version=1", "/v1/models?version=1&client_version=0.0.0"]);
  } finally { server.close(); server.closeAllConnections(); }
});

test("both spawned engines receive provider argv and child-only key; logs/results redact echoed keys", async () => {
  const original = { codex: config.codex, engine: config.engine };
  try {
    config.codex = { cmd: process.execPath, args: [join(import.meta.dirname, "fixtures", "provider-child.mjs")] };
    for (const engine of ["exec", "app-server"] as const) for (const apiKey of [key, 'sk-quoted"with\\escapes']) {
      config.engine = engine;
      const logFile = join(root, `${engine}.jsonl`), lastMessageFile = join(root, `${engine}-final.txt`);
      const result = await runCodex({ prompt: "test", sandbox: "read-only", cwd: root, provider: { ...doc().providers[0]!, apiKey }, timeoutMs: 5000, logFile, lastMessageFile });
      assert.equal(result.ok, true, result.error);
      assert.equal(result.text, "[REDACTED]");
      // Log stream is closed asynchronously by runCodex.
      await new Promise(resolve => setImmediate(resolve));
      assert(!readFileSync(logFile, "utf8").includes(apiKey));
      assert(!readFileSync(lastMessageFile, "utf8").includes(apiKey));
      const launch = JSON.parse(readFileSync(join(root, "provider-launch.json"), "utf8"));
      assert(launch.hasKey); assert(launch.args.includes('model_provider="cdp_relay"'));
      assert(!JSON.stringify(launch).includes(apiKey));
      assert(!JSON.stringify(result).includes(apiKey));
    }
    assert.notEqual(process.env[PROVIDER_KEY], key);
  } finally { config.codex = original.codex; config.engine = original.engine; }
});

const dates = ["2026-10-12T04:43:52.222894600Z", "2026-10-13T04:43:52Z", "2026-10-14T04:43:52Z"];
const accountId = "account-sensitive-123456";
const accountAuth = (tag: string, date = dates[0]!, id = accountId) => ({
  OPENAI_API_KEY: null, auth_mode: "chatgpt", email: "person@example.test", last_refresh: date,
  tokens: { account_id: id, id_token: `id-secret-${tag}`, access_token: `access-secret-${tag}`, refresh_token: `refresh-secret-${tag}` },
  poolImport: { keep: true },
});
function putJson(file: string, value: unknown) { mkdirSync(join(file, ".."), { recursive: true }); writeFileSync(file, JSON.stringify(value)); }
const getJson = (file: string) => JSON.parse(readFileSync(file, "utf8"));
function officialFixture() {
  const dir = mkdtempSync(join(root, "official-"));
  const paths = { homesRoot: join(dir, "homes"), codexHome: join(dir, "live"), ccswitchFile: join(dir, "cc.db") };
  const db = new DatabaseSync(paths.ccswitchFile);
  db.exec("CREATE TABLE providers (id TEXT, app_type TEXT, name TEXT, website_url TEXT, notes TEXT, category TEXT, settings_config TEXT, is_current INTEGER, PRIMARY KEY(id,app_type))");
  const settings = { config: 'model_provider="custom"\nmodel="gpt-6"\nmodel_reasoning_effort="high"\n[model_providers.custom]', auth: accountAuth("original"), poolImport: { outer: true }, email: "keep@example.test" };
  const insert = db.prepare("INSERT INTO providers VALUES (?,?,?,?,?,?,?,?)");
  insert.run("official", "codex", "Official", null, null, "official", JSON.stringify(settings), 1);
  insert.run("official", "claude", "Other app", null, null, "official", JSON.stringify(settings), 0);
  insert.run("official-api", "codex", "Official API", null, null, "official", JSON.stringify({ config: configText, auth: { OPENAI_API_KEY: key } }), 0);
  db.close();
  const available = readCcswitch(paths.ccswitchFile);
  const doc = importCcswitch({ defaultProvider: null, providers: [] }, available, ["official"], paths);
  const p = doc.providers[0]!;
  const homeFile = join(providerHome(p, paths.homesRoot), "auth.json"), liveFile = join(paths.codexHome, "auth.json");
  const readSettings = () => {
    const db = new DatabaseSync(paths.ccswitchFile);
    try { return JSON.parse(String(db.prepare("SELECT settings_config FROM providers WHERE id='official' AND app_type='codex'").get()!.settings_config)); } finally { db.close(); }
  };
  const setDbAuth = (auth: unknown) => {
    const db = new DatabaseSync(paths.ccswitchFile);
    try { db.prepare("UPDATE providers SET settings_config=? WHERE id='official' AND app_type='codex'").run(JSON.stringify({ ...settings, auth })); } finally { db.close(); }
  };
  return { dir, paths, available, doc, p, homeFile, liveFile, readSettings, setDbAuth, settings };
}

test("official import isolates tokens, masks display info, preserves newer home and sync preference", () => {
  const f = officialFixture();
  const file = join(f.dir, "providers.json"); saveProviders(f.doc, file);
  assert.equal(f.p.auth, "chatgpt"); assert.equal(f.p.sync, true); assert.equal(f.p.effort, "high");
  assert(!f.p.account!.accountId.includes(accountId)); assert.equal(f.p.account!.email, "person@example.test");
  assert.equal(f.available.find(p => p.source?.id === "official-api")!.apiKey, key);
  assert.deepEqual(getJson(f.homeFile), accountAuth("original"));
  if (process.platform !== "win32") assert.equal(statSync(f.homeFile).mode & 0o777, 0o600);
  for (const text of [readFileSync(file, "utf8"), JSON.stringify(f.available), JSON.stringify(maskedProviders(f.doc, f.paths)), JSON.stringify(maskedProviders({ defaultProvider: null, providers: f.available }))]) {
    for (const token of Object.values(accountAuth("original").tokens)) assert(!text.includes(token));
  }
  const display = maskedProviders(f.doc, f.paths).providers[0]!;
  assert.equal(display.hasTokens, true); assert.equal(display.lastRefresh, dates[0]);
  putJson(f.homeFile, accountAuth("home-new", dates[2])); f.p.sync = false;
  const imported = importCcswitch(f.doc, f.available, ["official"], f.paths);
  assert.equal(imported.providers[0]!.sync, false); assert.deepEqual(getJson(f.homeFile), accountAuth("home-new", dates[2]));
  f.setDbAuth(accountAuth("db-new", "2026-10-15T00:00:00Z"));
  importCcswitch(imported, readCcswitch(f.paths.ccswitchFile), ["official"], f.paths);
  assert.equal(getJson(f.homeFile).tokens.refresh_token, "refresh-secret-db-new");
});

test("sync chooses home, database, or matching live newest credentials and preserves unrelated keys", async () => {
  for (const winner of ["home", "ccswitch", "live"] as const) {
    const f = officialFixture();
    const home = { ...accountAuth("home", winner === "home" ? dates[2] : dates[0]), homeOnly: true };
    const dbAuth = { ...accountAuth("db", winner === "ccswitch" ? dates[2] : dates[0]), dbOnly: true };
    const live = { ...accountAuth("live", winner === "live" ? dates[2] : dates[0]), liveOnly: true };
    putJson(f.homeFile, home); f.setDbAuth(dbAuth); putJson(f.liveFile, live);
    const result = await syncTokens(f.p, f.paths);
    assert.equal(result.winner, winner); assert.equal(result.locations.filter(l => l.updated).length, 2);
    assert(!JSON.stringify(result).includes("secret"));
    const expected = { home, ccswitch: dbAuth, live }[winner];
    const settings = f.readSettings();
    assert.deepEqual(getJson(f.homeFile), { ...home, tokens: expected.tokens, last_refresh: expected.last_refresh });
    assert.deepEqual(settings, { ...f.settings, auth: { ...dbAuth, tokens: expected.tokens, last_refresh: expected.last_refresh } });
    assert.deepEqual(getJson(f.liveFile), { ...live, tokens: expected.tokens, last_refresh: expected.last_refresh });
    const db = new DatabaseSync(f.paths.ccswitchFile);
    assert.equal(JSON.parse(String(db.prepare("SELECT settings_config FROM providers WHERE app_type='claude'").get()!.settings_config)).auth.tokens.refresh_token, "refresh-secret-original"); db.close();
  }
});

test("sync skips different accounts, disabled sync, equal timestamps and unchanged refresh tokens", async () => {
  const f = officialFixture();
  putJson(f.liveFile, accountAuth("other", dates[2], "someone-else"));
  putJson(f.homeFile, accountAuth("home", dates[1]));
  const liveBefore = readFileSync(f.liveFile);
  assert.equal((await syncTokens(f.p, f.paths)).winner, "home");
  assert.deepEqual(readFileSync(f.liveFile), liveBefore);
  f.setDbAuth(accountAuth("other-db", dates[2], "another-account"));
  const dbBefore = readFileSync(f.paths.ccswitchFile);
  await syncTokens(f.p, f.paths); assert.deepEqual(readFileSync(f.paths.ccswitchFile), dbBefore);
  f.p.sync = false; putJson(f.homeFile, accountAuth("disabled", dates[2]));
  assert.deepEqual(await syncTokens(f.p, f.paths), { winner: null, locations: [] });
  assert.deepEqual(readFileSync(f.paths.ccswitchFile), dbBefore); assert.deepEqual(readFileSync(f.liveFile), liveBefore);
  f.p.sync = true; f.setDbAuth(accountAuth("tie-db", dates[2])); putJson(f.liveFile, accountAuth("tie-live", dates[2]));
  const before = [f.homeFile, f.liveFile, f.paths.ccswitchFile].map(file => readFileSync(file));
  const tied = await syncTokens(f.p, f.paths); assert.equal(tied.winner, null); assert(tied.locations.every(l => !l.updated));
  [f.homeFile, f.liveFile, f.paths.ccswitchFile].forEach((file, i) => assert.deepEqual(readFileSync(file), before[i]));
  const same = accountAuth("disabled", dates[1]); f.setDbAuth(same); rmSync(f.liveFile);
  const result = await syncTokens(f.p, f.paths); assert(result.locations.every(l => !l.updated));
  assert.equal(f.readSettings().auth.last_refresh, dates[1]);
});

test("sync treats missing timestamps as oldest and serializes parallel sync with stale-lock recovery", async () => {
  const f = officialFixture();
  const { last_refresh, ...old } = accountAuth("no-date"); putJson(f.homeFile, old);
  putJson(join(providerHome(f.p, f.paths.homesRoot), ".token-sync.lock"), "abandoned");
  const lock = join(providerHome(f.p, f.paths.homesRoot), ".token-sync.lock");
  utimesSync(lock, new Date(0), new Date(0));
  const results = await Promise.all([syncTokens(f.p, f.paths), syncTokens(f.p, f.paths)]);
  assert(results.some(r => r.winner === "ccswitch")); assert.equal(getJson(f.homeFile).last_refresh, dates[0]);
  assert(!existsSync(lock));
});

test("ChatGPT validation rejects token submissions and non-cc-switch sync; launch overrides ignore API fields", () => {
  const f = officialFixture();
  for (const tokens of [{ providers: [{ ...f.p, tokens: {} }] }, { providers: [{ ...f.p, account: { ...f.p.account, tokens: {} } }] }, { providers: [f.p], tokens: {} }]) assert.throws(() => validateProviders(tokens), /tokens/);
  assert.throws(() => validateProviders({ providers: [{ ...f.p, source: undefined, sync: false }] }), /sync/);
  assert.throws(() => validateProviders({ providers: [{ ...doc().providers[0], sync: true }] }), /sync/);
  const p = validateProviders({ providers: [{ ...f.p, baseUrl: "ignored", apiKey: key, extraToml: 'model_provider="custom"', httpHeaders: { Authorization: key } }] }).providers[0]!;
  assert.equal(p.baseUrl, undefined); assert.equal(p.apiKey, undefined);
  assert.deepEqual(providerArgs(p), ["-c", 'model_provider="openai"', "-c", 'cli_auth_credentials_store="file"']);
  assert.equal(threadParams({ prompt: "x", sandbox: "read-only", provider: p }).modelProvider, "openai");
  const env = providerEnv(p, { [PROVIDER_KEY]: key, OPENAI_API_KEY: key }, f.paths);
  assert.equal(env.CODEX_HOME, providerHome(p, f.paths.homesRoot)); assert.equal(env[PROVIDER_KEY], undefined); assert.equal(env.OPENAI_API_KEY, undefined);
  putJson(join(f.paths.codexHome, "config.toml"), "first"); writeFileSync(join(f.paths.codexHome, "AGENTS.md"), "guidance");
  prepareProviderHome(p, f.paths); assert.equal(readFileSync(join(providerHome(p, f.paths.homesRoot), "AGENTS.md"), "utf8"), "guidance");
  writeFileSync(join(f.paths.codexHome, "config.toml"), "second"); rmSync(join(f.paths.codexHome, "AGENTS.md"));
  prepareProviderHome(p, f.paths); assert.equal(readFileSync(join(providerHome(p, f.paths.homesRoot), "config.toml"), "utf8"), "second");
  assert(!existsSync(join(providerHome(p, f.paths.homesRoot), "AGENTS.md")));
});

// Tokens are read only from the isolated file, never passed to this child's argv/environment.
const chatgptChild = `import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path'; import {createInterface} from 'node:readline';
const args=process.argv.slice(2), home=process.env.CODEX_HOME, file=join(home,'auth.json');
let auth=JSON.parse(readFileSync(file,'utf8'));
if(args.includes('login')) { console.log('Logged in using ChatGPT '+auth.tokens.refresh_token); process.exit(0); }
if(process.env.CODEX_DELEGATE_PROVIDER_KEY || process.env.OPENAI_API_KEY) process.exit(4);
const launch={args,home,hasKey:false,before:auth.last_refresh};
writeFileSync('chatgpt-launch.json',JSON.stringify(launch));
const emit=x=>console.log(JSON.stringify(x));
const finish=()=>{auth={...auth,last_refresh:'2026-10-16T00:00:00Z',tokens:{...auth.tokens,refresh_token:'rotated-secret-refresh',access_token:'rotated-secret-access'}};writeFileSync(file,JSON.stringify(auth));};
if(args[0]==='app-server') {
for await(const line of createInterface({input:process.stdin})) { const msg=JSON.parse(line); if(msg.id===undefined)continue;
if(msg.method==='initialize')emit({id:msg.id,result:{}});
else if(msg.method==='thread/start'){if(msg.params.modelProvider!=='openai')process.exit(5);emit({id:msg.id,result:{thread:{id:'official-session'}}});}
else if(msg.method==='turn/start'){emit({id:msg.id,result:{turn:{id:'t'}}});finish();
if(process.env.TEST_PROVIDER_FAIL)process.exit(1);
emit({method:'item/completed',params:{item:{type:'agentMessage',text:auth.tokens.refresh_token}}});emit({method:'turn/completed',params:{turn:{id:'t',status:'completed'}}});}}
}else {for await(const chunk of process.stdin){}finish();if(process.env.TEST_PROVIDER_FAIL)process.exit(1);
emit({type:'thread.started',thread_id:'official-session'});emit({type:'item.completed',item:{type:'agent_message',text:auth.tokens.refresh_token}});emit({type:'turn.completed',usage:{}});}`;

test("both engines isolate official homes and sync before/after success and failure without leaking tokens", async () => {
  const original = { codex: config.codex, engine: config.engine };
  try {
    for (const engine of ["exec", "app-server"] as const) for (const fail of [false, true]) {
      const f = officialFixture(); const script = join(f.dir, "child.mjs"); writeFileSync(script, chatgptChild);
      config.codex = { cmd: process.execPath, args: [script] }; config.engine = engine;
      f.setDbAuth(accountAuth("db-before", dates[1])); putJson(f.liveFile, accountAuth("live"));
      const logFile = join(f.dir, "events.jsonl");
      const result = await runCodex({ prompt: "x", sandbox: "read-only", provider: f.p, providerPaths: f.paths, cwd: f.dir, timeoutMs: 5000, env: { TEST_PROVIDER_FAIL: fail ? "1" : "", [PROVIDER_KEY]: "must-be-removed" }, logFile });
      assert.equal(result.ok, !fail, result.error);
      assert.equal(f.readSettings().auth.tokens.refresh_token, "rotated-secret-refresh");
      assert.equal(getJson(f.liveFile).tokens.refresh_token, "rotated-secret-refresh");
      const launch = getJson(join(f.dir, "chatgpt-launch.json"));
      assert.equal(launch.home, providerHome(f.p, f.paths.homesRoot)); assert.equal(launch.hasKey, false); assert.equal(launch.before, dates[1]);
      assert(launch.args.includes('model_provider="openai"')); assert(launch.args.includes('cli_auth_credentials_store="file"'));
      await new Promise(resolve => setImmediate(resolve));
      for (const value of [JSON.stringify(result), readFileSync(logFile, "utf8"), JSON.stringify(launch)]) assert(!value.includes("rotated-secret"));
    }
    const f = officialFixture(); f.p.sync = false;
    const script = join(f.dir, "child.mjs"); writeFileSync(script, chatgptChild); config.codex = { cmd: process.execPath, args: [script] }; config.engine = "exec";
    const before = readFileSync(f.paths.ccswitchFile);
    await runCodex({ prompt: "x", sandbox: "read-only", provider: f.p, providerPaths: f.paths, cwd: f.dir, timeoutMs: 5000 });
    assert.deepEqual(readFileSync(f.paths.ccswitchFile), before); assert(!existsSync(f.liveFile));
    rmSync(f.homeFile);
    await assert.rejects(runCodex({ prompt: "x", sandbox: "read-only", provider: f.p, providerPaths: f.paths }), /re-import from cc-switch/);
  } finally { config.codex = original.codex; config.engine = original.engine; }
});

test("sync errors remain best-effort warnings on runs", async () => {
  const f = officialFixture(), script = join(f.dir, "child.mjs"); writeFileSync(script, chatgptChild);
  writeFileSync(f.paths.ccswitchFile, "invalid sqlite");
  const original = { codex: config.codex, engine: config.engine };
  try {
    config.codex = { cmd: process.execPath, args: [script] }; config.engine = "exec";
    const result = await runCodex({ prompt: "x", sandbox: "read-only", provider: f.p, providerPaths: f.paths, cwd: f.dir, timeoutMs: 5000 });
    assert.equal(result.ok, true); assert(result.warnings.some(w => /sync failed/.test(w)));
  } finally { config.codex = original.codex; config.engine = original.engine; }
});

test("official dashboard routes expose metadata, sync safely, probe login, and delete only auth.json", async () => {
  const f = officialFixture(); const file = join(f.dir, "providers.json"); saveProviders(f.doc, file);
  const server = createDashboardServer({ providersFile: file, ...f.paths }); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as any).port}`, headers = { Origin: base, "Content-Type": "application/json" };
  const endpoint = base + `/api/providers/${f.p.id}`, original = config.codex;
  try {
    for (const url of ["/api/providers", "/api/providers/ccswitch"]) {
      const response: any = await (await fetch(base + url)).json();
      const p = response.providers.find((p: any) => p.auth === "chatgpt"); assert(p.hasTokens); assert.equal(p.lastRefresh, dates[0]); assert.equal(p.sync, true);
      assert(!JSON.stringify(response).includes("secret")); assert(!JSON.stringify(response).includes(accountId));
    }
    assert.equal((await fetch(endpoint + "/sync", { method: "POST" })).status, 403);
    assert.equal((await fetch(endpoint + "/sync", { method: "POST", headers: { ...headers, Origin: "http://evil.test" } })).status, 403);
    const before = readFileSync(f.homeFile);
    let response = await fetch(base + "/api/providers", { method: "PUT", headers, body: JSON.stringify({ ...f.doc, providers: [{ ...f.p, tokens: { refresh_token: "never-save" } }] }) }); assert.equal(response.status, 400);
    response = await fetch(base + "/api/providers", { method: "PUT", headers, body: JSON.stringify({ ...f.doc, providers: [{ ...f.p, sync: false }] }) }); assert.equal(response.status, 200); assert.deepEqual(readFileSync(f.homeFile), before);
    assert.equal((await fetch(endpoint + "/sync", { method: "POST", headers })).status, 400);
    await fetch(base + "/api/providers", { method: "PUT", headers, body: JSON.stringify(f.doc) });
    f.setDbAuth(accountAuth("sync-api", dates[2]));
    response = await fetch(endpoint + "/sync", { method: "POST", headers }); assert.equal(response.status, 200);
    const synced: any = await response.json(); assert.equal(synced.winner, "ccswitch"); assert(synced.locations.some((l: any) => l.location === "home" && l.updated)); assert(!JSON.stringify(synced).includes("secret"));
    const script = join(f.dir, "child.mjs"); writeFileSync(script, chatgptChild); config.codex = { cmd: process.execPath, args: [script] };
    const probe: any = await (await fetch(endpoint + "/test", { method: "POST", headers })).json(); assert.equal(probe.ok, true); assert.equal(probe.output, "Logged in using ChatGPT"); assert(!JSON.stringify(probe).includes("secret"));
    const keep = join(providerHome(f.p, f.paths.homesRoot), "sessions", "keep.jsonl"); putJson(keep, {});
    response = await fetch(base + "/api/providers", { method: "PUT", headers, body: JSON.stringify({ providers: [] }) }); assert.equal(response.status, 200);
    assert(!existsSync(f.homeFile)); assert(existsSync(keep));
  } finally { config.codex = original; server.close(); server.closeAllConnections(); }
});

test("session discovery locates isolated provider rollouts for resume", () => {
  const f = officialFixture(), home = providerHome(f.p, f.paths.homesRoot);
  const rollout = join(home, "sessions", "2026", "10", "19", "rollout-2026-10-19-official-session.jsonl");
  putJson(rollout, { type: "session_meta", payload: { id: "official-session", cwd: f.dir, timestamp: dates[2] } });
  assert.equal(listSessions(f.dir, 20, join(home, "sessions"))[0]!.id, "official-session");
  assert.equal(sessionProvider("official-session", f.doc, f.paths.homesRoot)?.id, f.p.id);
  assert.equal(sessionProvider("absent", f.doc, f.paths.homesRoot), undefined);
});

test("dashboard timeline reads the recorded ChatGPT provider home", async () => {
  const f = officialFixture(), file = join(f.dir, "providers.json"), runsDir = join(f.dir, "runs"); saveProviders(f.doc, file);
  const id = "official-run", sessionId = "official-session", startedAt = Date.UTC(2026, 9, 19);
  putJson(join(runsDir, id, "meta.json"), { id, sessionId, provider: f.p.id, state: "ok", startedAt, endedAt: startedAt + 60000 });
  const event = JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "isolated timeline" }] } });
  const dir = join(providerHome(f.p, f.paths.homesRoot), "sessions", "2026", "10", "19"); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `rollout-date-${sessionId}.jsonl`), event + "\n");
  const server = createDashboardServer({ runsDir, providersFile: file, ...f.paths }); server.listen(0, "127.0.0.1"); await once(server, "listening");
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as any).port}/api/runs/${id}/timeline`);
    assert.equal(response.status, 200); const timeline: any = await response.json();
    assert.equal(timeline.source, "rollout"); assert.equal(timeline.entries[0].text, "isolated timeline");
  } finally { server.close(); server.closeAllConnections(); }
});
