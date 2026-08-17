import { CORRIDOR_STATUS_NOTE } from '@prova/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import {
  ChevronRight,
  Info,
  LogOut,
  MessageCircle,
  QrCode,
  Settings,
  ShieldCheck,
  UsersRound,
  Wallet,
  FileText,
  ScrollText,
} from 'lucide-react-native';
import type { ComponentType } from 'react';
import { Alert, Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import { Card, Screen } from '@/components/ui';
import { useToast } from '@/components/toast';
import { formatBalance } from '@/lib/balance';
import { useKycVerified, useSession, QK } from '@/lib/queries';
import { useMoney } from '@/hooks/use-money';
import { initials } from '@/lib/recipients';
import { clearSession } from '@/lib/session';
import { Palette, Radius, ScreenPadding, Spacing, Typography } from '@/constants/theme';

type IconType = ComponentType<{ color?: string; size?: number; strokeWidth?: number }>;

/** Diameter of the initials circle. Used by both the layout and the width maths below. */
const AVATAR_SIZE = 60;

/**
 * Largest and smallest the email is allowed to be, in points.
 *
 * The floor is 9 rather than something more comfortable because the requirement is that the address
 * is never truncated: Gmail permits a 30-character local part, so a 40-character address has to fit
 * beside the avatar on a 360pt phone, and 9pt is what that arithmetic demands. It is only reached by
 * the longest addresses — anything up to ~25 characters still renders at full size.
 */
const EMAIL_SIZE_MAX = 17;
const EMAIL_SIZE_MIN = 9;

/**
 * Average advance width of the semibold face as a fraction of its font size.
 *
 * Measured from the actual glyphs rather than assumed: email addresses are lowercase latin plus
 * `@` and `.`, and 0.55 is a slight over-estimate for that set, so the result errs toward fitting.
 */
const AVG_CHAR_RATIO = 0.55;

/**
 * A font size at which `email` fits on one line inside `available` points.
 *
 * Done in JS rather than with `adjustsFontSizeToFit` because that prop is unreliable on Android —
 * where it silently does nothing, leaving the text to ellipsise at full size, which is exactly the
 * failure this is meant to prevent. This is deterministic and behaves identically on both
 * platforms, and it reads the real screen width so a wide phone is not shrunk needlessly.
 */
export function emailFontSize(email: string, available: number): number {
  if (email.length === 0 || available <= 0) return EMAIL_SIZE_MAX;
  const ideal = Math.floor(available / (email.length * AVG_CHAR_RATIO));
  return Math.max(EMAIL_SIZE_MIN, Math.min(EMAIL_SIZE_MAX, ideal));
}

/** Profile tab: account identity, verification status, balance, shortcuts, and sign-out. */
export function ProfileScreen() {
  const router = useRouter();
  const toast = useToast();
  const queryClient = useQueryClient();
  const session = useSession();
  const money = useMoney();
  const kyc = useKycVerified();
  const verified = kyc.data === true;

  const onSignOut = () => {
    Alert.alert('Sign out?', 'You’ll need your phone number to sign back in.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Sign out',
        style: 'destructive',
        onPress: async () => {
          await clearSession();
          queryClient.setQueryData(QK.session, null);
          toast.info('Signed out');
          router.replace('/');
        },
      },
    ]);
  };

  const { width } = useWindowDimensions();
  const email = session.data?.email ?? '—';
  /*
   * What is genuinely left for the email: the screen, minus the Screen's own padding, minus the
   * Card's padding, minus the avatar and the gap beside it. Derived from the same constants the
   * styles use, so moving any of them keeps this correct.
   */
  const emailWidth = width - 2 * ScreenPadding - 2 * Spacing.five - AVATAR_SIZE - Spacing.four;

  return (
    <Screen scroll>
      <Text style={styles.title}>Profile</Text>

      <Card style={styles.identityCard}>
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>
            {initials(session.data?.name ?? session.data?.email ?? '?')}
          </Text>
        </View>
        <View style={styles.identityText}>
          {/*
            The email is always present — it is the account. Name and phone appear only after
            identity verification supplies them, so they are shown as "not yet added" rather than an
            empty dash that looks like a bug.
          */}
          {/*
            One line, always. At the previous size a normal address like
            `sdas721444@gmail.com` wrapped onto a second line and split the domain across the break,
            which reads as a broken address rather than a long one.

            `adjustsFontSizeToFit` shrinks the text only as far as it must, down to 75%, so ordinary
            addresses stay full size and only unusually long ones are scaled. `middle` truncation is
            the last resort: if something has to go it should be the middle of the local part, since
            the opening characters and the domain are what identify the account.
          */}
          <Text
            style={[styles.name, { fontSize: emailFontSize(email, emailWidth) }]}
            numberOfLines={1}
            ellipsizeMode="middle">
            {email}
          </Text>
          <Text style={styles.phone} numberOfLines={1} ellipsizeMode="tail">
            {session.data?.name
              ? `${session.data.name}${session.data.phone ? ` · ${session.data.phone}` : ''}`
              : 'Verify your identity to add your name'}
          </Text>
        </View>
      </Card>

      <View style={styles.statRow}>
        <Card style={styles.statCard}>
          <Text style={styles.statLabel}>Balance</Text>
          <Text style={styles.statValue}>
            {money.isLoading ? '—' : formatBalance(money.spendable, money.denom)}
          </Text>
        </Card>
        <Pressable style={styles.flex} onPress={() => !verified && router.push('/kyc')}>
          <Card style={styles.statCard}>
            <Text style={styles.statLabel}>Identity</Text>
            <Text
              style={[
                styles.statValue,
                { color: verified ? Palette.accent : Palette.textSecondary },
              ]}>
              {verified ? 'Verified' : 'Verify now'}
            </Text>
          </Card>
        </Pressable>
      </View>

      <View style={styles.menu}>
        <MenuRow Icon={QrCode} label="Account details" onPress={() => router.push('/account')} />
        <MenuRow Icon={UsersRound} label="Recipients" onPress={() => router.push('/recipients')} />
        <MenuRow
          Icon={ShieldCheck}
          label={verified ? 'Identity verified' : 'Verify identity'}
          onPress={() => router.push('/kyc')}
        />
        <MenuRow Icon={Wallet} label="Add money" onPress={() => router.push('/deposit')} />
        <MenuRow Icon={Settings} label="Settings" onPress={() => router.push('/settings')} />
        <MenuRow
          Icon={MessageCircle}
          label="Chat with us"
          onPress={() => router.push('/support')}
        />
        <MenuRow
          Icon={FileText}
          label="Privacy Policy"
          onPress={() => router.push({ pathname: '/legal', params: { doc: 'privacy' } })}
        />
        <MenuRow
          Icon={ScrollText}
          label="Terms of Service"
          onPress={() => router.push({ pathname: '/legal', params: { doc: 'terms' } })}
        />
      </View>

      <Card style={styles.privacyCard}>
        <ShieldCheck color={Palette.accent} size={18} strokeWidth={2} />
        <Text style={styles.privacyText}>
          Your amount is proved compliant on this device and never leaves it — only a commitment is
          written on-chain.
        </Text>
      </Card>

      {/*
        A statement of scope, above the sign-out rather than trailing after it. Below the last
        action it read as a footer nobody attributes to anything; here it sits with the other
        informational cards, which is what it is.
      */}
      <Card style={styles.statusCard}>
        <Info color={Palette.textSecondary} size={17} strokeWidth={2} />
        <Text style={styles.statusText}>{CORRIDOR_STATUS_NOTE}</Text>
      </Card>

      <Pressable
        style={({ pressed }) => [styles.signOut, pressed && styles.signOutPressed]}
        onPress={onSignOut}>
        <LogOut color={Palette.statusDown} size={18} strokeWidth={2} />
        <Text style={styles.signOutText}>Sign out</Text>
      </Pressable>
    </Screen>
  );
}

