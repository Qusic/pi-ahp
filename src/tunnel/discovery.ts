/** Shared Agent Host Dev Tunnel discovery contract plus pi-ahp's private labels. */

/** Required for clients using the VS Code-compatible discovery convention. */
export const LAUNCHER_LABEL = "vscode-server-launcher";

/**
 * Protocol 5 selects direct forwarding. Protocol 6 expects an
 * `/agent-host/select` gateway, which a plain `devtunnel` port forward cannot
 * provide. VS Code appends a tunnel-id-derived `tkn` on the v5 path; pi-ahp
 * ignores it and relies on the Dev Tunnel access boundary.
 *
 * This versions the tunnel arrangement, not AHP itself.
 */
export const PROTOCOL_LABEL = "protocolv5";

/** The fixed forwarded port used by the discovery convention. */
export const TUNNEL_PORT = 31546;

/**
 * Finds this host's tunnel on later runs without becoming its display name.
 * Compatible clients exclude underscore-prefixed labels from that name.
 */
export const IDENTITY_LABEL = "_pi_ahp";

/** Returns the client-facing tunnel name, when one exists. */
export function displayLabel(labels: readonly string[]): string | undefined {
	return labels.find((label) => !label.startsWith("_") && label !== LAUNCHER_LABEL && !label.startsWith("protocolv"));
}

/** Applies the discovery convention's normalization to a user-supplied name. */
export function nameLabel(name: string): string | undefined {
	const slug = name
		.replace(/^-+/g, "")
		.replace(/[^\w-]/g, "")
		.substring(0, 20);
	return slug || undefined;
}
