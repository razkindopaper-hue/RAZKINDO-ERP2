// =====================================================================
// EVENT QUEUE SERVICE v2 — High-performance concurrent event processor
//
// Optimizations over v1:
//   1. Priority buckets (O(1) enqueue) instead of array sort every tick
//   2. Batch processing — up to 10 events per 50ms tick (200 evt/s)
//   3. Lazy-initialized Supabase connection singleton
//   4. Per-IP connection limit: 50 (for PWA customers behind NAT)
//   5. Event deduplication — same type+payload within 2s window
//   6. Memory-efficient priority buckets instead of single sorted array
//   7. Single-pass statistics for status/health endpoints
//   8. Graceful backpressure at > 80% queue capacity
//   9. Priority groups: high (transactions/stock) → medium (notifications) → low (analytics)
//  10. Health metrics: processing rate, success rate, avg latency
//
// Socket.io + HTTP on same port (port 3004).
// API handler runs before socket.io via prependListener.
//
// Endpoints (backward compatible):
//   HTTP:
//     POST /enqueue               — Add single event to queue
//     POST /api/events            — Add single or batch events
//     GET  /api/queue/status      — Queue health (single-pass stats)
//     GET  /api/queue/dead-letter — Failed events
//     POST /api/queue/retry/:id   — Retry dead-letter event
//     GET  /api/health            — Detailed health metrics
//   Socket.io:
//     'register'     — Register user info
//     'event'        — Submit single event (with ack)
//     'bulk-events'  — Submit batch events (with ack)
// =====================================================================

import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { Server } from 'socket.io';
import { createClient } from '@supabase/supabase-js';
import type { SupabaseClient } from '@supabase/supabase-js';

// =====================================================================
// Types
// =====================================================================

type PriorityLevel = 'high' | 'medium' | 'low';

interface QueuedEvent {
  id: string;
  type: string;
  target: 'user' | 'role' | 'all' | 'unit' | 'super_admins' | 'sales' | 'courier';
  targetId?: string;
  data: unknown;
  priority: PriorityLevel;
  attempts: number;
  maxAttempts: number;
  createdAt: number; // Date.now() — number for faster arithmetic
  nextRetryAt?: number;
  lastError?: string;
}

interface SocketUser {
  socketId: string;
  userId?: string;
  roles?: string[];
  unitId?: string;
  userName?: string;
  joinedAt: number;
}

interface EnqueueResult {
  eventId: string;
  queueSize: number;
  deduplicated?: boolean;
  backpressure?: boolean;
}

// =====================================================================
// Constants
// =====================================================================

const PORT = 3004;
const MAX_QUEUE_SIZE = 5000;
const MAX_RETRIES = 3;
const BACKOFF_BASE_MS = 1000; // 1s, 2s, 4s
const MAX_CONNECTIONS_PER_IP = 50;
const MAX_BODY_SIZE = 2 * 1024 * 1024; // 2MB
const PROCESS_INTERVAL_MS = 50; // 20 ticks/second
const BATCH_SIZE = 10; // events per tick
const DEDUP_WINDOW_MS = 2000;
const METRICS_WINDOW_MS = 60_000; // 60-second rolling window
const MAX_DEAD_LETTER_SIZE = 500;
const BACKPRESSURE_THRESHOLD = 0.8;

// =====================================================================
// State — Priority Buckets
// =====================================================================

/**
 * Three separate FIFO arrays replace the single sorted array from v1.
 * Insertion: O(1) push into the correct bucket.
 * Batch dequeue: O(k) where k = batch size — drain high → medium → low.
 * No sorting needed. Priority is structural, not computed.
 */
const priorityBuckets: Record<PriorityLevel, QueuedEvent[]> = {
  high: [],
  medium: [],
  low: [],
};

const deadLetterQueue: QueuedEvent[] = [];
const connectedUsers = new Map<string, SocketUser>();
const ipConnectionCount = new Map<string, number>();

// =====================================================================
// State — Deduplication Map
// =====================================================================

const dedupMap = new Map<string, { eventId: string; ts: number }>();

// =====================================================================
// State — Health Metrics (rolling windows)
// =====================================================================

const metrics = {
  startTime: Date.now(),
  totalProcessed: 0,
  totalSuccess: 0,
  totalFailed: 0,
  totalEnqueued: 0,
  totalDeduplicated: 0,
  totalDropped: 0,
  backpressureActive: false,
  /** Timestamps (Date.now()) of processed events in the rolling window */
  processedTimestamps: [] as number[],
  /** Latencies (ms) of recently processed events */
  recentLatencies: [] as number[],
};

// =====================================================================
// Supabase Lazy Singleton
// =====================================================================

