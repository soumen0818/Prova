import { CloudOff, SignalLow, Wrench } from 'lucide-react-native';
import { StyleSheet, Text } from 'react-native';
import Animated, { FadeInDown, FadeOutUp } from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useConnectivity, type ConnectionState } from '@/lib/connectivity';
import { Palette, Spacing, Typography } from '@/constants/theme';

/** Per-state banner copy. Each says what is wrong *and* what the user should do about it. */
const BANNERS: Partial<
  Record<ConnectionState, { text: string; color: string; Icon: typeof CloudOff }>
> = {
  offline: {
    text: 'You’re offline. Payments are paused until you reconnect.',
    color: Palette.statusDown,
    Icon: CloudOff,
  },
  unreachable: {
    text: 'Can’t reach Prova. We’ll keep trying.',
    color: Palette.statusDown,
    Icon: CloudOff,
  },
  maintenance: {
    text: 'Scheduled maintenance — your funds are safe.',
    color: Palette.lilac,
    Icon: Wrench,
  },
  slow: {
    text: 'Weak connection. Please wait — don’t close the app.',
    color: Palette.accent,
    Icon: SignalLow,
  },
};

/**
 * Always-visible connectivity strip.
 *
 * Deliberately non-blocking: it *informs* on every screen, while the hard gate that stops a payment
 * lives in `ConnectionGate`. The slow-connection case is the important one for a money app — the
 * user must know the network is bad *before* they tap Send, so they don't fire a second payment.
 */
export function ConnectionBanner() {
  const { state, isChecking } = useConnectivity();
  const banner = BANNERS[state];
  if (isChecking || !banner) return null;

  const { text, color, Icon } = banner;
  const onAccent = color === Palette.accent;

  return (
    <SafeAreaView style={styles.host} edges={['top']} pointerEvents="none">
      <Animated.View
        entering={FadeInDown.duration(220)}
        exiting={FadeOutUp.duration(180)}
        style={[styles.banner, { backgroundColor: color }]}>
        <Icon color={onAccent ? Palette.onAccent : Palette.white} size={14} strokeWidth={2} />
        <Text style={[styles.text, onAccent && styles.textOnAccent]}>{text}</Text>
      </Animated.View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  host: { position: 'absolute', top: 0, left: 0, right: 0, zIndex: 50, alignItems: 'center' },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    paddingVertical: Spacing.two,
    paddingHorizontal: Spacing.four,
    borderBottomLeftRadius: 12,
    borderBottomRightRadius: 12,
    maxWidth: '94%',
  },
  text: { ...Typography.micro, color: Palette.white, fontWeight: '600', flexShrink: 1 },
  textOnAccent: { color: Palette.onAccent },
});
