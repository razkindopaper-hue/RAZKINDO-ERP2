'use client';

import { useEffect, useRef } from 'react';
import { useQueryClient, QueryCache } from '@tanstack/react-query';
import { useWebSocket } from '@/hooks/use-websocket';
import { useAuthStore } from '@/stores/auth-store';

// =====================================================================
// REALTIME SYNC HOOK - Bridges WebSocket events → TanStack Query cache
// When any user makes a change, all connected clients in the same
// unit/role automatically refresh their relevant data without polling.
//
// Optimizations:
//   1. Smarter batching — groups multiple WS events within 500ms into
//      a single invalidation batch
//   2. Subscriber-aware — only invalidates queries that have active
//      observers (checks queryCache via queryClient.getQueryCache)
//   3. Event deduplication — prevents double invalidation from
//      concurrent WS + focus events within the dedup window
//
// This eliminates the need for frequent polling and ensures all
// departments see changes in real-time.
// =====================================================================

/**
 * Map of WebSocket events to TanStack Query keys that should be invalidated.
 * When a WS event is received, the corresponding query keys are invalidated,
 * triggering automatic refetch of fresh data from the server.
 *
 * IMPORTANT: Keys MUST match the exact queryKey arrays used in components.
 * Mismatched keys = stale data across all clients.
 */
const EVENT_TO_QUERY_KEYS: Record<string, string[][]> = {
  // Transaction events — invalidate transactions, dashboard, receivables, PWA orders
  'erp:transaction_update': [
    ['transactions'],
    ['dashboard'],
    ['receivables'],
    ['finance-requests'],
    ['pwa-pending-orders'],
    ['pwa-approved-unpaid-orders'],
    ['products', 'stock-movements'],
    ['sales-dashboard'],
    ['courier-dashboard'],
  ],

  // Payment events — invalidate transactions, dashboard, finance pools, receivables
  'erp:payment_update': [
    ['transactions'],
    ['dashboard'],
    ['receivables'],
    ['finance-pools'],
    ['pwa-approved-unpaid-orders'],
    ['sales-dashboard'],
  ],

  // Stock events — invalidate products, dashboard, asset value, stock movements
  'erp:stock_update': [
    ['products'],
    ['dashboard'],
    ['asset-value'],
    ['stock-movements'],
  ],

  // User events (registration/approval) — invalidate users list
  'erp:user_update': [
    ['users'],
  ],

  // Sales task events — invalidate tasks
  'erp:task_update': [
    ['sales-tasks'],
  ],

  // Finance request events — invalidate finance requests, dashboard, pools
  'erp:finance_update': [
    ['finance-requests'],
    ['dashboard'],
    ['finance-pools'],
  ],

  // Delivery events — invalidate transactions, courier dashboard, receivables, courier cash
  'erp:delivery_update': [
    ['transactions'],
    ['dashboard'],
    ['receivables'],
    ['finance-pools'],
    ['courier-dashboard'],
    ['courier-cash-summary'],
    ['bank-accounts'],
    ['cash-boxes'],
  ],

  // Salary events — invalidate salaries
  'erp:salary_update': [
    ['salaries'],
  ],

  // Customer events — invalidate customers list
  'erp:customer_update': [
    ['customers'],
  ],

  // Product events — invalidate products list
  'erp:product_update': [
    ['products'],
  ],

  // Receivable events — invalidate receivables
  'erp:receivable_update': [
    ['receivables'],
  ],

  // Courier events — invalidate transactions, dashboard, courier cash, brankas/bank
  'erp:courier_update': [
    ['transactions'],
    ['dashboard'],
    ['courier-cash-summary'],
    ['bank-accounts'],
    ['cash-boxes'],
    ['finance-pools'],
  ],

  // New event notification — always refresh events list
  'erp:new_event': [
    ['events'],
  ],

  // Payment proof upload — refresh transactions and events
  'erp:payment_proof_update': [
    ['transactions'],
    ['events'],
    ['receivables'],
  ],

  // Chat message events — invalidate chat rooms and messages in real-time
  'erp:chat_message': [
    ['chat-messages'],
    ['chat-rooms'],
  ],

  // Global refresh — handled specially with queryClient.invalidateQueries()
  // and a longer debounce (see handler below)
  'erp:refresh_all': [],
};

/** Optimized debounce: 500ms — groups rapid WS events into single batch */
const INVALIDATION_DEBOUNCE_MS = 500;

/** Refresh-all debounce: 2 seconds (many queries fire at once) */
const REFRESH_ALL_DEBOUNCE_MS = 2000;

/** Dedup window: skip invalidation if same key was already invalidated recently */
const KEY_DEDUP_WINDOW_MS = 3000;

