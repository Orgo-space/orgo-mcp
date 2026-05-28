/**
 * Minimal Prometheus-format metrics. No external deps — keeps the container
 * tiny and avoids version drift with prom-client.
 *
 * Exposed counters/gauges:
 *   - orgo_mcp_requests_total{path,method,status}    (counter)
 *   - orgo_mcp_request_duration_seconds{path,method} (summary: count + sum)
 *   - orgo_mcp_oauth_validations_total{result}       (counter; result=ok|invalid|error)
 *   - orgo_mcp_active_sessions                        (gauge)
 *   - orgo_mcp_session_owner_mismatches_total         (counter — security signal)
 *
 * Why a hand-rolled exporter: the production endpoint at /metrics needs to
 * be safe to scrape from a CloudWatch agent or AMP. ~100 lines beats a
 * vendored library.
 */

type Labels = Record<string, string>;

class Counter {
  private data = new Map<string, number>();
  constructor(public readonly name: string, public readonly help: string) {}

  inc(labels: Labels = {}, by = 1): void {
    const key = labelKey(labels);
    this.data.set(key, (this.data.get(key) ?? 0) + by);
  }

  render(): string {
    const out: string[] = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    for (const [key, val] of this.data) {
      out.push(`${this.name}${key} ${val}`);
    }
    return out.join('\n');
  }
}

class Gauge {
  private value = 0;
  constructor(public readonly name: string, public readonly help: string) {}

  set(v: number): void {
    this.value = v;
  }

  render(): string {
    return [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} gauge`, `${this.name} ${this.value}`].join('\n');
  }
}

class Summary {
  private count = new Map<string, number>();
  private sum = new Map<string, number>();
  constructor(public readonly name: string, public readonly help: string) {}

  observe(labels: Labels, seconds: number): void {
    const key = labelKey(labels);
    this.count.set(key, (this.count.get(key) ?? 0) + 1);
    this.sum.set(key, (this.sum.get(key) ?? 0) + seconds);
  }

  render(): string {
    const out: string[] = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} summary`];
    for (const [key, c] of this.count) {
      out.push(`${this.name}_count${key} ${c}`);
      out.push(`${this.name}_sum${key} ${this.sum.get(key) ?? 0}`);
    }
    return out.join('\n');
  }
}

function labelKey(labels: Labels): string {
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return '';
  return '{' + keys.map((k) => `${k}="${escapeLabelValue(labels[k])}"`).join(',') + '}';
}

function escapeLabelValue(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

export class Metrics {
  readonly requestsTotal = new Counter('orgo_mcp_requests_total', 'Total HTTP requests handled, by path/method/status.');
  readonly requestDuration = new Summary(
    'orgo_mcp_request_duration_seconds',
    'HTTP request duration in seconds, by path/method.',
  );
  readonly oauthValidations = new Counter(
    'orgo_mcp_oauth_validations_total',
    'OAuth bearer validation attempts, by result (ok|invalid|error).',
  );
  readonly sessionOwnerMismatches = new Counter(
    'orgo_mcp_session_owner_mismatches_total',
    'Requests rejected because the bearer sub did not match the session owner. Spike = active hijack attempt.',
  );
  readonly activeSessions = new Gauge('orgo_mcp_active_sessions', 'Number of live MCP sessions.');

  render(): string {
    return [
      this.requestsTotal.render(),
      this.requestDuration.render(),
      this.oauthValidations.render(),
      this.sessionOwnerMismatches.render(),
      this.activeSessions.render(),
    ].join('\n\n') + '\n';
  }
}
