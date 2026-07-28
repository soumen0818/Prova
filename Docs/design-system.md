# Prova — UI Design System & Style Guide

> Companion to [proposal.md](proposal.md), [tech-stack.md](tech-stack.md), and
> [implementation-guide.md](implementation-guide.md). This document defines the visual language for
> the Prova mobile app, derived from the reference UI samples (a dark, yellow-accented crypto/fintech
> app). It adapts that aesthetic to Prova's remittance + ZK-privacy product so the look stays
> consistent while the screens serve our actual flows.

> **Note:** The reference images are a *crypto trading* app. We borrow the **visual language**
> (dark theme, chartreuse-yellow accent, rounded glassy components, honest charts), not the feature
> set. Map every borrowed pattern onto a Prova flow (send money, KYC, proof progress, history,
> regulator view) — see §9.

---

## 1. Design DNA (the mood in one breath)

- **Dark, premium, calm.** Near-black backgrounds with soft olive/yellow ambient glow at the top of
  each screen. Money feels serious and private.
- **One loud accent.** A single vivid **chartreuse-yellow** carries all primary actions and "alive"
  data. Everything else is restrained — dark surfaces, white text, one pastel lilac support color.
- **Soft, rounded, glassy.** Large corner radii, circular translucent icon buttons, gentle shadows.
  Nothing sharp.
- **Honest data.** Clear charts with a single highlight point + tooltip; numbers are the hero
  (giant balance, dimmed decimals). This pairs perfectly with our "honest progress bar" principle.

---

## 2. Color tokens

> Hex values are matched to the reference; tune ±a few points in implementation. Define these once
> as theme tokens (see §11) — never hardcode colors in screens.

### Brand / accent
| Token | Hex | Use |
|---|---|---|
| `accent.primary` | `#E6F94E` | Chartreuse-yellow. Primary buttons, active tab/FAB, primary CTA, key data, chart line, highlight card. **The one loud color.** |
| `accent.primaryPressed` | `#D2E63A` | Pressed/active state of primary. |
| `accent.lilac` | `#DCCBF7` | Soft pastel lavender. Secondary card / secondary highlight / "received" accents. Use sparingly. |

### Surfaces (dark)
| Token | Hex | Use |
|---|---|---|
| `bg.base` | `#0E0E11` | App background (near-black, slightly cool). |
| `bg.elevated` | `#171719` | Cards, sheets, list containers. |
| `bg.input` | `#1E1E21` | Inputs, keypad keys, inner wells. |
| `surface.glass` | `rgba(255,255,255,0.07)` | Translucent circular icon buttons (bell, gear, Add/Send/etc.). |
| `surface.glassBorder` | `rgba(255,255,255,0.10)` | Hairline border on glass elements. |

### Text
| Token | Hex | Use |
|---|---|---|
| `text.primary` | `#FFFFFF` | Headings, balances, primary labels. |
| `text.secondary` | `#9A9AA0` | Subtitles, captions, inactive tabs. |
| `text.muted` | `#6B6B72` | Dimmed balance decimals (`.00`), hints, disabled. |
| `text.onAccent` | `#11131A` | Text/icons placed on the yellow accent (dark, never white). |

### Status / data
| Token | Hex | Use |
|---|---|---|
| `status.up` | `#3FAE6F` | Positive change, "up" sparklines, success. |
| `status.down` | `#C0473C` | Negative change, "down" sparklines, errors. |
| `status.notify` | `#E5484D` | Notification dot on the bell. |

### Ambient glow / gradients
- **Screen-top glow:** radial olive-yellow `rgba(160,160,40,0.18)` fading into `bg.base` behind the
  header area of each screen.
- **Accent card gradient:** top `#EAF85E` → bottom `#C9DC2E` with a dark wavy chart overlay (the BTC
  card in the reference → our "primary balance/asset" card).
- **Lilac card gradient:** top `#E6DAF9` → bottom `#C9B9EE`.
- **Ambient app aura:** very subtle purple+yellow bloom at screen edges on key screens (optional).

---

## 3. Typography

The reference uses a clean geometric grotesque ("Free Font"). Recommended free pairings (pick one):

