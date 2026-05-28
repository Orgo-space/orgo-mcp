/**
 * Session store abstraction.
 *
 * Why this exists:
 *   The hosted HTTP server keeps per-session state (the SDK transport, the
 *   authenticated `ownerSub`, the tenant the session was created against,
 *   and the per-session OrgoClient). v1 stores this in memory on a single
 *   instance — that's all "tens of concurrent requests" requires.
 *
 *   When traffic grows past one instance, this needs to move to Redis so any
 *   instance behind the load balancer can pick up any session. By isolating
 *   the contract behind `SessionStore`, that migration is a one-file change
 *   (add `RedisSessionStore`, swap the wiring in `src/http.ts`) — not a panic.
 *
 * What's intentionally NOT in the interface:
 *   - The SDK `StreamableHTTPServerTransport` itself. Transports cannot move
 *     across instances anyway (they hold open SSE connections), so when we go
 *     multi-instance we'll need sticky sessions on the LB regardless. The
 *     SessionStore only persists the *associated* state.
 */

import type { OrgoClient } from './client.js';
import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

export interface SessionState {
  /** OAuth `sub` of the user that initialized this session. Pinned at create time. */
  ownerSub: string;
  /** Tenant host this session was created against, e.g. `acme.orgo.space`. Pinned at create time. */
  tenantHost: string;
  /** The session-scoped Orgo client. Auth credential gets rotated on every request. */
  client: OrgoClient;
  /** Transport instance. Cannot move across server instances. */
  transport: StreamableHTTPServerTransport;
  /** Wall-clock ms when the session was created. Useful for metrics + idle eviction. */
  createdAt: number;
}

export interface SessionStore {
  get(id: string): SessionState | undefined;
  set(id: string, state: SessionState): void;
  delete(id: string): void;
  size(): number;
  /** Iterate active sessions. Used by /metrics; keep cheap. */
  values(): IterableIterator<SessionState>;
}

export class InMemorySessionStore implements SessionStore {
  private readonly store = new Map<string, SessionState>();

  get(id: string): SessionState | undefined {
    return this.store.get(id);
  }
  set(id: string, state: SessionState): void {
    this.store.set(id, state);
  }
  delete(id: string): void {
    this.store.delete(id);
  }
  size(): number {
    return this.store.size;
  }
  values(): IterableIterator<SessionState> {
    return this.store.values();
  }
}
