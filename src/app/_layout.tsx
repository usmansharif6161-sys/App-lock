import 'expo-sqlite/localStorage/install';

import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect } from 'react';
import { useColorScheme } from 'react-native';

import { DeviceLockProvider, useDeviceLock } from '@/components/device-lock';
import { Colors } from '@/constants/theme';

SplashScreen.preventAutoHideAsync();

function RootNavigator() {
  const colorScheme = useColorScheme();
  const colors = Colors[colorScheme === 'dark' ? 'dark' : 'light'];
  const { isLocked } = useDeviceLock();

  return (
    <Stack
      screenOptions={{
        headerShown: !isLocked,
        gestureEnabled: !isLocked,
        headerStyle: { backgroundColor: colors.background },
        headerTintColor: colors.text,
        headerTitleStyle: { fontWeight: '600' },
        contentStyle: { backgroundColor: isLocked ? '#111827' : colors.background },
        animation: 'none',
      }}>
      <Stack.Screen name="index" options={{ title: 'Scan QR' }} />
      <Stack.Screen name="installment/[ref]" options={{ title: 'My Installment' }} />
    </Stack>
  );
}

export default function RootLayout() {
  useEffect(() => {
    void SplashScreen.hideAsync();
  }, []);

  return (
    <DeviceLockProvider>
      <RootNavigator />
    </DeviceLockProvider>
  );
}
