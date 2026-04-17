import { NextResponse } from 'next/server';
import { db } from '@/lib/supabase';
import { verifyAuthUser } from '@/lib/token';

// =====================================================================
// GET /api/storage/supabase-status - Real-time Supabase connection status
//
// Returns:
// - Connection status (connected/disconnected)
// - Database latency
// - Quick stats (total tables, total rows)
// - Storage bucket info
// - Last successful query timestamp
// =====================================================================

export async function GET(request: Request) {
  try {
    const authUserId = await verifyAuthUser(request.headers.get('authorization'));
    if (!authUserId) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    }

    const startTime = performance.now();
    let dbLatency = 0;
    let connected = false;
    let connectionError: string | null = null;

    // Test connection with a lightweight query
    try {
      const { error } = await db.from('settings').select('key').limit(1);
      dbLatency = Math.round(performance.now() - startTime);
      connected = !error;
      if (error) connectionError = error.message;
    } catch (err: any) {
      dbLatency = Math.round(performance.now() - startTime);
      connected = false;
      connectionError = err.message || 'Connection failed';
    }

    // Get table counts for quick overview
    let tableStats: { name: string; rows: number }[] = [];
    let totalRows = 0;
    try {
      const tables = [
        'users', 'units', 'products', 'unit_products', 'customers', 'suppliers',
        'transactions', 'transaction_items', 'payments', 'salary_payments',
        'bank_accounts', 'cash_boxes', 'finance_requests', 'fund_transfers',
        'company_debts', 'company_debt_payments', 'receivables', 'receivable_follow_ups',
        'sales_targets', 'courier_cash', 'courier_handovers', 'logs', 'events', 'settings',
      ];

      // Count rows for top tables (batch approach - just the important ones)
      const importantTables = ['transactions', 'payments', 'products', 'customers', 'users', 'logs', 'events'];
      for (const table of importantTables) {
        try {
          const { count } = await db.from(table).select('*', { count: 'exact', head: true });
          const rows = count || 0;
          tableStats.push({ name: table, rows });
          totalRows += rows;
        } catch { /* skip */ }
      }
    } catch { /* skip */ }

    // Supabase project info from env
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
    const projectId = supabaseUrl.match(/https:\/\/([^.]+)/)?.[1] || '';
    const region = supabaseUrl.match(/\.([^.]+)\.supabase/)?.[1] || 'unknown';

    // Connection quality assessment
    let quality: 'excellent' | 'good' | 'slow' | 'poor' = 'excellent';
    if (dbLatency > 1000) quality = 'poor';
    else if (dbLatency > 500) quality = 'slow';
    else if (dbLatency > 200) quality = 'good';

    return NextResponse.json({
      success: true,
      data: {
        connected,
        latency: dbLatency,
        latencyLabel: `${dbLatency}ms`,
        quality,
        connectionError,
        project: {
          id: projectId,
          region,
          url: supabaseUrl,
        },
        database: {
          type: 'PostgreSQL',
          tableCount: tableStats.length,
          totalRows,
          topTables: tableStats.sort((a, b) => b.rows - a.rows),
        },
        timestamp: new Date().toISOString(),
      },
    });
  } catch (error: any) {
    console.error('Supabase status API error:', error);
    return NextResponse.json({
      success: true,
      data: {
        connected: false,
        latency: 0,
        latencyLabel: 'N/A',
        quality: 'poor' as const,
        connectionError: error.message || 'Unknown error',
        project: { id: '', region: '', url: '' },
        database: { type: 'PostgreSQL', tableCount: 0, totalRows: 0, topTables: [] },
        timestamp: new Date().toISOString(),
      },
    });
  }
}
