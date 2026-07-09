import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Palette, Radius, Spacing, Typography } from '@/constants/theme';

type Variant = 'success' | 'error' | 'info';
type ToastState = { id: number; message: string; variant: Variant };

type ToastApi = {
  show: (message: string, variant?: Variant) => void;
  success: (message: string) => void;
  error: (message: string) => void;
  info: (message: string) => void;
};

const ToastContext = createContext<ToastApi | null>(null);

/** Access the toast API. Must be used under `ToastProvider`. */
export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return ctx;
}

const ACCENTS: Record<Variant, string> = {
  success: Palette.statusUp,
  error: Palette.statusDown,
  info: Palette.lilac,
};

/** Provides `useToast()` and renders a single auto-dismissing toast at the bottom of the app. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<ToastState | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const show = useCallback((message: string, variant: Variant = 'info') => {
    if (timer.current) clearTimeout(timer.current);
    setToast({ id: Date.now(), message, variant });
    timer.current = setTimeout(() => setToast(null), 3200);
  }, []);

  const api = useMemo<ToastApi>(
    () => ({
      show,
      success: (m) => show(m, 'success'),
      error: (m) => show(m, 'error'),
      info: (m) => show(m, 'info'),
    }),
    [show],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      {toast ? (
        <SafeAreaView style={styles.host} edges={['bottom']} pointerEvents="none">
          <View style={[styles.toast, { borderLeftColor: ACCENTS[toast.variant] }]}>
            <Text style={styles.text}>{toast.message}</Text>
          </View>
        </SafeAreaView>
      ) : null}
    </ToastContext.Provider>
  );
}

const styles = StyleSheet.create({
  host: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    paddingHorizontal: Spacing.four,
    paddingBottom: Spacing.six,
  },
  toast: {
    maxWidth: 520,
    width: '100%',
    backgroundColor: Palette.bgElevated,
    borderRadius: Radius.input,
    borderLeftWidth: 3,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Palette.glassBorder,
    paddingVertical: Spacing.three,
    paddingHorizontal: Spacing.four,
  },
  text: { ...Typography.caption, color: Palette.white },
});