/**
 * Check if a query key has any active observers (subscribers).
 * Only invalidate queries that are currently being watched by components,
 * to avoid unnecessary refetches for data nobody is looking at.
 */
function hasActiveObservers(queryCache: QueryCache, queryKey: string[]): boolean {
  const queries = queryCache.findAll({ queryKey });
  return queries.some(q => q.getObserversCount() > 0);
}

/**
 * Hook that subscribes to WebSocket events and invalidates
 * TanStack Query cache keys for seamless real-time data sync
 * across all connected clients and departments.
 */
export function useRealtimeSync() {
  const queryClient = useQueryClient();
  const { user, token } = useAuthStore();
  const debounceTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  // Dedup tracking: last invalidation timestamp per query key
  const lastInvalidatedRef = useRef<Map<string, number>>(new Map());
  // Batch accumulation: collect unique keys during debounce window
  const pendingBatchRef = useRef<Set<string>>(new Set());

  const { on, off, isConnected } = useWebSocket({
    userId: user?.id || '',
    role: user?.role || '',
    unitId: user?.unitId || '',
    userName: user?.name || '',
    authToken: token || '',
    enabled: !!user?.id,
  });

  /**
   * Execute a batch invalidation — checks subscribers and dedup before
   * actually calling invalidateQueries.
   */
  const flushBatch = useRef(() => {
    const queryCache = queryClient.getQueryCache();
    const now = Date.now();
    const keysToInvalidate = pendingBatchRef.current;

    keysToInvalidate.forEach((keyStr) => {
      // Dedup: skip if this key was invalidated within the dedup window
      const lastTs = lastInvalidatedRef.current.get(keyStr) || 0;
      if (now - lastTs < KEY_DEDUP_WINDOW_MS) {
        return;
      }

      const key = JSON.parse(keyStr) as string[];

      // Subscriber-aware: only invalidate if something is watching
      if (hasActiveObservers(queryCache, key)) {
        queryClient.invalidateQueries({ queryKey: key });
        lastInvalidatedRef.current.set(keyStr, now);
      }
    });

    // Clear batch
    keysToInvalidate.clear();

    // Periodically clean up dedup map to prevent memory growth
    if (lastInvalidatedRef.current.size > 200) {
      const cutoff = now - KEY_DEDUP_WINDOW_MS;
      for (const [k, ts] of lastInvalidatedRef.current) {
        if (ts < cutoff) lastInvalidatedRef.current.delete(k);
      }
    }
  });


  useEffect(() => {
    if (!isConnected || !user?.id) return;

    const events = Object.keys(EVENT_TO_QUERY_KEYS);
    const handlers: ((data: any) => void)[] = [];

    for (const event of events) {
      if (event === 'erp:refresh_all') {
        // refresh_all uses queryClient.invalidateQueries() and a longer 2s debounce
        const handler = (_data: any) => {
          const keyStr = '__refresh_all__';
          const existing = debounceTimers.current.get(keyStr);
          if (existing) clearTimeout(existing);

          debounceTimers.current.set(keyStr, setTimeout(() => {
            debounceTimers.current.delete(keyStr);
            queryClient.invalidateQueries();
            lastInvalidatedRef.current.clear(); // Reset dedup after full refresh
          }, REFRESH_ALL_DEBOUNCE_MS));
        };
        handlers.push(handler);
        on(event, handler);
      } else {
        const queryKeys = EVENT_TO_QUERY_KEYS[event];
        if (!queryKeys) continue;

        const handler = (_data: any) => {
          for (const key of queryKeys) {
            const keyStr = JSON.stringify(key);

            // Add to pending batch instead of scheduling individual timers
            pendingBatchRef.current.add(keyStr);
          }

          // Schedule batch flush — debounce: only one timer at a time
          // The timer key is a fixed batch key so multiple events extend the same timer
          const batchKey = '__batch_flush__';
          const existing = debounceTimers.current.get(batchKey);
          if (existing) clearTimeout(existing);

          debounceTimers.current.set(batchKey, setTimeout(() => {
            debounceTimers.current.delete(batchKey);
            flushBatch.current();
          }, INVALIDATION_DEBOUNCE_MS));
        };
        handlers.push(handler);
        on(event, handler);
      }
    }

    // Cleanup
    return () => {
      for (let i = 0; i < events.length; i++) {
        off(events[i], handlers[i]);
      }
      // Clear all debounce timers
      for (const timer of debounceTimers.current.values()) {
        clearTimeout(timer);
      }
      debounceTimers.current.clear();
      // Flush any remaining pending batch
      if (pendingBatchRef.current.size > 0) {
        flushBatch.current();
      }
    };
  }, [isConnected, user?.id, queryClient, on, off]);
}
