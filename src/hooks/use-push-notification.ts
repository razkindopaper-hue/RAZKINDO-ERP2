// =====================================================================
// usePushNotification - Hook for managing push notification subscription
// =====================================================================
// Handles: permission request, subscription management, and status tracking.
// Supports Android (Chrome/Firefox), iOS Safari 16.4+, macOS Safari/Chrome.
// =====================================================================

'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useAuthStore } from '@/stores/auth-store';
import { apiFetch } from '@/lib/api-client';

export type PushPermissionState = 'prompt' | 'granted' | 'denied' | 'unsupported' | 'loading';

interface PushStatus {
  permission: PushPermissionState;
  isSubscribed: boolean;
  isConfigured: boolean;
  deviceCount: number;
}

interface UsePushNotificationReturn extends PushStatus {
  requestPermission: () => Promise<boolean>;
  subscribe: () => Promise<void>;
  unsubscribe: () => Promise<void>;
  toggle: () => Promise<void>;
}

export function usePushNotification(): UsePushNotificationReturn {
  const user = useAuthStore((s) => s.user);
  const userId = user?.id;

  const [permission, setPermission] = useState<PushPermissionState>('loading');
  const [isSubscribed, setIsSubscribed] = useState(false);
  const [isConfigured, setIsConfigured] = useState(false);
  const [deviceCount, setDeviceCount] = useState(0);
  const isCheckingRef = useRef(false);

  // Check current subscription status
  const checkStatus = useCallback(async () => {
    if (isCheckingRef.current || !userId) return;
    isCheckingRef.current = true;

    try {
      // Check browser support
      if (typeof window === 'undefined' || !('serviceWorker' in navigator) || !('PushManager' in window)) {
        setPermission('unsupported');
        return;
      }

      // Check current permission
      const currentPermission = Notification.permission;
      if (currentPermission === 'denied') {
        setPermission('denied');
        return;
      }

      // Check server-side status
      try {
        const data = await apiFetch<{ configured: boolean; subscribed: boolean; subscriptionCount: number; vapidPublicKey: string | null }>('/api/push/status');
        setIsConfigured(data.configured);
        setIsSubscribed(data.subscribed);
        setDeviceCount(data.subscriptionCount || 0);
        setPermission(currentPermission as PushPermissionState);
      } catch {
        // If server check fails, just use browser permission state
        setPermission(currentPermission === 'granted' ? 'granted' : 'prompt');
      }
    } finally {
      isCheckingRef.current = false;
    }
  }, [userId]);

  // Check on mount and when user changes
  useEffect(() => {
    checkStatus();
  }, [checkStatus]);

  // Also re-check when tab becomes visible (permission may have changed)
  useEffect(() => {
    const handler = () => {
      if (document.visibilityState === 'visible') checkStatus();
    };
    document.addEventListener('visibilitychange', handler);
    return () => document.removeEventListener('visibilitychange', handler);
  }, [checkStatus]);

  // Request notification permission from browser
  const requestPermission = useCallback(async (): Promise<boolean> => {
    if (!('Notification' in window)) {
      setPermission('unsupported');
      return false;
    }

    if (Notification.permission === 'denied') {
      setPermission('denied');
      return false;
    }

    if (Notification.permission === 'granted') {
      setPermission('granted');
      return true;
    }

    setPermission('loading');
    const result = await Notification.requestPermission();
    setPermission(result as PushPermissionState);
    return result === 'granted';
  }, []);

  // Subscribe to push notifications
  const subscribe = useCallback(async () => {
    if (permission !== 'granted') {
      const granted = await requestPermission();
      if (!granted) return;
    }

    try {
      const registration = await navigator.serviceWorker.ready;
      const vapidKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;

      if (!vapidKey) {
        console.error('[Push] VAPID public key not configured');
        return;
      }

      // Convert base64 VAPID key to Uint8Array
      const applicationServerKey = urlBase64ToUint8Array(vapidKey);

      // Subscribe via PushManager
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: applicationServerKey as BufferSource,
      });

      const subJSON = subscription.toJSON();

      // Send subscription to server
      const res = await apiFetch<{ success: boolean }>('/api/push/subscribe', {
        method: 'POST',
        body: JSON.stringify({
          endpoint: subscription.endpoint,
          keys: subJSON.keys,
          deviceInfo: {
            userAgent: navigator.userAgent,
            platform: navigator.platform || (navigator as any).userAgentData?.platform || 'unknown',
            language: navigator.language,
          },
        }),
      });

      setIsSubscribed(true);
      setDeviceCount((prev) => prev + 1);
    } catch (err) {
      console.error('[Push] Subscribe failed:', err);
      // If subscription fails (e.g., existing subscription), try clearing and retry
      try {
        const registration = await navigator.serviceWorker.ready;
        const existing = await registration.pushManager.getSubscription();
        if (existing) {
          await existing.unsubscribe();
        }
      } catch {
        // Ignore
      }
    }
  }, [permission, requestPermission]);

  // Unsubscribe from push notifications
  const unsubscribe = useCallback(async () => {
    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();

      if (subscription) {
        // Tell server to remove subscription
        await apiFetch('/api/push/unsubscribe', {
          method: 'POST',
          body: JSON.stringify({ endpoint: subscription.endpoint }),
        });

        // Unsubscribe from browser
        await subscription.unsubscribe();
      }

      setIsSubscribed(false);
      // Re-fetch device count from server instead of guessing
      try {
        const data = await apiFetch<{ configured: boolean; subscribed: boolean; subscriptionCount: number }>('/api/push/status');
        setDeviceCount(data.subscriptionCount || 0);
      } catch {
        setDeviceCount(0);
      }
    } catch (err) {
      console.error('[Push] Unsubscribe failed:', err);
    }
  }, []);

  // Toggle push notifications on/off
  const toggle = useCallback(async () => {
    if (isSubscribed) {
      await unsubscribe();
    } else {
      await subscribe();
    }
  }, [isSubscribed, subscribe, unsubscribe]);

  return {
    permission,
    isSubscribed,
    isConfigured,
    deviceCount,
    requestPermission,
    subscribe,
    unsubscribe,
    toggle,
  };
}

/**
 * Convert base64 URL-encoded VAPID key to Uint8Array
 */
function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding)
    .replace(/-/g, '+')
    .replace(/_/g, '/');

  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);

  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }

  return outputArray;
}
