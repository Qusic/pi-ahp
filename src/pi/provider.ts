/**
 * Identity of the agent this host serves.
 *
 * Lives on the pi side because that is what it names. It used to sit in the
 * root channel module, which meant three pi modules imported *upward* into the
 * channel layer just to read a constant about themselves.
 */

/** The single `AgentInfo.provider` this host advertises. */
export const PI_PROVIDER = "pi";
