import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
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
	it("appends a file resource as a path with its selection", () => {
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
		assert.equal(messageTextForPi(input), `question\n\n${fileURLToPath("file:///outside.ts")}:5:3-9:1`);
	});

	it("appends attachment representations in order", () => {
		const input = message([
			{ type: MessageAttachmentKind.Simple, label: "first", modelRepresentation: "first context" },
			{ type: MessageAttachmentKind.Resource, label: "path", uri: "file:///path.ts" },
			{ type: MessageAttachmentKind.Simple, label: "second", modelRepresentation: "second context" },
		]);

		assert.equal(
			messageTextForPi(input),
			`question\n\nfirst context\n\n${fileURLToPath("file:///path.ts")}\n\nsecond context`,
		);
	});

	it("preserves resource URIs whose schemes may carry their own routing", () => {
		for (const uri of ["https://example.com/context.txt", "virtual://client/context.txt?revision=1"]) {
			const input = message([{ type: MessageAttachmentKind.Resource, label: "remote", uri }]);
			assert.equal(messageTextForPi(input), `question\n\n${uri}`);
		}
	});

	it("preserves a VS Code-wrapped resource without guessing which host owns it", () => {
		const wrapped = "vscode-agent-host://another-host/Users/user/project/some%20file.ts?_ah%3DeyJzY2hlbWUiOiJmaWxlIn0";
		assert.equal(
			messageTextForPi(message([{ type: MessageAttachmentKind.Resource, label: "some file.ts", uri: wrapped }])),
			`question\n\n${wrapped}`,
		);
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

	it("keeps embedded payload under its original 1-based selection marker", () => {
		const input = message([
			embedded(Buffer.from("selected text", "utf8").toString("base64"), {
				selection: {
					range: {
						start: { line: 20, character: 3 },
						end: { line: 20, character: 16 },
					},
				},
			}),
		]);

		assert.equal(messageTextForPi(input), "question\n\n[selection 21:4-21:17]\nselected text");
	});

	it("rejects malformed or non-text embedded payloads", () => {
		const cases: Array<[MessageAttachment, RegExp]> = [
			[embedded("%%%"), /valid base64/],
			[embedded(null as never), /valid base64/],
			[embedded(Buffer.from([0xc3, 0x28]).toString("base64")), /valid UTF-8/],
		];

		for (const [attachment, reason] of cases) {
			assert.match(messageRejectionReason(message([attachment])) ?? "", reason);
		}
	});

	it("rejects malformed message and selection shapes without throwing", () => {
		const malformed: Array<[unknown, RegExp]> = [
			[null, /requires text and an origin/],
			[{ text: 42, origin: { kind: MessageKind.User } }, /requires text and an origin/],
			[{ text: "x", origin: { kind: MessageKind.User }, attachments: {} }, /must be an array/],
			[message([null as never]), /requires a type and label/],
			[
				message([
					{
						type: MessageAttachmentKind.Resource,
						label: "bad range",
						uri: "file:///bad",
						selection: { range: { start: { line: -1, character: 0 }, end: { line: 0, character: 0 } } },
					},
				]),
				/invalid text selection/,
			],
			[message([embedded("", { contentType: undefined as never })]), /requires a content type/],
		];

		for (const [input, reason] of malformed) {
			assert.match(messageRejectionReason(input) ?? "", reason);
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
