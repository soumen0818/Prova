import { CameraView, useCameraPermissions } from 'expo-camera';
import FaceDetection, { type Face } from '@react-native-ml-kit/face-detection';
import { Check, ScanFace } from 'lucide-react-native';
import { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Loader } from '@/components/loader';
import { Button } from '@/components/ui';
import { Palette, Spacing, Typography } from '@/constants/theme';

/**
 * The selfie step, as a guided liveness sequence.
 *
 * Each challenge is **actually checked** against ML Kit's face analysis of the captured frame — a
 * blink is confirmed by eye-open probability collapsing, a head turn by the yaw angle moving. This
 * is what stops the obvious attack on a selfie step: holding up a photograph of someone else, which
 * passes a single static capture and fails every challenge here.
 *
 * What this is *not*: it does not match the face against the ID document, and it does not judge
 * whether the ID itself is genuine. Both are the verification provider's job (Sumsub/Onfido/Persona
 * — see Docs/kyc-verification.md §8), and the frames captured here are what its SDK would score.
 * Liveness is one signal of several, not the whole check.
 *
 * The images never leave the device, exactly as in `DocumentCapture`.
 */

interface Challenge {
  key: 'center' | 'blink' | 'turn';
  prompt: string;
  hint: string;
  /** Returns true when this frame satisfies the challenge. */
  passes: (face: Face, baseline: number | null) => boolean;
}

/** ML Kit reports ~0 when an eye is shut and ~1 when open; well clear of each other in practice. */
const EYES_CLOSED_BELOW = 0.35;
const EYES_OPEN_ABOVE = 0.7;
/** Degrees of yaw that count as a deliberate turn rather than natural sway. */
const TURN_DEGREES = 18;

const CHALLENGES: Challenge[] = [
  {
    key: 'center',
    prompt: 'Look straight at the camera',
    hint: 'Fit your face in the circle, eyes open.',
    passes: (f) =>
      (f.leftEyeOpenProbability ?? 1) > EYES_OPEN_ABOVE &&
      (f.rightEyeOpenProbability ?? 1) > EYES_OPEN_ABOVE &&
      Math.abs(f.rotationY ?? 0) < TURN_DEGREES,
  },
  {
    key: 'blink',
    prompt: 'Now blink',
    hint: 'Close both eyes for a moment.',
    passes: (f) =>
      (f.leftEyeOpenProbability ?? 1) < EYES_CLOSED_BELOW &&
      (f.rightEyeOpenProbability ?? 1) < EYES_CLOSED_BELOW,
  },
  {
    key: 'turn',
    prompt: 'Slowly turn your head to one side',
    hint: 'Either side is fine — keep your face in frame.',
    // Measured against the angle recorded when centred, so someone whose neutral pose is already
    // off-axis is not asked for a bigger turn than everyone else.
    passes: (f, baseline) => Math.abs((f.rotationY ?? 0) - (baseline ?? 0)) > TURN_DEGREES,
  },
];

/** How often to sample the camera while a challenge is active. */
const SAMPLE_MS = 700;