- **Headings/display:** **Clash Display** or **General Sans** (Fontshare, free) — geometric, confident.
- **Body/UI:** **General Sans**, **Inter**, or **Urbanist** — neutral, highly legible at small sizes.
- Numbers (balances) benefit from **tabular figures** — enable `font-variant-numeric: tabular-nums`.

**Recommended default:** `Clash Display` (display) + `General Sans` (UI/body). Safe all-rounder if
you want a single family: `Urbanist` or `Inter`.

### Type scale
| Role | Size / weight | Notes |
|---|---|---|
| Display balance | 40–44 / Bold | e.g. `$10,560` — dimmed `.00` in `text.muted`. |
| Screen title | 18–20 / Semibold | "Wallet", "Swap ETH for BTC" → "Send to Amma". |
| Section header | 15–16 / Semibold | "Recent activity", "Top Trending". |
| Body / list primary | 14–15 / Medium | Row titles. |
| Caption / subtitle | 12–13 / Regular | `text.secondary`. |
| Button label | 15–16 / Semibold | |
| Tab / micro label | 11–12 / Medium | Under icon buttons. |

---

## 4. Spacing, radius, elevation

- **Spacing scale (px):** 4, 8, 12, 16, 20, 24, 32. Default screen padding **20**. Card padding 16–20.
- **Corner radius:** cards **24**, inputs/keys **16**, chips/pills **full (999)**, icon buttons
  **full circle**, sheets **28 (top corners)**, FAB **full circle**.
- **Elevation:** dark theme → use soft, low-opacity shadows + a faint top inner-glow on cards rather
  than heavy drop shadows. The yellow FAB gets a subtle yellow glow (`shadow color = accent.primary`,
  low opacity, large blur).

---

## 5. Iconography

- **Style:** thin-to-medium line icons, rounded caps, ~1.5–2px stroke. Consistent single set.
- **Library:** `lucide-react-native` (clean, line, free) or `phosphor-react-native`.
- **On glass buttons:** icons in `text.primary`. **On yellow:** icons in `text.onAccent`.
- **Token chips:** circular coin/asset badges → for Prova, use circular **flag/currency badges**
  (AED, INR) and recipient avatars.

---

## 6. Component specs

**Top bar** — circular avatar (left); circular glass buttons for notifications (with red dot) and
settings (right). On sub-screens: circular glass back button (left), centered title, optional
filter/glass button (right).

**Primary balance block** — centered caption ("Total balance"), giant bold amount with muted
decimals, directly below the top bar over the olive glow.

**Quick-action row** — 4 circular glass buttons with labels beneath (reference: Add / Send / Request /
Bill). **Prova mapping:** **Send / Request / Deposit / History** (or KYC status).

**Asset/summary cards** — two side-by-side rounded cards, one yellow (primary), one lilac
(secondary), each with a small badge, title/subtitle, an embedded area-chart, and a value.
**Prova mapping:** a **"Send" card** (primary, yellow) + a **"Privacy/Proof" status card** (lilac),
or sending vs receiving balances.

**Segmented pill control** — full-radius pills in a row; active pill filled `accent.primary` with
`text.onAccent`, inactive transparent with `text.secondary` (reference: Income/Cashflow/Budget/
Markets). **Prova mapping:** Activity / Limits / Disclosures, or time ranges.

**Dropdown chips** — small rounded chips with a label + chevron (BTC ⌄, Monthly ⌄, Today ⌄).

**Charts** — area/line chart, single `accent.primary` line, gradient fill fading to transparent,
one highlighted node with a yellow rounded tooltip bubble ($value). Month axis in `text.secondary`,
active month in `text.primary`. Use `react-native-svg` + `react-native-svg-charts`/`victory-native`.

**List rows (activity)** — left circular icon in a dark well, title + status subtitle, right-aligned
value with unit. Mini-sparklines (green up / red down) for asset rows.

**Bottom tab bar** — dark rounded floating bar, 5 items; **center item is a raised yellow circular
FAB** (reference: swap). **Prova mapping:** Home / Wallet / **Send (FAB)** / Activity / Settings.
Active icon tinted, inactive `text.secondary`.

