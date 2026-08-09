import { CameraView, useCameraPermissions, type CameraType } from 'expo-camera';
import { Camera, Check, RefreshCw } from 'lucide-react-native';
import { useCallback, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/ui';
import { checkDocument, type DocumentSide } from '@/lib/document-check';
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
  side = 'front',
  onCaptured,
}: {
  title: string;
  hint: string;
  /** Which camera to use: 'front' for the selfie step, 'back' for documents. */
  facing?: CameraType;
  /**
   * Which side of the document this is — distinct from `facing`, which is the camera. Only the
   * photo page is expected to contain a face, so the checks differ.
   */
  side?: DocumentSide;
  onCaptured: () => void;
}) {
  const [permission, requestPermission] = useCameraPermissions();
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Why the last capture was not accepted; cleared on the next attempt. */
  const [rejected, setRejected] = useState('');
  const camera = useRef<CameraView>(null);

  const snap = useCallback(async () => {
    if (!camera.current || busy) return;
    setBusy(true);
    setRejected('');
    try {
      const photo = await camera.current.takePictureAsync({ quality: 0.7, skipProcessing: true });
      if (!photo?.uri) return;

      // Check before showing "Use this photo": telling someone their ID was unreadable while the
      // document is still in their hand is worth far more than a rejection days later.
      const verdict = await checkDocument(photo.uri, side);
      if (!verdict.ok) {
        setRejected(verdict.reason ?? 'That does not look like an ID. Please try again.');
        return;
      }
      setPreview(photo.uri);
    } finally {
      setBusy(false);
    }
  }, [busy, side]);

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
        <>
          {rejected ? <Text style={styles.rejected}>{rejected}</Text> : null}
          <Button label={busy ? 'Checking…' : 'Take photo'} onPress={snap} loading={busy} />
        </>
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
  rejected: { ...Typography.caption, color: Palette.statusDown, textAlign: 'center' },
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
