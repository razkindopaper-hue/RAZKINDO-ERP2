import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/supabase';
import { toCamelCase, createLog, createEvent } from '@/lib/supabase-helpers';
import { enforceSuperAdmin } from '@/lib/require-auth';
import { wsTransactionUpdate } from '@/lib/ws-dispatch';
import { atomicUpdateBalance, atomicUpdatePoolBalance } from '@/lib/atomic-ops';

const CANCEL_MIN_BALANCE = -999999999999999;

// BUG-7 FIX: Compensation log for manual recovery when cancel steps fail mid-way.
// Since this uses Supabase REST client (not Prisma directly), we cannot wrap
// in a real DB transaction. Instead, we track which steps have completed and
// log inconsistencies for manual review if a later step fails.
type CancelStepName = 'stock_restore' | 'receivable_cancel' | 'payment_reverse' | 'pool_reverse' | 'courier_cash_reverse' | 'payment_delete' | 'customer_stats_reverse' | 'cashback_reverse' | 'transaction_update';
interface CancelCompensationRecord {
  transactionId: string;
  invoiceNo: string;
  completedSteps: CancelStepName[];
  failedStep: string | null;
  error: string;
  timestamp: string;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    // Only super_admin can cancel/delete transactions
    const authResult = await enforceSuperAdmin(request);
    if (!authResult.success) return authResult.response;

    const { id } = await params;
    
    const { data: transaction } = await db
      .from('transactions')
      .select('*')
      .eq('id', id)
      .single();

    if (!transaction) {
      return NextResponse.json(
        { error: 'Transaksi tidak ditemukan' },
        { status: 404 }
      );
    }

    const txCamel = toCamelCase(transaction);

    if (txCamel.status === 'cancelled') {
      return NextResponse.json(
        { error: 'Transaksi sudah dibatalkan' },
        { status: 400 }
      );
    }

    // BUG-7 FIX: Track completed steps for compensation logging.
    // Since Supabase REST client doesn't support DB transactions,
    // we log each completed step. If a later step fails, we record
    // which steps completed so manual recovery is possible.
    const completedSteps: CancelStepName[] = [];
    let compensationLog: CancelCompensationRecord | null = null;

    function recordCompensationFailure(stepName: string, error: string) {
      compensationLog = {
        transactionId: id,
        invoiceNo: txCamel.invoiceNo || id,
        completedSteps: [...completedSteps],
        failedStep: stepName,
        error,
        timestamp: new Date().toISOString(),
      };
      console.error(
        `[CANCEL][COMPENSATION] Transaction ${txCamel.invoiceNo}: step "${stepName}" failed. ` +
        `Completed steps: [${completedSteps.join(', ')}]. ` +
        `Manual review may be required. Error: ${error}`
      );
    }

