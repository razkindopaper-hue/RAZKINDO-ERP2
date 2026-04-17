// =====================================================================
// CONNECTION POOL — Active PgBouncer connection pool manager
//
// Provides two pool modes for different workloads:
//   - Transaction pool (port 6543): For regular queries, max concurrency
//   - Session pool (port 5432): For DDL, BEGIN/COMMIT, NOTIFY, SET
//
// The pooler URL is auto-detected from environment variables:
//   SUPABASE_POOLER_URL  → Full PgBouncer URL (transaction mode)
//   SUPABASE_SESSION_POOL_URL → Session mode pooler URL
//   SUPABASE_DB_URL       → Direct connection (fallback)
//
// Supabase pooler format:
//   postgresql://postgres.[project-ref]:[password]@aws-1-ap-southeast-1.pooler.supabase.com:6543/postgres
// =====================================================================

import type { Pool, PoolConfig } from 'pg';

// ---------------------------------------------------------------------------
// Pool instances (lazy initialized)
// ---------------------------------------------------------------------------

let _transactionPool: Pool | null = null;
let _sessionPool: Pool | null = null;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Pool configuration for transaction-mode connections (high concurrency) */
const TRANSACTION_POOL_CONFIG: PoolConfig = {
  max: 20, // Max simultaneous connections
  min: 2,  // Min idle connections
  idleTimeoutMillis: 30_000,      // Reclaim idle connections after 30s
  connectionTimeoutMillis: 10_000, // Fail fast if no connection in 10s
  // NOTE: maxLifetimeMs is NOT a valid pg.PoolConfig option (BUG-04 fix — removed)
  allowExitOnIdle: false,         // Never exit — Next.js dev server must stay alive
};

/** Pool configuration for session-mode connections (DDL, transactions) */
const SESSION_POOL_CONFIG: PoolConfig = {
  max: 5,  // Lower limit — DDL operations are infrequent
  min: 1,
  idleTimeoutMillis: 60_000,      // Longer idle timeout for admin ops
  connectionTimeoutMillis: 30_000, // Longer timeout for DDL operations
  // NOTE: maxLifetimeMs is NOT a valid pg.PoolConfig option (BUG-04 fix — removed)
  allowExitOnIdle: false,
};

// ---------------------------------------------------------------------------
// URL resolution
// ---------------------------------------------------------------------------

/**
 * Get the transaction-mode pooler URL.
 * Prefers SUPABASE_POOLER_URL (port 6543), falls back to SUPABASE_DB_URL.
 */
export function getTransactionPoolUrl(): string {
  return process.env.SUPABASE_POOLER_URL || process.env.SUPABASE_DB_URL || '';
}

/**
 * Get the session-mode pooler URL.
 * Prefers SUPABASE_SESSION_POOL_URL, falls back to SUPABASE_DB_URL.
 * Session mode is needed for DDL, BEGIN/COMMIT, NOTIFY, SET commands.
 */
export function getSessionPoolUrl(): string {
  return process.env.SUPABASE_SESSION_POOL_URL || process.env.SUPABASE_DB_URL || '';
}

/** Check if PgBouncer pooler URL is configured for transaction mode */
export function hasTransactionPool(): boolean {
  return !!process.env.SUPABASE_POOLER_URL;
}

/** Check if PgBouncer pooler URL is configured for session mode */
export function hasSessionPool(): boolean {
  return !!process.env.SUPABASE_SESSION_POOL_URL;
}

// ---------------------------------------------------------------------------
// Pool initialization
// ---------------------------------------------------------------------------

/**
 * Get or create the transaction-mode connection pool.
 * Use this for regular queries, SELECT, INSERT, UPDATE, DELETE.
 * NOT suitable for DDL, BEGIN/COMMIT, NOTIFY, SET, or prepared statements.
 */
export async function getTransactionPool(): Promise<Pool> {
  if (_transactionPool) return _transactionPool;

  const url = getTransactionPoolUrl();
  if (!url) {
    throw new Error(
      '[ConnectionPool] No database URL configured. Set SUPABASE_POOLER_URL or SUPABASE_DB_URL.'
    );
  }

  const { Pool } = await import('pg');

  _transactionPool = new Pool({
    ...TRANSACTION_POOL_CONFIG,
    connectionString: url,
    ssl: { rejectUnauthorized: false },
  });

  _transactionPool.on('error', (err: Error) => {
    console.error('[ConnectionPool:Tx] Unexpected pool error:', err.message);
  });

  _transactionPool.on('connect', () => {
    // Only log on first connect to avoid spam
  });

  console.log('[ConnectionPool:Tx] Transaction-mode pool initialized');

  return _transactionPool;
}

/**
 * Get or create the session-mode connection pool.
 * Use this for DDL operations, multi-statement transactions, NOTIFY, SET.
 * Required for setup-schema, setup-rpc, migration operations.
 */
export async function getSessionPool(): Promise<Pool> {
  if (_sessionPool) return _sessionPool;

  const url = getSessionPoolUrl();
  if (!url) {
    throw new Error(
      '[ConnectionPool] No database URL configured. Set SUPABASE_SESSION_POOL_URL or SUPABASE_DB_URL.'
    );
  }

  const { Pool } = await import('pg');

  _sessionPool = new Pool({
    ...SESSION_POOL_CONFIG,
    connectionString: url,
    ssl: { rejectUnauthorized: false },
  });

  _sessionPool.on('error', (err: Error) => {
    console.error('[ConnectionPool:Session] Unexpected pool error:', err.message);
  });

  console.log('[ConnectionPool:Session] Session-mode pool initialized');

  return _sessionPool;
}

