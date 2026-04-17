import { NextRequest, NextResponse } from 'next/server';
import { db, prisma } from '@/lib/supabase';
import { toCamelCase, rowsToCamelCase } from '@/lib/supabase-helpers';
import { verifyAndGetAuthUser } from '@/lib/token';

export async function GET(request: NextRequest) {
  try {
    const authResult = await verifyAndGetAuthUser(request.headers.get('authorization'), { role: true });
    if (!authResult) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const userRole = authResult.user.role;

    const { searchParams } = new URL(request.url);
    const unitId = searchParams.get('unitId');
    const startDateParam = searchParams.get('startDate');
    const endDateParam = searchParams.get('endDate');

    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);

    // Date range from filter params
    const filterStart = startDateParam
      ? new Date(new Date(startDateParam).setHours(0, 0, 0, 0))
      : monthStart;
    const filterEnd = endDateParam
      ? new Date(new Date(endDateParam).setHours(23, 59, 59, 999))
      : monthEnd;

    const thirtySecondsAgo = new Date(now.getTime() - 30000);
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth() + 1;

    // ========== BATCH 1: All independent queries (14 parallel) ==========
    const [
      totalSalesData,
      totalTransactionsCount,
      pendingApprovalsCount,
      lowStockRows,
      onlineUsersCount,
      todaySalesData,
      monthlySalesData,
      receivablesData,
      chartRaw,
      topProductsRaw,
      topSalesRaw,
      salesTargetsData,
      superAdminUsersData,
      periodDetailedStats,
    ] = await Promise.all([
      // Total sales & profit (filtered by date range)
      (() => {
        let q = db.from('transactions')
          .select('total, total_profit')
          .eq('type', 'sale')
          .in('status', ['approved', 'paid'])
          .gte('transaction_date', filterStart.toISOString())
          .lte('transaction_date', filterEnd.toISOString());
        if (unitId) q = q.eq('unit_id', unitId);
        return q.then(({ data }) => (data || []).reduce((acc: { total: number; totalProfit: number }, r: any) => {
          acc.total += r.total || 0;
          acc.totalProfit += r.total_profit || 0;
          return acc;
        }, { total: 0, totalProfit: 0 }));
      })(),

      // Total transactions
      (() => {
        let q = db.from('transactions')
          .select('id', { count: 'exact', head: true })
          .eq('type', 'sale')
          .in('status', ['approved', 'paid'])
          .gte('transaction_date', filterStart.toISOString())
          .lte('transaction_date', filterEnd.toISOString());
        if (unitId) q = q.eq('unit_id', unitId);
        return q;
      })(),

      // Pending approvals
      (() => {
        let q = db.from('transactions')
          .select('id', { count: 'exact', head: true })
          .eq('status', 'pending');
        if (unitId) q = q.eq('unit_id', unitId);
        return q;
      })(),

      // Low stock products (count products where globalStock <= minStock)
      (() => {
        let q = db.from('products')
          .select('id, global_stock, min_stock, is_active, track_stock')
          .eq('is_active', true)
          .eq('track_stock', true);
        if (unitId) {
          // For unit-specific filter, use unit_products stock
          return db.from('unit_products')
            .select('product_id, stock')
            .eq('unit_id', unitId)
            .then(({ data: unitProducts }) => {
              if (!unitProducts || unitProducts.length === 0) return [];
              const productIds = unitProducts.map(up => up.product_id);
              return db.from('products')
                .select('id, name, global_stock, min_stock, is_active, track_stock, stock_type')
                .in('id', productIds)
                .eq('is_active', true)
                .then(({ data: products }) => {
                  if (!products) return [];
                  const unitStockMap = new Map(unitProducts.map(up => [up.product_id, up.stock]));
                  return (products as any[]).filter(p => {
                    if (p.stock_type === 'per_unit') {
                      const unitStock = unitStockMap.get(p.id);
                      return unitStock !== undefined && unitStock <= (p.min_stock || 0);
                    }
                    return p.global_stock <= (p.min_stock || 0);
                  });
                });
            });
        }
        return q.then(({ data }) => {
          if (!data) return [];
          return (data as any[]).filter((p: any) => p.global_stock <= (p.min_stock || 0));
        });
      })(),

      // Online users (last 30 seconds)
      db.from('users')
        .select('id', { count: 'exact', head: true })
        .gte('last_seen_at', thirtySecondsAgo.toISOString())
        .eq('is_active', true)
        .eq('status', 'approved'),

      // Today's sales
      (() => {
        let q = db.from('transactions')
          .select('total, total_profit')
          .eq('type', 'sale')
          .in('status', ['approved', 'paid'])
          .gte('transaction_date', today.toISOString());
        if (unitId) q = q.eq('unit_id', unitId);
        return q.then(({ data }) => (data || []).reduce((acc: { total: number; totalProfit: number }, r: any) => {
          acc.total += r.total || 0;
          acc.totalProfit += r.total_profit || 0;
          return acc;
        }, { total: 0, totalProfit: 0 }));
      })(),

      // Monthly sales
      (() => {
        let q = db.from('transactions')
          .select('total, total_profit')
          .eq('type', 'sale')
          .in('status', ['approved', 'paid'])
          .gte('transaction_date', monthStart.toISOString())
          .lte('transaction_date', monthEnd.toISOString());
        if (unitId) q = q.eq('unit_id', unitId);
        return q.then(({ data }) => (data || []).reduce((acc: { total: number; totalProfit: number }, r: any) => {
          acc.total += r.total || 0;
          acc.totalProfit += r.total_profit || 0;
          return acc;
        }, { total: 0, totalProfit: 0 }));
      })(),

      // Receivables
      db.from('receivables')
        .select('remaining_amount')
        .eq('status', 'active')
        .then(({ data }) => (data || []).reduce((sum: number, r: any) => sum + (r.remaining_amount || 0), 0)),

      // Chart raw data
      (() => {
        let q = db.from('transactions')
          .select('total, total_profit, transaction_date')
          .eq('type', 'sale')
          .in('status', ['approved', 'paid'])
          .gte('transaction_date', filterStart.toISOString())
          .lte('transaction_date', filterEnd.toISOString())
          .order('transaction_date', { ascending: true });
        if (unitId) q = q.eq('unit_id', unitId);
        return q;
      })(),

      // Top products (fetch from transaction_items, filter by transaction date in JS)
      // NOTE: Supabase REST API cannot filter on nested relation fields server-side,
      // so we limit to last 5000 items and filter by date client-side
      (() => {
        let q = db.from('transaction_items')
          .select('product_id, product_name, qty, subtotal, transaction:transactions!transaction_id(status, type, transaction_date, unit_id)')
          .order('created_at', { ascending: false })
          .limit(5000);
        return q;
      })(),

      // Top sales people
      (() => {
        let q = db.from('transactions')
          .select('created_by_id, total')
          .eq('type', 'sale')
          .in('status', ['approved', 'paid'])
          .gte('transaction_date', filterStart.toISOString())
          .lte('transaction_date', filterEnd.toISOString());
        if (unitId) q = q.eq('unit_id', unitId);
        return q;
      })(),

      // Sales targets (Supabase REST)
      db.from('sales_targets')
        .select('*, user:users!user_id(id, name, role, email)')
        .eq('period', 'monthly')
        .eq('year', currentYear)
        .eq('month', currentMonth)
        .eq('status', 'active'),

      // Super admin users
      db.from('users')
        .select('id, name')
        .eq('role', 'super_admin')
        .eq('is_active', true)
        .eq('status', 'approved'),

      // Period detailed stats (HPP/Profit breakdown, paid amounts)
      (() => {
        let q = db.from('transactions')
          .select('total_hpp, paid_amount, remaining_amount, hpp_paid, hpp_unpaid, profit_paid, profit_unpaid')
          .eq('type', 'sale')
          .in('status', ['approved', 'paid'])
          .gte('transaction_date', filterStart.toISOString())
          .lte('transaction_date', filterEnd.toISOString());
        if (unitId) q = q.eq('unit_id', unitId);
        return q.then(({ data }) => (data || []).reduce((acc: any, r: any) => {
          acc.totalHpp += r.total_hpp || 0;
          acc.totalPaid += r.paid_amount || 0;
          acc.totalReceivables += r.remaining_amount || 0;
          acc.hppInHand += r.hpp_paid || 0;
          acc.hppUnpaid += r.hpp_unpaid || 0;
          acc.profitInHand += r.profit_paid || 0;
          acc.profitUnpaid += r.profit_unpaid || 0;
          return acc;
        }, { totalHpp: 0, totalPaid: 0, totalReceivables: 0, hppInHand: 0, hppUnpaid: 0, profitInHand: 0, profitUnpaid: 0 }));
      })(),
    ]);

    // Synchronous computations from batch 1
    const lowStockProducts = Array.isArray(lowStockRows) ? lowStockRows : [];
    const lowStockCount = lowStockProducts.length;
    const totalTransactions = totalTransactionsCount.count || 0;

    // Bucket chart raw into days
    const chartData: { date: string; sales: number; profit: number }[] = [];
    const chartMaxDays = Math.min(
      Math.max(1, Math.ceil((filterEnd.getTime() - filterStart.getTime()) / (1000 * 60 * 60 * 24)) + 1),
      31
    );
    for (let i = chartMaxDays - 1; i >= 0; i--) {
      const date = new Date(filterEnd);
      date.setDate(date.getDate() - i);
      date.setHours(0, 0, 0, 0);
      const nextDate = new Date(date);
      nextDate.setDate(nextDate.getDate() + 1);
      const dateLabel = date.toISOString().split('T')[0];
      let sales = 0;
      let profit = 0;
      for (const row of (chartRaw.data || [])) {
        const txDate = new Date(row.transaction_date);
        if (txDate >= date && txDate < nextDate) {
          sales += row.total || 0;
          profit += row.total_profit || 0;
        }
      }
      chartData.push({ date: dateLabel, sales, profit });
    }

    // Compute top products from raw items (filter by approved sales within date range)
    const productMap = new Map<string, { name: string; qty: number; subtotal: number }>();
    for (const row of (topProductsRaw.data || [])) {
      const tx = toCamelCase(row.transaction);
      if (!tx || tx.type !== 'sale' || !['approved', 'paid'].includes(tx.status)) continue;
      // Filter by date range
      const txDate = new Date(tx.transactionDate);
      if (txDate < filterStart || txDate > filterEnd) continue;
      if (unitId && tx.unitId !== unitId) continue;
      const key = row.product_id;
      if (!productMap.has(key)) {
        productMap.set(key, { name: row.product_name, qty: 0, subtotal: 0 });
      }
      const entry = productMap.get(key)!;
      entry.qty += row.qty || 0;
      entry.subtotal += row.subtotal || 0;
    }
    const topProducts = Array.from(productMap.entries())
      .map(([id, p]) => ({ id, name: p.name, sold: p.qty, revenue: p.subtotal }))
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 5);

    // Compute top sales from raw data
    const salesByUser = new Map<string, { count: number; total: number }>();
    for (const row of (topSalesRaw.data || [])) {
      if (!salesByUser.has(row.created_by_id)) {
        salesByUser.set(row.created_by_id, { count: 0, total: 0 });
      }
      const entry = salesByUser.get(row.created_by_id)!;
      entry.count += 1;
      entry.total += row.total || 0;
    }
    const topSalesData = Array.from(salesByUser.entries())
      .sort((a, b) => b[1].total - a[1].total)
      .slice(0, 5);

    const salesTargets = (salesTargetsData?.data || []).map((t: any) => ({
      id: t.id,
      userId: t.user_id,
      period: t.period,
      year: t.year,
      month: t.month,
      quarter: t.quarter,
      targetAmount: Number(t.target_amount) || 0,
      achievedAmount: Number(t.achieved_amount) || 0,
      status: t.status,
      notes: t.notes,
      user: t.user ? { id: t.user.id, name: t.user.name, role: t.user.role, email: t.user.email } : null,
    }));
    const superAdminUsers = rowsToCamelCase(superAdminUsersData.data || []);

    // ========== BATCH 2: Queries depending on batch 1 results ==========
    const topSalesUserIds = topSalesData.map(([id]) => id);
    const targetUserIds = salesTargets.map((t: any) => t.userId);
    const superAdminIds = superAdminUsers.map((u: any) => u.id);

    const [
      topSalesUsers,
      achievedByUser,
      superAdminMonthlySales,
    ] = await Promise.all([
      // Get names for the top sales
      topSalesUserIds.length > 0
        ? db.from('users').select('id, name, role').in('id', topSalesUserIds)
        : Promise.resolve({ data: [] }),
      // Achieved amounts per target user
      targetUserIds.length > 0
        ? (() => {
            let q = db.from('transactions')
              .select('created_by_id, total')
              .eq('type', 'sale')
              .in('status', ['approved', 'paid'])
              .gte('transaction_date', filterStart.toISOString())
              .lte('transaction_date', filterEnd.toISOString())
              .in('created_by_id', targetUserIds);
            if (unitId) q = q.eq('unit_id', unitId);
            return q;
          })()
        : Promise.resolve({ data: [] }),
      // Super admin sales contribution
      superAdminIds.length > 0
        ? (() => {
            let q = db.from('transactions')
              .select('total')
              .eq('type', 'sale')
              .in('status', ['approved', 'paid'])
              .gte('transaction_date', filterStart.toISOString())
              .lte('transaction_date', filterEnd.toISOString())
              .in('created_by_id', superAdminIds);
            if (unitId) q = q.eq('unit_id', unitId);
            return q.then(({ data }) => (data || []).reduce((sum: number, r: any) => sum + (r.total || 0), 0));
          })()
        : Promise.resolve(0),
    ]);

    // Synchronous computations from batch 2
    const userMap = new Map(
      rowsToCamelCase(topSalesUsers.data || []).map((u: any) => [u.id, { name: u.name, role: u.role }])
    );

    const topSales = topSalesData.map(([id, s]) => {
      const u = userMap.get(id);
      return {
        id,
        name: u?.name || 'Unknown',
        role: u?.role || 'unknown',
        transactions: s.count,
        revenue: s.total
      };
    });

    const achievedMap = new Map(
      rowsToCamelCase(achievedByUser.data || []).reduce((acc: Map<string, number>, r: any) => {
        const key = r.createdById;
        acc.set(key, (acc.get(key) || 0) + (r.total || 0));
        return acc;
      }, new Map() as Map<string, number>)
    );

    const salesTargetsWithProgress = salesTargets.map((target: any) => {
      const achievedAmount = achievedMap.get(target.userId) || 0;
      const remaining = Math.max(0, target.targetAmount - achievedAmount);
      const percent = target.targetAmount > 0
        ? Math.round((achievedAmount / target.targetAmount) * 100)
        : 0;

      return {
        id: target.id,
        userId: target.userId,
        userName: target.user?.name || 'Unknown',
        targetAmount: target.targetAmount,
        achievedAmount,
        remaining,
        percent,
        notes: target.notes
      };
    });

    const superAdminContribution = superAdminMonthlySales;

    const totalTarget = salesTargetsWithProgress.reduce((sum: number, t: any) => sum + t.targetAmount, 0);
    const totalTeamAchieved = salesTargetsWithProgress.reduce((sum: number, t: any) => sum + t.achievedAmount, 0);
    const totalWithAdmin = totalTeamAchieved + superAdminContribution;
    const totalPercent = totalTarget > 0 ? Math.round((totalWithAdmin / totalTarget) * 100) : 0;

    return NextResponse.json({
      dashboard: {
        totalSales: totalSalesData.total,
        totalProfit: totalSalesData.totalProfit,
        totalTransactions,
        pendingApprovals: pendingApprovalsCount.count || 0,
        lowStockProducts,
        onlineUsers: onlineUsersCount.count || 0,
        todaySales: todaySalesData.total,
        todayProfit: todaySalesData.totalProfit,
        monthlySales: monthlySalesData.total,
        monthlyProfit: monthlySalesData.totalProfit,
        receivables: receivablesData,
        chartData,
        topProducts,
        topSales,
        salesTargets: salesTargetsWithProgress,
        superAdminContribution,
        totalTarget,
        totalTeamAchieved,
        totalWithAdmin,
        totalPercent,
        totalPaid: periodDetailedStats.totalPaid,
        totalHpp: periodDetailedStats.totalHpp,
        totalReceivables: periodDetailedStats.totalReceivables,
        hppInHand: periodDetailedStats.hppInHand,
        hppUnpaid: periodDetailedStats.hppUnpaid,
        profitInHand: periodDetailedStats.profitInHand,
        profitUnpaid: periodDetailedStats.profitUnpaid,
      }
    }, {
      headers: {
        'Cache-Control': 'private, s-maxage=30, stale-while-revalidate=90',
      }
    });
  } catch (error) {
    console.error('Get dashboard error:', error);
    return NextResponse.json(
      { error: 'Terjadi kesalahan server' },
      { status: 500 }
    );
  }
}
