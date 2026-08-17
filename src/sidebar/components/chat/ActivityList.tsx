import type { ToolActivityRecord } from "@/shared/types";
import { formatClock } from "@/shared/id";

interface Props {
  items: ToolActivityRecord[];
}

interface ItemProps {
  activity: ToolActivityRecord;
}

/** One inline tool-call lifecycle row for the chat timeline. */
export function ActivityItem({ activity: item }: ItemProps): JSX.Element {
  const thinking = item.kind === "thinking";
  const statusLabel = item.status === "running"
    ? (thinking ? "Thinking" : "Running")
    : item.status === "error" ? "Failed" : "Completed";
  return (
    <div
      className={`tool-call-item ${item.status}${thinking ? " thinking-step" : ""}`}
      role={thinking && item.status === "running" ? "status" : undefined}
      aria-live={thinking && item.status === "running" ? "polite" : undefined}
    >
      <span className="tool-call-icon" aria-hidden="true">
        {item.status === "running" ? "→" : item.status === "error" ? "×" : "✓"}
      </span>
      <div className="tool-call-body">
        <div className="tool-call-head">
          {thinking ? <strong>Agent thinking</strong> : <code>{item.tool}</code>}
          <span>{statusLabel}</span>
          <time>{formatClock(item.startedAt)}</time>
        </div>
        <div className="tool-call-label">{item.label}</div>
        {item.detail && <div className="activity-detail">{item.detail}</div>}
      </div>
    </div>
  );
}

/** Compact list used wherever several tool calls are grouped together. */
export function ActivityList({ items }: Props): JSX.Element {
  if (items.length === 0) return <></>;
  return (
    <div className="activity-feed">
      {items.map((item) => <ActivityItem key={item.id} activity={item} />)}
    </div>
  );
}
