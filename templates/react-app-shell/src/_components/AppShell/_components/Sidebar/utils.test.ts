import { describe, expect, test } from 'bun:test';
import type { NavItemConfig, NavSection } from './types';
import { resolveNav } from './utils';

const sections: NavSection[] = [
  {
    id: 'primary',
    label: 'Primary',
    items: [
      { id: 'home', label: 'Home', href: '/' },
      {
        id: 'transactions',
        label: 'Transactions',
        href: '/transactions',
        children: [
          { id: 'review', label: 'Review', href: '/transactions/review' },
          {
            id: 'rules',
            label: 'Rules',
            href: '/transactions/rules',
            children: [{ id: 'new-rule', label: 'New rule', href: '/transactions/rules/new' }],
          },
        ],
      },
      { id: 'reports', label: 'Reports', href: '/reports' },
    ],
  },
];

/** The state of every item in the resolved tree, keyed by id: current, active or -. */
function stateFor(pathname: string): Record<string, string> {
  const states: Record<string, string> = {};
  const visit = (items: NavItemConfig[]) => {
    for (const item of items) {
      states[item.id] = item.current ? 'current' : item.active ? 'active' : '-';
      if (item.children) visit(item.children);
    }
  };
  for (const section of resolveNav(sections, pathname)) visit(section.items);
  return states;
}

const idle = { home: '-', transactions: '-', review: '-', rules: '-', 'new-rule': '-', reports: '-' };

describe('resolveNav', () => {
  test('marks only the exact page current; the root item is not a prefix of every page', () => {
    expect(stateFor('/reports')).toEqual({ ...idle, reports: 'current' });
    expect(stateFor('/')).toEqual({ ...idle, home: 'current' });
  });

  test('marks a section active when its child is the current page', () => {
    expect(stateFor('/transactions/review')).toEqual({ ...idle, transactions: 'active', review: 'current' });
  });

  test('marks every ancestor of a nested page active', () => {
    expect(stateFor('/transactions/rules/new')).toEqual({
      ...idle,
      transactions: 'active',
      rules: 'active',
      'new-rule': 'current',
    });
  });

  test('marks an item active for a page below its href that the nav does not list', () => {
    expect(stateFor('/reports/2026/q3')).toEqual({ ...idle, reports: 'active' });
    expect(stateFor('/reportsarchive')).toEqual(idle);
  });

  test('ignores the query, the hash and a trailing slash', () => {
    expect(stateFor('/transactions/review/?sort=date#row-4')).toEqual({
      ...idle,
      transactions: 'active',
      review: 'current',
    });
  });

  test('leaves the config untouched', () => {
    resolveNav(sections, '/transactions/review');
    expect(sections[0]?.items[1]).not.toHaveProperty('active');
  });
});

// The budget app's real routes: a section shares its first child's href, and
// one section's href (/accounts) is a URL prefix of another's (/accounts/transactions).
const budget: NavSection[] = [
  {
    id: 'primary',
    label: 'Primary',
    items: [
      {
        id: 'activity',
        label: 'Activity',
        href: '/accounts/transactions',
        children: [
          { id: 'transactions', label: 'Transactions', href: '/accounts/transactions' },
          { id: 'subscriptions', label: 'Subscriptions', href: '/subscriptions' },
        ],
      },
      {
        id: 'connections',
        label: 'Connections',
        href: '/accounts',
        children: [
          { id: 'entities', label: 'Entities', href: '/entities' },
          { id: 'accounts', label: 'Accounts', href: '/accounts' },
          { id: 'merchant-accounts', label: 'Merchant Accounts', href: '/merchant-accounts' },
        ],
      },
    ],
  },
];

function budgetState(pathname: string): Record<string, string> {
  const states: Record<string, string> = {};
  const visit = (items: NavItemConfig[]) => {
    for (const item of items) {
      states[item.id] = item.current ? 'current' : item.active ? 'active' : '-';
      if (item.children) visit(item.children);
    }
  };
  for (const section of resolveNav(budget, pathname)) visit(section.items);
  return states;
}

const budgetIdle = {
  activity: '-',
  transactions: '-',
  subscriptions: '-',
  connections: '-',
  entities: '-',
  accounts: '-',
  'merchant-accounts': '-',
};

describe('resolveNav with shared hrefs and nested prefixes', () => {
  test('a parent that shares its child href is active; only the deepest exact match is current', () => {
    expect(budgetState('/accounts/transactions')).toEqual({
      ...budgetIdle,
      activity: 'active',
      transactions: 'current',
    });
    expect(budgetState('/accounts')).toEqual({ ...budgetIdle, connections: 'active', accounts: 'current' });
  });

  test('the prefix rule applies only to the single longest match in the whole tree', () => {
    // /accounts is a prefix too, but /accounts/transactions is longer, so Connections stays idle.
    expect(budgetState('/accounts/transactions/2026-09')).toEqual({
      ...budgetIdle,
      activity: 'active',
      transactions: 'active',
    });
    expect(budgetState('/merchant-accounts/amazon')).toEqual({
      ...budgetIdle,
      connections: 'active',
      'merchant-accounts': 'active',
    });
  });

  test('never marks more than one item current', () => {
    for (const path of ['/accounts/transactions', '/accounts', '/subscriptions', '/entities', '/nowhere']) {
      const currents = Object.values(budgetState(path)).filter((state) => state === 'current');
      expect(currents.length).toBeLessThanOrEqual(1);
    }
  });
});
