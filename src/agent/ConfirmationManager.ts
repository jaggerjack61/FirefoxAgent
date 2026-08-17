/**
 * ConfirmationManager: owns pending confirmation requests. Enforcement is
 * structural — the agent loop cannot execute a tool until the user
 * approves, and the LLM has no path to approve its own actions.
 */

import type { ConfirmationRequest } from "@/shared/types";
import { newId } from "@/shared/id";
import type { BackgroundEvent } from "@/shared/events";

export interface ConfirmationSink {
  emit(event: BackgroundEvent): void;
}

const CONFIRMATION_TTL_MS = 5 * 60_000;

export class ConfirmationManager {
  private pending: ConfirmationRequest | null = null;
  private readonly resolvers = new Map<string, (approved: boolean) => void>();

  constructor(private readonly sink: ConfirmationSink) {}

  get pendingRequest(): ConfirmationRequest | null {
    return this.pending;
  }

  /**
   * Requests user confirmation. The returned promise resolves only when the
   * user responds (or the request expires). The agent loop awaits it.
   */
  request(tool: string, description: string, details: string, opts: { tabId?: number; highRisk: boolean }): Promise<boolean> {
    if (this.pending) {
      // Replace the previous pending request (should not happen in practice).
      this.pending = null;
    }
    const id = newId("confirm");
    const now = Date.now();
    const request: ConfirmationRequest = {
      id,
      tool,
      description,
      details,
      tabId: opts.tabId,
      requestedAt: now,
      expiresAt: now + CONFIRMATION_TTL_MS,
      highRisk: opts.highRisk,
    };
    this.pending = request;
    this.sink.emit({ type: "CONFIRMATION_REQUESTED", request });

    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.resolvers.delete(id);
        if (this.pending?.id === id) this.pending = null;
        this.sink.emit({ type: "CONFIRMATION_RESOLVED", requestId: id, approved: false });
        resolve(false);
      }, CONFIRMATION_TTL_MS);
      this.resolvers.set(id, (approved) => {
        clearTimeout(timer);
        resolve(approved);
      });
    });
  }

  /** User responded via the sidebar. */
  respond(requestId: string, approved: boolean): boolean {
    const resolver = this.resolvers.get(requestId);
    if (!resolver) return false;
    this.resolvers.delete(requestId);
    if (this.pending?.id === requestId) this.pending = null;
    this.sink.emit({ type: "CONFIRMATION_RESOLVED", requestId, approved });
    resolver(approved);
    return true;
  }

  /** Cancels any pending request (e.g. on Stop). */
  cancelAll(): void {
    if (this.pending) {
      const id = this.pending.id;
      this.pending = null;
      const resolver = this.resolvers.get(id);
      if (resolver) {
        this.resolvers.delete(id);
        this.sink.emit({ type: "CONFIRMATION_RESOLVED", requestId: id, approved: false });
        resolver(false);
      }
    }
  }
}
