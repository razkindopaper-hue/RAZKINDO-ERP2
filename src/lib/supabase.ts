// =====================================================================
// SUPABASE CLIENT — Full Supabase PostgreSQL Backend
//
// All database operations go to Supabase PostgreSQL:
//   .from()  → Supabase PostgREST API (real-time queries)
//   .rpc()   → Prisma-backed handlers (connected to Supabase via PgBouncer)
//   .auth    → Supabase Auth
//   .storage → Supabase Storage
//
// Connection: PgBouncer (IPv4) → Supabase PostgreSQL (ap-southeast-1)
//
// Exports:
//   db             — main query client
//   supabaseAdmin  — alias for db
//   prisma         — raw Prisma Client for complex queries
// =====================================================================

import { PrismaClient } from '@prisma/client';
import { supabaseRestClient } from './supabase-rest';
import { generateId } from './supabase-helpers';

// ─────────────────────────────────────────────────────────────────────
// PRISMA CLIENT (singleton) — connects to Supabase via PgBouncer
// ─────────────────────────────────────────────────────────────────────
// CRITICAL FIX: System env may have DATABASE_URL=file:... (SQLite) which
// overrides the .env PostgreSQL URL. We must force Prisma to use the
// correct PostgreSQL URL via datasources override.
// ─────────────────────────────────────────────────────────────────────

// Read correct DB URL from .env file (system env may have SQLite override)
function getSupabaseDbUrl(): string {
  // Prefer DIRECT_URL (non-pooler, for direct Prisma queries)
  // then DATABASE_URL from .env (pooler), then whatever is in env
  const directUrl = process.env.DIRECT_URL;
  const envDbUrl = process.env.DATABASE_URL;

  // If DIRECT_URL is a valid PostgreSQL URL, use it
  if (directUrl && (directUrl.startsWith('postgresql://') || directUrl.startsWith('postgres://'))) {
    return directUrl;
  }
  // If DATABASE_URL is a valid PostgreSQL URL, use it
  if (envDbUrl && (envDbUrl.startsWith('postgresql://') || envDbUrl.startsWith('postgres://'))) {
    return envDbUrl;
  }
  // Fallback: try reading from .env file directly
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { join } = require('path');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { readFileSync } = require('fs');
    const envPath = join(process.cwd(), '.env');
    const envContent = readFileSync(envPath, 'utf8');
    for (const line of envContent.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('DIRECT_URL=') || trimmed.startsWith('DATABASE_URL=')) {
        const url = trimmed.split('=').slice(1).join('=');
        if (url.startsWith('postgresql://') || url.startsWith('postgres://')) {
          return url;
        }
      }
    }
  } catch { /* ignore */ }

  // Last resort: return whatever is there (will fail with clear error)
  return envDbUrl || '';
}

const supabaseDbUrl = getSupabaseDbUrl();

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient | undefined };
export const prisma = globalForPrisma.prisma || new PrismaClient({
  datasources: {
    db: {
      url: supabaseDbUrl,
    },
  },
});
if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

// ─────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────

export type PostgrestError = { message: string; code: string };
export type PostgrestResult<T = any> = { data: T | null; error: PostgrestError | null; count?: number; status?: number; statusText?: string };

// RPC IMPLEMENTATIONS
// ─────────────────────────────────────────────────────────────────────

type RpcFunction = (params: Record<string, any>) => Promise<PostgrestResult>;

