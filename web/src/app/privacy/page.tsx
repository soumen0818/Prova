import type { Metadata } from 'next';

import { LegalPage } from '@/components/legal-page';

export const metadata: Metadata = {
  title: 'Privacy Policy — Prova',
  description:
    'What stays on your phone, the little Prova holds, and who else is involved in a transfer.',
};

export default function PrivacyPage() {
  return <LegalPage id="privacy" />;
}
