/**
 * The personal-site fixture serves the app's pages read-only: every write method is refused, and the
 * paths the app's vite.config.ts would generate into the checkout (blog, sitemap, robots) answer 404
 * instead of serving stale output from an earlier run, however the request spells them. A target the
 * guard cannot read one way (protocol-relative, an encoded slash or backslash, a bad escape) answers
 * 400 rather than reaching Vite.
 */
import { expect, test } from "bun:test";

import { readOnlyGuard } from "../apps/fixtures/personal-site/serve.ts";

function request(method: string, url: string) {
  const res = { status: 0, writeHead(status: number) { this.status = status; }, end() {} };
  let passed = false;
  readOnlyGuard()({ method, url }, res, () => (passed = true));
  return passed ? "next" : res.status;
}

test.each([
  // Writes.
  ["POST", "/__dev-content-edit", 405],
  ["PUT", "/about/", 405],
  // Generated output.
  ["GET", "/blog/", 404],
  ["GET", "/blog/drafts/__docs/api/tree", 404],
  ["GET", "/sitemap.xml", 404],
  ["HEAD", "/robots.txt", 404],
  // Generated output spelled another way: dot segments, case (APFS), encoded letters or slashes.
  ["GET", "/x/../blog/x/", 404],
  ["GET", "/x/%2E%2E/blog/", 404],
  ["GET", "/BLOG/x/", 404],
  ["GET", "/Blog", 404],
  ["GET", "/%62log/x/", 404],
  ["GET", "/blog%2Fx", 404],
  // Ambiguous targets: a URL parser reads //blog/ as host "blog"; %2F and %5C decode to // and \.
  ["GET", "//blog/x/", 400],
  ["GET", "///blog/", 400],
  ["GET", "/a//b", 400],
  ["GET", "/%2Fblog/x/", 400],
  ["GET", "/%2fblog/x/", 400],
  ["GET", "/%5Cblog/", 400],
  ["GET", "/\\blog/x/", 400],
  ["GET", "http://fixture/blog/x/", 400],
  ["GET", "/%E0%A4%A", 400],
  // Content pages and assets reach Vite.
  ["GET", "/about/", "next"],
  ["GET", "/src/site/styles.css?direct", "next"],
  ["GET", "/about/?next=//x", "next"],
  ["HEAD", "/blog-style.css", "next"],
])("personal-site fixture guard: %s %s answers %p", (method, url, expected) => {
  expect(request(method, url)).toBe(expected);
});
