/**
 * Prova design tokens.
 *
 * Single source of truth for the app's visual language. See `Docs/design-system.md` for the
 * rationale behind every value. Rules:
 *   - Prova is dark-first. `Colors.dark` is the real palette; `Colors.light` mirrors it for now
 *     so existing color-scheme plumbing keeps working (a true light theme is optional, later).
 *   - One loud accent (`accent`) carries primary actions + live data. Text on the accent is always
 *     dark (`onAccent`), never white.
 *   - Never hardcode hex in screens — always read from here.
 */

import '@/global.css';

import { Platform } from 'react-native';

/** Raw brand palette (scheme-independent). Prefer the semantic `Colors` tokens in components. */
export const Palette = {
  accent: '#E6F94E', // chartreuse-yellow — the one loud color
  accentPressed: '#D2E63A',
  lilac: '#DCCBF7', // soft pastel support color, used sparingly
  onAccent: '#11131A', // dark text/icons placed on accent surfaces

  bgBase: '#0E0E11',
  bgElevated: '#171719',
  bgInput: '#1E1E21',
  bgSelected: '#26262A',

  white: '#FFFFFF',
  /**
   * Supporting text: descriptions, captions, the sentence under a heading.
   *
   * Contrast against `bgBase` sets these values, not taste. The original pair (#9A9AA0 / #6B6B72)
   * measured 6.8:1 and **3.6:1** — the muted one failed the 4.5:1 minimum for body text outright.
   * These measure **12.6:1 and 7.8:1**, comfortably past AAA for the secondary tone and well past
   * AA for the muted one.
   *
   * They are deliberately far above the minimum. This app is read one-handed, outdoors, in
   * sunlight, often by someone who is anxious about money — "technically passes" is the wrong bar.
   * Hierarchy comes from weight and size (see Typography) rather than from making text dim.
   *
   * If you darken either of these, measure the ratio first.
   */
  textSecondary: '#D2D2D9',
  textMuted: '#A5A5AF',

  glass: 'rgba(255,255,255,0.07)',
  glassBorder: 'rgba(255,255,255,0.10)',
  border: 'rgba(255,255,255,0.08)',

  statusUp: '#3FAE6F',
  statusDown: '#C0473C',
  statusNotify: '#E5484D',

  glowOlive: 'rgba(160,160,40,0.18)', // ambient top-of-screen glow
} as const;

/**
 * Semantic, scheme-aware colors. Keys preserve the original template tokens
 * (`text`, `background`, `backgroundElement`, `backgroundSelected`, `textSecondary`) plus Prova's
 * additions, so themed components keep working.
 */
export const Colors = {
  dark: {
    text: Palette.white,
    textSecondary: Palette.textSecondary,
    textMuted: Palette.textMuted,
    background: Palette.bgBase,
    backgroundElement: Palette.bgElevated,
    backgroundSelected: Palette.bgSelected,
    surfaceInput: Palette.bgInput,
    accent: Palette.accent,
    accentPressed: Palette.accentPressed,
    onAccent: Palette.onAccent,
    lilac: Palette.lilac,
    glass: Palette.glass,
    glassBorder: Palette.glassBorder,
    border: Palette.border,
    statusUp: Palette.statusUp,
    statusDown: Palette.statusDown,
    statusNotify: Palette.statusNotify,
  },
  light: {
    // Dark-first product: light mirrors dark for now. A real light theme is a later, optional task.
    text: Palette.white,
    textSecondary: Palette.textSecondary,
    textMuted: Palette.textMuted,
    background: Palette.bgBase,
    backgroundElement: Palette.bgElevated,
    backgroundSelected: Palette.bgSelected,
    surfaceInput: Palette.bgInput,
    accent: Palette.accent,
    accentPressed: Palette.accentPressed,
    onAccent: Palette.onAccent,
    lilac: Palette.lilac,
    glass: Palette.glass,
    glassBorder: Palette.glassBorder,
    border: Palette.border,
    statusUp: Palette.statusUp,
    statusDown: Palette.statusDown,
    statusNotify: Palette.statusNotify,
  },
} as const;

export type ThemeColor = keyof typeof Colors.light & keyof typeof Colors.dark;

/**
 * Brand font families. Each weight is its own loaded font (Urbanist via @expo-google-fonts).
 * Family names must match the exports loaded in `_layout.tsx`.
 */
export const FontFamily = {
  regular: 'Urbanist_400Regular',
  medium: 'Urbanist_500Medium',
  semibold: 'Urbanist_600SemiBold',
  bold: 'Urbanist_700Bold',
} as const;

/** Type scale (see design-system.md §3). */
export const Typography = {
  displayBalance: { fontFamily: FontFamily.bold, fontSize: 42, lineHeight: 48 },
  title: { fontFamily: FontFamily.semibold, fontSize: 20, lineHeight: 28 },
  section: { fontFamily: FontFamily.semibold, fontSize: 16, lineHeight: 22 },
  body: { fontFamily: FontFamily.medium, fontSize: 15, lineHeight: 22 },
  // Caption and micro carry most of the grey text in the app. At 13/12px they were small *and*
  // dim, which compounds — the fix for legibility is both, so they step up here alongside the
  // contrast change to textSecondary/textMuted. Medium weight rather than regular on `caption`
  // because a thin stroke at small sizes is the other half of why grey text disappears.
  caption: { fontFamily: FontFamily.medium, fontSize: 14, lineHeight: 20 },
  button: { fontFamily: FontFamily.semibold, fontSize: 16, lineHeight: 20 },
  micro: { fontFamily: FontFamily.medium, fontSize: 13, lineHeight: 18 },
} as const;

/** Legacy/platform font roles — kept for `code`/mono usage and web CSS variables. */
export const Fonts = Platform.select({
  ios: {
    sans: 'Urbanist_500Medium',
    serif: 'ui-serif',
    rounded: 'ui-rounded',
    mono: 'ui-monospace',
  },
  default: {
    sans: 'Urbanist_500Medium',
    serif: 'serif',
    rounded: 'Urbanist_500Medium',
    mono: 'monospace',
  },
  web: {
    sans: 'var(--font-display)',
    serif: 'var(--font-serif)',
    rounded: 'var(--font-rounded)',
    mono: 'var(--font-mono)',
  },
});

/** Spacing scale (px). Design-system §4: 4 / 8 / 12 / 16 / 20 / 24 / 32. */
export const Spacing = {
  half: 2,
  one: 4,
  two: 8,
  three: 12,
  four: 16,
  five: 20,
  six: 24,
  seven: 32,
  eight: 64,
} as const;

/** Default horizontal padding for screens. */
export const ScreenPadding = 20;

/** Corner radii (design-system §4). */
export const Radius = {
  card: 24,
  input: 16,
  sheet: 28,
  pill: 999,
  full: 999,
} as const;

export const BottomTabInset = Platform.select({ ios: 50, android: 80 }) ?? 0;
export const MaxContentWidth = 800;
