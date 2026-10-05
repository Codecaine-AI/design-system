/**
 * loadModel rejects every class of token error the README promises the build fails on.
 * Each case mutates a copy of one valid fixture and expects a problem naming the class and the token,
 * so a case cannot pass because some other rule happened to fire.
 */
import { describe, expect, test } from "bun:test";
import { loadModel, type Sources, TokenError } from "../scripts/build.ts";

type Json = Record<string, any>;

const token = (type: string, value: string | number) => ({ $type: type, $value: value });

function theme(page: string, panel: string, ink: string, accent: string, link: string): Json {
  return {
    color: {
      surface: { page: token("color", page), panel: token("color", panel) },
      text: { ink: token("color", ink) },
      accent: token("color", accent),
      link: token("color", link),
      "focus-ring": token("color", "{color.accent}"),
      fill: { hover: token("color", "color-mix(in srgb, {color.text.ink} 6%, {color.surface.panel})") },
    },
    // A theme token may embed a base dimension.
    shadow: { card: token("shadow", "0 {space.1} 8px rgba(0, 0, 0, 0.1)") },
  };
}

/** Two base files and both themes with identical keys; whole and embedded aliases in base and in themes. */
const VALID: Sources = {
  base: [
    { file: "tokens/base/motion.tokens.json", json: { motion: { duration: { fast: token("duration", "100ms") } } } },
    {
      file: "tokens/base/space.tokens.json",
      json: {
        space: { "1": token("dimension", "4px"), "2": token("dimension", "8px") },
        radius: { base: token("dimension", "{space.1}") },
      },
    },
  ],
  themes: [
    { file: "tokens/themes/dark.tokens.json", json: theme("#0d1117", "#151b23", "#f0f6fc", "#4493f8", "#4493f8") },
    { file: "tokens/themes/light.tokens.json", json: theme("#fdfdfd", "#f8f8f7", "#1f1f1f", "#0078df", "#245a81") },
  ],
};

/** The JSON of a fixture file, by name: "space", "motion", "light" or "dark". */
function source(sources: Sources, name: string): Json {
  const found = [...sources.base, ...sources.themes].find((f) => f.file.endsWith(`/${name}.tokens.json`));
  if (!found) throw new Error(`fixture has no ${name}.tokens.json`);
  return found.json as Json;
}

/** The node at a dotted path inside a fixture file. */
function node(sources: Sources, name: string, path: string): Json {
  return path.split(".").reduce((n: Json, key) => n[key], source(sources, name));
}

/** The problems loadModel reports; fails the test when it accepts the sources. */
function problemsOf(sources: Sources): string[] {
  try {
    loadModel(sources);
  } catch (error) {
    if (error instanceof TokenError) return error.problems;
    throw error;
  }
  throw new Error("loadModel accepted the sources");
}

/** An "alias cycle" problem naming every id, in whatever order the cycle is reported. */
const cycle = (...ids: string[]) =>
  new RegExp(`alias cycle\\b${ids.map((id) => `(?=.*${id.replace(/\./g, "\\.")}\\b)`).join("")}`);

const invalidLink = (value: string, reason: RegExp): [string, (s: Sources) => void, RegExp] => [
  `invalid color ${value}`,
  (s) => {
    node(s, "light", "color.link").$value = value;
  },
  new RegExp(`color\\.link\\b.*invalid color.*${reason.source}`),
];

const invalidShadow = (value: string, reason: RegExp): [string, (s: Sources) => void, RegExp] => [
  `invalid shadow ${value}`,
  (s) => {
    node(s, "light", "shadow.card").$value = value;
  },
  new RegExp(`shadow\\.card\\b.*invalid shadow.*${reason.source}`),
];