export function LivenessCapture({ onCaptured }: { onCaptured: () => void }) {
  const [permission, requestPermission] = useCameraPermissions();
  const [index, setIndex] = useState(0);
  const [checking, setChecking] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [done, setDone] = useState(false);

  const camera = useRef<CameraView>(null);
  /** Yaw when the user was centred, so the turn challenge is relative to their own neutral pose. */
  const baselineYaw = useRef<number | null>(null);
  /** Guards the sampling loop against overlapping captures and against running after unmount. */
  const busy = useRef(false);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const sample = useCallback(async () => {
    if (busy.current || !camera.current || done) return;
    busy.current = true;
    try {
      const photo = await camera.current.takePictureAsync({
        quality: 0.5,
        skipProcessing: true,
        shutterSound: false,
      });
      if (!photo?.uri || !alive.current) return;

      // `classificationMode: 'all'` is what populates the eye-open probabilities; without it the
      // blink challenge can never pass.
      const faces = await FaceDetection.detect(photo.uri, {
        performanceMode: 'fast',
        landmarkMode: 'none',
        classificationMode: 'all',
      });
      if (!alive.current) return;

      if (faces.length === 0) {
        setFeedback('No face detected — move into the light.');
        return;
      }
      if (faces.length > 1) {
        setFeedback('More than one face in frame.');
        return;
      }

      const face = faces[0];
      const challenge = CHALLENGES[index];
      if (!challenge.passes(face, baselineYaw.current)) {
        setFeedback('');
        return;
      }

      if (challenge.key === 'center') baselineYaw.current = face.rotationY ?? 0;

      if (index < CHALLENGES.length - 1) {
        setIndex((i) => i + 1);
        setFeedback('');
      } else {
        setDone(true);
      }
    } catch {
      // A dropped frame is normal (camera busy, detector hiccup) — the next tick retries.
    } finally {
      busy.current = false;
    }
  }, [index, done]);

  // Sample on a timer while a challenge is outstanding.
  useEffect(() => {
    if (!permission?.granted || done || !checking) return;
    const id = setInterval(() => void sample(), SAMPLE_MS);
    return () => clearInterval(id);
  }, [permission?.granted, done, checking, sample]);

  if (!permission) {
    return (
      <View style={styles.center}>
        <Loader />
      </View>
    );
  }

  if (!permission.granted) {
    return (
      <View style={styles.gate}>
        <ScanFace color={Palette.accent} size={32} strokeWidth={1.8} />
        <Text style={styles.title}>Camera access needed</Text>
        <Text style={styles.hint}>We use the camera only for this check.</Text>
        <Button label="Allow camera" onPress={requestPermission} />
      </View>
    );
  }

  if (done) {
    return (
      <View style={styles.gate}>
        <View style={styles.doneBadge}>
          <Check color={Palette.accent} size={34} strokeWidth={2.2} />
        </View>
        <Text style={styles.title}>Liveness confirmed</Text>
        <Text style={styles.hint}>Thanks — that is everything we need.</Text>
        <Button label="Continue" onPress={onCaptured} />
      </View>
    );
  }

  const challenge = CHALLENGES[index];

  return (
    <View style={styles.wrap}>
      <View style={styles.cameraRing}>
        <CameraView ref={camera} style={styles.camera} facing="front" />
      </View>

      <Text style={styles.prompt}>{challenge.prompt}</Text>
      <Text style={styles.hint}>{feedback || challenge.hint}</Text>

      <View style={styles.dots}>
        {CHALLENGES.map((c, i) => (
          <View key={c.key} style={[styles.dot, i <= index ? styles.dotActive : null]} />
        ))}
      </View>

      {checking ? (
        <View style={styles.busyRow}>
          <Loader />
          <Text style={styles.hint}>Checking…</Text>
        </View>
      ) : (
        <Button label="Start check" onPress={() => setChecking(true)} />
      )}
    </View>
  );
}

const CIRCLE = 260;

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', gap: Spacing.three },
  center: { alignItems: 'center', justifyContent: 'center', paddingVertical: Spacing.seven },
  gate: { alignItems: 'center', gap: Spacing.three, paddingVertical: Spacing.six },
  cameraRing: {
    width: CIRCLE,
    height: CIRCLE,
    borderRadius: CIRCLE / 2,
    overflow: 'hidden',
    borderWidth: 2,
    borderColor: Palette.accent,
    marginBottom: Spacing.two,
  },
  camera: { flex: 1 },
  prompt: { ...Typography.section, color: Palette.white, textAlign: 'center' },
  title: { ...Typography.section, color: Palette.white },
  hint: { ...Typography.caption, color: Palette.textSecondary, textAlign: 'center' },
  dots: { flexDirection: 'row', gap: Spacing.two, marginVertical: Spacing.two },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: Palette.bgElevated,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Palette.border,
  },
  dotActive: { backgroundColor: Palette.accent, borderColor: Palette.accent },
  doneBadge: {
    width: 80,
    height: 80,
    borderRadius: 40,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Palette.glass,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Palette.glassBorder,
  },
  busyRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.three },
});
