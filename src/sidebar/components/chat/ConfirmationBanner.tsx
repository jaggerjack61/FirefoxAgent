import { useState } from "react";
import type { ConfirmationRequest } from "@/shared/types";
import { useAgentStore } from "../../store/agentStore";

export function ConfirmationBanner({ request }: { request: ConfirmationRequest }): JSX.Element {
  const respond = useAgentStore((s) => s.respondConfirmation);
  const [busy, setBusy] = useState(false);

  const answer = async (approved: boolean): Promise<void> => {
    setBusy(true);
    try {
      await respond(request.id, approved);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`confirmation-banner ${request.highRisk ? "high-risk" : ""}`}>
      <div className="confirmation-title">⚠️ Action requires your approval</div>
      <div className="confirmation-desc">{request.description}</div>
      {request.details && <div className="confirmation-details">{request.details}</div>}
      <div className="confirmation-actions">
        <button className="cancel-btn" disabled={busy} onClick={() => void answer(false)}>
          Cancel
        </button>
        <button className="approve-btn" disabled={busy} onClick={() => void answer(true)}>
          Approve
        </button>
      </div>
    </div>
  );
}
