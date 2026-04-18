// =====================================================================
// POST /api/system/cleanup - Safe Supabase data cleanup
// =====================================================================
import { NextRequest, NextResponse } from 'next/server';
import { verifyAuthUser } from '@/lib/token';
import { db } from '@/lib/supabase';

const SAFE_TO_DELETE_ALL = ['events', 'logs', 'push_subscriptions', 'password_resets', 'cashback_log'];

const CAN_CLEAN_OLD: Record<string, { dateColumn: string; label: string }> = {
  events: { dateColumn: 'created_at', label: 'Event/Notifikasi' },
  logs: { dateColumn: 'created_at', label: 'Log Aktivitas' },
  password_resets: { dateColumn: 'created_at', label: 'Reset Password' },
  cashback_log: { dateColumn: 'created_at', label: 'Log Cashback' },
  push_subscriptions: { dateColumn: 'created_at', label: 'Push Subscription' },
  customer_follow_ups: { dateColumn: 'created_at', label: 'Follow Up Pelanggan' },
  receivable_follow_ups: { dateColumn: 'created_at', label: 'Follow Up Piutang' },
  sales_task_reports: { dateColumn: 'created_at', label: 'Laporan Tugas' },
  payment_proofs: { dateColumn: 'uploaded_at', label: 'Bukti Pembayaran' },
  transactions: { dateColumn: 'created_at', label: 'Transaksi' },
  transaction_items: { dateColumn: 'created_at', label: 'Item Transaksi' },
  payments: { dateColumn: 'paid_at', label: 'Pembayaran' },
};

export async function POST(request: NextRequest) {
  try {
    const authUserId = await verifyAuthUser(request.headers.get('authorization'));
    if (!authUserId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { data: user } = await db.from('users').select('role').eq('id', authUserId).single();
    if (!user || user.role !== 'super_admin') {
      return NextResponse.json({ error: 'Akses ditolak' }, { status: 403 });
    }

    const body = await request.json();
    const { table, mode, olderThanDays } = body;

    if (!table || !mode) {
      return NextResponse.json({ error: 'Parameter tidak lengkap' }, { status: 400 });
    }

    if (mode === 'all') {
      if (!SAFE_TO_DELETE_ALL.includes(table)) {
        return NextResponse.json({
          error: `Tabel "${table}" tidak aman untuk dihapus seluruhnya. Yang diizinkan: ${SAFE_TO_DELETE_ALL.join(', ')}`,
        }, { status: 400 });
      }

      // Get count before deletion
      const { count: beforeCount } = await db.from(table).select('*', { count: 'exact', head: true });

      // Delete all rows
      const { error } = await db.from(table).delete().neq('id', '__impossible__');
      if (error) {
        // Try alternative: delete with a tautology filter
        try {
          const { count } = await db.from(table).select('id', { count: 'exact' });
          if (count && count > 0) {
            const { data: allIds } = await db.from(table).select('id').limit(5000);
            if (allIds && allIds.length > 0) {
              await db.from(table).delete().in('id', allIds.map((r: any) => r.id));
            }
          }
        } catch (retryErr: any) {
          console.error('[System/Cleanup] Retry failed:', retryErr.message);
          return NextResponse.json({ error: `Gagal menghapus data: ${error.message}` }, { status: 500 });
        }
      }

      const { count: afterCount } = await db.from(table).select('*', { count: 'exact', head: true });
      const deleted = (beforeCount || 0) - (afterCount || 0);

      return NextResponse.json({
        success: true,
        message: `${deleted} data di tabel berhasil dihapus`,
        deletedRows: deleted,
        remainingRows: afterCount || 0,
      });
    }

    if (mode === 'old') {
      const config = CAN_CLEAN_OLD[table];
      if (!config) {
        return NextResponse.json({
          error: `Tabel "${table}" tidak mendukung pembersihan data lama. Yang didukung: ${Object.keys(CAN_CLEAN_OLD).join(', ')}`,
        }, { status: 400 });
      }

      const days = olderThanDays || 90;
      if (days < 7) {
        return NextResponse.json({ error: 'Minimal 7 hari untuk mencegah penghapusan data penting' }, { status: 400 });
      }

      const cutoffDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

      const { count: beforeCount } = await db
        .from(table)
        .select('*', { count: 'exact', head: true })
        .lt(config.dateColumn, cutoffDate);

      if (!beforeCount || beforeCount === 0) {
        return NextResponse.json({
          success: true,
          message: `Tidak ada data yang lebih lama dari ${days} hari di tabel "${config.label}"`,
          deletedRows: 0,
        });
      }

      const { error } = await db.from(table).delete().lt(config.dateColumn, cutoffDate);
      if (error) {
        console.error('[System/Cleanup] Delete old error:', error.message);
        return NextResponse.json({ error: `Gagal menghapus data: ${error.message}` }, { status: 500 });
      }

      return NextResponse.json({
        success: true,
        message: `${beforeCount} data lama (>${days} hari) di tabel "${config.label}" berhasil dihapus`,
        deletedRows: beforeCount,
      });
    }

    return NextResponse.json({ error: 'Mode tidak valid. Gunakan "all" atau "old"' }, { status: 400 });
  } catch (error: any) {
    console.error('[System/Cleanup] Error:', error);
    return NextResponse.json({ error: 'Terjadi kesalahan server' }, { status: 500 });
  }
}
