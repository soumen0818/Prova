const {
  withAndroidStyles,
  withAppBuildGradle,
  withGradleProperties,
  AndroidConfig,
} = require('expo/config-plugins');

/**
 * Android native settings that must survive `expo prebuild`.
 *
 * `android/` is generated and gitignored, so anything edited there by hand is lost the next time it
 * regenerates — and never existed at all for a teammate or for CI. Both fixes below were originally
 * made directly in the generated files and would have silently reverted.
 *
 * 1. **Gradle JVM heap.** The default 2 GB runs out during `mergeExtDexDebug` on this app (many
 *    native modules + the Rust prover), failing the build with `OutOfMemoryError: Java heap space`.
 *
 * 2. **Window background.** `AppTheme` is what shows between the splash screen dismissing and
 *    React's first frame. Without an explicit `android:windowBackground` it inherits
 *    `Theme.AppCompat.DayNight`'s default, which flashes plain black before the app's own dark
 *    background paints. Setting it to the brand background makes that gap invisible instead.
 *    (This is a real launch flash, not a dev-only artifact — it is shorter in a release build only
 *    because the JS bundle is embedded rather than fetched from Metro.)
 *
 * 3. **arm64-only native builds.** `expo-build-properties`' `buildArchs` and the
 *    `reactNativeArchitectures` Gradle property both constrain React Native's own build, but Expo
 *    modules with their own CMake (expo-updates, react-native-worklets) read neither — they build
 *    every ABI the NDK offers unless the app module declares `abiFilters`. A build therefore spent
 *    minutes compiling `armeabi-v7a` and then failed on it, for an architecture this app
 *    deliberately does not ship (the Rust prover has no 32-bit build).
 *
 * 4. **Version from app.json.** The generated `build.gradle` hardcodes `versionName "1.0.0"` and
 *    `versionCode 1`. Prebuild normally rewrites them, but a checked-out `android/` that predates a
 *    version bump keeps the stale values — so a local build reported 1.0.0 while app.json said
 *    1.2.8, and the installed build could not be identified. Reading app.json at configuration time
 *    makes the two agree by construction.
 */

/** Brand background — keep in sync with `Palette.bgBase` and the splash `backgroundColor`. */
const BRAND_BACKGROUND = '#0E0E11';

const withProvaGradleHeap = (config) =>
  withGradleProperties(config, (cfg) => {
    const key = 'org.gradle.jvmargs';
    const value = '-Xmx4608m -XX:MaxMetaspaceSize=1024m';
    const existing = cfg.modResults.find((item) => item.type === 'property' && item.key === key);
    if (existing) {
      existing.value = value;
    } else {
      cfg.modResults.push({ type: 'property', key, value });
    }
    return cfg;
  });

const withProvaWindowBackground = (config) =>
  withAndroidStyles(config, (cfg) => {
    cfg.modResults = AndroidConfig.Styles.assignStylesValue(cfg.modResults, {
      add: true,
      name: 'android:windowBackground',
      value: BRAND_BACKGROUND,
      parent: { name: 'AppTheme', parent: 'Theme.AppCompat.DayNight.NoActionBar' },
    });
    return cfg;
  });

/**
 * Constrain native builds to arm64 and take the version from app.json.
 *
 * Both are edits to the app module's `build.gradle`. `versionCode` is derived from `versionName`
 * (1.2.8 -> 10208) so it always rises with it: Android refuses to install over a package with a
 * higher code, and a frozen `1` makes every build look identical to the package manager.
 */
const withProvaAppGradle = (config) =>
  withAppBuildGradle(config, (cfg) => {
    const [major, minor, patch] = String(config.version ?? '0.0.0')
      .split('.')
      .map((n) => parseInt(n, 10) || 0);
    const versionCode = major * 10000 + minor * 100 + patch;

    let contents = cfg.modResults.contents;

    // Version: replace whatever prebuild wrote with the value from app.json.
    contents = contents
      .replace(/versionCode\s+\d+/, `versionCode ${versionCode}`)
      .replace(/versionName\s+"[^"]*"/, `versionName "${config.version}"`);

    // ABI filter: added once, inside defaultConfig, only if not already present.
    if (!contents.includes('abiFilters')) {
      contents = contents.replace(
        /(defaultConfig\s*\{)/,
        `$1\n        ndk {\n            abiFilters 'arm64-v8a'\n        }`,
      );
    }

    cfg.modResults.contents = contents;
    return cfg;
  });

module.exports = (config) =>
  withProvaAppGradle(withProvaWindowBackground(withProvaGradleHeap(config)));
