import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { Glob } from "bun";

// Every code link in docs/ is a span whose attributes.reference is { kind: "source", path, symbol?, line? }.
// The path must exist. A symbol must name exactly one place in the file: a declaration
// (function, const, let, class, interface, type, enum) or an anchor comment such as
// `// --- R-contrast ---`, `// S-outline-none` or `// Column: ...`. A line link must also
// carry a symbol, and that line must still contain it, so a code edit that moves the line fails here.

const ROOT = join(import.meta.dir, "..");
const DOCS = join(ROOT, "docs");

type SourceRef = { kind: "source"; path: string; symbol?: string; line?: number };
type Link = { page: string; text: string; ref: SourceRef };

function collect(node: unknown, page: string, out: Link[]): void {
  if (Array.isArray(node)) {
    for (const child of node) collect(child, page, out);
    return;
  }
  if (!node || typeof node !== "object") return;
  const span = node as { insert?: unknown; attributes?: { reference?: { kind?: unknown } } };
  if (typeof span.insert === "string" && span.attributes?.reference?.kind === "source") {
    out.push({ page, text: span.insert, ref: span.attributes.reference as SourceRef });
  }
  for (const value of Object.values(node)) collect(value, page, out);
}

function sourceLinks(): Link[] {
  const links: Link[] = [];
  for (const file of new Glob("**/doc.json").scanSync(DOCS)) {
    collect(JSON.parse(readFileSync(join(DOCS, file), "utf8")), relative(ROOT, join(DOCS, file)), links);
  }
  return links;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The 1-based lines where `symbol` is declared or names an anchor comment. */
function symbolLines(lines: string[], symbol: string): number[] {
  const s = escape(symbol);
  const declaration = new RegExp(
    `^\\s*(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?(?:function\\*?|const|let|var|class|interface|type|enum)\\s+${s}(?![\\w$])`,
  );
  const anchor = new RegExp(`^\\s*//\\s*(?:-{3}\\s+)?${s}(?:\\s*$|:|\\s+-{3})`);
  return lines.flatMap((line, i) => (declaration.test(line) || anchor.test(line) ? [i + 1] : []));
}

const links = sourceLinks();

describe("design-score docs code links", () => {
  test("the docs hold code links", () => {
    expect(links.length).toBeGreaterThan(100);
  });

  test.each(links.map((l) => [`${l.page} "${l.text}" -> ${l.ref.path}${l.ref.symbol ? `#${l.ref.symbol}` : ""}${l.ref.line ? `:${l.ref.line}` : ""}`, l] as const))(
    "%s",
    (_name, { ref }) => {
      const abs = join(ROOT, ref.path);
      expect(existsSync(abs), `${ref.path} does not exist`).toBe(true);
      if (ref.symbol === undefined && ref.line === undefined) return;

      expect(statSync(abs).isFile(), `${ref.path} is a folder, but the link names a symbol or line`).toBe(true);
      const lines = readFileSync(abs, "utf8").split("\n");
      expect(ref.symbol, `a line link must name a symbol that the line holds`).toBeString();
      const symbol = ref.symbol!;

      if (ref.line !== undefined) {
        const text = lines[ref.line - 1];
        expect(text, `${ref.path}:${ref.line} is past the end of the file`).toBeString();
        expect(text!.includes(symbol), `${ref.path}:${ref.line} no longer holds "${symbol}": ${text!.trim()}`).toBe(true);
        return;
      }

      const found = symbolLines(lines, symbol);
      expect(found, `"${symbol}" must be declared, or name an anchor comment, exactly once in ${ref.path}`).toHaveLength(1);
    },
  );
});
