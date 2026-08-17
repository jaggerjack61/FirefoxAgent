import { describe, it, expect, vi } from "vitest";
import { retryFetch } from "./retry";

describe("retryFetch", () => {
  it("succeeds on the first attempt", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await retryFetch("https://x.test/v1", { method: "POST" }, { attempts: 3, backoffMs: [1, 1] });
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it("retries on 429 with retry-after", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("rate limited", { status: 429, headers: { "retry-after": "0" } }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await retryFetch("https://x.test/v1", {}, { attempts: 3, backoffMs: [1, 1] });
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });

  it("retries on network failure", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("network error"))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await retryFetch("https://x.test/v1", {}, { attempts: 3, backoffMs: [1, 1] });
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });

  it("gives up after exhausting attempts", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("down"));
    vi.stubGlobal("fetch", fetchMock);
    await expect(retryFetch("https://x.test/v1", {}, { attempts: 3, backoffMs: [1, 1] })).rejects.toThrow("down");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    vi.unstubAllGlobals();
  });

  it("does not retry 4xx errors other than 429 (returns the response)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("bad", { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await retryFetch("https://x.test/v1", {}, { attempts: 3, backoffMs: [1, 1] });
    expect(res.status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it("aborts when the outer signal aborts", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      retryFetch("https://x.test/v1", {}, { attempts: 3, backoffMs: [1, 1], signal: controller.signal }),
    ).rejects.toThrow("Aborted");
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
