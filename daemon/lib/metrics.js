// Prometheus text exposition for the daemon (GET /metrics). Rendered by hand —
// the zero-runtime-dependency constraint rules out client libraries.
//
// Gauges are derived from queues.snapshot() at scrape time, so they can never
// drift from the dashboard. Counters and histograms accumulate in memory from
// the Queues event stream (observe()); they reset on daemon restart, which is
// normal Prometheus semantics (query with increase()/rate()).

const WAIT_BUCKETS = [0.5, 1, 2.5, 5, 10, 30, 60, 120, 300];
const RUN_BUCKETS = [1, 5, 10, 30, 60, 120, 300, 600, 1800];

function esc(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function labelString(pairs) {
  if (pairs.length === 0) return '';
  return `{${pairs.map(([k, v]) => `${k}="${esc(v)}"`).join(',')}}`;
}

class Histogram {
  constructor(buckets) {
    this.buckets = buckets;
    this.counts = new Array(buckets.length + 1).fill(0); // last slot = +Inf
    this.sum = 0;
    this.count = 0;
  }

  observe(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return;
    this.sum += seconds;
    this.count += 1;
    for (let i = 0; i < this.buckets.length; i += 1) {
      if (seconds <= this.buckets[i]) this.counts[i] += 1;
    }
    this.counts[this.buckets.length] += 1;
  }
}

/**
 * @param {object} opts
 * @param {import('./queues.js').Queues} opts.queues
 * @param {string} opts.version
 * @param {number} opts.startedAt epoch ms
 */
export function createMetrics({ queues, version, startedAt }) {
  const grants = new Map(); // "queue\u0000identity" -> n
  const releases = new Map(); // "queue\u0000reason" -> n
  const cancellations = new Map(); // "queue\u0000reason" -> n
  const rejections = new Map(); // "queue\u0000reason" -> n
  const waits = new Map(); // queue -> Histogram
  const runs = new Map(); // queue -> Histogram
  let identityUps = 0;

  const bump = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);
  const histogram = (map, buckets, queue) => {
    let h = map.get(queue);
    if (h === undefined) {
      h = new Histogram(buckets);
      map.set(queue, h);
    }
    return h;
  };

  function observe(type, payload) {
    const queue = payload.queue ?? 'unmapped';
    if (type === 'granted') {
      bump(grants, `${queue}\u0000${payload.instance ?? 'unknown'}`);
      histogram(waits, WAIT_BUCKETS, queue).observe((payload.waitedMs ?? 0) / 1000);
    } else if (type === 'released') {
      bump(releases, `${queue}\u0000${payload.reason ?? 'released'}`);
      if (payload.runMs !== undefined) histogram(runs, RUN_BUCKETS, queue).observe(payload.runMs / 1000);
    } else if (type === 'cancelled') {
      bump(cancellations, `${queue}\u0000${payload.reason ?? 'cancelled'}`);
    } else if (type === 'rejected') {
      bump(rejections, `${queue}\u0000${payload.reason ?? 'rejected'}`);
    } else if (type === 'identity_up') {
      identityUps += 1;
    }
  }

  function counterFamily(name, help, map, labelNames) {
    const lines = [`# HELP ${name} ${help}`, `# TYPE ${name} counter`];
    const series = [...map.entries()]
      .map(([key, value]) => {
        const [a, b] = key.split('\u0000');
        return { labels: [[labelNames[0], a], [labelNames[1], b]], value };
      })
      .sort((x, y) => JSON.stringify(x.labels) < JSON.stringify(y.labels) ? -1 : 1);
    for (const { labels, value } of series) lines.push(`${name}${labelString(labels)} ${value}`);
    return lines;
  }

  function histogramFamily(name, map) {
    const help = name.includes('wait') ? 'Time queued before a grant, in seconds.' : 'Time a held lease ran, in seconds.';
    const lines = [`# HELP ${name} ${help}`, `# TYPE ${name} histogram`];
    for (const [queue, h] of [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const inf = h.counts.length - 1;
      for (let i = 0; i < h.buckets.length; i += 1) {
        lines.push(`${name}_bucket${labelString([['queue', queue], ['le', h.buckets[i]]])} ${h.counts[i]}`);
      }
      lines.push(`${name}_bucket${labelString([['queue', queue], ['le', '+Inf']])} ${h.counts[inf]}`);
      lines.push(`${name}_sum${labelString([['queue', queue]])} ${h.sum}`);
      lines.push(`${name}_count${labelString([['queue', queue]])} ${h.count}`);
    }
    return lines;
  }

  function render() {
    const now = Date.now();
    const snap = queues.snapshot(); // the queue's own clock, not wall time
    const lines = [];

    lines.push('# HELP tan_up The take-a-number daemon is up.');
    lines.push('# TYPE tan_up gauge');
    lines.push(`tan_up{version="${esc(version)}"} 1`);
    lines.push('# HELP tan_uptime_seconds Daemon uptime in seconds.');
    lines.push('# TYPE tan_uptime_seconds gauge');
    lines.push(`tan_uptime_seconds ${(Math.max(0, now - startedAt) / 1000).toFixed(3)}`);
    lines.push('# HELP tan_identities Connected identities.');
    lines.push('# TYPE tan_identities gauge');
    lines.push(`tan_identities ${snap.identities.length}`);
    lines.push('# HELP tan_identity_ups_total Cumulative identity connections since daemon start.');
    lines.push('# TYPE tan_identity_ups_total counter');
    lines.push(`tan_identity_ups_total ${identityUps}`);

    const queueIds = snap.queues.map((q) => q.id).sort();
    const gauge = (name, help, labelName, entries) => {
      lines.push(`# HELP ${name} ${help}`);
      lines.push(`# TYPE ${name} gauge`);
      for (const [key, value] of [...entries].sort((a, b) => a[0].localeCompare(b[0]))) {
        lines.push(`${name}${labelString([[labelName, key]])} ${value}`);
      }
    };
    gauge('tan_queue_depth', 'Waiters currently queued per queue.', 'queue', queueIds.map((id) => [id, snap.queues.find((q) => q.id === id).waiters.length]));
    gauge('tan_queue_limit', 'Concurrency limit per queue (0 = unlimited).', 'queue', queueIds.map((id) => [id, snap.queues.find((q) => q.id === id).limit ?? 0]));
    gauge('tan_queue_active', 'Active leases per queue.', 'queue', queueIds.map((id) => [id, snap.queues.find((q) => q.id === id).used]));
    gauge('tan_queue_longest_wait_seconds', 'Longest current waiter age per queue, in seconds.', 'queue',
      queueIds.map((id) => {
        const q = snap.queues.find((x) => x.id === id);
        return [id, Math.max(0, ...q.waiters.map((w) => w.waitedMs), 0) / 1000];
      }));
    gauge('tan_queue_longest_lease_age_seconds', 'Oldest active lease per queue, in seconds.', 'queue',
      queueIds.map((id) => {
        const q = snap.queues.find((x) => x.id === id);
        return [id, Math.max(0, ...q.active.map((l) => l.elapsedMs), 0) / 1000];
      }));

    gauge('tan_identity_leases', 'Active leases per identity.', 'identity', snap.identities.map((i) => [i.identity, i.leases]));
    gauge('tan_identity_waiters', 'Queue positions held per identity.', 'identity', snap.identities.map((i) => [i.identity, i.waiters]));

    lines.push(...counterFamily('tan_grants_total', 'Grants issued per queue and identity.', grants, ['queue', 'identity']));
    lines.push(...counterFamily('tan_releases_total', 'Lease releases per queue and reason.', releases, ['queue', 'reason']));
    lines.push(...counterFamily('tan_cancellations_total', 'Waiter cancellations per queue and reason.', cancellations, ['queue', 'reason']));
    lines.push(...counterFamily('tan_rejections_total', 'Acquire rejections per queue and reason.', rejections, ['queue', 'reason']));
    lines.push(...histogramFamily('tan_wait_seconds', waits));
    lines.push(...histogramFamily('tan_run_seconds', runs));

    return `${lines.join('\n')}\n`;
  }

  return { observe, render };
}
