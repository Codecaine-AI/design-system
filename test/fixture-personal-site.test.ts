/**
 * The personal-site fixture serves the app's pages read-only: every write method is refused, and the
 * paths the app's vite.config.ts would generate into the checkout (blog, sitemap, robots) answer 404
 * instead of serving stale output from an earlier run.
 */
import { describe, expect, test } from "bun:test";

import { readOnlyGuard } from "../apps/fixtures/personal-site/serve.ts";

function request(method: string, url: string) {
  const res = { status: 0, writeHead(status: number) { this.status = status; }, end() {} };
  let passed = false;
  readOnlyGuard()({ method, url }, res, () => (passed = true));
  return passed ? "next" : res.status;
}

describe("personal-site fixture guard", () => {
  test.each([
    ["POST", "/__dev-content-edit", 405],
    ["PUT", "/about/", 405],
    ["GET", "/blog/", 404],
    ["GET", "/blog/drafts/__docs/api/tree", 404],
    ["GET", "/sitemap.xml", 404],
    ["HEAD", "/robots.txt", 404],
  ])("%s %s answers %d", (method, url, status) => {
    expect(request(method, url)).toBe(status);
  });

  test("passes content pages and assets to Vite", () => {
    expect(request("GET", "/about/")).toBe("next");
    expect(request("GET", "/src/site/styles.css?direct")).toBe("next");
    expect(request("HEAD", "/blog-style.css")).toBe("next");
  });
});
