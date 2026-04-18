// =====================================================================
// POST /api/push/test - Send a test push notification to the caller
// =====================================================================
import { NextRequest, NextResponse } from 'next/server';
import { verifyAuthUser } from '@/lib/token';
import { db } from '@/lib/supabase';
import { sendPushToUser } from '@/lib/push-notification';

export async function POST(request: NextRequest) {
  try {
    const userId = await verifyAuthUser(request.headers.get('authorization'));
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Check if user has any push subscriptions
    const { data: subs, error } = await db
      .from('push_subscriptions')
      .select('id')
      .eq('user_id', userId)
      .limit(1);

    if (error) {
      console.error('[Push/Test] DB error:', error.message);
      return NextResponse.json({ error: 'Gagal cek subscription' }, { status: 500 });
    }

    if (!subs || subs.length === 0) {
      return NextResponse.json({ success: false, message: 'Belum ada perangkat terdaftar untuk push notifikasi' }, { status: 200 });
    }

    // Send test push to this user's devices
    const result = await sendPushToUser(userId, {
      title: '🔔 Test Notifikasi',
      body: 'Push notifikasi berhasil! Sistem notifikasi Anda berfungsi dengan baik.',
      icon: '/logo.svg',
      badge: '/logo.svg',
      tag: 'test-push',
      data: {
        type: 'test_push',
        payload: { timestamp: Date.now() },
        url: '/',
      },
    });

    if (result.sent > 0) {
      return NextResponse.json({
        success: true,
        message: `Test push berhasil dikirim ke ${result.sent} perangkat`,
      });
    } else {
      return NextResponse.json({
        success: false,
        message: 'Gagal mengirim push notifikasi. Coba aktifkan ulang notifikasi.',
      });
    }
  } catch (err) {
    console.error('[Push/Test] Error:', err);
    return NextResponse.json({ error: 'Terjadi kesalahan' }, { status: 500 });
  }
}
