import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	type Message,
	type MessageAttachment,
	MessageAttachmentKind,
	type MessageEmbeddedResourceAttachment,
	MessageKind,
} from "@microsoft/agent-host-protocol";
import { messageRejectionReason, messageTextForPi } from "../src/pi/message-input.ts";

function message(attachments: MessageAttachment[], text = "question"): Message {
	return { text, origin: { kind: MessageKind.User }, attachments };
}

function embedded(
	data: string,
	extra: Partial<MessageEmbeddedResourceAttachment> = {},
): MessageEmbeddedResourceAttachment {
	return {
		type: MessageAttachmentKind.EmbeddedResource,
		label: "notes.txt",
		contentType: "text/plain",
		data,
		...extra,
	};
}

describe("pi message input", () => {
	it("passes text through without interpreting resource metadata", () => {
		const input = message([
			{
				type: MessageAttachmentKind.Resource,
				label: "outside.ts",
				uri: "file:///outside.ts",
				selection: {
					range: {
						start: { line: 4, character: 2 },
						end: { line: 8, character: 0 },
					},
				},
			},
		]);

		assert.equal(messageRejectionReason(input), undefined);
		assert.equal(messageTextForPi(input), "question");
	});

	it("appends simple model representations in attachment order", () => {
		const input = message([
			{ type: MessageAttachmentKind.Simple, label: "first", modelRepresentation: "first context" },
			{ type: MessageAttachmentKind.Resource, label: "path", uri: "file:///path.ts" },
			{ type: MessageAttachmentKind.Simple, label: "second", modelRepresentation: "second context" },
		]);

		assert.equal(messageTextForPi(input), "question\n\nfirst context\n\nsecond context");
	});

	it("requires client-created simple attachments to carry a model representation", () => {
		for (const modelRepresentation of [undefined, null]) {
			const input = message([{ type: MessageAttachmentKind.Simple, label: "missing", modelRepresentation } as never]);
			assert.equal(messageRejectionReason(input), "A simple attachment requires modelRepresentation");
			assert.throws(() => messageTextForPi(input), /requires modelRepresentation/);
		}
	});

	it("appends UTF-8 embedded text without interpreting its MIME type", () => {
		const input = message([
			embedded(Buffer.from("const answer = 42;", "utf8").toString("base64"), {
				contentType: "application/x-uncommon-text",
			}),
		]);

		assert.equal(messageTextForPi(input), "question\n\nconst answer = 42;");
	});

	it("includes the full embedded text under a 1-based selection marker", () => {
		const content = "zero\r\none 😀\r\ntwo\nthree";
		const input = message([
			embedded(Buffer.from(content, "utf8").toString("base64"), {
				selection: {
					range: {
						start: { line: 1, character: 4 },
						end: { line: 2, character: 3 },
					},
				},
			}),
		]);

		assert.equal(messageTextForPi(input), "question\n\n[selection 2:5-3:4]\nzero\r\none 😀\r\ntwo\nthree");
	});

	it("rejects malformed or non-text embedded resources", () => {
		const cases: Array<[MessageAttachment, RegExp]> = [
			[embedded("%%%"), /valid base64/],
			[embedded(null as never), /valid base64/],
			[embedded(Buffer.from([0xc3, 0x28]).toString("base64")), /valid UTF-8/],
			[
				embedded(Buffer.from("one line").toString("base64"), {
					selection: { range: { start: { line: 3, character: 0 }, end: { line: 3, character: 1 } } },
				}),
				/invalid selection/,
			],
			[
				embedded(Buffer.from("one line").toString("base64"), {
					selection: { range: { start: { line: 0, character: 4 }, end: { line: 0, character: 2 } } },
				}),
				/invalid selection/,
			],
		];

		for (const [attachment, reason] of cases) {
			assert.match(messageRejectionReason(message([attachment])) ?? "", reason);
		}
	});

	it("rejects annotations and chat attachments", () => {
		const attachments: MessageAttachment[] = [
			{ type: MessageAttachmentKind.Annotations, label: "diagnostics", resource: "ahp-annotations:/fixture" },
			{ type: MessageAttachmentKind.Chat, label: "other chat", resource: "ahp-chat:/fixture" },
		];

		for (const attachment of attachments) {
			assert.match(messageRejectionReason(message([attachment])) ?? "", /does not support/);
		}
	});
});
