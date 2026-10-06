import { useQueryClient } from '@tanstack/react-query';
import { Stack, useRouter } from 'expo-router';
import { Clock, ShieldCheck, ShieldX, UserSearch } from 'lucide-react-native';
import { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Loader } from '@/components/loader';
import { Button, Card, Screen } from '@/components/ui';
import { useToast } from '@/components/toast';
import {
  ApiError,
  getVerification,
  startVerification,
  type KycCredential,
  type VerificationRecord,
} from '@/lib/api';
import { syncBackup } from '@/lib/cloud-backup';
import { collectCredential, daysRemaining, getUsableCredential } from '@/lib/kyc';
import { poolUserId } from '@/lib/pool';
import { QK } from '@/lib/queries';
import { captureError } from '@/lib/reporting';
import { Palette, Spacing, Typography } from '@/constants/theme';

/** How often to re-check status while a verification is being processed. */
const POLL_MS = 3000;

type Phase = 'loading' | 'intro' | 'status' | 'verified';

/**
 * What to tell someone whose verification would not submit.
 *
 * One message per cause, because the causes have different fixes and only one of them is the
 * network. Blaming the connection for all of them sent a tester to check a connection that was
 * working, at the end of a flow they had just spent minutes on.
 *
 * A 401 is worth special care. `api` already clears the dead session and the root gate redirects to
 * sign-in on its own, so by the time this renders the person is on their way out of the flow — the
 * message explains what is about to happen rather than asking them to do something.
 */
function submitErrorMessage(e: unknown): string {
  if (!(e instanceof ApiError)) {
    return 'Something went wrong preparing your request. Please try again.';
  }
  // Transport failure or abort. The one case where checking the connection is the right advice.
  if (e.status === 0) {
    return 'Could not reach Prova. Check your connection and try again.';
  }
  switch (e.status) {
    case 401:
      return (
        'Your session expired, so we could not submit this. Sign in again and request the test ' +
        'credential once more.'
      );
    case 403:
      // Either the wallet belongs to another account, or the verification is terminally rejected.
      // The server writes both to be read by a person, so use its words rather than guessing which.
      return e.message;
    case 429:
      return 'Too many attempts. Please wait a moment and try again.';
    default:
      if (e.status >= 500) {
        return (
          'Verification is temporarily unavailable — this one is on us, not you. Please try ' +
          'again in a few minutes.'
        );
      }
      return e.message;
  }
}

/**
 * Identity verification (Docs/kyc-verification.md).
 *
 * Request an operator-reviewed demo credential without collecting identity documents.
 * The backend reads the account email from the authenticated session for the queue.
 */