// ---------------------------------------------------------------------------
// Convenience: Run a query directly
// ---------------------------------------------------------------------------

/**
 * Run a single query on the transaction pool.
 * Automatically acquires and releases a client.
 */
export async function poolQuery<T = any>(text: string, params?: unknown[]): Promise<T[]> {
  const pool = await getTransactionPool();
  const result = await pool.query(text, params);
  return result.rows;
}

/**
 * Run a single query on the session pool.
 * Use for DDL or operations requiring session state.
 */
export async function sessionQuery<T = any>(text: string, params?: unknown[]): Promise<T[]> {
  const pool = await getSessionPool();
  const result = await pool.query(text, params);
  return result.rows;
}

/**
 * Run multiple statements in a session-mode transaction.
 * Acquires a dedicated client, runs BEGIN, executes statements, then COMMIT.
 * On error, ROLLBACK is executed automatically.
 */
export async function sessionTransaction(
  statements: { text: string; params?: unknown[] }[]
): Promise<{ results: any[][]; errors: string[] }> {
  const pool = await getSessionPool();
  const client = await pool.connect();

  const results: any[][] = [];
  const errors: string[] = [];

  try {
    await client.query('BEGIN');

    for (const stmt of statements) {
      try {
        const result = await client.query(stmt.text, stmt.params);
        results.push(result.rows);
      } catch (err: any) {
        const msg = err.message || String(err);
        if (
          msg.includes('already exists') ||
          msg.includes('duplicate key') ||
          msg.includes('relation already exists')
        ) {
          results.push([]); // harmless, continue
        } else {
          errors.push(`${stmt.text.substring(0, 100)}: ${msg}`);
          throw err; // trigger ROLLBACK
        }
      }
    }

    await client.query('COMMIT');
  } catch (err: any) {
    await client.query('ROLLBACK').catch(() => {});
    if (errors.length === 0) {
      errors.push(err.message || String(err));
    }
  } finally {
    client.release();
  }

  return { results, errors };
}

// ---------------------------------------------------------------------------
// Health & stats
// ---------------------------------------------------------------------------

interface PoolStats {
  name: string;
  url: string;
  mode: 'transaction' | 'session' | 'none';
  totalConnections: number;
  idleConnections: number;
  waitingRequests: number;
  activeConnections: number;
  isHealthy: boolean;
}

/**
 * Get connection pool statistics for health monitoring.
 */
export async function getPoolStats(): Promise<{ transaction: PoolStats; session: PoolStats }> {
  const txStats = await getStatsForPool(_transactionPool, 'Transaction', getTransactionPoolUrl(), 'transaction');
  const sessionStats = await getStatsForPool(_sessionPool, 'Session', getSessionPoolUrl(), 'session');
  return { transaction: txStats, session: sessionStats };
}

async function getStatsForPool(
  pool: Pool | null,
  name: string,
  url: string,
  mode: 'transaction' | 'session'
): Promise<PoolStats> {
  if (!pool) {
    return {
      name,
      url: url ? '[configured]' : '[not configured]',
      mode,
      totalConnections: 0,
      idleConnections: 0,
      waitingRequests: 0,
      activeConnections: 0,
      isHealthy: false,
    };
  }

  try {
    // Quick connectivity check
    await pool.query('SELECT 1');

    return {
      name,
      url: '[active]',
      mode,
      totalConnections: pool.totalCount,
      idleConnections: pool.idleCount,
      waitingRequests: pool.waitingCount,
      activeConnections: pool.totalCount - pool.idleCount,
      isHealthy: true,
    };
  } catch {
    return {
      name,
      url: '[error]',
      mode,
      totalConnections: pool.totalCount,
      idleConnections: pool.idleCount,
      waitingRequests: pool.waitingCount,
      activeConnections: pool.totalCount - pool.idleCount,
      isHealthy: false,
    };
  }
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

/**
 * Close all connection pools gracefully.
 * Call this on server shutdown (SIGTERM, SIGINT).
 */
export async function closeAllPools(): Promise<void> {
  const closers: Promise<void>[] = [];

  if (_transactionPool) {
    closers.push(
      _transactionPool.end().then(() => {
        console.log('[ConnectionPool:Tx] Pool closed');
      })
    );
  }

  if (_sessionPool) {
    closers.push(
      _sessionPool.end().then(() => {
        console.log('[ConnectionPool:Session] Pool closed');
      })
    );
  }

  await Promise.allSettled(closers);
  _transactionPool = null;
  _sessionPool = null;
}

// ---------------------------------------------------------------------------
// Constants (for backward compatibility)
// ---------------------------------------------------------------------------

export const poolConfig = TRANSACTION_POOL_CONFIG;
export const POOL_HEALTH_CHECK_INTERVAL = 30_000;

// NOTE: SIGTERM/SIGINT handlers removed (BUG-17 fix).
// These handlers called process.exit(0) which killed the Next.js dev server
// after ~30 seconds because the sandbox sends periodic SIGTERM signals.
// Next.js has its own graceful shutdown handling.
// Call closeAllPools() explicitly if needed during controlled shutdown.
