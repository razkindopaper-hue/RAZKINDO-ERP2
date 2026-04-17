// =====================================================================
// AI FIX DISCREPANCY API
// Endpoint: POST /api/ai/fix-discrepancy
//
// Fixes specific transaction data inconsistencies identified by the audit.
// - paid_amount correction
// - remaining_amount correction
// - payment_status correction
// - hpp_paid, hpp_unpaid, profit_paid, profit_unpaid corrections
// - status correction
// - Auto-sync linked receivables when fixing transaction payment data
//
// Super Admin only.
// Creates log entries before and after the fix.
// =====================================================================

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/supabase';
import { verifyAndGetAuthUser } from '@/lib/token';
import { toCamelCase, createLog } from '@/lib/supabase-helpers';

// Allowed fixable fields on transactions
const ALLOWED_TX_FIELDS = new Set([
  'paid_amount',
  'remaining_amount',
  'payment_status',
  'hpp_paid',
  'hpp_unpaid',
  'profit_paid',
  'profit_unpaid',
  'status',
]);

// Valid payment_status values
const VALID_PAYMENT_STATUSES = new Set(['unpaid', 'partial', 'paid']);

// Valid transaction statuses
const VALID_STATUSES = new Set(['pending', 'approved', 'paid', 'cancelled']);

interface FixRequest {
  transactionId: string;
  fixes: Array<{ field: string; correctValue: number | string }>;
  reason: string;
}

// =====================================================================
// HELPER: Validate fixes
// =====================================================================

function validateFixes(fixes: Array<{ field: string; correctValue: number | string }>): string | null {
  if (!fixes || fixes.length === 0) {
    return 'Minimal 1 fix harus diberikan';
  }

  for (const fix of fixes) {
    if (!fix.field || !ALLOWED_TX_FIELDS.has(fix.field)) {
      return `Field "${fix.field}" tidak diperbolehkan. Allowed: ${Array.from(ALLOWED_TX_FIELDS).join(', ')}`;
    }

    if (fix.correctValue === undefined || fix.correctValue === null) {
      return `correctValue untuk field "${fix.field}" harus diisi`;
    }

    // Validate specific field values
    if (fix.field === 'payment_status') {
      if (!VALID_PAYMENT_STATUSES.has(String(fix.correctValue))) {
        return `payment_status harus salah satu: ${Array.from(VALID_PAYMENT_STATUSES).join(', ')}`;
      }
    }

    if (fix.field === 'status') {
      if (!VALID_STATUSES.has(String(fix.correctValue))) {
        return `status harus salah satu: ${Array.from(VALID_STATUSES).join(', ')}`;
      }

      // Don't allow fixing to 'cancelled'
      if (fix.correctValue === 'cancelled') {
        return 'Tidak dapat mengubah status ke cancelled melalui fix discrepancy';
      }
    }
  }

  return null;
}

// =====================================================================
// HELPER: Build update object with snake_case keys
// =====================================================================

function buildUpdateData(fixes: Array<{ field: string; correctValue: number | string }>): Record<string, any> {
  const data: Record<string, any> = {
    updated_at: new Date().toISOString(),
  };

  const camelToSnake: Record<string, string> = {
    paid_amount: 'paid_amount',
    remaining_amount: 'remaining_amount',
    payment_status: 'payment_status',
    hpp_paid: 'hpp_paid',
    hpp_unpaid: 'hpp_unpaid',
    profit_paid: 'profit_paid',
    profit_unpaid: 'profit_unpaid',
    status: 'status',
  };

  for (const fix of fixes) {
    const snakeKey = camelToSnake[fix.field] || fix.field;
    data[snakeKey] = fix.correctValue;
  }

  return data;
}

// =====================================================================
// HELPER: Sync linked receivables after transaction fix
// =====================================================================

async function syncReceivables(transactionId: string, newPaidAmount: number, newRemainingAmount: number, newPaymentStatus: string) {
  const results: string[] = [];

  // Find active receivables for this transaction
  const { data: receivables } = await db
    .from('receivables')
    .select('id, status, remaining_amount, paid_amount, total_amount')
    .eq('transaction_id', transactionId)
    .in('status', ['active', 'overdue']);

  if (!receivables || receivables.length === 0) {
    results.push('Tidak ada piutang aktif yang perlu disinkronkan');
    return results;
  }

  for (const r of receivables) {
    const recTotal = Number(r.total_amount) || 0;

    // If transaction is fully paid, close the receivable
    if (newPaymentStatus === 'paid') {
      await db.from('receivables').update({
        status: 'paid',
        remaining_amount: 0,
        paid_amount: recTotal,
        updated_at: new Date().toISOString(),
      }).eq('id', r.id);
      results.push(`Piutang ${r.id} ditutup (transaksi lunas)`);
    } else {
      // Sync amounts
      const newRecRemaining = Math.max(0, newRemainingAmount);
      const newRecPaid = Math.max(0, recTotal - newRecRemaining);

      await db.from('receivables').update({
        remaining_amount: newRecRemaining,
        paid_amount: newRecPaid,
        updated_at: new Date().toISOString(),
      }).eq('id', r.id);
      results.push(`Piutang ${r.id} disinkronkan: remaining ${newRecRemaining}, paid ${newRecPaid}`);
    }
  }

  return results;
}

