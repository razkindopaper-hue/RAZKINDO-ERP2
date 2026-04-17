import { NextRequest, NextResponse } from 'next/server';
import { db, prisma } from '@/lib/supabase';
import { verifyAuthUser } from '@/lib/token';
import { rowsToCamelCase, toCamelCase } from '@/lib/supabase-helpers';

function getPeriodDates(period: string) {
  const now = new Date();
  const start = new Date();
  const end = new Date();
  switch (period) {
    case 'day': start.setHours(0, 0, 0, 0); end.setHours(23, 59, 59, 999); break;
    case 'week': {
      const dayOfWeek = now.getDay();
      const diff = now.getDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1);
      start.setDate(diff); start.setHours(0, 0, 0, 0);
      end.setDate(diff + 6); end.setHours(23, 59, 59, 999); break;
    }
    case 'month':
    default: start.setDate(1); start.setHours(0, 0, 0, 0); end.setMonth(end.getMonth() + 1, 0); end.setHours(23, 59, 59, 999); break;
  }
  return { start, end };
}

export async function GET(request: NextRequest) {
  try {
    const authUserId = await verifyAuthUser(request.headers.get('authorization'));
    if (!authUserId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { searchParams } = request.nextUrl;
    const salesId = searchParams.get('salesId');
    const period = searchParams.get('period') || 'month';
    const unitId = searchParams.get('unitId') || undefined;

    if (!salesId) return NextResponse.json({ error: 'salesId is required' }, { status: 400 });
    const validPeriods = ['day', 'week', 'month'];
    if (!validPeriods.includes(period)) return NextResponse.json({ error: 'Invalid period' }, { status: 400 });

    const { start, end } = getPeriodDates(period);
    const startISO = start.toISOString();
    const endISO = end.toISOString();

    // Personal stats
    let query = db.from('transactions').select('*').eq('type', 'sale').in('status', ['approved', 'paid']).eq('created_by_id', salesId).gte('transaction_date', startISO).lte('transaction_date', endISO);
    if (unitId) query = query.eq('unit_id', unitId);
    const { data: personalTx } = await query;
    const personalStats = {
      totalSales: (personalTx || []).reduce((s: number, t: any) => s + (t.total || 0), 0),
      totalTransactions: (personalTx || []).length,
      totalPaid: (personalTx || []).reduce((s: number, t: any) => s + (t.paid_amount || 0), 0),
      totalReceivables: (personalTx || []).reduce((s: number, t: any) => s + (t.remaining_amount || 0), 0),
    };

    // Company stats
    let companyQuery = db.from('transactions').select('total').eq('type', 'sale').in('status', ['approved', 'paid']).gte('transaction_date', startISO).lte('transaction_date', endISO);
    if (unitId) companyQuery = companyQuery.eq('unit_id', unitId);
    const { data: companyTx } = await companyQuery;
    const companyStats = {
      totalCompanySales: (companyTx || []).reduce((s: number, t: any) => s + (t.total || 0), 0),
      totalCompanyTransactions: (companyTx || []).length,
    };

    // Sales target (use Prisma — PostgREST can't find 'SalesTarget' table)
    const now = new Date();
    let target: any = null;
    if (period === 'month') {
      const salesTarget = await prisma.salesTarget.findFirst({
        where: { userId: salesId, period: 'monthly', year: now.getFullYear(), month: now.getMonth() + 1, status: 'active' },
        include: { user: { select: { id: true, name: true, email: true } } },
      });
      if (salesTarget) {
        const achievedAmount = personalStats.totalSales;
        const achievedPercentage = salesTarget.targetAmount > 0 ? Math.round((achievedAmount / salesTarget.targetAmount) * 100) : 0;
        target = {
          id: salesTarget.id,
          userId: salesTarget.userId,
          period: salesTarget.period,
          year: salesTarget.year,
          month: salesTarget.month,
          targetAmount: salesTarget.targetAmount,
          status: salesTarget.status,
          notes: salesTarget.notes,
          user: salesTarget.user ? { id: salesTarget.user.id, name: salesTarget.user.name, email: salesTarget.user.email } : null,
          achievedAmount: achievedAmount,
          achievedPercentage,
        };
      }
    }

    // Inactive customers
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const { data: inactiveCustomersRaw } = await db.from('customers').select('id, name, phone, last_transaction_date, created_at').eq('assigned_to_id', salesId).eq('status', 'active').or(`last_transaction_date.is.null,last_transaction_date.lt.${thirtyDaysAgo.toISOString()}`).order('last_transaction_date', { ascending: true }).limit(1000);
    const inactiveCustomers = (inactiveCustomersRaw || []).map((c: any) => {
      const lastTx = c.last_transaction_date ? new Date(c.last_transaction_date) : null;
      const daysSince = lastTx ? Math.floor((now.getTime() - lastTx.getTime()) / (1000 * 60 * 60 * 24)) : Math.floor((now.getTime() - new Date(c.created_at).getTime()) / (1000 * 60 * 60 * 24));
      return { id: c.id, name: c.name, phone: c.phone, lastTransactionDate: c.last_transaction_date, daysSinceLastTransaction: daysSince };
    }).sort((a: any, b: any) => b.daysSinceLastTransaction - a.daysSinceLastTransaction);

    // Recent transactions
    let recentQuery = db.from('transactions').select(`
      id, invoice_no, total, paid_amount, remaining_amount, payment_status, payment_method, transaction_date, created_at,
      customer:customers(id, name, phone), unit:units(id, name)
    `).eq('type', 'sale').in('status', ['approved', 'paid']).eq('created_by_id', salesId).gte('transaction_date', startISO).lte('transaction_date', endISO).order('transaction_date', { ascending: false }).limit(200);
    if (unitId) recentQuery = recentQuery.eq('unit_id', unitId);
    const { data: recentTransactions } = await recentQuery;
    const recentTransactionsData = rowsToCamelCase(recentTransactions || []);

    // Unpaid transactions
    const unpaidBase = db.from('transactions').select(`
      id, invoice_no, total, paid_amount, remaining_amount, payment_status, payment_method, due_date, transaction_date, created_at,
      customer:customers(id, name, phone), unit:units(id, name)
    `).eq('type', 'sale');
    const { data: unpaidTransactions } = await unpaidBase
      .neq('payment_status', 'paid')
      .neq('status', 'cancelled')
      .eq('created_by_id', salesId)
      .order('created_at', { ascending: false })
      .limit(50);
    const unpaidData = rowsToCamelCase(unpaidTransactions || []);

    // Chart data - fetch all and bucket in memory
    let chartQuery = db.from('transactions').select('total, transaction_date').eq('type', 'sale').in('status', ['approved', 'paid']).eq('created_by_id', salesId).gte('transaction_date', startISO).lte('transaction_date', endISO);
    if (unitId) chartQuery = chartQuery.eq('unit_id', unitId);
    const { data: chartRaw } = await chartQuery;

    const chartData = getChartBuckets(chartRaw || [], period);

    // Unpaid for pending deliveries
    const { data: pendingDeliveries } = await db.from('transactions').select(`
      id, customer:customers(id, name), unit:units(id, name)
    `).eq('courier_id', salesId).eq('type', 'sale').eq('status', 'approved').is('delivered_at', null).order('created_at', { ascending: false }).limit(10);

    return NextResponse.json({ personalStats, companyStats, target, inactiveCustomers, recentTransactions: recentTransactionsData, unpaidTransactions: unpaidData, chartData, pendingDeliveries: rowsToCamelCase(pendingDeliveries || []) });
  } catch (error) {
    console.error('[SALES_DASHBOARD] Error:', error);
    return NextResponse.json({ error: 'Terjadi kesalahan server' }, { status: 500 });
  }
}

function getChartBuckets(rows: { total: number; transaction_date: string }[], period: string) {
  const now = new Date();
  const dates: { label: string; start: Date; end: Date }[] = [];

  switch (period) {
    case 'day': {
      for (let h = 0; h < 24; h++) {
        const s = new Date(now); s.setHours(h, 0, 0, 0);
        const e = new Date(now); e.setHours(h, 59, 59, 999);
        dates.push({ label: `${h.toString().padStart(2, '0')}:00`, start: s, end: e });
      }
      break;
    }
    case 'week': {
      const dayOfWeek = now.getDay();
      const diff = now.getDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1);
      const dayNames = ['Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab', 'Min'];
      for (let d = 0; d < 7; d++) {
        const s = new Date(now); s.setDate(diff + d); s.setHours(0, 0, 0, 0);
        const e = new Date(now); e.setDate(diff + d); e.setHours(23, 59, 59, 999);
        dates.push({ label: dayNames[d], start: s, end: e });
      }
      break;
    }
    default: {
      const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
      for (let d = 1; d <= daysInMonth; d++) {
        const s = new Date(now.getFullYear(), now.getMonth(), d, 0, 0, 0, 0);
        const e = new Date(now.getFullYear(), now.getMonth(), d, 23, 59, 59, 999);
        dates.push({ label: d.toString(), start: s, end: e });
      }
    }
  }

  return dates.map((cp) => {
    let sales = 0;
    for (const row of rows) {
      const txDate = new Date(row.transaction_date);
      if (txDate >= cp.start && txDate <= cp.end) sales += row.total || 0;
    }
    return { date: cp.label, sales };
  });
}
