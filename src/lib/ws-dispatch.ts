// =====================================================================
// WEBSOCKET DISPATCHER - Server-side helper for API routes
// Pushes real-time events from Next.js API routes to connected clients
// via the internal HTTP API of the realtime WebSocket service.
// =====================================================================

interface WSEmitOptions {
  event: string;
  data: any;
  target?: 'all' | 'user' | 'unit' | 'role' | 'super_admins' | 'sales' | 'courier';
  targetId?: string | string[];
}

/**
 * Emit a real-time event to connected WebSocket clients.
 * This is a fire-and-forget operation — errors are silently logged.
 *
 * @example
 * // Broadcast to all connected users
 * await wsEmit({ event: 'erp:transaction_update', data: { invoiceNo: 'INV-001' } });
 *
 * // Notify specific user
 * await wsEmit({ event: 'erp:new_event', data: payload, target: 'user', targetId: userId });
 *
 * // Notify all admins
 * await wsEmit({ event: 'erp:finance_update', data: payload, target: 'super_admins' });
 *
 * // Notify users in a unit
 * await wsEmit({ event: 'erp:stock_update', data: payload, target: 'unit', targetId: unitId });
 */
export async function wsEmit(options: WSEmitOptions): Promise<boolean> {
  try {
    const wsSecret = process.env.WS_SECRET;
    if (!wsSecret) {
      console.warn('[WS Dispatch] WS_SECRET not set, skipping emit');
      return false;
    }
    const wsUrl = process.env.WS_INTERNAL_URL || 'http://127.0.0.1:3004';
    const res = await fetch(`${wsUrl}/enqueue`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${wsSecret}`,
      },
      body: JSON.stringify({
        type: options.event,
        target: options.target || 'all',
        targetId: options.targetId,
        data: options.data,
        priority: 'normal',
      }),
      signal: AbortSignal.timeout(3000), // 3s timeout — don't block API response
    });
    const result = await res.json();
    return result.success === true;
  } catch (err) {
    // WebSocket service might be down — non-critical, just log
    console.warn('[WS Dispatch] Failed to emit:', options.event, err instanceof Error ? err.message : err);
    return false;
  }
}

// =====================================================================
// CONVENIENCE SHORTHANDS
// =====================================================================

/** Broadcast a new event notification to all users */
export function wsNotifyAll(data: any) {
  return wsEmit({ event: 'erp:new_event', data, target: 'all' });
}

/** Notify specific user(s) */
export function wsNotifyUser(userId: string | string[], data: any) {
  return wsEmit({ event: 'erp:new_event', data, target: 'user', targetId: userId });
}

/** Broadcast transaction update (new, approved, cancelled) */
export function wsTransactionUpdate(data: { invoiceNo?: string; type?: string; status?: string; unitId?: string }) {
  const target = data.unitId ? 'unit' as const : 'all' as const;
  const targetId = data.unitId;
  return wsEmit({ event: 'erp:transaction_update', data, target, targetId });
}

/** Broadcast payment update */
export function wsPaymentUpdate(data: { transactionId?: string; amount?: number; unitId?: string }) {
  if (data.unitId) {
    return wsEmit({ event: 'erp:payment_update', data, target: 'unit', targetId: data.unitId });
  }
  return wsEmit({ event: 'erp:payment_update', data, target: 'all' });
}

/** Broadcast stock update */
export function wsStockUpdate(data: { productId?: string; productName?: string; unitId?: string }) {
  const target = data.unitId ? 'unit' as const : 'all' as const;
  const targetId = data.unitId;
  return wsEmit({ event: 'erp:stock_update', data, target, targetId });
}

/** Notify admins about user registration/approval */
export function wsUserUpdate(data: any) {
  return wsEmit({ event: 'erp:user_update', data, target: 'super_admins' });
}

/** Notify about sales task assignment/update */
export function wsTaskUpdate(data: { assignedToId?: string; taskId?: string; status?: string }) {
  if (data.assignedToId) {
    return wsEmit({ event: 'erp:task_update', data, target: 'user', targetId: data.assignedToId });
  }
  return wsEmit({ event: 'erp:task_update', data, target: 'all' });
}

/** Notify about finance request status change */
export function wsFinanceUpdate(data: any) {
  if (data.unitId) {
    return wsEmit({ event: 'erp:finance_update', data, target: 'unit', targetId: data.unitId });
  }
  return wsEmit({ event: 'erp:finance_update', data, target: 'super_admins' });
}

/** Notify about courier delivery */
export function wsDeliveryUpdate(data: { transactionId?: string; courierId?: string; status?: string; unitId?: string }) {
  if (data.courierId) {
    return wsEmit({ event: 'erp:delivery_update', data, target: 'user', targetId: data.courierId });
  }
  if (data.unitId) {
    return wsEmit({ event: 'erp:delivery_update', data, target: 'unit', targetId: data.unitId });
  }
  return wsEmit({ event: 'erp:delivery_update', data, target: 'all' });
}

/** Notify about salary payment */
export function wsSalaryUpdate(data: { userId?: string; salaryId?: string }) {
  if (data.userId) {
    return wsEmit({ event: 'erp:salary_update', data, target: 'user', targetId: data.userId });
  }
  return wsEmit({ event: 'erp:salary_update', data, target: 'all' });
}

/** Force all clients to refresh all data */
export function wsRefreshAll(reason: string = 'Data diperbarui') {
  return wsEmit({ event: 'erp:refresh_all', data: { reason } });
}

/** Broadcast customer update (create, edit, status change) */
export function wsCustomerUpdate(data?: { unitId?: string }) {
  if (data?.unitId) {
    return wsEmit({ event: 'erp:customer_update', data, target: 'unit', targetId: data.unitId });
  }
  return wsEmit({ event: 'erp:customer_update', data: data || {}, target: 'all' });
}

/** Broadcast product update (create, edit, stock change) */
export function wsProductUpdate(data?: { productId?: string }) {
  return wsEmit({ event: 'erp:product_update', data: data || {}, target: 'all' });
}

/** Broadcast receivable update (create, payment, status change) */
export function wsReceivableUpdate(data?: Record<string, unknown>) {
  return wsEmit({ event: 'erp:receivable_update', data: data || {}, target: 'all' });
}

/** Broadcast courier update (assignment, status change) */
export function wsCourierUpdate(data?: { courierId?: string }) {
  if (data?.courierId) {
    return wsEmit({ event: 'erp:courier_update', data, target: 'user', targetId: data.courierId });
  }
  return wsEmit({ event: 'erp:courier_update', data: data || {}, target: 'all' });
}
