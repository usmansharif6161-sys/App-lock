import { useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { LAST_QR_REF_KEY, useDeviceLock } from '@/components/device-lock';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Colors, Spacing } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { useGuardedRouter } from '@/hooks/use-guarded-router';
import { supabase } from '@/lib/supabase';
import {
  formatMoney,
  resolvePaymentDisplayStatus,
  type InstallmentWithRelations,
  type Payment,
} from '@/lib/types';
import { isDeviceOwner, releaseDeviceOwner, requestUninstall } from 'device-kiosk';


function safeDecodeRef(value: string | undefined): string {
  if (!value) return '';
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export default function CustomerInstallmentScreen() {
  const { ref } = useLocalSearchParams<{ ref: string }>();
  const qrRef = useMemo(() => safeDecodeRef(ref), [ref]);
  const scheme = useColorScheme();
  const colors = Colors[scheme === 'dark' ? 'dark' : 'light'];
  const router = useGuardedRouter();
  const { rememberQrRef, refreshLockState, isLocked } = useDeviceLock();

  const [installment, setInstallment] = useState<InstallmentWithRelations | null>(null);
  const [loading, setLoading] = useState(true);
  const [paying, setPaying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Track previous installment to detect payment decline
  const prevInstallmentRef = useRef<InstallmentWithRelations | null>(null);

  const load = useCallback(async () => {
    if (!qrRef) return;
    setError(null);
    try {
      localStorage.setItem(LAST_QR_REF_KEY, qrRef);
    } catch {
      // ignore
    }

    const { data, error: fetchError } = await supabase
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
      .single();

    if (fetchError) {
      setError(fetchError.message);
      setInstallment(null);
    } else {
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
      // Detect if a pending_approval payment was just declined (became unpaid)
      const prev = prevInstallmentRef.current;
      if (prev) {
        const declinedPayment = row.payments.find((newP) => {
          const oldP = prev.payments.find((p) => p.id === newP.id);
          return oldP?.status === 'pending_approval' && newP.status === 'unpaid';
        });
        if (declinedPayment) {
          Alert.alert(
            'Payment Declined ❌',
            `Shop owner has declined the payment request for installment #${declinedPayment.installment_number}. Please try again.`
          );
        }
      }
      prevInstallmentRef.current = row;
      setInstallment(row);
    }
    setLoading(false);
  }, [qrRef]);

  useEffect(() => {
    if (qrRef) {
      rememberQrRef(qrRef);
    }
    void load();
  }, [qrRef, rememberQrRef, load]);

  // Realtime subscription handles DB changes instantly.
  // Polling is only a fallback for Lock Task mode where JS timers throttle.
  useEffect(() => {
    const timer = setInterval(() => {
      void load();
    }, 5000); // Reduced from 2000ms - realtime handles instant updates
    return () => clearInterval(timer);
  }, [load]);

  // Instantly re-fetch data as soon as device is unlocked so UI updates without delay
  useEffect(() => {
    if (!isLocked) {
      void load();
    }
  }, [isLocked, load]);

  useEffect(() => {
    if (!installment?.id) return;

    const installmentId = installment.id;
    const channel = supabase
      .channel(`customer-installment-${installmentId}-${Date.now()}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'installments',
          filter: `id=eq.${installmentId}`,
        },
        () => {
          void load();
        }
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'payments',
          filter: `installment_id=eq.${installmentId}`,
        },
        () => {
          void load();
        }
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [installment?.id, load]);

  const nextPayment = useMemo(() => {
    if (!installment) return null;
    // Find the next unpaid/overdue/pending_approval payment
    return installment.payments.find((payment) => payment.status !== 'paid') ?? null;
  }, [installment]);

  const isPendingApproval = nextPayment?.status === 'pending_approval';

  async function handlePay() {
    if (!installment || !nextPayment) return;

    // Don't allow double-click if already pending
    if (nextPayment.status === 'pending_approval') {
      Alert.alert(
        'Approval Pending ⏳',
        'Payment request already sent. Waiting for shop owner to Accept or Decline.'
      );
      return;
    }

    setPaying(true);

    // Set status to pending_approval — shop owner must Accept/Decline
    const { error: paymentError } = await supabase
      .from('payments')
      .update({
        status: 'pending_approval',
      })
      .eq('id', nextPayment.id)
      .neq('status', 'paid');

    setPaying(false);

    if (paymentError) {
      Alert.alert(
        'Payment Request Failed',
        paymentError.message + '\n\nNote: Run the SQL fix in Supabase to allow pending_approval status.'
      );
      return;
    }

    Alert.alert(
      'Payment Request Sent ⏳',
      'Your payment request has been sent to the shop owner. Please wait for approval.'
    );

    await load();
  }

  if (loading) {
    return (
      <ThemedView style={styles.centered}>
        <ActivityIndicator />
      </ThemedView>
    );
  }

  if (error || !installment) {
    return (
      <ThemedView style={styles.centered}>
        <ThemedText type="smallBold">Could not load installment</ThemedText>
        <ThemedText type="small" themeColor="textSecondary" style={styles.centerText}>
          {error ?? 'No record found for this QR code.'}
        </ThemedText>
        <Pressable onPress={() => void load()}>
          <ThemedText type="linkPrimary">Retry</ThemedText>
        </Pressable>
      </ThemedView>
    );
  }

  return (
    <ThemedView style={styles.container}>
      <SafeAreaView style={styles.safe} edges={['bottom']}>
        <ScrollView contentContainerStyle={styles.content}>
          <View style={[styles.card, { backgroundColor: colors.backgroundElement }]}>
            <ThemedText type="smallBold">{installment.products?.name ?? 'Product'}</ThemedText>
            <ThemedText type="small">Total price: {formatMoney(installment.product_price)}</ThemedText>
            <ThemedText type="small">
              Remaining balance: {formatMoney(installment.remaining_balance)}
            </ThemedText>
            <ThemedText type="small" themeColor="textSecondary">
              Customer: {installment.customers?.name}
              {installment.customers?.cnic ? ` · CNIC: ${installment.customers.cnic}` : ''}
              {installment.customers?.phone ? ` · Ph: ${installment.customers.phone}` : ''}
              {installment.customers?.alternate_phone ? ` · Alt: ${installment.customers.alternate_phone}` : ''}
            </ThemedText>
            {isLocked ? (
              <ThemedText type="smallBold" style={styles.lockedHint}>
                LOCKED by shop owner
              </ThemedText>
            ) : null}
          </View>

          <ThemedText type="smallBold">Installment Schedule</ThemedText>
          {installment.payments.map((payment) => (
            <PaymentRow key={payment.id} payment={payment} colors={colors} />
          ))}

          {nextPayment ? (
            <>
              {isPendingApproval ? (
                <View style={[styles.pendingBanner]}>
                  <ThemedText style={{ fontSize: 20, textAlign: 'center' }}>⏳</ThemedText>
                  <ThemedText type="smallBold" style={styles.pendingTitle}>
                    Payment Request Sent
                  </ThemedText>
                  <ThemedText type="small" style={styles.pendingBody}>
                    Waiting for shop owner to approve installment #{nextPayment.installment_number} ({formatMoney(nextPayment.amount)}).
                  </ThemedText>
                </View>
              ) : null}
              <Pressable
                style={[
                  styles.payButton,
                  isPendingApproval && styles.pendingPayButton,
                  paying && styles.disabled,
                ]}
                disabled={paying}
                onPress={() => void handlePay()}>
                {paying ? (
                  <ActivityIndicator color="#fff" />
                ) : isPendingApproval ? (
                  <ThemedText type="smallBold" style={styles.payLabel}>
                    ⏳ Approval Pending...
                  </ThemedText>
                ) : (
                  <ThemedText type="smallBold" style={styles.payLabel}>
                    Pay {formatMoney(nextPayment.amount)} (#{nextPayment.installment_number})
                  </ThemedText>
                )}
              </Pressable>
            </>
          ) : (
            <View style={[styles.doneCard, { backgroundColor: '#10B98115', borderColor: '#10B981', borderWidth: 1 }]}>
              <ThemedText style={{ fontSize: 36, textAlign: 'center' }}>🎉</ThemedText>
              <ThemedText type="subtitle" style={{ color: '#10B981', textAlign: 'center' }}>
                Installment Paid in Full!
              </ThemedText>
              <ThemedText type="small" themeColor="textSecondary" style={{ textAlign: 'center' }}>
                Congratulations! All installments for this device have been completed.
              </ThemedText>
            </View>
          )}

          <Pressable onPress={() => router.replace('/')}>
            <ThemedText type="linkPrimary" style={styles.centerText}>
              Scan another QR
            </ThemedText>
          </Pressable>
        </ScrollView>
      </SafeAreaView>
    </ThemedView>
  );
}

function PaymentRow({
  payment,
  colors,
}: {
  payment: Payment;
  colors: { backgroundElement: string; backgroundSelected: string };
}) {
  const isPending = payment.status === 'pending_approval';
  const tone =
    payment.status === 'paid' ? '#065F46'
      : payment.status === 'overdue' ? '#991B1B'
        : isPending ? '#B45309'
          : '#374151';
  const background =
    payment.status === 'paid' ? '#D1FAE5'
      : payment.status === 'overdue' ? '#FEE2E2'
        : isPending ? '#FEF3C7'
          : colors.backgroundSelected;

  return (
    <View style={[styles.paymentRow, { backgroundColor: colors.backgroundElement }]}>
      <View style={{ flex: 1 }}>
        <ThemedText type="smallBold">
          #{payment.installment_number} · {formatMoney(payment.amount)}
        </ThemedText>
        <ThemedText type="small" themeColor="textSecondary">
          Due {payment.due_date}
          {payment.paid_at ? ` · Paid ${new Date(payment.paid_at).toLocaleString()}` : ''}
        </ThemedText>
      </View>
      <View style={[styles.pill, { backgroundColor: background }]}>
        <ThemedText type="code" style={{ color: tone }}>
          {isPending ? '⏳ PENDING' : payment.status.toUpperCase()}
        </ThemedText>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  safe: { flex: 1, paddingHorizontal: Spacing.three },
  content: { gap: Spacing.three, paddingVertical: Spacing.three, paddingBottom: Spacing.six },
  card: {
    gap: Spacing.one,
    padding: Spacing.three,
    borderRadius: Spacing.three,
  },
  lockedHint: { color: '#DC2626', marginTop: Spacing.two },
  paymentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    padding: Spacing.three,
    borderRadius: Spacing.two,
  },
  pill: {
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.one,
    borderRadius: Spacing.one,
  },
  payButton: {
    marginTop: Spacing.two,
    backgroundColor: '#059669',
    borderRadius: Spacing.two,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: Spacing.three,
  },
  pendingPayButton: {
    backgroundColor: '#92400E',
  },
  pendingBanner: {
    backgroundColor: '#FEF3C7',
    borderColor: '#D97706',
    borderWidth: 1,
    borderRadius: Spacing.two,
    padding: Spacing.three,
    gap: Spacing.one,
    alignItems: 'center',
  },
  pendingTitle: { color: '#B45309', textAlign: 'center' },
  pendingBody: { color: '#92400E', textAlign: 'center' },
  payLabel: { color: '#fff' },
  disabled: { opacity: 0.6 },
  doneCard: {
    padding: Spacing.three,
    borderRadius: Spacing.two,
    alignItems: 'center',
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.two,
    padding: Spacing.four,
  },
  centerText: { textAlign: 'center' },
});
