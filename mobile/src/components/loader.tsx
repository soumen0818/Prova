import { useEffect } from 'react';
import { StyleSheet, View, type ViewStyle } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';

import { Palette } from '@/constants/theme';

/**
 * The app-wide loader — three accent dots pulsing in a gentle staggered wave. One indeterminate
 * indicator used everywhere a spinner would go: inline in buttons, in a screen's centre, in a row.
 * Scales via `size` (dot diameter). Pure Reanimated (UI thread), calm and on-brand.
 */
export function Loader({
  size = 8,
  color = Palette.accent,
  style,
}: {
  size?: number;
  color?: string;
  style?: ViewStyle;
}) {
  const a = useSharedValue(0);
  const b = useSharedValue(0);
  const c = useSharedValue(0);

  useEffect(() => {
    const wave = () =>
      withRepeat(
        withSequence(
          withTiming(1, { duration: 480, easing: Easing.inOut(Easing.quad) }),
          withTiming(0, { duration: 480, easing: Easing.inOut(Easing.quad) }),
        ),
        -1,
      );
    a.value = wave();
    b.value = withDelay(150, wave());
    c.value = withDelay(300, wave());
  }, [a, b, c]);

  const s1 = useAnimatedStyle(() => ({
    opacity: 0.35 + a.value * 0.65,
    transform: [{ scale: 0.6 + a.value * 0.4 }],
  }));
  const s2 = useAnimatedStyle(() => ({
    opacity: 0.35 + b.value * 0.65,
    transform: [{ scale: 0.6 + b.value * 0.4 }],
  }));
  const s3 = useAnimatedStyle(() => ({
    opacity: 0.35 + c.value * 0.65,
    transform: [{ scale: 0.6 + c.value * 0.4 }],
  }));

  const dot: ViewStyle = {
    width: size,
    height: size,
    borderRadius: size / 2,
    backgroundColor: color,
  };

  return (
    <View style={[styles.row, { gap: Math.max(4, size * 0.6) }, style]}>
      <Animated.View style={[dot, s1]} />
      <Animated.View style={[dot, s2]} />
      <Animated.View style={[dot, s3]} />
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center' },
});
