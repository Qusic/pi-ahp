/**
 * Protocol version negotiation.
 *
 * The client offers `InitializeParams.protocolVersions` most-preferred first;
 * the server picks the first entry it can speak and echoes it back as
 * `InitializeResult.protocolVersion`. If there is no overlap the server MUST
 * return `UnsupportedProtocolVersion` (-32005) rather than a result.
 *
 * @see https://microsoft.github.io/agent-host-protocol/specification/versioning
 */

import { AhpErrorCodes, SUPPORTED_PROTOCOL_VERSIONS } from "@microsoft/agent-host-protocol";
import { ProtocolError } from "./errors.ts";

/** Versions this host speaks, most-preferred first. */
const HOST_SUPPORTED_VERSIONS: readonly string[] = SUPPORTED_PROTOCOL_VERSIONS;

/**
 * Picks the client's most-preferred version that this host also speaks.
 *
 * @throws {ProtocolError} `UnsupportedProtocolVersion` when there is no overlap.
 *   The error `data` advertises what the host can speak so the client can
 *   decide whether to downgrade.
 */
export function negotiateProtocolVersion(offered: readonly string[] | undefined): string {
	if (!Array.isArray(offered) || offered.length === 0) {
		throw ProtocolError.invalidParams("initialize requires a non-empty protocolVersions array");
	}
	for (const candidate of offered) {
		if (HOST_SUPPORTED_VERSIONS.includes(candidate)) {
			return candidate;
		}
	}
	throw new ProtocolError(
		AhpErrorCodes.UnsupportedProtocolVersion,
		`No mutually supported protocol version. Offered: ${offered.join(", ")}`,
		{ supportedVersions: [...HOST_SUPPORTED_VERSIONS] },
	);
}