const CASES: Array<[name: string, mutate: (s: Sources) => void, problem: RegExp]> = [
  [
    "unresolved alias in a theme",
    (s) => {
      node(s, "light", "color.focus-ring").$value = "{color.missing}";
    },
    /color\.focus-ring\b.*unresolved alias \{color\.missing\}/,
  ],
  [
    "unresolved alias in base",
    (s) => {
      node(s, "space", "radius.base").$value = "{space.9}";
    },
    /radius\.base\b.*unresolved alias \{space\.9\}/,
  ],
  [
    "base token referencing a theme token",
    (s) => {
      source(s, "space").outline = { color: token("color", "{color.accent}") };
    },
    /outline\.color\b.*unresolved alias \{color\.accent\}.*theme tokens/,
  ],
  [
    "alias cycle a -> b -> a",
    (s) => {
      Object.assign(node(s, "space", "space"), { a: token("dimension", "{space.b}"), b: token("dimension", "{space.a}") });
    },
    cycle("space.a", "space.b"),
  ],
  [
    "alias cycle through an embedded alias",
    (s) => {
      node(s, "light", "color.text.ink").$value = "color-mix(in srgb, {color.fill.hover} 50%, #000000)";
    },
    cycle("color.text.ink", "color.fill.hover"),
  ],
  [
    "missing $type",
    (s) => {
      delete node(s, "motion", "motion.duration.fast").$type;
    },
    /motion\.duration\.fast\b.*missing \$type/,
  ],
  [
    "missing $value",
    (s) => {
      delete node(s, "space", "space.2").$value;
    },
    /space\.2\b.*missing \$value/,
  ],
  [
    "unknown $type",
    (s) => {
      node(s, "space", "space.2").$type = "size";
    },
    /space\.2\b.*unknown \$type.*"size"/,
  ],
  [
    "key missing in dark",
    (s) => {
      delete node(s, "dark", "color").link;
    },
    /color\.link\b.*missing from dark/,
  ],
  [
    "extra key in dark",
    (s) => {
      node(s, "dark", "color").extra = token("color", "#000000");
    },
    /color\.extra\b.*missing from light/,
  ],
  [
    "type mismatch between themes",
    (s) => {
      node(s, "dark", "color").link = token("dimension", "4px");
    },
    /color\.link\b.*color in light.*dimension in dark/,
  ],
  [
    "duplicate leaf path across two base files",
    (s) => {
      source(s, "motion").space = { "1": token("dimension", "4px") };
    },
    /duplicate path space\.1\b(?=.*motion\.tokens\.json)(?=.*space\.tokens\.json)/,
  ],
  [
    "a path that is a token in one file and a group in another",
    (s) => {
      source(s, "motion").space = { "2": { half: token("dimension", "4px") } };
    },
    /duplicate path space\.2\b.*\bgroup\b/,
  ],
  [
    "a theme path nested under a base token",
    (s) => {
      source(s, "light").space = { "1": { x: token("dimension", "4px") } };
    },
    /duplicate path space\.1\.x\b.*tokens\/base/,
  ],
  [
    "two paths producing one CSS variable (a.b-c and a.b.c)",
    (s) => {
      source(s, "space").motion = { "duration-fast": token("duration", "100ms") };
    },
    /CSS variable --ds-motion-duration-fast\b/,
  ],
  [
    "a base path colliding with a dark-pinned variable (dark.color.link and color.link)",
    (s) => {
      source(s, "space").dark = { color: { link: token("color", "#000000") } };
    },
    /CSS variable --ds-dark-color-link\b/,
  ],
  invalidLink("#245A81", /lowercase/),
  invalidLink("#fff", /"#fff"/),
  invalidLink("bluish", /"bluish"/),
  invalidLink("rgb(36, 90, 129)", /opaque/),
  // The build suggests the exact hex for an alpha that is exact in 8 bits.
  invalidLink("rgba(0, 0, 0, 0.2)", /"#00000033"/),
  invalidLink("rgba(0, 0, 0, 0.4)", /"#00000066"/),
  invalidShadow("8px rgba(0, 0, 0, 0.1)", /2 to 4 lengths.*got 1/),
  invalidShadow("0 1px 2px 3px 4px rgba(0, 0, 0, 0.1)", /2 to 4 lengths.*got 5/),
  invalidShadow("0 1px 8 #00000033", /"8" is not a length/),
  invalidShadow("0 1px #00000033 2px", /adjacent/),
  invalidShadow("0 1px -2px #00000033", /blur -2px is negative/),
  invalidShadow("0 1px 2px glow", /"glow" is not a valid color/),
  invalidShadow("0 1px 2px #FFFFFF", /lowercase/),
  invalidShadow("0 1px 2px #00000033 #ffffff33", /2 colors/),
  invalidShadow("inset inset 0 1px #00000033", /repeats inset/),
  invalidShadow("0 1px 2px #00000033,", /layer 2 .*is empty/),
  invalidShadow("none, 0 1px 2px #00000033", /"none" must be the whole value/),
  [
    "invalid color inside color-mix",
    (s) => {
      node(s, "light", "color.fill.hover").$value = "color-mix(in srgb, {color.text.ink} 6%, #12345)";
    },
    /color\.fill\.hover\b.*invalid color.*color-mix.*"#12345"/,
  ],
  [
    "alias to a token of another type",
    (s) => {
      node(s, "light", "color.focus-ring").$value = "{space.1}";
    },
    /color\.focus-ring\b.*\{space\.1\} is a dimension/,
  ],
  [
    "embedded alias to a token of another type",
    (s) => {
      node(s, "light", "color.fill.hover").$value = "color-mix(in srgb, {space.1} 6%, {color.surface.panel})";
    },
    /color\.fill\.hover\b.*\{space\.1\} is a dimension/,
  ],
  [
    "only the light theme file",
    (s) => {
      s.themes = s.themes.filter((f) => f.file.endsWith("/light.tokens.json"));
    },
    /missing theme file tokens\/themes\/dark\.tokens\.json/,
  ],
];

