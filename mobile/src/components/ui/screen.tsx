import { LinearGradient } from 'expo-linear-gradient';
import type { ReactNode } from 'react';
import { ScrollView, StyleSheet, View, type ViewStyle } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { BottomTabInset, Palette, ScreenPadding, Spacing } from '@/constants/theme';

type ScreenProps = {
  children: ReactNode;
  /** Wrap content in a ScrollView. Default false. */
  scroll?: boolean;
  /** Apply default horizontal screen padding. Default true. */
  padded?: boolean;
  /** Show the ambient olive glow behind the header. Default true. */
  glow?: boolean;
  style?: ViewStyle;
  contentContainerStyle?: ViewStyle;
};

/**
 * Base screen wrapper: dark base background, ambient top glow, and safe-area handling.
 * Every Prova screen should be built inside this so the look stays consistent.
 */
export function Screen({
  children,
  scroll = false,
  padded = true,
  glow = true,
  style,
  contentContainerStyle,
}: ScreenProps) {
  const innerStyle = [padded && styles.padded, style];

  return (
    <View style={styles.root}>
      {glow && (
        <LinearGradient
          colors={[Palette.glowOlive, 'transparent']}
          style={styles.glow}
          pointerEvents="none"
        />
      )}
      <SafeAreaView style={styles.safeArea} edges={['top', 'left', 'right']}>
        {scroll ? (
          <ScrollView
            style={styles.flex}
            contentContainerStyle={[styles.scrollContent, innerStyle, contentContainerStyle]}
            showsVerticalScrollIndicator={false}>
            {children}
          </ScrollView>
        ) : (
          <View style={[styles.flex, innerStyle, contentContainerStyle]}>{children}</View>
        )}
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: Palette.bgBase,
  },
  glow: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 320,
  },
  safeArea: {
    flex: 1,
  },
  flex: {
    flex: 1,
  },
  padded: {
    paddingHorizontal: ScreenPadding,
  },
  scrollContent: {
    paddingTop: Spacing.four,
    paddingBottom: BottomTabInset + Spacing.six,
  },
});
