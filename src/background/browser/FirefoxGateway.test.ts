import { afterEach, describe, expect, it, vi } from "vitest";
import { FirefoxGateway } from "./FirefoxGateway";
import type { ContentRequest, ContentResponse, PageSnapshot } from "@/shared/contentProtocol";

function installBrowserMock(contains: (origins: string[]) => boolean): ReturnType<typeof vi.fn> {
  const containsMock = vi.fn(async ({ origins }: { origins?: string[] }) => contains(origins ?? []));
  vi.stubGlobal("browser", {
    tabs: { onUpdated: { addListener: vi.fn() } },
    permissions: { contains: containsMock },
  });
  return containsMock;
}

function page(elements: PageSnapshot["elements"] = [], links: PageSnapshot["links"] = []): PageSnapshot {
  return {
    url: "https://example.com/page",
    title: "Example",
    capturedAt: Date.now(),
    version: Date.now(),
    elements,
    text: "Example page text",
    headings: [],
    links,
    forms: [],
    tableCount: 0,
    listCount: 0,
    truncated: false,
  };
}

interface NetworkListeners {
  before?: (details: { tabId: number; requestId: string; type: string }) => void;
  completed?: (details: { tabId: number; requestId: string }) => void;
  failed?: (details: { tabId: number; requestId: string }) => void;
}

function installContentBrowserMock(
  responder: (request: ContentRequest) => ContentResponse | Promise<ContentResponse>,
  networkListeners?: NetworkListeners,
) {
  const sendMessage = vi.fn(async (_tabId: number, request: ContentRequest) => responder(request));
  vi.stubGlobal("browser", {
    tabs: {
      onUpdated: { addListener: vi.fn() },
      get: vi.fn(async (id: number) => ({ id, url: "https://example.com/page", title: "Example", active: true, windowId: 1, status: "complete" })),
      query: vi.fn(async () => [{ id: 1, url: "https://example.com/page", title: "Example", active: true, windowId: 1, status: "complete" }]),
      sendMessage,
    },
    permissions: { contains: vi.fn(async () => true) },
    scripting: { registerContentScripts: vi.fn(async () => undefined) },
    webNavigation: { getAllFrames: vi.fn(async () => [{ frameId: 0, url: "https://example.com/page" }]) },
    webRequest: {
      onBeforeRequest: { addListener: vi.fn((listener: NetworkListeners["before"]) => { if (networkListeners) networkListeners.before = listener; }) },
      onCompleted: { addListener: vi.fn((listener: NetworkListeners["completed"]) => { if (networkListeners) networkListeners.completed = listener; }) },
      onErrorOccurred: { addListener: vi.fn((listener: NetworkListeners["failed"]) => { if (networkListeners) networkListeners.failed = listener; }) },
    },
  });
  return sendMessage;
}

describe("FirefoxGateway host access", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("recognizes the granted <all_urls> permission", async () => {
    const contains = installBrowserMock((origins) => origins[0] === "<all_urls>");
    const gateway = new FirefoxGateway();

    await expect(gateway.hasHostAccess("https://example.com/page")).resolves.toBe(true);
    expect(contains).toHaveBeenCalledOnce();
    expect(contains).toHaveBeenCalledWith({ origins: ["<all_urls>"] });
  });

  it("uses a valid match pattern for site-specific permission checks", async () => {
    const contains = installBrowserMock((origins) => origins[0] === "https://example.com/*");
    const gateway = new FirefoxGateway();

    await expect(gateway.hasHostAccess("https://example.com/path?q=1")).resolves.toBe(true);
    expect(contains).toHaveBeenNthCalledWith(1, { origins: ["<all_urls>"] });
    expect(contains).toHaveBeenNthCalledWith(2, { origins: ["https://example.com/*"] });
  });

  it("does not treat internal Firefox pages as inspectable", async () => {
    const contains = installBrowserMock(() => false);
    const gateway = new FirefoxGateway();

    await expect(gateway.hasHostAccess("about:config")).resolves.toBe(false);
    expect(contains).toHaveBeenCalledOnce();
  });
});

