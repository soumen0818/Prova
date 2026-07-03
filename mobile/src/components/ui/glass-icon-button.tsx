import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View, type PressableProps, type ViewStyle } from 'react-native';

import { Palette, Radius } from '@/constants/theme';

type GlassIconButtonProps = Omit<PressableProps, 'style' | 'children'> & {
  children: ReactNode;
  size?: number;
  /** Show a small notification dot (top-right). */
  badge?: boolean;
  style?: ViewStyle;
};

/**
 * Circular translucent "glass" button that holds a single icon — the bell/gear/back/quick-action
 * controls from the reference UI. See design-system.md §6.
 */
export function GlassIconButton({
  children,
  size = 44,
  badge = false,
  style,
  ...rest
}: GlassIconButtonProps) {
  return (
    <Pressable
      accessibilityRole="button"
      style={({ pressed }) => [
        styles.base,
        { width: size, height: size, borderRadius: Radius.full },
        pressed && styles.pressed,
        style,
      ]}
      {...rest}>
      {children}
      {badge && <View style={styles.badge} />}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Palette.glass,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Palette.glassBorder,
  },
  pressed: {
    opacity: 0.7,
  },
  badge: {
    position: 'absolute',
    top: 10,
    right: 10,
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: Palette.statusNotify,
  },
});
