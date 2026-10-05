/**
 * The assertion record every verify:apps check returns, and the page's response log.
 */

/** warn is reported but never fails the app. */
export type Status = "pass" | "fail" | "warn" | "n/a";

export interface Assertion {
  id: string;
  status: Status;
  message: string;
  detail?: Record<string, unknown>;
}

export const pass = (id: string, message: string, detail?: Record<string, unknown>): Assertion => ({ id, status: "pass", message, detail });
export const fail = (id: string, message: string, detail?: Record<string, unknown>): Assertion => ({ id, status: "fail", message, detail });
export const warn = (id: string, message: string, detail?: Record<string, unknown>): Assertion => ({ id, status: "warn", message, detail });
export const na = (id: string, message: string, detail?: Record<string, unknown>): Assertion => ({ id, status: "n/a", message, detail });

/** A response the page received: HTTP status (0 when the request failed) and Playwright's resource type. */
export interface ResponseEntry {
  status: number;
  type: string;
}

/** Responses the page received, by URL. Filled by `trackResponses`. */
export type ResponseLog = Map<string, ResponseEntry>;

export function trackResponses(page: any): ResponseLog {
  const log: ResponseLog = new Map();
  page.on("response", (response: any) => log.set(response.url(), { status: response.status(), type: response.request().resourceType() }));
  page.on("requestfailed", (request: any) => {
    if (!log.has(request.url())) log.set(request.url(), { status: 0, type: request.resourceType() });
  });
  return log;
}
