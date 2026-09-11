# pi-ahp

[![CI](https://github.com/Qusic/pi-ahp/actions/workflows/ci.yml/badge.svg?branch=main&event=push)](https://github.com/Qusic/pi-ahp/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/pi-ahp)](https://www.npmjs.com/package/pi-ahp)
[![pi](https://img.shields.io/npm/dependency-version/pi-ahp/@earendil-works/pi-coding-agent?label=pi)](https://github.com/earendil-works/pi)
[![AHP](https://img.shields.io/npm/dependency-version/pi-ahp/@microsoft/agent-host-protocol?label=AHP)](https://github.com/microsoft/agent-host-protocol)
[![License](https://img.shields.io/npm/l/pi-ahp)](LICENSE)

`pi-ahp` is an [Agent Host Protocol](https://github.com/microsoft/agent-host-protocol) host for the [pi coding agent](https://github.com/earendil-works/pi).

It embeds pi and makes its sessions available to AHP clients over WebSocket. Interoperability is primarily tested with [Agent Host support in Visual Studio Code](https://code.visualstudio.com/docs/agents/concepts/agent-host) and [Agent Console for iPhone and iPad](https://qusic.github.io/agent-console/), but the host is not limited to either client.

The project is under active development; expect rough edges and occasional instability. Contributions are welcome.

## Requirements

- Node.js 24 or later
- At least one model provider configured for pi

## Usage

```sh
npm install --global pi-ahp
```

`pi-ahp` starts a direct WebSocket listener and prints its connection URL:

```sh
pi-ahp
```

On first run, it creates `~/.pi/ahp/settings.json` with a free port and a random token, for example:

```json
{
  "host": "127.0.0.1",
  "port": 32145,
  "token": "<generated token>"
}
```

The token is optional and may be set to `null`. The host and port can also be overridden for one run:

```sh
pi-ahp --host 127.0.0.1 --port 31546
```

Enter the printed URL in an AHP client. In VS Code, run **Sessions: Add Remote Agent Host...** from the Command Palette.

`pi-ahp-tunnel` instead creates or reuses a Microsoft Dev Tunnel that VS Code can discover. It requires the [`devtunnel` CLI](https://aka.ms/devtunnels/download) and does not use the direct-listener settings:

```sh
devtunnel user login
pi-ahp-tunnel
```

Sign in to the same account in VS Code, then run **Sessions: Connect to Remote Agent Host via Dev Tunnel**. If the remote-host commands are unavailable, set `"chat.remoteAgentHostsEnabled": true` in VS Code's `settings.json`.

Run either command with `--help` for all available options.

## AHP support

The following is a high-level mapping to the [official AHP specification](https://microsoft.github.io/agent-host-protocol/specification/overview).

Currently supported protocol versions: **0.9.0**

🟢 Supported · 🟡 Planned · 🔴 Out of scope

| Feature | Status | Notes |
| --- | :---: | --- |
| Connection lifecycle and reconnect | 🟢 | Active work survives a temporary connection loss, but not a host restart |
| Durable sessions and history | 🟢 | Completed history for the active conversation branch recovers after restart |
| Streaming chat and pi tool calls | 🟢 | One chat per session |
| Steering, queues, drafts, and truncation | 🟢 | Drafts and unconsumed queues do not survive a host restart |
| Models, session setup, and completions | 🟢 | Model and thinking-level selection, working directory, and `@` file completions |
| Text attachments | 🟢 | Client-provided text, local file references, and embedded UTF-8 text |
| Files and watches | 🟢 | Host-local `file:` resources only |
| Interactive terminals | 🟢 | Client-owned; terminals and scrollback end when the host stops |
| Images and vision | 🟡 | Pass AHP image attachments to vision-capable pi models |
| Tool catalogue and client tools | 🟡 | Show available pi tools and let connected clients contribute tools |
| pi customizations | 🟡 | Show and configure loaded extensions, skills, and prompt templates |
| Changeset views | 🟡 | Expose uncommitted workspace changes |
| Terminal command detection | 🟡 | Group terminal output by command and exit status |
| Persistent read and archive controls | 🔴 | pi sessions do not store this metadata |
| Multiple chats or working directories | 🔴 | A pi session has one active branch and cwd; branches are not simultaneous AHP chats |
| Custom agents | 🔴 | pi sub-agents are extension tools rather than selectable agents |
| Elicitation | 🔴 | pi extension dialogs are not persisted as turn input |
| Tool input and result confirmation | 🔴 | pi has no built-in permission policy |
| Errored-turn resume | 🔴 | pi cannot reopen a finalized turn |
| MCP lifecycle and Apps | 🔴 | pi has no built-in MCP runtime; extension implementations are opaque |
| Annotations | 🔴 | There is no corresponding pi session state |
| Automations and automation runs | 🔴 | pi has no scheduler or automation-run model |
| AHP protected-resource authentication | 🔴 | pi manages model-provider credentials itself |
| OTLP telemetry channels | 🔴 | pi does not provide host telemetry as OTLP |

## License

[MIT](LICENSE)
