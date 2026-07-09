import { Stack } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TextInput, View } from 'react-native';

import { submitTransfer, type KycCredential } from '@/lib/api';
import { isProverAvailable, prove } from '@/lib/prover';
import { getSecret, SecureKey } from '@/lib/secure-store';
import { secureRandomU64 } from '@/lib/wallet';
import { Button, Card, Screen } from '@/components/ui';
import { useToast } from '@/components/toast';
import { Palette, Radius, Spacing, Typography } from '@/constants/theme';

type Phase = 'idle' | 'proving' | 'submitting' | 'sent' | 'error';

/**
 * Phase 4 send flow — proving happens on-device. Enter amount → the native Rust prover generates the
 * Groth16 proof off the JS thread (honest progress bar) → the proof blob is relayed to the contract
 * via the backend → "Sent". The amount and secret never leave the phone.
 *
 * (True pre-computation — starting witness generation before "confirm" — is a future optimization;
 * the native module currently does witness + prove in one `prove()` call.)
 */
export default function SendScreen() {
  const [amount, setAmount] = useState('');
  const [secret, setSecret] = useState<string | null>(null);
  const [credential, setCredential] = useState<KycCredential | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [progress, setProgress] = useState(0);
  const [message, setMessage] = useState('');
  const [txHash, setTxHash] = useState('');
  const [error, setError] = useState('');
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const toast = useToast();

  useEffect(() => {
    let active = true;
    (async () => {
      const s = await getSecret(SecureKey.zkSecretKey);
      const c = await getSecret(SecureKey.kycCredential);
      if (!active) return;
      setSecret(s);
      if (c) {
        try {
          setCredential(JSON.parse(c) as KycCredential);
        } catch {
          /* ignore malformed */
        }
      }
    })();
    return () => {
      active = false;
      if (timer.current) clearInterval(timer.current);
    };
  }, []);

  const startProgress = () => {
    setProgress(0.05);
    timer.current = setInterval(() => setProgress((p) => (p < 0.9 ? p + 0.03 : p)), 250);
  };
  const stopProgress = () => {
    if (timer.current) {
      clearInterval(timer.current);
      timer.current = null;
    }
  };

  const onSend = useCallback(async () => {
    setError('');
    const amt = Number(amount);
    if (!Number.isInteger(amt) || amt < 1 || amt > 9999) {
      setError('Amount must be a whole number between 1 and 9999.');
      return;
    }
    if (!secret || !credential) {
      setError('Complete KYC first (Verify identity).');
      return;
    }
    try {
      setPhase('proving');
      setMessage('Securing your transfer…');
      startProgress();

      const now = Math.floor(Date.now() / 1000);
      const transferId = secureRandomU64();
      const blob = await prove({
        amount: String(amt),
        secret,
        transferId,
        kycLevel: String(credential.kycLevel),
        expiry: String(credential.expiry),
        currentTime: String(now),
        sigRx: credential.signature.rX,
        sigRy: credential.signature.rY,
        sigS: credential.signature.s,
        anchorPkX: credential.anchor.x,
        anchorPkY: credential.anchor.y,
      });

      stopProgress();
      setProgress(1);
      setPhase('submitting');
      setMessage('Submitting to Stellar…');
      const resp = await submitTransfer(blob);
      if (resp.status === 'confirmed') {
        setTxHash(resp.txHash ?? '');
        setPhase('sent');
        toast.success('Sent — no amount on-chain');
      } else {
        setError(`Transfer ${resp.status}.`);
        setPhase('error');
        toast.error(`Transfer ${resp.status}`);
      }
    } catch (e) {
      stopProgress();
      const msg = e instanceof Error ? e.message : 'send failed';
      setError(msg);
      setPhase('error');
      toast.error(msg);
    }
  }, [amount, secret, credential, toast]);

  const busy = phase === 'proving' || phase === 'submitting';

  return (
    <Screen scroll>
      <Stack.Screen options={{ title: 'Send privately' }} />
      <Text style={styles.title}>Send</Text>
      <Text style={styles.subtitle}>
        The amount is proved compliant on your device and never leaves it — only a commitment goes
        on-chain.
      </Text>

      {!credential ? (
        <Card style={styles.card}>
          <Text style={styles.warn}>Complete KYC first — open “Verify identity”.</Text>
        </Card>
      ) : null}

      <Card style={styles.card}>
        <Text style={styles.label}>Amount (1–9999)</Text>
        <TextInput
          style={styles.input}
          value={amount}
          onChangeText={setAmount}
          keyboardType="number-pad"
          placeholder="500"
          placeholderTextColor={Palette.textMuted}
          editable={!busy}
        />
      </Card>

      {phase === 'sent' ? (
        <Card style={styles.card}>
          <Text style={styles.sent}>Sent ✅</Text>
          <Text style={styles.mono}>tx {txHash.slice(0, 16)}…</Text>
          <Text style={styles.enclave}>No amount is visible on-chain — only the commitment.</Text>
        </Card>
      ) : (
        <Button label={busy ? message : 'Send privately'} onPress={onSend} disabled={busy} />
      )}

      {busy ? (
        <View style={styles.progressWrap}>
          <View style={styles.progressTrack}>
            <View style={[styles.progressFill, { width: `${Math.round(progress * 100)}%` }]} />
          </View>
          <View style={styles.progressRow}>
            <ActivityIndicator color={Palette.accent} />
            <Text style={styles.progressText}>{message}</Text>
          </View>
        </View>
      ) : null}

      {error ? <Text style={styles.error}>{error}</Text> : null}
      {!isProverAvailable ? (
        <Text style={styles.hint}>
          On-device prover not built into this app yet. Rebuild with `npx expo run:android` to
          enable proving.
        </Text>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { ...Typography.title, color: Palette.white, marginBottom: Spacing.two },
  subtitle: { ...Typography.caption, color: Palette.textSecondary, marginBottom: Spacing.five },
  card: { gap: Spacing.two, marginBottom: Spacing.four },
  label: { ...Typography.caption, color: Palette.textSecondary },
  input: {
    ...Typography.title,
    color: Palette.white,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Palette.border,
    paddingVertical: Spacing.two,
  },
  warn: { ...Typography.caption, color: '#ffb020' },
  sent: { ...Typography.title, color: Palette.accent },
  mono: { ...Typography.micro, color: Palette.textMuted },
  enclave: { ...Typography.micro, color: Palette.textMuted },
  progressWrap: { marginTop: Spacing.five, gap: Spacing.three },
  progressTrack: {
    height: 6,
    borderRadius: Radius.pill,
    backgroundColor: Palette.bgElevated,
    overflow: 'hidden',
  },
  progressFill: { height: 6, borderRadius: Radius.pill, backgroundColor: Palette.accent },
  progressRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.three },
  progressText: { ...Typography.caption, color: Palette.textSecondary },
  error: { ...Typography.caption, color: '#ff6b6b', marginTop: Spacing.four },
  hint: { ...Typography.micro, color: Palette.textMuted, marginTop: Spacing.four },
});
