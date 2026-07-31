import { COUNTRIES, DEFAULT_COUNTRY, findCountry, toE164, type Country } from '@prova/shared';
import { Check, ChevronDown } from 'lucide-react-native';
import { useCallback, useMemo, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { Button, Card } from '@/components/ui';
import { useToast } from '@/components/toast';
import { Palette, Radius, Spacing, Typography } from '@/constants/theme';
import { validateName, validateNationalPhone } from '@/lib/validation';

/**
 * Identity — the first step of verification.
 *
 * Name and phone are collected **here** rather than at sign-up, because they are compliance data the
 * anchor requires, not things the app needs to let someone in. Keeping them out of sign-up also
 * means changing a phone number never risks the account, which is tied to the email instead.
 *
 * The number is entered as: pick a country → its dial code appears → type only the national digits.
 * The expected digit count comes from the country itself (India 10, UAE 9), so the error can say
 * exactly how many are needed rather than a vague "invalid number". A single hardcoded length would
 * reject every valid UAE number — half of Prova's corridor.
 *
 * ## The number is captured, not yet verified
 *
 * There is deliberately no OTP round-trip here. The phone is **not** a regulatory identity field —
 * the Travel Rule set (see `IVMS101Person`) is name, date of birth, country of residence and a
 * national identifier, all of which come from the ID document and selfie captured in the next steps.
 * The phone is contact and payout information, and the verified channel for this account is already
 * the email proved at sign-in.
 *
 * Phone OTP verification is planned (`/kyc/phone/request` and `/kyc/phone/verify` already exist and
 * are tested on the backend) — see `Docs/signup-and-validation.md`. Until it is wired, treat the
 * stored number as **user-asserted**, not proved: do not rely on it for fraud scoring or as a
 * second factor.
 */

export interface CapturedIdentity {
  name: string;
  /** Full E.164. User-asserted — not yet verified by a one-time code. */
  phone: string;
}

interface Props {
  onCaptured: (identity: CapturedIdentity) => void;
}

export function KycIdentityStep({ onCaptured }: Props) {
  const toast = useToast();

  const [name, setName] = useState('');
  const [countryCode, setCountryCode] = useState(DEFAULT_COUNTRY);
  const [national, setNational] = useState('');

  const [pickerOpen, setPickerOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const country = useMemo(() => findCountry(countryCode) ?? COUNTRIES[0], [countryCode]);
  const nameCheck = validateName(name);
  const phoneCheck = validateNationalPhone(national, countryCode);

  const nameError = submitted && !nameCheck.ok ? nameCheck.error : '';
  const phoneError = submitted && !phoneCheck.ok ? phoneCheck.error : '';

  const e164 = toE164(national, countryCode);

  const onContinue = useCallback(() => {
    setSubmitted(true);
    if (!nameCheck.ok) {
      toast.error(nameCheck.error);
      return;
    }
    if (!phoneCheck.ok) {
      toast.error(phoneCheck.error);
      return;
    }
    // toE164 re-runs the country's own rules, so this cannot produce a malformed number even if the
    // field checks above were somehow bypassed.
    if (!e164) {
      toast.error('Enter a valid phone number');
      return;
    }

    setBusy(true);
    try {
      onCaptured({ name: name.trim().replace(/\s+/g, ' '), phone: e164 });
    } finally {
      setBusy(false);
    }
  }, [e164, name, nameCheck, onCaptured, phoneCheck, toast]);

  return (
    <Card>
      <Text style={styles.title}>Your details</Text>
      <Text style={styles.body}>
        Your legal name and a phone number we can reach you on. This is required by the licensed
        anchor for compliance — it is never attached to your payments on-chain.
      </Text>

      <View style={styles.field}>
        <Text style={styles.label}>Full legal name</Text>
        <TextInput
          style={[styles.input, nameError ? styles.inputError : null]}
          value={name}
          onChangeText={setName}
          placeholder="As printed on your ID"
          placeholderTextColor={Palette.textMuted}
          autoCapitalize="words"
          maxLength={60}
          editable={!busy}
        />
        {nameError ? <Text style={styles.error}>{nameError}</Text> : null}
      </View>

      <View style={styles.field}>
        <Text style={styles.label}>Phone number</Text>
        <View style={styles.phoneRow}>
          {/* Country first: picking it fixes the dial code and the expected digit count. */}
          <Pressable
            style={styles.countryButton}
            onPress={() => setPickerOpen(true)}
            disabled={busy}
            accessibilityLabel="Choose country">
            <Text style={styles.countryFlag}>{country.flag}</Text>
            <Text style={styles.countryDial}>{country.dial}</Text>
            <ChevronDown color={Palette.textSecondary} size={16} strokeWidth={2} />
          </Pressable>

          <TextInput
            style={[styles.input, styles.phoneInput, phoneError ? styles.inputError : null]}
            value={national}
            // Strip non-digits as they type and cap at this country's length, so the field cannot
            // hold something the server would reject.
            onChangeText={(t) => setNational(t.replace(/\D/g, '').slice(0, country.nationalDigits))}
            keyboardType="number-pad"
            placeholder={'0'.repeat(country.nationalDigits)}
            placeholderTextColor={Palette.textMuted}
            maxLength={country.nationalDigits}
            editable={!busy}
          />
        </View>
        <Text style={styles.hint}>
          {country.nationalDigits} digits, without the leading 0
        </Text>
        {phoneError ? <Text style={styles.error}>{phoneError}</Text> : null}
      </View>

      <Button
        label="Continue"
        onPress={onContinue}
        loading={busy}
        style={styles.action}
      />

      <CountryPicker
        open={pickerOpen}
        selected={countryCode}
        onClose={() => setPickerOpen(false)}
        onSelect={(c) => {
          setCountryCode(c.code);
          // The expected length changes with the country, so a number typed for the previous one is
          // almost certainly wrong now. Clearing it is kinder than showing an error on digits the
          // user entered correctly a moment ago.
          setNational('');
          setPickerOpen(false);
        }}
      />
    </Card>
  );
}

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
        <Text style={styles.sheetTitle}>Choose country</Text>
        <ScrollView>
          {/* Served from the same table the server validates against, so the picker can never offer
              a country whose numbers would then be rejected. */}
          {COUNTRIES.map((c) => (
            <Pressable key={c.code} style={styles.countryRow} onPress={() => onSelect(c)}>
              <Text style={styles.countryFlag}>{c.flag}</Text>
              <Text style={styles.countryName}>{c.name}</Text>
              <Text style={styles.countryDial}>{c.dial}</Text>
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

const styles = StyleSheet.create({
  title: { ...Typography.section, color: Palette.white },
  body: { ...Typography.body, color: Palette.textSecondary, marginTop: Spacing.two },
  field: { gap: Spacing.two, marginTop: Spacing.four },
  label: { ...Typography.caption, color: Palette.textSecondary },
  hint: { ...Typography.micro, color: Palette.textMuted },
  input: {
    ...Typography.body,
    color: Palette.white,
    backgroundColor: Palette.bgInput,
    borderRadius: Radius.input,
    paddingHorizontal: Spacing.four,
    paddingVertical: Spacing.three,
  },
  inputError: { borderWidth: 1, borderColor: Palette.statusDown },
  error: { ...Typography.caption, color: Palette.statusDown },
  action: { marginTop: Spacing.five },
  link: {
    ...Typography.caption,
    color: Palette.accent,
    textAlign: 'center',
    marginTop: Spacing.four,
  },
  phoneRow: { flexDirection: 'row', gap: Spacing.two },
  phoneInput: { flex: 1 },
  countryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    backgroundColor: Palette.bgInput,
    borderRadius: Radius.input,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.three,
  },
  countryFlag: { fontSize: 18 },
  countryDial: { ...Typography.body, color: Palette.white },
  countryName: { ...Typography.body, color: Palette.white, flex: 1 },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)' },
  sheet: {
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
    paddingVertical: Spacing.three,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Palette.border,
  },
});
