The Orgo API is a REST/JSON-LD API for managing the full lifecycle of a member-driven organization: people (members, contacts, families, companies), events and tickets, payments and invoices, contracts and e-signatures, communications (newsletters, discussions, notifications), governance (voting, org charts), and learning (courses, badges).

It is built on Symfony 7 and API Platform 3.4. Every resource follows the same conventions — pagination, filtering, ordering, content negotiation, validation, tenant isolation — so once you know one endpoint, you know the shape of all of them.

## Base URL

```
https://app.orgo.space
```

All endpoints are prefixed with `/api/v1/`. For example: `GET https://app.orgo.space/api/v1/users`.

## Authentication

The API accepts five authentication methods. Pick by use case:

| Method | When to use | How |
|---|---|---|
| `Api-Token` header | Server-to-server integrations, scripts, CRON jobs | `Api-Token: <your_token>` (no `Bearer` prefix) |
| `Authorization: Bearer <jwt>` | Sessions started via `POST /api/v1/login` (email + password) | Standard Bearer JWT |
| OAuth 2.0 (Authorization Code) | "Log in with Orgo" in third-party apps | See [OAuth Server](https://orgo.space/docs/platform/oauth) |
| OTP (one-time password) | Magic-link login for event attendees and members without a password | `POST /api/v1/request-login-otp` → `POST /api/v1/verify-login-otp` |
| `X-Contact-Hash` header | Anonymous contacts opening an event link they were emailed | `X-Contact-Hash: <hash>` |

Tokens issued by `/api/v1/login` and `/api/v1/verify-login-otp` are JWTs valid for approximately 11 days. Generate API tokens in the admin UI at **Settings → Developers → API Access**. Read-only tokens reject any non-GET request with `403 Forbidden`.

## Tenant context

Orgo is multi-tenant. Each organization (a "tenant") has its own subdomain or custom domain. The tenant for a request is resolved from the HTTP `Host` header — calling `app.orgo.space` directly **will not work** for tenant-scoped endpoints. You must call your tenant's host:

```
https://<your-org>.orgo.space/api/v1/users
https://members.your-domain.org/api/v1/users
```

Every read and write is automatically scoped to the tenant the request was made against. Cross-tenant reads are blocked at the persistence layer by Doctrine extensions, so even a misconfigured query cannot leak data across organizations.

## Content negotiation

Most endpoints support three response formats. Select with the `Accept` header:

| Accept | Format | When to use |
|---|---|---|
| `application/ld+json` (default) | JSON-LD with Hydra | Browsing, link discovery, generic clients |
| `application/json` | Plain JSON | Most integrations — simpler shape, no `@context`/`@id` |
| `multipart/form-data` | Multipart | Only on endpoints that accept file uploads |

For request bodies, use `Content-Type: application/json` for create/replace and `Content-Type: application/merge-patch+json` for PATCH (RFC 7396).

## Collection responses (Hydra envelope)

`Accept: application/ld+json` (the default) wraps collections in a Hydra envelope:

```json
{
  "@context": "/api/contexts/User",
  "@id": "/api/v1/users",
  "@type": "hydra:Collection",
  "hydra:member": [ { ... }, { ... } ],
  "hydra:totalItems": 1248,
  "hydra:view": {
    "@id": "/api/v1/users?page=1",
    "@type": "hydra:PartialCollectionView",
    "hydra:first": "/api/v1/users?page=1",
    "hydra:last": "/api/v1/users?page=42",
    "hydra:next": "/api/v1/users?page=2"
  }
}
```

`Accept: application/json` returns a bare array — no envelope, no total count, no pagination links. Use JSON-LD if you need totals or page navigation; use plain JSON if you already know the shape.

## Pagination

All collection endpoints are paginated. Defaults: **30 items per page**, maximum **100 per page**.

| Query parameter | Purpose | Default |
|---|---|---|
| `page` | 1-indexed page number | `1` |
| `itemsPerPage` | Page size (max 100) | `30` |
| `pagination` | Set to `false` to disable pagination (where allowed) | `true` |

Iterate pages by following `hydra:view.hydra:next` until it is absent, or by incrementing `page` until you receive fewer than `itemsPerPage` items.

## Filtering and ordering

Filters and ordering are passed as query parameters. The available filters differ per resource and are listed under each endpoint's parameters. Common patterns:

```
# Filter by exact value
GET /api/v1/users?status=ACTIVE

# Filter by relation
GET /api/v1/users?localCenter=/api/v1/local_centers/4

# Keyword search (where supported)
GET /api/v1/users?keyword=patterson

# Ordering — ascending
GET /api/v1/users?order[lastName]=asc

# Ordering — multiple fields
GET /api/v1/events?order[startDate]=desc&order[name]=asc
```

## Errors

Errors are returned as JSON with `Content-Type: application/json` and a status code that reflects the error class. The shape is:

```json
{
  "title": "Bad Request",
  "detail": "Email must be a valid email address.",
  "status": 400
}
```

Validation errors (`422`) include a `violations` array enumerating each failed field:

```json
{
  "@type": "ConstraintViolationList",
  "title": "An error occurred",
  "detail": "email: This value is not a valid email address.\nphoneNumber: This value is too short.",
  "violations": [
    { "propertyPath": "email", "message": "This value is not a valid email address." },
    { "propertyPath": "phoneNumber", "message": "This value is too short." }
  ]
}
```

| Status | Meaning | When to retry |
|---|---|---|
| `400 Bad Request` | Malformed request — JSON syntax, wrong content type, missing parameter | No — fix the request |
| `401 Unauthorized` | Missing or invalid auth | After re-authenticating |
| `403 Forbidden` | Authenticated, but lacks permission for this resource | No |
| `404 Not Found` | Resource does not exist or is in another tenant | No |
| `409 Conflict` | Optimistic-lock collision, duplicate identifier, illegal state transition | Yes — refetch and retry |
| `422 Unprocessable Entity` | Validation failed | No — fix the fields listed in `violations[]` |
| `429 Too Many Requests` | Rate limit hit on this endpoint | After the `Retry-After` window |
| `5xx` | Server error | Yes, with exponential backoff |

See [Errors](https://orgo.space/docs/api-reference/concepts/errors) for the full error catalog and worked examples.

## Rate limits

Rate limits are applied per-endpoint, per-token. Most write-heavy endpoints (login, OTP requests, impersonation, sending emails) are limited to **20 requests per 60 seconds**. Read endpoints are not rate-limited at the application layer but are subject to platform-level protections.

A `429 Too Many Requests` response carries the standard `Retry-After` header.

## Webhooks

Orgo can deliver event notifications to a URL of your choosing — see [Webhooks](https://orgo.space/docs/api-reference/concepts/webhooks). Eighteen event types are available across users, payments, event attendance, contracts, roles, and contacts.

## Versioning and stability

The API is versioned in the URL path (`/api/v1/`). Additive changes (new fields, new endpoints, new optional parameters) ship in `v1`. Breaking changes (removed fields, renamed properties, status-code changes) will ship in a future `/api/v2/` with at least six months of overlap.

## Pointers

- [Authentication](https://orgo.space/docs/api-reference/concepts/authentication) — every auth method, with worked examples
- [Tenancy](https://orgo.space/docs/api-reference/concepts/tenancy) — how tenant resolution works and how to scope requests
- [Content types](https://orgo.space/docs/api-reference/concepts/content-types) — JSON-LD vs JSON vs multipart, when to pick which
- [Pagination and filters](https://orgo.space/docs/api-reference/concepts/pagination-and-filters) — exhaustive filter reference
- [Errors](https://orgo.space/docs/api-reference/concepts/errors) — every error shape and when to expect it
- [Rate limits](https://orgo.space/docs/api-reference/concepts/rate-limits) — the per-endpoint table
- [Webhooks](https://orgo.space/docs/api-reference/concepts/webhooks) — events, payloads, signature verification
- [Recipes](https://orgo.space/docs/api-reference/recipes) — end-to-end walkthroughs ("Onboard a new member", "Sell event tickets", ...)
