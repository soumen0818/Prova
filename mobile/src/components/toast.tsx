import { CheckCircle2, Info, XCircle } from 'lucide-react-native';
import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { StyleSheet, Text } from 'react-native';
import Animated, { FadeInDown, FadeOutUp } from 'react-native-reanimated';
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

const ICONS: Record<Variant, typeof Info> = {
  success: CheckCircle2,
  error: XCircle,
  info: Info,
};

/** Provides `useToast()` and renders a single auto-dismissing toast at the top of the app. */
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

  const Icon = toast ? ICONS[toast.variant] : Info;

  return (
    <ToastContext.Provider value={api}>
      {children}
      {toast ? (
        <SafeAreaView style={styles.host} edges={['top']} pointerEvents="none">
          <Animated.View
            key={toast.id}
            entering={FadeInDown.springify().damping(18)}
            exiting={FadeOutUp.duration(200)}
            style={[styles.toast, { borderLeftColor: ACCENTS[toast.variant] }]}>
            <Icon color={ACCENTS[toast.variant]} size={18} strokeWidth={2.2} />
            <Text style={styles.text}>{toast.message}</Text>
          </Animated.View>
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
    top: 0,
    alignItems: 'center',
    paddingHorizontal: Spacing.four,
    paddingTop: Spacing.three,
  },
  toast: {
    maxWidth: 520,
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
    backgroundColor: Palette.bgElevated,
    borderRadius: Radius.input,
    borderLeftWidth: 3,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Palette.glassBorder,
    paddingVertical: Spacing.three,
    paddingHorizontal: Spacing.four,
    // Subtle lift so it reads above the content it overlays.
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.35,
    shadowRadius: 12,
    elevation: 8,
  },
  text: { ...Typography.caption, color: Palette.white, flex: 1 },
});
