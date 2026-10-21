# Per-run model providers (0.11.0)

Store providers in `~/.codex-delegate/providers.json`. Changes apply to the next run without restarting the MCP server. Each run starts its own Codex process; the system Codex configuration is never rewritten.

```json
{
  "defaultProvider": null,
  "providers": [{
    "id": "relay",
    "name": "My relay",
    "baseUrl": "https://relay.example/v1",
    "apiKey": "your-key",
    "model": "gpt-6.1-sol",
    "wireApi": "responses",
    "requiresOpenaiAuth": false
  }]
}
```

`delegate` and `delegate_async` accept `provider: "relay"`. Selection order is the call's `provider`, the policy tier's optional `provider`, `defaultProvider`, then system configuration. `provider: "system"` forces system configuration, including on tiers. Unknown ids fail clearly. A saved provider is used only when selected by the call, tier, or `defaultProvider`; an unset default inherits system configuration even when providers are saved. Invalid provider files fail rather than silently selecting different credentials; an explicit system selection also works.

Model selection is explicit call `model` > provider `model` > tier model > existing defaults. Optional provider `effort` follows the same order (a call naming a policy tier uses that tier's effort below provider effort). Existing policy model allowlists still apply: add a relay's models to `policy.models`, or use an empty list to allow any model. The existing model-name resolver and effort checks also apply. Follow-ups select providers afresh using the same precedence, except that a resume without an explicit provider automatically selects the ChatGPT provider whose home contains that session.

Optional fields: `websiteUrl`, `httpHeaders` and `queryParams` (string maps), `extraToml`, `notes`, and `source: {"type":"cc-switch","id":"original-id"}`. Provider ids contain 1–64 letters, digits, `_` or `-`; `system` is reserved. `wireApi` defaults to `responses`; Codex validates supported wire protocols. `requiresOpenaiAuth` defaults to false.

`extraToml` accepts single-line `key = value` assignments and `[table]` sections, dotted/quoted keys, strings, booleans, decimal numbers, arrays and inline tables. Comments are allowed outside strings. Multiline strings, array-of-table sections, dates and unsupported syntax fail with a line number. Standard provider fields take precedence over `extraToml`. CLI call/thread model settings take precedence over a model specified only in extra TOML. Do not put API keys into extra TOML or other provider fields.

API-key providers (`auth: "apiKey"`, also the default when absent) receive `-c model_provider="cdp_<id>"` and provider table overrides in both engines. App-server thread start/resume/fork also receive `modelProvider`. The key is passed only through the child's `CODEX_DELEGATE_PROVIDER_KEY`; argv contains the environment variable name. Run metadata records `provider` as the local id or `system`, never credentials. Provider files contain plaintext API keys; restrict access to your user account.

Official ChatGPT-login accounts imported from cc-switch use `auth: "chatgpt"`. They need no `baseUrl`, API key, wire protocol or headers. Their tokens live only in `~/.codex-delegate/homes/<providerId>/auth.json`, written atomically with mode 0600 where supported; provider JSON and API responses contain only masked account ids, optional email, and refresh/presence metadata. Every run refreshes that home's `config.toml` and `AGENTS.md` from the real Codex home without copying auth, sessions or databases. Both engines use `CODEX_HOME=<isolated home>`, `model_provider="openai"` and `cli_auth_credentials_store="file"`; no provider-key environment variable is passed. A missing auth file requires re-import. Session listing includes these homes, resumes infer their provider when none is explicit, and dashboard timelines use the recorded provider's home. Deleting an account removes only its `auth.json`, retaining sessions and other files.

Imported accounts default to `sync: true`; re-import preserves your setting and keeps a newer isolated auth file. `sync` is allowed only with a cc-switch source. Before and after each run (including failed runs), sync compares `last_refresh` in the isolated home, the original cc-switch Codex row, and the live Codex auth file only when its account id matches. The uniquely newest timestamp wins; missing/invalid timestamps are oldest and ties do nothing. Only differing refresh tokens trigger writes, and only `tokens` and `last_refresh` change in matching accounts; unrelated JSON keys are preserved and rows are never inserted. Reconciliations use a per-provider lock with retries and stale-lock recovery plus a five-second SQLite busy timeout. Failures add a warning to run notes without failing the run. With `sync: false`, only the isolated copy is used: refresh-token rotation in any other copy can invalidate it, and refreshing the isolated copy can log out stale cc-switch/live copies. Independent Codex or cc-switch processes do not share the reconciliation lock, so simultaneous refreshes can still race.

Dashboard backend API (no dashboard UI changes):

| Method/path | Body/result |
| --- | --- |
| `GET /api/providers` | Full document with masked `apiKey`, `hasKey`, `auth`, `sync`, masked `account`, `lastRefresh` and `hasTokens` where applicable; never tokens |
| `PUT /api/providers` | Full document; omitted or unchanged masked key keeps the stored key; `""` clears it; may toggle `sync`; token fields are rejected and auth files remain untouched except on deletion |
| `GET /api/providers/ccswitch` | Same document shape listing importable Codex providers |
| `POST /api/providers/ccswitch/import` | `{"ids":["original-cc-switch-id"]}`; returns updated masked document |
| `POST /api/providers/:id/test` | API keys: GETs `/models`, 10-second timeout, first 20 ids. ChatGPT: isolated `codex login status`, 15-second timeout, returns `ok` and short sanitized `output` (plus `ms` and `status: 0`) |
| `POST /api/providers/:id/sync` | Returns `{winner: "home"|"ccswitch"|"live"|null, locations: [{location,lastRefresh,updated}]}`; 400 unless ChatGPT with sync enabled |

Writes and test requests require a loopback Host, matching Origin when supplied, and `Content-Type: application/json`, matching the policy endpoint's write guard. Reads follow the policy endpoint's read behavior. Errors never echo keys or upstream response bodies. Masked keys look like `sk-ab…wxyz`; very short keys are entirely masked.

cc-switch import uses Node's built-in SQLite API, reads `~/.cc-switch/cc-switch.db` read-only, and imports only `app_type='codex'`. It extracts the selected model-provider table, top-level model/effort and `auth.OPENAI_API_KEY`, ignoring MCP configuration and `env_key`. Official rows with an API key and base URL remain API-key providers; ChatGPT-login rows without a base URL are also imported, with credentials written into their isolated home. Missing database/table yields an empty list. Invalid rows are skipped. Import upserts by original `source.id` and preserves any renamed local id and default binding. Import never changes cc-switch or the current default automatically; enabled token sync can update the original row during runs or explicit sync.

Existing behavior changes: selecting a custom provider with a model replaces the tier's model unless the call supplies a model. A null default with no tier/call provider retains existing behavior. No existing arguments, recovery paths or engine options were removed.
