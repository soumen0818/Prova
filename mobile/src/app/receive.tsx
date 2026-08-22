import { encodePayLink } from '@prova/shared';
import * as Clipboard from 'expo-clipboard';
import { useEffect, useState } from 'react';
import { Pressable, Share, StyleSheet, Text, View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';

import { Card, Screen } from '@/components/ui';
import { useToast } from '@/components/toast';
import { encodePoolAddress, poolAddress } from '@/lib/pool';
import { Palette, Radius, Spacing, Typography } from '@/constants/theme';

/**
 * The shielded-pool receive address — a different thing from the Stellar address on `account.tsx`.
 * The Stellar address is where funds move on-chain in public (deposits, trustlines); this is where
 * private payments *inside* the pool find their way to you. Sharing it reveals nothing about your
 * balance or history — see `lib/pool.ts`'s `poolAddress()`.
 */
export default function ReceiveScreen() {
  const toast = useToast();
  const [encoded, setEncoded] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    poolAddress()
      .then((addr) => {
        if (!active) return;
        setEncoded(encodePoolAddress(addr));
        setLink(encodePayLink(addr));
      })
      .catch(() => {
        if (!active) return;
        setEncoded(null);
        setLink(null);
      });
    return () => {
      active = false;
    };
  }, []);

  /*
   * Sharing sends the LINK, not the raw address.
   *
   * Tapping it opens Prova straight on the recipient form with this address filled in; without the
   * app it opens the site, which offers the download. Either way nothing reaches our server — the
   * address sits in the URL fragment, which is never transmitted.
   *
   * The QR and the copy button still carry the bare address, because a scanner expects one and
   * because someone pasting into another wallet should get an address rather than a URL.
   */
  const onShare = async () => {
    if (!link) return;
    try {
      await Share.share({ message: link });
    } catch {
      // The user dismissing the sheet is not a failure worth reporting.
    }
  };

  const onCopy = async () => {
    if (!encoded) return;
    await Clipboard.setStringAsync(encoded);
    toast.success('Pool address copied');
  };

  return (
    <Screen scroll>
      <Card style={styles.card}>
        <Text style={styles.label}>Your private receive address</Text>
        <Text style={styles.hint}>
          Share this so someone can send you money privately inside the pool. It reveals nothing
          about your balance or history.
        </Text>
        <View style={styles.qrWrap}>
          {encoded ? (
            <View style={styles.qrBox}>
              <QRCode value={encoded} size={200} backgroundColor="#FFFFFF" color="#0E0E11" />
            </View>
          ) : (
            <View style={[styles.qrBox, styles.qrPlaceholder]} />
          )}
        </View>
        <Pressable
          onPress={onShare}
          disabled={!link}
          style={({ pressed }) => [styles.sharePill, pressed && styles.pressed]}>
          <Text style={styles.shareText}>Share link</Text>
        </Pressable>
        <Pressable
          onPress={onCopy}
          disabled={!encoded}
          style={({ pressed }) => [styles.copyPill, pressed && styles.pressed]}>
          <Text style={styles.copyText}>Copy address</Text>
        </Pressable>
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  card: { alignItems: 'center', gap: Spacing.two, marginBottom: Spacing.six },
  label: { ...Typography.section, color: Palette.white },
  hint: { ...Typography.micro, color: Palette.textMuted, textAlign: 'center' },
  sharePill: {
    backgroundColor: Palette.accent,
    borderRadius: Radius.full,
    paddingHorizontal: Spacing.six,
    paddingVertical: Spacing.three,
    marginBottom: Spacing.two,
  },
  shareText: { ...Typography.button, color: Palette.onAccent },
  qrWrap: { marginVertical: Spacing.four },
  qrBox: { padding: Spacing.four, backgroundColor: '#FFFFFF', borderRadius: Radius.input },
  qrPlaceholder: { width: 232, height: 232, backgroundColor: Palette.bgElevated },
  copyPill: {
    backgroundColor: Palette.bgElevated,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Palette.border,
    borderRadius: Radius.pill,
    paddingHorizontal: Spacing.five,
    paddingVertical: Spacing.three,
  },
  copyText: { ...Typography.caption, color: Palette.accent, fontWeight: '600' },
  pressed: { opacity: 0.6 },
});
