import { APK_URL } from '@/lib/site';

/**
 * The "Get the app" call to action, used by the header and the hero.
 *
 * Both used to jump to the download section. They now hand over the APK directly, because a visitor
 * who clicks "Get the app" has already decided — making them land on a section and press a second
 * button was a step that asked nothing and told them nothing.
 *
 * The download section still exists and is still linked from the footer: it carries the testnet
 * warning, the arm64 requirement and the sideloading note, which are worth reading and are not worth
 * blocking the download behind.
 *
 * When `APK_URL` is empty there is no build to hand over, so the button falls back to the section —
 * which in that state explains that the download is not up yet and offers to email when it is. A
 * button that downloads nothing would be worse than one that explains itself.
 */
export function GetAppButton({ className }: { className: string }) {
  const ready = APK_URL !== '';

  return (
    <a
      className={className}
      href={ready ? APK_URL : '/#get-the-app'}
      // `download` only hints the filename for same-origin URLs; the build is served from Expo's
      // CDN as application/octet-stream, so the browser saves it either way.
      {...(ready ? { download: true } : {})}>
      Get the app
    </a>
  );
}