export default function KycScreen() {
  const toast = useToast();
  const queryClient = useQueryClient();

  const [phase, setPhase] = useState<Phase>('loading');
  const [userId, setUserId] = useState('');
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
          const cred = await collectCredential(uid);
          if (cred) {
            // Stop only once the credential is actually in hand. Stopping before the attempt meant a
            // single failed collection ended the polling for good, leaving an approved user on a
            // screen that asked them to "pull again" — with nothing on it to pull.
            stopPolling();
            setCredential(cred);
            setPhase('verified');
            await queryClient.invalidateQueries({ queryKey: QK.kyc });
            toast.success('Test credential ready');
            void syncBackup(); // carry the credential into the cloud backup (silent)
          } else {
            setError('Approved — finishing up. This will complete on its own in a moment.');
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

        const stored = await getUsableCredential(uid);
        if (stored) {
          if (!active) return;
          setCredential(stored);
          setPhase('verified');
          return;
        }
        const v = await getVerification(uid).catch(() => null);
        if (!active) return;
        if (v && v.status !== 'not_started' && v.status !== 'expired') {
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

  // Poll while an outcome is still pending — or while an approval is waiting to be collected.
  useEffect(() => {
    /*
     * `approved` counts as in-flight until the credential is actually stored.
     *
     * Collection can fail on a flaky connection, and it is the poll that retries it. Treating
     * `approved` as finished here stopped the timer the moment the status arrived, so one failed
     * collection stranded a verified user on the waiting screen with no way back.
     */
    const awaitingCollection = record?.status === 'approved' && !credential;
    const inFlight =
      record?.status === 'pending' || record?.status === 'in_review' || awaitingCollection;
    if (phase !== 'status' || !inFlight || !userId) return;
    poll.current = setInterval(() => void refresh(userId), POLL_MS);
    return () => stopPolling();
  }, [phase, record?.status, credential, userId, refresh, stopPolling]);

  const submit = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      if (!userId) {
        setError('Wallet is not ready. Return to the home screen and try again.');
        return;
      }
      const v = await startVerification(userId, 2);
      setRecord(v);
      setPhase('status');
    } catch (e) {
      captureError(e, { step: 'kyc-submit' });
      /*
       * Say which failure it was.
       *
       * This used to report *every* failure as "check your connection and try again", including
       * ones the network had nothing to do with. A tester whose session had gone stale was told to
       * check a connection that was working perfectly, went and checked it, and reported the app
       * as broken — reasonably, because nothing on screen pointed at the actual problem.
       *
       * `ApiError.status` already carries what happened, so there is no excuse for guessing.
       *
       * Note `status === 0` is the ONLY genuine connectivity failure — `api` gives transport
       * errors and aborts that code. Branch on status, never on the message.
       */
      setError(submitErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }, [userId]);

  const restart = useCallback(() => {
    setError('');
    setPhase('intro');
  }, []);

  // ---------- Render ----------

  if (phase === 'loading') {
    return (
      <Screen>
        <Stack.Screen options={{ title: 'Test credential' }} />
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
        <Stack.Screen options={{ title: 'Test credential' }} />
        <View style={styles.hero}>
          <View style={styles.badge}>
            <ShieldCheck color={Palette.accent} size={38} strokeWidth={1.7} />
          </View>
          <Text style={styles.heroTitle}>Test credential ready</Text>
          <Text style={styles.heroBody}>
            This demo credential lets you try private transfers on testnet. It is not proof that a
            licensed provider checked your identity.
          </Text>
        </View>
        <Card style={styles.card}>
          <Row label="Status" value="Demo approved" accent />
          <Row label="Tier" value={`Level ${credential.kycLevel}`} />
          <Row label="Valid for" value={`${left} day${left === 1 ? '' : 's'}`} />
        </Card>
        <Text style={styles.note}>
          The credential is stored on your device. Midnight eligibility is not connected to this app
          yet; Stellar currently checks the test credential in its own proof.
        </Text>
      </Screen>
    );
  }

  if (phase === 'intro') {
    return (
      <Screen scroll>
        <Stack.Screen options={{ title: 'Test credential' }} />
        <View style={styles.hero}>
          <View style={styles.badge}>
            <UserSearch color={Palette.accent} size={36} strokeWidth={1.7} />
          </View>
          <Text style={styles.heroTitle}>Request a test credential</Text>
          <Text style={styles.heroBody}>
            This testnet build uses a demo approval process. It does not verify your identity or ask
            for ID photos.
          </Text>
        </View>
        <Card style={styles.card}>
          <Bullet text="An operator may approve a demo credential without reviewing identity documents." />
          <Bullet text="Use test assets only. This is not a real KYC or regulated payment service." />
          <Bullet text="Stellar uses the test credential today; Midnight integration is in progress." />
        </Card>
        <Button
          label="Request test credential"
          onPress={() => void submit()}
          disabled={busy || !userId}
        />
        {error ? <Text style={styles.error}>{error}</Text> : null}
      </Screen>
    );
  }

  // phase === 'status'
  return (
    <Screen scroll>
      <Stack.Screen options={{ title: 'Test credential' }} />
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
  const router = useRouter();
  const status = record?.status ?? 'pending';

  if (status === 'expired') {
    return (
      <>
        <View style={styles.hero}>
          <View style={styles.badge}>
            <Clock color={Palette.accent} size={36} strokeWidth={1.7} />
          </View>
          <Text style={styles.heroTitle}>Test credential expired</Text>
          <Text style={styles.heroBody}>
            The old credential cannot be used for a new transfer. Request another demo approval.
          </Text>
        </View>
        <Button label="Request a new test credential" onPress={onRetry} />
      </>
    );
  }

  if (status === 'rejected') {
    // A terminal operator decision cannot be retried through the app.
    const canRetry = record?.retryable === true;
    return (
      <>
        <View style={styles.hero}>
          <View style={styles.badge}>
            <ShieldX color={Palette.statusDown} size={36} strokeWidth={1.7} />
          </View>
          <Text style={styles.heroTitle}>Request not approved</Text>
          <Text style={styles.heroBody}>{reasonText(record?.reasonCode)}</Text>
        </View>
        {canRetry ? (
          <Button label="Try again" onPress={onRetry} />
        ) : (
          <Card style={styles.card}>
            <Text style={styles.note}>
              This decision is final and can’t be retried in the app. Message us if you believe it’s
              a mistake.
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
          <Clock color={Palette.accent} size={36} strokeWidth={1.7} />
        </View>
        <Text style={styles.heroTitle}>
          {inReview ? 'Demo approval pending' : 'Request received'}
        </Text>
        <Text style={styles.heroBody}>
          An operator can approve this test credential. No identity documents are checked in this
          build. Check this screen again for the decision.
        </Text>
      </View>
      <Card style={styles.card}>
        <Bullet text="You can close the app and return here to check the status." />
        <Bullet text="Approval timing depends on the test operator." />
        <Bullet text="If your request is stuck, message us." />
      </Card>
      {/*
        A direct way through, rather than "go to your profile and find the chat". Someone opening
        this screen for the second day running is exactly the person who should not have to hunt for
        the way to ask about it.
      */}
      <Button label="Chat with us" variant="secondary" onPress={() => router.push('/support')} />
      <Text style={styles.note}>No identity documents are requested for this test flow.</Text>
    </>
  );
}

/** The demo operator can reject a request without performing an identity check. */
function reasonText(code?: string): string {
  return code === 'manual_review'
    ? 'An operator has not approved this test credential yet.'
    : 'This test-credential request was not approved. Contact support if you need help.';
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
  note: { ...Typography.micro, color: Palette.textMuted, textAlign: 'center' },
  error: { ...Typography.caption, color: Palette.statusDown, marginTop: Spacing.four },
});
