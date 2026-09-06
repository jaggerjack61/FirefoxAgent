import { agentEventSchema, uiCommandSchema } from "@/shared/schema";
import { Orchestrator } from "./orchestrator";

const ports = new Set<browser.runtime.Port>();

const orchestrator = new Orchestrator(undefined, undefined, (event) => {
  const validated = agentEventSchema.parse(event);
  for (const port of ports) {
    try {
      port.postMessage({ kind: "event", event: validated });
    } catch {
      ports.delete(port);
    }
  }
});

const ready = orchestrator.init();

browser.runtime.onConnect.addListener((port) => {
  if (port.name !== "browseragent-sidebar-v1") return;
  ports.add(port);
  port.onDisconnect.addListener(() => ports.delete(port));
  port.onMessage.addListener((raw: unknown) => {
    void (async () => {
      const parsed = uiCommandSchema.safeParse(raw);
      if (!parsed.success) {
        const requestId =
          raw && typeof raw === "object" && typeof (raw as Record<string, unknown>).requestId === "string"
            ? (raw as Record<string, unknown>).requestId
            : "invalid";
        port.postMessage({ kind: "response", requestId, ok: false, error: "Invalid command" });
        return;
      }
      const command = parsed.data;
      try {
        await ready;
        const data = await orchestrator.handle(command);
        port.postMessage({ kind: "response", requestId: command.requestId, ok: true, data });
      } catch (error) {
        port.postMessage({
          kind: "response",
          requestId: command.requestId,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();
  });
});

browser.runtime.onInstalled.addListener(() => {
  void ready;
});

browser.runtime.onStartup.addListener(() => {
  void ready;
});

browser.action.onClicked.addListener(() => {
  void browser.sidebarAction.open();
});
