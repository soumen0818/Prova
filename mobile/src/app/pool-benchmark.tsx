import { useCallback, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { Button, Card, Screen } from '@/components/ui';
import { Palette, Spacing, Typography } from '@/constants/theme';
import { poolIdentity, warmUpProver } from '@/lib/pool';
import { secureRandomHex } from '@/lib/wallet';
import { poolScan, poolShieldProve } from '../../modules/prova-prover';

/**
 * On-device proving benchmark — the measurement behind the proposal's #1 product risk.
 *
 * Everything else about the pool is proven correct by tests. This is the one question tests cannot
 * answer: **how long does a real phone take?** A desktop builds a spend proof in about a second; a
 * budget Android will be slower, and by how much decides which UX is even possible.
 *
 * The number changes the product, not just the polish:
 *
 * | Spend proof | What the send screen has to be |
 * |---|---|
 * | under ~5 s | a spinner — "Sending…" |
 * | 5–20 s | a staged progress view with reassurance |
 * | over ~20 s | "we'll notify you when it's sent" — a different flow entirely |
 *
 * Which is why this ships as a screen rather than a lab exercise: run it on the cheapest handset in
 * the target market, early, before the send screen is designed around a guess.
 *
 * The shield proof is measured instead of the spend proof because it needs no funded note, no Merkle
 * path and no backend — it runs on a fresh install. It is the smaller circuit (6,684 constraints vs
 * 24,729), so **multiply by roughly 3.7 to estimate a spend**, and treat that as a lower bound.
 */

interface Timing {
  label: string;
  ms: number;
  note?: string;
}

const SCAN_SIZES = [50, 200];

export default function PoolBenchmarkScreen() {
  const [timings, setTimings] = useState<Timing[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async () => {
    setRunning(true);
    setError(null);
    setTimings([]);
    const results: Timing[] = [];

    const time = async <T,>(label: string, fn: () => Promise<T>, note?: string): Promise<T> => {
      const started = Date.now();
      const value = await fn();
      results.push({ label, ms: Date.now() - started, note });
      setTimings([...results]);
      return value;
    };

    try {
      // Key derivation (~1 s). Paid once at app start, never inside a user action.
      await time('Warm up prover', warmUpProver, 'once per app launch, in the background');

      const keys = await time('Derive wallet keys', poolIdentity, 'from the seed');

      // A shield proof, run twice: the first can still absorb lazy initialisation, so the second is
      // the honest steady-state figure.
      for (const pass of ['Shield proof (first)', 'Shield proof (warm)']) {
        await time(
          pass,
          () =>
            poolShieldProve({
              amount: 1000,
              owner_pk: keys.owner_pk,
              rho: secureRandomHex(32),
              enc_pk_x: keys.enc_pk_x,
              enc_pk_y: keys.enc_pk_y,
              esk: secureRandomHex(32),
            }),
          pass.includes('warm') ? '×3.7 ≈ a spend proof' : undefined,
        );
      }

      // Scanning: what the wallet does on every poll. None of these notes are ours, which is the
      // worst case and also the normal one.
      for (const size of SCAN_SIZES) {
        const candidates = Array.from({ length: size }, (_, i) => ({
          queue_index: i,
          commitment: secureRandomHex(32),
          epk_x: keys.enc_pk_x,
          epk_y: keys.enc_pk_y,
          enc_amount: secureRandomHex(32),
          enc_rho: secureRandomHex(32),
          slot: 0,
        }));
        await time(
          `Scan ${size} notes`,
          () => poolScan(keys.enc_sk, keys.owner_pk, candidates),
          'none of them ours — the worst case',
        );
      }
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : 'Benchmark failed. This screen needs a native build (npx expo run:android).',
      );
    } finally {
      setRunning(false);
    }
  }, []);

  const shieldWarm = timings.find((t) => t.label === 'Shield proof (warm)');
  const estimatedSpend = shieldWarm ? Math.round(shieldWarm.ms * 3.7) : null;

  return (
    <Screen>
      <ScrollView contentContainerStyle={styles.content}>
        <Card>
          <Text style={styles.title}>On-device proving</Text>
          <Text style={styles.body}>
            Measures how long this phone takes to do the private-payment maths. Run it on the
            cheapest device your users actually carry — the result decides how the send screen has
            to behave.
          </Text>
        </Card>

        <Button
          label={running ? 'Measuring…' : 'Run benchmark'}
          onPress={run}
          loading={running}
          disabled={running}
        />

        {error ? (
          <Card>
            <Text style={styles.error}>{error}</Text>
          </Card>
        ) : null}

        {timings.length > 0 ? (
          <Card>
            {timings.map((t) => (
              <View key={t.label} style={styles.row}>
                <View style={styles.rowText}>
                  <Text style={styles.label}>{t.label}</Text>
                  {t.note ? <Text style={styles.note}>{t.note}</Text> : null}
                </View>
                <Text style={styles.value}>{t.ms.toLocaleString()} ms</Text>
              </View>
            ))}
          </Card>
        ) : null}

        {estimatedSpend !== null ? (
          <Card>
            <Text style={styles.label}>Estimated spend proof</Text>
            <Text style={styles.estimate}>≈ {(estimatedSpend / 1000).toFixed(1)} s</Text>
            <Text style={styles.body}>{verdict(estimatedSpend)}</Text>
          </Card>
        ) : null}
      </ScrollView>
    </Screen>
  );
}

/** Turn a number into the design decision it implies, so the result is actionable on its own. */
function verdict(ms: number): string {
  if (ms < 5_000) {
    return 'Comfortable. A simple "Sending…" spinner is enough.';
  }
  if (ms < 20_000) {
    return 'Noticeable. The send screen needs staged progress and some reassurance, but the user ' +
      'can still wait for it.';
  }
  return 'Too slow to wait on. Sending should become a background job that notifies the user when ' +
    'it completes — a different flow, and much cheaper to design now than to retrofit.';
}

const styles = StyleSheet.create({
  content: { padding: Spacing.five, gap: Spacing.four },
  title: { ...Typography.title, color: Palette.white },
  body: { ...Typography.body, color: Palette.textSecondary, marginTop: Spacing.two },
  error: { ...Typography.body, color: Palette.statusDown },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: Spacing.three,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Palette.border,
    gap: Spacing.four,
  },
  rowText: { flex: 1 },
  label: { ...Typography.body, color: Palette.white },
  note: { ...Typography.caption, color: Palette.textSecondary },
  value: { ...Typography.body, color: Palette.accent, fontVariant: ['tabular-nums'] },
  estimate: {
    ...Typography.displayBalance,
    color: Palette.accent,
    marginVertical: Spacing.two,
  },
});
