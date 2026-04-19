import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/supabase';
import { toCamelCase } from '@/lib/supabase-helpers';
import { verifyAndGetAuthUser } from '@/lib/token';

// =====================================================================
// Cashback Withdrawals — Super Admin & Keuangan (Finance)
// GET /api/cashback/withdrawals — List all withdrawals
// =====================================================================

export async function GET(request: NextRequest) {
  try {
    const authUserId = await verifyAndGetAuthUser(request.headers.get('authorization'), { role: true });
    if (!authUserId || !['super_admin', 'keuangan'].includes(authUserId.user.role)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const status = searchParams.get('status');

    // Build query — use plain field select (no PostgREST joins since CashbackWithdrawal has no Prisma relations)
    let query = db
      .from('cashback_withdrawal')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(100);

    if (status) {
      query = query.eq('status', status);
    }

    const { data: withdrawals } = await query;

    // Fetch related data manually (no Prisma relations on CashbackWithdrawal)
    const customerIds = [...new Set((withdrawals || []).map((w: any) => w.customerId).filter(Boolean))];
    const processedByIds = [...new Set((withdrawals || []).map((w: any) => w.processedById).filter(Boolean))];

    const [customersResult, usersResult] = await Promise.all([
      customerIds.length > 0
        ? db.from('customers').select('id, name, phone, code').in('id', customerIds)
        : Promise.resolve({ data: [] }),
      processedByIds.length > 0
        ? db.from('users').select('id, name').in('id', processedByIds)
        : Promise.resolve({ data: [] }),
    ]);

    const customerMap: Record<string, any> = {};
    for (const c of (customersResult.data || [])) {
      customerMap[c.id] = toCamelCase(c);
    }
    const userMap: Record<string, any> = {};
    for (const u of (usersResult.data || [])) {
      userMap[u.id] = toCamelCase(u);
    }

    // Join data
    const mappedWithdrawals = (withdrawals || []).map((w: any) => ({
      ...toCamelCase(w),
      customer: customerMap[w.customerId] || null,
      processedBy: userMap[w.processedById] || null,
    }));

    // Summary stats
    const { data: allWithdrawals } = await db
      .from('cashback_withdrawal')
      .select('status, amount');

    const stats = {
      total: (allWithdrawals || []).length,
      pending: (allWithdrawals || []).filter((w: any) => w.status === 'pending').length,
      approved: (allWithdrawals || []).filter((w: any) => w.status === 'approved').length,
      processed: (allWithdrawals || []).filter((w: any) => w.status === 'processed').length,
      rejected: (allWithdrawals || []).filter((w: any) => w.status === 'rejected').length,
      totalPendingAmount: (allWithdrawals || []).filter((w: any) => w.status === 'pending').reduce((s: number, w: any) => s + w.amount, 0),
      totalProcessedAmount: (allWithdrawals || []).filter((w: any) => w.status === 'processed').reduce((s: number, w: any) => s + w.amount, 0),
    };

    return NextResponse.json({
      withdrawals: mappedWithdrawals,
      stats,
    });
  } catch (error) {
    console.error('Cashback withdrawals GET error:', error);
    return NextResponse.json({ error: 'Terjadi kesalahan server' }, { status: 500 });
  }
}
