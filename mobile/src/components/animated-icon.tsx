import { Image } from 'expo-image';
import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, {
  Easing,
  FadeIn,
  FadeOut,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

import { Palette, Radius, Spacing, Typography } from '@/constants/theme';

const LOGO = require('@/assets/images/brand-symbol.png');
const GLOW = require('@/assets/images/logo-glow.png');

// Indeterminate progress bar geometry.
const TRACK = 140;
const SEGMENT = 48;

/**
 * BrandedLoading — Prova's on-brand loading screen. The chartreuse mark breathes over a soft
 * pulsing glow, with an indeterminate progress shimmer beneath it. Fills its parent on the dark
 * base color, so it works both as the boot overlay and as an in-app loading state.
 */
export function BrandedLoading({ caption }: { caption?: string }) {
  const pulse = useSharedValue(0); // glow: opacity + scale
  const breathe = useSharedValue(0); // logo: gentle scale
  const slide = useSharedValue(0); // progress segment travel

  useEffect(() => {
    pulse.value = withRepeat(
      withTiming(1, { duration: 1600, easing: Easing.inOut(Easing.quad) }),
      -1,
      true,
    );
    breathe.value = withRepeat(
      withTiming(1, { duration: 1900, easing: Easing.inOut(Easing.quad) }),
      -1,
      true,
    );
    slide.value = withRepeat(
      withTiming(1, { duration: 1150, easing: Easing.inOut(Easing.ease) }),
      -1,
      false,
    );
  }, [breathe, pulse, slide]);

  const glowStyle = useAnimatedStyle(() => ({
    opacity: 0.4 + pulse.value * 0.45,
    transform: [{ scale: 0.82 + pulse.value * 0.3 }],
  }));
  const logoStyle = useAnimatedStyle(() => ({
    transform: [{ scale: 0.97 + breathe.value * 0.06 }],
  }));
  const segmentStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: -SEGMENT + slide.value * (TRACK + SEGMENT) }],
  }));

  return (
    <View style={styles.fill}>
      <Animated.View entering={FadeIn.duration(500)} style={styles.center}>
        <View style={styles.logoWrap}>
          <Animated.View style={[styles.glow, glowStyle]}>
            <Image style={styles.glowImage} source={GLOW} contentFit="contain" />
          </Animated.View>
          <Animated.View style={logoStyle}>
            <Image style={styles.logo} source={LOGO} contentFit="contain" />
          </Animated.View>
        </View>

        <View style={styles.track}>
          <Animated.View style={[styles.segment, segmentStyle]} />
        </View>
        {caption ? <Text style={styles.caption}>{caption}</Text> : null}
      </Animated.View>
    </View>
  );
}

/**
 * AnimatedSplashOverlay — plays the branded loading screen once over the app after the native
 * splash hides, then fades out. A seamless aesthetic bridge while the first screen mounts (the
 * native splash uses the same mark + background, so there is no visual jump).
 */
export function AnimatedSplashOverlay() {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const t = setTimeout(() => setVisible(false), 1100);
    return () => clearTimeout(t);
  }, []);

  if (!visible) return null;

  return (
    <Animated.View exiting={FadeOut.duration(420)} style={styles.overlay}>
      <BrandedLoading />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  fill: {
    flex: 1,
    backgroundColor: Palette.bgBase,
    alignItems: 'center',
    justifyContent: 'center',
  },
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: Palette.bgBase,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000,
  },
  center: { alignItems: 'center' },
  logoWrap: {
    width: 168,
    height: 168,
    alignItems: 'center',
    justifyContent: 'center',
  },
  glow: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  glowImage: { width: 240, height: 240 },
  logo: { width: 92, height: 92 },
  track: {
    width: TRACK,
    height: 3,
    borderRadius: Radius.pill,
    backgroundColor: 'rgba(255,255,255,0.08)',
    overflow: 'hidden',
    marginTop: Spacing.six,
  },
  segment: {
    width: SEGMENT,
    height: 3,
    borderRadius: Radius.pill,
    backgroundColor: Palette.accent,
  },
  caption: {
    ...Typography.caption,
    color: Palette.textSecondary,
    marginTop: Spacing.four,
  },
});
