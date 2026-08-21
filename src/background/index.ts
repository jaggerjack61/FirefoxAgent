/**
 * Background script entry point (Firefox MV3).
 *
 * Wires together storage, settings, workspace, gateway, tools and the
 * agent orchestrator; routes typed sidebar requests; pushes events to the
 * sidebar; manages tab lifecycle via the TabCoordinator.
 */

import { IndexedDbMemoryStore } from "@/memory/IndexedDbMemoryStore";
import { WebExtensionSettingsRepository } from "@/settings/SettingsRepository";
import { WorkspaceManager } from "@/workspace/WorkspaceManager";
import { FirefoxGateway } from "./browser/FirefoxGateway";
import { createToolRegistry } from "@/tools/index";
import { createProvider } from "@/providers/registry";
import { BackgroundOrchestrator } from "./Orchestrator";
import { TabCoordinator } from "./coordinator/TabCoordinator";
import { bridgeBackgroundEvents } from "./eventBridge";
import type { SidebarRequest, SidebarResponse } from "@/shared/protocol";
import type { AppSettings } from "@/shared/types";

const store = new IndexedDbMemoryStore();
const settingsRepo = new WebExtensionSettingsRepository(store);
const gateway = new FirefoxGateway();
const registry = createToolRegistry();

let orchestrator!: BackgroundOrchestrator;
let coordinator: TabCoordinator;
let settings: AppSettings;

async function main(): Promise<void> {
  settings = await settingsRepo.load();
  const provider = createProvider(settings.provider);
  const workspace = new WorkspaceManager({ storage: store });

  orchestrator = new BackgroundOrchestrator(store, settingsRepo, workspace, gateway, registry, provider, settings);
  await orchestrator.init();
  bridgeBackgroundEvents(orchestrator, browser.runtime);
  workspace.onChanged = (ws) => orchestrator.broadcastWorkspace(ws);

  coordinator = new TabCoordinator(workspace, { emit: (e) => orchestrator.broadcast(e) });
  coordinator.start();

  browser.runtime.onMessage.addListener(router);
  browser.action.onClicked.addListener(() => {
    void browser.sidebarAction.open();
  });

  // Optional host permissions grant → (re)register content scripts.
  browser.permissions.onAdded.addListener(() => {
    void gateway.ensureContentScripts().catch(() => undefined);
  });
}

// ---------------------------------------------------------------------------
// Router: sidebar <-> background
// ---------------------------------------------------------------------------

async function router(message: unknown, sender: browser.runtime.MessageSender): Promise<SidebarResponse | undefined> {
  // Content-script notifications carry their own type space.
  if (message && typeof message === "object" && "type" in message) {
    const m = message as { type: string };
    if (m.type === "PAGE_CHANGED" || m.type === "SNAPSHOT_DIRTY") {
      const tabId = sender.tab?.id;
      if (tabId !== undefined) gateway.invalidate(tabId);
      return undefined;
    }
  }

  const req = message as SidebarRequest;
  if (!req || typeof req !== "object" || !("type" in req)) return undefined;
  void sender;

  try {
    switch (req.type) {
      case "GET_BOOTSTRAP":
        return { ok: true, bootstrap: await orchestrator.bootstrap() };

      case "GET_CONVERSATION":
        return {
          ok: true,
          conversation: await store.loadConversation(req.conversationId),
          messages: await store.loadMessages(req.conversationId),
        };

      case "GET_WORKSPACE":
        return { ok: true, workspace: orchestrator.getWorkspace() };

      case "GET_ACTION_LOG":
        return { ok: true, actionLog: orchestrator.getActionLog() };

      case "GET_SETTINGS":
        return { ok: true, settings: orchestrator.getSettings() };

      case "SET_SETTINGS": {
        await orchestrator.updateSettings(req.settings);
        return { ok: true, settings: orchestrator.getSettings() };
      }

      case "SEND_USER_MESSAGE": {
        const result = await orchestrator.sendUserMessage(req.text);
        return result.ok ? { ok: true, accepted: true } : { ok: false, error: result.error ?? "Unknown error" };
      }

      case "STOP_AGENT":
        orchestrator.stopAgent();
        return { ok: true, accepted: true };

      case "NEW_CONVERSATION":
        await orchestrator.newConversation();
        return { ok: true, accepted: true };

      case "NEW_WORKSPACE": {
        const ws = orchestrator.newWorkspace();
        await ws.then((w) => orchestrator.bindWorkspace(w));
        return { ok: true, accepted: true };
      }

      case "WORKSPACE_ADD_TAB": {
        const tab = await gateway.getTab(req.tabId);
        if (!tab) return { ok: false, error: `Tab ${req.tabId} does not exist` };
        await orchestrator.workspaceAddTab(req.tabId, tab.url, tab.title, req.pinned ?? false);
        return { ok: true, accepted: true };
      }

      case "WORKSPACE_ADD_ALL_TABS": {
        const tabs = await gateway.listTabs();
        for (const t of tabs) {
          await orchestrator.workspaceAddTab(t.id, t.url, t.title, false);
        }
        return { ok: true, accepted: true };
      }

      case "WORKSPACE_REMOVE_TAB":
        await orchestrator.workspaceRemoveTab(req.tabId);
        return { ok: true, accepted: true };

      case "WORKSPACE_CLEAR":
        await orchestrator.workspaceClear();
        return { ok: true, accepted: true };

      case "WORKSPACE_PIN_TAB":
        await orchestrator.workspacePinTab(req.tabId, req.pinned);
        return { ok: true, accepted: true };

      case "CONFIRMATION_RESPONSE": {
        const handled = orchestrator.confirmations.respond(req.requestId, req.approved);
        return handled ? { ok: true, accepted: true } : { ok: false, error: "Confirmation request not found or expired" };
      }

      case "CLEAR_CONVERSATION":
        await orchestrator.clearConversation();
        return { ok: true, accepted: true };

      case "CLEAR_WORKSPACE":
        await orchestrator.workspaceClear();
        return { ok: true, accepted: true };

      case "CLEAR_REMEMBERED_PAGES":
        await store.clearFacts();
        return { ok: true, accepted: true };

      case "DELETE_ALL_LOCAL_DATA":
        await orchestrator.deleteAllLocalData();
        return { ok: true, accepted: true };

      case "ENSURE_PERMISSIONS": {
        const granted = await browser.permissions.request({ origins: ["<all_urls>"] });
        if (granted) {
          await gateway.ensureContentScripts().catch(() => undefined);
          return { ok: true, accepted: true };
        }
        return { ok: false, error: "Site access was not granted" };
      }

      case "GET_DEV_EVENTS":
        return { ok: true, devEvents: orchestrator.getDevEvents() };

      case "GET_EXCHANGE_LOGS":
        return { ok: true, exchangeLogs: orchestrator.getExchangeLogs() };

      case "FETCH_MODELS":
        return { ok: true, models: await orchestrator.listModels() };

      default: {
        const exhaustive: never = req;
        throw new Error(`Unknown request: ${JSON.stringify(exhaustive)}`);
      }
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// Expose a few internals for debugging (devtools console of the extension).
(globalThis as unknown as { __ffa?: unknown }).__ffa = { orchestrator };

void main();
