import type { TerminalInfo, TerminalState, URI } from "@microsoft/agent-host-protocol";

/** Root catalogue projection; terminal process handles never enter protocol state. */
export function terminalInfo(resource: URI, state: TerminalState): TerminalInfo {
	return {
		resource,
		title: state.title,
		claim: state.claim,
		lifecycle: state.lifecycle,
	};
}
