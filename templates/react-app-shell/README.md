# React app shell template

The reference React implementation of the default app shell ([guide/layout.md](../../guide/layout.md)), organized as vertical slices ([guide/code-structure.md](../../guide/code-structure.md)). Copy it into an app. It is not a package and has no dependencies besides React.

## Tree

```text
src/
  App.tsx                                  example wiring, no router; imports AppShell and Icon through their indexes
  shared/_components/Icon/index.tsx        example icon set; swap in your own
  _components/AppShell/
    index.tsx                              AppShell and Lane; re-exports the nav types and resolveNav
    index.test.tsx                         server render against the layout.css contract
    useSidebarCollapsed.ts                 collapsed state, persistence, Mod+\, shortcut label
    constants.ts                           NARROW_VIEWPORT_QUERY (matches the 800px block in layout.css)
    utils.ts  utils.test.ts                isToggleShortcut, shortcutLabel
    _components/
      Sidebar/
        index.tsx                          Sidebar; re-exports its types and resolveNav
        types.ts                           NavSection, NavItemConfig, ShellLinkProps, ShellLinkComponent
        utils.ts  utils.test.ts            resolveNav: one current row, one longest prefix match
        _components/
          SidebarToggle/index.tsx          collapse button; gets the shortcut label as a prop
          NavItem/index.tsx                top-level row
          SubNav/index.tsx                 nested rows, recursive for a third level
      Topbar/index.tsx                     h1 and actions
      Inspector/index.tsx                  optional right-hand panel
```

The nav model lives in `Sidebar/` because only the sidebar subtree uses it. Every import goes through an index and climbs at most two levels, so the copied folder needs no `@/` alias.

## Use it

1. Copy `src/_components/AppShell/` into your app's `src/_components/`. Copy `src/shared/_components/Icon/` too if you want the example icons.
2. Load the CSS once at the app root. These paths map to `dist/css/tokens.css` and `css/layout.css`:

   ```ts
   import '@codecaine-ai/text-measure/fonts.css'; // Inter + IBM Plex Mono; tokens.css names them but ships no @font-face
   import '@codecaine-ai/design-system/tokens.css';
   import '@codecaine-ai/design-system/layout.css';
   ```

3. Import everything from the AppShell index, write the nav config and render the shell. `src/App.tsx` shows a full example.

   ```tsx
   import { AppShell, resolveNav, type NavSection } from './_components/AppShell';

   <AppShell
     appName="Ledger"
     storageKey="ledger.sidebar"
     sections={resolveNav(sections, pathname)}
     title="Overview"
   >
     {page}
   </AppShell>
   ```

Requirements: React 18 or 19 and TypeScript. The markup uses only the `ds-` classes and data attributes from `css/layout.css`: no other CSS, no inline styles.

## Router wiring: RouterShell

Put the router wiring in its own component folder, `RouterShell`, next to `AppShell`. Every nav link renders through `linkComponent` (default `'a'`), which receives `ShellLinkProps`: anchor attributes plus `href`. Define a link adapter at module scope so it keeps one identity across renders.

### React Router

```tsx
// src/_components/RouterShell/index.tsx
import { Link, Outlet, useLocation } from 'react-router'; // v6: 'react-router-dom'
import { AppShell, resolveNav, type NavSection, type ShellLinkProps } from '../AppShell';

const sections: NavSection[] = [
  /* your nav config, as in the template's App.tsx */
];

function RouterLink({ href, ...rest }: ShellLinkProps) {
  return <Link to={href} {...rest} />;
}

export function RouterShell() {
  const { pathname } = useLocation();
  return (
    <AppShell
      appName="Ledger"
      storageKey="ledger.sidebar"
      sections={resolveNav(sections, pathname)}
      title="Overview"
      linkComponent={RouterLink}
    >
      <Outlet />
    </AppShell>
  );
}
```

`App.tsx` renders it as the layout route:

```tsx
// src/App.tsx
<BrowserRouter>
  <Routes>
    <Route element={<RouterShell />}>{/* page routes */}</Route>
  </Routes>
</BrowserRouter>
```

### Next.js (App Router)

Copy `AppShell/` to `app/_components/AppShell/`. `next/link` takes `href` directly, so on Next 15 and later (React 19 types) it needs no adapter. On Next 14 (React 18 types), pass `function NextLink(props: ShellLinkProps) { return <Link {...props} />; }` instead.

```tsx
// app/_components/RouterShell/index.tsx
'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { AppShell, resolveNav, type NavSection } from '../AppShell';

const sections: NavSection[] = [
  /* your nav config */
];

export type RouterShellProps = { children: ReactNode; defaultCollapsed?: boolean };

export function RouterShell({ children, defaultCollapsed }: RouterShellProps) {
  const pathname = usePathname();
  return (
    <AppShell
      appName="Ops"
      storageKey="ops.sidebar"
      sections={resolveNav(sections, pathname)}
      title="Overview"
      linkComponent={Link}
      defaultCollapsed={defaultCollapsed}
    >
      {children}
    </AppShell>
  );
}
```

