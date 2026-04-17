// =====================================================================
// SUPABASE REST CLIENT — Real @supabase/supabase-js connection
//
// Creates a real Supabase client that connects to the remote Supabase
// PostgreSQL project via HTTPS REST API (no direct DB connection needed).
//
// This is the single source of truth for the Supabase connection config.
// All other modules that need the real Supabase client should import
// from here.
//
// Exports:
//   supabaseRestClient — real Supabase client (from '@supabase/supabase-js')
//   SUPABASE_URL        — resolved project URL
//   SUPABASE_ANON_KEY   — resolved anon key
//   SUPABASE_SERVICE_KEY — resolved service role key
// =====================================================================

import { createClient, SupabaseClient } from '@supabase/supabase-js';

// ─────────────────────────────────────────────────────────────────────
// CONFIGURATION — Read from env, gracefully handle missing keys
// ─────────────────────────────────────────────────────────────────────

/** Supabase project URL — from env only (no hardcoded fallback) */
export const SUPABASE_URL: string = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://placeholder.supabase.co';

/** Supabase anon (publishable) key — from env, fallback to placeholder */
export const SUPABASE_ANON_KEY: string = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'placeholder-anon-key';

/** Supabase service role key — bypasses all RLS policies, server-side only */
export const SUPABASE_SERVICE_KEY: string = process.env.SUPABASE_SERVICE_ROLE_KEY || (() => {
  if (process.env.NODE_ENV !== 'test') {
    console.warn(
      '[Supabase REST] ⚠️ SUPABASE_SERVICE_ROLE_KEY not set or invalid. ' +
      'Server-side queries will use anon key (RLS enforced). ' +
      'Set the correct service role key from Supabase Dashboard → Settings → API.'
    );
  }
  return SUPABASE_ANON_KEY;
})();

// ─────────────────────────────────────────────────────────────────────
// CLIENT SINGLETON
// ─────────────────────────────────────────────────────────────────────

const globalForSupabase = globalThis as unknown as {
  supabaseRestClient: SupabaseClient | undefined;
};

const hasValidConfig = process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

/**
 * Real Supabase client connected to the remote project.
 * Uses the singleton pattern to prevent multiple instances in dev mode.
 *
 * If env vars are missing, creates a placeholder client that won't crash
 * but will return errors on API calls. The app falls back to Prisma.
 */
export const supabaseRestClient: SupabaseClient =
  globalForSupabase.supabaseRestClient ||
  createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    // Use service_role key — bypasses Row Level Security for server-side operations
    auth: {
      persistSession: false, // Server-side — no cookie/session persistence
      autoRefreshToken: false,
    },
    db: {
      schema: 'public',
    },
  });

// Persist singleton in development to survive HMR
if (process.env.NODE_ENV !== 'production') {
  globalForSupabase.supabaseRestClient = supabaseRestClient;
}

if (!hasValidConfig) {
  console.warn(
    '[Supabase REST] Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY. ' +
    'REST API features will be unavailable. Prisma-based operations will continue normally.'
  );
}
