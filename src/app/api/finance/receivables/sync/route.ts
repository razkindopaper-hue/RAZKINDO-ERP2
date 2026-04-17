import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/supabase';
import { verifyAuthUser } from '@/lib/token';
import { toSnakeCase, generateId } from '@/lib/supabase-helpers';

export async function POST(request: NextRequest) {
  try {
    const authUserId = await verifyAuthUser(request.headers.get('authorization'));
    if (!authUserId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Find all sale transactions that are unpaid or partial without a receivable
    const { data: unpaidSales, error: txError } = await db.from('transactions').select('id, total, paid_amount, remaining_amount, due_date, created_by_id, customer_id').eq('type', 'sale').in('payment_status', ['unpaid', 'partial']).neq('status', 'cancelled').limit(2000);
    if (txError) throw txError;

    // Get existing receivable transaction IDs
    const { data: existingReceivables } = await db.from('receivables').select('transaction_id');
    const existingTxIds = new Set((existingReceivables || []).map((r: any) => r.transaction_id));

    let created = 0;
    for (const tx of unpaidSales) {
      if (existingTxIds.has(tx.id)) continue;
      const remaining = tx.total - tx.paid_amount;
      if (remaining <= 0) continue;

      // Get customer info
      const { data: customer } = await db.from('customers').select('name, phone').eq('id', tx.customer_id).maybeSingle();

      const insertData = toSnakeCase({
        id: generateId(), transactionId: tx.id,
        customerName: customer?.name || 'Walk-in',
        customerPhone: customer?.phone || '',
        totalAmount: tx.total,
        paidAmount: tx.paid_amount,
        remainingAmount: remaining,
        assignedToId: tx.created_by_id,
        priority: tx.due_date && new Date(tx.due_date) < new Date() ? 'high' : 'normal',
      });

      const { error: insertError } = await db.from('receivables').insert(insertData);
      if (insertError) {
        // If unique constraint violation, update instead
        if (insertError.code === '23505') {
          await db.from('receivables').update({ paid_amount: tx.paid_amount, remaining_amount: remaining }).eq('transaction_id', tx.id);
        }
      } else {
        created++;
      }
    }

    // Sync existing receivables
    const { data: activeReceivables, error: arError } = await db.from('receivables').select('id, paid_amount, status, transaction_id').eq('status', 'active').limit(2000);
    if (arError) throw arError;

    let synced = 0;
    for (const r of activeReceivables) {
      const { data: tx } = await db.from('transactions').select('total, paid_amount').eq('id', r.transaction_id).maybeSingle();
      if (!tx) continue;

      if (tx.paid_amount >= tx.total && r.status === 'active') {
        await db.from('receivables').update({ paid_amount: tx.total, remaining_amount: 0, status: 'paid' }).eq('id', r.id);
        synced++;
      } else if (tx.paid_amount !== r.paid_amount) {
        await db.from('receivables').update({ paid_amount: tx.paid_amount, remaining_amount: tx.total - tx.paid_amount }).eq('id', r.id);
        synced++;
      }
    }

    return NextResponse.json({ created, synced, message: `${created} piutang baru dibuat, ${synced} diperbarui` });
  } catch (error) {
    console.error('Sync receivables error:', error);
    return NextResponse.json({ error: 'Terjadi kesalahan server' }, { status: 500 });
  }
}
