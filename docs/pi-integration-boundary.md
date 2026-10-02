# pi integration boundary

> **The `src/pi/` folder is NOT pi's source code.** It is `pi-ahp`'s own
> **adapter layer** that consumes pi as an SDK dependency. Do not copy pi's
> source into this repository, and do not let pi's types leak into the AHP core.

This document pins down exactly where pi ends and pi-ahp begins, because that
boundary is the thing a contributor is most likely to get wrong.

## Why this confusion is easy to have

The folder is literally named `src/pi/`. It is full of names like
`session-registry`, `session-storage`, `session-hydrator`, `history`, `models`,
`turn-paging`. Those sound like they could be pi internals. They are not — they
are pi-ahp's code that *wraps* pi's session concepts.

## The facts

**pi-ahp depends on pi as published npm packages:**

```jsonc
// package.json
{
  "dependencies": {
    "@earendil-works/pi-ai": "0.87.1",
    "@earendil-works/pi-coding-agent": "0.87.1",
    "@microsoft/agent-host-protocol": "0.9.0",
    // ...
  }
}
```

`pi-ahp` imports **only** from these two pi packages (and the AHP package). A
grep of the repo confirms every pi import is one of
`@earendil-works/pi-ai` or `@earendil-works/pi-coding-agent`:

- `@earendil-works/pi-coding-agent` — the `AgentSession`,
  `createAgentSessionServices`, `createAgentSessionFromServices`,
  `SessionManager`, `SettingsManager`, `ModelRuntime` surface.
- `@earendil-works/pi-ai` — model / content / thinking-level helpers
  (`ImageContent`, `clampThinkingLevel`, …).

**No pi source file lives in `pi-ahp`.** None of pi's internals
(`session-manager`, `agent-loop`, providers, tool implementations, …) are
copied in. If a file that looks like pi internals appears in this repo, that is
a bug, not a feature.

**pi's real source** is a separate monorepo (`pi-monorepo`), locally checked
out for reference at `D:\AI\pi`. Its packages live under
`D:\AI\pi\packages/<folder>` (short folder names: `coding-agent`, `ai`,
`agent`, `client`, `codemode`, `mcp`, `server`, …) and publish as
`@earendil-works/pi-*`. When you need to understand what a pi API does, read
that checkout — **do not vendor it here.**

> Note: the local `D:\AI\pi` checkout may be at a different version than the
> `0.87.1` pi-ahp actually consumes from npm. If the two diverge, trust the
> installed `node_modules` (or the npm tarball) for the exact API surface
> `pi-ahp` compiles against, and use `D:\AI\pi` to understand intent.

## The seam: `PiBackend`

The entire pi dependency is funneled through one narrow interface,
`src/pi/chat-driver.ts`:

```ts
export interface PiBackend {
  subscribe(listener: (event: AgentSessionEvent) => void): () => void;
  prompt(text: string, images?: ImageContent[], signal?: AbortSignal): Promise<void>;
  steer(text: string, images?: ImageContent[], signal?: AbortSignal): Promise<void>;
  abort(): Promise<void>;
  selectModel?(selection: ModelSelection): Promise<void>;
  currentSelection?(): ModelSelection | undefined;
  truncate?(entryId: string): Promise<boolean>;
  dispose?(): void;
}
```

The production implementation, `InProcessPiBackend` (`src/pi/in-process-backend.ts`),
is the **only** place a concrete pi `AgentSession` is constructed. It exists so
that the event mapper and the chat driver never import pi's concrete types —
they program against `PiBackend`. If you ever want a subprocess pi backend, you
implement the same interface; nothing upstream of it changes.

## Layer rules (enforce these in review)

| Layer | May import |
| --- | --- |
| `src/core`, `src/protocol` | `@microsoft/agent-host-protocol` only. **Never** `@earendil-works/pi-*`. |
| `src/channels` | AHP + `src/core`. No direct pi import. |
| `src/pi` | AHP + `@earendil-works/pi-*` + `src/core`. This is the **only** layer allowed to touch pi. |
| `src/host`, `src/transport`, `src/bin`, `src/tunnel` | AHP + the layers above. `pi-host.ts` is the composition root that wires `src/pi` services into the core's capability interfaces. |

**Red flag checklist** (stop and reconsider if any are true):

- A new `import ... from "@earendil-works/pi-ai"` or `.../pi-coding-agent`
  appears in `src/core/**` or `src/protocol/**`.
- A file is being added that looks like pi's own internal module rather than a
  thin adapter.
- A concrete pi type (e.g. `AgentSession`) appears in a signature outside
  `src/pi/in-process-backend.ts`.
- pi's event/state types are imported into `src/core` (they should only flow
  into `src/pi/event-mapper.ts` and be translated to AHP `StateAction`s).

## What "embedding pi in-process" actually means

`InProcessPiBackend.create` calls pi's `createAgentSessionServices` then
`createAgentSessionFromServices`, and holds the resulting `AgentSession` for
the life of the session. It does **not** spawn `pi --mode rpc`. The comment in
`in-process-backend.ts` explains why: a subprocess would add process-lifecycle
and stdio backpressure without isolating provider credentials or user
resources. The narrow `PiBackend` seam keeps those concerns out of the mapper
and the driver.