describe("loadModel", () => {
  test("accepts the valid fixture and resolves whole, embedded and theme-to-base aliases", () => {
    const model = loadModel(structuredClone(VALID));
    expect(model.resolved.base.get("radius.base")).toBe("4px");
    expect(model.resolved.theme.dark.get("color.focus-ring")).toBe("#4493f8");
    expect(model.resolved.theme.light.get("color.fill.hover")).toBe("color-mix(in srgb, #1f1f1f 6%, #f8f8f7)");
    expect(model.resolved.theme.light.get("shadow.card")).toBe("0 4px 8px rgba(0, 0, 0, 0.1)");
  });

  test.each(CASES)("rejects %s", (_, mutate, problem) => {
    const sources = structuredClone(VALID);
    mutate(sources);
    expect(problemsOf(sources)).toContainEqual(expect.stringMatching(problem));
  });

  test.each([
    "none",
    "0 1px 2px",
    "inset 0 0 0 1px #00000014",
    "#00000014 0 0 0 1px inset",
    "0 0 0 calc(1px + 1px) currentcolor",
    "0 {space.1} 8px rgba(0, 0, 0, 0.1), inset 0 1px 0 color-mix(in srgb, #ffffff 10%, transparent)",
  ])("accepts the shadow %s", (value) => {
    const sources = structuredClone(VALID);
    for (const theme of ["light", "dark"]) node(sources, theme, "shadow.card").$value = value;
    expect(() => loadModel(sources)).not.toThrow();
  });

  test("reports every problem in one error instead of stopping at the first", () => {
    const sources = structuredClone(VALID);
    node(sources, "light", "color.link").$value = "#FFF";
    delete node(sources, "space", "space.2").$type;
    const problems = problemsOf(sources);
    expect(problems).toContainEqual(expect.stringMatching(/color\.link\b.*invalid color/));
    expect(problems).toContainEqual(expect.stringMatching(/space\.2\b.*missing \$type/));
  });
});
