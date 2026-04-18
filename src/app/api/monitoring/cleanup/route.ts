import { NextRequest, NextResponse } from 'next/server';
import { verifyAndGetAuthUser } from '@/lib/token';
import { db } from '@/lib/supabase';

/**
 * POST /api/monitoring/cleanup
 * Cleans up old records from safe tables.
 * Only accessible by super_admin.
 *
 * Body: { tables: string[], olderThanDays: number }
 */

const ALLOWED_CLEANUP_TABLES = ['events', 'logs', 'cashback_log'] as const;
type CleanupTable = typeof ALLOWED_CLEANUP_TABLES[number];

// Map table name to date column
const TABLE_DATE_COLUMNS: Record<CleanupTable, string> = {
  events: 'created_at',
  logs: 'created_at',
  cashback_log: 'created_at',
};

export async function POST(request: NextRequest) {
  try {
    // Verify super_admin auth
    const result = await verifyAndGetAuthUser(
      request.headers.get('authorization'),
      { role: true }
    );
    if (!result) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (result.user.role !== 'super_admin') {
      return NextResponse.json({ error: 'Forbidden — hanya super admin' }, { status: 403 });
    }

    const body = await request.json();
    const { tables, olderThanDays } = body;

    // Validate input
    if (!Array.isArray(tables) || tables.length === 0) {
      return NextResponse.json(
        { error: 'Daftar tabel harus berupa array tidak kosong' },
        { status: 400 }
      );
    }

    if (typeof olderThanDays !== 'number' || olderThanDays < 1 || olderThanDays > 365) {
      return NextResponse.json(
        { error: 'olderThanDays harus berupa angka antara 1-365' },
        { status: 400 }
      );
    }

    // Filter to only allowed tables
    const validTables = tables.filter(
      (t: string): t is CleanupTable =>
        (ALLOWED_CLEANUP_TABLES as readonly string[]).includes(t)
    );

    if (validTables.length === 0) {
      return NextResponse.json(
        { error: 'Tidak ada tabel yang valid untuk dibersihkan' },
        { status: 400 }
      );
    }

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - olderThanDays);
    const cutoffISO = cutoffDate.toISOString();

    // Delete from each table and track counts
    const results: Array<{ table: string; deleted_count: number }> = [];

    for (const tableName of validTables) {
      try {
        const dateColumn = TABLE_DATE_COLUMNS[tableName];
        const { count } = await db
          .from(tableName)
          .delete({ count: 'exact' })
          .lt(dateColumn, cutoffISO);

        results.push({
          table: tableName,
          deleted_count: count || 0,
        });
      } catch (err) {
        console.error(`[Cleanup] Error deleting from ${tableName}:`, err);
        results.push({
          table: tableName,
          deleted_count: -1, // Error indicator
        });
      }
    }

    const totalDeleted = results.reduce((sum, r) => sum + (r.deleted_count > 0 ? r.deleted_count : 0), 0);
    const hadErrors = results.some((r) => r.deleted_count === -1);

    return NextResponse.json({
      success: !hadErrors,
      message: hadErrors
        ? `Beberapa tabel gagal dibersihkan. Total berhasil: ${totalDeleted} baris.`
        : `Berhasil menghapus ${totalDeleted} baris dari ${validTables.length} tabel.`,
      results,
      total_deleted: totalDeleted,
      cutoff_date: cutoffISO,
    });
  } catch (error) {
    console.error('[Cleanup] Error:', error);
    return NextResponse.json({ error: 'Terjadi kesalahan server' }, { status: 500 });
  }
}