let _supabase: SupabaseClient | null = null;
let _supabaseAttempted = false;

function getSupabaseClient(): SupabaseClient | null {
  if (_supabase) return _supabase;
  if (_supabaseAttempted) return null;

  _supabaseAttempted = true;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !key) {
    console.log('[EventQueue] Supabase not configured — running in memory-only mode');
    return null;
  }

  try {
    _supabase = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
      db: { schema: 'public' },
    });
    console.log('[EventQueue] Supabase client initialized (lazy singleton)');
    return _supabase;
  } catch (err) {
    console.error('[EventQueue] Supabase init failed:', err);
    return null;
  }
}

// =====================================================================
// Utility Functions
// =====================================================================

let eventIdCounter = 0;
function generateId(): string {
  return `evt_${Date.now()}_${++eventIdCounter}`;
}

/**
 * Auto-detect priority from event type when not explicitly provided.
 * High: transactional/financial events (transactions, stock, finance, payment, sale, purchase).
 * Low: analytics/telemetry (analytics, metric, telemetry, ping, heartbeat).
 * Medium: everything else (notifications, broadcasts, presence).
 */
function getAutoPriority(type: string): PriorityLevel {
  const highKw = ['transaction', 'stock', 'finance', 'payment', 'sale', 'purchase'];
  const lowKw = ['analytics', 'metric', 'telemetry', 'ping', 'heartbeat'];

  for (let i = 0; i < highKw.length; i++) {
    if (type.includes(highKw[i])) return 'high';
  }
  for (let i = 0; i < lowKw.length; i++) {
    if (type.includes(lowKw[i])) return 'low';
  }
  return 'medium';
}

/** Accept 'normal' as 'medium' for backward compatibility. */
function normalizePriority(p?: string): PriorityLevel {
  if (p === 'high') return 'high';
  if (p === 'low') return 'low';
  return 'medium'; // 'normal', 'medium', undefined → medium
}

function totalQueueSize(): number {
  return priorityBuckets.high.length + priorityBuckets.medium.length + priorityBuckets.low.length;
}

// =====================================================================
// Event Deduplication
// =====================================================================

function computeDedupHash(type: string, target: string, targetId: string | undefined, data: unknown): string {
  const dataStr = typeof data === 'string' ? data : JSON.stringify(data);
  // Truncate data to 256 chars — type+target combo is usually sufficient for dedup
  const slice = dataStr.length > 256 ? dataStr.slice(0, 256) : dataStr;
  return `${type}|${target}|${targetId || ''}|${slice}`;
}

function checkDedup(
  type: string,
  target: string,
  targetId: string | undefined,
  data: unknown,
): string | null {
  const hash = computeDedupHash(type, target, targetId, data);
  const entry = dedupMap.get(hash);
  if (entry && Date.now() - entry.ts < DEDUP_WINDOW_MS) {
    return entry.eventId;
  }
  return null;
}

function storeDedup(
  type: string,
  target: string,
  targetId: string | undefined,
  data: unknown,
  eventId: string,
): void {
  const hash = computeDedupHash(type, target, targetId, data);
  dedupMap.set(hash, { eventId, ts: Date.now() });
}

/** Called once per tick — O(n) but map is small (bounded by 2s window). */
function cleanupDedupMap(): void {
  const cutoff = Date.now() - DEDUP_WINDOW_MS;
  for (const [key, entry] of dedupMap) {
    if (entry.ts < cutoff) dedupMap.delete(key);
  }
}

// =====================================================================
// Metrics Cleanup
// =====================================================================

function cleanupMetrics(): void {
  const cutoff = Date.now() - METRICS_WINDOW_MS;
  const ts = metrics.processedTimestamps;
  let idx = 0;
  while (idx < ts.length && ts[idx] < cutoff) idx++;
  if (idx > 0) metrics.processedTimestamps = ts.slice(idx);

  // Cap latencies array to prevent unbounded growth
  if (metrics.recentLatencies.length > 1000) {
    metrics.recentLatencies = metrics.recentLatencies.slice(-1000);
  }
}

// =====================================================================
// Supabase Persistence (fire-and-forget)
// =====================================================================

function persistEventAsync(event: QueuedEvent, result: 'delivered' | 'failed' | 'dead_letter'): void {
  const client = getSupabaseClient();
  if (!client) return;

  // Fire-and-forget — intentionally not awaited
  (async () => {
    try {
      await client.from('event_queue_log').insert({
        event_id: event.id,
        event_type: event.type,
        target: event.target,
        target_id: event.targetId ?? null,
        priority: event.priority,
        attempts: event.attempts,
        result,
        last_error: event.lastError ?? null,
        created_at: new Date(event.createdAt).toISOString(),
      });
    } catch {
      // Silently ignore — in-memory delivery is the primary path
    }
  })();
}

