import type { ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Button } from '@/components/ui';
import { Palette, Spacing, Typography } from '@/constants/theme';

/**
 * The shared shape of every error / empty / success state: illustration, headline, explanation,
 * one primary action and optional secondary ones.
 *
 * Having a single component matters for a money app — a user who hits "no internet", "payment
 * declined" and "no recipients yet" should feel the same steady hand each time, not three different
 * designs. Copy is passed in; the layout, rhythm and motion stay constant.
 */
export function StateView({
  illustration,
  title,
  body,
  reassurance,
  primaryLabel,
  onPrimary,
  primaryLoading,
  secondaryLabel,
  onSecondary,
  children,
  /** Fill the screen (a route) rather than sitting inline inside one. */
  fullscreen = true,
}: {
  illustration: ReactNode;
  title: string;
  body?: string;
  /** Extra calming line — used to state explicitly that funds are safe. */
  reassurance?: string;
  primaryLabel?: string;
  onPrimary?: () => void;
  primaryLoading?: boolean;
  secondaryLabel?: string;
  onSecondary?: () => void;
  children?: ReactNode;
  fullscreen?: boolean;
}) {
  const content = (
    <Animated.View entering={FadeIn.duration(260)} style={styles.body}>
      {illustration}
      <Text style={styles.title}>{title}</Text>
      {body ? <Text style={styles.text}>{body}</Text> : null}
      {children}
      {reassurance ? (
        <View style={styles.reassure}>
          <Text style={styles.reassureText}>{reassurance}</Text>
        </View>
      ) : null}
      {primaryLabel && onPrimary ? (
        <Button
          label={primaryLabel}
          onPress={onPrimary}
          loading={primaryLoading}
          style={styles.primary}
        />
      ) : null}
      {secondaryLabel && onSecondary ? (
        <Pressable onPress={onSecondary} hitSlop={8} style={styles.secondary}>
          <Text style={styles.secondaryText}>{secondaryLabel}</Text>
        </Pressable>
      ) : null}
    </Animated.View>
  );

  if (!fullscreen) return content;

  return (
    <SafeAreaView style={styles.root} edges={['top', 'bottom', 'left', 'right']}>
      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        {content}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Palette.bgBase },
  scroll: { flexGrow: 1, justifyContent: 'center', paddingHorizontal: Spacing.six },
  body: { alignItems: 'center', gap: Spacing.four, paddingVertical: Spacing.seven },
  title: {
    ...Typography.title,
    fontSize: 22,
    color: Palette.white,
    textAlign: 'center',
    marginTop: Spacing.two,
  },
  text: {
    ...Typography.body,
    color: Palette.textSecondary,
    textAlign: 'center',
    paddingHorizontal: Spacing.two,
  },
  reassure: {
    backgroundColor: Palette.bgElevated,
    borderRadius: 999,
    paddingHorizontal: Spacing.four,
    paddingVertical: Spacing.two,
  },
  reassureText: { ...Typography.micro, color: Palette.textSecondary, textAlign: 'center' },
  primary: { alignSelf: 'stretch', marginTop: Spacing.two },
  secondary: { paddingVertical: Spacing.three },
  secondaryText: { ...Typography.caption, color: Palette.accent, fontWeight: '600' },
});
