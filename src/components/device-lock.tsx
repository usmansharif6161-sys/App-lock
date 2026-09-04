import 'expo-sqlite/localStorage/install';

import {
  NavigationBar,
  addVisibilityListener,
  setVisibilityAsync,
} from 'expo-navigation-bar';
import { StatusBar } from 'expo-status-bar';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  AppState,
  BackHandler,
  PermissionsAndroid,
  Platform,
  StatusBar as RNStatusBar,
  StyleSheet,
  View
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { supabase } from '@/lib/supabase';
import {
  formatMoney,
  resolvePaymentDisplayStatus,
  type InstallmentWithRelations,
} from '@/lib/types';
import {
  addRemoteLockStateListener,
  canUseSystemKiosk,
  hideLockOverlay,
  hideSystemUi,
  isDeviceOwner,
  lockPhone,
  releaseDeviceOwner,
  requestUninstall,
  showSystemUi,
  startLockWatch,
  unlockPhone,
} from 'device-kiosk';

export const LAST_QR_REF_KEY = 'last_installment_qr_ref';
export const LOCKED_REF_KEY = 'locked_installment_qr_ref';

type DeviceLockContextValue = {
  isLocked: boolean;
  refreshLockState: () => Promise<void>;
  rememberQrRef: (qrRef: string) => void;
};

const DeviceLockContext = createContext<DeviceLockContextValue>({
  isLocked: false,
  refreshLockState: async () => { },
  rememberQrRef: () => { },
});

export function useDeviceLock() {
  return useContext(DeviceLockContext);
}

function getSavedQrRef(): string {
  try {
    return localStorage.getItem(LOCKED_REF_KEY) || localStorage.getItem(LAST_QR_REF_KEY) || '';
  } catch {
    return '';
  }
}

function ensureBackgroundLockWatch(qrRef: string) {
  if (Platform.OS !== 'android' || !qrRef || !canUseSystemKiosk()) return;
  const url = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
  const key = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '';
  if (!url || !key) return;
  startLockWatch(qrRef, url, key);
}

async function applyLockedSystemUi() {
  if (Platform.OS === 'android') {
    try {
      RNStatusBar.setHidden(true, 'none');
    } catch {
      // ignore
    }
    try {
      // Hide bottom 3 buttons (Back / Home / Recents)
      NavigationBar.setHidden(true);
    } catch {
      // ignore
    }
    try {
      // Force native update even if JS thinks it's already hidden
      await setVisibilityAsync('hidden');
    } catch {
      // ignore
    }
  }
  // Native immersive sticky (works in custom Android build, not Expo Go)
  hideSystemUi();
}

async function restoreSystemUi() {
  if (Platform.OS === 'android') {
    try {
      RNStatusBar.setHidden(false, 'none');
    } catch {
      // ignore
    }
    try {
      NavigationBar.setHidden(false);
    } catch {
      // ignore
    }
    try {
      await setVisibilityAsync('visible');
    } catch {
      // ignore
    }
  }
  showSystemUi();
}