// =====================================================================
// Queue Operations — Enqueue (O(1) insertion into priority bucket)
// =====================================================================

function enqueueEvent(
  type: string,
  target: QueuedEvent['target'],
  targetId: string | undefined,
  data: unknown,
  rawPriority: string | undefined,
): EnqueueResult | string {
  const size = totalQueueSize();

  // --- Backpressure ---
  if (size >= MAX_QUEUE_SIZE * BACKPRESSURE_THRESHOLD) {
    metrics.backpressureActive = true;

    if (size >= MAX_QUEUE_SIZE) {
      // Try to evict oldest low-priority event
      if (priorityBuckets.low.length > 0) {
        const dropped = priorityBuckets.low.shift()!;
        dropped.lastError = 'Queue full — evicted by backpressure';
        deadLetterQueue.push(dropped);
        metrics.totalDropped++;
        trimDeadLetter();
      } else {
        return 'queue_full';
      }
    }
  } else {
    metrics.backpressureActive = false;
  }

  // --- Deduplication ---
  const dupId = checkDedup(type, target, targetId, data);
  if (dupId) {
    metrics.totalDeduplicated++;
    return `deduplicated:${dupId}`;
  }

  // --- Create event ---
  const priority = rawPriority ? normalizePriority(rawPriority) : getAutoPriority(type);
  const eventId = generateId();

  const event: QueuedEvent = {
    id: eventId,
    type,
    target,
    targetId,
    data,
    priority,
    attempts: 0,
    maxAttempts: MAX_RETRIES,
    createdAt: Date.now(),
  };

  // O(1) push into the correct priority bucket
  priorityBuckets[priority].push(event);
  storeDedup(type, target, targetId, data, eventId);
  metrics.totalEnqueued++;

  return { eventId, queueSize: totalQueueSize() };
}

// =====================================================================
// Queue Operations — Batch Dequeue (O(k) per tick)
// =====================================================================

/**
 * Drain up to `maxCount` events across priority groups: high → medium → low.
 * Events with unelapsed backoff are skipped and left in their bucket.
 */
function dequeueBatch(maxCount: number): QueuedEvent[] {
  const batch: QueuedEvent[] = [];
  const now = Date.now();

  for (const level of ['high', 'medium', 'low'] as const) {
    if (batch.length >= maxCount) break;

    const bucket = priorityBuckets[level];
    if (bucket.length === 0) continue;

    const kept: QueuedEvent[] = [];

    for (let i = 0; i < bucket.length; i++) {
      const event = bucket[i];

      if (batch.length >= maxCount) {
        kept.push(event); // put back — batch full
        continue;
      }

      // Skip events still in backoff
      if (event.nextRetryAt && event.nextRetryAt > now) {
        kept.push(event);
        continue;
      }

      batch.push(event);
    }

    priorityBuckets[level] = kept;
  }

  return batch;
}

// =====================================================================
// Event Delivery
// =====================================================================

function deliverEvent(event: QueuedEvent): 'delivered' | 'no_match' {
  let emitted = false;
  const payload = { ...(event.data as Record<string, unknown>), _eventId: event.id };

  switch (event.target) {
    case 'all': {
      if (connectedUsers.size > 0) {
        io.emit(event.type, payload);
        emitted = true;
      }
      break;
    }

    case 'user': {
      if (event.targetId) {
        for (const user of connectedUsers.values()) {
          if (user.userId === event.targetId) {
            io.to(user.socketId).emit(event.type, payload);
            emitted = true;
            break;
          }
        }
      }
      break;
    }

    case 'role': {
      if (event.targetId) {
        const targetRoles = event.targetId.split(',');
        for (const user of connectedUsers.values()) {
          if (user.roles && user.roles.some((r) => targetRoles.includes(r))) {
            io.to(user.socketId).emit(event.type, payload);
            emitted = true;
          }
        }
      }
      break;
    }

    case 'unit': {
      if (event.targetId) {
        for (const user of connectedUsers.values()) {
          if (user.unitId && event.targetId === user.unitId) {
            io.to(user.socketId).emit(event.type, payload);
            emitted = true;
          }
        }
      }
      break;
    }

    case 'super_admins': {
      for (const user of connectedUsers.values()) {
        if (user.roles && user.roles.includes('super_admin')) {
          io.to(user.socketId).emit(event.type, payload);
          emitted = true;
        }
      }
      break;
    }

    case 'sales': {
      for (const user of connectedUsers.values()) {
        if (user.roles && user.roles.includes('sales')) {
          io.to(user.socketId).emit(event.type, payload);
          emitted = true;
        }
      }
      break;
    }

    case 'courier': {
      for (const user of connectedUsers.values()) {
        if (user.roles && user.roles.includes('kurir')) {
          io.to(user.socketId).emit(event.type, payload);
          emitted = true;
        }
      }
      break;
    }
  }

  return emitted ? 'delivered' : 'no_match';
}

