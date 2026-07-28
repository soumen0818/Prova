/**
 * Animated vector illustrations for the app's state screens.
 *
 * All pure SVG + Reanimated — no raster assets and no emoji, so they stay crisp at any size, follow
 * the theme, and add nothing to the bundle. Each one is a single expressive motion (a check that
 * draws itself, a pulsing signal, a settling stack) rather than a looping cartoon: the point is to
 * communicate state instantly, not to entertain while someone waits on their money.
 */
import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
  Easing,
  useAnimatedProps,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import Svg, { Circle, Line, Path, Rect } from 'react-native-svg';

import { Palette } from '@/constants/theme';

const AnimatedPath = Animated.createAnimatedComponent(Path);
const AnimatedCircle = Animated.createAnimatedComponent(Circle);

const SIZE = 96;

/** Shared ring that all illustrations sit inside, so every state screen has one silhouette. */
function Halo({ color, children }: { color: string; children: React.ReactNode }) {
  return (
    <View style={[styles.halo, { borderColor: color + '33', backgroundColor: color + '14' }]}>
      {children}
    </View>
  );
}

/**
 * Success — a check mark that draws itself once. Deliberately quick (450ms) and non-looping: a
 * completed payment should feel resolved, and the user shouldn't wait on an animation to read it.
 */
export function SuccessMark({ color = Palette.statusUp }: { color?: string }) {
  const draw = useSharedValue(0);
  const pop = useSharedValue(0);

  useEffect(() => {
    pop.value = withTiming(1, { duration: 260, easing: Easing.out(Easing.back(2)) });
    draw.value = withDelay(140, withTiming(1, { duration: 450, easing: Easing.out(Easing.cubic) }));
  }, [draw, pop]);

  // 48 is the check path length; offset walks it from hidden to fully drawn.
  const checkProps = useAnimatedProps(() => ({ strokeDashoffset: 48 * (1 - draw.value) }));
  const ringStyle = useAnimatedStyle(() => ({
    transform: [{ scale: 0.85 + pop.value * 0.15 }],
    opacity: pop.value,
  }));

  return (
    <Animated.View style={ringStyle}>
      <Halo color={color}>
        <Svg width={SIZE} height={SIZE} viewBox="0 0 48 48">
          <Circle
            cx="24"
            cy="24"
            r="20"
            stroke={color}
            strokeWidth={2}
            fill="none"
            opacity={0.35}
          />
          <AnimatedPath
            d="M15 24.5 L21.5 31 L33 19"
            stroke={color}
            strokeWidth={3.2}
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
            strokeDasharray={48}
            animatedProps={checkProps}
          />
        </Svg>
      </Halo>
    </Animated.View>
  );
}

/** Failure — a cross that draws itself. Same language as success, opposite meaning. */
export function ErrorMark({ color = Palette.statusDown }: { color?: string }) {
  const draw = useSharedValue(0);
  useEffect(() => {
    draw.value = withTiming(1, { duration: 380, easing: Easing.out(Easing.cubic) });
  }, [draw]);
  const a = useAnimatedProps(() => ({ strokeDashoffset: 24 * (1 - draw.value) }));
  const b = useAnimatedProps(() => ({
    strokeDashoffset: 24 * (1 - Math.max(0, draw.value - 0.3)),
  }));

  return (
    <Halo color={color}>
      <Svg width={SIZE} height={SIZE} viewBox="0 0 48 48">
        <Circle cx="24" cy="24" r="20" stroke={color} strokeWidth={2} fill="none" opacity={0.35} />
        <AnimatedPath
          d="M17 17 L31 31"
          stroke={color}
          strokeWidth={3.2}
          strokeLinecap="round"
          strokeDasharray={24}
          animatedProps={a}
        />
        <AnimatedPath
          d="M31 17 L17 31"
          stroke={color}
          strokeWidth={3.2}
          strokeLinecap="round"
          strokeDasharray={24}
          animatedProps={b}
        />
      </Svg>
    </Halo>
  );
}

/** Offline — a signal tower whose waves fade out, with the link struck through. */
export function OfflineMark({ color = Palette.textSecondary }: { color?: string }) {
  const fade = useSharedValue(0);
  useEffect(() => {
    fade.value = withRepeat(
      withSequence(withTiming(1, { duration: 900 }), withTiming(0.15, { duration: 900 })),
      -1,
      true,
    );
  }, [fade]);
  const outer = useAnimatedProps(() => ({ opacity: 0.15 + (1 - fade.value) * 0.35 }));

  return (
    <Halo color={color}>
      <Svg width={SIZE} height={SIZE} viewBox="0 0 48 48">
        <AnimatedCircle
          cx="24"
          cy="30"
          r="15"
          stroke={color}
          strokeWidth={2}
          fill="none"
          animatedProps={outer}
        />
        <Circle cx="24" cy="30" r="9" stroke={color} strokeWidth={2} fill="none" opacity={0.5} />
        <Circle cx="24" cy="30" r="3" fill={color} />
        <Line
          x1="12"
          y1="12"
          x2="36"
          y2="36"
          stroke={Palette.statusDown}
          strokeWidth={3}
          strokeLinecap="round"
        />
      </Svg>
    </Halo>
  );
}

