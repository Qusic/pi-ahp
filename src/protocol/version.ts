/**
 * Protocol version negotiation for `initialize`.
 *
 * The SDK selects the version. This module checks the client's offer and
 * reports the SDK's outcome as the errors the spec requires.
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
 * Returns the version the SDK selects from the client's offer.
 *
 * @throws {ProtocolError} `InvalidParams` for a malformed offer, or
 * `UnsupportedProtocolVersion` with the SDK's supported versions when it
 * selects none.
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