// =====================================================================
// Process Single Event
// =====================================================================

function processEvent(event: QueuedEvent): void {
  event.attempts++;
  metrics.totalProcessed++;

  const latency = Date.now() - event.createdAt;

  try {
    const result = deliverEvent(event);

    if (result === 'delivered') {
      metrics.totalSuccess++;
      metrics.processedTimestamps.push(Date.now());
      metrics.recentLatencies.push(latency);
      persistEventAsync(event, 'delivered');

      if (process.env.NODE_ENV !== 'production') {
        console.log(
          `[EventQueue] ✓ ${event.type}:${event.id} → ${event.target}${event.targetId ? ':' + event.targetId : ''} (${event.priority}, ${latency}ms)`,
        );
      }
    } else {
      // No matching socket — retry or dead letter
      if (event.attempts < event.maxAttempts) {
        const backoffMs = BACKOFF_BASE_MS * (1 << (event.attempts - 1));
        event.nextRetryAt = Date.now() + backoffMs;
        event.lastError = `No matching socket: ${event.target}${event.targetId ? ':' + event.targetId : ''} (${connectedUsers.size} clients)`;
        priorityBuckets[event.priority].push(event);
      } else {
        moveToDeadLetter(event, 'Max retries — no matching socket');
      }
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    if (event.attempts < event.maxAttempts) {
      const backoffMs = BACKOFF_BASE_MS * (1 << (event.attempts - 1));
      event.nextRetryAt = Date.now() + backoffMs;
      event.lastError = errMsg;
      priorityBuckets[event.priority].push(event);
    } else {
      moveToDeadLetter(event, `Max retries — ${errMsg}`);
    }
  }
}

function moveToDeadLetter(event: QueuedEvent, reason: string): void {
  event.lastError = reason;
  deadLetterQueue.push(event);
  metrics.totalFailed++;
  trimDeadLetter();
  persistEventAsync(event, 'dead_letter');
  console.error(`[EventQueue] ✗ Dead letter: ${event.id} — ${reason} (DLQ: ${deadLetterQueue.length})`);
}

function trimDeadLetter(): void {
  if (deadLetterQueue.length > MAX_DEAD_LETTER_SIZE) {
    deadLetterQueue.splice(0, deadLetterQueue.length - MAX_DEAD_LETTER_SIZE);
  }
}

// =====================================================================
// Batch Processor — runs every 50ms
// =====================================================================

function processTick(): void {
  const size = totalQueueSize();
  if (size === 0) {
    metrics.backpressureActive = false;
    return;
  }

  // Periodic cleanup (every tick is fine — cheap O(n) on small maps)
  cleanupDedupMap();
  cleanupMetrics();

  // Batch dequeue: up to BATCH_SIZE events, high → medium → low
  const batch = dequeueBatch(BATCH_SIZE);

  for (let i = 0; i < batch.length; i++) {
    processEvent(batch[i]);
  }
}

// =====================================================================
// Statistics — Single-Pass Computation
// =====================================================================

function computeStats() {
  // Single pass through all 3 buckets to compute priority + type counts
  let highCount = 0;
  let mediumCount = 0;
  let lowCount = 0;
  const typeCounts: Record<string, number> = {};

  for (const level of ['high', 'medium', 'low'] as const) {
    const bucket = priorityBuckets[level];
    for (let i = 0; i < bucket.length; i++) {
      if (level === 'high') highCount++;
      else if (level === 'medium') mediumCount++;
      else lowCount++;

      const t = bucket[i].type;
      typeCounts[t] = (typeCounts[t] || 0) + 1;
    }
  }

  // Health metrics from rolling windows
  const now = Date.now();
  const windowStart = now - METRICS_WINDOW_MS;
  let recentCount = 0;
  const ts = metrics.processedTimestamps;
  for (let i = 0; i < ts.length; i++) {
    if (ts[i] >= windowStart) recentCount++;
  }

  const eventsPerSecond = recentCount > 0 ? recentCount / (METRICS_WINDOW_MS / 1000) : 0;
  const successRate =
    metrics.totalProcessed > 0
      ? (metrics.totalSuccess / metrics.totalProcessed) * 100
      : 100;

  let avgLatency = 0;
  if (metrics.recentLatencies.length > 0) {
    let sum = 0;
    const lat = metrics.recentLatencies;
    for (let i = 0; i < lat.length; i++) sum += lat[i];
    avgLatency = sum / lat.length;
  }

  return {
    queueSize: totalQueueSize(),
    deadLetterSize: deadLetterQueue.length,
    maxQueueSize: MAX_QUEUE_SIZE,
    connectedClients: connectedUsers.size,
    uptimeSeconds: Math.floor((now - metrics.startTime) / 1000),
    processed: {
      total: metrics.totalProcessed,
      success: metrics.totalSuccess,
      failed: metrics.totalFailed,
    },
    byPriority: { high: highCount, medium: mediumCount, low: lowCount },
    byType: typeCounts,
    deduplication: {
      totalDeduplicated: metrics.totalDeduplicated,
      windowMs: DEDUP_WINDOW_MS,
    },
    backpressure: {
      active: metrics.backpressureActive,
      threshold: BACKPRESSURE_THRESHOLD,
      currentUtilization: totalQueueSize() / MAX_QUEUE_SIZE,
    },
    health: {
      eventsPerSecond: Math.round(eventsPerSecond * 100) / 100,
      successRate: Math.round(successRate * 100) / 100,
      avgLatencyMs: Math.round(avgLatency * 100) / 100,
      windowSeconds: METRICS_WINDOW_MS / 1000,
    },
  };
}

// =====================================================================
// HTTP API Handler
// =====================================================================

function handleApiRequest(req: IncomingMessage, res: ServerResponse): boolean {
  const url = new URL(req.url || '/', `http://localhost:${PORT}`);
  const path = url.pathname;
  const isApiPath =
    path === '/enqueue' ||
    path === '/api/events' ||
    path === '/api/health' ||
    path.startsWith('/api/queue/');

  if (!isApiPath) return false;

  // Auth check (shared secret)
  const authHeader = req.headers.authorization;
  const wsSecret = process.env.WS_SECRET || 'razkindo-erp-ws-secret-2024';
  if (authHeader !== `Bearer ${wsSecret}`) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return true;
  }

  // --- POST /enqueue (backward compatible) ---
  if (path === '/enqueue' && req.method === 'POST') {
    return handleEnqueue(req, res, false);
  }

  // --- POST /api/events (new — supports batch) ---
  if (path === '/api/events' && req.method === 'POST') {
    return handleEnqueue(req, res, true);
  }

  // --- GET /api/queue/status ---
  if (path === '/api/queue/status' && req.method === 'GET') {
    const stats = computeStats();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(stats));
    return true;
  }

  // --- GET /api/queue/performance ---
  if (path === '/api/queue/performance' && req.method === 'GET') {
    const stats = computeStats();
    const now = Date.now();
    const windowStart = now - METRICS_WINDOW_MS;
    let recentCount = 0;
    const ts = metrics.processedTimestamps;
    for (let i = 0; i < ts.length; i++) {
      if (ts[i] >= windowStart) recentCount++;
    }
    const eventsPerSecond = recentCount > 0 ? recentCount / (METRICS_WINDOW_MS / 1000) : 0;

    let p50Latency = 0;
    let p95Latency = 0;
    let p99Latency = 0;
    if (metrics.recentLatencies.length > 0) {
      const sorted = [...metrics.recentLatencies].sort((a, b) => a - b);
      const p = (percentile: number) => {
        const idx = Math.ceil((percentile / 100) * sorted.length) - 1;
        return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
      };
      p50Latency = p(50);
      p95Latency = p(95);
      p99Latency = p(99);
    }

    const performanceResponse = {
      timestamp: new Date(now).toISOString(),
      processing: {
        eventsPerSecond: Math.round(eventsPerSecond * 100) / 100,
        batchSize: BATCH_SIZE,
        tickIntervalMs: PROCESS_INTERVAL_MS,
      },
      latency: {
        avgMs: stats.health.avgLatencyMs,
        p50Ms: p50Latency,
        p95Ms: p95Latency,
        p99Ms: p99Latency,
        sampleCount: metrics.recentLatencies.length,
      },
      throughput: {
        totalEnqueued: metrics.totalEnqueued,
        totalProcessed: metrics.totalProcessed,
        totalSuccess: metrics.totalSuccess,
        totalFailed: metrics.totalFailed,
        totalDeduplicated: metrics.totalDeduplicated,
        totalDropped: metrics.totalDropped,
        successRate: stats.health.successRate,
      },
      queue: {
        size: stats.queueSize,
        maxSize: MAX_QUEUE_SIZE,
        byPriority: stats.byPriority,
        deadLetterSize: stats.deadLetterSize,
      },
      connections: {
        total: stats.connectedClients,
        uniqueIps: ipConnectionCount.size,
        maxPerIp: MAX_CONNECTIONS_PER_IP,
      },
      deduplication: {
        totalDeduplicated: metrics.totalDeduplicated,
        windowMs: DEDUP_WINDOW_MS,
      },
      backpressure: stats.backpressure,
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(performanceResponse));
    return true;
  }

  // --- GET /api/health ---
  if (path === '/api/health' && req.method === 'GET') {
    const stats = computeStats();
    const now = Date.now();
    const healthResponse = {
      status: stats.backpressure.active ? 'degraded' : 'healthy',
      timestamp: new Date(now).toISOString(),
      version: '2.0.0',
      queue: {
        size: stats.queueSize,
        maxSize: stats.maxQueueSize,
        utilization: `${Math.round(stats.backpressure.currentUtilization * 100)}%`,
      },
      performance: stats.health,
      connections: {
        total: stats.connectedClients,
        maxPerIp: MAX_CONNECTIONS_PER_IP,
        uniqueIps: ipConnectionCount.size,
      },
      deduplication: stats.deduplication,
      deadLetter: {
        size: stats.deadLetterSize,
        maxSize: MAX_DEAD_LETTER_SIZE,
      },
      totals: {
        enqueued: metrics.totalEnqueued,
        processed: stats.processed,
        deduplicated: metrics.totalDeduplicated,
        dropped: metrics.totalDropped,
      },
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(healthResponse));
    return true;
  }

  // --- GET /api/queue/dead-letter ---
  if (path === '/api/queue/dead-letter' && req.method === 'GET') {
    const events = deadLetterQueue.map((e) => ({
      id: e.id,
      type: e.type,
      target: e.target,
      targetId: e.targetId,
      priority: e.priority,
      attempts: e.attempts,
      lastError: e.lastError,
      createdAt: e.createdAt,
      data: e.data,
    }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ count: events.length, events }));
    return true;
  }

  // --- POST /api/queue/retry/:id ---
  const retryMatch = path.match(/^\/api\/queue\/retry\/(.+)$/);
  if (retryMatch && req.method === 'POST') {
    const eventId = retryMatch[1];
    let dlIdx = -1;
    for (let i = 0; i < deadLetterQueue.length; i++) {
      if (deadLetterQueue[i].id === eventId) {
        dlIdx = i;
        break;
      }
    }
    if (dlIdx === -1) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Event not found in dead-letter queue' }));
      return true;
    }
    const event = deadLetterQueue.splice(dlIdx, 1)[0];
    event.attempts = 0;
    event.nextRetryAt = undefined;
    event.lastError = undefined;
    priorityBuckets[event.priority].push(event);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, message: `Event ${eventId} moved back to queue` }));
    return true;
  }

  return false;
}

