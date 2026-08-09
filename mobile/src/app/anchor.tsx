import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';

import { Loader } from '@/components/loader';
import { Button, Screen } from '@/components/ui';
import { Palette, Spacing, Typography } from '@/constants/theme';

/**
 * The anchor's SEP-24 deposit page, rendered **inside the app**.
 *
 * This used to hand off to whatever browser the phone had set as default. That is worse in three
 * ways: the user leaves Prova mid-payment, the anchor's page is a JavaScript app that some browsers
 * (Brave with Shields up, for one) break by blocking its cross-domain data fetch, and nothing tells
 * the app when the flow finished — it could only guess on return.
 *
 * A WebView fixes all three. It is still the anchor's own page — SEP-24 is *defined* as handing the
 * user to the anchor for KYC and amount entry, and Prova deliberately never sees those details — but
 * it now runs in a container we control, with a predictable engine and a completion signal.
 */
/**
 * SDF's SEP-24 reference UI hands back a URL with **no path**, which its router maps to a Welcome
 * route that is still placeholder text (`// TODO: update welcome text` + lorem ipsum in their
 * bundle). The flow that actually collects an amount and KYC starts at `/start`.
 *
 * So when an interactive URL arrives with an empty path, send it to `/start` instead, carrying the
 * query string — the transaction id and token — untouched. A URL that already names a path is left
 * exactly as the anchor gave it: this is a workaround for one unfinished testnet demo, not a rule
 * about anchors, and a licensed anchor's URL must never be second-guessed.
 */
function entryUrl(raw: string): string {
  try {
    const u = new URL(raw);
    if (u.pathname === '' || u.pathname === '/') u.pathname = '/start';
    return u.toString();
  } catch {
    return raw;
  }
}

export default function AnchorScreen() {
  const router = useRouter();
  const { url } = useLocalSearchParams<{ url?: string }>();
  const [loading, setLoading] = useState(true);
  /** Guards against the anchor signalling completion more than once. */
  const finished = useRef(false);

  const finish = useCallback(() => {
    if (finished.current) return;
    finished.current = true;
    router.back();
  }, [router]);

  /**
   * SEP-24 tells the client it is done by posting a message from the interactive page.
   * Implementations differ on the exact shape, so accept any of the documented spellings rather
   * than failing closed on one anchor's phrasing.
   */
  const onMessage = useCallback(
    (e: WebViewMessageEvent) => {
      const raw = e.nativeEvent?.data ?? '';
      let status = '';
      try {
        const parsed = JSON.parse(raw) as { status?: string; transaction?: { status?: string } };
        status = parsed.status ?? parsed.transaction?.status ?? '';
      } catch {
        status = raw;
      }
      if (/completed|success|pending|close/i.test(status)) finish();
    },
    [finish],
  );

  if (!url) {
    return (
      <Screen>
        <View style={styles.center}>
          <Text style={styles.error}>Missing the anchor address.</Text>
          <Button label="Go back" onPress={() => router.back()} />
        </View>
      </Screen>
    );
  }

  return (
    <View style={styles.root}>
      <WebView
        source={{ uri: entryUrl(url) }}
        style={styles.web}
        onLoadEnd={() => setLoading(false)}
        onMessage={onMessage}
        // The anchor's page is a JS app that fetches its transaction from another subdomain; without
        // these it renders empty field labels and no form, which is exactly the failure seen when a
        // shields-up browser blocked it.
        javaScriptEnabled
        domStorageEnabled
        thirdPartyCookiesEnabled
        sharedCookiesEnabled
        setSupportMultipleWindows={false}
      />
      {loading ? (
        <View style={styles.loading}>
          <Loader />
          <Text style={styles.loadingText}>Opening your provider…</Text>
        </View>
      ) : null}
      <View style={styles.footer}>
        <Text style={styles.footerNote}>Handled by your funding provider.</Text>
        <Button label="Done" variant="secondary" onPress={finish} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Palette.bgBase },
  web: { flex: 1, backgroundColor: Palette.bgBase },
  loading: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.three,
    backgroundColor: Palette.bgBase,
  },
  loadingText: { ...Typography.caption, color: Palette.textSecondary },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: Spacing.four },
  error: { ...Typography.body, color: Palette.statusDown },
  footer: {
    padding: Spacing.four,
    gap: Spacing.two,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Palette.border,
    backgroundColor: Palette.bgBase,
  },
  footerNote: { ...Typography.micro, color: Palette.textMuted, textAlign: 'center' },
});
