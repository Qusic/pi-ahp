/**
 * Normalizes client-provided images before they enter a pi AgentSession.
 *
 * AgentSession accepts already-prepared ImageContent blocks; pi's CLI performs
 * conversion and resizing one layer earlier. This host is another input layer,
 * so it applies the same public image utilities and honours pi's auto-resize
 * setting rather than relying on every AHP client to know provider limits.
 */

import type { ImageContent } from "@earendil-works/pi-ai";
import { convertToPng, resizeImage } from "@earendil-works/pi-coding-agent";
import { normalizeImageMimeType } from "./image-mime.ts";

const SUPPORTED_INLINE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

async function prepareImage(image: ImageContent, autoResize: boolean, index: number): Promise<ImageContent> {
	let data = image.data;
	let mimeType = normalizeImageMimeType(image.mimeType);
	if (!mimeType) {
		throw new Error(`Image ${index + 1} has an invalid MIME type: ${image.mimeType}`);
	}

	if (!SUPPORTED_INLINE_TYPES.has(mimeType)) {
		const converted = await convertToPng(data, mimeType);
		if (!converted) {
			throw new Error(`Image ${index + 1} could not be converted from ${mimeType}`);
		}
		data = converted.data;
		mimeType = converted.mimeType;
	}

	if (!autoResize) {
		return { type: "image", data, mimeType };
	}

	const resized = await resizeImage(Buffer.from(data, "base64"), mimeType);
	if (!resized) {
		throw new Error(`Image ${index + 1} could not be prepared for inline model input`);
	}
	return { type: "image", data: resized.data, mimeType: resized.mimeType };
}

/** Processes sequentially so several large images do not start several WASM workers at once. */
export async function prepareImagesForPi(
	images: readonly ImageContent[] | undefined,
	autoResize: boolean,
): Promise<ImageContent[] | undefined> {
	if (!images || images.length === 0) {
		return undefined;
	}
	const prepared: ImageContent[] = [];
	for (const [index, image] of images.entries()) {
		prepared.push(await prepareImage(image, autoResize, index));
	}
	return prepared;
}