// =====================================================================
// MAIN HANDLER
// =====================================================================

export async function POST(request: NextRequest) {
  try {
    // ── AUTH ──
    const authResult = await verifyAndGetAuthUser(
      request.headers.get('authorization'),
      { role: true }
    );
    if (!authResult) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (authResult.user.role !== 'super_admin') {
      return NextResponse.json(
        { error: 'Forbidden — hanya Super Admin yang dapat memperbaiki discrepancy' },
        { status: 403 }
      );
    }

    const body = await request.json() as FixRequest;
    const { transactionId, fixes, reason } = body;

    // Validate inputs
    if (!transactionId) {
      return NextResponse.json({ error: 'transactionId wajib diisi' }, { status: 400 });
    }
    if (!reason || reason.trim().length < 5) {
      return NextResponse.json({ error: 'Alasan perbaikan minimal 5 karakter' }, { status: 400 });
    }

    const validationError = validateFixes(fixes);
    if (validationError) {
      return NextResponse.json({ error: validationError }, { status: 400 });
    }

    // ── Fetch current transaction data (before fix) ──
    const { data: currentTx, error: fetchError } = await db
      .from('transactions')
      .select('*')
      .eq('id', transactionId)
      .single();

    if (fetchError || !currentTx) {
      return NextResponse.json({ error: 'Transaksi tidak ditemukan' }, { status: 404 });
    }

    const beforeSnapshot = toCamelCase(currentTx) as any;

    // ── Log BEFORE the fix ──
    await createLog(db, {
      type: 'audit',
      userId: authResult.userId,
      action: 'fix_discrepancy_before',
      entity: 'transactions',
      entityId: transactionId,
      payload: JSON.stringify({
        invoiceNo: beforeSnapshot.invoiceNo,
        currentValues: fixes.map(f => ({ field: f.field, oldValue: beforeSnapshot[f.field] })),
        reason,
      }),
      message: `FIX BEFORE: ${beforeSnapshot.invoiceNo} — ${fixes.map(f => `${f.field}: ${beforeSnapshot[f.field]} → ${f.correctValue}`).join(', ')}`,
    });

    // ── Apply fixes ──
    const updateData = buildUpdateData(fixes);

    const { error: updateError } = await db
      .from('transactions')
      .update(updateData)
      .eq('id', transactionId);

    if (updateError) {
      return NextResponse.json({
        error: `Gagal memperbarui transaksi: ${updateError.message}`,
      }, { status: 500 });
    }

    // ── Auto-sync receivables if payment fields were changed ──
    const paymentFieldsChanged = fixes.some(f =>
      ['paid_amount', 'remaining_amount', 'payment_status'].includes(f.field)
    );

    let receivableSyncResults: string[] = [];
    if (paymentFieldsChanged) {
      // Get the new values
      const newPaidAmount = fixes.find(f => f.field === 'paid_amount')?.correctValue ?? beforeSnapshot.paidAmount;
      const newRemainingAmount = fixes.find(f => f.field === 'remaining_amount')?.correctValue ?? beforeSnapshot.remainingAmount;
      const newPaymentStatus = fixes.find(f => f.field === 'payment_status')?.correctValue ?? beforeSnapshot.paymentStatus;

      receivableSyncResults = await syncReceivables(
        transactionId,
        Number(newPaidAmount),
        Number(newRemainingAmount),
        String(newPaymentStatus),
      );
    }

    // ── Fetch updated transaction data (after fix) ──
    const { data: updatedTx } = await db
      .from('transactions')
      .select('*')
      .eq('id', transactionId)
      .single();

    const afterSnapshot = updatedTx ? toCamelCase(updatedTx) : null;

    // ── Log AFTER the fix ──
    await createLog(db, {
      type: 'audit',
      userId: authResult.userId,
      action: 'fix_discrepancy_after',
      entity: 'transactions',
      entityId: transactionId,
      payload: JSON.stringify({
        invoiceNo: beforeSnapshot.invoiceNo,
        newValues: fixes.map(f => ({ field: f.field, newValue: f.correctValue })),
        reason,
      }),
      message: `FIX AFTER: ${beforeSnapshot.invoiceNo} — fixed ${fixes.length} field(s)`,
    });

    // ── Build response ──
    const fixResults = fixes.map(f => ({
      field: f.field,
      oldValue: beforeSnapshot[f.field as string] ?? null,
      newValue: f.correctValue,
      status: 'success',
    }));

    return NextResponse.json({
      success: true,
      transactionId,
      invoiceNo: beforeSnapshot.invoiceNo,
      fixes: fixResults,
      before: beforeSnapshot,
      after: afterSnapshot,
      receivableSync: receivableSyncResults,
      reason,
      fixedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error('[AI Fix Discrepancy] Error:', error);
    return NextResponse.json(
      { error: 'Gagal memperbaiki discrepancy', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}