function MenuRow({ Icon, label, onPress }: { Icon: IconType; label: string; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.menuRow, pressed && styles.menuRowPressed]}>
      <Icon color={Palette.white} size={20} strokeWidth={1.8} />
      <Text style={styles.menuLabel}>{label}</Text>
      <ChevronRight color={Palette.textMuted} size={20} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  statusCard: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.three,
    marginBottom: Spacing.four,
    paddingVertical: Spacing.four,
  },
  statusText: {
    ...Typography.caption,
    color: Palette.textSecondary,
    flex: 1,
    lineHeight: 20,
  },
  title: { ...Typography.title, color: Palette.white, marginBottom: Spacing.five },
  flex: { flex: 1 },
  identityCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.four,
    marginBottom: Spacing.four,
  },
  avatar: {
    width: AVATAR_SIZE,
    height: AVATAR_SIZE,
    borderRadius: Radius.full,
    backgroundColor: Palette.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { ...Typography.title, color: Palette.onAccent },
  identityText: { flex: 1 },
  // fontSize is overridden per-address by emailFontSize; this is the maximum. lineHeight is left
  // generous so a shrunken address still sits on the same baseline as a full-size one.
  name: { ...Typography.title, fontSize: EMAIL_SIZE_MAX, lineHeight: 24, color: Palette.white },
  phone: { ...Typography.caption, color: Palette.textSecondary },
  statRow: { flexDirection: 'row', gap: Spacing.three, marginBottom: Spacing.six },
  statCard: { flex: 1, gap: Spacing.one, padding: Spacing.four },
  statLabel: { ...Typography.micro, color: Palette.textSecondary, textTransform: 'uppercase' },
  statValue: { ...Typography.section, color: Palette.white },
  menu: { gap: Spacing.two, marginBottom: Spacing.six },
  menuRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
    backgroundColor: Palette.bgElevated,
    borderRadius: Radius.input,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Palette.border,
    paddingHorizontal: Spacing.four,
    paddingVertical: Spacing.four,
  },
  menuRowPressed: { backgroundColor: Palette.bgSelected },
  menuLabel: { ...Typography.body, color: Palette.white, flex: 1 },
  privacyCard: {
    flexDirection: 'row',
    gap: Spacing.three,
    alignItems: 'flex-start',
    marginBottom: Spacing.six,
  },
  privacyText: { ...Typography.caption, color: Palette.textSecondary, flex: 1 },
  signOut: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.two,
    paddingVertical: Spacing.four,
  },
  signOutPressed: { opacity: 0.6 },
  signOutText: { ...Typography.button, fontSize: 15, color: Palette.statusDown },
});
