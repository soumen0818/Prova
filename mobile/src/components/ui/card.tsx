import type { ReactNode } from 'react';
import { StyleSheet, View, type ViewStyle } from 'react-native';

import { Palette, Radius, Spacing } from '@/constants/theme';

type CardTone = 'elevated' | 'accent' | 'lilac';

type CardProps = {
  children: ReactNode;
  tone?: CardTone;
  style?: ViewStyle;
};

/**
 * Rounded surface container. `elevated` is the default dark card; `accent`/`lilac` are the colored
 * highlight cards from the reference UI (use sparingly). See design-system.md §6.
 */
export function Card({ children, tone = 'elevated', style }: CardProps) {
  return <View style={[styles.base, toneStyles[tone], style]}>{children}</View>;
}

const styles = StyleSheet.create({
  base: {
    borderRadius: Radius.card,
    padding: Spacing.five,
  },
});

const toneStyles: Record<CardTone, ViewStyle> = {
  elevated: {
    backgroundColor: Palette.bgElevated,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Palette.border,
  },
  accent: {
    backgroundColor: Palette.accent,
  },
  lilac: {
    backgroundColor: Palette.lilac,
  },
};
