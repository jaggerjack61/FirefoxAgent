import { createId } from "@/shared/token";
import type { AgentEvent, UiCommand } from "@/shared/schema";

type CommandInput = UiCommand extends infer Command
  ? Command extends UiCommand
    ? Omit<Command, "version" | "requestId">
    : never
  : never;
type EventListener = (event: AgentEvent) => void;

export class BackgroundClient {
  private port: browser.runtime.Port | null = null;
  private listeners = new Set<EventListener>();
  private pending = new Map<string, { resolve: (value: unknown) => void; reject: (reason: Error) => void }>();
  private reconnectTimer: number | undefined;

  constructor() {
    this.connect();
  }

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async send<T>(input: CommandInput): Promise<T> {
    const requestId = createId("request");
    const command = { ...input, version: 1, requestId } as UiCommand;
    const port = this.port;
    if (!port) throw new Error("Background connection is unavailable");
    return new Promise<T>((resolve, reject) => {
      this.pending.set(requestId, {
        resolve: (value) => resolve(value as T),
        reject,
      });
      port.postMessage(command);
    });
  }

  private connect(): void {
    const port = browser.runtime.connect({ name: "browseragent-sidebar-v1" });
    this.port = port;
    port.onMessage.addListener((raw: unknown) => {
      if (!raw || typeof raw !== "object") return;
      const message = raw as Record<string, unknown>;
      if (message.kind === "event" && message.event) {
        for (const listener of this.listeners) listener(message.event as AgentEvent);
        return;
      }
      if (message.kind !== "response" || typeof message.requestId !== "string") return;
      const pending = this.pending.get(message.requestId);
      if (!pending) return;
      this.pending.delete(message.requestId);
      if (message.ok) pending.resolve(message.data);
      else
        pending.reject(
          new Error(typeof message.error === "string" ? message.error : "Background request failed"),
        );
    });
    port.onDisconnect.addListener(() => {
      if (this.port !== port) return;
      this.port = null;
      for (const pending of this.pending.values())
        pending.reject(new Error("Background connection restarted"));
      this.pending.clear();
      if (this.reconnectTimer !== undefined) window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = window.setTimeout(() => this.connect(), 500);
    });
  }
}

export const backgroundClient = new BackgroundClient();
