import { CORRIDOR_STATUS_NOTE, COUNTRIES, type Country } from '@prova/shared';
import { useQueryClient } from '@tanstack/react-query';
import * as Clipboard from 'expo-clipboard';
import { useRouter } from 'expo-router';
import { Check, ChevronDown } from 'lucide-react-native';
import { useCallback, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { Button, Screen } from '@/components/ui';
import { useToast } from '@/components/toast';
import { QK } from '@/lib/queries';
import { syncBackup } from '@/lib/cloud-backup';
import { decodePoolAddress, type Payee } from '@/lib/pool';
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
  const [poolAddr, setPoolAddr] = useState<Payee | null>(null);
  const [pasteError, setPasteError] = useState('');
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const country = COUNTRIES.find((c) => c.code === countryCode) ?? COUNTRIES[0];
  const nameV = validateName(name);
  const nameError = submitted && !nameV.ok ? (nameV.error ?? '') : '';
  const addrError =
    pasteError ||
    (submitted && !poolAddr ? 'A Prova address is needed to send to this person.' : '');

  const onPastePoolAddress = useCallback(async () => {
    const text = await Clipboard.getStringAsync();
    const decoded = decodePoolAddress(text);
    if (!decoded) {
      setPasteError('That doesn’t look like a Prova address. Copy it again and retry.');
      return;
    }
    setPoolAddr(decoded);
    setPasteError('');
  }, []);

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

  return (
    <Screen scroll>
      <Text style={styles.subtitle}>
        You need their Prova address to send them money. Ask them to open{' '}
        <Text style={styles.strong}>Account → Receive privately</Text> and send it to you.
      </Text>

      <Field label="Their name" error={nameError}>
        <TextInput
          style={[styles.input, nameError ? styles.inputError : null]}
          value={name}
          onChangeText={setName}
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

      <Field label="Prova address" error={addrError}>
        {poolAddr ? (
          <View style={styles.addrRow}>
            <View style={styles.addrOk}>
              <Check color={Palette.statusUp} size={17} strokeWidth={2.6} />
            </View>
            <Text style={styles.addrText} numberOfLines={1}>
              {poolAddr.ownerPk.slice(0, 10)}…{poolAddr.ownerPk.slice(-6)}
            </Text>
            <Text style={styles.addrClear} onPress={() => setPoolAddr(null)}>
              Clear
            </Text>
          </View>
        ) : (
          <Button
            label="Paste from clipboard"
            variant="secondary"
            onPress={onPastePoolAddress}
            disabled={busy}
          />
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

  addrRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
    backgroundColor: Palette.bgInput,
    borderRadius: Radius.input,
    paddingHorizontal: Spacing.four,
    paddingVertical: Spacing.four,
  },
  addrOk: {
    width: 26,
    height: 26,
    borderRadius: Radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(63,174,111,0.16)',
  },
  addrText: { ...Typography.body, color: Palette.white, flex: 1 },
  addrClear: { ...Typography.caption, color: Palette.accent, fontWeight: '600' },

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
