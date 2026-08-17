/**
 * SPA + DOM mutation detection. Signals the background whenever the page
 * state changes so stale snapshots can be invalidated:
 *  - History API navigation (pushState/replaceState/popstate/hashchange)
 *  - Heavy DOM mutation bursts
 */

export interface PageChangeReporter {
  (reason: "history" | "mutation" | "navigation"): void;
}

export class DomObserver {
  private lastUrl = location.href;
  private mutationTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly report: PageChangeReporter) {}

  start(): void {
    this.watchHistory();
    this.watchMutations();
    window.addEventListener("beforeunload", () => this.report("navigation"));
  }

  /** Returns true when the page URL changed since the last check. */
  private checkUrl(): boolean {
    const url = location.href;
    if (url !== this.lastUrl) {
      this.lastUrl = url;
      return true;
    }
    return false;
  }

  private watchHistory(): void {
    const reportHistory = () => {
      if (this.checkUrl()) this.report("history");
    };
    const originalPush = history.pushState;
    const originalReplace = history.replaceState;
    history.pushState = function (this: History, ...args: Parameters<History["pushState"]>) {
      const result = originalPush.apply(this, args as [unknown, string, string | URL | null | undefined]);
      queueMicrotask(reportHistory);
      return result;
    };
    history.replaceState = function (this: History, ...args: Parameters<History["replaceState"]>) {
      const result = originalReplace.apply(this, args as [unknown, string, string | URL | null | undefined]);
      queueMicrotask(reportHistory);
      return result;
    };
    window.addEventListener("popstate", reportHistory);
    window.addEventListener("hashchange", reportHistory);
  }

  private watchMutations(): void {
    const observer = new MutationObserver((records) => {
      let added = 0;
      for (const r of records) added += r.addedNodes.length;
      // Only heavy rewrites invalidate the snapshot — light churn (animations,
      // live counters) must not force constant re-snapshots.
      if (added < 25) return;
      if (this.mutationTimer) return;
      this.mutationTimer = setTimeout(() => {
        this.mutationTimer = null;
        this.report("mutation");
      }, 800);
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: false,
      characterData: false,
    });
  }
}

