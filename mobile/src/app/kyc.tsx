import { useQueryClient } from '@tanstack/react-query';
import { Stack } from 'expo-router';
import { CheckCircle2, Clock, ShieldCheck, ShieldX, UserSearch } from 'lucide-react-native';
import { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { DocumentCapture } from '@/components/document-capture';
import { Loader } from '@/components/loader';
import { Button, Card, Screen } from '@/components/ui';
import { useToast } from '@/components/toast';
import {
  getVerification,
  startVerification,
  type CapturedArtifact,
  type KycCredential,
  type VerificationRecord,
} from '@/lib/api';
import { syncBackup } from '@/lib/cloud-backup';
import { collectCredential, daysRemaining, getStoredCredential } from '@/lib/kyc';
import { poolUserId } from '@/lib/pool';
import { KycIdentityStep, type CapturedIdentity } from '@/features/kyc-identity';
import { patchSession } from '@/lib/session';
import { QK } from '@/lib/queries';
import { captureError } from '@/lib/reporting';
import { Palette, Spacing, Typography } from '@/constants/theme';

/** Capture steps for a Tier-2 (standard) verification. */
const STEPS: { key: CapturedArtifact; title: string; hint: string; facing: 'front' | 'back' }[] = [
  {
    key: 'document_front',
    title: 'Front of your ID',
    hint: 'Emirates ID or passport photo page. Fill the frame, avoid glare.',
    facing: 'back',
  },
  {
    key: 'document_back',
    title: 'Back of your ID',
    hint: 'Skip if you used a passport photo page.',
    facing: 'back',
  },
  {
    key: 'selfie',
    title: 'Take a selfie',
    hint: 'We match your face to your ID. Look straight at the camera.',
    facing: 'front',
  },
];

/** How often to re-check status while a verification is being processed. */
const POLL_MS = 3000;

type Phase = 'loading' | 'identity' | 'intro' | 'capture' | 'status' | 'verified';

/**
 * Identity verification (Docs/kyc-verification.md).
 *
 * Capture ID + selfie → submit → poll the async state machine → on approval collect the
 * anchor-signed credential into the secure enclave.
 *
 * Two things worth knowing when reading this screen:
 *  - **No personal data is sent to Prova.** Photos stay on the device; the submit call carries only
 *    the opaque `userId` and which artefacts were captured.
 *  - **Approval is not instant and can fail.** `pending` and `in_review` are normal states, and a
 *    rejection may be terminal (sanctions/duplicate), in which case retrying is blocked.
 */
export default function KycScreen() {
  const toast = useToast();
  const queryClient = useQueryClient();

  const [phase, setPhase] = useState<Phase>('loading');
  const [userId, setUserId] = useState('');
  const [step, setStep] = useState(0);
  const [captured, setCaptured] = useState<CapturedArtifact[]>([]);
  const [record, setRecord] = useState<VerificationRecord | null>(null);
  const [credential, setCredential] = useState<KycCredential | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const poll = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = useCallback(() => {
    if (poll.current) {
      clearInterval(poll.current);
      poll.current = null;
    }
  }, []);

  /** Fetch status; on approval, collect the credential and finish. */
  const refresh = useCallback(
    async (uid: string) => {
      try {
        const v = await getVerification(uid);
        setRecord(v);
        if (v.status === 'approved') {
          stopPolling();
          const cred = await collectCredential(uid);
          if (cred) {
            setCredential(cred);
            setPhase('verified');
            await queryClient.invalidateQueries({ queryKey: QK.kyc });
            toast.success('Verified ✅');
            void syncBackup(); // carry the credential into the cloud backup (silent)
          } else {
            setError('Approved, but the credential could not be collected. Pull again shortly.');
          }
        } else if (v.status === 'rejected') {
          stopPolling();
        }
      } catch (e) {
        captureError(e, { step: 'kyc-status' });
      }
    },
    [queryClient, stopPolling, toast],
  );

  // Resolve the wallet id and pick up any existing credential / in-flight verification.
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        // Bound to the POOL spending key, not the older v2 transfer secret: the spend circuit
        // derives `user_id = Poseidon(ownerSk, domain)`, so a credential issued against anything
        // else produces a proof the contract rejects with no explanation.
        const uid = await poolUserId();
        if (!active) return;
        setUserId(uid);

        const stored = await getStoredCredential();
        if (stored) {
          if (!active) return;
          setCredential(stored);
          setPhase('verified');
          return;
        }
        const v = await getVerification(uid).catch(() => null);
        if (!active) return;
        if (v && v.status !== 'not_started') {
          setRecord(v);
          setPhase('status');
        } else {
          setPhase('intro');
        }
      } catch (e) {
        captureError(e, { step: 'kyc-init' });
        if (active) setPhase('intro');
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  // Poll only while an outcome is still pending.
  useEffect(() => {
    const inFlight = record?.status === 'pending' || record?.status === 'in_review';
    if (phase !== 'status' || !inFlight || !userId) return;
    poll.current = setInterval(() => void refresh(userId), POLL_MS);
    return () => stopPolling();
  }, [phase, record?.status, userId, refresh, stopPolling]);

  const submit = useCallback(
    async (artifacts: CapturedArtifact[]) => {
      setBusy(true);
      setError('');
      try {
        const v = await startVerification(userId, 2, artifacts);
        setRecord(v);
        setPhase('status');
      } catch (e) {
        captureError(e, { step: 'kyc-submit' });
        setError('Could not submit your verification. Check your connection and try again.');
      } finally {
        setBusy(false);
      }
    },
    [userId],
  );

  const onCaptured = useCallback(() => {
    const key = STEPS[step].key;
    setCaptured((prev) => (prev.includes(key) ? prev : [...prev, key]));
    if (step < STEPS.length - 1) {
      setStep(step + 1);
    } else {
      void submit([...captured, key]);
    }
  }, [step, captured, submit]);

  const restart = useCallback(() => {
    setCaptured([]);
    setStep(0);
    setError('');
    setPhase('capture');
  }, []);

  // ---------- Render ----------

  /**
   * Identity captured: keep the name and number on-device, then move on to documents.
   *
   * Stored in the session rather than sent anywhere — the backend deliberately holds no PII (see
   * Docs/kyc-verification.md §3), and the anchor receives identity data through its own vendor. The
   * app keeps them to prefill later steps and to show what has been provided.
   *
   * The number is **user-asserted**: phone OTP verification is planned but not yet wired, so nothing
   * should treat it as proved. The account's verified channel is the email from sign-in.
   */
  const onIdentityCaptured = useCallback(
    async (identity: CapturedIdentity) => {
      try {
        await patchSession({ name: identity.name, phone: identity.phone });
        await queryClient.invalidateQueries({ queryKey: QK.session });
      } catch (e) {
        captureError(e, { step: 'kyc-identity-save' });
        // Not fatal: verification can continue, and the details are re-collected if needed.
      }
      setPhase('capture');
    },
    [queryClient],
  );

  if (phase === 'loading') {
    return (
      <Screen>
        <Stack.Screen options={{ title: 'Verify identity' }} />
        <View style={styles.center}>
          <Loader size={12} />
        </View>
      </Screen>
    );
  }

  if (phase === 'verified' && credential) {
    const left = daysRemaining(credential);
    return (
      <Screen scroll>
        <Stack.Screen options={{ title: 'Verify identity' }} />
        <View style={styles.hero}>
          <View style={styles.badge}>
            <ShieldCheck color={Palette.accent} size={38} strokeWidth={1.7} />
          </View>
          <Text style={styles.heroTitle}>You’re verified</Text>
          <Text style={styles.heroBody}>
            Your credential is stored in this device’s secure enclave and proves you’re verified
            without revealing who you are.
          </Text>
        </View>
        <Card style={styles.card}>
          <Row label="Status" value="Verified" accent />
          <Row label="Tier" value={`Level ${credential.kycLevel}`} />
          <Row label="Valid for" value={`${left} day${left === 1 ? '' : 's'}`} />
        </Card>
        <Text style={styles.note}>
          Credentials are short-lived and renew automatically — that’s how verification stays
          current without ever putting your identity on-chain.
        </Text>
      </Screen>
    );
  }

  if (phase === 'intro') {
    return (
      <Screen scroll>
        <Stack.Screen options={{ title: 'Verify identity' }} />
        <View style={styles.hero}>
          <View style={styles.badge}>
            <UserSearch color={Palette.accent} size={36} strokeWidth={1.7} />
          </View>
          <Text style={styles.heroTitle}>Verify your identity</Text>
          <Text style={styles.heroBody}>
            A one-time check to send money legally. You’ll photograph your ID and take a selfie.
          </Text>
        </View>
        <Card style={styles.card}>
          <Bullet text="Your photos stay on this phone — Prova never stores your ID or your name." />
          <Bullet text="Checks usually finish in under a minute; sometimes a person reviews them." />
          <Bullet text="Once verified, every transfer proves compliance without revealing you." />
        </Card>
        <Button label="Start verification" onPress={() => setPhase('identity')} />
      </Screen>
    );
  }

  if (phase === 'identity') {
    return (
      <Screen scroll>
        <Stack.Screen options={{ title: 'Verify identity' }} />
        <Text style={styles.progress}>Step 1 of {STEPS.length + 1}</Text>
        <KycIdentityStep onCaptured={onIdentityCaptured} />
      </Screen>
    );
  }

  if (phase === 'capture') {
    const s = STEPS[step];
    return (
      <Screen scroll>
        <Stack.Screen options={{ title: 'Verify identity' }} />
        <Text style={styles.progress}>
          Step {step + 2} of {STEPS.length + 1}
        </Text>
        <DocumentCapture
          key={s.key}
          title={s.title}
          hint={s.hint}
          facing={s.facing}
          onCaptured={onCaptured}
        />
        {step === 1 ? (
          <Button
            label="Skip — I used a passport"
            variant="glass"
            onPress={onCaptured}
            style={styles.skip}
          />
        ) : null}
        {busy ? (
          <View style={styles.busyRow}>
            <Loader />
            <Text style={styles.busyText}>Submitting…</Text>
          </View>
        ) : null}
        {error ? <Text style={styles.error}>{error}</Text> : null}
      </Screen>
    );
  }

  // phase === 'status'
  return (
    <Screen scroll>
      <Stack.Screen options={{ title: 'Verify identity' }} />
      <StatusView record={record} onRetry={restart} />
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </Screen>
  );
}

function StatusView({
  record,
  onRetry,
}: {
  record: VerificationRecord | null;
  onRetry: () => void;
}) {
  const status = record?.status ?? 'pending';

  if (status === 'rejected') {
    // A terminal rejection (sanctions, duplicate identity, tampered document) must not be retried —
    // the backend refuses a resubmission, so we don't offer one.
    const canRetry = record?.retryable === true;
    return (
      <>
        <View style={styles.hero}>
          <View style={styles.badge}>
            <ShieldX color={Palette.statusDown} size={36} strokeWidth={1.7} />
          </View>
          <Text style={styles.heroTitle}>We couldn’t verify you</Text>
          <Text style={styles.heroBody}>{reasonText(record?.reasonCode)}</Text>
        </View>
        {canRetry ? (
          <Button label="Try again" onPress={onRetry} />
        ) : (
          <Card style={styles.card}>
            <Text style={styles.note}>
              This decision is final and can’t be retried in the app. Contact support if you believe
              it’s a mistake.
            </Text>
          </Card>
        )}
      </>
    );
  }

  const inReview = status === 'in_review';
  return (
    <>
      <View style={styles.hero}>
        <View style={styles.badge}>
          {inReview ? (
            <Clock color={Palette.accent} size={36} strokeWidth={1.7} />
          ) : (
            <CheckCircle2 color={Palette.accent} size={36} strokeWidth={1.7} />
          )}
        </View>
        <Text style={styles.heroTitle}>{inReview ? 'Under review' : 'Checking your details'}</Text>
        <Text style={styles.heroBody}>
          {inReview
            ? 'A specialist is taking a closer look. This can take a little longer — we’ll update this screen automatically.'
            : 'Running the automated checks. This usually takes under a minute.'}
        </Text>
      </View>
      <View style={styles.busyRow}>
        <Loader />
        <Text style={styles.busyText}>Waiting for the result…</Text>
      </View>
      <Text style={styles.note}>
        You can leave this screen — we’ll keep checking in the background.
      </Text>
    </>
  );
}

/** Plain-language explanation of a rejection, so the user knows what to fix. */
function reasonText(code?: string): string {
  switch (code) {
    case 'document_unreadable':
      return 'Your ID photo wasn’t clear enough to read. Try again in better light.';
    case 'document_expired':
      return 'That ID has expired. Please use a valid document.';
    case 'face_mismatch':
      return 'Your selfie didn’t match the photo on your ID.';
    case 'liveness_failed':
      return 'We couldn’t confirm a live selfie. Take it yourself, in good light.';
    case 'document_tampered':
      return 'The document couldn’t be accepted.';
    case 'sanctions_hit':
    case 'duplicate_identity':
    case 'underage':
      return 'We’re unable to verify this identity.';
    default:
      return 'Something didn’t pass our checks.';
  }
}

function Row({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <View style={styles.row}>
      <Text style={styles.label}>{label}</Text>
      <Text style={[styles.value, accent ? styles.valueAccent : null]}>{value}</Text>
    </View>
  );
}

function Bullet({ text }: { text: string }) {
  return (
    <View style={styles.bullet}>
      <View style={styles.dot} />
      <Text style={styles.bulletText}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  hero: { alignItems: 'center', gap: Spacing.three, marginBottom: Spacing.six },
  badge: {
    width: 80,
    height: 80,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Palette.glass,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Palette.glassBorder,
  },
  heroTitle: { ...Typography.title, fontSize: 22, color: Palette.white, textAlign: 'center' },
  heroBody: { ...Typography.caption, color: Palette.textSecondary, textAlign: 'center' },
  card: { gap: Spacing.three, marginBottom: Spacing.five },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  label: { ...Typography.caption, color: Palette.textSecondary },
  value: { ...Typography.caption, fontWeight: '600', color: Palette.white },
  valueAccent: { color: Palette.accent },
  bullet: { flexDirection: 'row', gap: Spacing.three, alignItems: 'flex-start' },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: Palette.accent,
    marginTop: 7,
  },
  bulletText: { ...Typography.caption, color: Palette.textSecondary, flex: 1 },
  progress: {
    ...Typography.micro,
    color: Palette.textMuted,
    textAlign: 'center',
    marginBottom: Spacing.three,
  },
  skip: { marginTop: Spacing.three },
  busyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.three,
    marginVertical: Spacing.four,
  },
  busyText: { ...Typography.caption, color: Palette.textSecondary },
  note: { ...Typography.micro, color: Palette.textMuted, textAlign: 'center' },
  error: { ...Typography.caption, color: Palette.statusDown, marginTop: Spacing.four },
});
