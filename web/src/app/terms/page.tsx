import type { Metadata } from 'next';

import { LegalPage } from '@/components/legal-page';

export const metadata: Metadata = {
  title: 'Terms of Service — Prova',
  description: 'The terms covering your use of the Prova app, including the test-network notice.',
};

export default function TermsPage() {
  return <LegalPage id="terms" />;
}
