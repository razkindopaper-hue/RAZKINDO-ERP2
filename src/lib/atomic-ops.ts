// =====================================================================
// ATOMIC OPS — Server-side helpers for atomic financial operations.
// Each function wraps a PostgreSQL RPC that runs inside a single
// statement, preventing race conditions on concurrent requests.
// =====================================================================

import { db } from '@/lib/supabase';

/**
 * Atomically update a cash box or bank account balance.
 * Throws if balance would go below minBalance (default 0).
 * Returns the new balance.
 */
export async function atomicUpdateBalance(
  table: 'cash_boxes' | 'bank_accounts',
  id: string,
  delta: number,
  minBalance = 0,
): Promise<number> {
  const { data, error } = await db.rpc('atomic_update_balance', {
    p_table: table,
    p_id: id,
    p_delta: delta,
    p_min: minBalance,
  });
  if (error) {
    const label = table === 'cash_boxes' ? 'Brankas' : 'Akun bank';
    const msg = error.message.toLowerCase();
    if (msg.includes('insufficient') || msg.includes('below minimum')) {
      throw new Error(`Saldo ${label} tidak mencukupi`);
    }
    if (msg.includes('not found') || msg.includes('no row')) {
      throw new Error(`${label} tidak ditemukan`);
    }
    throw new Error(error.message);
  }
  return Number(data) || 0;
}

/**
 * Atomically update a pool balance setting.
 * Settings are stored as JSON stringified numbers.
 * Throws if balance would go below minBalance (default 0).
 * Returns the new balance.
 */
export async function atomicUpdatePoolBalance(
  key: string,
  delta: number,
  minBalance = 0,
): Promise<number> {
  const { data, error } = await db.rpc('atomic_update_setting_balance', {
    p_key: key,
    p_delta: delta,
    p_min: minBalance,
  });
  if (error) {
    const msg = error.message.toLowerCase();
    if (msg.includes('insufficient') || msg.includes('below minimum')) {
      throw new Error('Saldo pool tidak mencukupi');
    }
    if (msg.includes('not found') || msg.includes('no row')) {
      throw new Error('Pool balance tidak ditemukan');
    }
    throw new Error(error.message);
  }
  return Number(data) || 0;
}

/**
 * Get a pool balance from settings table.
 * Settings are stored as JSON stringified numbers.
 */
export async function getPoolBalance(key: string): Promise<number> {
  const { data } = await db
    .from('settings')
    .select('value')
    .eq('key', key)
    .maybeSingle();
  if (!data) return 0;
  try {
    return parseFloat(JSON.parse(data.value)) || 0;
  } catch {
    return 0;
  }
}

/**
 * Atomically deduct stock (wraps the existing decrement_stock RPC).
 * If the RPC is later updated to accept p_unit_id and return
 * { new_stock, new_unit_stock }, this wrapper will automatically
 * surface those values.
 */
export async function atomicDecrementStock(
  productId: string,
  qty: number,
  unitId?: string,
): Promise<{ newStock: number; newUnitStock: number }> {
  const params: Record<string, unknown> = {
    p_product_id: productId,
    p_qty: qty,
  };
  // Only pass p_unit_id if the caller provided one
  if (unitId) {
    params.p_unit_id = unitId;
  }

  const { data, error } = await db.rpc('decrement_stock', params);
  if (error) throw new Error(error.message);
  return { newStock: data?.new_stock ?? 0, newUnitStock: data?.new_unit_stock ?? 0 };
}
