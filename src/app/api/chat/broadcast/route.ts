import { NextRequest, NextResponse } from 'next/server';
import { verifyAuthUser } from '@/lib/token';
import { prisma } from '@/lib/supabase';
import { wsEmit } from '@/lib/ws-dispatch';

// =====================================================================
// GET /api/chat/broadcast
// Returns units and customer counts for broadcast UI preview
// =====================================================================
export async function GET(request: NextRequest) {
  try {
    const userId = await verifyAuthUser(request.headers.get('authorization'));
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { role: true, userUnits: { select: { unitId: true } } },
    });
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 });

    const isSuperAdmin = user.role === 'super_admin';

    // Fetch active units
    const whereUnit: any = { isActive: true };
    if (!isSuperAdmin && user.userUnits.length > 0) {
      whereUnit.id = { in: user.userUnits.map((u) => u.unitId) };
    }

    const units = await prisma.unit.findMany({
      where: whereUnit,
      select: {
        id: true,
        name: true,
        _count: { select: { customers: { where: { status: 'active' } } } },
      },
      orderBy: { name: 'asc' },
    });

    // Count total active customers
    const totalCustomers = await prisma.customer.count({
      where: { status: 'active' },
    });

    return NextResponse.json({
      units,
      totalCustomers,
      isSuperAdmin,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

// =====================================================================
// POST /api/chat/broadcast
// Send broadcast message to customers via in-app chat rooms
// Body: {
//   message: string,
//   messageType?: string (default: 'text'),
//   scope: 'all' | 'unit' | 'selected',
//   unitId?: string,        // required when scope === 'unit'
//   customerIds?: string[], // required when scope === 'selected'
// }
// =====================================================================
export async function POST(request: NextRequest) {
  try {
    const userId = await verifyAuthUser(request.headers.get('authorization'));
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { role: true, name: true, userUnits: { select: { unitId: true } } },
    });
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 });

    const isSuperAdmin = user.role === 'super_admin';
    const isSales = user.role === 'sales';

    if (!isSuperAdmin && !isSales) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const body = await request.json();
    const { message, messageType, scope, unitId, customerIds } = body;

    if (!message || typeof message !== 'string' || !message.trim()) {
      return NextResponse.json({ error: 'Pesan wajib diisi' }, { status: 400 });
    }

    if (!scope || !['all', 'unit', 'selected'].includes(scope)) {
      return NextResponse.json({ error: 'Scope tidak valid' }, { status: 400 });
    }

    if (scope === 'unit' && !unitId) {
      return NextResponse.json({ error: 'Unit ID wajib diisi untuk scope unit' }, { status: 400 });
    }

    if (scope === 'selected' && (!customerIds || !Array.isArray(customerIds) || customerIds.length === 0)) {
      return NextResponse.json({ error: 'Pilih minimal satu pelanggan' }, { status: 400 });
    }

    // --- Build list of customer IDs to send to ---
    let targetCustomerIds: string[] = [];

    if (scope === 'all') {
      // All active customers (super_admin only)
      if (!isSuperAdmin) {
        return NextResponse.json({ error: 'Hanya super admin yang bisa broadcast ke semua pelanggan' }, { status: 403 });
      }
      const allCustomers = await prisma.customer.findMany({
        where: { status: 'active' },
        select: { id: true },
      });
      targetCustomerIds = allCustomers.map((c) => c.id);
    } else if (scope === 'unit') {
      // Validate unit access
      if (!isSuperAdmin && user.userUnits.length > 0) {
        const allowedUnits = user.userUnits.map((u) => u.unitId);
        if (!allowedUnits.includes(unitId)) {
          return NextResponse.json({ error: 'Anda tidak memiliki akses ke unit ini' }, { status: 403 });
        }
      }
      const unitCustomers = await prisma.customer.findMany({
        where: { unitId, status: 'active' },
        select: { id: true },
      });
      targetCustomerIds = unitCustomers.map((c) => c.id);
    } else if (scope === 'selected') {
      targetCustomerIds = customerIds;
    }

    if (targetCustomerIds.length === 0) {
      return NextResponse.json({ error: 'Tidak ada pelanggan yang ditemukan' }, { status: 400 });
    }

    // --- Create or find chat rooms and send messages ---
    const trimmedMessage = message.trim();
    const msgType = messageType || 'text';
    let sentCount = 0;
    let skippedCount = 0;
    const errors: string[] = [];

    for (const customerId of targetCustomerIds) {
      try {
        // Find or create chat room
        const customer = await prisma.customer.findUnique({
          where: { id: customerId },
          select: { id: true, assignedToId: true, unitId: true },
        });

        if (!customer) {
          skippedCount++;
          errors.push(`Customer ${customerId} tidak ditemukan`);
          continue;
        }

        // Find existing room
        let room = await prisma.chatRoom.findUnique({
          where: { customerId },
          select: { id: true },
        });

        // Create room if not exists
        if (!room) {
          const salesId = customer.assignedToId || userId;
          room = await prisma.chatRoom.create({
            data: {
              customerId: customer.id,
              salesId,
              unitId: customer.unitId,
            },
            select: { id: true },
          });
        }

        // Create broadcast message
        await prisma.chatMessage.create({
          data: {
            roomId: room.id,
            senderType: 'sales',
            senderId: userId,
            senderName: user.name,
            content: `[Broadcast] ${trimmedMessage}`,
            messageType: msgType,
          },
        });

        // Update room last message
        await prisma.chatRoom.update({
          where: { id: room.id },
          data: {
            lastMessage: `[Broadcast] ${trimmedMessage}`.slice(0, 100),
            lastMessageAt: new Date(),
            customerUnread: { increment: 1 },
          },
        });

        sentCount++;
      } catch (err: any) {
        skippedCount++;
        errors.push(`Gagal kirim ke ${customerId}: ${err.message}`);
      }
    }

    // --- WebSocket notification ---
    wsEmit({
      event: 'erp:chat_broadcast',
      data: {
        senderId: userId,
        senderName: user.name,
        message: trimmedMessage,
        scope,
        sentCount,
      },
      target: 'all',
    });

    return NextResponse.json({
      success: sentCount > 0,
      sent: sentCount,
      skipped: skippedCount,
      totalTargets: targetCustomerIds.length,
      errors: errors.length > 10 ? errors.slice(0, 10) : errors,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