**Numeric keypad** — 3×4 grid of dark rounded keys (`bg.input`), white digits, backspace icon,
big full-width `accent.primary` primary button beneath (reference: "Swap" → our **"Send privately"**).

**Buttons**
- *Primary:* full-width, `accent.primary` fill, `text.onAccent` label, radius 16, optional `›` chevron.
- *Glass/secondary:* `surface.glass` fill, hairline border, `text.primary` label.
- *Icon button:* circular glass.

---

## 7. Effects & texture

- **Glassmorphism** on circular controls: translucent white fill + hairline border + slight blur.
- **Top olive glow** behind each screen header (defining mood).
- **Card gradients** as in §2; overlay a subtle dark wave/chart on the colored cards.
- **FAB glow:** faint yellow halo around the center tab button.
- Keep it subtle — premium, not neon. One accent does the heavy lifting.

---

## 8. The honest progress moment (Prova-specific, our signature screen)

The reference has no equivalent — this is ours, and it must feel **intentional, not frozen**
(see proposal §7). Design it in the same language:
- Full-screen dark with top olive glow.
- Centered copy: "Securing your transfer…" + honest countdown/percent.
- A circular or linear progress indicator filled in `accent.primary`, smooth and continuous.
- Reassuring sub-caption: "Generating your private proof. Your amount never leaves this phone."
- On success → yellow check, "Sent ✅", link to the on-chain commitment (showing **no amount**).

---

## 9. Mapping reference screens → Prova screens

| Reference (crypto) | Prova equivalent |
|---|---|
| Home + total balance + quick actions | **Home** — wallet balance (AED), Send/Request/Deposit/History actions |
| Asset cards (BTC/ETH) | **Send card** (primary) + **Privacy/KYC status card** (secondary) |
| Wallet + chart + recent activity | **Activity** — transfer history (commitments, statuses), sent/received |
| Swap ETH→BTC + keypad | **Send flow** — enter amount on keypad, pick recipient, confirm |
| Segmented pills | Activity / Limits / Disclosures filters |
| (none) | **Proof progress screen** (§8) — our signature moment |
| (none) | **KYC screen** — capture docs, "Verified ✅" |
| (none) | **Regulator/selective-disclosure view** — shows only `valid / KYC'd / within-limits / not-sanctioned`, never amounts |

Keep every new screen in the same tokens, radii, and accent discipline.

---

## 10. Accessibility

- Yellow `accent.primary` on dark passes large-text contrast; **always pair yellow surfaces with the
  dark `text.onAccent`**, never white-on-yellow.
- Don't rely on color alone for up/down — pair with arrow icons and signs (+/–).
- Minimum tap target 44×44. Body text ≥ 13. Respect OS dynamic font scaling.
- Provide a high-contrast fallback for the subtle glass borders.

---

## 11. Implementation notes (React Native / Expo)

- **Theme tokens:** centralize all of §2–§4 in a single `theme.ts` (colors, spacing, radius,
  typography) and consume via a provider/context. No inline hex in screens.
- **Fonts:** load via `expo-font` (`@expo-google-fonts/*` for Inter/Urbanist, or bundle Clash
  Display/General Sans from Fontshare).
- **Icons:** `lucide-react-native`.
- **Charts:** `react-native-svg` + `victory-native` or `react-native-svg-charts`.
- **Gradients/blur:** `expo-linear-gradient` for card + glow gradients; `expo-blur` for glass.
- **Bottom tab + FAB:** custom tab bar component to raise/highlight the center Send FAB.
- **Dark-only first.** This system is designed dark-native; a light theme is optional later.

---

## 12. Quick-reference cheat sheet

- **Accent:** `#E6F94E` chartreuse-yellow — primary actions + live data only.
- **Support:** `#DCCBF7` lilac — secondary, used sparingly.
- **Background:** `#0E0E11`; cards `#171719`; inputs `#1E1E21`.
- **Text:** white / `#9A9AA0` / muted `#6B6B72`; **on-yellow = dark `#11131A`**.
- **Radius:** cards 24, inputs 16, pills/circles full.
- **Padding:** screen 20, card 16–20.
- **One accent. Dark surfaces. Rounded & glassy. Honest data.**