```tsx
// app/layout.tsx (a server component)
import { cookies } from 'next/headers';
import type { ReactNode } from 'react';
import { RouterShell } from './_components/RouterShell';

export default async function RootLayout({ children }: { children: ReactNode }) {
  const stored = (await cookies()).get('ops.sidebar')?.value;
  return (
    <html lang="en">
      <body>
        <RouterShell defaultCollapsed={stored ? stored === 'collapsed' : undefined}>{children}</RouterShell>
      </body>
    </html>
  );
}
```

localStorage is client-only. The server renders the sidebar from `defaultCollapsed` (expanded when unset), and hydration reuses that state, so the markup matches. After hydration the shell switches to the stored choice, so the width can animate once on load. The cookie that `app/layout.tsx` reads prevents that. To write it, add one line to `writeStored` in `useSidebarCollapsed.ts`:

```ts
document.cookie = `${storageKey}=${value}; path=/; max-age=31536000; samesite=lax`;
```

## Behavior

- **Toggle.** The button at the right end of the sidebar header, or `⌘\` on Apple platforms and `Ctrl+\` elsewhere, from anywhere in the app. Alt or Shift combinations, held-key repeats and key events that another handler already prevented are ignored.
- **Persistence.** Only explicit choices are stored, in localStorage under `storageKey` (default `ds.sidebar`; use `<app>.sidebar`), as `collapsed` or `expanded`. The start state is the stored choice, then `defaultCollapsed`, then collapsed when the viewport is 800px wide or less (`NARROW_VIEWPORT_QUERY`). A client render reads it before the first paint, so no width transition plays on load.
- **Rail tooltips.** Collapsed, every top-level row carries a native `title` with its label. Expanded rows have none.
- **Nav state.** `resolveNav(sections, pathname)` picks one item for the page: the deepest item whose href equals it, or, when none does, the item with the longest href that is a path prefix of it. An exact match is `current` (`aria-current="page"`); a prefix match and every item above the match are `active` (`data-active="true"`, which also shows their subnav). So a section that shares its first child's href is active, not current, and `/accounts` does not light up on `/accounts/transactions`. Query, hash and a trailing slash are ignored.
- **Inspector.** It stays mounted while closed so it can slide out; `inspector.open` sets `data-inspector` on the shell. Opening moves focus to its close button. Escape or the close button calls `onClose`, and focus returns to the opener.

## Verification

The template was checked in place, with React and Bun types borrowed from `codecaine/core`. Run from `templates/react-app-shell/`:

```sh
# Import rules from guide/code-structure.md: both print nothing
grep -rnE "from ['\"]\.{1,2}/([^'\"]*/)?[A-Z][A-Za-z0-9]*/" src
grep -rnE "from ['\"](\.\./){3,}" src

cat > tsconfig.tmp.json <<'EOF'
{
  "compilerOptions": {
    "strict": true, "jsx": "react-jsx", "module": "ESNext", "moduleResolution": "Bundler",
    "target": "ES2022", "lib": ["DOM", "DOM.Iterable", "ES2022"], "noEmit": true,
    "skipLibCheck": true, "noUnusedLocals": true, "noUnusedParameters": true,
    "typeRoots": ["/Users/Ford/workspace/codecaine/core/node_modules/@types"], "types": ["bun"],
    "paths": {
      "react": ["/Users/Ford/workspace/codecaine/core/node_modules/@types/react"],
      "react/*": ["/Users/Ford/workspace/codecaine/core/node_modules/@types/react/*"],
      "react-dom/*": ["/Users/Ford/workspace/codecaine/core/node_modules/@types/react-dom/*"]
    }
  },
  "include": ["src"]
}
EOF
/Users/Ford/workspace/codecaine/core/node_modules/.bin/tsc -p tsconfig.tmp.json   # no errors

ln -s /Users/Ford/workspace/codecaine/core/node_modules node_modules
bun test                                                                         # 15 pass, 0 fail, 3 files

rm node_modules tsconfig.tmp.json
```

Versions: TypeScript 5.9.3, `@types/react` 19.2.18, React 19.2.3, Bun 1.4.2. The source also type-checks with `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` and `verbatimModuleSyntax` on, and with `@types/react` 18.3. The `RouterShell` snippets were type-checked against React Router 7.1 and Next 16.1 (React 19 types), and against React Router 6.30 and the `NextLink` adapter on Next 15.3 (React 18 types).

The tests need React, and the design-system root has none, so run them from this folder as above. A plain `bun test` at the repo root fails on `index.test.tsx` unless it skips `templates/`.
