// =====================================================================
// DEPLOY RPCs — One-shot script to force-deploy all PostgreSQL RPC
// functions defined in src/lib/ensure-rpc.ts.
//
// Usage: bun run scripts/deploy-rpcs.ts
//
// Connection strategy (same as ensure-rpc.ts):
//   1. SUPABASE_DB_URL (direct — may fail on IPv6-only hosts)
//   2. Session-mode pooler (port 5432 on pooler host) — DDL-safe
//   3. Transaction-mode pooler (port 6543) — last resort
// =====================================================================

import { config } from 'dotenv';
config({ path: '.env' });

import { Pool } from 'pg';

// ---------------------------------------------------------------------------
// RPC Definitions — duplicated from ensure-rpc.ts to avoid importing
// server-side code that relies on Next.js runtime.
// ---------------------------------------------------------------------------

const RPC_DEFINITIONS: { name: string; sql: string }[] = [
  {
    name: 'decrement_stock',
    sql: `CREATE OR REPLACE FUNCTION decrement_stock(p_product_id text, p_qty numeric)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_new_stock numeric;
BEGIN
  UPDATE products SET global_stock = global_stock - p_qty
  WHERE id = p_product_id AND global_stock >= p_qty
  RETURNING global_stock INTO v_new_stock;
  IF NOT FOUND THEN RAISE EXCEPTION 'Stok tidak cukup untuk produk %', p_product_id; END IF;
END;
$$;`,
  },
  {
    name: 'increment_stock',
    sql: `CREATE OR REPLACE FUNCTION increment_stock(p_product_id text, p_qty numeric)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  UPDATE products SET global_stock = global_stock + p_qty WHERE id = p_product_id;
END;
$$;`,
  },
  {
    name: 'decrement_unit_stock',
    sql: `CREATE OR REPLACE FUNCTION decrement_unit_stock(p_unit_product_id text, p_qty numeric)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_new_stock numeric;
BEGIN
  UPDATE unit_products SET stock = stock - p_qty
  WHERE id = p_unit_product_id AND stock >= p_qty
  RETURNING stock INTO v_new_stock;
  IF NOT FOUND THEN RAISE EXCEPTION 'Stok unit tidak cukup (unit_product_id: %)', p_unit_product_id; END IF;
END;
$$;`,
  },
  {
    name: 'increment_unit_stock',
    sql: `CREATE OR REPLACE FUNCTION increment_unit_stock(p_unit_product_id text, p_qty numeric)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  UPDATE unit_products SET stock = stock + p_qty WHERE id = p_unit_product_id;
END;
$$;`,
  },
  {
    name: 'recalc_global_stock',
    sql: `CREATE OR REPLACE FUNCTION recalc_global_stock(p_product_id text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_total numeric;
BEGIN
  SELECT COALESCE(SUM(stock), 0) INTO v_total FROM unit_products WHERE product_id = p_product_id;
  UPDATE products SET global_stock = v_total WHERE id = p_product_id;
END;
$$;`,
  },
  {
    name: 'increment_stock_with_hpp',
    sql: `CREATE OR REPLACE FUNCTION increment_stock_with_hpp(p_product_id text, p_qty numeric, p_new_hpp numeric DEFAULT 0)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_current_stock numeric; v_current_hpp numeric; v_new_global_stock numeric; v_new_avg_hpp numeric;
BEGIN
  SELECT global_stock, avg_hpp INTO v_current_stock, v_current_hpp FROM products WHERE id = p_product_id;
  v_new_global_stock := COALESCE(v_current_stock, 0) + p_qty;
  IF p_qty > 0 AND p_new_hpp > 0 THEN
    v_new_avg_hpp := (COALESCE(v_current_stock, 0) * COALESCE(v_current_hpp, 0) + p_qty * p_new_hpp) / v_new_global_stock;
  ELSE v_new_avg_hpp := COALESCE(v_current_hpp, 0); END IF;
  UPDATE products SET global_stock = v_new_global_stock, avg_hpp = v_new_avg_hpp WHERE id = p_product_id;
END;
$$;`,
  },
  {
    name: 'atomic_update_balance',
    sql: `CREATE OR REPLACE FUNCTION atomic_update_balance(p_table text, p_id text, p_delta numeric, p_min numeric DEFAULT 0)
RETURNS numeric LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_new_balance numeric; v_balance_col text;
BEGIN
  IF p_table = 'cash_boxes' OR p_table = 'bank_accounts' THEN v_balance_col := 'balance';
  ELSE RAISE EXCEPTION 'Unsupported table: %', p_table; END IF;
  EXECUTE format('UPDATE %I SET balance = balance + $1 WHERE id = $2 AND balance + $1 >= $3 RETURNING balance', p_table)
    INTO v_new_balance USING p_delta, p_id, p_min;
  IF v_new_balance IS NULL THEN RAISE EXCEPTION 'Insufficient balance or record not found'; END IF;
  RETURN v_new_balance;
END;
$$;`,
  },
  {
    name: 'atomic_update_setting_balance',
    sql: `CREATE OR REPLACE FUNCTION atomic_update_setting_balance(p_key text, p_delta numeric, p_min numeric DEFAULT 0)
RETURNS numeric LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_current numeric; v_new_balance numeric; v_raw_value text;
BEGIN
  SELECT value INTO v_raw_value FROM settings WHERE key = p_key;
  BEGIN v_current := v_raw_value::numeric;
  EXCEPTION WHEN OTHERS THEN
    BEGIN v_current := (v_raw_value::json)::text::numeric;
    EXCEPTION WHEN OTHERS THEN v_current := 0; END;
  END;
  v_current := COALESCE(v_current, 0);
  v_new_balance := v_current + p_delta;
  IF v_new_balance < p_min THEN RAISE EXCEPTION 'Insufficient pool balance. Current: %, Attempted change: %', v_current, p_delta; END IF;
  INSERT INTO settings (key, value) VALUES (p_key, v_new_balance::text) ON CONFLICT (key) DO UPDATE SET value = v_new_balance::text;
  RETURN v_new_balance;
END;
$$;`,
  },
  // === Concurrency-fix RPCs ===
  {
    name: 'atomic_increment_customer_stats',
    sql: `CREATE OR REPLACE FUNCTION atomic_increment_customer_stats(p_customer_id uuid, p_order_delta integer DEFAULT 1, p_spent_delta numeric DEFAULT 0)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE customers
  SET total_orders = COALESCE(total_orders, 0) + p_order_delta,
      total_spent = COALESCE(total_spent, 0) + p_spent_delta,
      last_transaction_date = GREATEST(COALESCE(last_transaction_date, '1970-01-01'::timestamptz), NOW())
  WHERE id = p_customer_id;
END;
$$;`,
  },
  {
    name: 'decrement_unit_stock_recalc',
    sql: `CREATE OR REPLACE FUNCTION decrement_unit_stock_recalc(p_unit_product_id text, p_qty numeric)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_new_unit_stock numeric; v_new_global_stock numeric; v_product_id text;
BEGIN
  UPDATE unit_products SET stock = stock - p_qty
  WHERE id = p_unit_product_id AND stock >= p_qty
  RETURNING stock, product_id INTO v_new_unit_stock, v_product_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Stok unit tidak cukup (unit_product_id: %)', p_unit_product_id; END IF;
  SELECT COALESCE(SUM(stock), 0) INTO v_new_global_stock FROM unit_products WHERE product_id = v_product_id;
  UPDATE products SET global_stock = v_new_global_stock WHERE id = v_product_id;
  RETURN json_build_object('new_unit_stock', v_new_unit_stock, 'new_global_stock', v_new_global_stock, 'product_id', v_product_id);
END;
$$;`,
  },
  {
    name: 'batch_decrement_centralized_stock',
    sql: `CREATE OR REPLACE FUNCTION batch_decrement_centralized_stock(p_product_ids jsonb, p_quantities jsonb)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_results jsonb := '[]'::jsonb; v_pid text; v_qty numeric; v_new_stock numeric; v_idx integer;
BEGIN
  IF jsonb_array_length(p_product_ids) != jsonb_array_length(p_quantities) THEN
    RAISE EXCEPTION 'product_ids and quantities arrays must have the same length'; END IF;
  FOR v_idx IN 0 .. jsonb_array_length(p_product_ids) - 1 LOOP
    v_pid := p_product_ids->>v_idx; v_qty := (p_quantities->>v_idx)::numeric;
    SELECT global_stock INTO v_new_stock FROM products WHERE id = v_pid;
    IF v_new_stock IS NULL THEN RAISE EXCEPTION 'Produk tidak ditemukan: %', v_pid; END IF;
    IF v_new_stock < v_qty THEN RAISE EXCEPTION 'Stok tidak cukup untuk produk %. Tersedia: %, Dibutuhkan: %', v_pid, v_new_stock, v_qty; END IF;
  END LOOP;
  FOR v_idx IN 0 .. jsonb_array_length(p_product_ids) - 1 LOOP
    v_pid := p_product_ids->>v_idx; v_qty := (p_quantities->>v_idx)::numeric;
    UPDATE products SET global_stock = global_stock - v_qty WHERE id = v_pid RETURNING global_stock INTO v_new_stock;
    v_results := v_results || jsonb_build_object('product_id', v_pid, 'new_stock', v_new_stock);
  END LOOP;
  RETURN v_results;
END;
$$;`,
  },
  // === Courier cash operations ===
  {
    name: 'atomic_add_courier_cash',
    sql: `CREATE OR REPLACE FUNCTION atomic_add_courier_cash(
      p_courier_id uuid, p_unit_id uuid, p_amount numeric DEFAULT 0, p_delta numeric DEFAULT 0,
      p_hpp_delta numeric DEFAULT 0, p_profit_delta numeric DEFAULT 0
    ) RETURNS numeric LANGUAGE plpgsql SECURITY DEFINER AS $$
    DECLARE
      v_delta numeric := COALESCE(p_amount, 0) + COALESCE(p_delta, 0);
      v_hpp_delta numeric := COALESCE(p_hpp_delta, 0);
      v_profit_delta numeric := COALESCE(p_profit_delta, 0);
      v_cc_id text;
      v_new_balance numeric;
    BEGIN
      INSERT INTO courier_cash (id, courier_id, unit_id, balance, total_collected, total_handover, hpp_pending, profit_pending)
      VALUES (gen_random_uuid()::text, p_courier_id, p_unit_id, v_delta,
              CASE WHEN v_delta > 0 THEN v_delta ELSE 0 END,
              CASE WHEN v_delta < 0 THEN ABS(v_delta) ELSE 0 END,
              CASE WHEN v_hpp_delta > 0 THEN v_hpp_delta ELSE 0 END,
              CASE WHEN v_profit_delta > 0 THEN v_profit_delta ELSE 0 END)
      ON CONFLICT (courier_id, unit_id) DO UPDATE SET
        balance = courier_cash.balance + v_delta,
        total_collected = courier_cash.total_collected + CASE WHEN v_delta > 0 THEN v_delta ELSE 0 END,
        total_handover = courier_cash.total_handover + CASE WHEN v_delta < 0 THEN ABS(v_delta) ELSE 0 END,
        hpp_pending = courier_cash.hpp_pending + CASE WHEN v_delta > 0 THEN v_hpp_delta ELSE 0 END,
        profit_pending = courier_cash.profit_pending + CASE WHEN v_delta > 0 THEN v_profit_delta ELSE 0 END
      RETURNING id, balance INTO v_cc_id, v_new_balance;
      RETURN v_new_balance;
    END;
    $$;`,
  },
  {
    name: 'process_courier_handover',
    sql: `CREATE OR REPLACE FUNCTION process_courier_handover(
      p_courier_id uuid, p_unit_id uuid, p_amount numeric, p_processed_by_id uuid, p_notes text DEFAULT NULL
    ) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
    DECLARE
      v_cc record;
      v_cash_box record;
      v_handover_id text;
      v_finance_request_id text;
      v_new_balance numeric;
      v_cb_balance numeric;
    BEGIN
      INSERT INTO courier_cash (id, courier_id, unit_id, balance, total_collected, total_handover)
      VALUES (gen_random_uuid()::text, p_courier_id, p_unit_id, 0, 0, 0)
      ON CONFLICT (courier_id, unit_id) DO NOTHING;
      SELECT * INTO v_cc FROM courier_cash WHERE courier_id = p_courier_id AND unit_id = p_unit_id;
      IF NOT FOUND THEN RAISE EXCEPTION 'Courier cash record not found'; END IF;
      IF v_cc.balance < p_amount THEN
        RAISE EXCEPTION 'Saldo cash kurir tidak cukup. Saldo: %, Diminta: %', v_cc.balance, p_amount;
      END IF;
      UPDATE courier_cash SET balance = balance - p_amount, total_handover = total_handover + p_amount
      WHERE id = v_cc.id RETURNING balance INTO v_new_balance;
      SELECT * INTO v_cash_box FROM cash_boxes WHERE unit_id = p_unit_id AND is_active = true LIMIT 1;
      IF NOT FOUND THEN
        INSERT INTO cash_boxes (id, name, unit_id, balance, is_active)
        VALUES (gen_random_uuid()::text, 'Brankas Utama', p_unit_id, 0, true)
        RETURNING * INTO v_cash_box;
      END IF;
      UPDATE cash_boxes SET balance = balance + p_amount WHERE id = v_cash_box.id RETURNING balance INTO v_cb_balance;
      v_finance_request_id := gen_random_uuid()::text;
      INSERT INTO finance_requests (id, type, amount, status, request_by_id, processed_by_id, description, processed_at)
      VALUES (v_finance_request_id, 'courier_deposit', p_amount, 'approved', p_processed_by_id, p_processed_by_id,
              CONCAT('Setoran kurir sebesar ', p_amount, COALESCE(' — ' || p_notes, '')), NOW());
      v_handover_id := gen_random_uuid()::text;
      INSERT INTO courier_handovers (id, courier_cash_id, amount, notes, status, finance_request_id, processed_by_id, processed_at)
      VALUES (v_handover_id, v_cc.id, p_amount, p_notes, 'processed', v_finance_request_id, p_processed_by_id, NOW());
      RETURN jsonb_build_object(
        'handover_id', v_handover_id,
        'finance_request_id', v_finance_request_id,
        'cash_box_id', v_cash_box.id,
        'new_balance', v_new_balance,
        'cash_box_balance', v_cb_balance
      );
    END;
    $$;`,
  },
  // === Cashback operations ===
  {
    name: 'atomic_add_cashback',
    sql: `CREATE OR REPLACE FUNCTION atomic_add_cashback(
      p_customer_id uuid, p_amount numeric DEFAULT 0, p_delta numeric DEFAULT 0
    ) RETURNS numeric LANGUAGE plpgsql SECURITY DEFINER AS $$
    DECLARE
      v_delta numeric := COALESCE(p_amount, 0) + COALESCE(p_delta, 0);
      v_new_balance numeric;
    BEGIN
      UPDATE customers SET cashback_balance = COALESCE(cashback_balance, 0) + v_delta
      WHERE id = p_customer_id
      RETURNING cashback_balance INTO v_new_balance;
      RETURN v_new_balance;
    END;
    $$;`,
  },
  {
    name: 'atomic_deduct_cashback',
    sql: `CREATE OR REPLACE FUNCTION atomic_deduct_cashback(
      p_customer_id uuid, p_amount numeric DEFAULT 0, p_delta numeric DEFAULT 0
    ) RETURNS numeric LANGUAGE plpgsql SECURITY DEFINER AS $$
    DECLARE
      v_delta numeric := COALESCE(p_amount, 0) + COALESCE(p_delta, 0);
      v_current numeric;
      v_new_balance numeric;
    BEGIN
      SELECT COALESCE(cashback_balance, 0) INTO v_current FROM customers WHERE id = p_customer_id;
      IF v_current < v_delta THEN RAISE EXCEPTION 'Cashback balance tidak mencukupi'; END IF;
      UPDATE customers SET cashback_balance = cashback_balance - v_delta
      WHERE id = p_customer_id RETURNING cashback_balance INTO v_new_balance;
      RETURN v_new_balance;
    END;
    $$;`,
  },
];

