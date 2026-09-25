# Orgo MCP — Deployment runbook

Step-by-step deploy of the hosted HTTP server from a clean state. Pairs with the Terraform module at `orgo-space/orgo-infrastructure → modules/mcp-server/` and `live/prod/mcp-server/`.

**Target architecture (v1):**

```
internet
   │  https://{tenant}.mcp.orgo.space
   ▼
┌──────────────────────────────────┐
│  EC2 t3.small (eu-central-1)     │
│  ┌──────────────────────────┐    │
│  │ Caddy (80/443)            │    │
│  │  ├─ ACME wildcard (DNS-01) │    │
│  │  └─ reverse_proxy ─┐      │    │
│  └────────────────────┼──────┘    │
│  ┌────────────────────▼──────┐    │
│  │ orgo-mcp container (3333) │    │
│  │  (multi-tenant HTTP MCP)  │    │
│  └─────────────┬─────────────┘    │
└────────────────┼──────────────────┘
                 │ HTTPS
                 ▼
        https://{tenant}.orgo.space/api/v1/*
        https://app.orgo.space/oauth/*
```

**Scale envelope:** designed for tens of concurrent users / hundreds of active sessions on a single t3.small. See [Scaling beyond v1](#scaling-beyond-v1) when traffic grows.

---

## Prerequisites

| Item | How to get it |
|---|---|
| AWS access to account `541548133783` in `eu-central-1` | Existing Orgo IAM |
| Terragrunt + Terraform installed locally | `brew install terragrunt terraform` |
| `orgo-infrastructure` repo cloned at `/Users/alex/orgo-infrastructure` | Existing |
| `gh` CLI logged into the `orgo-space` org | Existing |
| The Orgo OAuth server up at `https://app.orgo.space/oauth/{authorize,token,userinfo}` | Existing |
| Cloudflare account with edit access on the `orgo.space` zone | Existing — DNS is in Cloudflare, not Route53 |
| SNS topic `orgo-alarms` in `eu-central-1` | Existing |
| GHCR image `ghcr.io/orgo-space/orgo-mcp:<tag>` published | One run of the `release.yml` workflow on a `v*.*.*` tag |

---

## One-time setup

### 1. Publish the container image to GHCR

The release workflow at `.github/workflows/release.yml` builds + pushes on every `v*.*.*` tag push.

```bash
cd /Users/alex/orgo-mcp
git tag v0.1.0   # or bump if v0.1.0 already exists
git push origin v0.1.0
# Watch: https://github.com/orgo-space/orgo-mcp/actions
```

After ~3 minutes you should see `ghcr.io/orgo-space/orgo-mcp:0.1.0` in the org's Packages tab. **Make it public** (Package settings → Change visibility → Public) so the EC2 box can pull it without auth — or supply ECR credentials in the user-data instead.

### 2. OAuth clients register themselves

Orgo exposes RFC 7591 dynamic client registration at `POST /api/v1/oauth/register` (rate-limited per IP), and the MCP server advertises it in its authorization-server metadata. Claude.ai and other MCP clients register on first connect; nothing to create by hand.

### 2b. TLS credentials for the wildcard certificate

Tenant subdomains are served under one `*.mcp.orgo.space` certificate. Let's Encrypt issues wildcards only via DNS-01, so Caddy needs a Cloudflare API token with Zone:Read + DNS:Edit on `orgo.space`. The box reads it from SSM parameter `/ORGO_PROD/CLOUDFLARE_API_TOKEN` (the instance profile already allows it) into `/opt/orgo-mcp/caddy.env` (mode 600) at first boot. To rotate the token: update the SSM parameter, then re-run the fetch line from `user-data.sh.tpl` and `docker compose up -d --force-recreate caddy`.

The caddy image must include the `caddy-dns/cloudflare` plugin; the stack pins `ghcr.io/caddybuilds/caddy-cloudflare`.

### 3. Apply the Terraform module

```bash
cd /Users/alex/orgo-infrastructure/live/prod/mcp-server
terragrunt init
terragrunt plan      # review carefully on first apply
terragrunt apply
```

On success you'll see outputs for `instance_id`, `public_ip`, `log_group_name`. Grab the IP for the next step.

### 4. Add the DNS records in Cloudflare

In the Cloudflare dashboard for `orgo.space`, add two A records pointing at the EIP from the previous step:

| Type | Name | Content | Proxy | TTL |
|---|---|---|---|---|
| A | `mcp` | `<public_ip>` | DNS only (grey cloud) | Auto |
| A | `*.mcp` | `<public_ip>` | DNS only (grey cloud) | Auto |

**Important: keep the proxy OFF (grey cloud, not orange).** Caddy on the box needs to receive the incoming Host header unchanged to derive the tenant correctly. Cloudflare's proxy would rewrite it.

Propagation is usually <30s. Verify with `dig mcp.orgo.space` — you should see the EIP.

### 5. Bootstrap verification

Wait ~90 seconds for cloud-init to finish, then check the box came up clean:

```bash
INSTANCE_ID=$(cd /Users/alex/orgo-infrastructure/live/prod/mcp-server && terragrunt output -raw instance_id)
aws ssm start-session --target "$INSTANCE_ID" --region eu-central-1

# Inside the session:
sudo tail -100 /var/log/user-data.log    # expect "[user-data] done"
sudo systemctl status orgo-mcp.service   # expect active (exited)
sudo docker ps                            # expect mcp + caddy containers
sudo docker logs orgo-mcp-mcp-1 --tail 20 # expect "orgo_mcp_http_started" JSON line
```

---

## Pre-launch verification (from outside the VPC)

These are the same 6 checks documented in the saved memory plan. All must pass.

Replace `<your-test-tenant>` with the tenant subdomain you want to validate (e.g. `app` for `app.mcp.orgo.space`). Any tenant works: there is no per-tenant TLS or Caddy step.

```bash
TENANT=<your-test-tenant>

# 1. OAuth protected resource metadata renders, references the right authorization server
curl -fsS "https://$TENANT.mcp.orgo.space/.well-known/oauth-protected-resource" | jq

# 2. OAuth authorization server metadata renders, points at app.orgo.space/oauth
curl -fsS "https://$TENANT.mcp.orgo.space/.well-known/oauth-authorization-server" | jq

# 3. Unauthed POST /mcp returns 401 with the resource_metadata WWW-Authenticate hint
curl -i -X POST "https://$TENANT.mcp.orgo.space/mcp" \
  -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' | grep -E 'HTTP/|WWW-Authenticate'
# expect: HTTP/2 401 ... WWW-Authenticate: Bearer ... resource_metadata="..."

# 4. SSRF guard: a Host that's not on the allowlist returns 400
curl -i "https://evil.mcp.orgo.space/.well-known/oauth-protected-resource" -H "host: evil.mcp.example.com"
# expect: 400 forbidden_tenant
# (the TLS handshake uses a real tenant host; the forged Host header is what the app rejects)

# 5. Authed initialize → tools/list returns 13 tools
TOKEN=<real OAuth bearer for tenant $TENANT, obtained out-of-band>
SESSION=$(curl -fsSi -X POST "https://$TENANT.mcp.orgo.space/mcp" \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"runbook","version":"0"}}}' \
  | grep -i '^mcp-session-id' | cut -d' ' -f2 | tr -d '\r')
echo "session: $SESSION"
curl -fsS -X POST "https://$TENANT.mcp.orgo.space/mcp" \
  -H "authorization: Bearer $TOKEN" \
  -H "mcp-session-id: $SESSION" \
  -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | jq '.result.tools | length'
# expect: 13

# 6. Hijack test: same session id, different user's bearer → 403 session_owner_mismatch
TOKEN_B=<bearer of a DIFFERENT user in the same tenant>
curl -i -X POST "https://$TENANT.mcp.orgo.space/mcp" \
  -H "authorization: Bearer $TOKEN_B" \
  -H "mcp-session-id: $SESSION" \
  -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":3,"method":"tools/list"}' | grep -E 'HTTP/|session_owner'
# expect: HTTP/2 403, "session_owner_mismatch"
```

Optional load test (skip for staging-only):

```bash
# 7. Sanity load — 20 concurrent connections for 30s, p95 < 500ms
wrk -t4 -c20 -d30s -H "authorization: Bearer $TOKEN" \
  -s tools_list.lua https://$TENANT.mcp.orgo.space/mcp
```

---

## Updating to a new MCP version

The release workflow auto-publishes a new GHCR image on every tag push. Rolling it out to the running box:

```bash
NEW_VERSION="0.2.0"
INSTANCE_ID=$(cd /Users/alex/orgo-infrastructure/live/prod/mcp-server && terragrunt output -raw instance_id)

# Option A — via SSM (no SSH)
aws ssm send-command --region eu-central-1 \
  --instance-ids "$INSTANCE_ID" \
  --document-name AWS-RunShellScript \
  --parameters commands="['/opt/orgo-mcp/update.sh ghcr.io/orgo-space/orgo-mcp:'$NEW_VERSION']" \
  --output text --query Command.CommandId

# Option B — via SSM session (interactive)
aws ssm start-session --target "$INSTANCE_ID" --region eu-central-1
# inside: sudo /opt/orgo-mcp/update.sh ghcr.io/orgo-space/orgo-mcp:$NEW_VERSION
```

The script pins the new image, runs `docker compose pull && docker compose up -d`, and Caddy's connection drains transparently. Active SSE streams will reconnect; in-flight tool calls complete on the old container before it exits (compose default `stop_grace_period: 10s`).

To pin the new image in IaC (so a future apply doesn't roll back):

```bash
cd /Users/alex/orgo-infrastructure/live/prod/mcp-server
# Edit terragrunt.hcl: image_ref = "ghcr.io/orgo-space/orgo-mcp:0.2.0"
git commit -am "mcp-server: bump image to 0.2.0"
terragrunt apply   # no-op on the EC2 (user_data_replace_on_change = false), but config now matches reality
```

---

## Observability

### Logs

CloudWatch log group `/aws/ec2/orgo-prod-mcp-server` (30-day retention).

| Stream | Source |
|---|---|
| `mcp-<instance-id>` | The orgo-mcp Node app's JSON stderr |
| `caddy-<instance-id>` | Caddy's JSON access log |

Useful queries (CloudWatch Insights):

```sql
-- Active sessions over time
fields @timestamp, @message
| filter msg like /session_initialized/
| stats count() by bin(5m)

-- OAuth validation failures
fields @timestamp, @message
| filter msg = "oauth_validate_unexpected_error" or msg = "session_owner_mismatch"
| sort @timestamp desc | limit 50
```

### Metrics

`/metrics` exposes Prometheus-format counters. Scrape from CloudWatch agent or a Grafana Cloud agent on the box (not wired in v1).

| Metric | Use |
|---|---|
| `orgo_mcp_requests_total{path,method,status}` | Traffic + error rate |
| `orgo_mcp_request_duration_seconds` | Latency percentiles |
| `orgo_mcp_oauth_validations_total{result}` | Auth-layer health |
| `orgo_mcp_session_owner_mismatches_total` | **Security signal** — spike = active hijack attempt, investigate immediately |
| `orgo_mcp_active_sessions` | Capacity headroom |

### Alarms (already provisioned)

| Alarm | Threshold | Action |
|---|---|---|
| EC2 status check failed | 1 failure / 2 min | Page via `orgo-alarms` SNS |
| EC2 CPU > 80% | 10 min sustained | Page — sign you need to scale up |

---

## Scaling beyond v1

When `orgo_mcp_active_sessions` consistently exceeds ~300, or CPU stays above 70%, vertical-scale first:

1. **t3.small → t3.medium → t3.large**: change `instance_type` in `modules/mcp-server/main.tf`, `terragrunt apply`. AWS replaces the instance in place (~3 min downtime). One small instance handles ~200 concurrent sessions, large handles ~1000.

When vertical isn't enough, horizontal:

1. Provision an ElastiCache Redis cluster (the existing module is fine — orgo-prod-redis already exists).
2. Implement `RedisSessionStore` in `src/lib/sessions.ts` (the interface is already defined for this).
3. Switch from EC2 to ECS Fargate with `desired_count = 2+`, behind an ALB with sticky-session cookies (SSE streams can't migrate, so stickiness is still required even with shared session storage).
4. Replace the CloudWatch alarms with ALB target-group metrics.

This migration is a 1-2 day project, not a panic — the code abstractions are already in place.

---

## Rollback

If a deploy breaks the server:

```bash
# Roll back the image to the previous known-good
aws ssm send-command --region eu-central-1 \
  --instance-ids "$INSTANCE_ID" \
  --document-name AWS-RunShellScript \
  --parameters commands="['/opt/orgo-mcp/update.sh ghcr.io/orgo-space/orgo-mcp:0.1.0']"
```

If the whole box is hosed, `terragrunt taint aws_instance.mcp && terragrunt apply` rebuilds from user-data. The EIP, log group, and DNS records survive — only the EC2 instance is replaced.

If the EIP needs to change (rare — e.g., region migration), Route53 records update automatically on the next `terragrunt apply`.
