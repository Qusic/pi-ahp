import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { prepareImagesForPi } from "../src/pi/image-input.ts";
import { TWO_PIXEL_BMP } from "./support/images.ts";

describe("pi image input", () => {
	it("converts an unsupported image type even when auto-resize is disabled", async () => {
		const prepared = await prepareImagesForPi([{ type: "image", data: TWO_PIXEL_BMP, mimeType: "image/bmp" }], false);

		assert.ok(prepared);
		assert.equal(prepared.length, 1);
		assert.equal(prepared[0]?.mimeType, "image/png");
		assert.deepEqual(
			Buffer.from(prepared[0]?.data ?? "", "base64").subarray(0, 8),
			Buffer.from("89504e470d0a1a0a", "hex"),
		);
	});

	it("fails when image bytes cannot be prepared", async () => {
		await assert.rejects(
			prepareImagesForPi(
				[{ type: "image", data: Buffer.from("not an image").toString("base64"), mimeType: "image/png" }],
				true,
			),
			/could not be prepared/,
		);
	});
});
