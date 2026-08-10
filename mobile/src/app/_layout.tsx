import {
  Urbanist_400Regular,
  Urbanist_500Medium,
  Urbanist_600SemiBold,
  Urbanist_700Bold,
  useFonts,
} from '@expo-google-fonts/urbanist';
import { QueryClientProvider } from '@tanstack/react-query';

import { usePoolSync } from '@/hooks/use-pool';
import { usesPool } from '@/hooks/use-money';
import { warmUpProver } from '@/lib/pool';
import { DarkTheme, Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useState } from 'react';

import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ApproveProvider } from '@/components/approve-sheet';
import { AppLock } from '@/components/app-lock';
import { ConnectionBanner } from '@/components/connection-banner';
import { ErrorBoundary } from '@/components/error-boundary';
import { ToastProvider } from '@/components/toast';
import { initReporting } from '@/lib/reporting';
import { queryClient } from '@/lib/queries';
import { FontFamily, Palette } from '@/constants/theme';

// Keep the native splash up until the brand fonts are ready.
SplashScreen.preventAutoHideAsync().catch(() => {
  /* no-op: splash may already be hidden */
});

// Dark-first navigation theme tinted with Prova tokens.
const ProvaNavTheme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    primary: Palette.accent,
    background: Palette.bgBase,
    card: Palette.bgBase,
    text: Palette.white,
    border: Palette.border,
  },
};

/**
 * Background work that must run for the whole session, mounted inside the query provider.
 *
 * Kept as a component rather than an effect in RootLayout because both hooks need the React Query
 * client, which only exists below the provider.
 */
function PoolSync() {
  // Only meaningful when money actually lives in the pool; in simulated mode there is nothing to
  // scan for and no prover cost worth paying up front.
  usePoolSync(usesPool);

  useEffect(() => {
    if (!usesPool) return;
    // ~1s of proving-key derivation. Doing it here means it lands while the user is reading the
    // home screen instead of inside their first send.
    void warmUpProver();
  }, []);

  return null;
}

export default function RootLayout() {
  const [fontsLoaded] = useFonts({
    Urbanist_400Regular,
    Urbanist_500Medium,
    Urbanist_600SemiBold,
    Urbanist_700Bold,
  });

  useEffect(() => {
    initReporting();
  }, []);

  // The native splash stays up until the app can show something real: fonts ready AND the lock
  // decision made. There is deliberately no JS loading screen in between — for a payments app a
  // spinner on launch is noise, and the gap it used to fill was really AppLock painting an empty
  // full-screen overlay while it decided, which read as a black flash.
  const [lockResolved, setLockResolved] = useState(false);
  const onLockResolved = useCallback(() => setLockResolved(true), []);
  const ready = fontsLoaded && lockResolved;

  useEffect(() => {
    if (ready) {
      SplashScreen.hideAsync().catch(() => {
        /* no-op: already hidden */
      });
    }
  }, [ready]);

  // Fonts gate the tree because rendering brand text in a fallback face and swapping it a frame
  // later is its own visible flash. The splash is still covering this, so nothing shows through.
  if (!fontsLoaded) return null;

  return (
    <ErrorBoundary>
      <SafeAreaProvider>
        <QueryClientProvider client={queryClient}>
          <PoolSync />
          <ThemeProvider value={ProvaNavTheme}>
            <ToastProvider>
              <ApproveProvider>
                <StatusBar style="light" />
                <AppLock onResolved={onLockResolved}>
                  <Stack
                    screenOptions={{
                      headerStyle: { backgroundColor: Palette.bgBase },
                      headerTintColor: Palette.white,
                      headerTitleStyle: { fontFamily: FontFamily.semibold },
                      headerShadowVisible: false,
                      contentStyle: { backgroundColor: Palette.bgBase },
                      headerBackButtonDisplayMode: 'minimal',
                    }}>
                    {/* Gated root + auth flow render their own chrome. */}
                    <Stack.Screen name="index" options={{ headerShown: false }} />
                    <Stack.Screen name="welcome" options={{ headerShown: false }} />
                    <Stack.Screen name="email" options={{ headerShown: false }} />
                    <Stack.Screen name="otp" options={{ headerShown: false }} />
                    <Stack.Screen name="set-pin" options={{ headerShown: false }} />
                    <Stack.Screen name="restore" options={{ headerShown: false }} />
                    {/* Pushed flows get a themed native header + back button. */}
                    <Stack.Screen name="account" options={{ title: 'Account details' }} />
                    <Stack.Screen name="receive" options={{ title: 'Receive privately' }} />
                    <Stack.Screen name="backup" options={{ title: 'Cloud backup' }} />
                    <Stack.Screen name="blocked" options={{ headerShown: false }} />
                    <Stack.Screen name="send" options={{ title: 'Send' }} />
                    <Stack.Screen name="deposit" options={{ title: 'Add money' }} />
                    <Stack.Screen name="anchor" options={{ title: 'Add funds' }} />
                    <Stack.Screen name="kyc" options={{ title: 'Verify identity' }} />
                    <Stack.Screen name="recipients" options={{ title: 'Recipients' }} />
                    <Stack.Screen name="recipient-new" options={{ title: 'New recipient' }} />
                    <Stack.Screen name="settings" options={{ title: 'Settings' }} />
                    <Stack.Screen name="legal" options={{ title: 'Legal' }} />
                    <Stack.Screen name="support" options={{ title: 'Chat with us' }} />
                    <Stack.Screen name="pool-benchmark" options={{ title: 'Proving benchmark' }} />
                  </Stack>
                </AppLock>
                <ConnectionBanner />
              </ApproveProvider>
            </ToastProvider>
          </ThemeProvider>
        </QueryClientProvider>
      </SafeAreaProvider>
    </ErrorBoundary>
  );
}
