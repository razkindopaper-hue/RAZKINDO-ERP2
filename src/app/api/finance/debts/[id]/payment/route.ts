import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/supabase';
import { enforceFinanceRole } from '@/lib/require-auth';
import { toCamelCase, rowsToCamelCase, toSnakeCase, createLog, generateId } from '@/lib/supabase-helpers';
import { atomicUpdateBalance, atomicUpdatePoolBalance } from '@/lib/atomic-ops';
import { wsFinanceUpdate } from '@/lib/ws-dispatch';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await enforceFinanceRole(request);
    if (!auth.success) return auth.response;

    const { id } = await params;
    const { amount, paymentSource, bankAccountId, cashBoxId, referenceNo, notes, paidById, fundSource } = await request.json();

    if (!amount || amount <= 0) {
      return NextResponse.json({ error: 'Jumlah pembayaran harus lebih dari 0' }, { status: 400 });
    }

    // ========== 2-STEP WORKFLOW VALIDATION ==========
    // Step 1: Fund source (HPP or Profit pool) must be specified
    const validFundSources = ['hpp_paid', 'profit_unpaid'];
    if (!fundSource || !validFundSources.includes(fundSource)) {
      return NextResponse.json({ error: 'Step 1: Komposisi dana (HPP Sudah Terbayar / Profit Sudah Terbayar) wajib dipilih' }, { status: 400 });
    }

    // Step 2: Physical account (bank/cashbox) must be specified
    const validSources = ['bank', 'cashbox'];
    if (!paymentSource || !validSources.includes(paymentSource)) {
      return NextResponse.json({ error: 'Step 2: Sumber pembayaran fisik (Rekening Bank / Brankas) wajib dipilih' }, { status: 400 });
    }

    if (paymentSource === 'bank' && !bankAccountId) {
      return NextResponse.json({ error: 'Rekening bank wajib diisi untuk pembayaran bank' }, { status: 400 });
    }
    if (paymentSource === 'cashbox' && !cashBoxId) {
      return NextResponse.json({ error: 'Brankas wajib diisi untuk pembayaran brankas' }, { status: 400 });
    }

    // Fetch debt with payments
    const { data: debt, error: debtError } = await db.from('company_debts').select('*, company_debt_payments(*)').eq('id', id).single();
    if (debtError || !debt) {
      throw new Error('Hutang tidak ditemukan');
    }

    if (debt.status !== 'active') {
      throw new Error('Hutang sudah ditutup atau dibatalkan');
    }

    const currentPaid = (debt.company_debt_payments || []).reduce((sum: number, p: any) => sum + (p.amount || 0), 0);
    const remaining = debt.total_amount - currentPaid;

    if (amount > remaining) {
      throw new Error(`Jumlah melebihi sisa hutang. Sisa: Rp ${remaining.toLocaleString('id-ID')}`);
    }

    // Step 1: Atomically deduct from pool balance (throws if insufficient)
    const poolKey = fundSource === 'hpp_paid' ? 'pool_hpp_paid_balance' : 'pool_profit_paid_balance';
    try {
      await atomicUpdatePoolBalance(poolKey, -amount);
    } catch {
      const poolLabel = fundSource === 'hpp_paid' ? 'HPP Sudah Terbayar' : 'Profit Sudah Terbayar';
      throw new Error(`Saldo pool ${poolLabel} tidak mencukupi`);
    }

    // Step 2: Atomically deduct from physical account (throws if insufficient)
    if (paymentSource === 'bank' && bankAccountId) {
      try {
        await atomicUpdateBalance('bank_accounts', bankAccountId, -amount);
      } catch {
        // Rollback pool deduction on failure
        try { await atomicUpdatePoolBalance(poolKey, amount); } catch { /* best effort rollback */ }
        throw new Error('Saldo bank tidak mencukupi');
      }
    } else if (paymentSource === 'cashbox' && cashBoxId) {
      try {
        await atomicUpdateBalance('cash_boxes', cashBoxId, -amount);
      } catch {
        // Rollback pool deduction on failure
        try { await atomicUpdatePoolBalance(poolKey, amount); } catch { /* best effort rollback */ }
        throw new Error('Saldo brankas tidak mencukupi');
      }
    }

    // Create payment record
    const paymentData = toSnakeCase({
      id: generateId(), debtId: id,
      amount,
      paymentSource,
      bankAccountId: bankAccountId || null,
      cashBoxId: cashBoxId || null,
      referenceNo: referenceNo || null,
      notes: notes || null,
      paidById: auth.userId,
    });

    const { data: payment, error: paymentError } = await db.from('company_debt_payments').insert(paymentData).select().single();
    if (paymentError) throw paymentError;

    // Update debt totals
    const newPaidAmount = currentPaid + amount;
    const newRemainingAmount = debt.total_amount - newPaidAmount;
    const newStatus = newRemainingAmount <= 0 ? 'paid' : 'active';

    const { error: updateErr } = await db.from('company_debts').update({
      paid_amount: newPaidAmount,
      remaining_amount: newRemainingAmount,
      status: newStatus,
    }).eq('id', id);
    if (updateErr) throw updateErr;

    // Log with 2-step info
    const fundLabel = fundSource === 'hpp_paid' ? 'HPP Sudah Terbayar' : 'Profit Sudah Terbayar';
    const physLabel = paymentSource === 'bank' ? 'Rekening Bank' : 'Brankas';
    createLog(db, {
      type: 'activity',
      userId: auth.userId,
      action: 'company_debt_payment',
      entity: 'company_debt',
      entityId: id,
      payload: JSON.stringify({ amount, fundSource, fundLabel, paymentSource, physLabel, bankAccountId, cashBoxId, newPaidAmount, newRemainingAmount, newStatus }),
    });

    wsFinanceUpdate({ type: 'debt_payment', debtId: id });

    return NextResponse.json({
      payment: toCamelCase(payment),
      debt: {
        ...toCamelCase(debt),
        paidAmount: newPaidAmount,
        remainingAmount: newRemainingAmount,
        status: newStatus,
      },
    });
  } catch (error) {
    console.error('Create debt payment error:', error);
    const message = error instanceof Error ? error.message : 'Terjadi kesalahan server';
    const status = error instanceof Error && (
      message.includes('tidak mencukupi') ||
      message.includes('tidak ditemukan') ||
      message.includes('melebihi') ||
      message.includes('ditutup') ||
      message.includes('wajib dipilih') ||
      message.includes('Step 1') ||
      message.includes('Step 2')
    ) ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
