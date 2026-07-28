import { useLocalSearchParams, useRouter } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';

import { LockedMark } from '@/components/illustrations';
import { StateView } from '@/components/state-view';

const SUPPORT_URL = 'https://prova.app/support';

/**
 * Access denied / account restricted (the 403 case).
 *
 * Reached when the backend refuses an action for a *policy* reason rather than a technical one:
 * a frozen account, a fraud hold, or a terminal KYC rejection. Those are different from an error —
 * retrying won't help — so this screen offers the only two routes that can: verify identity, or
 * talk to a human.
 *
 * `reason` selects the explanation; anything unknown falls back to the generic restricted copy so a
 * new server-side reason can never produce a blank screen.
 */
export default function BlockedScreen() {
  const router = useRouter();
  const { reason } = useLocalSearchParams<{ reason?: string }>();
  const copy = explain(reason);

  return (
    <StateView
      illustration={<LockedMark />}
      title={copy.title}
      body={copy.body}
      reassurance="Your funds remain safe and are not affected."
      primaryLabel={copy.canVerify ? 'Verify identity' : 'Contact support'}
      onPrimary={() =>
        copy.canVerify ? router.replace('/kyc') : void WebBrowser.openBrowserAsync(SUPPORT_URL)
      }
      secondaryLabel={copy.canVerify ? 'Contact support' : 'Go to home'}
      onSecondary={() =>
        copy.canVerify ? void WebBrowser.openBrowserAsync(SUPPORT_URL) : router.replace('/')
      }
    />
  );
}

function explain(reason?: string): { title: string; body: string; canVerify: boolean } {
  switch (reason) {
    case 'kyc_required':
      return {
        title: 'Verification needed',
        body: 'You need to verify your identity before you can use this feature.',
        canVerify: true,
      };
    case 'kyc_rejected':
      return {
        title: 'We can’t verify this account',
        body: 'Your identity check didn’t pass, so account features are unavailable. Our support team can explain what happens next.',
        canVerify: false,
      };
    case 'frozen':
      return {
        title: 'Account temporarily frozen',
        body: 'We’ve paused this account while our team reviews some unusual activity. This is a protective measure.',
        canVerify: false,
      };
    default:
      return {
        title: 'Access restricted',
        body: 'This account can’t access that right now. Our support team can help sort it out.',
        canVerify: false,
      };
  }
}
