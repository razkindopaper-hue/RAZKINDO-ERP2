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

    // Batch fetch all unique customers needed (eliminates N+1)
    const customerIds = [...new Set((unpaidSales || []).map((tx: any) => tx.customer_id).filter(Boolean))];
    const { data: customers } = customerIds.length > 0
      ? await db.from('customers').select('id, name, phone').in('id', customerIds)
      : { data: [] };
    const customerMap = Object.fromEntries((customers || []).map((c: any) => [c.id, c]));

    // Build all receivable records in memory
    const receivablesToInsert: any[] = [];
    for (const tx of unpaidSales || []) {
      if (existingTxIds.has(tx.id)) continue;
      const remaining = tx.total - tx.paid_amount;
      if (remaining <= 0) continue;

      const customer = customerMap[tx.customer_id];
      receivablesToInsert.push(toSnakeCase({
        id: generateId(), transactionId: tx.id,
        customerName: customer?.name || 'Walk-in',
        customerPhone: customer?.phone || '',
        totalAmount: tx.total,
        paidAmount: tx.paid_amount,
        remainingAmount: remaining,
        assignedToId: tx.created_by_id,
        priority: tx.due_date && new Date(tx.due_date) < new Date() ? 'high' : 'normal',
        updatedAt: new Date().toISOString(),
      }));
    }

    // Batch insert all receivables in one query
    let created = 0;
    if (receivablesToInsert.length > 0) {
      const { error: insertError } = await db.from('receivables').insert(receivablesToInsert);
      if (!insertError) {
        created = receivablesToInsert.length;
      } else if (insertError.code === '23505') {
        // Unique constraint violation — fall back to individual upserts
        for (const insertData of receivablesToInsert) {
          const { error: singleError } = await db.from('receivables').insert(insertData);
          if (singleError?.code === '23505') {
            await db.from('receivables').update({ paid_amount: insertData.paid_amount, remaining_amount: insertData.remaining_amount, updated_at: insertData.updated_at }).eq('transaction_id', insertData.transaction_id);
          }
          created++;
        }
      }
    }

    // Sync existing receivables
    const { data: activeReceivables, error: arError } = await db.from('receivables').select('id, paid_amount, status, transaction_id').eq('status', 'active').limit(2000);
    if (arError) throw arError;

    // Batch fetch all transactions for active receivables (eliminates N+1)
    const arTxIds = [...new Set((activeReceivables || []).map((r: any) => r.transaction_id).filter(Boolean))];
    const { data: arTransactions } = arTxIds.length > 0
      ? await db.from('transactions').select('id, total, paid_amount').in('id', arTxIds)
      : { data: [] };
    const arTxMap = Object.fromEntries((arTransactions || []).map((t: any) => [t.id, t]));

    // Build all update promises
    let synced = 0;
    const syncPromises: any[] = [];
    for (const r of activeReceivables || []) {
      const tx = arTxMap[r.transaction_id];
      if (!tx) continue;

      if (tx.paid_amount >= tx.total && r.status === 'active') {
        syncPromises.push(
          db.from('receivables').update({ paid_amount: tx.total, remaining_amount: 0, status: 'paid', updated_at: new Date().toISOString() }).eq('id', r.id)
        );
        synced++;
      } else if (tx.paid_amount !== r.paid_amount) {
        syncPromises.push(
          db.from('receivables').update({ paid_amount: tx.paid_amount, remaining_amount: tx.total - tx.paid_amount, updated_at: new Date().toISOString() }).eq('id', r.id)
        );
        synced++;
      }
    }
    if (syncPromises.length > 0) {
      await Promise.all(syncPromises);
    }

    return NextResponse.json({ created, synced, message: `${created} piutang baru dibuat, ${synced} diperbarui` });
  } catch (error) {
    console.error('Sync receivables error:', error);
    return NextResponse.json({ error: 'Terjadi kesalahan server' }, { status: 500 });
  }
}
