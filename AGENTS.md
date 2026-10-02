# AGENTS.md — pi-ahp

Guidance for AI coding agents (and human contributors) working in this
repository.

## What this is

`pi-ahp` is an [Agent Host Protocol (AHP)](https://microsoft.github.io/agent-host-protocol/)
**host** that embeds the [pi coding agent](https://github.com/earendil-works/pi)
and exposes pi's sessions to AHP clients over WebSocket. It speaks AHP
**0.9.0**.

## Read these first

Before making non-trivial changes, read the architecture docs:

- **[docs/architecture.md](docs/architecture.md)** — the layered design, the
  AHP core engine, the pi adapter, transport, and an end-to-end request
  walkthrough.
- **[docs/pi-integration-boundary.md](docs/pi-integration-boundary.md)** — the
  pi/pi-ahp boundary. **Read this before touching anything near `src/pi/`.**
- **[docs/reference/](docs/reference/README.md)** — local, git-ignored copies of
  the AHP spec and guide for offline reading (source of truth is upstream).

## The one rule that matters most

**`src/pi/` is NOT pi's source code.** It is pi-ahp's own adapter layer that
consumes pi as an npm SDK dependency (`@earendil-works/pi-coding-agent`,
`@earendil-works/pi-ai`). pi's real source is a separate monorepo — never copy
it into this repo.

Layer discipline (enforce in review):

- `src/core` and `src/protocol` are the **pi-agnostic AHP core**. They may
  import `@microsoft/agent-host-protocol` only — **never**
  `@earendil-works/pi-*`.
- `src/pi` is the **only** layer allowed to import pi.
- All pi access is funneled through the narrow `PiBackend` interface
  (`src/pi/chat-driver.ts`); the concrete `AgentSession` lives only in
  `src/pi/in-process-backend.ts`.

If you find yourself importing a pi package in `src/core`, you're in the wrong
layer — stop.

## Commands

Node 24+. pnpm workspace.

```sh
pnpm install
pnpm test          # node --test across test/ (serial files run with concurrency 1)
pnpm check         # tsc type-check
pnpm lint          # biome check
pnpm format        # biome check --write
pnpm build         # tsc build to dist/
node src/bin/cli.ts --help      # run the host (dev)
```

## Local-only reference material (do not commit)

`docs/reference/` holds vendored copies of the upstream AHP spec/guide. It is
**git-ignored on purpose** so contribution PRs stay clean and mergeable. The
regeneration steps are in
[docs/reference/README.md](docs/reference/README.md). Upstream checkouts:

- AHP: `D:\AI-Agents\agent-host-protocol`
- pi: `D:\AI\pi`

Contribution rule: a PR should contain only your actual changes to the
`pi-ahp` source and the tracked docs above — never the vendored reference
material or any pi source.

## Contributing

- This is under active development; expect rough edges.
- Keep the mapper (`src/pi/event-mapper.ts`) pure — replay tests depend on it.
- The host is the sole source of truth and ordering; agent output flows through
  `AhpHost.dispatchServerAction` → reducer → `serverSeq` → broadcast.
- Keep the AHP support table in [README.md](README.md) in sync when a feature's
  supported status changes.