/**
 * Handle POST /enqueue and POST /api/events.
 * When `allowBatch` is true, accepts an array of events (bulk mode).
 */
function handleEnqueue(
  req: IncomingMessage,
  res: ServerResponse,
  allowBatch: boolean,
): boolean {
  let body = '';
  let bodySize = 0;

  req.on('data', (chunk: Buffer) => {
    bodySize += chunk.length;
    if (bodySize > MAX_BODY_SIZE) {
      if (!res.headersSent && !res.writableEnded) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Request body too large', maxSize: MAX_BODY_SIZE }));
      }
      req.destroy();
      return;
    }
    body += chunk.toString();
  });

  req.on('end', () => {
    // Guard: skip if response was already sent (e.g., body size overflow)
    if (res.headersSent || res.writableEnded) return;

    try {
      const parsed = JSON.parse(body);

      // Batch mode: array of events
      if (allowBatch && Array.isArray(parsed)) {
        handleBulkEnqueue(parsed, res);
        return;
      }

      // Single event (works for both /enqueue and /api/events)
      const event = parsed as Partial<QueuedEvent>;
      const result = enqueueEvent(
        event.type || 'notification',
        event.target || 'all',
        event.targetId,
        event.data || {},
        event.priority,
      );

      if (typeof result === 'string') {
        if (result === 'queue_full') {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Queue full', queueSize: totalQueueSize() }));
        } else if (result.startsWith('deduplicated:')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              success: true,
              deduplicated: true,
              originalEventId: result.slice('deduplicated:'.length),
              queueSize: totalQueueSize(),
            }),
          );
        }
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          success: true,
          eventId: result.eventId,
          queueSize: result.queueSize,
          backpressure: metrics.backpressureActive,
        }),
      );
    } catch {
      if (!res.headersSent && !res.writableEnded) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      }
    }
  });

  return true;
}

