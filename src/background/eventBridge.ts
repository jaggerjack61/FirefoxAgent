import type { BackgroundEvent } from "@/shared/events";

interface BackgroundEventSource {
  subscribe(listener: (event: BackgroundEvent) => void): () => void;
}

interface RuntimeEventTarget {
  sendMessage(message: { event: "BACKGROUND_EVENT"; payload: BackgroundEvent }): Promise<unknown>;
}

/** Forwards orchestrator events into extension contexts such as the sidebar. */
export function bridgeBackgroundEvents(source: BackgroundEventSource, runtime: RuntimeEventTarget): () => void {
  return source.subscribe((event) => {
    // A closed sidebar means there is no receiver; the agent must keep running.
    void runtime.sendMessage({ event: "BACKGROUND_EVENT", payload: event }).catch(() => undefined);
  });
}
