import { CloudOff } from 'lucide-react-native';
import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useHealth } from '@/lib/queries';
import { Palette, Spacing, Typography } from '@/constants/theme';

/** Thin top banner shown when the backend can't be reached — so failed actions are explained. */
export function ConnectionBanner() {
  const { isError, isLoading } = useHealth();
  if (isLoading || !isError) return null;

  return (
    <SafeAreaView style={styles.host} edges={['top']} pointerEvents="none">
      <View style={styles.banner}>
        <CloudOff color={Palette.white} size={14} strokeWidth={2} />
        <Text style={styles.text}>Can’t reach the backend — some actions won’t work.</Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  host: { position: 'absolute', top: 0, left: 0, right: 0, zIndex: 50, alignItems: 'center' },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    backgroundColor: Palette.statusDown,
    paddingVertical: Spacing.two,
    paddingHorizontal: Spacing.four,
    borderBottomLeftRadius: 12,
    borderBottomRightRadius: 12,
  },
  text: { ...Typography.micro, color: Palette.white, fontWeight: '600' },
});
