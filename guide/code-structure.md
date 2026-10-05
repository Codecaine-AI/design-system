# Code structure standard

Group code by feature, not by file type. A slice is one route folder: its `page.tsx`, its `_components/`, and the modules only that route uses.
Every component is a folder, `_components/<Name>/index.tsx`, with its parts in its own `_components/`. Code sits next to the one component that uses it and moves up only when a second consumer appears.
Imports go down through an index, up to an ancestor, or out to `@/shared` and packages. Never sideways into another component's or another slice's internals.

- Reference implementation: [`templates/react-app-shell/`](../templates/react-app-shell/)
- The shell these apps render: [layout.md](layout.md). The values their styles use: [tokens.md](tokens.md).
- The same rules cover React with Vite, React with Next.js, and plain TypeScript DOM apps. See [Variants](#variants).

## Canonical tree

The template is the smallest complete example:

```text
templates/react-app-shell/src/
  App.tsx                           entry file; imports AppShell and Icon through their indexes
  shared/_components/Icon/index.tsx
  _components/AppShell/
    index.tsx                       AppShell; re-exports the nav types and resolveNav
    index.test.tsx
    useSidebarCollapsed.ts
    constants.ts                    NARROW_VIEWPORT_QUERY
    utils.ts  utils.test.ts         shortcut helpers the hook uses
    _components/
      Sidebar/
        index.tsx                   Sidebar; re-exports its types and resolveNav
        types.ts                    NavSection, NavItemConfig, ShellLinkProps
        utils.ts  utils.test.ts     resolveNav
        _components/
          SidebarToggle/index.tsx   gets the shortcut label as a prop
          NavItem/index.tsx
          SubNav/index.tsx
      Topbar/index.tsx
      Inspector/index.tsx
```

The nav model lives in `Sidebar/` because only the sidebar subtree uses it. `NavItem` and `SubNav` reach it in two steps (`../../types`). `AppShell/index.tsx` re-exports it, so `App.tsx` never reaches past an index.

A full app (Vite + react-router):

```text
src/
  main.tsx                          createRoot(…).render(<App />)
  App.tsx                           router, providers, layout route; the only file that imports pages
  _components/AppShell/             the shell; only App.tsx renders it
  shared/
    _components/<Name>/index.tsx    components used by 2+ slices
    <module>.ts                     logic used by 2+ slices
  pages/
    <slice>/                        kebab-case route folder: review/, net-worth/
      page.tsx                      route entry, default export
      model.ts  api.ts  types.ts  use<Slice>.ts
      _components/
        <Name>/
          index.tsx                 export function <Name>, export type <Name>Props
          use<Hook>.ts  types.ts  constants.ts  utils.ts  styles.css
          index.test.tsx  utils.test.ts
          _components/
            <Part>/index.tsx        keep breaking down
      <sub-route>/                  review/results/
        page.tsx
        _components/
```

## Checklist

Run through this before you add or change a component.

1. Find the one component that will render the new code. Create `<that component>/_components/<Name>/index.tsx`. If `page.tsx` renders it, use `<slice>/_components/`.
2. Name the folder in PascalCase. From `index.tsx`, export `function <Name>` and `type <Name>Props`. No default export.
3. Put its hooks, types, constants, helpers, styles and tests in the same folder, under the names in [Files in a component folder](#files-in-a-component-folder).
4. Check every import against [Imports](#imports). If no allowed import reaches the code you need, that code is in the wrong place. Move it (step 5).
5. Code gains a second consumer: `git mv` it to the nearest common ancestor in the same change. A second slice: move it to `src/shared/`. Code loses a consumer: move it back down. Nothing uses it: delete it.
6. Past ~150 lines, a JSX region with its own name, or a region with its own state: extract a child. More than ~7 folders in one `_components/`: add an intermediate component.
7. Run the typecheck, the tests, and the four checks below (paths for the Vite layout). Each check must print nothing.

```sh
# 1. Relative import that passes through a component folder (reaches past its index)
grep -rnE "from ['\"]\.{1,2}/([^'\"]*/)?[A-Z][A-Za-z0-9]*/" src
# 2. Relative import that climbs more than two levels (use @/)
grep -rnE "from ['\"](\.\./){3,}" src
# 3. Shared code or the shell importing a page
grep -rnE "from ['\"](@/pages/|(\.\./)+pages/)" src/shared src/_components
# 4. A slice importing another slice through the alias
for s in src/pages/*/; do grep -rnE "from ['\"]@/pages/" "$s" | grep -v "@/pages/$(basename "$s")/"; done
```

## Vocabulary

| Term | Meaning |
| --- | --- |
| Slice | One route and everything only that route uses. `src/pages/review/` in Vite, a route segment folder in Next.js, a region folder such as `right-sidebar/` in a plain-DOM app. Its entry is `page.tsx` (`index.ts` for a DOM region). |
| Component folder | `_components/<PascalName>/` with an `index.tsx`. |
| Subtree | A component folder and everything below it. |
| Nearest common ancestor | The deepest component folder, or slice root, that contains every consumer. |
| Promote, demote | `git mv` code up or down the tree when its consumers change. |

## Rules

### Slices

- A slice is `src/pages/<slice>/` in Vite and a route segment folder in Next.js. Route folders are kebab-case: `net-worth/`, `budget-setup/`.
- The route entry is `page.tsx`. It keeps the default export its router needs: `lazy(() => import('./pages/review/page'))` in Vite, the file conventions in Next.js (`page.tsx`, `layout.tsx` and the other special files). Components never use a default export.
- `page.tsx` is the root of the slice tree. The components it renders live in `<slice>/_components/`. Styles for markup that `page.tsx` renders itself go in a `styles.css` beside it.
- The slice root holds `page.tsx`, `_components/`, sub-route folders, and a few slice modules: `model.ts`, `api.ts`, `types.ts`, `use<Slice>.ts`.
- When the slice root holds more than 6 non-route modules, move them into `<slice>/_lib/`.
- A sub-route is a folder with its own `page.tsx`: `review/results/page.tsx`, never a sibling file `review/results.tsx`. It follows the slice rules and has its own `_components/`.

### Components

- A component lives at `<parent>/_components/<PascalName>/index.tsx`. It is always a folder, even for a 10-line leaf, so it can grow parts without moving.
- Entry files are the only exception: `main.tsx`, `App.tsx`, route entries (`page.tsx`, and in Next.js `layout.tsx` and the other special files), and the `index.ts` of a plain-DOM slice. They wire the app, its routes or a region together. Everything they render is a component folder.
- One component per `index.tsx`. A second component in the file is a child: give it its own folder.
- Export the component by name, matching the folder. Declare its props in the same file with `type`, not `interface`.
- `index.tsx` is the folder's public surface. A type or helper that belongs to the component's API, such as a type its props use, is re-exported there: `export type { NavSection } from './types';`.
- Re-export types freely. A re-exported function (the template's `resolveNav`) costs Vite Fast Refresh for that `index.tsx`: edits to it reload through the importer instead of updating in place. Keep value re-exports to the few helpers callers need.

```tsx
// …/_components/ReviewCard/index.tsx (the shape, not the real props)
import { CardHeader } from './_components/CardHeader';
import './styles.css';

export type ReviewCardProps = { title: string; onConfirm: () => void };

export function ReviewCard({ title, onConfirm }: ReviewCardProps) {
  return (
    <article className="review-card">
      <CardHeader title={title} />
      <button className="review-card-confirm" type="button" onClick={onConfirm}>Confirm</button>
    </article>
  );
}
```

- Sub-parts nest in the component's own `_components/`. Keep breaking down.
- `_components/` holds only PascalCase component folders: no loose `.tsx` files, no stylesheets, no category folders such as `_components/timelines/`.

### Files in a component folder

Only `index.tsx` is required.

| File | Holds | Rule |
| --- | --- | --- |
| `index.tsx` | The component | One component. Named export and `<Name>Props`. |
| `use<Name>.ts` | A hook used in this subtree | The file name is the hook name: `useReviewDraft.ts`. |
| `types.ts` | Types shared inside the subtree | Types only, no constants. |
| `constants.ts` | Constants shared inside the subtree | |
| `utils.ts` | Pure functions | No React, no DOM. |
| `styles.css` | This component's styles | Imported by `index.tsx`. Every class starts with the component's kebab name: `.review-card`, `.review-card-header`. Values come only from `--ds-*` tokens, such as `var(--ds-space-2)`. Apps on CSS Modules use `styles.module.css`. |
| `index.test.tsx`, `utils.test.ts`, `use<Name>.test.ts` | Unit and component tests | Next to the file they test. No top-level `tests/` folder for them. |
| `<module>/` | Non-component code that outgrew one file | Lowercase folder with an `index.ts` barrel, like `EvidenceRail/connectors/`. |
| `_components/` | Child components | PascalCase folders only. |

### Naming

| What | Case | Examples |
| --- | --- | --- |
| Component folder | PascalCase | `ReviewCard/`, `EvidenceRail/` |
| Hook file | camelCase, same as the hook | `useReviewDraft.ts` exports `useReviewDraft` |
| Every other file and folder | kebab-case | `utils.ts`, `queue-model.ts`, `evidence-connector.ts`, `connectors/`, `net-worth/` |
| Underscore folder | `_` prefix | `_components/` anywhere. `_lib/` only at a slice root with more than 6 modules, and in Next.js route groups. Nothing else. |

### Where code lives

| Used by | Put it |
| --- | --- |
| One component | In that component's folder: its `_components/` for components, next to its `index.tsx` for hooks, utils and types. |
| Two or more components | At their nearest common ancestor: its `_components/` for components, next to its `index.tsx` for hooks, utils and types. |
| Two or more slices | `src/shared/_components/<Name>/index.tsx` for components, `src/shared/<module>.ts` for logic, or a workspace package. |
| Only `src/App.tsx` | `src/_components/`. The shell lives at `src/_components/AppShell/`; its router wiring at `src/_components/RouterShell/`. |

- Never create `src/pages/_components/`. Code that two slices share is shared code.
- Promote with `git mv` in the same change that adds the second consumer. Demote when a consumer goes away. Delete when none is left.
- Example: in the budget app, `GroupedSelector` sits in `review/_components/`, but only `ClassificationPicker` renders it. `ReviewWorkbench` and `ReviewCard` import only its `SelectGroup` type. The component moves down to `ClassificationPicker/_components/GroupedSelector/`, and `SelectGroup` moves to `ReviewWorkbench/types.ts`, the nearest common ancestor of every file that uses it.

### Imports

| Allowed | Example from `ReviewWorkbench/_components/ReviewCard/index.tsx` |
| --- | --- |
| A child, through its index | `./_components/CardHeader` |
| An ancestor's module | `../../types`, `../../useReviewDraft` |
| A component in an ancestor's `_components/` (a sibling or a promoted part), through its index | `../EvidenceRail` |
| Shared code | `@/shared/_components/CategoryIcon`, `@/shared/dates` |
| Packages | `react`, `@personal-budget/classification` |

| Forbidden | Example | Fix |
| --- | --- | --- |
| Reaching past another component's index | `../EvidenceRail/_components/BestGuess`, `../EvidenceRail/utils` | Promote the code you need. If it belongs to that component's API, re-export it from its `index.tsx`. |
| Importing from another slice | `pages/review` importing `pages/budget-setup/model` | Move that code to `src/shared/` or a workspace package. |
| `src/shared/` importing from `src/pages/` | `shared/AppLayout.tsx` importing `pages/review/navigation` | Move the code into `src/shared/`. |
| A child importing its parent's index | `CardHeader` importing `'../..'` (ReviewCard) | Pass props, or move the shared piece to the parent's `types.ts` or `utils.ts`. |

- Use relative paths inside one component subtree, up to `../../`. Use the `@/` alias for `src/shared` and for anything more than two `../` up.
- A folder that is copied between apps, such as the template's `AppShell/`, uses no alias, because each app roots it somewhere else. Keep its imports within two levels: put types at the level that uses them and pass values down as props, as `SidebarToggle` gets its shortcut label.
- The shell is shared code too: `src/_components/AppShell/` never imports from `src/pages/`. Only `src/App.tsx` imports pages.
- Next.js ships the `@/*` alias. In Vite, set it in both `tsconfig.json` and `vite.config.ts`:

```ts
// tsconfig.json: { "compilerOptions": { "paths": { "@/*": ["./src/*"] } } }
// vite.config.ts:
import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
});
```

The `'@'` key matches only `@` and `@/…`, so scoped packages such as `@personal-budget/classification` still resolve from `node_modules`. Bun reads the tsconfig `paths`; Vitest reads the Vite config.

### Size and splitting

- `index.tsx` renders one thing.
- Extract a child when the file passes ~150 lines, when a JSX region has its own name (header, row, picker, empty state), or when a region owns state.
- Split a hook past ~80 lines, or when it does two jobs.
- More than ~7 children in one `_components/` means that level does two jobs. Add an intermediate component that groups them. Depth is fine: the alias keeps imports short.

## Variants

### Vite + react-router

The [canonical tree](#canonical-tree) is the Vite shape. `App.tsx` is the only file that imports pages. It lazy-loads each `page.tsx` and nests the routes under one layout route, `src/_components/RouterShell/`, which renders `<AppShell>` around react-router's `<Outlet />`. The [template README](../templates/react-app-shell/README.md) shows `RouterShell` and its link adapter. The `@/` alias needs both config files ([Imports](#imports)).

```tsx
// src/App.tsx
const Review = lazy(() => import('./pages/review/page'));
const ReviewResults = lazy(() => import('./pages/review/results/page'));
<Route element={<RouterShell />}>  {/* src/_components/RouterShell: <AppShell …><Outlet /></AppShell> */}
  <Route path="review" element={<Review />} />
  <Route path="review/results" element={<ReviewResults />} />
</Route>
```

### Next.js app router

In Next.js, a folder whose name starts with `_` is a private folder: the router skips it. That is where the `_components/` convention comes from. A route group `(name)/` organizes routes without adding a URL segment.

```text
app/
  layout.tsx                          renders <RouterShell>; stays a server component
  _components/AppShell/               copied from the template
  _components/RouterShell/index.tsx   'use client': next/link, usePathname, <AppShell>
  (tracing)/                          route group, no URL segment
    _components/                      components used by 2+ routes in the group
    _lib/                             group modules and hooks: trace-utils.ts, useTraceEvents.ts
    traces/
      page.tsx
      _components/CallsList/index.tsx
      [callUuid]/
        page.tsx
        _components/
          TraceDetails/
            index.tsx
            _components/JsonView/index.tsx
          SwimLaneTimeline/
            index.tsx  constants.ts  types.ts  utils.ts
            _components/LaneHeader/index.tsx
shared/                               app-wide; replaces root components/ and lib/
  _components/PromptView/index.tsx    used by (tracing) and (prompts)
```

- `app/layout.tsx` renders `app/_components/RouterShell/`, a client component that wires `AppShell` to `next/link` and `usePathname` ([layout.md](layout.md), [template README](../templates/react-app-shell/README.md)).
- Each segment has its `page.tsx` and its `_components/`. A dynamic segment such as `[callUuid]/` has its own `_components/`.
- Code shared by the routes of one group goes to `app/(group)/_components/` and `app/(group)/_lib/`. Hooks go in `_lib/`; there is no `_hooks/`.
- App-wide shared code goes to `src/shared/`, or to root `shared/` in apps without `src/`. Not to root `components/` and `lib/`.
- Put `'use client'` only on components that need state, effects, event handlers or browser APIs. Everything a client component imports is client code already, so its children do not repeat the directive.

### Plain TypeScript DOM

A page without routes splits into regions, such as `left-sidebar/` and `right-sidebar/`. Each region is a slice: a kebab-case folder whose `index.ts` is its entry, the way `page.tsx` is for a route. The entry composes the region from its `_components/` and exports `render<Region>(root)` and `mount<Region>(root, deps)`.

Inside a region the component rules do not change, with `index.ts` in place of `index.tsx`. Every component is a PascalCase folder in a `_components/`, and its parts nest in its own `_components/`. A component folder exports `<Name>(props): string` for the markup. When the component is interactive, the same folder exports `mount<Name>(root: HTMLElement, deps): () => void`, which attaches behavior inside `root` and returns the cleanup.

```text
src/ui/
  right-sidebar/                      a slice: one region of the page
    index.ts                          entry: renderRightSidebar(panel), mountRightSidebar(panel, deps)
    _components/
      StatsBar/index.ts
      ColorSection/
        index.ts                      ColorSection(): string, mountColorSection(root, deps)
        _components/SwatchGrid/index.ts
  left-sidebar/
    index.ts                          entry: renderLeftSidebar(panel), mountLeftSidebar(panel, deps)
    _components/ActionButton/index.ts  …
  shared/                             code that 2+ regions use
    _components/ToggleField/index.ts
    styles.ts                         class strings used by 2+ components
```

- A parent's mount calls its children's mounts and returns one cleanup for all of them. The entry's mount does the same for the whole region. No central controller that finds every element by id.
- Class strings that one component uses stay in its folder. The shared `ui` map keeps only strings that two or more components use.

```ts
// src/ui/shared/_components/ToggleField/index.ts
import { ui } from '../../styles';

export type ToggleFieldProps = { label: string; setting: string };

export function ToggleField({ label, setting }: ToggleFieldProps): string {
  return `<label class="${ui.toggleField}">
    <input class="${ui.checkbox}" data-setting="${setting}" type="checkbox" /><span>${label}</span>
  </label>`;
}

export function mountToggleField(root: HTMLElement, deps: { onChange: (checked: boolean) => void }): () => void {
  const input = root.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  const onChange = () => deps.onChange(input.checked);
  input.addEventListener('change', onChange);
  return () => input.removeEventListener('change', onChange);
}
```

## Example: the budget review slice

`life/budget/apps/web/src/pages/review/` is the deepest tree in the reference apps.

### Today

```text
src/pages/review/                     24 files and _components/
  page.tsx                            renders _components/ReviewContent
  results.tsx  reconciliation.tsx  disagreements.tsx        sub-routes as sibling files
  model.ts  queue-model.ts  navigation.ts  suggest.ts  …     12 plain .ts modules
  use-classifier.ts  use-decisions.ts  use-review-hotkeys.ts
  review.css  review-cards.css  results.css  reconciliation.css  disagreements.css
  _components/
    ReviewContent.tsx                 205 lines; renders ReviewWorkbench and ReviewMonthPicker
    GroupedSelector.tsx  grouped-selector.css
    CategoryGuidance.tsx  DisagreementExplanation.tsx  ReviewDataset.tsx
    ReviewMonthPicker.tsx  UnresolvedCredits.tsx
    ReviewWorkbench/
      ReviewWorkbench.tsx  review-workbench.css  use-review-draft.ts
      _components/
        ReviewCard/
          ReviewCard.tsx  review-card.css
          _components/{CardActions,CardHeader,ClassificationPicker,ContextNote}/<Name>.tsx
        EvidenceRail/
          EvidenceRail.tsx  evidence-rail.css
          use-connector-history.ts  use-purchase-matches.ts
          connectors/index.ts  EvidenceConnector.ts  {amazon,merchant,venmo}/<Name>Connector.tsx
          _components/
            AmazonEvidence/AmazonEvidence.tsx
            AmazonEvidence/_components/OrderItem.tsx  OrderReceipt.tsx  OtherCandidates.tsx  PaymentFilter.tsx
            BestGuess/BestGuess.tsx  best-guess.css
            {HistorySection,MerchantEvidence,MoreDetails}/<Name>.tsx
            VenmoEvidence/VenmoEvidence.tsx
            VenmoEvidence/_components/FundingLink.tsx  PaymentNote.tsx
apps/web/tests/                       33 bun:test files for the whole app
```

### After

```text
src/
  _components/AppShell/               was shared/AppLayout.tsx and shared/sidebar.css
  shared/
    _components/CategoryIcon/         was shared/CategoryIcon.tsx and category-icon.css
    budget-setup.ts                   moved out of pages/budget-setup/model.ts
    review-navigation.ts              was pages/review/navigation.ts
  pages/review/
    page.tsx                          renders <ReviewContent />
    _lib/                             9 modules the whole slice uses
      model.ts  queue-model.ts  queue-prediction.ts  suggest.ts  classifier-run.ts
      category-guidance.ts  results-model.ts  useClassifier.ts  useDecisions.ts
    _components/
      ReviewContent/
        index.tsx  styles.css
        utils.ts  utils.test.ts       was hotkeys.ts, monthly-queue.ts, tests/review-hotkeys.test.ts
        useReviewHotkeys.ts           used by ReviewContent and useReviewDraft
        _components/
          ReviewMonthPicker/index.tsx
          ReviewWorkbench/
            index.tsx  styles.css     was ReviewWorkbench.tsx, review-workbench.css
            types.ts                  SelectGroup
            useReviewDraft.ts         was use-review-draft.ts
            utils.ts  utils.test.ts   was context-autosave.ts, tests/context-autosave.test.ts
            _components/
              ReviewCard/
                index.tsx  styles.css
                _components/
                  CardActions/  CardHeader/  ContextNote/
                  ClassificationPicker/
                    index.tsx
                    _components/GroupedSelector/index.tsx  styles.css
              EvidenceRail/
                index.tsx  index.test.tsx  styles.css
                useConnectorHistory.ts  usePurchaseMatches.ts
                connectors/
                  index.ts  index.test.ts  evidence-connector.ts
                  amazon-connector.tsx  merchant-connector.tsx  venmo-connector.tsx
                _components/
                  AmazonEvidence/
                    index.tsx
                    _components/
                      OrderReceipt/
                        index.tsx
                        _components/OrderItem/
                          index.tsx
                          _components/ProductImage/index.tsx
                      OtherCandidates/  PaymentFilter/
                  BestGuess/  HistorySection/  MerchantEvidence/  MoreDetails/
                  VenmoEvidence/
                    index.tsx
                    _components/FundingLink/  PaymentNote/
    results/
      page.tsx  styles.css            was results.tsx, results.css
      _components/ReviewDataset/
    reconciliation/
      page.tsx  styles.css  model.ts  was reconciliation.tsx, reconciliation.css, reconciliation-model.ts
      _components/UnresolvedCredits/  index.tsx, index.test.tsx
    disagreements/
      page.tsx  styles.css
      _components/CategoryGuidance/  DisagreementExplanation/
```

Why each move:

- `ReviewWorkbench` and `ReviewMonthPicker` go under `ReviewContent`, the only component that renders them. Components that only one sub-route renders go into that sub-route: `ReviewDataset`, `UnresolvedCredits`, `CategoryGuidance`, `DisagreementExplanation`.
- `GroupedSelector` goes down to `ClassificationPicker`, its only renderer, and `SelectGroup` goes to `ReviewWorkbench/types.ts`. `OrderItem` goes under `OrderReceipt`, its only renderer. `ProductImage`, the second component in `OrderItem.tsx`, gets its own folder.
- `navigation.ts` moves to `src/shared/` because the shell imports it. `reviewEntities` moves with it, out of `model.ts`.
- Other slices import `Category`, `BudgetSetup`, `parseSetup` and `storageKey` from `budget-setup/model.ts`. Those, and the helpers `parseSetup` calls, move to `src/shared/budget-setup.ts`. `accountCategories` and `categoryEvidence` stay, because only the budget-setup slice uses them. `spending/model.ts` needs the same split: `review/suggest.ts` and `budget-spend` import it.
- Stylesheets follow their markup. `review-cards.css` is imported by ReviewContent but styles classes from eight components (ReviewContent, ReviewMonthPicker, ReviewCard, CardHeader, ClassificationPicker, ContextNote, GroupedSelector, MoreDetails), so it splits by owner. `disagreements.tsx` also renders classes from `results.css` (`.classification-results`, `.results-run-picker`, `.results-amount`); that shared markup becomes one component in `review/_components/`.

## What the reference apps do today

Budget: `life/budget/apps/web`. Ops console: `clients/past/hey-bubba/bubba-phone/helper-applications/ops-console/frontend` (Next.js 14). Personal site: `lascari-ai/personal-site`.

| App | Today | Standard |
| --- | --- | --- |
| Budget | `<Name>/<Name>.tsx` (`ReviewWorkbench/ReviewWorkbench.tsx`), flat `_components/<Name>.tsx` (`review/_components/ReviewContent.tsx`, `accounts/_components/AccountGroups.tsx`), flat leaves (`AmazonEvidence/_components/OrderItem.tsx`) | `<Name>/index.tsx`, always a folder |
| Budget | Components at a slice root, outside `_components/`: `budget-spend/BudgetFlowChart.tsx`, `spending/FlowChart.tsx`, `special-rules/PersonalRules.tsx`, `connections/PurchaseSetup.tsx` | `<slice>/_components/<Name>/` |
| Budget | Mostly `export default function`; `EvidenceRail` and `VenmoEvidence` export both ways; `UnresolvedCredits` only by name. Props as `type` and as `interface` (`BestGuess`, `ReviewCard`, `CardHeader`) | Named export, `export type <Name>Props` |
| Budget | Kebab-case hook files: `use-review-draft.ts` exports `useReviewDraft` | `useReviewDraft.ts` |
| Budget | Stylesheets per component with kebab names (`review-workbench.css`), at slice roots (`review-cards.css` styles eight components), and one PascalCase sheet (`shared/BankTextDetails.css`) | `styles.css` in the owner's folder |
| Budget | 13 `review/` files import `pages/budget-setup/model`; `budget-spend` imports `budget-setup/model` and `spending/model`; `review/suggest.ts` imports `spending/model` | Shared parts move to `src/shared/` |
| Budget | Other slices' stylesheets: `ReviewContent.tsx` imports `accounts/transactions/_components/transactions.css`; `budget-setup/page.tsx` imports `accounts.css`; `budget-spend/page.tsx` imports `net-worth.css` and `spending.css` | Styles two slices use belong to a shared component |
| Budget | `shared/AppLayout.tsx` imports `pages/review/navigation`; `shared/processed-model.ts` imports a type from `pages/spending/model` | Shared never imports pages |
| Budget | The shell is `shared/AppLayout.tsx`. `src/shared/` is flat (9 `.tsx` files, no `_components/`). Domain modules sit at `src/` root: `entities.ts`, `transaction-model.ts`, `closed-accounts.ts`, `manual-accounts.ts` | `src/_components/AppShell/`, `src/shared/_components/`, modules in `src/shared/` |
| Budget | Routes in sibling files not named `page.tsx`: `review/{results,reconciliation,disagreements}.tsx`, `connections/{amazon,venmo}.tsx`, `kernel/{agents,traces}.tsx`, `config/firecrawl.tsx`, `special-rules/preview.tsx`. Only `accounts/transactions/` is a folder. `App.tsx` lazy-loads 12 routes and imports 8 eagerly | `<route>/page.tsx`, lazy-loaded |
| Budget | `review/` root holds 24 files: 4 routes, 15 modules, 5 stylesheets | `page.tsx`, `_components/`, `_lib/`, sub-route folders |
| Budget | Relative paths only. 68 imports climb more than two levels, up to nine (`OrderItem.tsx` to `shared/CategoryIcon`) | `@/` alias |
| Budget | 33 `bun:test` files in `apps/web/tests/`, outside the tsconfig `include` | Next to the file they test |
| Budget | `GroupedSelector` sits at `review/_components/` with one renderer. `OrderItem` sits beside `OrderReceipt`, its only consumer, and also defines `ProductImage` | Under the one consumer; one component per `index.tsx` |
| Ops console | Parents use `<Name>/index.tsx` (`TraceDetails/`, `SwimLaneTimeline/`); leaves are flat (`TraceDetails/_components/JsonView.tsx`) | Leaves are folders too |
| Ops console | `Lane.tsx` exports `LaneHeader`; `TimelineRuler.tsx` and `EventRow.tsx` define two components each | One component per folder, same name |
| Ops console | Constants in `SwimLaneTimeline/types.ts` (`LANES`, `PIXELS_PER_SECOND`); `ColumnWidthSelector.tsx` exports `COLUMN_WIDTH_CLASSES` for `page.tsx` | `constants.ts` at the nearest common ancestor |
| Ops console | Category folder `[callUuid]/_components/timelines/` | PascalCase component folders only |
| Ops console | `(tracing)/_hooks/useTraceEvents.ts` (imported as `@/app/(tracing)/_hooks/useTraceEvents`) beside `(tracing)/_lib/` (imported as `@/tracing/*`) | Hooks in `_lib/` |
| Ops console | `'use client'` in 21 of 23 `.tsx` files in `(tracing)`, both pages included; 17 with double quotes, 4 with single | Only where needed |
| Ops console | `TraceDetails/_components/CopyButton.tsx` and `PromptView.tsx` are one-line re-exports of root `components/`; app-wide code in root `components/` and `lib/utils.ts` | Import from `shared/` directly |
| Ops console | Never rendered: `timelines/TraceTimeline.tsx` (480 lines), `TraceLevelSlider.tsx`, `TimelineGranularitySlider.tsx`, the `ColumnWidthSelector` component | Delete |
| Ops console | `(evaluations)` keeps kebab-case component files beside `page.tsx`: `runs/filter-bar.tsx`, `runs/[id]/run-detail-body.tsx` (1,282 lines) | `_components/<Name>/index.tsx`, split |
| Personal site | Flat `_components/<Name>.ts`; `right-sidebar/_components/` holds 13 components | `<Name>/index.ts`; group past ~7 |
| Personal site | `ui/Controls.ts` (542 lines) renders both sidebars, then finds elements by id: `#instance-count` is written in `StatsBar.ts` | `mount<Name>` in the component's folder |
| Personal site | `ui/landing/` and `ui/logo-lab/` have no `_components/` and build DOM with `document.createElement` | Same folder rules |
| Personal site | PascalCase non-component files: `ui/Controls.ts`, `ui/Presets.ts` | kebab-case |

## Migrating a flat app

Move one slice per commit. Before each commit, run the typecheck and the tests.

1. Add the `@/` alias ([Imports](#imports)). Rewrite imports of `src/shared` and imports that climb more than two levels to `@/`. Check 2 in the [Checklist](#checklist) lists them.
2. Move shared components: `git mv src/shared/<Name>.tsx src/shared/_components/<Name>/index.tsx`, and its stylesheet to `styles.css` beside it. Then point importers at the new path: `perl -pi -e "s#@/shared/([A-Z][A-Za-z0-9]*)(['\"])#@/shared/_components/\1\2#g"` over `src`.
3. In one slice, make every component a folder with an `index.tsx` (script A).
4. Switch the slice's components to named exports (script B). tsc lists every import to fix.
5. Colocate. Each component's stylesheet becomes its `styles.css`. Hook files become `useX.ts` (script C). Tests move next to the file they test.
6. Turn sub-route files into folders: `mkdir -p src/pages/review/results && git mv src/pages/review/results.tsx src/pages/review/results/page.tsx`. Update the `lazy()` import in `App.tsx`. Add one `../` to the moved file's relative imports with the `perl` line from script A.
7. Move modules that other slices import into `src/shared/` or a workspace package.
8. Typecheck, test, commit. Start the next slice.

Script A: `<Name>/<Name>.tsx` and flat `_components/<Name>.tsx` become `<Name>/index.tsx`.

```sh
slice=src/pages/review
# <Name>/<Name>.tsx -> <Name>/index.tsx, then './_components/ReviewCard/ReviewCard' -> './_components/ReviewCard'
find "$slice" -type f -name '*.tsx' | while read -r f; do
  dir=$(dirname "$f")
  if [ "$(basename "$dir")" = "$(basename "$f" .tsx)" ]; then git mv "$f" "$dir/index.tsx"; fi
done
find "$slice" tests -type f \( -name '*.ts' -o -name '*.tsx' \) -exec perl -pi -e "s#/([A-Z][A-Za-z0-9]+)/\1(['\"])#/\1\2#g" {} +
# Flat _components/<Name>.tsx -> _components/<Name>/index.tsx. Importers keep working unchanged.
find "$slice" -type f -path '*/_components/*' -name '[A-Z]*.tsx' | while read -r f; do
  [ "$(basename "$(dirname "$f")")" = _components ] || continue
  mkdir -p "${f%.tsx}" && git mv "$f" "${f%.tsx}/index.tsx"
  # The file is one level deeper now: add one ../ to each of its relative specifiers
  perl -pi -e 's#(["\x27])\.\./#$1../../#g; s#(["\x27])\./#$1../#g' "${f%.tsx}/index.tsx"
done
```

Script B: named exports. `page.tsx` files keep their default export.

```sh
find "$slice" -path '*/_components/*' -name index.tsx -exec perl -ni -e \
  'next if /^export default [A-Z]\w*;\s*$/; s/^export default function ([A-Z]\w*)/export function $1/; print' {} +
npx tsc --noEmit   # each "has no default export" error is an import to rewrite as { Name }
```

Script C: hook files, for the whole app in one commit, because slices import shared hooks too.

```sh
find src -name 'use-*.ts' | while read -r f; do
  git mv "$f" "$(dirname "$f")/$(basename "$f" .ts | perl -pe 's/-(\w)/\u$1/g').ts"
done
find src tests -type f \( -name '*.ts' -o -name '*.tsx' \) -exec perl -pi -e \
  's#/use-([a-z0-9-]+)(["\x27])#"/use" . join("", map { ucfirst } split /-/, $1) . $2#ge' {} +
```

Notes for the budget app:

- `apps/web/tsconfig.json` includes only `src` and sets `"types": ["vite/client"]`. tsc does not see `tests/` today, so run `bun test` after every script. Colocated tests import `bun:test`: add `@types/bun` to the app and `"bun"` to `types` in the commit that moves the first test.
- Three test files use `bun:test`'s `mock.module('../src/…')`. tsc does not check those strings. Update them when their target moves.
- The root `test:classification` script lists test paths under `apps/web/tests/`. Update it when those tests move.