describe("FirefoxGateway snapshots and recovery", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("does not reuse a cache entry that omitted requested links", async () => {
    const sendMessage = installContentBrowserMock((request) => {
      if (request.kind !== "get_snapshot") return { ok: false, error: "NOT_IMPLEMENTED", message: "unexpected" };
      const links = (request.opts?.maxLinks ?? 0) > 0 ? [{ text: "Docs", href: "https://example.com/docs" }] : [];
      return { ok: true, data: page([], links) };
    });
    const gateway = new FirefoxGateway();

    const withoutLinks = await gateway.getSnapshot(1, { maxLinks: 0 });
    const withLinks = await gateway.getSnapshot(1, { maxLinks: 10 });

    expect(withoutLinks.links).toEqual([]);
    expect(withLinks.links).toHaveLength(1);
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it("waits for a loading tab before reading or acting on the page", async () => {
    let tabChecks = 0;
    const sendMessage = installContentBrowserMock((request) => {
      if (request.kind !== "get_snapshot") return { ok: false, error: "NOT_IMPLEMENTED", message: "unexpected" };
      return { ok: true, data: page() };
    });
    vi.mocked(browser.tabs.get).mockImplementation(async (id: number) => {
      tabChecks += 1;
      return {
        id,
        url: "https://example.com/page",
        title: "Example",
        active: true,
        windowId: 1,
        status: tabChecks < 3 ? "loading" : "complete",
      } as browser.tabs.Tab;
    });
    const gateway = new FirefoxGateway();

    await gateway.getSnapshot(1);

    expect(tabChecks).toBeGreaterThanOrEqual(3);
    expect(sendMessage).toHaveBeenCalledOnce();
  });

  it("waits for page API requests and a quiet network window after document completion", async () => {
    vi.useFakeTimers();
    const network: NetworkListeners = {};
    const sendMessage = installContentBrowserMock((request) => {
      if (request.kind !== "get_snapshot") return { ok: false, error: "NOT_IMPLEMENTED", message: "unexpected" };
      return { ok: true, data: page() };
    }, network);
    const gateway = new FirefoxGateway();
    network.before?.({ tabId: 1, requestId: "api-1", type: "xmlhttprequest" });

    const snapshotPromise = gateway.getSnapshot(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sendMessage).not.toHaveBeenCalled();

    network.completed?.({ tabId: 1, requestId: "api-1" });
    await vi.advanceTimersByTimeAsync(400);
    expect(sendMessage).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    await snapshotPromise;

    expect(sendMessage).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it("does not block forever on long-polling or streaming API traffic", async () => {
    vi.useFakeTimers();
    const network: NetworkListeners = {};
    const sendMessage = installContentBrowserMock((request) => {
      if (request.kind !== "get_snapshot") return { ok: false, error: "NOT_IMPLEMENTED", message: "unexpected" };
      return { ok: true, data: page() };
    }, network);
    const gateway = new FirefoxGateway();
    network.before?.({ tabId: 1, requestId: "long-poll", type: "xmlhttprequest" });

    const snapshotPromise = gateway.getSnapshot(1);
    await vi.advanceTimersByTimeAsync(4_500);
    expect(sendMessage).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(700);
    await snapshotPromise;

    expect(sendMessage).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it("keeps the old semantic identity long enough to remap a stale id", async () => {
    let snapshotNumber = 0;
    const clickIds: string[] = [];
    installContentBrowserMock((request) => {
      if (request.kind === "get_snapshot") {
        snapshotNumber += 1;
        const id = snapshotNumber === 1 ? "E1" : "E7";
        return {
          ok: true,
          data: page([{ id, role: "button", name: "Continue", tag: "button", visible: true, inFrame: false, frameId: 0 }]),
        };
      }
      if (request.kind === "click") {
        clickIds.push(request.elementId);
        return request.elementId === "E1"
          ? { ok: false, error: "ELEMENT_NOT_FOUND", message: "stale" }
          : { ok: true, data: { action: "click" } };
      }
      return { ok: false, error: "NOT_IMPLEMENTED", message: "unexpected" };
    });
    const gateway = new FirefoxGateway();
    await gateway.getSnapshot(1, { maxElements: 120 });

    const result = await gateway.clickElement(1, "E1");

    expect(result.success).toBe(true);
    expect(clickIds).toEqual(["E1", "E7"]);
  });

  it("remaps a covered target to an actionable semantic duplicate", async () => {
    let snapshotNumber = 0;
    const clickIds: string[] = [];
    installContentBrowserMock((request) => {
      if (request.kind === "get_snapshot") {
        snapshotNumber += 1;
        return {
          ok: true,
          data: page(snapshotNumber === 1
            ? [{ id: "E1", role: "button", name: "Continue", tag: "button", visible: true, actionable: true, inFrame: false, frameId: 0 }]
            : [
                { id: "E1", role: "button", name: "Continue", tag: "button", visible: true, actionable: false, inFrame: false, frameId: 0 },
                { id: "E8", role: "button", name: "Continue", tag: "button", visible: true, actionable: true, inFrame: false, frameId: 0 },
              ]),
        };
      }
      if (request.kind === "click") {
        clickIds.push(request.elementId);
        return request.elementId === "E1"
          ? { ok: false, error: "ELEMENT_NOT_INTERACTABLE", message: "covered" }
          : { ok: true, data: { action: "click", effectObserved: true } };
      }
      return { ok: false, error: "NOT_IMPLEMENTED", message: "unexpected" };
    });
    const gateway = new FirefoxGateway();
    await gateway.getSnapshot(1, { maxElements: 120 });

    const result = await gateway.clickElement(1, "E1");

    expect(result.success).toBe(true);
    expect(clickIds).toEqual(["E1", "E8"]);
  });

  it("does not report success when a synthetic click has no verifiable effect", async () => {
    installContentBrowserMock((request) => {
      if (request.kind === "get_snapshot") return { ok: true, data: page() };
      if (request.kind === "click") {
        return { ok: true, data: { action: "click", effectObserved: false, trustedInput: false } };
      }
      return { ok: false, error: "NOT_IMPLEMENTED", message: "unexpected" };
    });
    const gateway = new FirefoxGateway();

    const result = await gateway.clickElement(1, "E1");

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("ACTION_NOT_VERIFIED");
    expect(result.observation).toContain("isTrusted=false");
  });
});
