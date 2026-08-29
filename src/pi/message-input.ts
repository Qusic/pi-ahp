import {
	type Message,
	MessageAttachmentKind,
	type MessageEmbeddedResourceAttachment,
	type TextPosition,
} from "@microsoft/agent-host-protocol";

type PreparedMessage = { readonly text: string } | { readonly rejectionReason: string };

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

function positionExists(lines: readonly string[], position: TextPosition): boolean {
	if (
		!Number.isSafeInteger(position.line) ||
		!Number.isSafeInteger(position.character) ||
		position.line < 0 ||
		position.character < 0
	) {
		return false;
	}
	const line = lines[position.line];
	const length = line?.endsWith("\r") ? line.length - 1 : line?.length;
	return length !== undefined && position.character <= length;
}

function hasValidSelection(text: string, attachment: MessageEmbeddedResourceAttachment): boolean {
	const range = attachment.selection?.range;
	if (!range) {
		return true;
	}
	const lines = text.split("\n");
	const ordered =
		range.start.line < range.end.line ||
		(range.start.line === range.end.line && range.start.character <= range.end.character);
	return ordered && positionExists(lines, range.start) && positionExists(lines, range.end);
}

function embeddedText(attachment: MessageEmbeddedResourceAttachment): PreparedMessage {
	// MIME is advisory; successful UTF-8 decoding is the only distinction this
	// text-only adapter needs.
	const bytes = decodeBase64(attachment.data);
	if (!bytes) {
		return { rejectionReason: `Embedded resource ${attachment.label} is not valid base64` };
	}

	let decoded: string;
	try {
		decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return { rejectionReason: `Embedded resource ${attachment.label} is not valid UTF-8` };
	}
	if (!hasValidSelection(decoded, attachment)) {
		return { rejectionReason: `Embedded resource ${attachment.label} has an invalid selection` };
	}
	const range = attachment.selection?.range;
	if (!range) {
		return { text: decoded };
	}
	const marker = `[selection ${range.start.line + 1}:${range.start.character + 1}-${range.end.line + 1}:${range.end.character + 1}]`;
	return { text: `${marker}\n${decoded}` };
}

function prepareMessage(message: Message): PreparedMessage {
	if (message.agent) {
		return { rejectionReason: "This host does not support custom agents" };
	}

	const representations: string[] = [];
	for (const attachment of message.attachments ?? []) {
		switch (attachment.type) {
			case MessageAttachmentKind.Resource:
				// Resource metadata has no pi equivalent; pi consumes Message.text.
				break;
			case MessageAttachmentKind.Simple:
				if (typeof attachment.modelRepresentation !== "string") {
					return { rejectionReason: "A simple attachment requires modelRepresentation" };
				}
				if (attachment.modelRepresentation) {
					representations.push(attachment.modelRepresentation);
				}
				break;
			case MessageAttachmentKind.EmbeddedResource: {
				const embedded = embeddedText(attachment);
				if ("rejectionReason" in embedded) {
					return embedded;
				}
				representations.push(embedded.text);
				break;
			}
			default:
				return { rejectionReason: `This host does not support ${attachment.type} attachments` };
		}
	}

	return { text: [message.text, ...representations].filter(Boolean).join("\n\n") };
}

export function messageRejectionReason(message: Message): string | undefined {
	const prepared = prepareMessage(message);
	return "rejectionReason" in prepared ? prepared.rejectionReason : undefined;
}

export function messageTextForPi(message: Message): string {
	const prepared = prepareMessage(message);
	if ("rejectionReason" in prepared) {
		throw new Error(prepared.rejectionReason);
	}
	return prepared.text;
}
