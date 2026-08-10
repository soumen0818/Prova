import { Stack, useLocalSearchParams } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

import { Screen } from '@/components/ui';
import { LEGAL_DOCS, type LegalDocId } from '@prova/shared';
import { Palette, Spacing, Typography } from '@/constants/theme';

/**
 * Privacy Policy and Terms, rendered from the shared definitions in `@prova/shared`.
 *
 * One screen serves both because they differ only in content, and the text lives in the shared
 * package so the marketing site publishes the identical wording — a policy that says two different
 * things in two places is worse than having none.
 */
export default function LegalScreen() {
  const { doc } = useLocalSearchParams<{ doc?: string }>();
  const id: LegalDocId = doc === 'terms' ? 'terms' : 'privacy';
  const content = LEGAL_DOCS[id];

  return (
    <Screen scroll>
      <Stack.Screen options={{ title: content.title }} />
      <Text style={styles.updated}>Last updated {content.updated}</Text>
      <Text style={styles.intro}>{content.intro}</Text>

      {content.sections.map((section) => (
        <View key={section.heading} style={styles.section}>
          <Text style={styles.heading}>{section.heading}</Text>
          {section.body.map((paragraph, i) => (
            <Text key={i} style={styles.body}>
              {paragraph}
            </Text>
          ))}
        </View>
      ))}

      <Text style={styles.footer}>{content.contact}</Text>
    </Screen>
  );
}

const styles = StyleSheet.create({
  updated: { ...Typography.micro, color: Palette.textMuted, marginBottom: Spacing.three },
  intro: { ...Typography.body, color: Palette.textSecondary, marginBottom: Spacing.six },
  section: { marginBottom: Spacing.six, gap: Spacing.three },
  heading: { ...Typography.section, color: Palette.white },
  body: { ...Typography.caption, color: Palette.textSecondary, lineHeight: 21 },
  footer: {
    ...Typography.micro,
    color: Palette.textMuted,
    marginBottom: Spacing.six,
    lineHeight: 18,
  },
});