    // Sequential operations (no DB transactions via Supabase REST — compensation logging used instead)
    if (txCamel.status === 'approved' || txCamel.status === 'paid') {
      // Get transaction items
      const { data: items } = await db
        .from('transaction_items')
        .select('*')
        .eq('transaction_id', id);

      // Restore stock for sale/cancel stock for purchase
      // OPTIMIZATION: Batch-fetch all products before the loop (eliminates N+1)
      const allItemProductIds = [...new Set((items || []).map((i: any) => (toCamelCase(i) || {}).productId).filter(Boolean))];
      const { data: cancelProductsBatch } = await db
        .from('products')
        .select('*, unit_products:unit_products(*)')
        .in('id', allItemProductIds);
      const cancelProductLookup = new Map((cancelProductsBatch || []).map((p: any) => [p.id, p]));

      try {
      for (const item of (items || [])) {
        const itemCamel = toCamelCase(item);
        const stockQty = itemCamel.qtyInSubUnit ?? itemCamel.qty;
        
        if (txCamel.type === 'sale') {
          const product = cancelProductLookup.get(itemCamel.productId);
          if (!product) continue;
          
          if (product.stock_type === 'per_unit') {
            const { data: unitProduct } = await db
              .from('unit_products')
              .select('*')
              .eq('unit_id', txCamel.unitId)
              .eq('product_id', itemCamel.productId)
              .maybeSingle();
            
            if (unitProduct) {
              // Use atomic RPC for stock restoration
              const { error: rpcError } = await db.rpc('increment_unit_stock', {
                p_unit_product_id: unitProduct.id,
                p_qty: stockQty,
              });
              if (rpcError) {
                console.error('[CANCEL] Failed to increment unit stock via RPC, falling back:', rpcError.message);
                await db
                  .from('unit_products')
                  .update({ stock: unitProduct.stock + stockQty })
                  .eq('id', unitProduct.id);
              }
              // Recalculate global stock
              await db.rpc('recalc_global_stock', { p_product_id: itemCamel.productId });
            } else {
              const { error: rpcError } = await db.rpc('increment_stock', {
                p_product_id: itemCamel.productId,
                p_qty: stockQty,
              });
              if (rpcError) {
                await db
                  .from('products')
                  .update({ global_stock: product.global_stock + stockQty })
                  .eq('id', itemCamel.productId);
              }
            }
          } else {
            // Use atomic RPC for centralized stock restoration
            const { error: rpcError } = await db.rpc('increment_stock', {
              p_product_id: itemCamel.productId,
              p_qty: stockQty,
            });
            if (rpcError) {
              await db
                .from('products')
                .update({ global_stock: product.global_stock + stockQty })
                .eq('id', itemCamel.productId);
            }
          }
        } else if (txCamel.type === 'purchase') {
          const product = cancelProductLookup.get(itemCamel.productId);
          if (product) {
            if (product.stock_type === 'per_unit') {
              const { data: unitProduct } = await db
                .from('unit_products')
                .select('*')
                .eq('unit_id', txCamel.unitId)
                .eq('product_id', itemCamel.productId)
                .maybeSingle();
              if (unitProduct) {
                await db
                  .from('unit_products')
                  .update({ stock: Math.max(0, unitProduct.stock - stockQty) })
                  .eq('id', unitProduct.id);
              }
              const { data: allUnitProducts } = await db
                .from('unit_products')
                .select('stock')
                .eq('product_id', itemCamel.productId);
              const newGlobalStock = (allUnitProducts || []).reduce((sum: number, up: any) => sum + (up.stock || 0), 0);
              // Reverse weighted average HPP for per_unit products
              const oldGlobalStock = Number(product.global_stock) || 0;
              const oldAvgHpp = Number(product.avg_hpp) || 0;
              let newAvgHpp = oldAvgHpp;
              if (newGlobalStock > 0 && oldGlobalStock > 0) {
                const totalValueBefore = oldGlobalStock * oldAvgHpp;
                // BUG-11 FIX: Use ONLY itemCamel.hpp for purchase HPP reversal.
                // Never fall back to itemCamel.price (that's the selling price, not cost).
                const itemCostPerUnit = Number(itemCamel.hpp) || 0;
                const removedValue = stockQty * itemCostPerUnit;
                if (removedValue > 0) {
                  newAvgHpp = Math.max(0, (totalValueBefore - removedValue) / newGlobalStock);
                }
              } else if (newGlobalStock <= 0) {
                newAvgHpp = 0;
              }
              await db
                .from('products')
                .update({ global_stock: newGlobalStock, avg_hpp: newAvgHpp })
                .eq('id', itemCamel.productId);
            } else {
              const oldGlobalStock = Number(product.global_stock) || 0;
              const newStock = Math.max(0, oldGlobalStock - stockQty);
              // Reverse weighted average HPP for centralized products
              const oldAvgHpp = Number(product.avg_hpp) || 0;
              let newAvgHpp = oldAvgHpp;
              if (newStock > 0 && oldGlobalStock > 0) {
                const totalValueBefore = oldGlobalStock * oldAvgHpp;
                // BUG-11 FIX: Use ONLY itemCamel.hpp for purchase HPP reversal.
                // Never fall back to itemCamel.price (that's the selling price, not cost).
                const itemCostPerUnit = Number(itemCamel.hpp) || 0;
                const removedValue = stockQty * itemCostPerUnit;
                if (removedValue > 0) {
                  newAvgHpp = Math.max(0, (totalValueBefore - removedValue) / newStock);
                }
              } else if (newStock <= 0) {
                newAvgHpp = 0;
              }
              await db
                .from('products')
                .update({ global_stock: newStock, avg_hpp: newAvgHpp })
                .eq('id', itemCamel.productId);
            }
          }
        }
      }
      completedSteps.push('stock_restore');
      } catch (stepErr) {
        recordCompensationFailure('stock_restore', stepErr instanceof Error ? stepErr.message : String(stepErr));
        throw stepErr;
      }

      // Cancel linked receivable
      try {
      const { data: receivable } = await db
        .from('receivables')
        .select('*')
        .eq('transaction_id', id)
        .maybeSingle();
      if (receivable && receivable.status !== 'cancelled' && receivable.status !== 'paid') {
        await db
          .from('receivables')
          .update({ status: 'cancelled' })
          .eq('id', receivable.id);
      }
      completedSteps.push('receivable_cancel');
      } catch (stepErr) {
        recordCompensationFailure('receivable_cancel', stepErr instanceof Error ? stepErr.message : String(stepErr));
        throw stepErr;
      }

      // Reverse all financial balances from linked payments
      const { data: payments } = await db
        .from('payments')
        .select('*')
        .eq('transaction_id', id);

      try {
      for (const payment of (payments || [])) {
        // Sale: money was credited → decrement to reverse
        // Purchase: money was debited → increment to reverse
        if (payment.cash_box_id) {
          const delta = txCamel.type === 'sale' ? -(Number(payment.amount) || 0) : (Number(payment.amount) || 0);
          try {
            await atomicUpdateBalance('cash_boxes', payment.cash_box_id, delta, CANCEL_MIN_BALANCE);
          } catch { /* best effort on cancellation rollback */ }
        }
        if (payment.bank_account_id) {
          const delta = txCamel.type === 'sale' ? -(Number(payment.amount) || 0) : (Number(payment.amount) || 0);
          try {
            await atomicUpdateBalance('bank_accounts', payment.bank_account_id, delta, CANCEL_MIN_BALANCE);
          } catch { /* best effort on cancellation rollback */ }
        }
      }
      completedSteps.push('payment_reverse');
      } catch (stepErr) {
        recordCompensationFailure('payment_reverse', stepErr instanceof Error ? stepErr.message : String(stepErr));
        throw stepErr;
      }

      // Reverse pool balances from payments (only for sale transactions)
      try {
      if (txCamel.type === 'sale') {
        let totalHppToReverse = 0;
        let totalProfitToReverse = 0;
        for (const payment of (payments || [])) {
          // Only reverse pool for payments deposited to brankas/bank
          // Skip courier cash collection payments (no cash_box_id or bank_account_id)
          if (payment.cash_box_id || payment.bank_account_id) {
            totalHppToReverse += Number(payment.hpp_portion) || 0;
            totalProfitToReverse += Number(payment.profit_portion) || 0;
          }
        }

        if (totalHppToReverse > 0) {
          try {
            await atomicUpdatePoolBalance('pool_hpp_paid_balance', -totalHppToReverse, CANCEL_MIN_BALANCE);
          } catch { /* best effort on cancellation rollback */ }
        }
        if (totalProfitToReverse > 0) {
          try {
            await atomicUpdatePoolBalance('pool_profit_paid_balance', -totalProfitToReverse, CANCEL_MIN_BALANCE);
          } catch { /* best effort on cancellation rollback */ }
        }
      }
      completedSteps.push('pool_reverse');
      } catch (stepErr) {
        recordCompensationFailure('pool_reverse', stepErr instanceof Error ? stepErr.message : String(stepErr));
        throw stepErr;
      }

      // Reverse CourierCash if this was a cash delivery
      try {
      if (txCamel.deliveredAt && txCamel.courierId && txCamel.paymentMethod === 'cash' && txCamel.type === 'sale') {
        const { data: courierCash } = await db
          .from('courier_cash')
          .select('*')
          .eq('courier_id', txCamel.courierId)
          .eq('unit_id', txCamel.unitId)
          .maybeSingle();
        if (courierCash) {
          const reverseAmount = Math.min(txCamel.paidAmount || 0, courierCash.balance);
          // Calculate hpp/profit portions to reverse from the payment records
          let courierHppToReverse = 0;
          let courierProfitToReverse = 0;
          for (const payment of (payments || [])) {
            // Only count payments without cash_box_id/bank_account_id (courier cash collection)
            if (!payment.cash_box_id && !payment.bank_account_id) {
              courierHppToReverse += Number(payment.hpp_portion) || 0;
              courierProfitToReverse += Number(payment.profit_portion) || 0;
            }
          }
          courierHppToReverse = Math.min(courierHppToReverse, courierCash.hpp_pending || 0);
          courierProfitToReverse = Math.min(courierProfitToReverse, courierCash.profit_pending || 0);

          await db
            .from('courier_cash')
            .update({
              balance: courierCash.balance - reverseAmount,
              total_collected: courierCash.total_collected - reverseAmount,
              hpp_pending: Math.max(0, (courierCash.hpp_pending || 0) - courierHppToReverse),
              profit_pending: Math.max(0, (courierCash.profit_pending || 0) - courierProfitToReverse),
            })
            .eq('id', courierCash.id);
        }
      }
      completedSteps.push('courier_cash_reverse');
      } catch (stepErr) {
        recordCompensationFailure('courier_cash_reverse', stepErr instanceof Error ? stepErr.message : String(stepErr));
        throw stepErr;
      }

      // Delete all payment records
      try {
      await db
        .from('payments')
        .delete()
        .eq('transaction_id', id);
      completedSteps.push('payment_delete');
      } catch (stepErr) {
        recordCompensationFailure('payment_delete', stepErr instanceof Error ? stepErr.message : String(stepErr));
        throw stepErr;
      }

      // Reverse customer stats for sale transactions
      try {
      if (txCamel.customerId && txCamel.type === 'sale') {
        const { data: customer } = await db
          .from('customers')
          .select('total_orders, total_spent')
          .eq('id', txCamel.customerId)
          .single();
        if (customer) {
          await db
            .from('customers')
            .update({
              total_orders: Math.max(0, customer.total_orders - 1),
              total_spent: Math.max(0, customer.total_spent - txCamel.total),
            })
            .eq('id', txCamel.customerId);
        }

        // Reverse cashback if any was given for this transaction
        try {
          const { data: cbLog } = await db
            .from('cashback_log')
            .select('id, amount, customer_id')
            .eq('transaction_id', id)
            .eq('type', 'earned')
            .maybeSingle();
          if (cbLog && cbLog.amount > 0) {
            // Deduct cashback balance (use RPC if available, fallback to read-then-write)
            try {
              // BUG FIX #5: Changed p_amount → p_delta to match RPC signature
              await db.rpc('atomic_deduct_cashback', {
                p_customer_id: cbLog.customer_id,
                p_delta: cbLog.amount,
              });
            } catch {
              // RPC may not exist — fallback to read-then-write
              const { data: cbCustomer } = await db
                .from('customers')
                .select('cashback_balance')
                .eq('id', cbLog.customer_id)
                .single();
              if (cbCustomer) {
                await db
                  .from('customers')
                  .update({ cashback_balance: Math.max(0, (cbCustomer.cashback_balance || 0) - cbLog.amount) })
                  .eq('id', cbLog.customer_id);
              }
            }
            // Archive the cashback log entry
            await db
              .from('cashback_log')
              .update({
                type: 'reversed',
                description: `Dibatalkan — Rp ${cbLog.amount.toLocaleString('id-ID')} dikembalikan dari cashback (pembatalan invoice)`,
              })
              .eq('id', cbLog.id);
          }
        } catch (cbReverseErr) {
          console.error('[CANCEL] Failed to reverse cashback (non-blocking):', cbReverseErr);
        }
      }
      completedSteps.push('customer_stats_reverse');
      completedSteps.push('cashback_reverse');
      } catch (stepErr) {
        recordCompensationFailure('customer_stats_reverse', stepErr instanceof Error ? stepErr.message : String(stepErr));
        throw stepErr;
      }
    } else {
      // Pending transactions — cancel linked receivable
      const { data: pendingReceivable } = await db
        .from('receivables')
        .select('*')
        .eq('transaction_id', id)
        .maybeSingle();
      if (pendingReceivable && pendingReceivable.status !== 'cancelled' && pendingReceivable.status !== 'paid') {
        await db
          .from('receivables')
          .update({ status: 'cancelled' })
          .eq('id', pendingReceivable.id);
      }

      // Reverse customer stats for sale transactions
      if (txCamel.customerId && txCamel.type === 'sale') {
        const { data: customer } = await db
          .from('customers')
          .select('total_orders, total_spent')
          .eq('id', txCamel.customerId)
          .single();
        if (customer) {
          await db
            .from('customers')
            .update({
              total_orders: Math.max(0, customer.total_orders - 1),
              total_spent: Math.max(0, customer.total_spent - txCamel.total),
            })
            .eq('id', txCamel.customerId);
        }
      }
    }

