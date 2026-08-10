'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { ChatIcon, GridIcon, ShieldIcon } from './icons';

/**
 * Console navigation, with a count beside anything that is waiting.
 *
 * The counts matter more than they look: this console is checked a few times a day, so the first
 * question on opening it is always "is there anything for me?". Answering that in the nav means it
 * is answered on every page, not just the overview.
 *
 * A client component only because it needs the current path to mark the active link.
 */
export function OpsNav({ waiting, unanswered }: { waiting: number; unanswered: number }) {
  const pathname = usePathname();

  const links = [
    { href: '/ops', label: 'Overview', Icon: GridIcon, count: 0 },
    { href: '/ops/kyc', label: 'Verifications', Icon: ShieldIcon, count: waiting },
    { href: '/ops/support', label: 'Conversations', Icon: ChatIcon, count: unanswered },
  ];

  return (
    <nav className="ops-nav">
      {links.map(({ href, label, Icon, count }) => {
        // Exact match for the overview, prefix match for the rest, so a conversation page keeps
        // "Conversations" highlighted.
        const active = href === '/ops' ? pathname === '/ops' : pathname.startsWith(href);
        return (
          <Link key={href} href={href} aria-current={active ? 'page' : undefined}>
            <Icon />
            <span className="ops-nav-label">{label}</span>
            {/* No badge at zero: a "0" on every item trains you to stop reading the number. */}
            {count > 0 ? (
              <span className="ops-nav-count" aria-label={`${count} waiting`}>
                {count}
              </span>
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}
