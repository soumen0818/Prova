import { CORRIDOR_STATUS_NOTE, COUNTRIES, type Country } from '@prova/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import * as Clipboard from 'expo-clipboard';
import { Stack, useRouter } from 'expo-router';
import { Check, ChevronDown, ClipboardPaste, QrCode } from 'lucide-react-native';
import { useCallback, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { AddressScanner } from '@/components/scan-address';
import { Button, Screen } from '@/components/ui';
import { useToast } from '@/components/toast';
import { QK, useRecipients } from '@/lib/queries';
import { syncBackup } from '@/lib/cloud-backup';
import { decodePoolAddress, encodePoolAddress, poolAddress, type Payee } from '@/lib/pool';
import { addRecipient } from '@/lib/recipients';
import { captureError } from '@/lib/reporting';
import { validateName } from '@/lib/validation';
import { Palette, Radius, Spacing, Typography } from '@/constants/theme';

/** Where money is usually going, so the common case needs no interaction. */
const DEFAULT_DESTINATION = 'IN';

/**
 * Add someone you can send to.
 *
 * Two fields, because only two things are real:
 *
 *  - a **name**, so you can recognise them in a list;
 *  - their **pool address**, which is the only thing that actually moves money.
 *
 * The old "Account / phone" field is gone. It suggested Prova could pay a bank account or a phone
 * number, and it cannot — there is no payout leg yet. A field that implies a capability the app does
 * not have is worse than a missing one: somebody would have entered their mother's account number
 * and expected the money to arrive there.
 *
 * The pool address is now required for the same reason it was always the only one that mattered:
 * a recipient saved without it cannot be paid, so saving one is just a way to be disappointed later.
 */
export default function NewRecipientScreen() {
  const router = useRouter();
  const toast = useToast();
  const queryClient = useQueryClient();

  const [name, setName] = useState('');
  const [countryCode, setCountryCode] = useState(DEFAULT_DESTINATION);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [scanning, setScanning] = useState(false);
  /** Raw text in the address field — what was pasted, scanned, or typed. */
  const [addrText, setAddrText] = useState('');
  const [poolAddr, setPoolAddr] = useState<Payee | null>(null);
  const [addrError, setAddrError] = useState('');

  const recipients = useRecipients();
  // Own address, so the field can refuse it. Sending to yourself is not an error the contract would
  // catch — it would succeed, and quietly do nothing except cost a fee.
  const { data: ownAddress } = useQuery({ queryKey: ['pool-address'], queryFn: poolAddress });
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  /*
   * Shows the name error once the user has left the field, rather than only after Continue.
   * Otherwise a value the rule rejects — "Ravi 2", "123" — draws no reaction at all while typing,
   * which reads as no validation rather than as deferred validation.
   */
  const [nameTouched, setNameTouched] = useState(false);

  const country = COUNTRIES.find((c) => c.code === countryCode) ?? COUNTRIES[0];
  const nameV = validateName(name);
  const nameError = (submitted || nameTouched) && !nameV.ok ? (nameV.error ?? '') : '';
  const addrMessage =
    addrError ||
    (submitted && !poolAddr ? 'A Prova address is needed to send to this person.' : '');

  /**
   * Validate an address however it arrived — typed, pasted or scanned.
   *
   * All three go through here so the rules cannot differ by route. The two that matter beyond
   * "is it well-formed" are catching your own address and one already saved: neither fails at send
   * time, they just produce a transfer that does nothing useful.
   */
  const applyAddress = useCallback(
    (text: string) => {
      setAddrText(text);
      const trimmed = text.trim();

      if (!trimmed) {
        setPoolAddr(null);
        setAddrError('');
        return;
      }

      const decoded = decodePoolAddress(trimmed);
      if (!decoded) {
        setPoolAddr(null);
        // Name the mistake rather than restating the rule. This app shows a Stellar address too
        // (Account details), so pasting that one is the obvious error to make — and "not a Prova
        // address" would leave someone staring at something that looks like an address to them.
        setAddrError(specificAddressError(trimmed));
        return;
      }
      if (ownAddress && decoded.ownerPk === ownAddress.ownerPk) {
        setPoolAddr(null);
        setAddrError('That is your own address — money sent there would come straight back.');
        return;
      }
      const existing = (recipients.data ?? []).find((r) => r.poolOwnerPk === decoded.ownerPk);
      if (existing) {
        setPoolAddr(null);
        setAddrError(`You already have ${existing.name} saved with this address.`);
        return;
      }

      setPoolAddr(decoded);
      setAddrError('');
    },
    [ownAddress, recipients.data],
  );

  const onPasteAddress = useCallback(async () => {
    applyAddress(await Clipboard.getStringAsync());
  }, [applyAddress]);

  const onSave = useCallback(async () => {
    // Inline errors under each field are the feedback here — see the note in kyc-identity.tsx.
    // Toasts stay for outcomes that have nowhere on screen to live (saved, or failed to save).
    setSubmitted(true);
    if (!validateName(name).ok || !poolAddr) return;

    setBusy(true);
    try {
      await addRecipient({
        name,
        country: country.name,
        poolOwnerPk: poolAddr.ownerPk,
        poolEncPkX: poolAddr.encPkX,
        poolEncPkY: poolAddr.encPkY,
      });
      await queryClient.invalidateQueries({ queryKey: QK.recipients });
      toast.success('Recipient added');
      void syncBackup(); // silent, best-effort backup refresh
      router.back();
    } catch (e) {
      captureError(e, { step: 'add-recipient' });
      toast.error('Could not save recipient');
    } finally {
      setBusy(false);
    }
  }, [name, country, poolAddr, queryClient, router, toast]);

  if (scanning) {
    return (
      <>
        {/* No back arrow while the camera is up — the X inside the scanner is the only way out. */}
        <Stack.Screen options={{ headerShown: false }} />
        <AddressScanner
          onClose={() => setScanning(false)}
          onScanned={(payee) => {
            // Routed through the same validation as a paste, so a scanned code cannot skip the
            // own-address and duplicate checks.
            applyAddress(encodePoolAddress(payee));
            setScanning(false);
          }}
        />
      </>
    );
  }

  return (
    <Screen scroll>
      {/* Restores the header the scanner hid. Unmounting its override does not put this back. */}
      <Stack.Screen options={{ headerShown: true, title: 'New recipient' }} />
      <Text style={styles.subtitle}>
        You need their Prova address to send them money. Ask them to open{' '}
        <Text style={styles.strong}>Account → Receive privately</Text> and send it to you.
      </Text>

      <Field label="Their name" error={nameError}>
        <TextInput
          style={[styles.input, nameError ? styles.inputError : null]}
          value={name}
          onChangeText={setName}
          onBlur={() => setNameTouched(true)}
          placeholder="Amma Devi"
          placeholderTextColor={Palette.textMuted}
          autoCapitalize="words"
          autoFocus
          maxLength={60}
          editable={!busy}
        />
        <Text style={styles.hint}>Only you see this — it never leaves your phone.</Text>
      </Field>

      <Field label="Destination country">
        <Pressable
          style={styles.picker}
          onPress={() => setPickerOpen(true)}
          disabled={busy}
          accessibilityRole="button"
          accessibilityLabel="Choose destination country">
          <Text style={styles.pickerFlag}>{country.flag}</Text>
          <Text style={styles.pickerName}>{country.name}</Text>
          <ChevronDown color={Palette.textMuted} size={19} strokeWidth={2} />
        </Pressable>
      </Field>

      <Field label="Prova address" error={addrMessage}>
        <View style={[styles.addrField, addrMessage ? styles.inputError : null]}>
          <TextInput
            style={styles.addrInput}
            value={addrText}
            onChangeText={applyAddress}
            placeholder="prova-pay:…"
            placeholderTextColor={Palette.textMuted}
            autoCapitalize="none"
            autoCorrect={false}
            editable={!busy}
            numberOfLines={1}
          />
          {/* Small, inline: the field is the thing, these are just two ways to fill it. */}
          <Pressable
            onPress={onPasteAddress}
            disabled={busy}
            hitSlop={8}
            style={styles.addrIcon}
            accessibilityLabel="Paste address from clipboard">
            <ClipboardPaste color={Palette.textSecondary} size={19} strokeWidth={2} />
          </Pressable>
          <Pressable
            onPress={() => setScanning(true)}
            disabled={busy}
            hitSlop={8}
            style={styles.addrIcon}
            accessibilityLabel="Scan their QR code">
            <QrCode color={Palette.accent} size={19} strokeWidth={2} />
          </Pressable>
        </View>

        {poolAddr ? (
          <View style={styles.addrOkRow}>
            <Check color={Palette.statusUp} size={15} strokeWidth={2.6} />
            <Text style={styles.addrOkText}>Prova address recognised</Text>
          </View>
        ) : (
          <Text style={styles.hint}>Scan their code, or paste the address they sent you.</Text>
        )}
      </Field>

      <Button
        label={busy ? 'Saving…' : 'Save recipient'}
        onPress={onSave}
        loading={busy}
        style={styles.save}
      />

      {/* Stated plainly, once, at the point where somebody wonders why there is no bank field. */}
      <Text style={styles.statusNote}>{CORRIDOR_STATUS_NOTE}</Text>

      <CountryPicker
        open={pickerOpen}
        selected={countryCode}
        onClose={() => setPickerOpen(false)}
        onSelect={(c) => {
          setCountryCode(c.code);
          setPickerOpen(false);
        }}
      />
    </Screen>
  );
}

/** Stellar keys are base32, 56 characters, and start with G (public) or S (secret). */
const STELLAR_KEY = /^[GS][A-Z2-7]{55}$/;

/**
 * Say what was actually pasted, when we can tell.
 *
 * A Prova address and a Stellar address both look like "a long string of characters" to somebody
 * holding two of them, and this app displays both. Telling them which one they used, and where the
 * other one lives, is the difference between a fixed mistake and a stuck user.
 */
function specificAddressError(text: string): string {
  if (STELLAR_KEY.test(text)) {
    return text.startsWith('S')
      ? 'That is a secret key — never share it with anyone, including us. Delete it and ask them for their Prova address instead.'
      : 'That is a Stellar wallet address, not a Prova address. Ask them for Account → Receive privately.';
  }
  return 'That is not a Prova address. Scan their code, or paste what they sent you.';
}

/**
 * Country list, served from the same table the KYC step and the server use.
 *
 * Free text was worse than it looked: "Bharat", "india " and a typo all became different countries
 * in the address book, and none of them matches what compliance validates against.
 */
function CountryPicker({
  open,
  selected,
  onClose,
  onSelect,
}: {
  open: boolean;
  selected: string;
  onClose: () => void;
  onSelect: (c: Country) => void;
}) {
  return (
    <Modal visible={open} animationType="slide" transparent onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} />
      <View style={styles.sheet}>
        <Text style={styles.sheetTitle}>Destination country</Text>
        <ScrollView>
          {COUNTRIES.map((c) => (
            <Pressable key={c.code} style={styles.countryRow} onPress={() => onSelect(c)}>
              <Text style={styles.pickerFlag}>{c.flag}</Text>
              <Text style={styles.countryName}>{c.name}</Text>
              {c.code === selected ? (
                <Check color={Palette.accent} size={18} strokeWidth={2.5} />
              ) : null}
            </Pressable>
          ))}
        </ScrollView>
      </View>
    </Modal>
  );
}

