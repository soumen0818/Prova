import { useFocusEffect, useRouter } from 'expo-router';
import { Clock, Home, Send, User } from 'lucide-react-native';
import type { ComponentType } from 'react';
import { useCallback, useRef, useState } from 'react';
import { BackHandler, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useToast } from '@/components/toast';
import { ActivityScreen } from '@/features/activity';
import { HomeScreen } from '@/features/home';
import { ProfileScreen } from '@/features/profile';
import { Palette, Radius, Spacing, Typography } from '@/constants/theme';
import { useRequireKyc } from '@/hooks/use-require-kyc';

/** How long a second back press still counts as "yes, I meant to leave". */
const EXIT_CONFIRM_MS = 2500;

type IconType = ComponentType<{ color?: string; size?: number; strokeWidth?: number }>;
type TabKey = 'home' | 'activity' | 'profile';

const TABS: { key: TabKey; label: string; Icon: IconType }[] = [
  { key: 'home', label: 'Home', Icon: Home },
  { key: 'activity', label: 'Activity', Icon: Clock },
  { key: 'profile', label: 'Profile', Icon: User },
];

/**
 * Authenticated app shell: a custom bottom tab bar (Home / Activity / Profile) with a floating
 * "Send" action. The tabs are in-shell views; deeper flows (send, deposit, kyc, recipients,
 * settings) are pushed routes on top of this screen.
 */
export function AppShell() {
  const router = useRouter();
  const requireKyc = useRequireKyc();
  const insets = useSafeAreaInsets();
  const toast = useToast();
  const [tab, setTab] = useState<TabKey>('home');
  const lastBackPress = useRef(0);

  /**
   * Make the Android back button behave the way people expect.
   *
   * The tabs are React state, not routes, so the navigator has no history to pop for them. Without
   * this, back from Activity or Profile fell through to the system default and **closed the app** —
   * which for a payments app, mid-task, is alarming rather than merely annoying.
   *
   * Two rules:
   *  - On a tab other than Home, go to Home. That is what the back arrow means to a person here.
   *  - On Home, ask once before leaving. A single stray press closing a wallet is a bad outcome;
   *    a second press within a couple of seconds confirms it and the app exits normally.
   *
   * Registered through `useFocusEffect` so it is only active while the shell is on top. The
   * listener is global, so left mounted it would also swallow the back press on pushed screens
   * like Send — breaking exactly what it is meant to fix.
   */
  useFocusEffect(
    useCallback(() => {
      const onBack = () => {
        if (tab !== 'home') {
          setTab('home');
          return true; // handled
        }
        const now = Date.now();
        if (now - lastBackPress.current < EXIT_CONFIRM_MS) {
          return false; // let Android close the app
        }
        lastBackPress.current = now;
        toast.info('Press back again to exit');
        return true;
      };

      const sub = BackHandler.addEventListener('hardwareBackPress', onBack);
      return () => sub.remove();
    }, [tab, toast]),
  );

  return (
    <View style={styles.root}>
      <View style={styles.content}>
        {tab === 'home' && <HomeScreen onNavigateTab={setTab} />}
        {tab === 'activity' && <ActivityScreen />}
        {tab === 'profile' && <ProfileScreen />}
      </View>

      {/* Floating Send action */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Send money"
        onPress={() => requireKyc(() => router.push('/send'))}
        style={({ pressed }) => [
          styles.fab,
          { bottom: insets.bottom + 74 },
          pressed && styles.fabPressed,
        ]}>
        <Send color={Palette.onAccent} size={24} strokeWidth={2.2} />
      </Pressable>

      {/* Bottom tab bar */}
      <View style={[styles.tabBar, { paddingBottom: insets.bottom + Spacing.two }]}>
        {TABS.map(({ key, label, Icon }) => {
          const active = tab === key;
          return (
            <Pressable
              key={key}
              accessibilityRole="tab"
              accessibilityState={{ selected: active }}
              accessibilityLabel={label}
              onPress={() => setTab(key)}
              style={styles.tab}>
              <Icon
                color={active ? Palette.accent : Palette.textMuted}
                size={22}
                strokeWidth={active ? 2.2 : 1.8}
              />
              <Text style={[styles.tabLabel, active && styles.tabLabelActive]}>{label}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Palette.bgBase },
  content: { flex: 1 },
  tabBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
    paddingTop: Spacing.three,
    backgroundColor: Palette.bgElevated,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Palette.border,
  },
  tab: { alignItems: 'center', justifyContent: 'center', gap: 3, flex: 1 },
  tabLabel: { ...Typography.micro, fontSize: 11, color: Palette.textMuted },
  tabLabelActive: { color: Palette.accent },
  fab: {
    position: 'absolute',
    right: Spacing.five,
    width: 60,
    height: 60,
    borderRadius: Radius.full,
    backgroundColor: Palette.accent,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.35,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 8,
  },
  fabPressed: { backgroundColor: Palette.accentPressed, transform: [{ scale: 0.96 }] },
});