const rpcHandlers: Record<string, RpcFunction> = {
  // ── Stock operations ──
  async decrement_stock(params) {
    const { p_product_id, p_qty } = params;
    try {
      const product = await prisma.product.findUnique({
        where: { id: p_product_id },
        select: { globalStock: true, name: true },
      });
      if (!product) {
        return { data: null, error: { message: `Produk tidak ditemukan: ${p_product_id}`, code: 'PGRST116' } };
      }
      if (product.globalStock < p_qty) {
        return { data: null, error: { message: `Stok tidak cukup untuk ${product.name}. Tersedia: ${product.globalStock}, Dibutuhkan: ${p_qty}`, code: 'PGRST116' } };
      }
      const updated = await prisma.product.update({
        where: { id: p_product_id },
        data: { globalStock: { decrement: p_qty } },
      });
      return { data: { new_stock: updated.globalStock }, error: null };
    } catch (error: any) {
      return { data: null, error: { message: error.message, code: 'PGRST116' } };
    }
  },

  async increment_stock(params) {
    const { p_product_id, p_qty } = params;
    try {
      await prisma.product.update({
        where: { id: p_product_id },
        data: { globalStock: { increment: p_qty } },
      });
      return { data: null, error: null };
    } catch (error: any) {
      return { data: null, error: { message: error.message, code: 'PGRST116' } };
    }
  },

  async increment_stock_with_hpp(params) {
    const { p_product_id, p_qty, p_new_hpp } = params;
    try {
      const product = await prisma.product.findUnique({
        where: { id: p_product_id },
        select: { globalStock: true, avgHpp: true },
      });
      if (!product) {
        return { data: null, error: { message: `Produk tidak ditemukan: ${p_product_id}`, code: 'PGRST116' } };
      }

      const currentStock = product.globalStock || 0;
      const currentHpp = product.avgHpp || 0;
      const newGlobalStock = currentStock + p_qty;

      let newAvgHpp = currentHpp;
      if (p_qty > 0 && p_new_hpp > 0) {
        newAvgHpp = (currentStock * currentHpp + p_qty * p_new_hpp) / newGlobalStock;
      }

      await prisma.product.update({
        where: { id: p_product_id },
        data: {
          globalStock: newGlobalStock,
          avgHpp: newAvgHpp,
        },
      });
      return { data: null, error: null };
    } catch (error: any) {
      return { data: null, error: { message: error.message, code: 'PGRST116' } };
    }
  },

  async decrement_unit_stock(params) {
    const { p_unit_product_id, p_qty } = params;
    try {
      const unitProduct = await prisma.unitProduct.findUnique({
        where: { id: p_unit_product_id },
        select: { stock: true },
      });
      if (!unitProduct) {
        return { data: null, error: { message: `Unit product tidak ditemukan: ${p_unit_product_id}`, code: 'PGRST116' } };
      }
      if (unitProduct.stock < p_qty) {
        return { data: null, error: { message: `Stok unit tidak cukup (unit_product_id: ${p_unit_product_id})`, code: 'PGRST116' } };
      }
      await prisma.unitProduct.update({
        where: { id: p_unit_product_id },
        data: { stock: { decrement: p_qty } },
      });
      return { data: null, error: null };
    } catch (error: any) {
      return { data: null, error: { message: error.message, code: 'PGRST116' } };
    }
  },

  async increment_unit_stock(params) {
    const { p_unit_product_id, p_qty } = params;
    try {
      await prisma.unitProduct.update({
        where: { id: p_unit_product_id },
        data: { stock: { increment: p_qty } },
      });
      return { data: null, error: null };
    } catch (error: any) {
      return { data: null, error: { message: error.message, code: 'PGRST116' } };
    }
  },

  async decrement_unit_stock_recalc(params) {
    const { p_unit_product_id, p_qty } = params;
    try {
      const unitProduct = await prisma.unitProduct.findUnique({
        where: { id: p_unit_product_id },
        select: { stock: true, productId: true },
      });
      if (!unitProduct) {
        return { data: null, error: { message: `Unit product tidak ditemukan: ${p_unit_product_id}`, code: 'PGRST116' } };
      }
      if (unitProduct.stock < p_qty) {
        return { data: null, error: { message: `Stok unit tidak cukup (unit_product_id: ${p_unit_product_id})`, code: 'PGRST116' } };
      }

      const newUnitStock = unitProduct.stock - p_qty;
      await prisma.unitProduct.update({
        where: { id: p_unit_product_id },
        data: { stock: newUnitStock },
      });

      // Recalculate global stock
      const aggregates = await prisma.unitProduct.aggregate({
        where: { productId: unitProduct.productId },
        _sum: { stock: true },
      });
      const newGlobalStock = aggregates._sum.stock || 0;
      await prisma.product.update({
        where: { id: unitProduct.productId },
        data: { globalStock: newGlobalStock },
      });

      return {
        data: {
          new_unit_stock: newUnitStock,
          new_global_stock: newGlobalStock,
          product_id: unitProduct.productId,
        },
        error: null,
      };
    } catch (error: any) {
      return { data: null, error: { message: error.message, code: 'PGRST116' } };
    }
  },

  async recalc_global_stock(params) {
    const { p_product_id } = params;
    try {
      const aggregates = await prisma.unitProduct.aggregate({
        where: { productId: p_product_id },
        _sum: { stock: true },
      });
      const total = aggregates._sum.stock || 0;
      await prisma.product.update({
        where: { id: p_product_id },
        data: { globalStock: total },
      });
      return { data: null, error: null };
    } catch (error: any) {
      return { data: null, error: { message: error.message, code: 'PGRST116' } };
    }
  },

  // FIX BUG-4: Wrap in prisma.$transaction with Serializable isolation to prevent race conditions
  async batch_decrement_centralized_stock(params) {
    const { p_product_ids, p_quantities } = params;
    try {
      const productIds: string[] = typeof p_product_ids === 'string' ? JSON.parse(p_product_ids) : p_product_ids;
      const quantities: number[] = typeof p_quantities === 'string' ? JSON.parse(p_quantities) : p_quantities;

      if (productIds.length !== quantities.length) {
        return { data: null, error: { message: 'product_ids and quantities arrays must have the same length', code: 'PGRST116' } };
      }

      const results = await prisma.$transaction(async (tx) => {
        // Read inside transaction to prevent dirty reads
        const products = await tx.product.findMany({
          where: { id: { in: productIds } },
          select: { id: true, globalStock: true, name: true },
        });
        const productMap = new Map(products.map(p => [p.id, p]));

        for (let i = 0; i < productIds.length; i++) {
          const product = productMap.get(productIds[i]);
          if (!product) {
            throw new Error(`Produk tidak ditemukan: ${productIds[i]}`);
          }
          if (product.globalStock < quantities[i]) {
            throw new Error(`Stok tidak cukup untuk ${product.name}. Tersedia: ${product.globalStock}, Dibutuhkan: ${quantities[i]}`);
          }
        }

        // Apply all deductions atomically
        const txResults: any[] = [];
        for (let i = 0; i < productIds.length; i++) {
          const updated = await tx.product.update({
            where: { id: productIds[i] },
            data: { globalStock: { decrement: quantities[i] } },
          });
          txResults.push({ product_id: productIds[i], new_stock: updated.globalStock });
        }
        return txResults;
      }, { isolationLevel: 'Serializable' });

      return { data: results, error: null };
    } catch (error: any) {
      return { data: null, error: { message: error.message, code: 'PGRST116' } };
    }
  },

  // ── Balance operations ──
  async atomic_update_balance(params) {
    const { p_table, p_id, p_delta, p_min } = params;
    try {
      if (p_table !== 'cash_boxes' && p_table !== 'bank_accounts') {
        return { data: null, error: { message: `Unsupported table: ${p_table}`, code: 'PGRST116' } };
      }

      const model: any = p_table === 'cash_boxes' ? prisma.cashBox : prisma.bankAccount;
      const record = await model.findUnique({
        where: { id: p_id },
        select: { balance: true },
      });

      if (!record) {
        return { data: null, error: { message: 'Record not found', code: 'PGRST116' } };
      }

      const newBalance = (record.balance || 0) + p_delta;
      if (newBalance < (p_min || 0)) {
        return { data: null, error: { message: 'Insufficient balance or record not found', code: 'PGRST116' } };
      }

      const updated = await model.update({
        where: { id: p_id },
        data: { balance: newBalance },
      });

      return { data: updated.balance, error: null };
    } catch (error: any) {
      return { data: null, error: { message: error.message, code: 'PGRST116' } };
    }
  },

  async atomic_update_setting_balance(params) {
    const { p_key, p_delta, p_min } = params;
    try {
      const setting = await prisma.setting.findUnique({
        where: { key: p_key },
        select: { value: true },
      });

      let current = 0;
      if (setting?.value) {
        try {
          current = parseFloat(setting.value);
        } catch {
          try {
            current = parseFloat(JSON.parse(setting.value));
          } catch {
            current = 0;
          }
        }
      }

      const newBalance = current + p_delta;
      if (newBalance < (p_min || 0)) {
        return { data: null, error: { message: `Insufficient pool balance. Current: ${current}, Attempted change: ${p_delta}`, code: 'PGRST116' } };
      }

      await prisma.setting.upsert({
        where: { key: p_key },
        create: { key: p_key, value: String(newBalance) },
        update: { value: String(newBalance) },
      });

      return { data: newBalance, error: null };
    } catch (error: any) {
      return { data: null, error: { message: error.message, code: 'PGRST116' } };
    }
  },

  // ── Courier cash operations ──
  // BUG FIX: Accept both p_amount (used by API routes) and p_delta (legacy).
  // Also auto-creates courier_cash record if not exists (upsert pattern).
  // When courier collects cash: pass p_hpp_delta / p_profit_delta to track
  // HPP/profit portions that are still held by courier (not yet in brankas).
  async atomic_add_courier_cash(params) {
    const { p_courier_id, p_unit_id, p_amount, p_delta, p_hpp_delta, p_profit_delta } = params;
    const delta = p_amount ?? p_delta ?? 0;
    if (!p_courier_id || !p_unit_id) {
      return { data: null, error: { message: 'courier_id dan unit_id wajib diisi', code: 'PGRST116' } };
    }
    try {
      // When courier collects cash (positive delta), track HPP/profit portions
      const hppDelta = delta > 0 ? (p_hpp_delta || 0) : 0;
      const profitDelta = delta > 0 ? (p_profit_delta || 0) : 0;

      // Upsert: get or create courier_cash record
      const courierCash = await prisma.courierCash.upsert({
        where: { courierId_unitId: { courierId: p_courier_id, unitId: p_unit_id } },
        create: {
          id: generateId(),
          courierId: p_courier_id,
          unitId: p_unit_id,
          balance: delta,
          totalCollected: delta > 0 ? delta : 0,
          totalHandover: delta < 0 ? Math.abs(delta) : 0,
          hppPending: hppDelta,
          profitPending: profitDelta,
        },
        update: {
          balance: { increment: delta },
          totalCollected: delta > 0 ? { increment: delta } : undefined,
          totalHandover: delta < 0 ? { increment: Math.abs(delta) } : undefined,
          hppPending: hppDelta !== 0 ? { increment: hppDelta } : undefined,
          profitPending: profitDelta !== 0 ? { increment: profitDelta } : undefined,
        },
      });
      return { data: courierCash.balance, error: null };
    } catch (error: any) {
      return { data: null, error: { message: error.message, code: 'PGRST116' } };
    }
  },

  // ── Cashback operations ──
  // BUG FIX: Accept both p_amount (used by API routes) and p_delta (legacy).
  async atomic_add_cashback(params) {
    const { p_customer_id, p_amount, p_delta } = params;
    const delta = p_amount ?? p_delta ?? 0;
    try {
      const updated = await prisma.customer.update({
        where: { id: p_customer_id },
        data: { cashbackBalance: { increment: delta } },
      });
      return { data: updated.cashbackBalance, error: null };
    } catch (error: any) {
      return { data: null, error: { message: error.message, code: 'PGRST116' } };
    }
  },

  async atomic_deduct_cashback(params) {
    const { p_customer_id, p_delta } = params;
    try {
      const customer = await prisma.customer.findUnique({
        where: { id: p_customer_id },
        select: { cashbackBalance: true },
      });

      if (!customer || (customer.cashbackBalance || 0) < p_delta) {
        return { data: null, error: { message: 'Cashback balance tidak mencukupi', code: 'PGRST116' } };
      }

      const updated = await prisma.customer.update({
        where: { id: p_customer_id },
        data: { cashbackBalance: { decrement: p_delta } },
      });
      return { data: updated.cashbackBalance, error: null };
    } catch (error: any) {
      return { data: null, error: { message: error.message, code: 'PGRST116' } };
    }
  },

  // ── Customer stats ──
  async atomic_increment_customer_stats(params) {
    const { p_customer_id, p_order_delta, p_spent_delta } = params;
    try {
      const customer = await prisma.customer.findUnique({
        where: { id: p_customer_id },
        select: { totalOrders: true, totalSpent: true, lastTransactionDate: true },
      });

      if (!customer) {
        return { data: null, error: { message: 'Customer not found', code: 'PGRST116' } };
      }

      const now = new Date();
      const lastTx = customer.lastTransactionDate;
      const updatedLastTx = lastTx
        ? (now > lastTx ? now : lastTx)
        : now;

      await prisma.customer.update({
        where: { id: p_customer_id },
        data: {
          totalOrders: (customer.totalOrders || 0) + (p_order_delta || 0),
          totalSpent: (customer.totalSpent || 0) + (p_spent_delta || 0),
          lastTransactionDate: updatedLastTx,
        },
      });

      return { data: null, error: null };
    } catch (error: any) {
      return { data: null, error: { message: error.message, code: 'PGRST116' } };
    }
  },

  // ── Courier handover ──
  // BUG FIX: Complete rewrite. The old implementation expected { p_handover_id, p_status, p_processed_by_id }
  // (for updating an existing handover's status), but the API route sends:
  // { p_courier_id, p_unit_id, p_amount, p_processed_by_id, p_notes }
  // to CREATE a new handover atomically (deduct courier cash → credit brankas → create records).
  async process_courier_handover(params) {
    const { p_courier_id, p_unit_id, p_amount, p_processed_by_id, p_notes } = params;
    try {
      // Step 1: Get or create courier_cash record
      const courierCash = await prisma.courierCash.upsert({
        where: { courierId_unitId: { courierId: p_courier_id, unitId: p_unit_id } },
        create: {
          id: generateId(),
          courierId: p_courier_id,
          unitId: p_unit_id,
          balance: 0,
          totalCollected: 0,
          totalHandover: 0,
        },
        update: {},
      });

      // Step 2: Validate sufficient balance
      if ((courierCash.balance || 0) < p_amount) {
        return {
          data: null,
          error: { message: `Saldo cash kurir tidak cukup. Saldo: ${courierCash.balance}, Diminta: ${p_amount}`, code: 'PGRST116' },
        };
      }

      // Step 3: Deduct from courier cash balance
      const updatedCourierCash = await prisma.courierCash.update({
        where: { id: courierCash.id },
        data: {
          balance: { decrement: p_amount },
          totalHandover: { increment: p_amount },
        },
      });

      // Step 4: Get or create brankas (cash_box) for the unit
      let cashBox = await prisma.cashBox.findFirst({
        where: { unitId: p_unit_id, isActive: true },
      });
      if (!cashBox) {
        cashBox = await prisma.cashBox.create({
          data: {
            id: generateId(),
            name: 'Brankas Utama',
            unitId: p_unit_id,
            balance: 0,
            isActive: true,
          },
        });
      }

      // Step 5: Credit brankas balance
      const updatedCashBox = await prisma.cashBox.update({
        where: { id: cashBox.id },
        data: { balance: { increment: p_amount } },
      });

      // Step 6: Create finance_request (type: courier_deposit)
      const financeRequestId = generateId();
      await prisma.financeRequest.create({
        data: {
          id: financeRequestId,
          type: 'courier_deposit',
          amount: p_amount,
          status: 'approved',
          requestById: p_processed_by_id,
          processedById: p_processed_by_id,
          description: `Setoran kurir sebesar ${p_amount}${p_notes ? ` — ${p_notes}` : ''}`,
          processedAt: new Date(),
        },
      });

      // Step 7: Create courier_handover record
      const handoverId = generateId();
      await prisma.courierHandover.create({
        data: {
          id: handoverId,
          courierCashId: courierCash.id,
          amount: p_amount,
          notes: p_notes || null,
          status: 'processed',
          financeRequestId: financeRequestId,
          processedById: p_processed_by_id,
          processedAt: new Date(),
        },
      });

      // Step 8: Return results matching expected shape
      return {
        data: {
          handover_id: handoverId,
          finance_request_id: financeRequestId,
          cash_box_id: cashBox.id,
          new_balance: updatedCourierCash.balance,
          cash_box_balance: updatedCashBox.balance,
        },
        error: null,
      };
    } catch (error: any) {
      return { data: null, error: { message: error.message, code: 'PGRST116' } };
    }
  },

  // ── Aggregate queries ──
  async get_courier_cash_totals(params) {
    try {
      const { p_courier_id, p_unit_id } = params || {};
      const whereClause: any = {};
      if (p_courier_id) whereClause.courierId = p_courier_id;
      if (p_unit_id) whereClause.unitId = p_unit_id;

      const aggregates = await prisma.courierCash.aggregate({
        where: Object.keys(whereClause).length > 0 ? whereClause : undefined,
        _sum: {
          balance: true,
          totalCollected: true,
          totalHandover: true,
        },
      });

      return {
        data: {
          total_balance: aggregates._sum.balance || 0,
          total_collected: aggregates._sum.totalCollected || 0,
          total_handover: aggregates._sum.totalHandover || 0,
        },
        error: null,
      };
    } catch (error: any) {
      return { data: null, error: { message: error.message, code: 'PGRST116' } };
    }
  },

  async get_payment_pool_sums(_params) {
    try {
      // =====================================================================
      // GROUND TRUTH CALCULATION for pool balances.
      //
      // Pool inflows come from TWO sources:
      //   1. Direct sale payments to brankas/bank (payments with cashBoxId/bankAccountId)
      //   2. Courier handovers (setor ke brankas) — money collected by couriers
      //      then deposited to brankas. These update pool via atomicUpdatePoolBalance
      //      but are NOT recorded in the payments table with cashBoxId/bankAccountId.
      //
      // Pool outflows come from finance_requests processed as "pay_now" (not debt):
      //   - Purchases, expenses, salaries paid from hpp_paid or profit_unpaid pools
      //
      // Previous implementation only counted source #1, causing sync to zero out
      // balances when most payments go through couriers first.
      // =====================================================================

      // Inflow #1: Direct payments to brankas/bank
      const directPayments = await prisma.payment.aggregate({
        _sum: {
          hppPortion: true,
          profitPortion: true,
        },
        where: {
          transaction: {
            type: 'sale',
          },
          OR: [
            { cashBoxId: { not: null } },
            { bankAccountId: { not: null } },
          ],
        },
      });

      // Inflow #2: Courier handovers (setor ke brankas)
      // These have hpp_portion and profit_portion tracked in courier_handovers table
      const handovers = await prisma.courierHandover.aggregate({
        _sum: {
          hppPortion: true,
          profitPortion: true,
          amount: true,
        },
        where: {
          status: 'processed',
        },
      });

      // Outflow: Finance requests that deducted from pool balances
      // These are processed requests paid from hpp_paid or profit_unpaid pools (not debt)
      const hppDeductions = await prisma.financeRequest.aggregate({
        _sum: {
          amount: true,
        },
        where: {
          status: 'processed',
          fundSource: 'hpp_paid',
          paymentType: 'pay_now',
        },
      });

      const profitDeductions = await prisma.financeRequest.aggregate({
        _sum: {
          amount: true,
        },
        where: {
          status: 'processed',
          fundSource: 'profit_unpaid',
          paymentType: 'pay_now',
        },
      });

      // Also deduct salary payments from pools
      // Salaries use finance_requests with type='salary' and fundSource
      // They are already included in the financeRequest aggregate above

      const directHpp = directPayments._sum.hppPortion || 0;
      const directProfit = directPayments._sum.profitPortion || 0;
      const handoverHpp = handovers._sum.hppPortion || 0;
      const handoverProfit = handovers._sum.profitPortion || 0;
      const handoverTotal = handovers._sum.amount || 0;
      const hppDeducted = hppDeductions._sum.amount || 0;
      const profitDeducted = profitDeductions._sum.amount || 0;

      // Net pool balance = inflows - outflows
      const hppPaidTotal = Math.round(directHpp + handoverHpp - hppDeducted);
      const profitPaidTotal = Math.round(directProfit + handoverProfit - profitDeducted);

      return {
        data: {
          hppPaidTotal,
          profitPaidTotal,
          totalPaid: hppPaidTotal + profitPaidTotal,
          // Breakdown for debugging/transparency
          directHpp,
          directProfit,
          handoverHpp,
          handoverProfit,
          handoverTotal,
          hppDeducted,
          profitDeducted,
        },
        error: null,
      };
    } catch (error: any) {
      return { data: null, error: { message: error.message, code: 'PGRST116' } };
    }
  },

  async get_low_stock_count(params) {
    try {
      const { p_unit_id } = params || {};
      let count: number;

      if (p_unit_id) {
        // Count products where per_unit stock is low for this unit
        count = await prisma.unitProduct.count({
          where: {
            unitId: p_unit_id,
            stock: { lte: 0 },
          },
        });
      } else {
        // Count products with low global stock
        count = await prisma.product.count({
          where: {
            globalStock: { lte: 0 },
            trackStock: true,
            isActive: true,
          },
        });
      }

      return { data: count, error: null };
    } catch (error: any) {
      return { data: null, error: { message: error.message, code: 'PGRST116' } };
    }
  },

  async get_supabase_stats(_params) {
    try {
      const [users, transactions, products, customers, units] = await Promise.all([
        prisma.user.count(),
        prisma.transaction.count(),
        prisma.product.count(),
        prisma.customer.count(),
        prisma.unit.count(),
      ]);

      return {
        data: {
          users,
          transactions,
          products,
          customers,
          units,
          db_size_bytes: 0,
        },
        error: null,
      };
    } catch (error: any) {
      return { data: null, error: { message: error.message, code: 'PGRST116' } };
    }
  },
};

