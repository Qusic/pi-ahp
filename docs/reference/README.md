# Reference material (local only)

This folder holds **vendored reference documentation** used while working on
`pi-ahp`. It is **not part of the contribution** and is deliberately
git-ignored (see [../../.gitignore](../../.gitignore)). Everything here is a
copy of upstream material that is version-controlled in its own repository; we
do not track it in `pi-ahp` to keep contribution PRs clean and mergeable.

## AHP protocol specification

`ahp-protocol/` is a copy of the official Agent Host Protocol documentation:

- `ahp-protocol/specification/` — the normative spec (lifecycle, transport,
  subscriptions, channels, versioning, …).
- `ahp-protocol/guide/` — the conceptual guide (what is AHP, doctrine,
  state model, clients, hosts, …).

- **Pinned protocol version:** `0.9.0` — the version `pi-ahp` currently speaks
  (see `src/protocol/version.ts` and the AHP support table in
  [../../README.md](../../README.md)).
- **Upstream source of truth:** the `microsoft/agent-host-protocol` monorepo,
  cloned locally at `D:\AI-Agents\agent-host-protocol`.
- **Live documentation:** <https://microsoft.github.io/agent-host-protocol/specification/overview>
- **Protocol TypeScript source** (the `@microsoft/agent-host-protocol` npm
  package `pi-ahp` depends on): `D:\AI-Agents\agent-host-protocol\clients\typescript`,
  with the canonical type definitions in `D:\AI-Agents\agent-host-protocol\types`.

> The internal links inside `ahp-protocol/**` point at the live docs site, not
> at this local copy. Treat the live site as canonical; the local copy exists
> so you can read and search the spec offline.

## pi coding agent source

`pi-ahp` embeds **pi** as an SDK dependency
(`@earendil-works/pi-coding-agent` / `@earendil-works/pi-ai`). pi's real source
is **not** in this repo and must never be copied into it — see
[../pi-integration-boundary.md](../pi-integration-boundary.md).

- **Local pi checkout (reference only, do not commit):** `D:\AI\pi` (the
  `pi-monorepo`; package folders under `D:\AI\pi\packages`, e.g. `coding-agent`,
  `ai`).

## Regenerating the vendored copy

```sh
# refresh the AHP spec/guide from the upstream clone
cp -R "D:\AI-Agents\agent-host-protocol/docs/specification" docs/reference/ahp-protocol/specification
cp -R "D:\AI-Agents\agent-host-protocol/docs/guide"         docs/reference/ahp-protocol/guide
```

(Windows: use `Copy-Item -Recurse` in PowerShell instead of `cp -R`.)