/** Processing — an orbiting dot, the one deliberately looping illustration (work is ongoing). */
export function ProcessingMark({ color = Palette.accent }: { color?: string }) {
  const spin = useSharedValue(0);
  useEffect(() => {
    spin.value = withRepeat(withTiming(1, { duration: 1600, easing: Easing.linear }), -1, false);
  }, [spin]);
  const style = useAnimatedStyle(() => ({ transform: [{ rotate: `${spin.value * 360}deg` }] }));

  return (
    <Halo color={color}>
      <Svg width={SIZE} height={SIZE} viewBox="0 0 48 48" style={StyleSheet.absoluteFill}>
        <Circle cx="24" cy="24" r="18" stroke={color} strokeWidth={2} fill="none" opacity={0.25} />
      </Svg>
      <Animated.View style={[styles.orbit, style]}>
        <Svg width={SIZE} height={SIZE} viewBox="0 0 48 48">
          <Circle cx="24" cy="6" r="3.4" fill={color} />
        </Svg>
      </Animated.View>
    </Halo>
  );
}

/** Maintenance — tools/gear resting, communicating "planned", not "broken". */
export function MaintenanceMark({ color = Palette.lilac }: { color?: string }) {
  const tilt = useSharedValue(0);
  useEffect(() => {
    tilt.value = withRepeat(
      withTiming(1, { duration: 2400, easing: Easing.inOut(Easing.quad) }),
      -1,
      true,
    );
  }, [tilt]);
  const style = useAnimatedStyle(() => ({ transform: [{ rotate: `${tilt.value * 40}deg` }] }));

  return (
    <Halo color={color}>
      <Animated.View style={style}>
        <Svg width={SIZE} height={SIZE} viewBox="0 0 48 48">
          <Circle cx="24" cy="24" r="8" stroke={color} strokeWidth={2.6} fill="none" />
          <Circle cx="24" cy="24" r="2.5" fill={color} />
          {[0, 60, 120, 180, 240, 300].map((deg) => {
            const r = (deg * Math.PI) / 180;
            return (
              <Line
                key={deg}
                x1={24 + Math.cos(r) * 11}
                y1={24 + Math.sin(r) * 11}
                x2={24 + Math.cos(r) * 15}
                y2={24 + Math.sin(r) * 15}
                stroke={color}
                strokeWidth={2.6}
                strokeLinecap="round"
              />
            );
          })}
        </Svg>
      </Animated.View>
    </Halo>
  );
}

/** Locked / access denied — a padlock with a shackle that settles shut. */
export function LockedMark({ color = Palette.statusDown }: { color?: string }) {
  const drop = useSharedValue(0);
  useEffect(() => {
    drop.value = withTiming(1, { duration: 480, easing: Easing.out(Easing.back(1.6)) });
  }, [drop]);
  const style = useAnimatedStyle(() => ({ transform: [{ translateY: (1 - drop.value) * -6 }] }));

  return (
    <Halo color={color}>
      <Animated.View style={style}>
        <Svg width={SIZE} height={SIZE} viewBox="0 0 48 48">
          <Path
            d="M17 22 v-4 a7 7 0 0 1 14 0 v4"
            stroke={color}
            strokeWidth={2.8}
            fill="none"
            strokeLinecap="round"
          />
          <Rect
            x="13"
            y="22"
            width="22"
            height="16"
            rx="4"
            stroke={color}
            strokeWidth={2.8}
            fill="none"
          />
          <Circle cx="24" cy="30" r="2.4" fill={color} />
        </Svg>
      </Animated.View>
    </Halo>
  );
}

/** Not found — a magnifier that sweeps once, then rests. */
export function NotFoundMark({ color = Palette.textSecondary }: { color?: string }) {
  const sweep = useSharedValue(0);
  useEffect(() => {
    sweep.value = withRepeat(
      withTiming(1, { duration: 2000, easing: Easing.inOut(Easing.quad) }),
      -1,
      true,
    );
  }, [sweep]);
  const style = useAnimatedStyle(() => ({
    transform: [{ translateX: -4 + sweep.value * 8 }, { rotate: `${-6 + sweep.value * 12}deg` }],
  }));

  return (
    <Halo color={color}>
      <Animated.View style={style}>
        <Svg width={SIZE} height={SIZE} viewBox="0 0 48 48">
          <Circle cx="21" cy="21" r="11" stroke={color} strokeWidth={2.8} fill="none" />
          <Line
            x1="29"
            y1="29"
            x2="37"
            y2="37"
            stroke={color}
            strokeWidth={3}
            strokeLinecap="round"
          />
        </Svg>
      </Animated.View>
    </Halo>
  );
}

/** Empty — a light, friendly stack of cards that breathes. Used for all "nothing here yet" states. */
export function EmptyMark({ color = Palette.accent }: { color?: string }) {
  const rise = useSharedValue(0);
  useEffect(() => {
    rise.value = withRepeat(
      withTiming(1, { duration: 2200, easing: Easing.inOut(Easing.quad) }),
      -1,
      true,
    );
  }, [rise]);
  const style = useAnimatedStyle(() => ({ transform: [{ translateY: -2 + rise.value * 4 }] }));

  return (
    <Halo color={color}>
      <Animated.View style={style}>
        <Svg width={SIZE} height={SIZE} viewBox="0 0 48 48">
          <Rect
            x="9"
            y="14"
            width="30"
            height="10"
            rx="3"
            stroke={color}
            strokeWidth={2.2}
            fill="none"
            opacity={0.35}
          />
          <Rect
            x="7"
            y="22"
            width="34"
            height="16"
            rx="4"
            stroke={color}
            strokeWidth={2.6}
            fill="none"
          />
          <Line
            x1="13"
            y1="30"
            x2="23"
            y2="30"
            stroke={color}
            strokeWidth={2.4}
            strokeLinecap="round"
            opacity={0.7}
          />
        </Svg>
      </Animated.View>
    </Halo>
  );
}

const styles = StyleSheet.create({
  halo: {
    width: 128,
    height: 128,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  orbit: { position: 'absolute', width: SIZE, height: SIZE },
});