// ─────────────────────────────────────────────────────────────────────
// SUPABASE CLIENT OBJECT (real Supabase + local RPC overlay)
// ─────────────────────────────────────────────────────────────────────

/**
 * Main database client that uses the real Supabase REST API for queries,
 * with local Prisma-backed RPC handlers for complex operations.
 *
 * Usage:
 *   db.from('users').select('*')                    → real Supabase REST
 *   db.from('users').select('*').eq('id', '123')   → real Supabase REST
 *   db.from('users').insert(data).select()          → real Supabase REST
 *   db.rpc('decrement_stock', { ... })              → local Prisma handler
 *   db.rpc('get_supabase_stats')                    → real Supabase RPC (fallback)
 */
const supabaseClient = {
  /**
   * Start a query on a table.
   * Delegates to the real Supabase REST API client.
   * Returns the native PostgREST query builder with full chaining support:
   *   .select().eq().neq().gt().gte().lt().lte().in().is().not()
   *   .ilike().like().or().order().limit().range().single().maybeSingle()
   *   .insert().update().delete().upsert()
   */
  from(tableName: string) {
    return supabaseRestClient.from(tableName);
  },

  /**
   * Call an RPC function.
   * First checks local Prisma-backed handlers (for stock ops, etc.).
   * Falls back to the real Supabase RPC for unregistered functions
   * (e.g., get_supabase_stats, database functions).
   */
  async rpc(fnName: string, params: Record<string, any> = {}): Promise<PostgrestResult> {
    // Try local Prisma-backed handler first
    const handler = rpcHandlers[fnName];
    if (handler) {
      try {
        return await handler(params);
      } catch (error) {
        console.error(`[SupabaseClient] Local RPC "${fnName}" error:`, error);
        const msg = error instanceof Error ? error.message : String(error);
        return { data: null, error: { message: msg, code: 'PGRST116' } };
      }
    }

    // Fallback: call real Supabase RPC function
    try {
      const result = await supabaseRestClient.rpc(fnName as any, params as any);
      return {
        data: result.data,
        error: result.error ? { message: result.error.message, code: String(result.error.code) } : null,
        count: (result as any).count,
        status: result.status,
        statusText: result.statusText,
      };
    } catch (error) {
      console.error(`[SupabaseClient] RPC "${fnName}" error (remote):`, error);
      const msg = error instanceof Error ? error.message : String(error);
      return { data: null, error: { message: msg, code: 'PGRST116' } };
    }
  },

  // ─── Real Supabase Auth ───────────────────────────────────────────
  auth: supabaseRestClient.auth,

  // ─── Real Supabase Storage ────────────────────────────────────────
  storage: supabaseRestClient.storage,

  // ─── Realtime ─────────────────────────────────────────────────────
  channel: (...args: any[]): any => supabaseRestClient.channel(...(args as [any])),
  removeChannel: (...args: any[]): any => supabaseRestClient.removeChannel(...(args as [any])),
  removeAllChannels: (): any => supabaseRestClient.removeAllChannels(),

  // ─── Table name helper for testing ────────────────────────────────
  get tableNameMap() {
    return null; // Not needed externally
  },
};

/**
 * Server-side admin client with full access.
 * Identical to `db` — provided for backward compatibility.
 */
export const supabaseAdmin = supabaseClient;

/**
 * Main database client.
 * Import this in all API routes: `import { db } from '@/lib/supabase'`
 */
export const db = supabaseClient;

// ─────────────────────────────────────────────────────────────────────
// RE-EXPORT TYPES
// ─────────────────────────────────────────────────────────────────────

// prisma is exported above as const
