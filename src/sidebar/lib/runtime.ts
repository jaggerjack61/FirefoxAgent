/**
 * Sidebar runtime client: typed wrapper around browser.runtime with a
 * mockable seam for preview/E2E (no extension environment).
 */

import type { BackgroundEvent } from "@/shared/events";
import type { SidebarRequest, SidebarResponse } from "@/shared/protocol";

export interface RuntimeApi {
  send(request: SidebarRequest): Promise<SidebarResponse>;
  onEvent(listener: (event: BackgroundEvent) => void): () => void;
}

/** Real implementation on top of Firefox WebExtension APIs. */
const extensionRuntime: RuntimeApi = {
  async send(request) {
    return (await browser.runtime.sendMessage(request)) as SidebarResponse;
  },
  onEvent(listener) {
    const handler = (message: unknown) => {
      if (message && typeof message === "object" && "event" in message && "payload" in message) {
        listener((message as { payload: BackgroundEvent }).payload);
      }
    };
    browser.runtime.onMessage.addListener(handler);
    return () => browser.runtime.onMessage.removeListener(handler);
  },
};

/**
 * Mockable seam. In a real extension the browser global exists; in the
 * Vite preview (used by Playwright E2E) a mock can be installed at
 * window.__FFA_MOCK_RUNTIME before the app boots.
 */
export function getRuntime(): RuntimeApi {
  const mock = (globalThis as { __FFA_MOCK_RUNTIME?: RuntimeApi }).__FFA_MOCK_RUNTIME;
  if (mock) return mock;
  return extensionRuntime;
}

/** Sends an event back to the background from the sidebar (unused for now). */
export async function request<T extends SidebarRequest["type"]>(
  type: T,
  body: Omit<Extract<SidebarRequest, { type: T }>, "type"> = {} as never,
): Promise<SidebarResponse> {
  return getRuntime().send({ type, ...body } as SidebarRequest);
}
