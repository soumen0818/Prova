import {
  Urbanist_400Regular,
  Urbanist_500Medium,
  Urbanist_600SemiBold,
  Urbanist_700Bold,
  useFonts,
} from '@expo-google-fonts/urbanist';
import { QueryClientProvider } from '@tanstack/react-query';
import { DarkTheme, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';

import { AnimatedSplashOverlay } from '@/components/animated-icon';
import { AppLock } from '@/components/app-lock';
import AppTabs from '@/components/app-tabs';
import { ConnectionBanner } from '@/components/connection-banner';
import { ErrorBoundary } from '@/components/error-boundary';
import { OnboardingGate } from '@/components/onboarding-gate';
import { ToastProvider } from '@/components/toast';
import { initReporting } from '@/lib/reporting';
import { queryClient } from '@/lib/queries';
import { Palette } from '@/constants/theme';

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
            <OnboardingGate>
              <AppLock>
                <AppTabs />
                <ConnectionBanner />
              </AppLock>
            </OnboardingGate>
          </ToastProvider>
        </ThemeProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}
