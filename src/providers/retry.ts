/**
 * Resilient fetch with retry + backoff for transient provider failures
 * (429, 5xx, network errors). 4xx errors other than 429 are not retried.
 */

import { ToolError } from "@/shared/errors";

export interface RetryOptions {
  attempts: number;
  /** Base delays between attempts (ms). */
  backoffMs: number[];
  /** Outer abort signal — cancels all attempts. */
  signal?: AbortSignal;
}

export class AbortError extends Error {
  constructor() {
    super("Aborted");
    this.name = "AbortError";
  }
}

export interface FetchTimeoutOptions extends RetryOptions {
  /** Per-attempt timeout in ms; 0 disables. */
  timeoutMs?: number;
}

export async function retryFetch(
  url: string,
  init: RequestInit,
  opts: FetchTimeoutOptions,
): Promise<Response> {
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < opts.attempts; attempt++) {
    if (opts.signal?.aborted) throw new AbortError();

    const controller = new AbortController();
    const onOuterAbort = () => controller.abort();
    opts.signal?.addEventListener("abort", onOuterAbort, { once: true });
    const timeoutId = opts.timeoutMs ? setTimeout(() => controller.abort(), opts.timeoutMs) : undefined;

    try {
      const res = await fetch(url, { ...init, signal: controller.signal });
      if (res.status === 429 || res.status >= 500) {
        if (attempt < opts.attempts - 1) {
          const retryAfter = Number(res.headers.get("retry-after"));
          const delay = Number.isFinite(retryAfter) ? retryAfter * 1000 : opts.backoffMs[attempt] ?? 1000;
          await delayWithAbort(delay, opts.signal);
          continue;
        }
        throw new ToolError("PROVIDER_ERROR", `Provider returned HTTP ${res.status}`, { retryable: res.status === 429 || res.status >= 500 });
      }
      return res;
    } catch (err) {
      if (opts.signal?.aborted || (err instanceof DOMException && err.name === "AbortError") || err instanceof AbortError) {
        throw new AbortError();
      }
      lastErr = err instanceof Error ? err : new Error(String(err));
      if (attempt < opts.attempts - 1) {
        await delayWithAbort(opts.backoffMs[attempt] ?? 1000, opts.signal);
      }
    } finally {
      clearTimeout(timeoutId);
      opts.signal?.removeEventListener("abort", onOuterAbort);
    }
  }
  throw lastErr ?? new ToolError("PROVIDER_ERROR", "Request failed");
}

function delayWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new AbortError());
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new AbortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