function handleBulkEnqueue(events: unknown[], res: ServerResponse): void {
  const results: Array<{
    success: boolean;
    eventId?: string;
    deduplicated?: boolean;
    error?: string;
  }> = [];
  let acceptedCount = 0;
  let dedupCount = 0;
  let rejectCount = 0;

  for (const raw of events) {
    const event = raw as Partial<QueuedEvent>;
    const result = enqueueEvent(
      event.type || 'notification',
      event.target || 'all',
      event.targetId,
      event.data || {},
      event.priority,
    );

    if (typeof result === 'string') {
      if (result === 'queue_full') {
        results.push({ success: false, error: 'queue_full' });
        rejectCount++;
      } else if (result.startsWith('deduplicated:')) {
        results.push({ success: true, deduplicated: true, eventId: result.slice('deduplicated:'.length) });
        dedupCount++;
        acceptedCount++;
      }
    } else {
      results.push({ success: true, eventId: result.eventId });
      acceptedCount++;
    }
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(
    JSON.stringify({
      success: true,
      batch: {
        total: events.length,
        accepted: acceptedCount,
        deduplicated: dedupCount,
        rejected: rejectCount,
        queueSize: totalQueueSize(),
        backpressure: metrics.backpressureActive,
      },
      results,
    }),
  );
}

// =====================================================================
// Create Server + Socket.io
// =====================================================================

const httpServer = createServer();

const io = new Server(httpServer, {
  path: '/socket.io',
  pingTimeout: 60000,
  pingInterval: 25000,
  cors: {
    origin: process.env.CORS_ORIGINS?.split(',') || true,
    methods: ['GET', 'POST'],
    credentials: true,
  },
});

// ---------------------------------------------------------------------------
// Request routing: API routes vs Socket.io (engine.io)
//
// Problem: engine.io registers its own 'request' listener which intercepts
// ALL POST requests to path '/'. For non-socket requests (our API), it
// responds with {"code":0,"message":"Transport unknown"} before our
// async body parser can finish.
//
// Fix: Remove engine.io's request listener and replace with a gatekeeper
// that routes API paths to our handler and everything else to engine.io.
// The 'upgrade' listener (for WebSocket) is left untouched.
// ---------------------------------------------------------------------------

// Capture engine.io's request handler before removing it
const engineRequestListeners = httpServer.listeners('request') as Array<
  (req: IncomingMessage, res: ServerResponse) => void
>;
httpServer.removeAllListeners('request');

// Single request handler that routes based on path
httpServer.on('request', (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url || '/', `http://localhost:${PORT}`);
  const path = url.pathname;
  const isApiPath =
    path === '/enqueue' ||
    path === '/api/events' ||
    path === '/api/health' ||
    path.startsWith('/api/queue/');

  if (isApiPath) {
    // API route — handled exclusively by our handler
    handleApiRequest(req, res);
    return;
  }

  // Non-API route — delegate to engine.io (socket.io polling/handshake)
  for (const listener of engineRequestListeners) {
    listener(req, res);
    if (res.writableEnded || res.headersSent) break;
  }
});