    // Update transaction status + reset payment fields
    await db
      .from('transactions')
      .update({
        status: 'cancelled',
        paid_amount: 0,
        remaining_amount: txCamel.total,
        payment_status: 'unpaid',
        hpp_paid: 0,
        profit_paid: 0,
        hpp_unpaid: txCamel.totalHpp,
        profit_unpaid: txCamel.totalProfit,
      })
      .eq('id', id);

    // Log
    createLog(db, {
      type: 'audit',
      action: 'transaction_cancelled',
      entity: 'transaction',
      entityId: id,
      message: 'Transaction ' + txCamel.invoiceNo + ' cancelled'
    });

    createEvent(db, 'transaction_cancelled', {
      transactionId: id,
      invoiceNo: txCamel.invoiceNo
    });

    const { data: updatedTransaction } = await db
      .from('transactions')
      .select('*')
      .eq('id', id)
      .single();

    wsTransactionUpdate({ invoiceNo: txCamel.invoiceNo, type: txCamel.type, status: 'cancelled', unitId: txCamel.unitId });

    return NextResponse.json({ transaction: toCamelCase(updatedTransaction) });
  } catch (error) {
    console.error('Cancel transaction error:', error);
    return NextResponse.json({ error: 'Terjadi kesalahan server' }, { status: 500 });
  }
}
