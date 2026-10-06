/**
 * Protocol version negotiation.
 *
 * The client offers `InitializeParams.protocolVersions`; the server picks the
 * highest compatible SemVer entry and echoes it back as
 * `InitializeResult.protocolVersion`. If there is no overlap the server MUST
 * return `UnsupportedProtocolVersion` (-32005) rather than a result.
 *
 * @see https://microsoft.github.io/agent-host-protocol/specification/versioning
 */

import {
	AhpErrorCodes,
	SUPPORTED_PROTOCOL_VERSIONS,
	negotiateProtocolVersion as selectProtocolVersion,
} from "@microsoft/agent-host-protocol";
import { ProtocolError } from "./errors.ts";

/**
 * Supports the SDK's released 1.0 and 0.9 compatibility baselines. No 1.0-only
 * actions or fields are published yet, so both clients see the same 0.9 surface.
 *
 * @throws {ProtocolError} `UnsupportedProtocolVersion` when there is no overlap.
 */
export function negotiateProtocolVersion(offered: readonly string[] | undefined): string {
	if (!Array.isArray(offered) || offered.length === 0 || offered.some((version) => typeof version !== "string")) {
		throw ProtocolError.invalidParams("initialize requires a non-empty protocolVersions array of strings");
	}
	let selected: string | undefined;
	try {
		selected = selectProtocolVersion(offered);
	} catch {
		throw ProtocolError.invalidParams("protocolVersions must contain valid MAJOR.MINOR.PATCH versions");
	}
	if (selected) return selected;
	throw new ProtocolError(
		AhpErrorCodes.UnsupportedProtocolVersion,
		`No mutually supported protocol version. Offered: ${offered.join(", ")}`,
		{ supportedVersions: [...SUPPORTED_PROTOCOL_VERSIONS] },
	);
}
