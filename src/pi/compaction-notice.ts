import { ResponsePartKind, type SystemNotificationResponsePart } from "@microsoft/agent-host-protocol";

/** Compaction changes the model's context, not the user's visible transcript. */
export const COMPACTION_NOTICE = "Conversation compacted. Earlier messages remain available in history.";

export function compactionNotification(): SystemNotificationResponsePart {
	return { kind: ResponsePartKind.SystemNotification, content: COMPACTION_NOTICE };
}
