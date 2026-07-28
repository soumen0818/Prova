import { CameraView, useCameraPermissions, type CameraType } from 'expo-camera';
import { Camera, Check, RefreshCw } from 'lucide-react-native';
import { useCallback, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/ui';
import { Palette, Radius, Spacing, Typography } from '@/constants/theme';

/**
 * One capture step of the KYC flow (document front/back, or a selfie).
 *
 * **The photo never leaves the phone.** In production the verification provider's SDK uploads
 * directly to the provider, so Prova's backend never receives an image — see
 * Docs/kyc-verification.md §3. Here we capture, let the user confirm quality, then report only
 * *that* the artefact was captured; the image itself is discarded when the flow completes.
 */
export function DocumentCapture({
  title,
  hint,
  facing = 'back',
  onCaptured,
}: {
  title: string;
  hint: string;
  /** 'front' for the selfie step, 'back' for documents. */
  facing?: CameraType;
  onCaptured: () => void;
}) {
  const [permission, requestPermission] = useCameraPermissions();
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const camera = useRef<CameraView>(null);

  const snap = useCallback(async () => {
    if (!camera.current || busy) return;
    setBusy(true);
    try {
      const photo = await camera.current.takePictureAsync({ quality: 0.7, skipProcessing: true });
      setPreview(photo?.uri ?? null);
    } finally {
      setBusy(false);
    }
  }, [busy]);

  // Permission is still resolving.
  if (!permission) return <View style={styles.frame} />;

  if (!permission.granted) {
    return (
      <View style={styles.center}>
        <Camera color={Palette.accent} size={34} strokeWidth={1.7} />
        <Text style={styles.title}>Camera access needed</Text>
        <Text style={styles.hint}>
          We use the camera only to capture your ID and a selfie for verification. The photos stay
          on your phone.
        </Text>
        <Button label="Allow camera" onPress={requestPermission} style={styles.cta} />
      </View>
    );
  }

  return (
    <View style={styles.wrap}>
      <Text style={styles.title}>{title}</Text>
      <Text style={styles.hint}>{hint}</Text>

      <View style={styles.frame}>
        {preview ? (
          <View style={styles.captured}>
            <Check color={Palette.accent} size={40} strokeWidth={2} />
            <Text style={styles.capturedText}>Captured</Text>
          </View>
        ) : (
          <CameraView ref={camera} style={StyleSheet.absoluteFill} facing={facing} />
        )}
      </View>

      {preview ? (
        <View style={styles.actions}>
          <Button label="Use this photo" onPress={onCaptured} />
          <Pressable onPress={() => setPreview(null)} hitSlop={8} style={styles.retake}>
            <RefreshCw color={Palette.accent} size={16} strokeWidth={2} />
            <Text style={styles.retakeText}>Retake</Text>
          </Pressable>
        </View>
      ) : (
        <Button label={busy ? 'Capturing…' : 'Take photo'} onPress={snap} loading={busy} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: Spacing.three },
  center: { alignItems: 'center', gap: Spacing.three, paddingVertical: Spacing.seven },
  title: { ...Typography.section, color: Palette.white, textAlign: 'center' },
  hint: { ...Typography.caption, color: Palette.textSecondary, textAlign: 'center' },
  cta: { alignSelf: 'stretch', marginTop: Spacing.four },
  frame: {
    height: 260,
    borderRadius: Radius.card,
    overflow: 'hidden',
    backgroundColor: Palette.bgElevated,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Palette.glassBorder,
    marginVertical: Spacing.three,
  },
  captured: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: Spacing.two },
  capturedText: { ...Typography.caption, color: Palette.accent, fontWeight: '600' },
  actions: { gap: Spacing.three },
  retake: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.two,
    paddingVertical: Spacing.two,
  },
  retakeText: { ...Typography.caption, color: Palette.accent, fontWeight: '600' },
});
