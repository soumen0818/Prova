import { decodePayLink, encodePoolAddress } from '@prova/shared';
import * as Linking from 'expo-linking';
import { Stack, useRouter } from 'expo-router';
import { useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Loader } from '@/components/loader';
import { Button, Card, Screen } from '@/components/ui';
import { Palette, Spacing, Typography } from '@/constants/theme';

/**
 * Where a shared pay link lands.
 *
 * Someone taps `https://provapay.duckdns.org/pay#<address>` in a chat and Android hands the URI
 * straight here — no browser, no request, and the server never sees who is being paid because the
 * address rides in the fragment. Without the app installed the same link opens the website instead,
 * which offers the download.
 *
 * This screen only reads the address and forwards to the recipient form; it deliberately does not
 * save anything by itself. A link should never be able to add a payee silently — the user still
 * names them and confirms, exactly as if they had pasted the address.
 */
export default function PayLinkScreen() {
  const router = useRouter();
  // The full launch URL, fragment included. `Linking.parse()` is not used on purpose: it returns
  // scheme/host/path/queryParams and drops the fragment, which is the only part that matters here.
  const url = Linking.useURL();

  /*
   * Both of these are derived, not stored. Whether the link parsed is a pure function of the URL, so
   * holding it in state would only add a render and a way for the two to disagree.
   *
   * `address` is re-encoded to a string rather than kept as an object so the effect below has a
   * stable dependency — an object rebuilt each render would re-fire the navigation forever.
   */
  const address = url ? decodePayLink(url) : null;
  const encoded = address ? encodePoolAddress(address) : null;
  const failed = url !== null && encoded === null;

  useEffect(() => {
    if (!encoded) return;
    // `replace`, not `push`: backing out of the recipient form should return wherever the user was,
    // not to a loading screen that immediately forwards again.
    router.replace({ pathname: '/recipient-new', params: { address: encoded } });
  }, [encoded, router]);

  return (
    <Screen>
      <Stack.Screen options={{ headerShown: true, title: 'Add recipient' }} />
      {failed ? (
        <Card style={styles.card}>
          <Text style={styles.title}>That link didn’t work</Text>
          <Text style={styles.body}>
            It may have been shortened or cut off in the message. Ask them to send it again, or to
            show you their QR code instead.
          </Text>
          <Button label="Add manually" onPress={() => router.replace('/recipient-new')} />
        </Card>
      ) : (
        <View style={styles.loading}>
          <Loader />
          <Text style={styles.body}>Opening…</Text>
        </View>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  card: { gap: Spacing.three },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: Spacing.three },
  title: { ...Typography.title, color: Palette.white },
  body: { ...Typography.caption, color: Palette.textSecondary },
});
