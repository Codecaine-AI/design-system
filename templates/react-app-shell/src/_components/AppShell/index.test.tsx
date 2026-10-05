import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { AppShell, type AppShellProps, type NavSection } from '.';

// Already resolved, as `resolveNav(…, '/transactions/review')` would return it.
const sections: NavSection[] = [
  {
    id: 'primary',
    label: 'Primary',
    items: [
      { id: 'home', label: 'Home', href: '/', icon: <svg /> },
      {
        id: 'transactions',
        label: 'Transactions',
        href: '/transactions',
        icon: <svg />,
        active: true,
        children: [
          { id: 'review', label: 'Review', href: '/transactions/review', current: true },
          { id: 'rules', label: 'Rules', href: '/transactions/rules' },
        ],
      },
      {
        id: 'reports',
        label: 'Reports',
        href: '/reports',
        icon: <svg />,
        children: [{ id: 'monthly', label: 'Monthly', href: '/reports/monthly' }],
      },
    ],
  },
];

function render(props: Partial<AppShellProps> = {}): string {
  return renderToStaticMarkup(
    <AppShell appName="Ledger" sections={sections} title="Review" {...props}>
      <p>Body</p>
    </AppShell>,
  );
}

/** The opening tag of the element whose attributes contain `marker`. */
function tagWith(html: string, marker: string): string {
  const at = html.indexOf(marker);
  if (at === -1) throw new Error(`No element with ${marker}`);
  return html.slice(html.lastIndexOf('<', at), html.indexOf('>', at) + 1);
}

describe('AppShell server render', () => {
  test('renders an expanded shell with a working skip link', () => {
    const html = render();
    expect(tagWith(html, 'class="ds-shell"')).toContain('data-sidebar="expanded"');
    expect(tagWith(html, 'class="ds-skip-link"')).toContain('href="#ds-main"');
    expect(tagWith(html, 'class="ds-main"')).toContain('id="ds-main"');
    expect(tagWith(html, 'ds-sidebar-toggle')).toContain('aria-expanded="true"');
  });

  test('marks the current page and shows only the active section subnav', () => {
    const html = render();
    expect(tagWith(html, 'aria-current="page"')).toContain('href="/transactions/review"');
    expect(tagWith(html, 'href="/transactions"')).toContain('data-active="true"');
    expect(tagWith(html, 'class="ds-subnav"')).toContain('aria-label="Transactions"');
    expect(html).not.toContain('/reports/monthly');
  });

  test('keeps the inspector mounted while closed and mirrors open on the shell', () => {
    const inspector = { title: 'Details', open: false, onClose: () => {}, content: <p>Info</p> };
    const closed = render({ inspector });
    expect(tagWith(closed, 'class="ds-shell"')).toContain('data-inspector="closed"');
    expect(tagWith(closed, 'class="ds-inspector"')).toContain('aria-label="Details"');

    const open = render({ inspector: { ...inspector, open: true } });
    expect(tagWith(open, 'class="ds-shell"')).toContain('data-inspector="open"');
  });
});
