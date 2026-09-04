import 'expo-sqlite/localStorage/install';

import { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { useFocusEffect } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
  LAST_QR_REF_KEY,
  LOCKED_REF_KEY,
  useDeviceLock,
} from '@/components/device-lock';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Colors, Spacing } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { useGuardedRouter } from '@/hooks/use-guarded-router';

function getSavedQrRef(): string {
  try {
    return localStorage.getItem(LOCKED_REF_KEY) || localStorage.getItem(LAST_QR_REF_KEY) || '';
  } catch {
    return '';
  }
}

function normalizeQrRef(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const ref = value.trim();
  if (!ref) return null;

  const matchesModernFormat = /^inst_[a-z0-9_-]+$/i.test(ref);
  const matchesLegacyFormat = /^INS-\d+-[A-Z0-9]+$/i.test(ref);

  return matchesModernFormat || matchesLegacyFormat ? ref : null;
}

function extractQrRef(raw: string): string | null {
  const directRef = normalizeQrRef(raw);
  if (directRef) return directRef;

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const adminExtras =
      parsed['android.app.extra.PROVISIONING_ADMIN_EXTRAS_BUNDLE'] as
        | Record<string, unknown>
        | undefined;

    return (
      normalizeQrRef(parsed.qr_code_ref) ||
      normalizeQrRef(parsed.qr_ref) ||
      normalizeQrRef(parsed.qrRef) ||
      normalizeQrRef(parsed.ref) ||
      normalizeQrRef(adminExtras?.qr_ref) ||
      normalizeQrRef(adminExtras?.qr_code_ref) ||
      normalizeQrRef(adminExtras?.qrRef) ||
      normalizeQrRef(adminExtras?.ref)
    );
  } catch {
    // not JSON
  }

  try {
    const url = new URL(raw);
    return (
      normalizeQrRef(url.searchParams.get('qr_code_ref')) ||
      normalizeQrRef(url.searchParams.get('qr_ref')) ||
      normalizeQrRef(url.searchParams.get('qrRef')) ||
      normalizeQrRef(url.searchParams.get('ref')) ||
      normalizeQrRef(url.pathname.split('/').filter(Boolean).at(-1))
    );
  } catch {
    // not a URL
  }

  return null;
}