// =====================================================================
// Socket.io Connection Handling
// =====================================================================

io.on('connection', (socket) => {
  console.log(`[EventQueue] Socket connected: ${socket.id}`);

  // Per-IP rate limiting
  const clientIp =
    socket.request.headers['x-forwarded-for']?.toString().split(',')[0]?.trim() ||
    socket.handshake.address ||
    'unknown';

  const currentCount = ipConnectionCount.get(clientIp) || 0;
  if (currentCount >= MAX_CONNECTIONS_PER_IP) {
    console.warn(
      `[EventQueue] Rejecting ${clientIp}: max ${MAX_CONNECTIONS_PER_IP} connections reached`,
    );
    socket.disconnect(true);
    return;
  }
  ipConnectionCount.set(clientIp, currentCount + 1);

  // --- 'register' event (backward compatible) ---
  socket.on(
    'register',
    (data: { userId?: string; roles?: string[]; unitId?: string; userName?: string }) => {
      connectedUsers.set(socket.id, {
        socketId: socket.id,
        userId: data.userId,
        roles: data.roles || [],
        unitId: data.unitId,
        userName: data.userName,
        joinedAt: Date.now(),
      });
      console.log(
        `[EventQueue] Registered: ${socket.id} (user: ${data.userId || 'anon'}, roles: ${data.roles?.join(',') || 'none'}, unit: ${data.unitId || 'none'})`,
      );
    },
  );

  // --- 'event' event (submit single event via socket) ---
  socket.on(
    'event',
    (eventData: Partial<QueuedEvent>, ack: (response: Record<string, unknown>) => void) => {
      if (!ack || typeof ack !== 'function') return; // No ack callback — ignore

      const result = enqueueEvent(
        eventData.type || 'notification',
        eventData.target || 'all',
        eventData.targetId,
        eventData.data || {},
        eventData.priority,
      );

      if (typeof result === 'string') {
        if (result === 'queue_full') {
          ack({ success: false, error: 'queue_full', queueSize: totalQueueSize() });
        } else if (result.startsWith('deduplicated:')) {
          ack({
            success: true,
            deduplicated: true,
            originalEventId: result.slice('deduplicated:'.length),
            queueSize: totalQueueSize(),
          });
        }
      } else {
        ack({
          success: true,
          eventId: result.eventId,
          queueSize: result.queueSize,
          backpressure: metrics.backpressureActive,
        });
      }
    },
  );

  // --- 'bulk-events' event (submit multiple events via socket) ---
  socket.on(
    'bulk-events',
    (eventsData: Partial<QueuedEvent>[], ack: (response: Record<string, unknown>) => void) => {
      if (!ack || typeof ack !== 'function') return;
      if (!Array.isArray(eventsData)) {
        ack({ success: false, error: 'Expected array of events' });
        return;
      }

      const results: Array<Record<string, unknown>> = [];
      let accepted = 0;
      let deduped = 0;
      let rejected = 0;

      for (const raw of eventsData) {
        const result = enqueueEvent(
          raw.type || 'notification',
          raw.target || 'all',
          raw.targetId,
          raw.data || {},
          raw.priority,
        );

        if (typeof result === 'string') {
          if (result === 'queue_full') {
            results.push({ success: false, error: 'queue_full' });
            rejected++;
          } else if (result.startsWith('deduplicated:')) {
            results.push({ success: true, deduplicated: true, eventId: result.slice('deduplicated:'.length) });
            deduped++;
            accepted++;
          }
        } else {
          results.push({ success: true, eventId: result.eventId });
          accepted++;
        }
      }

      ack({
        success: true,
        batch: { total: eventsData.length, accepted, deduplicated: deduped, rejected },
        queueSize: totalQueueSize(),
        results,
      });
    },
  );

  // --- Disconnect ---
  socket.on('disconnect', (reason) => {
    connectedUsers.delete(socket.id);
    const count = ipConnectionCount.get(clientIp) || 1;
    if (count <= 1) ipConnectionCount.delete(clientIp);
    else ipConnectionCount.set(clientIp, count - 1);
    console.log(`[EventQueue] Disconnected: ${socket.id} (${reason})`);
  });

  socket.on('error', (err) => {
    console.error(`[EventQueue] Socket error (${socket.id}):`, err);
  });
});

