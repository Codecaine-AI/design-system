/**
 * Shared test helpers: read package files and evaluate the generated CSS the way a browser would.
 *
 * The CSS parser accepts exactly what the build writes (flat blocks of declarations, plus comments)
 * and throws on anything else, so a format change fails loudly instead of slipping past a test.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Package root. */
export const PKG = join(import.meta.dir, "..");

export const THEMES = ["light", "dark"] as const;
export type Theme = (typeof THEMES)[number];

/** Selectors of the three blocks of dist/css/tokens.css, in the order they must appear. */
export const SELECTORS = {
  root: ":root",
  light: ':root, [data-theme="light"], .light',
  dark: '[data-theme="dark"], .dark',
} as const;

export function readText(path: string): string {
  return readFileSync(join(PKG, path), "utf8");
}

/** Parsed JSON; the assertions check its shape. */
export function readJson(path: string): any {
  return JSON.parse(readText(path));
}

/** The documented naming rule: "--ds-", an optional theme, then the path with dots as hyphens. */
export function cssVarOf(path: string, theme?: string): string {
  return `--ds-${theme ? `${theme}-` : ""}${path.split(".").join("-")}`;
}

export interface CssBlock {
  /** Selector or at-rule prelude, whitespace collapsed. */
  prelude: string;
  declarations: Array<[property: string, value: string]>;
}

/** Splits a block body at top-level semicolons (outside quotes and parentheses) into [property, value]. */
function splitDeclarations(body: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  let depth = 0;
  let quote = "";
  let current = "";
  const flush = () => {
    const text = current.trim();
    current = "";
    if (!text) return;
    const colon = text.indexOf(":");
    out.push(colon === -1 ? [text, ""] : [text.slice(0, colon).trim(), text.slice(colon + 1).trim()]);
  };
  for (const ch of body) {
    if (quote) {
      if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "(") {
      depth++;
    } else if (ch === ")") {
      depth--;
    } else if (ch === ";" && depth === 0) {
      flush();
      continue;
    }
    current += ch;
  }
  flush();
  return out;
}

const BLOCK_RE = /([^{}]+)\{([^{}]*)\}/g;

/** Parses a stylesheet of flat `prelude { declarations }` blocks. Throws on a statement outside a block or nesting. */
export function parseCss(css: string): CssBlock[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const blocks = [...text.matchAll(BLOCK_RE)].map(([, prelude, body]) => ({
    prelude: prelude.trim().replace(/\s+/g, " "),
    declarations: splitDeclarations(body),
  }));
  // Text before a block lands in its prelude; a semicolon there means a stray statement.
  const stray = text.replace(BLOCK_RE, "").trim() || blocks.find((b) => b.prelude.includes(";"))?.prelude;
  if (stray) throw new Error(`CSS outside a flat block: ${stray.slice(0, 160)}`);
  return blocks;
}

const STATEMENT_RE = /@[a-z-]+\b[^;{}]*;/g;

/** parseCss, plus top-level at-rule statements (`@custom-variant dark (...);`), whitespace collapsed. */
export function parseStylesheet(css: string): { blocks: CssBlock[]; statements: string[] } {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const statements = [...text.matchAll(STATEMENT_RE)].map((m) => m[0].replace(/\s+/g, " ").trim());
  return { blocks: parseCss(text.replace(STATEMENT_RE, "")), statements };
}

export interface TokensCss {
  blocks: CssBlock[];
  /** Declarations of the `:root` block: base and theme-pinned variables. */
  root: Map<string, string>;
  /** Declarations of each theme switch block. */
  light: Map<string, string>;
  dark: Map<string, string>;
}

let tokensCssCache: TokensCss | undefined;

/** dist/css/tokens.css, parsed. Read-only, so one parse serves every test. */
export function tokensCss(): TokensCss {
  if (tokensCssCache) return tokensCssCache;
  const blocks = parseCss(readText("dist/css/tokens.css"));
  const block = (selector: string) => {
    const found = blocks.filter((b) => b.prelude === selector);
    if (found.length !== 1) throw new Error(`dist/css/tokens.css has ${found.length} "${selector}" blocks, expected 1`);
    return new Map(found[0].declarations);
  };
  tokensCssCache = { blocks, root: block(SELECTORS.root), light: block(SELECTORS.light), dark: block(SELECTORS.dark) };
  return tokensCssCache;
}

/** Every custom property declared anywhere in dist/css/tokens.css. */
export function declaredVars(): Set<string> {
  return new Set(tokensCss().blocks.flatMap((b) => b.declarations.map(([property]) => property)));
}

/** Names of the `var(--ds-*)` references in a text. */
export function varRefs(text: string): Set<string> {
  return new Set([...text.matchAll(/var\(\s*(--ds-[a-z0-9-]+)/g)].map((m) => m[1]));
}

const VAR_RE = /var\(\s*(--[a-z0-9-]+)\s*\)/g;

/**
 * Computed value of a custom property, substituting var() references the way a browser does.
 * `scope` holds the declarations on the element; a name not declared there comes from `inherit`,
 * and without `inherit` an undeclared name throws.
 */
function computeVar(name: string, scope: Map<string, string>, inherit?: (name: string) => string, chain: string[] = []): string {
  if (chain.includes(name)) throw new Error(`var() cycle: ${[...chain, name].join(" -> ")}`);
  const raw = scope.get(name);
  if (raw === undefined) {
    if (inherit) return inherit(name);
    throw new Error(`${name} is not declared`);
  }
  return raw.replace(VAR_RE, (_, ref: string) => computeVar(ref, scope, inherit, [...chain, name]));
}

/**
 * Value of a base or theme-pinned variable. Computed from the `:root` block alone: a pinned value must not
 * depend on which theme block applies, so a reference to a theme-following name throws here.
 */
export function computePinned(css: TokensCss, name: string): string {
  return computeVar(name, css.root);
}

/** Value of a theme-following `--ds-*` variable inside a `data-theme` region: its block, the rest inherited from `:root`. */
export function computeInTheme(css: TokensCss, theme: Theme, name: string): string {
  return computeVar(name, css[theme], (ref) => computePinned(css, ref));
}
