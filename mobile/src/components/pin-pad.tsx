import { Delete } from 'lucide-react-native';
import { useCallback } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Palette, Radius, Spacing, Typography } from '@/constants/theme';

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', 'del'] as const;

/**
 * Controlled numeric PIN pad — a row of dots + a 3×4 keypad. Purely presentational: the parent owns
 * the value and decides what "complete" means. Shared by set-pin, the lock screen, and step-up.
 */
export function PinPad({
  value,
  onChange,
  length = 6,
  disabled = false,
  onComplete,
}: {
  value: string;
  onChange: (next: string) => void;
  length?: number;
  disabled?: boolean;
  onComplete?: (value: string) => void;
}) {
  const press = useCallback(
    (key: string) => {
      if (disabled) return;
      if (key === 'del') {
        onChange(value.slice(0, -1));
        return;
      }
      if (!key || value.length >= length) return;
      const next = value + key;
      onChange(next);
      if (next.length === length) {
        // Let the final dot render as filled before handing off — feels responsive, not abrupt.
        setTimeout(() => onComplete?.(next), 130);
      }
    },
    [disabled, length, onChange, onComplete, value],
  );

  return (
    <View style={styles.wrap}>
      <View style={styles.dots}>
        {Array.from({ length }).map((_, i) => (
          <View key={i} style={[styles.dot, i < value.length && styles.dotFilled]} />
        ))}
      </View>

      <View style={styles.keys}>
        {KEYS.map((key, i) =>
          key === '' ? (
            <View key={i} style={styles.key} />
          ) : (
            <Pressable
              key={i}
              disabled={disabled}
              onPress={() => press(key)}
              style={({ pressed }) => [styles.key, pressed && !disabled && styles.keyPressed]}
              accessibilityRole="button"
              accessibilityLabel={key === 'del' ? 'Delete' : key}>
              {key === 'del' ? (
                <Delete color={Palette.white} size={24} strokeWidth={1.8} />
              ) : (
                <Text style={styles.keyText}>{key}</Text>
              )}
            </Pressable>
          ),
        )}
      </View>
    </View>
  );
}

const KEY_SIZE = 72;

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', gap: Spacing.seven },
  dots: { flexDirection: 'row', gap: Spacing.four },
  dot: {
    width: 14,
    height: 14,
    borderRadius: Radius.full,
    borderWidth: 1.5,
    borderColor: Palette.textMuted,
  },
  dotFilled: { backgroundColor: Palette.accent, borderColor: Palette.accent },
  keys: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    width: KEY_SIZE * 3 + Spacing.five * 2,
    rowGap: Spacing.four,
    columnGap: Spacing.five,
  },
  key: {
    width: KEY_SIZE,
    height: KEY_SIZE,
    borderRadius: Radius.full,
    alignItems: 'center',
    justifyContent: 'center',
  },
  keyPressed: { backgroundColor: Palette.bgSelected },
  keyText: { ...Typography.title, fontSize: 28, color: Palette.white },
});