// =====================================================================
// Start Server
// =====================================================================

httpServer.listen(PORT, () => {
  console.log(`[EventQueue] v2 started on port ${PORT}`);
  console.log(`[EventQueue] Config: batch=${BATCH_SIZE}/tick, interval=${PROCESS_INTERVAL_MS}ms, maxQueue=${MAX_QUEUE_SIZE}, maxIp=${MAX_CONNECTIONS_PER_IP}`);
  console.log(`[EventQueue] Endpoints:`);
  console.log(`  POST /enqueue                 — Add single event`);
  console.log(`  POST /api/events              — Add single or batch events`);
  console.log(`  GET  /api/queue/status        — Queue health (single-pass)`);
  console.log(`  GET  /api/queue/performance  — Detailed performance metrics`);
  console.log(`  GET  /api/health              — Detailed health metrics`);
  console.log(`  GET  /api/queue/dead-letter   — Failed events`);
  console.log(`  POST /api/queue/retry/:id     — Retry dead-letter event`);
  console.log(`[EventQueue] Socket events: register, event, bulk-events`);
});

// Start batch processor (every 50ms)
const processInterval = setInterval(processTick, PROCESS_INTERVAL_MS);

// =====================================================================
// Graceful Shutdown
// =====================================================================

function shutdown(): void {
  console.log('[EventQueue] Shutting down...');
  console.log(`[EventQueue] Queue state: ${totalQueueSize()} events in queue, ${deadLetterQueue.length} in dead-letter`);

  clearInterval(processInterval);

  // Stop accepting new connections
  io.close();

  httpServer.close((err) => {
    if (err) console.error('[EventQueue] Server close error:', err);
    console.log('[EventQueue] Server closed');
    process.exit(0);
  });

  // Force exit after 5s
  setTimeout(() => {
    console.warn('[EventQueue] Forced shutdown after 5s timeout');
    process.exit(1);
  }, 5000);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Handle uncaught exceptions — log and continue
process.on('uncaughtException', (err) => {
  console.error('[EventQueue] Uncaught exception:', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('[EventQueue] Unhandled rejection:', reason);
});
