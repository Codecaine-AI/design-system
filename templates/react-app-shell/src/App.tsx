import { useState } from 'react';
import { AppShell, resolveNav, type NavSection } from './_components/AppShell';
import { Icon } from './shared/_components/Icon';

const sections: NavSection[] = [
  {
    id: 'primary',
    label: 'Primary',
    items: [
      { id: 'overview', label: 'Overview', href: '/', icon: <Icon name="dashboard" /> },
      {
        id: 'transactions',
        label: 'Transactions',
        href: '/transactions',
        icon: <Icon name="list" />,
        children: [
          { id: 'review', label: 'Review', href: '/transactions/review' },
          { id: 'recurring', label: 'Recurring', href: '/transactions/recurring' },
        ],
      },
      { id: 'reports', label: 'Reports', href: '/reports', icon: <Icon name="chart" /> },
      {
        id: 'accounts',
        label: 'Accounts',
        href: '/accounts',
        icon: <Icon name="wallet" />,
        dividerAfter: true,
      },
      { id: 'connections', label: 'Connections', href: '/connections', icon: <Icon name="link" /> },
    ],
  },
  {
    id: 'tools',
    label: 'Tools',
    showHeading: true,
    placement: 'end',
    items: [
      { id: 'automations', label: 'Automations', href: '/automations', icon: <Icon name="bot" /> },
      { id: 'settings', label: 'Settings', href: '/settings', icon: <Icon name="settings" /> },
    ],
  },
];

export function App() {
  const [detailsOpen, setDetailsOpen] = useState(false);
  // No router in this example. With one, pass its location instead (see README).
  const pathname = typeof window === 'undefined' ? '/' : window.location.pathname;

  return (
    <AppShell
      appName="Ledger"
      storageKey="ledger.sidebar"
      sections={resolveNav(sections, pathname)}
      title="Overview"
      actions={
        <button
          type="button"
          className="ds-shell-button"
          aria-expanded={detailsOpen}
          aria-controls="ds-inspector"
          onClick={() => setDetailsOpen((open) => !open)}
        >
          Details
        </button>
      }
      footer={
        <>
          <span className="ds-avatar" aria-hidden="true">
            AL
          </span>
          <span className="ds-sidebar-footer-text">
            <span className="ds-sidebar-footer-name">Ada Lovelace</span>
            <span className="ds-sidebar-footer-meta">Personal account</span>
          </span>
        </>
      }
      inspector={{
        title: 'Details',
        open: detailsOpen,
        onClose: () => setDetailsOpen(false),
        content: <p>Details for the selected row go here.</p>,
      }}
    >
      <p>Page content goes here.</p>
    </AppShell>
  );
}