export default function ScanScreen() {
  const router  = useGuardedRouter();
  const scheme  = useColorScheme();
  const colors  = Colors[scheme === 'dark' ? 'dark' : 'light'];
  const isDark  = scheme === 'dark';

  const [permission, requestPermission] = useCameraPermissions();
  const [manualRef, setManualRef]       = useState('');
  const [scanned, setScanned]           = useState(false);
  const [showCamera, setShowCamera]     = useState(false);
  const [checkingSaved, setCheckingSaved] = useState(true);
  const [cameraKey, setCameraKey]       = useState(0);
  const { refreshLockState, rememberQrRef, isLocked } = useDeviceLock();

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      async function checkAndRedirect() {
        // First refresh lock state from DB
        await refreshLockState();
        if (cancelled) return;

        const saved = getSavedQrRef();
        if (saved) {
          // Already linked — go straight to installment screen
          router.replace(`/installment/${encodeURIComponent(saved)}`);
        } else {
          setCheckingSaved(false);
          setShowCamera(false);
        }
      }
      setCheckingSaved(true);
      void checkAndRedirect();
      return () => {
        cancelled = true;
      };
    }, [refreshLockState, router])
  );

  function openInstallment(raw: string) {
    const ref = extractQrRef(raw);
    if (!ref) {
      Alert.alert(
        'Invalid QR Code',
        'Please scan a valid installment QR. Setup/provisioning QR and installment QR are different.'
      );
      return;
    }
    rememberQrRef(ref);
    try {
      localStorage.setItem(LAST_QR_REF_KEY, ref);
    } catch {
      // ignore
    }
    router.replace(`/installment/${encodeURIComponent(ref)}`);
  }

  async function enableCamera() {
    if (!permission?.granted) {
      const result = await requestPermission();
      if (!result.granted) {
        Alert.alert('Camera Permission', 'Camera access is needed to scan the installment QR code.');
        return;
      }
    }
    setCameraKey((k) => k + 1);
    setShowCamera(true);
  }

  // ── Loading / locked states ───────────────────────────────────────

  if (isLocked) {
    return (
      <ThemedView style={styles.centered}>
        <Text style={{ fontSize: 40 }}>🔒</Text>
        <ThemedText type="smallBold" style={{ textAlign: 'center' }}>
          Device locked by shop owner
        </ThemedText>
      </ThemedView>
    );
  }

  if (checkingSaved) {
    return (
      <ThemedView style={styles.centered}>
        <ActivityIndicator color="#2563EB" />
        <ThemedText type="small" themeColor="textSecondary">Loading…</ThemedText>
      </ThemedView>
    );
  }

  // ── Main scan screen ──────────────────────────────────────────────

  const bg = isDark ? '#0D1117' : '#F8FAFC';

  return (
    <ThemedView style={styles.container}>
      <SafeAreaView style={[styles.safe, { backgroundColor: bg }]}>

        {/* ── Header ──────────────────────────────────────────── */}
        <View style={styles.topSection}>
          <Text style={{ fontSize: 52, textAlign: 'center' }}>📱</Text>
          <ThemedText type="subtitle" style={styles.heading}>
            Scan Your QR Code
          </ThemedText>
          <ThemedText type="small" themeColor="textSecondary" style={styles.subheading}>
            Dukandaar ne aapko ek QR code diya hoga.{'\n'}
            Neeche scan karo ya code enter karo.
          </ThemedText>
        </View>

        {/* ── Camera section ───────────────────────────────────── */}
        {showCamera && permission?.granted ? (
          <View style={styles.cameraWrap}>
            <CameraView
              key={cameraKey}
              style={styles.camera}
              facing="back"
              barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
              onBarcodeScanned={
                scanned
                  ? undefined
                  : ({ data }) => {
                      setScanned(true);
                      setShowCamera(false);
                      openInstallment(data);
                      setTimeout(() => setScanned(false), 1500);
                    }
              }
            />
            {/* Corner frame */}
            <View style={styles.overlay}>
              <View style={styles.frameBox}>
                <View style={[styles.corner, styles.cTL]} />
                <View style={[styles.corner, styles.cTR]} />
                <View style={[styles.corner, styles.cBL]} />
                <View style={[styles.corner, styles.cBR]} />
              </View>
              <Text style={styles.scanHint}>Position QR code inside the frame</Text>
            </View>
            <Pressable style={styles.closeCam} onPress={() => setShowCamera(false)}>
              <Text style={styles.closeCamLabel}>✕  Close Camera</Text>
            </Pressable>
          </View>
        ) : (
          /* ── Scan Button ─── */
          <Pressable style={styles.scanBtn} onPress={() => void enableCamera()}>
            <Text style={{ fontSize: 28 }}>📷</Text>
            <Text style={styles.scanBtnLabel}>Scan Installment QR</Text>
          </Pressable>
        )}

        {/* ── Manual entry ─────────────────────────────────────── */}
        <View style={[styles.manualCard, { backgroundColor: colors.backgroundElement }]}>
          <ThemedText type="smallBold">
            Or enter code manually
          </ThemedText>
          <TextInput
            value={manualRef}
            onChangeText={setManualRef}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="INS-xxxxxxxx"
            placeholderTextColor={colors.textSecondary}
            style={[
              styles.input,
              {
                backgroundColor: isDark ? '#1E293B' : '#F1F5F9',
                color: colors.text,
                borderColor: colors.backgroundSelected,
              },
            ]}
          />
          <Pressable
            style={styles.manualBtn}
            onPress={() => {
              if (!manualRef.trim()) {
                Alert.alert('Empty Code', 'Please enter your QR reference code (e.g. INS-XXXXX).');
                return;
              }
              openInstallment(manualRef);
            }}>
            <Text style={styles.manualBtnLabel}>Open Installment →</Text>
          </Pressable>
        </View>

        {/* ── Info note ────────────────────────────────────────── */}
        <View style={[styles.infoNote, { backgroundColor: isDark ? '#1E3A8A22' : '#EFF6FF' }]}>
          <Text style={{ fontSize: 14 }}>ℹ️</Text>
          <ThemedText type="code" themeColor="textSecondary" style={{ flex: 1, lineHeight: 18 }}>
            Yeh QR code ek baar scan karne ke baad automatically yaad reh jayega.
            Dobara scan nahi karna padega.
          </ThemedText>
        </View>

      </SafeAreaView>
    </ThemedView>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────

const CORNER_SZ = 22;
const CORNER_W  = 3;

const styles = StyleSheet.create({
  container: { flex: 1 },
  safe: {
    flex: 1,
    paddingHorizontal: Spacing.three,
    paddingTop: Spacing.three,
    gap: Spacing.three,
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.two,
    padding: Spacing.four,
  },

  // Top section
  topSection: { alignItems: 'center', gap: Spacing.one, paddingTop: Spacing.two },
  heading: {
    fontSize: 22,
    fontWeight: '700',
    textAlign: 'center',
  },
  subheading: { textAlign: 'center', lineHeight: 22 },

  // Camera
  cameraWrap: {
    height: 300,
    borderRadius: 20,
    overflow: 'hidden',
    backgroundColor: '#000',
    position: 'relative',
  },
  camera: { flex: 1 },
  overlay: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.two,
  },
  frameBox: {
    width: 220, height: 220,
  },
  corner: {
    position: 'absolute',
    width: CORNER_SZ,
    height: CORNER_SZ,
    borderColor: '#60A5FA',
  },
  cTL: { top: 0,    left: 0,  borderTopWidth: CORNER_W,    borderLeftWidth: CORNER_W,  borderTopLeftRadius: 4 },
  cTR: { top: 0,    right: 0, borderTopWidth: CORNER_W,    borderRightWidth: CORNER_W, borderTopRightRadius: 4 },
  cBL: { bottom: 0, left: 0,  borderBottomWidth: CORNER_W, borderLeftWidth: CORNER_W,  borderBottomLeftRadius: 4 },
  cBR: { bottom: 0, right: 0, borderBottomWidth: CORNER_W, borderRightWidth: CORNER_W, borderBottomRightRadius: 4 },
  scanHint: {
    color: 'rgba(255,255,255,0.7)',
    fontSize: 12,
    marginTop: 240,
  },
  closeCam: {
    position: 'absolute',
    bottom: 12,
    alignSelf: 'center',
    backgroundColor: 'rgba(0,0,0,0.6)',
    borderRadius: 20,
    paddingHorizontal: 20,
    paddingVertical: 10,
  },
  closeCamLabel: { color: '#fff', fontWeight: '600', fontSize: 14 },

  // Scan button
  scanBtn: {
    backgroundColor: '#2563EB',
    borderRadius: 18,
    paddingVertical: 20,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    flexDirection: 'row',
  },
  scanBtnLabel: { color: '#fff', fontSize: 16, fontWeight: '700' },

  // Manual card
  manualCard: {
    borderRadius: 16,
    padding: Spacing.three,
    gap: Spacing.two,
  },
  input: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: Spacing.three,
    paddingVertical: 12,
    fontSize: 15,
    fontFamily: 'monospace',
  },
  manualBtn: {
    backgroundColor: '#1E293B',
    borderRadius: 10,
    alignItems: 'center',
    paddingVertical: 12,
  },
  manualBtnLabel: { color: '#fff', fontWeight: '600', fontSize: 14 },

  // Info note
  infoNote: {
    borderRadius: 12,
    padding: Spacing.two,
    flexDirection: 'row',
    gap: 8,
    alignItems: 'flex-start',
    marginBottom: Spacing.three,
  },
});
