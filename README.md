# Orgo MCP Server

Model Context Protocol server for the [Orgo API](https://orgo.space/docs/api-reference). Lets LLM agents — Claude Desktop, Claude.ai, Cursor, Gemini, OpenAI Responses, custom agents — manage Orgo organizations: members, events, payments, contracts, communications, governance, learning.

Built on the enriched Orgo OpenAPI spec: **488 paths**, **787 operations**, **122 resource families**, **18 webhook events**, hand-curated tag descriptions and code samples shipped in the package. That includes the **website builder** — an agent connected here can move an organisation's site in from WordPress or Squarespace and author pages on it.

---

## Two deployment modes

| Mode | Transport | Auth | Use when |
|---|---|---|---|
| **Local (stdio)** | `stdio` | Api-Token / JWT / OAuth env var | Claude Desktop, Cursor, CLI agents on a developer machine |
| **Hosted (HTTP)** | Streamable HTTP | OAuth bearer (delegated to Orgo's OAuth server) | Claude.ai integrations, remote agents, multi-user deployments |

You can run both from the same codebase — the tool/resource layer is identical.

---

## Mode 1 — Local stdio (Claude Desktop, Cursor, CLI)

### Claude Desktop config

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "orgo": {
      "command": "npx",
      "args": ["-y", "orgo-mcp"],
      "env": {
        "ORGO_TENANT_HOST": "acme.orgo.space",
        "ORGO_API_TOKEN": "otk_xxx"
      }
    }
  }
}
```

Restart Claude Desktop. The Orgo tools appear in the tool tray; the concept docs and recipes appear in the `@` mention menu. Generate an Api-Token in **Settings → Developers → API Access**.

### Cursor / Cline / other stdio clients

Same idea — point them at `npx -y orgo-mcp` with the env vars set.

### Run it directly

```bash
ORGO_TENANT_HOST=acme.orgo.space \
ORGO_API_TOKEN=otk_xxx \
npx -y orgo-mcp
```

It speaks MCP over stdio.

### Build from source

If you want to hack on it:

```bash
git clone https://github.com/orgo-space/orgo-mcp.git
cd orgo-mcp
npm install
npm run build
```

The build step rebuilds `src/data/` from the Orgo docs repo. The default source path (`/Users/alex/api-docs`) is the maintainer's local checkout; everyone else should set `ORGO_DOCS_REPO`:

```bash
ORGO_DOCS_REPO=/path/to/your/api-docs/checkout npm run build
```

### Against a local Orgo (development)

```bash
npm install && npm run build:code

claude mcp add orgo-local \
  --env ORGO_TENANT_HOST=localhost:8088 \
  --env ORGO_PROTOCOL=http \
  --env ORGO_API_TOKEN=... \
  -- node "$(pwd)/dist/index.js"