export function DeviceLockProvider({ children }: { children: React.ReactNode }) {
  const insets = useSafeAreaInsets();
  const [installment, setInstallment] = useState<InstallmentWithRelations | null>(null);
  const [paying, setPaying] = useState(false);
  // Optimistically start locked if we were locked before this launch (e.g. after a
  // reboot). Shows LOCKED instantly on open, even before DB confirms / offline.
  const [isLocked, setIsLocked] = useState<boolean>(() => {
    try {
      return Boolean(localStorage.getItem(LOCKED_REF_KEY));
    } catch {
      return false;
    }
  });

  const refreshLockState = useCallback(async () => {
    const qrRef = getSavedQrRef();
    if (!qrRef) {
      setInstallment(null);
      setIsLocked(false);
      return;
    }

    const { data, error } = await supabase
      .from('installments')
      .select(
        `
        *,
        customers ( * ),
        products ( * ),
        payments ( * )
      `
      )
      .eq('qr_code_ref', qrRef)
      .maybeSingle();

    if (error || !data) {
      return;
    }

    const row = data as InstallmentWithRelations;
    row.payments = [...(row.payments ?? [])]
      .sort((a, b) => a.installment_number - b.installment_number)
      .map((payment) => ({
        ...payment,
        // Preserve pending_approval — do NOT overwrite with resolvePaymentDisplayStatus
        status: payment.status === 'pending_approval'
          ? 'pending_approval'
          : resolvePaymentDisplayStatus(payment.status, payment.due_date),
      }));

    const isCompleted = row.status === 'completed';
    if (isCompleted && isDeviceOwner()) {
      // Surrender Device Owner mode permanently without wiping user data!
      releaseDeviceOwner();
      // Remove the locked key so app doesn't think it's locked after release
      try {
        localStorage.removeItem(LOCKED_REF_KEY);
        localStorage.removeItem(LAST_QR_REF_KEY);
      } catch {
        // ignore
      }
      // Auto-trigger uninstall after a short delay so releaseDeviceOwner completes
      setTimeout(() => {
        requestUninstall();
      }, 1200);
    }

    const locked = isCompleted ? false : Boolean(row.is_locked);
    setInstallment(row);
    setIsLocked(locked);

    try {
      if (locked) {
        localStorage.setItem(LOCKED_REF_KEY, qrRef);
        localStorage.setItem(LAST_QR_REF_KEY, qrRef);
      } else {
        localStorage.removeItem(LOCKED_REF_KEY);
      }
    } catch {
      // ignore
    }

    // Keep native background watch alive so Lock works even in other apps
    ensureBackgroundLockWatch(qrRef);
  }, []);

  const rememberQrRef = useCallback(
    (qrRef: string) => {
      if (!qrRef) return;
      try {
        localStorage.setItem(LAST_QR_REF_KEY, qrRef);
      } catch {
        // ignore
      }
      ensureBackgroundLockWatch(qrRef);
      void refreshLockState();
    },
    [refreshLockState]
  );

  useEffect(() => {
    const initialRefreshTimer = setTimeout(() => {
      void refreshLockState();
    }, 0);

    const qrRef = getSavedQrRef();
    if (qrRef) ensureBackgroundLockWatch(qrRef);
    // Fallback only — under Lock Task Android throttles JS timers (~1 min).
    // Instant unlock comes from native LockWatch broadcast + addRemoteLockStateListener.
    const timer = setInterval(() => {
      void refreshLockState();
    }, 2000);
    return () => {
      clearTimeout(initialRefreshTimer);
      clearInterval(timer);
    };
  }, [refreshLockState]);

  // Instant lock/unlock from native LockWatch (500ms poll + broadcast). Does not
  // depend on JS setInterval, which freezes while the phone is lock-tasked.
  useEffect(() => {
    const sub = addRemoteLockStateListener((locked) => {
      if (!locked) {
        try {
          localStorage.removeItem(LOCKED_REF_KEY);
        } catch {
          // ignore
        }
        // Update UI INSTANTLY before any async work — this eliminates the delay
        setIsLocked(false);
        hideLockOverlay();
        // Unlock immediately (synchronous) — do NOT await restoreSystemUi first
        if (canUseSystemKiosk()) {
          unlockPhone();
        }
        void restoreSystemUi();
        // Refresh DB in background — don't block the UI unlock
        void refreshLockState();
      } else {
        const qrRef = getSavedQrRef();
        if (qrRef) {
          try {
            localStorage.setItem(LOCKED_REF_KEY, qrRef);
          } catch {
            // ignore
          }
        }
        setIsLocked(true);
        // Refresh to get latest installment data for the lock screen
        void refreshLockState();
      }
    });
    return () => sub.remove();
  }, [refreshLockState]);

  useEffect(() => {
    const channel = supabase
      .channel(`device-lock-${Date.now()}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'installments' },
        (payload) => {
          const qrRef = getSavedQrRef();
          const row = payload.new as { qr_code_ref?: string; is_locked?: boolean; status?: string } | null;
          if (qrRef && row?.qr_code_ref && row.qr_code_ref !== qrRef) {
            return;
          }
          // Handle completed installment from realtime event
          if (row?.status === 'completed' && isDeviceOwner()) {
            releaseDeviceOwner();
            try {
              localStorage.removeItem(LOCKED_REF_KEY);
              localStorage.removeItem(LAST_QR_REF_KEY);
            } catch {
              // ignore
            }
            setTimeout(() => requestUninstall(), 1200);
          }
          // Optimistic UI from realtime payload (no wait for full refresh)
          if (typeof row?.is_locked === 'boolean' || row?.status === 'completed') {
            const shouldUnlock = !row?.is_locked || row?.status === 'completed';
            if (shouldUnlock) {
              try {
                localStorage.removeItem(LOCKED_REF_KEY);
              } catch {
                // ignore
              }
              // Instantly update UI — eliminates the loading delay on unlock
              setIsLocked(false);
              hideLockOverlay();
              // Unlock immediately before any async UI operations
              if (canUseSystemKiosk()) {
                unlockPhone();
              }
              void restoreSystemUi();
            } else {
              setIsLocked(true);
            }
          }
          // Refresh in background to get latest data
          void refreshLockState();
        }
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [refreshLockState]);

  // On resume: refresh DB only. Do NOT call lockPhone() from stale isLocked —
  // that re-locks during Unlock while LockWatch brings the app forward.
  // The isLocked effect below applies lock/unlock after refresh updates state.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active') return;
      void refreshLockState();
    });
    return () => sub.remove();
  }, [refreshLockState]);

  useEffect(() => {
    if (!isLocked) {
      try {
        localStorage.removeItem(LOCKED_REF_KEY);
      } catch {
        // ignore
      }
      hideLockOverlay();
      // Call unlockPhone() FIRST before any async UI restoration to minimize delay
      if (canUseSystemKiosk()) {
        unlockPhone();
      }
      void restoreSystemUi();
      return;
    }

    if (Platform.OS === 'android' && Platform.Version >= 33) {
      void PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
    }

    // App foreground with JS lock UI — remove system overlay so Pay works
    hideLockOverlay();

    // Device Owner only for Lock Task (no OK / No thanks dialog)
    void applyLockedSystemUi();
    if (canUseSystemKiosk()) {
      lockPhone();
    }

    // Block Android Back button
    const sub = BackHandler.addEventListener('hardwareBackPress', () => true);

    // Keep forcing the status/navigation bars hidden. Do NOT call lockPhone() here —
    // when Unlock shows the bars again, visibility=visible used to re-pin the app
    // before React cleaned up this effect, leaving the phone stuck in screen pinning.
    const timer = setInterval(() => {
      void applyLockedSystemUi();
    }, 800);

    let visibilitySub: { remove: () => void } | undefined;
    try {
      visibilitySub = addVisibilityListener((event) => {
        if (event.visibility === 'visible') {
          void applyLockedSystemUi();
        }
      });
    } catch {
      // older API
    }

    return () => {
      sub.remove();
      clearInterval(timer);
      visibilitySub?.remove();
      void restoreSystemUi();
      if (canUseSystemKiosk()) unlockPhone();
    };
  }, [isLocked]);

  const nextPayment = useMemo(() => {
    if (!installment) return null;
    return installment.payments.find((payment) => payment.status !== 'paid') ?? null;
  }, [installment]);

  async function handlePay() {
    if (!installment || !nextPayment) return;

    if (nextPayment.status === 'pending_approval') {
      Alert.alert(
        'Approval Pending ⏳',
        'Payment request already sent to shop owner. Please wait for approval.'
      );
      return;
    }

    setPaying(true);

    const { error: paymentError } = await supabase
      .from('payments')
      .update({
        status: 'pending_approval',
      })
      .eq('id', nextPayment.id)
      .neq('status', 'paid');

    setPaying(false);

    if (paymentError) {
      Alert.alert('Payment Request Failed', paymentError.message);
      return;
    }

    Alert.alert(
      'Request Sent ⏳',
      'Payment request sent to shop owner. Waiting for approval.'
    );
    await refreshLockState();
  }

  const value = useMemo(
    () => ({
      isLocked,
      refreshLockState,
      rememberQrRef,
    }),
    [isLocked, refreshLockState, rememberQrRef]
  );

  return (
    <DeviceLockContext.Provider value={value}>
      <StatusBar hidden={isLocked} style="light" />
      {Platform.OS === 'android' ? <NavigationBar hidden={isLocked} style="light" /> : null}
      <View style={styles.root}>
        {/* Keep the app UI mounted underneath so navigation state (the open
            installment screen) is preserved when we unlock. While locked, the
            opaque overlay below fully covers and blocks it. */}
        {children}

        {isLocked ? (
          <View
            style={[styles.lockScreen, styles.lockOverlay, { paddingTop: insets.top + Spacing.four }]}
            // Eat top-edge swipes inside the app (notification shade still needs Device Owner)
            onStartShouldSetResponder={() => true}
            onMoveShouldSetResponder={() => true}
            onResponderTerminationRequest={() => false}>
            {/* Top strip: catch pull-down gestures before they leave the app */}
            <View
              pointerEvents="box-only"
              style={[
                styles.topSwipeBlocker,
                { height: Math.max(insets.top, 24) + 56 },
              ]}
              onStartShouldSetResponder={() => true}
              onMoveShouldSetResponder={() => true}
              onResponderTerminationRequest={() => false}
            />

            <ThemedText type="subtitle" style={styles.lockTitle}>
              LOCKED
            </ThemedText>
            <ThemedText type="small" style={styles.lockBody}>
              This device is locked. Contact shop owner to unlock.
            </ThemedText>
            {Platform.OS === 'android' ? (
              <ThemedText type="small" style={styles.lockHint}>
                {isDeviceOwner()
                  ? 'Device Owner lock ON — Home / Recents / status bar blocked.'
                  : 'WARNING: Device Owner missing — bottom tabs & top menu will still work. Set Device Owner for real lock.'}
              </ThemedText>
            ) : null}

            <View style={styles.lockCard}>
              <ThemedText type="smallBold" style={styles.lockBody}>
                {installment?.products?.name ?? 'Product'}
              </ThemedText>
              <ThemedText type="small" style={styles.lockBody}>
                Remaining: {formatMoney(installment?.remaining_balance ?? 0)}
              </ThemedText>
              {nextPayment ? (
                <ThemedText type="small" style={[styles.mt, styles.lockBody]}>
                  Due: #{nextPayment.installment_number} · {formatMoney(nextPayment.amount)}
                </ThemedText>
              ) : (
                <ThemedText type="small" style={[styles.mt, styles.lockBody]}>
                  Paid — waiting for Unlock
                </ThemedText>
              )}
            </View>
          </View>
        ) : null}
      </View>
    </DeviceLockContext.Provider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#111827' },
  lockScreen: {
    flex: 1,
    backgroundColor: '#111827',
    paddingHorizontal: Spacing.four,
    justifyContent: 'center',
    gap: Spacing.three,
  },
  lockOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 100,
  },
  topSwipeBlocker: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 50,
    backgroundColor: 'transparent',
  },
  lockTitle: {
    color: '#fff',
    textAlign: 'center',
  },
  lockBody: {
    color: '#F9FAFB',
    textAlign: 'center',
  },
  lockHint: {
    color: '#FBBF24',
    textAlign: 'center',
    paddingHorizontal: Spacing.two,
  },
  lockCard: {
    backgroundColor: '#1F2937',
    borderRadius: Spacing.three,
    padding: Spacing.four,
    gap: Spacing.one,
  },
  mt: { marginTop: Spacing.two },
  payButton: {
    marginTop: Spacing.two,
    backgroundColor: '#059669',
    borderRadius: Spacing.two,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: Spacing.three,
  },
  payLabel: { color: '#fff' },
  disabled: { opacity: 0.6 },
});
