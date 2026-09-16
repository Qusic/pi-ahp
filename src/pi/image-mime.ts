/** Normalizes MIME values at the AHP/pi image boundary. */
export function normalizeImageMimeType(mimeType: string): string | undefined {
	const base = mimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
	if (!base.startsWith("image/")) {
		return undefined;
	}
	return base === "image/jpg" ? "image/jpeg" : base;
}
