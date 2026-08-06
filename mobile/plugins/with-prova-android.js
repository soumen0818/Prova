const { withAndroidStyles, withGradleProperties, AndroidConfig } = require('expo/config-plugins');

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

module.exports = (config) => withProvaWindowBackground(withProvaGradleHeap(config));