// ---------------------------------------------------------------------------
// Connection helpers
// ---------------------------------------------------------------------------

interface ConnectionCandidate {
  url: string;
  label: string;
}

function getConnectionCandidates(): ConnectionCandidate[] {
  const candidates: ConnectionCandidate[] = [];

  const directUrl = process.env.SUPABASE_DB_URL;
  if (directUrl) {
    candidates.push({ url: directUrl, label: 'direct (SUPABASE_DB_URL)' });
  }

  const poolerUrl = process.env.SUPABASE_POOLER_URL;
  if (poolerUrl) {
    // Session-mode pooler: same host, change port 6543 → 5432
    const sessionModeUrl = poolerUrl.replace(/:6543\//, ':5432/');
    if (sessionModeUrl !== poolerUrl) {
      candidates.push({ url: sessionModeUrl, label: 'session-mode pooler (port 5432)' });
    }
    // Transaction-mode pooler as last resort
    candidates.push({ url: poolerUrl, label: 'transaction-mode pooler (port 6543)' });
  }

  return candidates;
}

async function deployWithConnectionString(connString: string): Promise<{ deployed: number; failed: number }> {
  let deployed = 0;
  let failed = 0;

  const pool = new Pool({
    connectionString: connString,
    ssl: { rejectUnauthorized: false },
    max: 2,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 15_000,
  });

  const client = await pool.connect();
  try {
    for (const rpc of RPC_DEFINITIONS) {
      try {
        await client.query(rpc.sql);
        deployed++;
        console.log(`  ✓ ${rpc.name}`);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        failed++;
        console.error(`  ✗ ${rpc.name}: ${msg.substring(0, 120)}`);
      }
    }

    // Notify PostgREST to reload schema cache
    try {
      await client.query("NOTIFY pgrst, 'reload schema'");
      console.log('  ✓ PostgREST schema cache notified');
    } catch {
      console.warn('  ⚠ Could not notify PostgREST (non-critical)');
    }
  } finally {
    client.release();
    await pool.end();
  }

  return { deployed, failed };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('=== Supabase RPC Deployment ===\n');

  const candidates = getConnectionCandidates();

  if (candidates.length === 0) {
    console.error('ERROR: No database URL configured.');
    console.error('Set SUPABASE_DB_URL and/or SUPABASE_POOLER_URL in .env');
    process.exit(1);
  }

  console.log(`Deploying ${RPC_DEFINITIONS.length} RPC functions...\n`);

  let lastError: string | undefined;

  for (const { url, label } of candidates) {
    // Mask password in log output
    const safeUrl = url.replace(/\/\/([^:]+):([^@]+)@/, '//$1:****@/');
    console.log(`Trying ${label}...`);
    console.log(`  URL: ${safeUrl}`);

    try {
      const result = await deployWithConnectionString(url);
      console.log(`\nResult: ${result.deployed}/${RPC_DEFINITIONS.length} deployed${result.failed > 0 ? `, ${result.failed} failed` : ''}`);
      process.exit(result.failed > 0 ? 1 : 0);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      lastError = msg;
      console.error(`  Connection failed: ${msg.substring(0, 120)}\n`);
    }
  }

  console.error('All connection methods failed!');
  if (lastError) console.error(`Last error: ${lastError}`);
  process.exit(1);
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
