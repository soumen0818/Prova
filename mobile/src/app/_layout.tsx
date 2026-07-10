import {
  Urbanist_400Regular,
  Urbanist_500Medium,
  Urbanist_600SemiBold,
  Urbanist_700Bold,
  useFonts,
} from '@expo-google-fonts/urbanist';
import { QueryClientProvider } from '@tanstack/react-query';
import { DarkTheme, Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';

import { AnimatedSplashOverlay } from '@/components/animated-icon';
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

  useEffect(() => {
    if (fontsLoaded) {
      SplashScreen.hideAsync().catch(() => {
        /* no-op */
      });
    }
  }, [fontsLoaded]);

  // Hold the native splash (render nothing) until fonts resolve, to avoid a fallback-font flash.
  if (!fontsLoaded) return null;

  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider value={ProvaNavTheme}>
          <ToastProvider>
            <StatusBar style="light" />
            <AnimatedSplashOverlay />
            <AppLock>
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
                <Stack.Screen name="phone" options={{ headerShown: false }} />
                <Stack.Screen name="otp" options={{ headerShown: false }} />
                <Stack.Screen name="profile-setup" options={{ headerShown: false }} />
                {/* Pushed flows get a themed native header + back button. */}
                <Stack.Screen name="send" options={{ title: 'Send' }} />
                <Stack.Screen name="deposit" options={{ title: 'Add money' }} />
                <Stack.Screen name="kyc" options={{ title: 'Verify identity' }} />
                <Stack.Screen name="recipients" options={{ title: 'Recipients' }} />
                <Stack.Screen name="recipient-new" options={{ title: 'New recipient' }} />
                <Stack.Screen name="settings" options={{ title: 'Settings' }} />
              </Stack>
            </AppLock>
            <ConnectionBanner />
          </ToastProvider>
        </ThemeProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}
