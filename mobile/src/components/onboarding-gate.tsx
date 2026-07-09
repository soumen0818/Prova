import { useEffect, useState, type ReactNode } from 'react';
import { View } from 'react-native';

import { Onboarding } from '@/components/onboarding';
import { hasWallet } from '@/lib/wallet';
import { Palette } from '@/constants/theme';

type GateState = 'checking' | 'onboarding' | 'ready';

/** First-run gate: shows onboarding until a wallet exists, then renders the app. */
export function OnboardingGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<GateState>('checking');

  useEffect(() => {
    let active = true;
    (async () => {
      const wallet = await hasWallet();
      if (active) setState(wallet ? 'ready' : 'onboarding');
    })();
    return () => {
      active = false;
    };
  }, []);

  if (state === 'ready') return <>{children}</>;
  if (state === 'onboarding') return <Onboarding onDone={() => setState('ready')} />;
  return <View style={{ flex: 1, backgroundColor: Palette.bgBase }} />;
}
