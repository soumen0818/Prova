# prova-mobile

Prova's mobile app — private, compliant cross-border remittance on Stellar.
React Native + Expo (SDK 56). Part of the Prova polyrepo (see `../Docs/`).

## Prerequisites

- Node **22 LTS** (managed via nvm: `nvm use 22`)
- A free [Expo account](https://expo.dev) for cloud builds (EAS)
- Expo Go on a device for quick previews; a **development build** for native features (see below)

## Getting started

```bash
nvm use 22
npm install
cp .env.example .env   # adjust if needed; defaults target Stellar testnet
npm start              # then press w (web) or scan the QR with Expo Go
```

## Scripts

| Script                            | Purpose                      |
| --------------------------------- | ---------------------------- |
| `npm start`                       | Start the Expo dev server    |
| `npm run android` / `ios` / `web` | Start on a specific platform |
| `npm run typecheck`               | `tsc --noEmit`               |
| `npm run lint`                    | Expo ESLint                  |
| `npm run format` / `format:check` | Prettier write / verify      |

## Builds (EAS)

This app needs **development builds** (not Expo Go) because of upcoming native modules (the Rust ZK
prover, secure enclave). Profiles are in `eas.json`:

```bash
eas login
eas init                                    # one-time: link the project
eas build --profile development --platform android
```

- `development` — installable dev client (day-to-day build, replaces Expo Go)
- `preview` — internal APK for testers
- `production` — Play Store app bundle

## Project structure

```
src/
  app/            expo-router routes (file-based). _layout loads fonts + theme.
  components/
    ui/           design-system primitives (Screen, Button, Card, GlassIconButton)
    themed-*.tsx  scheme-aware text/view
  constants/
    theme.ts      ★ single source of truth for design tokens (colors, type, spacing, radius)
  config/
    env.ts        typed runtime config (EXPO_PUBLIC_* + testnet defaults)
  lib/
    secure-store.ts  typed enclave wrapper (ZK key, KYC credential)
    logger.ts        Sentry-ready logging abstraction
  hooks/          color-scheme + theme hooks
```

## Conventions

- **Never hardcode colors/spacing** — import tokens from `@/constants/theme`.
- Build screens inside `<Screen>` so background, glow, and safe areas stay consistent.
- Secrets (ZK key, KYC credential) only ever go through `lib/secure-store.ts` — never plain storage.
- Design language: dark-first, one chartreuse accent, rounded glassy components. See
  `../Docs/design-system.md`.
