import { ShieldCheck } from 'lucide-react-native';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/ui';
import { Palette, Radius, Spacing, Typography } from '@/constants/theme';

/**
 * The approval sheet shown before anything is signed.
 *
 * Signing lives in `lib/onchain.ts`, which is plain async code with no React tree of its own — so it
 * cannot render a dialog. Previously it fell back to `Alert.alert`, which works but hands the most
 * security-critical moment in the app to an OS dialog that looks like every permission prompt the
 * user dismisses without reading.
 *
 * The bridge below lets that non-React code await a real UI: the provider registers a handler, and
 * `requestApproval()` returns a promise that settles when the user chooses. If no provider is
 * mounted the request is **rejected**, never auto-approved — failing closed is the only safe
 * default for a signature.
 */

type Handler = (summary: string) => Promise<boolean>;

let handler: Handler | null = null;

/** Ask the user to approve `summary`. Resolves true on approve, false on cancel. */
export function requestApproval(summary: string): Promise<boolean> {
  if (!handler) {
    return Promise.reject(new Error('Approval UI unavailable — nothing was signed.'));
  }
  return handler(summary);
}

interface Pending {
  summary: string;
  resolve: (approved: boolean) => void;
}

export function ApproveProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);
  // Held in a ref so the handler registered below never closes over a stale setter.
  const pendingRef = useRef<Pending | null>(null);

  const settle = useCallback((approved: boolean) => {
    pendingRef.current?.resolve(approved);
    pendingRef.current = null;
    setPending(null);
  }, []);

  useEffect(() => {
    handler = (summary: string) =>
      new Promise<boolean>((resolve) => {
        // A second request while one is open would strand the first promise forever; decline it
        // rather than leave a caller hanging.
        if (pendingRef.current) {
          resolve(false);
          return;
        }
        const next = { summary, resolve };
        pendingRef.current = next;
        setPending(next);
      });
    return () => {
      handler = null;
      // Unmounting with a request open must not leave the caller awaiting forever.
      pendingRef.current?.resolve(false);
      pendingRef.current = null;
    };
  }, []);

  return (
    <>
      {children}
      <Modal
        visible={pending !== null}
        transparent
        animationType="fade"
        // Android back button counts as declining, not as approving.
        onRequestClose={() => settle(false)}>
        <View style={styles.backdrop}>
          {/* Tapping outside declines too — the same as Cancel. */}
          <Pressable style={StyleSheet.absoluteFill} onPress={() => settle(false)} />
          <View style={styles.sheet}>
            <View style={styles.badge}>
              <ShieldCheck color={Palette.accent} size={26} strokeWidth={2} />
            </View>
            <Text style={styles.title}>Approve this action</Text>
            <Text style={styles.summary}>{pending?.summary ?? ''}</Text>
            <Text style={styles.note}>
              Signed on this device. Your keys never leave your phone.
            </Text>
            <Button label="Approve" onPress={() => settle(true)} style={styles.approve} />
            <Pressable onPress={() => settle(false)} hitSlop={8} style={styles.cancel}>
              <Text style={styles.cancelText}>Cancel</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.65)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: Palette.bgElevated,
    borderTopLeftRadius: Radius.sheet,
    borderTopRightRadius: Radius.sheet,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Palette.glassBorder,
    padding: Spacing.six,
    paddingBottom: Spacing.seven,
    gap: Spacing.three,
    alignItems: 'center',
  },
  badge: {
    width: 56,
    height: 56,
    borderRadius: Radius.full,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Palette.glass,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Palette.glassBorder,
    marginBottom: Spacing.one,
  },
  title: { ...Typography.section, color: Palette.white, textAlign: 'center' },
  summary: { ...Typography.body, color: Palette.textSecondary, textAlign: 'center' },
  note: { ...Typography.micro, color: Palette.textMuted, textAlign: 'center' },
  approve: { alignSelf: 'stretch', marginTop: Spacing.three },
  cancel: { paddingVertical: Spacing.three },
  cancelText: { ...Typography.caption, color: Palette.textSecondary, fontWeight: '600' },
});