function Field({
  label,
  error,
  children,
}: {
  label: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      {children}
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  subtitle: {
    ...Typography.body,
    color: Palette.textSecondary,
    marginBottom: Spacing.five,
    lineHeight: 22,
  },
  strong: { color: Palette.white, fontWeight: '600' },
  field: { gap: Spacing.two, marginBottom: Spacing.five },
  label: { ...Typography.caption, color: Palette.textSecondary },
  hint: { ...Typography.micro, color: Palette.textMuted },
  input: {
    ...Typography.body,
    fontSize: 17,
    color: Palette.white,
    backgroundColor: Palette.bgInput,
    borderRadius: Radius.input,
    paddingHorizontal: Spacing.four,
    paddingVertical: Spacing.four,
  },
  inputError: { borderWidth: 1, borderColor: Palette.statusDown },
  error: { ...Typography.caption, color: Palette.statusDown },
  save: { marginTop: Spacing.two },

  addrField: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
    backgroundColor: Palette.bgInput,
    borderRadius: Radius.input,
    paddingHorizontal: Spacing.four,
  },
  addrInput: {
    ...Typography.body,
    color: Palette.white,
    flex: 1,
    paddingVertical: Spacing.four,
  },
  addrIcon: { padding: Spacing.one },
  addrOkRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two },
  addrOkText: { ...Typography.micro, color: Palette.statusUp },
  statusNote: {
    ...Typography.micro,
    color: Palette.textMuted,
    lineHeight: 19,
    marginTop: Spacing.four,
  },

  picker: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
    backgroundColor: Palette.bgInput,
    borderRadius: Radius.input,
    paddingHorizontal: Spacing.four,
    paddingVertical: Spacing.four,
  },
  pickerFlag: { fontSize: 20 },
  pickerName: { ...Typography.body, fontSize: 17, color: Palette.white, flex: 1 },

  backdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: '#0009',
  },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    maxHeight: '70%',
    backgroundColor: Palette.bgElevated,
    borderTopLeftRadius: Radius.sheet,
    borderTopRightRadius: Radius.sheet,
    padding: Spacing.five,
  },
  sheetTitle: { ...Typography.section, color: Palette.white, marginBottom: Spacing.four },
  countryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
    paddingVertical: Spacing.four,
  },
  countryName: { ...Typography.body, color: Palette.white, flex: 1 },
});
