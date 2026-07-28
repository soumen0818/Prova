# Prova — Branding & Marketing Image Assets

Companion to [design-system.md](design-system.md). A complete list of the images Prova needs for
branding + marketing, each with a purpose, a spec, and a ready-to-paste generation prompt tuned to
the brand.


**Total: 23 images across 5 groups.** The minimum needed to ship testnet builds is the OS assets
(#5–#10); the rest is marketing/polish.

---

## Reusable STYLE BLOCK

Paste this at the **start of every prompt**, then add the per-image line.

> Brand: "Prova" — private, compliant crypto remittance. Aesthetic: dark, premium, calm, fintech.
> Near-black background `#0E0E11` with a soft olive/chartreuse ambient glow. ONE loud accent —
> chartreuse-yellow `#E6F94E` (gradient `#EAF85E`→`#C9DC2E`); one support color, pastel lilac
> `#DCCBF7`. Soft rounded shapes, large corner radii, subtle glassmorphism, gentle glow instead of
> hard shadows. Minimal, geometric, high-contrast, lots of negative space. Flat vector illustration,
> no photorealism, no clutter, no text unless specified. Core metaphor: a sealed letter with a
> notary stamp — the stamp is a zero-knowledge proof.

**Palette lock (append to any prompt):** `use exactly these colors: background #0E0E11, accent
#E6F94E, support #DCCBF7, text #FFFFFF, on-accent text #11131A`.

---

## Format strategy (read first)

The rule of thumb: **design the master as SVG (vector), export to the format each destination
requires.**

| Where it's used | Master | Ship as | Why |
|---|---|---|---|
| Logo / marks (#1–#4) | **SVG** | SVG + exported PNG | Vector = scales to every size, one source of truth |
| OS / platform assets (#5–#10) | SVG | **PNG** (raster) | iOS/Android/Expo require PNG; store icon PNG must have **no alpha** |
| In-app illustrations (#15–#20) | **SVG** | **SVG** (this app bundles `react-native-svg`); fallback **WebP/PNG @2x & @3x** | SVG stays crisp + tiny + theme-able; use WebP/PNG only for heavy gradients |
| Store / social / web (#11–#14, #21–#23) | SVG/layered | **PNG** (or JPG if photographic) | PNG keeps crisp edges + transparency; JPG only for photo-heavy art |
| Favicon (#10) | SVG | **PNG** (+ optional `.ico`, SVG favicon) | Expo web uses `favicon.png`; SVG favicon is a nice modern extra |

AI generators output **PNG/raster** — for anything marked "SVG", either vectorize it (Figma /
Illustrator / auto-trace) or recreate the concept as vector. Never ship an AI raster as your logo.

---

## 1) Brand core — logo suite (4)

| # | Image | Use | Spec · **Format** | Prompt (after STYLE BLOCK) |
|---|---|---|---|---|
| 1 | **App symbol / mark** | icon everywhere | 1024×1024, transparent · **SVG** (+ PNG exports) | "A single minimal app-icon symbol for 'Prova': an abstract notary seal / proof stamp fused with the letter **P** and a subtle checkmark, geometric, rounded, chartreuse-yellow `#E6F94E` mark centered on transparent background, thick confident strokes, readable at 24px, flat vector, no text, no gradient noise." |
| 2 | **Wordmark** | headers, footer | 2400×800, transparent · **SVG** | "The lowercase wordmark **'prova'** as a custom geometric-grotesque logotype (like Clash Display / General Sans), pure white `#FFFFFF` on transparent, tight even spacing, the dot of any letter replaced by a tiny chartreuse `#E6F94E` proof-dot, no icon, no background." |
| 3 | **Horizontal lockup** | website nav, decks | 2400×700, transparent · **SVG** | "Logo lockup: the Prova proof-seal symbol (chartreuse `#E6F94E`) on the left + the white wordmark 'prova' on the right, balanced spacing, on transparent background, minimal, vector." |
| 4 | **Monochrome mark** | watermarks, stamps | 1024×1024, transparent · **SVG** (+ PNG) | "The Prova proof-seal symbol in solid single-color, two versions: pure white and pure black, flat, no gradients, transparent background — for embossing/watermark use." |

## 2) Platform / OS assets — required to ship (6)

| # | Image | Use | Spec · **Format** | Prompt (after STYLE BLOCK) |
|---|---|---|---|---|
| 5 | **App icon (store)** | iOS/Play listing | 1024×1024, no transparency · **PNG** (flattened, no alpha) | "App store icon: the Prova proof-seal 'P' symbol in chartreuse-yellow `#E6F94E` centered on a near-black `#0E0E11` rounded square with a faint top olive-glow, generous padding, crisp, iconic, no text." |
| 6 | **Android adaptive — foreground** | launcher | 1024×1024, transparent, subject in center 66% · **PNG** (alpha) | "Just the Prova chartreuse `#E6F94E` proof-seal symbol, centered, occupying the middle safe zone, transparent background, thick strokes — Android adaptive foreground layer." |
| 7 | **Android adaptive — background** | launcher | 1024×1024 · **PNG** | "A near-black `#0E0E11` background with a soft radial olive/chartreuse glow in the upper area, subtle, no subject — Android adaptive background layer." |
| 8 | **Splash logo** | launch screen | 1200×1200, transparent (over `#0E0E11`) · **PNG** (alpha) | "Centered Prova seal symbol + 'prova' wordmark stacked, chartreuse `#E6F94E` mark + white wordmark, small, on transparent background intended over near-black, calm, minimal." |
| 9 | **Notification icon** | Android status bar | 96×96, transparent, pure white silhouette · **PNG** (alpha, white only) | "A single flat pure-white silhouette of the Prova proof-seal 'P', no color, no detail, solid shape only, transparent background — Android notification small icon." |
| 10 | **Favicon glyph** | web | 512×512 · **PNG** (+ optional `.ico` / SVG favicon) | "The Prova seal symbol simplified to its barest form, chartreuse `#E6F94E` on near-black rounded square, legible at 16px, flat." |

## 3) Store listing / marketing graphics (4)

| # | Image | Use | Spec · **Format** | Prompt (after STYLE BLOCK) |
|---|---|---|---|---|
| 11 | **Play feature graphic** | Play Store banner | 1024×500 · **PNG** (or JPG) | "Wide hero banner: near-black background with chartreuse glow, a floating glassy phone showing a dark fintech app, big white headline space on the left, the Prova seal, sealed-envelope-with-glowing-stamp motif, premium, minimal, chartreuse `#E6F94E` accent." |
| 12 | **Screenshot frame template** | store screenshots | 1290×2796 (iPhone) · **PNG** (final screenshots PNG/JPG) | "A clean phone-mockup frame on a near-black gradient background with a short bold white caption bar at top and a chartreuse underline accent — an empty device frame template to drop app screenshots into." |
| 13 | **App preview poster** | store video thumb | 1290×2796 · **PNG** (or JPG) | "Vertical poster: the Prova app floating in a dark glassy scene, 'Send money home — privately' concept space, chartreuse accent glow, one phone, lots of negative space." |
| 14 | **Pitch / one-pager hero** | deck cover | 1920×1080 · **PNG** (SVG/PDF if editable in a deck) | "Landscape title slide: near-black with olive glow, the Prova lockup centered, tagline space, a faint sealed-letter + zk-stamp motif in the corner, elegant, investor-grade." |

## 4) In-app illustrations (6)

| # | Image | Use | Spec · **Format** | Prompt (after STYLE BLOCK) |
|---|---|---|---|---|
| 15 | **Onboarding 1 — Privacy** | welcome slide | 1200×1200, transparent · **SVG** (fallback WebP/PNG @2x,@3x) | "Flat vector illustration: a sealed glowing envelope with a chartreuse `#E6F94E` wax-stamp shaped like a checkmark, floating on transparent/dark, soft glow, conveys 'private by default', minimal, no text." |
| 16 | **Onboarding 2 — Compliance** | welcome slide | 1200×1200, transparent · **SVG** (fallback WebP/PNG) | "Flat vector: a shield/seal made of light with a subtle zero-knowledge circuit pattern inside, chartreuse accent, conveys 'provably legal without revealing data', dark, minimal, no text." |
| 17 | **Onboarding 3 — Speed** | welcome slide | 1200×1200, transparent · **SVG** (fallback WebP/PNG) | "Flat vector: a paper plane / value token traveling along a glowing arc from a UAE skyline silhouette to an India silhouette, chartreuse trail, conveys 'fast cross-border', dark, minimal, no text." |
| 18 | **Success / 'Sent' hero** | send success | 1000×1000, transparent · **SVG** | "Flat vector celebratory mark: a chartreuse `#E6F94E` checkmark inside a soft glowing seal with tiny sparkles, conveys 'transfer delivered', dark background friendly, no text." |
| 19 | **KYC / verify illustration** | KYC screen | 1000×1000, transparent · **SVG** | "Flat vector: an ID card transforming into a glowing chartreuse credential badge with a checkmark, subtle lock, conveys 'verified once, stored only on your phone', dark, minimal." |
| 20 | **Empty / offline state** | empty history, no-connection | 1000×1000, transparent · **SVG** | "Flat vector: a calm empty seal outline with a faint dotted orbit, muted lilac `#DCCBF7` + grey, conveys 'nothing here yet', gentle, dark-friendly, no text." |

## 5) Social / web marketing (3)

| # | Image | Use | Spec · **Format** | Prompt (after STYLE BLOCK) |
|---|---|---|---|---|
| 21 | **Open Graph / share card** | link previews | 1200×630 · **PNG** | "Social share card: near-black with chartreuse glow, Prova lockup left, tagline 'Private, compliant remittance on Stellar' space right, a glassy phone peeking in, premium, minimal." |
| 22 | **X / Twitter banner** | profile header | 1500×500 · **PNG** (or JPG) | "Wide profile banner: dark olive-glow gradient, subtle sealed-letter + zk-stamp pattern, Prova wordmark and seal offset to one side, lots of clean space, chartreuse accent." |
| 23 | **Instagram post template** | announcements | 1080×1080 · **PNG** (export JPG/PNG) | "Square branded template: near-black card with rounded chartreuse frame accent, centered headline space, small Prova seal in a corner, glassy, consistent with the app UI." |

---

## Production tips

- **Generate at 2–4× and downscale** for crisp icons. Get the **app symbol (#1) perfect first** —
  everything else (#3–#10) derives from that single mark.
- **AI is bad at text.** For the wordmark (#2) and anything with letters, set the type yourself in
  Figma/Canva or plan to clean it up; prompt-generated lettering is usually garbled.
- **Prefer vector (SVG)** for the logo/icon so it scales to every size; #5–#10 are the same mark at
  different sizes/treatments.
- **Minimum to ship testnet builds:** #5, #6, #7, #8, #9 (OS assets) + the #1 mark they come from.

## Where these plug into the app

| Asset | File to replace | Declared in |
|---|---|---|
| App icon | `mobile/assets/images/icon.png` | `mobile/app.json` → `expo.icon` |
| Adaptive foreground/background | `mobile/assets/images/android-icon-foreground.png` / `-background.png` | `expo.android.adaptiveIcon` |
| Adaptive monochrome | `mobile/assets/images/android-icon-monochrome.png` | `expo.android.adaptiveIcon.monochromeImage` |
| Splash | `mobile/assets/images/splash-icon.png` (+ set `backgroundColor` to `#0E0E11`) | `expo-splash-screen` plugin |
| Favicon | `mobile/assets/images/favicon.png` | `expo.web.favicon` |

> After generating #5–#9, the `app.json` colors also need updating from the Expo-default blue
> (`#E6F4FE` / `#208AEF`) to the brand near-black `#0E0E11`.