```

`ORGO_PROTOCOL=http` is required — the default is https and a bare `localhost:8088` over TLS fails at
the socket. Tenant comes from the authenticated user, so the `Host` header does not have to resolve.

### Auth options (env)

| Variable | Header | Use when |
|---|---|---|
| `ORGO_API_TOKEN` | `Api-Token` | Server-to-server, scripts, CRON. Generate in admin UI. |
| `ORGO_JWT` | `Authorization: Bearer` | Session from `POST /api/v1/login` or OTP verify. ~11d lifetime. |
| `ORGO_OAUTH_TOKEN` | `Authorization: Bearer` | OAuth access token from a third-party app. |
| `ORGO_CONTACT_HASH` | `X-Contact-Hash` | Anonymous-contact context (event landing pages). |

Pick exactly one. `ORGO_TENANT_HOST` is always required (Orgo resolves tenant from the `Host` header).

---

## Mode 2 — Hosted HTTP server with OAuth (Claude.ai, remote agents)

The HTTP server lets multiple users connect with their own Orgo identities via OAuth. Each user's bearer token is forwarded to the Orgo API for every call they make — no shared service account, no cross-user data leakage.

### Run it

```bash
ORGO_TENANT_HOST=acme.orgo.space \
ORGO_PUBLIC_BASE_URL=https://acme.mcp.orgo.space \
PORT=3333 \
node dist/http.js
```

### Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET`  | `/`                                           | Landing JSON |
| `GET`  | `/healthz`                                    | Health check |
| `GET`  | `/.well-known/oauth-protected-resource`       | [RFC 9728](https://datatracker.ietf.org/doc/html/rfc9728) Protected Resource Metadata |
| `GET`  | `/.well-known/oauth-authorization-server`     | [RFC 8414](https://datatracker.ietf.org/doc/html/rfc8414) Auth Server Metadata (synthesized, points at Orgo's real `/oauth/*` endpoints) |
| `POST` | `/mcp`                                        | JSON-RPC over Streamable HTTP |
| `GET`  | `/mcp`                                        | SSE event stream (resumability) |
| `DELETE` | `/mcp`                                      | Terminate session |

### Why the synthetic metadata?

Orgo's OAuth server does not publish RFC 8414 (auth server metadata) or RFC 9728 (protected resource metadata). The MCP spec (rev 2025-06-18) expects discovery via those documents. To bridge that gap, the MCP server publishes them itself, pointing at Orgo's actual endpoints, including Orgo's RFC 7591 dynamic client registration endpoint (`/api/v1/oauth/register`). Standard MCP clients (Claude.ai, etc.) discover everything they need with no manual configuration: no client_id, no secret.

### OAuth flow at runtime

1. Claude.ai (or other MCP client) hits `POST /mcp` without a token → server returns `401 WWW-Authenticate: Bearer resource_metadata="..."`.
2. Client fetches `/.well-known/oauth-protected-resource` → discovers our authorization-server URL.
3. Client fetches `/.well-known/oauth-authorization-server` → discovers Orgo's `/oauth/authorize` + `/oauth/token`.
4. Client redirects the user to Orgo's `/oauth/authorize`. User logs in, consents.
5. Client exchanges the code at `/oauth/token` and receives a bearer access token.
6. Client retries `POST /mcp` with `Authorization: Bearer <token>`. The MCP server validates by calling Orgo's `/oauth/userinfo`. If valid, the token is cached (60s) and forwarded to every Orgo API call this session makes.

### Connector setup (Claude.ai)

In Claude.ai → Settings → Connectors → Add custom connector:
- **URL**: `https://acme.mcp.orgo.space/mcp` (the app shows each organisation its own address under Website → Build by asking). Tenants on a custom domain use the apex, `https://mcp.orgo.space/mcp`.
- No client ID or secret: Claude.ai registers itself through dynamic client registration, then opens Orgo's consent screen. PKCE is negotiated automatically.

Every tenant subdomain is served by one wildcard certificate (see `Caddyfile`); there is no per-tenant TLS step.

Once connected, Claude.ai shows the full Orgo tool tray scoped to the connected user's permissions.

### Gemini / OpenAI / custom agents

Any MCP client that supports remote/HTTP transport works the same way. Some agents (e.g. server-side OpenAI Responses tools) may bypass OAuth and just pass a pre-issued Api-Token directly in the bearer header — that works too: the server validates by calling userinfo and Orgo accepts Api-Token there too.

### Multi-tenant hosting

The simplest multi-tenant pattern is **one deployment per tenant subdomain**, mirroring how the Orgo API itself is routed:

```
acme.mcp.orgo.space     → ORGO_TENANT_HOST=acme.orgo.space
contoso.mcp.orgo.space  → ORGO_TENANT_HOST=contoso.orgo.space
```

The hostname scheme is `{tenant}.mcp.orgo.space`, not `mcp.{tenant}.orgo.space`: a single `*.mcp.orgo.space` DNS record and one wildcard certificate cover every tenant. The default multi-tenant routing pattern in `src/lib/tenant.ts` derives `acme.orgo.space` from `acme.mcp.orgo.space` automatically.

This keeps the OAuth bearer tokens tenant-scoped automatically and avoids cross-tenant routing logic in the MCP layer.

### Deploy notes

- **Docker**: standard Node 20 image, `npm ci && npm run build`, `CMD ["node","dist/http.js"]`. Mount or bake in `src/data/` (already part of `npm run build`).
- **Bref/Lambda**: `dist/http.js` is a standard Express app — wrap with `@vendia/serverless-express` or `bref/extra-php-extensions` style Node runtime.
- **TLS termination**: trust the load balancer / Caddy / API Gateway in front. Don't expose the server directly without HTTPS — bearer tokens fly over the wire.

---

## Tools exposed

14 tools across discovery, invocation, the website builder, and auth helpers.

### Discovery (use these first)

| Tool | Purpose |
|---|---|
| `list_resources` | List all 122 resource families (User, Event, Contact, Website, …) with descriptions. |
| `describe_resource` | Tag description + every endpoint for one resource family. |
| `list_endpoints` | Search the 787-operation catalog by tag / method / free-text. |
| `describe_endpoint` | Full OpenAPI spec for one operation: parameters, body, responses, code samples. |
| `describe_schema` | JSON schema for a model (e.g. `User-user_read`). |
| `list_webhooks` | All 18 webhook events. |
| `describe_webhook` | Payload schema + example for one event. |

### Invocation

| Tool | Purpose |
|---|---|
| `call_endpoint` | Workhorse — invokes any of the 488 paths × methods. Validates against the catalog so hallucinated paths fail loud. |

### Website builder

| Tool | Purpose |
|---|---|
| `website_guide` | The workflow for building or migrating a tenant's public site, and — with `includeSchema: true` — the whole section vocabulary. Fetched live from the tenant, so it is exactly what that tenant's sanitizer accepts. Read it before composing anything. |

Everything else about the website is ordinary `call_endpoint` work against the 49 website endpoints
(`list_endpoints({ tag: "Website" })` for the builder's own operations; the page, article and
menu CRUD sit under `WebsitePage`, `WebsiteArticle` and `WebsiteMenuItem`). Two things worth knowing before you point an agent at it:

- **Nothing reaches a visitor by itself.** An import sets page statuses — pages land published
  unless the spec says otherwise — but never the site's live switch; `POST /api/v1/website-publish`
  is a separate call, and the guide tells the agent to ask a person first. Every write is preceded by
  an automatic snapshot, and `/website-restore/{uuid}` puts the site back.
- **Pictures and documents come in by url.** `POST /api/v1/website-media/import` for images,
  `POST /api/v1/website-documents/import` for PDFs, Office files and CSVs a migrated site offered
  for download; blocks store the returned names, never urls. A document can also be uploaded
  (`/website-documents/upload-url`, then `/website-documents/upload`) or linked from a public Drive
  share. A hosted document is public until `DELETE /api/v1/website-documents/{file}` (refused
  with 409 while a page still links it, unless `force=true`).
- **A scoped Api-Token cannot reach any of it.** The builder is out of scope for scoped tokens by
  design. Use OAuth, a JWT, or a full-access Api-Token, in each case for a tenant admin.

### Auth helpers (interactive flows)

| Tool | Purpose |
|---|---|
| `whoami` | `GET /api/v1/me` — probe + identity check. |
| `login` | Email + password → JWT pair. |
| `request_otp` | Send a 6-digit code to an email. |
| `verify_otp` | Verify the code → JWT pair. |
| `refresh_token` | Refresh an expiring JWT. |

---

## Resources exposed

23 resources, all under the `orgo://` URI scheme.

```
orgo://docs/overview                            ← API overview (info.md)
orgo://docs/tags                                ← Catalog of all 122 resource families
orgo://docs/webhooks                            ← Webhook event catalog
orgo://docs/concepts/authentication             ← 5 auth methods explained
orgo://docs/concepts/tenancy                    ← Host-header tenant resolution
orgo://docs/concepts/errors                     ← Error envelope + retry guidance
orgo://docs/concepts/pagination-and-filters     ← Hydra envelope, filter syntax
orgo://docs/concepts/rate-limits                ← Per-endpoint limits, 429 handling
orgo://docs/concepts/content-types              ← JSON-LD vs JSON vs multipart
orgo://docs/concepts/webhooks                   ← Subscribing, verifying, idempotency
orgo://docs/recipes/onboard-a-new-member
orgo://docs/recipes/create-and-sell-event-tickets
orgo://docs/recipes/build-a-public-event-landing-page
orgo://docs/recipes/send-a-newsletter-campaign
orgo://docs/recipes/sync-your-crm-with-orgo
orgo://docs/recipes/issue-and-track-contracts
orgo://docs/recipes/process-payments
orgo://docs/recipes/integrate-oauth-login
orgo://docs/recipes/handle-webhooks
orgo://docs/recipes/manage-local-centers-and-permissions
orgo://docs/recipes/run-a-board-election
orgo://website/guide                            ← Live: the website migration + authoring workflow
orgo://website/schema                           ← Live: the section vocabulary this tenant accepts
```

The two `orgo://website/*` resources are fetched from the tenant on read rather than bundled — both
are generated from the running code, and a bundled copy would go stale silently.

---

## Prompts exposed

6 reusable prompts surfaced in the slash-command menu:

- `onboard-member` — full adhesion (membership application) flow
- `sell-event-tickets` — create ticketed event + Stripe checkout
- `migrate-website` — move a site in from WordPress, Squarespace, Wix, WildApricot, Hivebrite or NationBuilder
- `write-website-page` — compose one page or article on the tenant's public site
- `find-endpoint` — given a goal in plain language, locate the right operation(s)
- `sync-crm` — design a one-way or two-way sync with an external CRM

---

## How the model uses this server

Typical reasoning flow:

1. User: "Find all members who joined the Boston chapter in the last 30 days."
2. Model calls `list_resources` to find that "User" is the entity, plus "LocalCenter".
3. Model calls `list_endpoints({ tag: "User", method: "GET" })` and picks `api_users_get_collection`.
4. Model calls `describe_endpoint` to learn the filter parameters.
5. Model calls `call_endpoint` with:
   ```
   GET /api/v1/users
   ?localCenter=4
   &dateCreated[after]=2026-04-28T00:00:00Z
   &order[lastName]=asc
   ```
6. Returns the Hydra-wrapped collection.

The discovery-then-invoke pattern keeps the model grounded in the real catalog: no hallucinated paths, no guesses at parameter names, no missing required fields — every step is backed by the enriched OpenAPI.

---

## Keeping the catalog current (maintainers)

There are two refresh paths, and the difference matters.

**The API changed.** A feature shipped in orgo-platform and the bundled catalog does not know about
it — which means `call_endpoint` *refuses* it, because it validates every call against this catalog.
Merge straight from an export, without waiting on the docs pipeline:

```bash
# from a checkout of orgo-platform, with the containers up
docker exec orgo-php bin/console api:openapi:export --spec-version=3 > /tmp/orgo-openapi.json

cd path/to/orgo-mcp
npm run sync:spec -- --from /tmp/orgo-openapi.json --only '^/api/v1/website' --dry   # see what would land
npm run sync:spec -- --from /tmp/orgo-openapi.json --only '^/api/v1/website'
npm run build:code
```

It is additive: an operation already bundled is left alone (the bundled copy carries the curated
description and code samples), tags are added but never overwritten, and only schemas the new
operations actually reference are copied. Drop `--only` to merge everything, `--overwrite` to let the
export win. `--from` also takes a URL.

**The docs changed.** Tag descriptions, concepts, recipes and code samples live in the api-docs repo.
Rebuild the whole bundle from it and cut a release:

```bash
# 1. Regenerate the enriched spec in the api-docs repo
cd path/to/api-docs
docker exec orgo-php bin/console api:openapi:export --output=json --spec-version=3.1 \
  > api-reference/openapi.json
python3 scripts/postprocess-openapi.py api-reference/openapi.json
git push   # Mintlify deploys

# 2. Rebuild this package against the fresh spec
cd path/to/orgo-mcp
ORGO_DOCS_REPO=path/to/api-docs npm run build
npm version patch && npm publish
```

`npm run build` wipes and rebuilds `src/data/` from that repo, so a checkout that is behind
orgo-platform will *remove* endpoints the bundle already has. When you are only changing code, use
`npm run build:code` — same build without the data step.

---

## Project layout

```
orgo-mcp/
├── package.json
├── tsconfig.json
├── README.md
├── LICENSE
├── .env.example
├── scripts/
│   ├── build-data.ts          # bundles docs + builds the slim endpoint index
│   ├── sync-openapi.ts        # additively merges a live API export into the bundle
│   └── smoke-stdio.mjs        # end-to-end stdio smoke test
└── src/
    ├── index.ts               # stdio entry
    ├── http.ts                # HTTP entry (Streamable HTTP + OAuth)
    ├── server.ts              # transport-agnostic McpServer factory
    ├── config.ts              # env loading + auth resolution
    ├── auth/
    │   └── oauth.ts           # OAuth metadata + userinfo-based validator
    ├── lib/
    │   ├── openapi.ts         # spec loader + indexer
    │   └── client.ts          # HTTP client with Hydra/auth/retry
    ├── tools/
    │   ├── shared.ts
    │   ├── discovery.ts       # list_endpoints, describe_endpoint, list_resources, …
    │   ├── invoke.ts          # call_endpoint
    │   ├── website.ts         # website_guide
    │   └── auth.ts            # whoami, login, request_otp, verify_otp, refresh_token
    ├── resources/
    │   └── docs.ts            # concepts + recipes + catalogs
    ├── prompts/
    │   └── index.ts           # onboard-member, sell-tickets, find-endpoint, sync-crm
    └── data/                  # built artifact: openapi.json + indices + docs
```

---

## License

MIT.
