import { CameraView, useCameraPermissions } from 'expo-camera';
import { X } from 'lucide-react-native';
import { useCallback, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button } from '@/components/ui';
import { decodePoolAddress, type Payee } from '@/lib/pool';
import { Palette, Radius, Spacing, Typography } from '@/constants/theme';

/**
 * Scan someone's Prova address from the QR on their Receive screen.
 *
 * The Receive screen has always shown a QR code; until now nothing could read one, so the only way
 * to add a recipient was to get the address across as text — through a chat app, then the clipboard.
 * That is the step people found fiddly, and the step where a truncated paste silently produces an
 * address that is not theirs. Pasting stays on the form for an address that arrived as text.
 *
 * Rendered **inline and full-screen**, not inside a React Native `Modal` and not inside the form's
 * ScrollView. Both were tried: a `Modal` gets its own window on Android, and inside a ScrollView the
 * absolute positioning resolves against scrolling content rather than the window — either way the
 * preview came up black and the overlay was cut off. The KYC capture screens render their cameras
 * inline for the same reason.
 *
 * Nothing is ever captured or stored. The camera reads codes; the only thing taken from one is a
 * valid Prova address, and anything else is refused on screen while scanning continues.
 */
export function AddressScanner({
  onClose,
  onScanned,
}: {
  onClose: () => void;
  onScanned: (payee: Payee) => void;
}) {
  const insets = useSafeAreaInsets();
  const [permission, requestPermission] = useCameraPermissions();
  const [error, setError] = useState('');
  /**
   * The camera fires continuously while a code is in frame, so without this the handler runs dozens
   * of times for one scan — closing the view mid-close and re-reporting the same address.
   */
  const handled = useRef(false);
  /** The last code refused, so holding it in frame does not re-report it on every frame. */
  const lastRejected = useRef('');

  const onBarcode = useCallback(
    ({ data }: { data: string }) => {
      if (handled.current) return;

      const decoded = decodePoolAddress(data);
      if (!decoded) {
        // Refused, and nothing is taken from it. The scanner stays open because the camera is very
        // likely still pointed at the right screen and the person caught a different code.
        if (lastRejected.current !== data) {
          lastRejected.current = data;
          setError('That is not a Prova QR code. Point at their Receive screen.');
        }
        return;
      }

      handled.current = true;
      lastRejected.current = '';
      setError('');
      onScanned(decoded);
    },
    [onScanned],
  );

  const close = useCallback(() => {
    handled.current = false;
    lastRejected.current = '';
    setError('');
    onClose();
  }, [onClose]);

  return (
    <View style={styles.root}>
      {permission?.granted ? (
        <CameraView
          style={StyleSheet.absoluteFill}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={onBarcode}
        />
      ) : null}

      <View style={styles.overlay} pointerEvents="box-none">
        <View style={[styles.header, { paddingTop: insets.top + Spacing.three }]}>
          <Text style={styles.title}>Scan their Prova address</Text>
          <Pressable onPress={close} hitSlop={12} accessibilityLabel="Close scanner">
            <X color={Palette.white} size={24} strokeWidth={2} />
          </Pressable>
        </View>

        {permission?.granted ? (
          <>
            {/*
              The frame turns red the moment a code is refused, so the failure lands where the
              person is actually looking — on the thing they are pointing at — rather than only as
              text underneath it.
            */}
            <View style={[styles.frame, error ? styles.frameError : null]} />

            <View style={[styles.footer, { paddingBottom: insets.bottom + Spacing.five }]}>
              {error ? (
                <Text style={styles.error}>{error}</Text>
              ) : (
                <Text style={styles.hint}>Point at their Prova QR code</Text>
              )}
            </View>
          </>
        ) : (
          <View style={styles.permission}>
            <Text style={styles.permissionTitle}>Camera access needed</Text>
            <Text style={styles.hint}>
              Only to read the QR code. Nothing is recorded, and no image leaves your phone.
            </Text>
            <Button label="Allow camera" onPress={requestPermission} style={styles.cta} />
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: '#000',
    zIndex: 10,
  },
  overlay: { flex: 1, justifyContent: 'space-between' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.five,
    paddingBottom: Spacing.four,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  title: { ...Typography.section, color: Palette.white },
  frame: {
    alignSelf: 'center',
    width: 250,
    height: 250,
    borderRadius: Radius.card,
    borderWidth: 2,
    borderColor: Palette.accent,
  },
  frameError: { borderColor: Palette.statusDown },
  footer: {
    paddingHorizontal: Spacing.five,
    paddingTop: Spacing.four,
    minHeight: 96,
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  hint: { ...Typography.body, color: Palette.white, textAlign: 'center' },
  error: { ...Typography.body, color: Palette.statusDown, textAlign: 'center', lineHeight: 22 },
  permission: {
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: Spacing.five,
    gap: Spacing.three,
  },
  permissionTitle: { ...Typography.title, color: Palette.white },
  cta: { marginTop: Spacing.three },
});
