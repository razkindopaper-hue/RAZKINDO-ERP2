import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/supabase';
import { enforceFinanceRole } from '@/lib/require-auth';
import { toSnakeCase, toCamelCase, createLog, createEvent, generateId } from '@/lib/supabase-helpers';
import { runInTransaction, createStep, type TransactionStep } from '@/lib/db-transaction';
import { atomicUpdateBalance, atomicUpdatePoolBalance } from '@/lib/atomic-ops';

// GET /api/finance/expenses - List expense transactions
export async function GET(request: NextRequest) {
  try {
    const authResult = await enforceFinanceRole(request);
    if (!authResult.success) return authResult.response;

    const { searchParams } = new URL(request.url);
    const page = parseInt(searchParams.get('page') || '1');
    const limit = parseInt(searchParams.get('limit') || '30');

    const { data: expenses, error, count } = await db
      .from('transactions')
      .select('*, unit:units(id, name), created_by:users!created_by_id(id, name)', { count: 'exact' })
      .eq('type', 'expense')
      .order('created_at', { ascending: false })
      .range((page - 1) * limit, page * limit - 1);

    if (error) throw error;

    // Calculate total expenses amount
    const totalExpenses = (expenses || []).reduce((sum: number, e: any) => sum + (Number(e.total) || 0), 0);

    return NextResponse.json({
      expenses: (expenses || []).map(toCamelCase),
      totalExpenses,
      pagination: { page, limit, total: count || 0, totalPages: Math.ceil((count || 0) / limit) }
    });
  } catch (error) {
    console.error('Get expenses error:', error);
    return NextResponse.json({ error: 'Terjadi kesalahan server' }, { status: 500 });
  }
}

// POST /api/finance/expenses - Create direct expense
// Accepts: { description, amount, category?, unitId?, fundSource?, sourceType, bankAccountId?, cashBoxId?, notes? }
export async function POST(request: NextRequest) {
  try {
    const authResult = await enforceFinanceRole(request);
    if (!authResult.success) return authResult.response;

    const body = await request.json();
    const {
      description,
      amount,
      category,
      unitId: bodyUnitId,
      fundSource,
      sourceType,
      bankAccountId,
      cashBoxId,
      notes,
    } = body;

    if (!amount || typeof amount !== 'number' || isNaN(amount) || amount <= 0) {
      return NextResponse.json({ error: 'Jumlah tidak valid' }, { status: 400 });
    }
    if (!description || typeof description !== 'string' || description.trim().length === 0) {
      return NextResponse.json({ error: 'Deskripsi wajib diisi' }, { status: 400 });
    }
    if (description.length > 500) {
      return NextResponse.json({ error: 'Deskripsi terlalu panjang (maks 500 karakter)' }, { status: 400 });
    }

    // Resolve sourceType and sourceId from bankAccountId/cashBoxId
    const resolvedSourceType = sourceType || (bankAccountId ? 'bank' : cashBoxId ? 'cashbox' : null);
    const resolvedSourceId = bankAccountId || cashBoxId || null;

    if (!resolvedSourceType || !resolvedSourceId) {
      return NextResponse.json({ error: 'Sumber pembayaran (Bank/Brankas) wajib dipilih' }, { status: 400 });
    }

    const authUserId = authResult.userId;
    const now = new Date();

    // Resolve unitId: from body, or from user's assignment
    let unitId = bodyUnitId || null;
    if (!unitId) {
      const { data: userUnit } = await db
        .from('user_units')
        .select('unit_id')
        .eq('user_id', authUserId)
        .limit(1)
        .maybeSingle();
      unitId = userUnit?.unit_id || null;
    }

    // Generate invoice number
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const { count } = await db.from('transactions').select('*', { count: 'exact', head: true }).eq('type', 'expense').gte('created_at', monthStart);
    const invoiceNo = `EXP-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String((count || 0) + 1).padStart(4, '0')}`;

    // Build transaction steps with compensating rollback
    const expenseId = generateId();
    const steps: TransactionStep<any>[] = [];

    // Step 1: Create expense transaction
    steps.push(createStep('create-expense', async () => {
      const txData = toSnakeCase({
        id: expenseId,
        type: 'expense',
        invoiceNo,
        unitId,
        createdById: authUserId,
        total: amount,
        paidAmount: amount,
        remainingAmount: 0,
        totalHpp: 0,
        totalProfit: 0,
        hppPaid: 0,
        profitPaid: 0,
        hppUnpaid: 0,
        profitUnpaid: 0,
        paymentMethod: resolvedSourceType === 'bank' ? 'transfer' : 'cash',
        status: 'approved',
        paymentStatus: 'paid',
        notes: `${category ? `[${category}] ` : ''}${description}${notes ? `\n${notes}` : ''}`,
        transactionDate: now.toISOString(),
        updatedAt: now.toISOString(),
      });

      const { error } = await db.from('transactions').insert(txData);
      if (error) throw error;
      return expenseId;
    }, async (txId: string) => {
      try { await db.from('transactions').delete().eq('id', txId); } catch { /* best effort */ }
    }));

    // Step 2 (optional): Deduct from pool balance (2-step workflow)
    if (fundSource) {
      const validFundSources = ['hpp_paid', 'profit_unpaid'];
      if (validFundSources.includes(fundSource)) {
        const poolKey = fundSource === 'hpp_paid' ? 'pool_hpp_paid_balance' : 'pool_profit_paid_balance';
        steps.push(createStep('deduct-pool-balance', async () => {
          try {
            await atomicUpdatePoolBalance(poolKey, -amount);
          } catch {
            const poolLabel = fundSource === 'hpp_paid' ? 'HPP Sudah Terbayar' : 'Profit Sudah Terbayar';
            throw new Error(`Saldo pool ${poolLabel} tidak mencukupi`);
          }
          return poolKey;
        }, async (pKey: string) => {
          try { await atomicUpdatePoolBalance(pKey, amount); } catch { /* best effort */ }
        }));
      }
    }

    // Step 3: Deduct from physical account (bank or cashbox)
    const tableName = resolvedSourceType === 'bank' ? 'bank_accounts' : 'cash_boxes';
    steps.push(createStep('deduct-physical-balance', async () => {
      try {
        await atomicUpdateBalance(tableName, resolvedSourceId, -amount);
      } catch {
        const label = resolvedSourceType === 'bank' ? 'rekening bank' : 'brankas/kas';
        throw new Error(`Saldo ${label} tidak mencukupi`);
      }
      return true;
    }, async () => {
      try { await atomicUpdateBalance(tableName, resolvedSourceId, amount); } catch { /* best effort */ }
    }));

    // Execute all steps atomically with compensating rollback
    await runInTransaction(steps);

    // Log and event (fire-and-forget)
    createLog(db, {
      type: 'activity',
      userId: authUserId,
      action: 'expense_created',
      entity: 'transaction',
      entityId: expenseId,
      message: `Pengeluaran ${category || 'umum'} sebesar ${amount.toLocaleString('id-ID')} (${description})`
    });
    createEvent(db, 'expense_created', { expenseId, amount, description, category, sourceType: resolvedSourceType });

    return NextResponse.json({
      expense: { id: expenseId, invoiceNo, amount },
      message: 'Pengeluaran berhasil dicatat'
    });
  } catch (error: unknown) {
    console.error('Create expense error:', error);
    const message = error instanceof Error ? error.message : 'Terjadi kesalahan server';
    const status = message.includes('tidak cukup') || message.includes('wajib') ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
