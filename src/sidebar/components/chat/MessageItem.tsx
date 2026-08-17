import type { ChatMessageRecord } from "@/shared/types";
import { Markdown } from "./Markdown";

interface Props {
  message?: ChatMessageRecord;
  streamingText?: string;
  streaming?: boolean;
}

export function MessageItem({ message, streamingText, streaming = false }: Props): JSX.Element {
  if (streamingText !== undefined) {
    return (
      <div className="msg assistant streaming">
        <div className="msg-role">Agent</div>
        <div className="msg-content">
          <Markdown content={streamingText} />
        </div>
      </div>
    );
  }

  if (!message) return <></>;

  const isUser = message.role === "user";
  const isTool = message.role === "tool";
  const cls = `msg ${message.role}${streaming ? " streaming" : ""}`;

  if (isTool) {
    // Tool messages are not rendered as chat bubbles; they are surfaced
    // through the activity feed.
    return <></>;
  }

  return (
    <div className={cls}>
      <div className="msg-role">{isUser ? "You" : "Agent"}</div>
      <div className="msg-content">
        {isUser ? message.content || "" : <Markdown content={message.content || ""} />}
      </div>
    </div>
  );
}
