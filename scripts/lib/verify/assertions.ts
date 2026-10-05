/**
 * The assertion record every verify:apps check returns, and the page's response log.
 */

export type Status = "pass" | "fail" | "n/a";

export interface Assertion {
  id: string;
  status: Status;
  message: string;
  detail?: Record<string, unknown>;
}

export const pass = (id: string, message: string, detail?: Record<string, unknown>): Assertion => ({ id, status: "pass", message, detail });
export const fail = (id: string, message: string, detail?: Record<string, unknown>): Assertion => ({ id, status: "fail", message, detail });
export const na = (id: string, message: string, detail?: Record<string, unknown>): Assertion => ({ id, status: "n/a", message, detail });

/** Responses the page received: URL → HTTP status. Filled by `trackResponses`. */
export type ResponseLog = Map<string, number>;

export function trackResponses(page: any): ResponseLog {
  const log: ResponseLog = new Map();
  page.on("response", (response: any) => log.set(response.url(), response.status()));
  page.on("requestfailed", (request: any) => {
    if (!log.has(request.url())) log.set(request.url(), 0);
  });
  return log;
}
