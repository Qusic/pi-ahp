/** Reconstructs the protocol-visible part of a user message stored by pi. */

import {
	type Message,
	type MessageAttachment,
	MessageAttachmentKind,
	MessageKind,
} from "@microsoft/agent-host-protocol";
import { normalizeImageMimeType } from "./image-mime.ts";

interface PiContentBlock {
	readonly type?: unknown;
	readonly text?: unknown;
	readonly data?: unknown;
	readonly mimeType?: unknown;
}

function blocksOf(content: unknown): PiContentBlock[] {
	return Array.isArray(content)
		? content.filter((block): block is PiContentBlock => typeof block === "object" && block !== null)
		: [];
}

export function textFromPiUserContent(content: unknown): string {
	if (typeof content === "string") {
		return content;
	}
	return blocksOf(content)
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text as string)
		.join("");
}

function imageAttachments(content: unknown): MessageAttachment[] {
	const attachments: MessageAttachment[] = [];
	for (const block of blocksOf(content)) {
		if (block.type !== "image" || typeof block.data !== "string" || typeof block.mimeType !== "string") {
			continue;
		}
		const contentType = normalizeImageMimeType(block.mimeType);
		if (!contentType) {
			continue;
		}
		attachments.push({
			type: MessageAttachmentKind.EmbeddedResource,
			label: `Image ${attachments.length + 1}`,
			displayKind: "image",
			data: block.data,
			contentType,
		});
	}
	return attachments;
}

/**
 * pi persists image bytes but not client-side labels, so replay uses stable
 * ordinal labels while preserving the actual image and MIME type.
 */
export function userMessageFromPiContent(content: unknown): Message {
	const attachments = imageAttachments(content);
	return {
		text: textFromPiUserContent(content),
		origin: { kind: MessageKind.User },
		...(attachments.length > 0 ? { attachments } : {}),
	};
}
