// =====================================================================
// SUPABASE CLIENT — Prisma-backed PostgreSQL Backend
//
// All database operations go through Prisma to local PostgreSQL:
//   .from()  → Prisma-backed PostgREST-compatible query builder
//   .rpc()   → Prisma-backed handlers (atomic operations)
//   .auth    → Supabase Auth (unchanged)
//   .storage → Supabase Storage (unchanged)
//
// Connection: Prisma → local PostgreSQL
//
// Exports:
//   db             — main query client (PostgREST-compatible via Prisma)
//   supabaseAdmin  — alias for db
//   prisma         — raw Prisma Client for complex queries
// =====================================================================

import { PrismaClient } from '@prisma/client';
import { supabaseRestClient } from './supabase-rest';
import { generateId } from './supabase-helpers';
import {
  snakeToModelName,
  parseSelectToInclude,
  parseOrFilter,
  prismaToSnakeCase,
  toCamelCaseDeep,
  snakeToCamel,
} from './supabase-prisma';

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
  //
  // BUG-28 FIX: Wrapped Steps 1-7 in prisma.$transaction with Serializable isolation level.
  // Previously these were 7 sequential Prisma operations without transaction wrapping,
  // meaning a failure after Step 3 (e.g., cash_box create fails) would leave the system
  // in an inconsistent state (courier cash deducted but brankas not credited).
  async process_courier_handover(params) {
    const { p_courier_id, p_unit_id, p_amount, p_processed_by_id, p_notes,
            p_hpp_portion, p_profit_portion } = params;
    try {
      const handoverId = generateId();
      const financeRequestId = generateId();

      // BUG-28 FIX: All steps wrapped in a single Serializable transaction
      const results = await prisma.$transaction(async (tx) => {
        // Step 1: Get or create courier_cash record
        const courierCash = await tx.courierCash.upsert({
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
          throw new Error(`Saldo cash kurir tidak cukup. Saldo: ${courierCash.balance}, Diminta: ${p_amount}`);
        }

        // Step 3: Deduct from courier cash balance
        const updatedCourierCash = await tx.courierCash.update({
          where: { id: courierCash.id },
          data: {
            balance: { decrement: p_amount },
            totalHandover: { increment: p_amount },
          },
        });

        // Step 4: Get or create brankas (cash_box) for the unit
        let cashBox = await tx.cashBox.findFirst({
          where: { unitId: p_unit_id, isActive: true },
        });
        if (!cashBox) {
          cashBox = await tx.cashBox.create({
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
        const updatedCashBox = await tx.cashBox.update({
          where: { id: cashBox.id },
          data: { balance: { increment: p_amount } },
        });

        // Step 6: Create finance_request (type: courier_deposit)
        await tx.financeRequest.create({
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
        await tx.courierHandover.create({
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

        return { updatedCourierCash, updatedCashBox, handoverId, financeRequestId, cashBox };
      }, { isolationLevel: 'Serializable' });

      // Step 8: Return results matching expected shape
      return {
        data: {
          handover_id: results.handoverId,
          finance_request_id: results.financeRequestId,
          cash_box_id: results.cashBox.id,
          new_balance: results.updatedCourierCash.balance,
          cash_box_balance: results.updatedCashBox.balance,
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
// PRISMA POSTGREST QUERY BUILDER
// ─────────────────────────────────────────────────────────────────────
// Immutable query builder that wraps Prisma to provide a PostgREST-compatible
// API. All 128+ API routes use db.from('table').select().eq() etc.
// and will work transparently with this Prisma implementation.
// ─────────────────────────────────────────────────────────────────────

// Helper: split string by commas respecting nested parentheses
function splitTopLevel(str: string): string[] {
  const result: string[] = [];
  let depth = 0;
  let current = '';
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch === '(') { depth++; current += ch; }
    else if (ch === ')') { depth--; current += ch; }
    else if (ch === ',' && depth === 0) { result.push(current.trim()); current = ''; }
    else { current += ch; }
  }
  if (current.trim()) result.push(current.trim());
  return result;
}

// Helper: try parsing an ISO date string to a Date object
function tryParseDate(value: any): any {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value)) {
    const d = new Date(value);
    if (!isNaN(d.getTime())) return d;
  }
  return value;
}

// Helper: recursively convert ISO date strings in an object to Date objects
function convertDatesDeep(obj: any): any {
  if (obj === null || obj === undefined || obj instanceof Date) return obj;
  if (Array.isArray(obj)) return obj.map(convertDatesDeep);
  if (typeof obj === 'object') {
    const result: Record<string, any> = {};
    for (const [k, v] of Object.entries(obj)) result[k] = convertDatesDeep(v);
    return result;
  }
  return tryParseDate(obj);
}

// ─────────────────────────────────────────────────────────────────────
// QUERY STATE (immutable — each method returns a new builder)
// ─────────────────────────────────────────────────────────────────────

type Operation = 'select' | 'insert' | 'update' | 'delete';

interface QueryState {
  tableName: string;
  modelName: string;
  operation: Operation;
  selectStr: string;
  countExact: boolean;
  head: boolean;
  whereConditions: Record<string, any>[];
  orGroups: any[][];
  orderBy: any[];
  limitVal: number | null;
  skipVal: number | null;
  takeVal: number | null;
  singleMode: boolean;
  maybeSingleMode: boolean;
  returnData: boolean; // .select() called after insert/update
  insertData: any;
  updateData: any;
}

function defaultState(tableName: string): QueryState {
  return {
    tableName,
    modelName: snakeToModelName(tableName),
    operation: 'select',
    selectStr: '*',
    countExact: false,
    head: false,
    whereConditions: [],
    orGroups: [],
    orderBy: [],
    limitVal: null,
    skipVal: null,
    takeVal: null,
    singleMode: false,
    maybeSingleMode: false,
    returnData: false,
    insertData: null,
    updateData: null,
  };
}

// ─────────────────────────────────────────────────────────────────────
// BUILD PRISMA WHERE CLAUSE from accumulated conditions
// ─────────────────────────────────────────────────────────────────────

function buildWhere(state: QueryState): Record<string, any> | undefined {
  const where: Record<string, any> = {};

  // Merge all where conditions (top-level = implicit AND)
  for (const cond of state.whereConditions) {
    for (const [key, val] of Object.entries(cond)) {
      if (where[key] !== undefined) {
        // Merge nested objects (shouldn't happen in practice)
        if (typeof where[key] === 'object' && typeof val === 'object') {
          where[key] = { ...where[key], ...val };
        } else {
          where[key] = val;
        }
      } else {
        where[key] = val;
      }
    }
  }

  // Add OR groups
  if (state.orGroups.length > 0) {
    where.OR = state.orGroups.map(group => {
      if (group.length === 1) return group[0];
      return { AND: group };
    });
  }

  return Object.keys(where).length > 0 ? where : undefined;
}

// ─────────────────────────────────────────────────────────────────────
// BUILD PRISMA SELECT/INCLUDE from PostgREST select string
// ─────────────────────────────────────────────────────────────────────

function buildSelectArgs(parsed: any): Record<string, any> {
  if (!parsed || parsed.type === 'all') return {};

  if (parsed.type === 'fields') {
    const select: Record<string, boolean> = {};
    for (const f of parsed.fields) select[snakeToCamel(f)] = true;
    return { select };
  }

  if (parsed.type === 'include') {
    // Mix of specific fields + includes → use select with relations nested inside
    if (parsed.select && parsed.select.length > 0) {
      const select: Record<string, any> = {};
      for (const f of parsed.select) select[snakeToCamel(f)] = true;
      for (const [k, v] of Object.entries(parsed.include)) select[k] = v;
      return { select };
    }
    // Only includes, no specific fields
    return { include: parsed.include };
  }

  return {};
}

// ─────────────────────────────────────────────────────────────────────
// PARSE OR FILTER VALUE (convert string values from PostgREST .or())
// ─────────────────────────────────────────────────────────────────────

function orValueToPrisma(operator: string, value: string): any {
  if (operator === 'is' && value === 'null') return null;
  return tryParseDate(value);
}

function orClauseToPrisma(clause: { field: string; operator: string; value: string }): Record<string, any> {
  const v = orValueToPrisma(clause.operator, clause.value);
  switch (clause.operator) {
    case 'eq': return { [clause.field]: v };
    case 'neq': return { [clause.field]: { not: v } };
    case 'gt': return { [clause.field]: { gt: v } };
    case 'gte': return { [clause.field]: { gte: v } };
    case 'lt': return { [clause.field]: { lt: v } };
    case 'lte': return { [clause.field]: { lte: v } };
    case 'is': return { [clause.field]: v };
    case 'like': {
      if (typeof v !== 'string') return { [clause.field]: v };
      if (v.endsWith('%') && v.startsWith('%')) return { [clause.field]: { contains: v.slice(1, -1) } };
      if (v.endsWith('%')) return { [clause.field]: { startsWith: v.slice(0, -1) } };
      if (v.startsWith('%')) return { [clause.field]: { endsWith: v.slice(1) } };
      return { [clause.field]: v };
    }
    case 'ilike': {
      if (typeof v !== 'string') return { [clause.field]: v };
      if (v.endsWith('%') && v.startsWith('%')) return { [clause.field]: { contains: v.slice(1, -1), mode: 'insensitive' } };
      if (v.endsWith('%')) return { [clause.field]: { startsWith: v.slice(0, -1), mode: 'insensitive' } };
      if (v.startsWith('%')) return { [clause.field]: { endsWith: v.slice(1), mode: 'insensitive' } };
      return { [clause.field]: { contains: v, mode: 'insensitive' } };
    }
    default: return { [clause.field]: v };
  }
}

// ─────────────────────────────────────────────────────────────────────
// PRISMA QUERY BUILDER CLASS
// ─────────────────────────────────────────────────────────────────────

class PrismaQueryBuilder {
  private _s: QueryState;
  private _promise: Promise<PostgrestResult> | null = null;

  constructor(state: QueryState) {
    this._s = state;
  }

  // ─── Immutable clone with overrides ────────────────────────────
  private _clone(overrides: Partial<QueryState>): PrismaQueryBuilder {
    return new PrismaQueryBuilder({ ...this._s, ...overrides });
  }

  // ─── Thenable interface (for await / Promise.all) ──────────────
  then<TResult1 = PostgrestResult, TResult2 = never>(
    onfulfilled?: ((value: PostgrestResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    if (!this._promise) this._promise = this._execute();
    return this._promise.then(onfulfilled, onrejected);
  }

  catch<TResult = never>(
    onrejected?: ((reason: any) => TResult | PromiseLike<TResult>) | null,
  ): Promise<PostgrestResult | TResult> {
    if (!this._promise) this._promise = this._execute();
    return this._promise.catch(onrejected);
  }

  // ─── SELECT ────────────────────────────────────────────────────
  select(columns?: string, options?: { count?: string; head?: boolean }): PrismaQueryBuilder {
    const isAfterMutation = this._s.operation !== 'select';
    return this._clone({
      operation: isAfterMutation ? this._s.operation : 'select',
      selectStr: columns || '*',
      countExact: options?.count === 'exact',
      head: options?.head === true,
      returnData: isAfterMutation,
    });
  }

  // ─── FILTERS ──────────────────────────────────────────────────
  eq(column: string, value: any): PrismaQueryBuilder {
    return this._clone({ whereConditions: [...this._s.whereConditions, { [snakeToCamel(column)]: tryParseDate(value) }] });
  }

  neq(column: string, value: any): PrismaQueryBuilder {
    return this._clone({ whereConditions: [...this._s.whereConditions, { [snakeToCamel(column)]: { not: tryParseDate(value) } }] });
  }

  gt(column: string, value: any): PrismaQueryBuilder {
    return this._clone({ whereConditions: [...this._s.whereConditions, { [snakeToCamel(column)]: { gt: tryParseDate(value) } }] });
  }

  gte(column: string, value: any): PrismaQueryBuilder {
    return this._clone({ whereConditions: [...this._s.whereConditions, { [snakeToCamel(column)]: { gte: tryParseDate(value) } }] });
  }

  lt(column: string, value: any): PrismaQueryBuilder {
    return this._clone({ whereConditions: [...this._s.whereConditions, { [snakeToCamel(column)]: { lt: tryParseDate(value) } }] });
  }

  lte(column: string, value: any): PrismaQueryBuilder {
    return this._clone({ whereConditions: [...this._s.whereConditions, { [snakeToCamel(column)]: { lte: tryParseDate(value) } }] });
  }

  in(column: string, values: any[]): PrismaQueryBuilder {
    return this._clone({ whereConditions: [...this._s.whereConditions, { [snakeToCamel(column)]: { in: values.map(tryParseDate) } }] });
  }

  is(column: string, value: any): PrismaQueryBuilder {
    if (value === null) {
      return this._clone({ whereConditions: [...this._s.whereConditions, { [snakeToCamel(column)]: null }] });
    }
    return this._clone({ whereConditions: [...this._s.whereConditions, { [snakeToCamel(column)]: tryParseDate(value) }] });
  }

  not(column: string, operator: string, value: any): PrismaQueryBuilder {
    const camelCol = snakeToCamel(column);
    if (operator === 'is' && value === null) {
      return this._clone({ whereConditions: [...this._s.whereConditions, { [camelCol]: { not: null } }] });
    }
    if (operator === 'eq') {
      return this._clone({ whereConditions: [...this._s.whereConditions, { [camelCol]: { not: tryParseDate(value) } }] });
    }
    if (operator === 'in') {
      return this._clone({ whereConditions: [...this._s.whereConditions, { [camelCol]: { notIn: (Array.isArray(value) ? value : [value]).map(tryParseDate) } }] });
    }
    // Fallback
    return this._clone({ whereConditions: [...this._s.whereConditions, { [camelCol]: { not: tryParseDate(value) } }] });
  }

  like(column: string, pattern: string): PrismaQueryBuilder {
    const camelCol = snakeToCamel(column);
    if (pattern.endsWith('%') && pattern.startsWith('%')) {
      return this._clone({ whereConditions: [...this._s.whereConditions, { [camelCol]: { contains: pattern.slice(1, -1) } }] });
    }
    if (pattern.endsWith('%')) {
      return this._clone({ whereConditions: [...this._s.whereConditions, { [camelCol]: { startsWith: pattern.slice(0, -1) } }] });
    }
    if (pattern.startsWith('%')) {
      return this._clone({ whereConditions: [...this._s.whereConditions, { [camelCol]: { endsWith: pattern.slice(1) } }] });
    }
    return this._clone({ whereConditions: [...this._s.whereConditions, { [camelCol]: pattern }] });
  }

  ilike(column: string, pattern: string): PrismaQueryBuilder {
    const camelCol = snakeToCamel(column);
    if (pattern.endsWith('%') && pattern.startsWith('%')) {
      return this._clone({ whereConditions: [...this._s.whereConditions, { [camelCol]: { contains: pattern.slice(1, -1), mode: 'insensitive' } }] });
    }
    if (pattern.endsWith('%')) {
      return this._clone({ whereConditions: [...this._s.whereConditions, { [camelCol]: { startsWith: pattern.slice(0, -1), mode: 'insensitive' } }] });
    }
    if (pattern.startsWith('%')) {
      return this._clone({ whereConditions: [...this._s.whereConditions, { [camelCol]: { endsWith: pattern.slice(1), mode: 'insensitive' } }] });
    }
    return this._clone({ whereConditions: [...this._s.whereConditions, { [camelCol]: { contains: pattern, mode: 'insensitive' } }] });
  }

  or(filterString: string): PrismaQueryBuilder {
    const groups = parseOrFilter(filterString);
    const prismaGroups = groups.map(group =>
      group.map(clause => orClauseToPrisma(clause))
    );
    return this._clone({ orGroups: [...this._s.orGroups, ...prismaGroups] });
  }

  // ─── ORDERING ──────────────────────────────────────────────────
  order(column: string, options?: { ascending?: boolean; nullsFirst?: boolean }): PrismaQueryBuilder {
    const camelCol = snakeToCamel(column);
    const ascending = options?.ascending !== false; // default true
    let orderEntry: any;
    if (options?.nullsFirst !== undefined) {
      orderEntry = { [camelCol]: { sort: ascending ? 'asc' : 'desc', nulls: options.nullsFirst ? 'first' : 'last' } };
    } else {
      orderEntry = { [camelCol]: ascending ? 'asc' : 'desc' };
    }
    return this._clone({ orderBy: [...this._s.orderBy, orderEntry] });
  }

  // ─── PAGINATION ────────────────────────────────────────────────
  limit(n: number): PrismaQueryBuilder {
    return this._clone({ takeVal: n });
  }

  range(from: number, to: number): PrismaQueryBuilder {
    return this._clone({ skipVal: from, takeVal: to - from + 1 });
  }

  // ─── SINGLE RESULT MODIFIERS ───────────────────────────────────
  single(): PrismaQueryBuilder {
    return this._clone({ singleMode: true });
  }

  maybeSingle(): PrismaQueryBuilder {
    return this._clone({ maybeSingleMode: true });
  }

  // ─── MUTATIONS ─────────────────────────────────────────────────
  insert(data: any): PrismaQueryBuilder {
    return this._clone({ operation: 'insert', insertData: data });
  }

  update(data: any): PrismaQueryBuilder {
    return this._clone({ operation: 'update', updateData: data });
  }

  delete(): PrismaQueryBuilder {
    return this._clone({ operation: 'delete' });
  }

  upsert(data: any): PrismaQueryBuilder {
    return this._clone({ operation: 'insert', insertData: data, returnData: true });
  }

  // ─────────────────────────────────────────────────────────────────
  // EXECUTE — build and run the Prisma query
  // ─────────────────────────────────────────────────────────────────

  private async _execute(): Promise<PostgrestResult> {
    const { operation, tableName, modelName } = this._s;
    const model = (prisma as any)[modelName];

    if (!model) {
      return { data: null, error: { message: `Prisma model "${modelName}" not found for table "${tableName}"`, code: 'PGRST116' } };
    }

    try {
      switch (operation) {
        case 'select': return this._execSelect(model);
        case 'insert': return this._execInsert(model);
        case 'update': return this._execUpdate(model);
        case 'delete': return this._execDelete(model);
        default: return { data: null, error: { message: 'Unknown operation', code: 'PGRST116' } };
      }
    } catch (error: any) {
      return { data: null, error: { message: error.message || String(error), code: 'PGRST116' } };
    }
  }

  // ─── SELECT execution ──────────────────────────────────────────
  private async _execSelect(model: any): Promise<PostgrestResult> {
    const where = buildWhere(this._s);
    const parsed = parseSelectToInclude(this._s.selectStr);

    // Count-only query (head: true)
    if (this._s.head && this._s.countExact) {
      const count = await model.count({ where });
      return { data: null, error: null, count, status: 200, statusText: 'OK' };
    }

    // Head without count (rare, just return empty)
    if (this._s.head) {
      return { data: null, error: null, status: 200, statusText: 'OK' };
    }

    // Build findMany args
    const args: Record<string, any> = {};
    if (where) args.where = where;
    const selectArgs = buildSelectArgs(parsed);
    Object.assign(args, selectArgs);

    if (this._s.orderBy.length > 0) args.orderBy = this._s.orderBy;
    if (this._s.takeVal !== null) args.take = this._s.takeVal;
    if (this._s.skipVal !== null) args.skip = this._s.skipVal;

    // .single() → use findFirst + validation
    if (this._s.singleMode || this._s.maybeSingleMode) {
      const row = await model.findFirst(args);
      if (!row) {
        if (this._s.singleMode) {
          return { data: null, error: { message: 'No rows returned', code: 'PGRST116' }, status: 406, statusText: 'Not Acceptable' };
        }
        return { data: null, error: null, count: 0, status: 200, statusText: 'OK' };
      }
      return { data: prismaToSnakeCase(row), error: null, status: 200, statusText: 'OK' };
    }

    // Regular findMany
    let rows = await model.findMany(args);

    // Also fetch count if requested
    let count: number | undefined;
    if (this._s.countExact) {
      count = await model.count({ where });
    }

    const result: PostgrestResult = {
      data: rows.length > 0 ? prismaToSnakeCase(rows) : rows,
      error: null,
      status: 200,
      statusText: 'OK',
    };
    if (count !== undefined) result.count = count;
    return result;
  }

  // ─── INSERT execution ──────────────────────────────────────────
  private async _execInsert(model: any): Promise<PostgrestResult> {
    const data = convertDatesDeep(toCamelCaseDeep(this._s.insertData));
    const isArray = Array.isArray(data);

    if (isArray) {
      // createMany doesn't return rows
      await model.createMany({ data });
      return { data: null, error: null, status: 201, statusText: 'Created' };
    }

    // Single insert
    if (this._s.returnData) {
      // Parse select for return shape
      const parsed = parseSelectToInclude(this._s.selectStr);
      const selectArgs = buildSelectArgs(parsed);
      const row = await model.create({ data, ...selectArgs });
      return { data: prismaToSnakeCase(row), error: null, status: 201, statusText: 'Created' };
    }

    await model.create({ data });
    return { data: null, error: null, status: 201, statusText: 'Created' };
  }

  // ─── UPDATE execution ──────────────────────────────────────────
  private async _execUpdate(model: any): Promise<PostgrestResult> {
    const data = convertDatesDeep(toCamelCaseDeep(this._s.updateData));
    const where = buildWhere(this._s);

    if (!where) {
      return { data: null, error: { message: 'Update requires at least one filter (e.g., .eq("id", val))', code: 'PGRST116' } };
    }

    if (this._s.returnData) {
      // Parse select for return shape
      const parsed = parseSelectToInclude(this._s.selectStr);
      const selectArgs = buildSelectArgs(parsed);
      const row = await model.updateFirst({ where, data, ...selectArgs });
      return { data: prismaToSnakeCase(row), error: null, status: 200, statusText: 'OK' };
    }

    await model.updateMany({ where, data });
    return { data: null, error: null, status: 200, statusText: 'OK' };
  }

  // ─── DELETE execution ──────────────────────────────────────────
  private async _execDelete(model: any): Promise<PostgrestResult> {
    const where = buildWhere(this._s);

    if (!where) {
      return { data: null, error: { message: 'Delete requires at least one filter', code: 'PGRST116' } };
    }

    await model.deleteMany({ where });
    return { data: null, error: null, status: 200, statusText: 'OK' };
  }
}

// ─────────────────────────────────────────────────────────────────────
// SUPABASE CLIENT OBJECT (Prisma-backed + Supabase Auth/Storage)
// ─────────────────────────────────────────────────────────────────────

/**
 * Main database client that uses Prisma for all .from() queries,
 * with local Prisma-backed RPC handlers for complex operations.
 *
 * Usage (all route via Prisma → local PostgreSQL):
 *   db.from('users').select('*')                    → Prisma findMany
 *   db.from('users').select('*').eq('id', '123')   → Prisma findFirst
 *   db.from('users').insert(data).select()          → Prisma create
 *   db.rpc('decrement_stock', { ... })              → local Prisma handler
 *   db.rpc('get_supabase_stats')                    → local Prisma handler
 *
 * Auth/Storage still use real Supabase:
 *   db.auth.signIn()   → Supabase Auth
 *   db.storage.from()  → Supabase Storage
 */
const supabaseClient = {
  /**
   * Start a query on a table.
   * Returns an immutable PostgREST-compatible query builder backed by Prisma.
   *
   * Supported chaining:
   *   .select().eq().neq().gt().gte().lt().lte().in().is().not()
   *   .ilike().like().or().order().limit().range().single().maybeSingle()
   *   .insert().update().delete().upsert()
   */
  from(tableName: string): PrismaQueryBuilder {
    return new PrismaQueryBuilder(defaultState(tableName));
  },

  /**
   * Call an RPC function.
   * Uses local Prisma-backed handlers (stock ops, balance ops, etc.).
   */
  async rpc(fnName: string, params: Record<string, any> = {}): Promise<PostgrestResult> {
    const handler = rpcHandlers[fnName];
    if (handler) {
      try {
        return await handler(params);
      } catch (error) {
        console.error(`[SupabaseClient] RPC "${fnName}" error:`, error);
        const msg = error instanceof Error ? error.message : String(error);
        return { data: null, error: { message: msg, code: 'PGRST116' } };
      }
    }

    // No handler found
    return { data: null, error: { message: `RPC function "${fnName}" not found`, code: 'PGRST116' } };
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
    return null;
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
