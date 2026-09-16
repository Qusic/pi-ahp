/**
 * Converts supported AHP user-message attachments into pi's prompt shape.
 * Resource references become paths or URIs, simple attachments contribute their
 * model representation, embedded text is decoded as UTF-8, and embedded images
 * become pi image-content blocks. Other attachment kinds remain unsupported.
 */

import { fileURLToPath } from "node:url";
import type { ImageContent } from "@earendil-works/pi-ai";
import {
	type Message,
	MessageAttachmentKind,
	type MessageEmbeddedResourceAttachment,
	type MessageResourceAttachment,
	type TextRange,
} from "@microsoft/agent-host-protocol";
import { normalizeImageMimeType } from "./image-mime.ts";

export interface PiMessageInput {
	readonly text: string;
	readonly images?: ImageContent[];
}

type RejectedMessage = { readonly rejectionReason: string };
type PreparedMessage = PiMessageInput | RejectedMessage;
type PreparedText = { readonly text: string } | RejectedMessage;
type PreparedEmbedded = { readonly text: string } | { readonly image: ImageContent } | RejectedMessage;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isNonNegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isTextRange(value: unknown): value is TextRange {
	if (!isRecord(value) || !isRecord(value.start) || !isRecord(value.end)) return false;
	return [value.start.line, value.start.character, value.end.line, value.end.character].every(isNonNegativeInteger);
}

function decodeBase64(data: unknown): Buffer | undefined {
	if (typeof data !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/u.test(data) || data.length % 4 === 1) {
		return undefined;
	}
	const padding = data.indexOf("=");
	if (padding !== -1 && (padding < data.length - 2 || data.length % 4 !== 0)) {
		return undefined;
	}
	const decoded = Buffer.from(data, "base64");
	const canonical = decoded.toString("base64").replace(/=+$/u, "");
	return canonical === data.replace(/=+$/u, "") ? decoded : undefined;
}

function rangeText(range: TextRange): string {
	return `${range.start.line + 1}:${range.start.character + 1}-${range.end.line + 1}:${range.end.character + 1}`;
}

function baseContentType(contentType: string): string {
	return contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function embeddedContent(attachment: MessageEmbeddedResourceAttachment): PreparedEmbedded {
	if (typeof attachment.contentType !== "string") {
		return { rejectionReason: `Embedded resource ${attachment.label} requires a content type` };
	}
	const contentType = baseContentType(attachment.contentType);
	if (!contentType) {
		return { rejectionReason: `Embedded resource ${attachment.label} requires a content type` };
	}
	const bytes = decodeBase64(attachment.data);
	if (!bytes) {
		return { rejectionReason: `Embedded resource ${attachment.label} is not valid base64` };
	}

	const imageMimeType = normalizeImageMimeType(contentType);
	if (imageMimeType) {
		if (bytes.length === 0) {
			return { rejectionReason: `Embedded image ${attachment.label} is empty` };
		}
		return {
			image: {
				type: "image",
				data: bytes.toString("base64"),
				mimeType: imageMimeType,
			},
		};
	}

	// MIME is advisory for non-images: successful UTF-8 decoding decides whether
	// an embedded resource can safely join pi's text prompt.
	let decoded: string;
	try {
		decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return { rejectionReason: `Embedded resource ${attachment.label} is not valid UTF-8` };
	}
	const selected = attachment.selection?.range;
	if (!selected) {
		return { text: decoded };
	}
	return { text: `[selection ${rangeText(selected)}]\n${decoded}` };
}

function resourceText(attachment: MessageResourceAttachment): PreparedText {
	if (typeof attachment.uri !== "string") {
		return { rejectionReason: "A resource attachment requires a URI" };
	}
	const selected = attachment.selection?.range;
	let reference = attachment.uri;
	if (/^file:/iu.test(reference)) {
		try {
			reference = fileURLToPath(reference);
		} catch {
			// Preserve a remote or malformed file URI rather than guessing a path.
		}
	}
	return { text: `${reference}${selected ? `:${rangeText(selected)}` : ""}` };
}

function prepareMessage(value: unknown): PreparedMessage {
	if (
		!isRecord(value) ||
		typeof value.text !== "string" ||
		!isRecord(value.origin) ||
		typeof value.origin.kind !== "string"
	) {
		return { rejectionReason: "A message requires text and an origin" };
	}
	if (value.attachments !== undefined && !Array.isArray(value.attachments)) {
		return { rejectionReason: "Message attachments must be an array" };
	}
	if (value.model !== undefined && (!isRecord(value.model) || typeof value.model.id !== "string")) {
		return { rejectionReason: "A message model requires an id" };
	}
	if (value.agent !== undefined) {
		return { rejectionReason: "This host does not support custom agents" };
	}
	const message = value as unknown as Message;

	const representations: string[] = [];
	const images: ImageContent[] = [];
	for (const attachment of message.attachments ?? []) {
		if (!isRecord(attachment) || typeof attachment.type !== "string" || typeof attachment.label !== "string") {
			return { rejectionReason: "Every message attachment requires a type and label" };
		}
		if (attachment.range !== undefined && !isTextRange(attachment.range)) {
			return { rejectionReason: `Attachment ${attachment.label} has an invalid text range` };
		}
		if (
			"selection" in attachment &&
			attachment.selection !== undefined &&
			(!isRecord(attachment.selection) || !isTextRange(attachment.selection.range))
		) {
			return { rejectionReason: `Attachment ${attachment.label} has an invalid text selection` };
		}
		switch (attachment.type) {
			case MessageAttachmentKind.Resource: {
				const resource = resourceText(attachment);
				if ("rejectionReason" in resource) {
					return resource;
				}
				representations.push(resource.text);
				break;
			}
			case MessageAttachmentKind.Simple:
				if (typeof attachment.modelRepresentation !== "string") {
					return { rejectionReason: "A simple attachment requires modelRepresentation" };
				}
				if (attachment.modelRepresentation) {
					representations.push(attachment.modelRepresentation);
				}
				break;
			case MessageAttachmentKind.EmbeddedResource: {
				const embedded = embeddedContent(attachment);
				if ("rejectionReason" in embedded) {
					return embedded;
				}
				if ("image" in embedded) {
					images.push(embedded.image);
				} else {
					representations.push(embedded.text);
				}
				break;
			}
			default:
				return { rejectionReason: `This host does not support ${attachment.type} attachments` };
		}
	}

	return {
		text: [message.text, ...representations].filter(Boolean).join("\n\n"),
		...(images.length > 0 ? { images } : {}),
	};
}

export function messageRejectionReason(message: unknown): string | undefined {
	const prepared = prepareMessage(message);
	return "rejectionReason" in prepared ? prepared.rejectionReason : undefined;
}

export function messageInputForPi(message: Message): PiMessageInput {
	const prepared = prepareMessage(message);
	if ("rejectionReason" in prepared) {
		throw new Error(prepared.rejectionReason);
	}
	return prepared;
}

export function messageTextForPi(message: Message): string {
	return messageInputForPi(message).text;
}
