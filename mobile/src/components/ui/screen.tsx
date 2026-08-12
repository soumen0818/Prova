import { LinearGradient } from 'expo-linear-gradient';
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Dimensions,
  Keyboard,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type ViewStyle,
} from 'react-native';
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

  /**
   * Lift content above the keyboard.
   *
   * This app runs edge-to-edge (`edgeToEdgeEnabled=true`), and under edge-to-edge Android does not
   * resize the window when the keyboard opens — `adjustResize` is effectively ignored, and so is
   * anything that depends on it. The ScrollView keeps its full height, the content never becomes
   * scrollable, and a field low on the screen simply sits behind the keyboard.
   * `automaticallyAdjustKeyboardInsets` does not help either: it is iOS-only.
   *
   * So the keyboard height is measured directly and applied as bottom padding. That works whether
   * or not the OS resizes anything, which is the only way to be right on both platforms here.
   */
  const scroller = useRef<ScrollView>(null);
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  /** Current scroll offset, so a correction can be applied relative to where the view already is. */
  const scrollY = useRef(0);

  /**
   * Whether this screen is the one on top.
   *
   * `Keyboard` events are global, and a stack keeps earlier screens **mounted** underneath the one
   * you are looking at. Without this gate, opening the keyboard on "Add recipient" also padded and
   * scrolled the Home screen sitting behind it — so coming back showed Home shifted upward for a
   * moment, until its own `keyboardDidHide` arrived. Only the focused screen may react.
   *
   * A ref rather than state: the listeners below need to read the *current* value, and re-creating
   * them on every focus change would drop events during the transition.
   */
  const focused = useRef(true);

  useEffect(() => {
    if (!scroll) return;
    const show = Keyboard.addListener('keyboardDidShow', (e) => {
      if (!focused.current) return;
      const height = e.endCoordinates?.height ?? 0;
      setKeyboardHeight(height);

      /*
       * Bring the focused field into view — and only if it is actually hidden.
       *
       * This used to scroll to the *end* of the content, which is right only when the focused field
       * happens to be the last one. On a form whose first field is autofocused it did the opposite
       * of what it promised: the keyboard opened and the view scrolled away from the very input the
       * cursor was in, so "Add recipient" opened with its name field off the top of the screen.
       *
       * Measuring the focused input and scrolling by the overlap fixes both cases, and does nothing
       * at all when the field is already visible.
       */
      const input = TextInput.State.currentlyFocusedInput();
      if (!input) return;
      requestAnimationFrame(() => {
        input.measureInWindow((_x, y, _width, h) => {
          const keyboardTop = Dimensions.get('window').height - height;
          const overlap = y + h + Spacing.four - keyboardTop;
          if (overlap > 0) {
            scroller.current?.scrollTo({ y: scrollY.current + overlap, animated: true });
          }
        });
      });
    });
    const hide = Keyboard.addListener('keyboardDidHide', () => setKeyboardHeight(0));
    return () => {
      show.remove();
      hide.remove();
    };
  }, [scroll]);

  /**
   * Track focus, and drop the keyboard padding when the screen is left.
   *
   * Navigating away closes the keyboard, but `keyboardDidHide` does not reliably arrive for a
   * screen that is being torn down — so the padding stayed applied and the next screen appeared
   * shifted upward, as if the keyboard were still open.
   */
  useFocusEffect(
    useCallback(() => {
      focused.current = true;
      return () => {
        focused.current = false;
        Keyboard.dismiss();
        setKeyboardHeight(0);
      };
    }, []),
  );

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
            ref={scroller}
            style={styles.flex}
            contentContainerStyle={[
              styles.scrollContent,
              innerStyle,
              contentContainerStyle,
              keyboardHeight > 0 && { paddingBottom: keyboardHeight + Spacing.six },
            ]}
            showsVerticalScrollIndicator={false}
            // Tracked so the keyboard correction above can scroll relative to the current position.
            onScroll={(event: NativeSyntheticEvent<NativeScrollEvent>) => {
              scrollY.current = event.nativeEvent.contentOffset.y;
            }}
            scrollEventThrottle={16}
            // Forms: Android's `adjustResize` shrinks the window when the keyboard opens, but a
            // ScrollView does not scroll the focused field into view by itself — so a field low on
            // the screen ends up behind the keyboard. The bottom inset gives it somewhere to
            // scroll to; `persistTaps` makes a button tap land on the first press instead of being
            // swallowed to dismiss the keyboard.
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
            automaticallyAdjustKeyboardInsets>
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
