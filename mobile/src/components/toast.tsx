import { CheckCircle2, Info, XCircle } from 'lucide-react-native';
import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
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

/** Faint variant tint for the icon chip (keeps the glass look, adds a glanceable colour). */
const CHIP_BG: Record<Variant, string> = {
  success: 'rgba(63,174,111,0.16)',
  error: 'rgba(192,71,60,0.18)',
  info: 'rgba(220,203,247,0.16)',
};

const ICONS: Record<Variant, typeof Info> = {
  success: CheckCircle2,
  error: XCircle,
  info: Info,
};

/** Provides `useToast()` and renders a single auto-dismissing glass toast at the top of the app. */
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
            style={styles.shadow}>
            <View style={[styles.clip, { borderColor: ACCENTS[toast.variant] + '55' }]}>
              {/* A coloured rail carries the status at a glance, without tinting the whole
                  surface — which at this size turns into a solid block of colour and fights the
                  text for contrast. */}
              <View style={[styles.rail, { backgroundColor: ACCENTS[toast.variant] }]} />
              <View style={styles.surface}>
                <View style={[styles.iconChip, { backgroundColor: CHIP_BG[toast.variant] }]}>
                  <Icon color={ACCENTS[toast.variant]} size={15} strokeWidth={2.4} />
                </View>
                <Text style={styles.text}>{toast.message}</Text>
              </View>
            </View>
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
    // Clears the navigation header. At the previous offset the toast landed on top of the screen
    // title, so a success message hid the very heading telling you where you were.
    paddingTop: Spacing.seven,
  },
  shadow: {
    maxWidth: 520,
    width: '100%',
    borderRadius: Radius.card,
    // Soft lift so the glass floats above the content it overlays.
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.4,
    shadowRadius: 16,
    elevation: 10,
  },
  clip: {
    flexDirection: 'row',
    alignItems: 'stretch',
    borderRadius: Radius.card,
    overflow: 'hidden',
    borderWidth: 1,
    // Solid, not glass: expo-blur's Android blur needs a configured `blurTarget` to actually blur
    // (see the "dimezisBlurView... fallback to none" warning) — without it the view is just an
    // invisible no-op, which read as "the toast has no background at all". A flat surface color
    // is simpler and always correct, on every Android version, with no experimental API involved.
    backgroundColor: Palette.bgElevated,
  },
  rail: { width: 4 },
  surface: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
    paddingVertical: Spacing.four,
    paddingHorizontal: Spacing.four,
  },
  iconChip: {
    width: 26,
    height: 26,
    borderRadius: Radius.full,
    alignItems: 'center',
    justifyContent: 'center',
  },
  text: { ...Typography.caption, color: Palette.white, flex: 1, lineHeight: 19 },
});
