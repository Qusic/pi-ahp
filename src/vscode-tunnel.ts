/**
 * What VS Code requires of a dev tunnel before it will treat it as an agent
 * host. Every value here is fixed on its side, so none is configurable on ours.
 *
 * Transcribed from `platform/agentHost/common/tunnelAgentHost.ts` and
 * `platform/agentHost/node/tunnelAgentHostService.ts`. Kept apart from the
 * command that uses them so they can be tested without running it.
 */

import { createHash } from "node:crypto";

/**
 * `TUNNEL_LAUNCHER_LABEL` — the label both of VS Code's tunnel lists filter on.
 *
 * On its own it marks a VS Code *server* tunnel, the kind Remote Dev offers to
 * open a window on. {@link PROTOCOL_LABEL} is what turns it into an agent host.
 */
export const LAUNCHER_LABEL = "vscode-server-launcher";

/**
 * `TUNNEL_MIN_PROTOCOL_VERSION` as a `protocolvN` label.
 *
 * Carrying it alongside {@link LAUNCHER_LABEL} moves the tunnel from Remote
 * Dev's list into the agent host list — the two are exclusive. Measured over
 * all four combinations of the two labels:
 *
 *     (none)                        neither list
 *     protocolv5                    neither list
 *     vscode-server-launcher        Remote Dev only
 *     both                          agent host only
 *
 * `TunnelTags` defaults the version to 2 when no `protocolvN` label is present,
 * which is what keeps a plain server tunnel out of the agent list. The number
 * versions this tunnel arrangement, not the agent protocol; AHP's own version
 * is negotiated later by `initialize`.
 */
export const PROTOCOL_LABEL = "protocolv5";

/** `TUNNEL_AGENT_HOST_PORT` — the only port VS Code will look for. */
export const TUNNEL_PORT = 31546;

/**
 * Marks a tunnel as this host's, so a later run finds the same one.
 *
 * Underscore-prefixed on purpose: `TunnelTags` takes the first label that is
 * not the launcher label, not a `protocolvN` tag, and does not start with `_`
 * as the tunnel's display name. Keeping the identity out of that competition
 * means a user can rename the tunnel — in VS Code or with `devtunnel` — without
 * the next run losing track of it and making a second one.
 *
 * Underscore labels are inert to discovery: a probe carrying `_flag3` (which
 * VS Code puts on its own) behaved identically to one without.
 */
export const IDENTITY_LABEL = "_pi_ahp";

/**
 * The label VS Code will show for this tunnel, or `undefined` when its labels
 * name nothing and it falls back to the tunnel's own name or id.
 *
 * Transcribed from `TunnelTags`; see {@link IDENTITY_LABEL} for why that
 * distinction matters here.
 */
export function displayLabel(labels: readonly string[]): string | undefined {
	return labels.find((label) => !label.startsWith("_") && label !== LAUNCHER_LABEL && !label.startsWith("protocolv"));
}

/**
 * Folds a user-supplied name into something usable as a label.
 *
 * VS Code applies the same shape to its own tunnel names
 * (`tunnelHostMainService._getTunnelName`): strip leading dashes, drop anything
 * outside `\w-`, cap at 20.
 */
export function nameLabel(name: string): string | undefined {
	const slug = name
		.replace(/^-+/g, "")
		.replace(/[^\w-]/g, "")
		.substring(0, 20);
	return slug || undefined;
}

/**
 * Splits the `devtunnel` CLI's fully-qualified id into its parts.
 *
 * The CLI prints and accepts `<id>.<cluster>`, but the REST contract keeps them
 * apart — `tunnelId` is documented as "unique within the cluster" — and VS Code
 * reads `tunnel.tunnelId` and `tunnel.clusterId` as separate fields. Deriving
 * the token from the dotted form would hash a string VS Code never sees.
 */
export function splitTunnelId(qualified: string): { tunnelId: string; clusterId: string | undefined } {
	const dot = qualified.indexOf(".");
	return dot < 0
		? { tunnelId: qualified, clusterId: undefined }
		: { tunnelId: qualified.slice(0, dot), clusterId: qualified.slice(dot + 1) };
}

/**
 * The token VS Code will present on the upgrade.
 *
 * It is never exchanged: both sides compute it from the tunnel id, so this has
 * to match `deriveConnectionToken` exactly or every connection is a 401. The
 * leading-dash fixup is theirs — base64url can start with `-`, which some
 * readers take for a flag.
 *
 * Takes the bare id, not the CLI's `<id>.<cluster>` form.
 */
export function deriveConnectionToken(tunnelId: string): string {
	const digest = createHash("sha256").update(tunnelId).digest("base64url");
	return digest.startsWith("-") ? `a${digest}` : digest;
}
