<p align="center">
  <img src="resources/icon.png" alt="Ling logo" width="128">
</p>
<p align="center">A desktop and Web workspace for the <a href="https://github.com/earendil-works/pi">Pi coding agent</a>.</p>
<p align="center">
  <a href="https://github.com/tyql688/ling/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/tyql688/ling/ci.yml?style=flat-square&branch=main" /></a>
  <a href="LICENSE"><img alt="Code license" src="https://img.shields.io/badge/code-MIT-blue?style=flat-square" /></a>
</p>
<p align="center">English | <a href="README.zh-CN.md">简体中文</a> | <a href="README.ja.md">日本語</a> | <a href="README.ko.md">한국어</a></p>

Ling brings Pi conversations, project files, change review and terminals into one workspace. The Electron app and browser client share the same interface and local Host. Ling embeds the Pi SDK directly and uses Pi's default `~/.pi/agent` directory, so existing credentials, models, packages, skills and settings remain available alongside the CLI.

## Features

- Conversations support streaming responses, model and thinking controls, session history, forks, queued messages and context compaction. Start without a project or open a folder to work on its files.
- Read files in an independent area with Monaco editing, language support, Git history, diffs and review annotations. The conversation and its draft stay open while you read.
- Run project terminals, background commands and scheduled agent tasks.
- Manage Pi packages, extensions, skills and prompts, and reload them into open projects and sessions. Ling displays Pi extension prompts and status in its shared interface.
- The [built-in features](docs/design.md) are Todo, access mode, local voice input, MCP services with global/project configuration, questions, background tasks and schedules. Each has its own switch under Plugins in Settings. Voice is off by default. MCP follows Pi’s global extension selection; upgrades preserve the saved choice. Pi-installed packages take precedence over bundled copies.
- Choose light/dark themes and built-in or custom declarative skins. View token/cost statistics and supported provider quotas. Application languages include English, Simplified Chinese, Japanese and Korean.

## Run from source

Install Git and the Node.js and pnpm versions declared in [package.json](package.json).

The macOS desktop app requires macOS 13 or newer.

Windows installers use Ling's fixed self-signed release certificate. Windows may show an unknown-publisher or SmartScreen prompt during the first installation. The installed app checks for updates automatically, downloads them by default, and installs them on restart or normal quit. Automatic downloads can be disabled in Settings. Versions with manual-only updates need a one-time installation from [Releases](https://github.com/tyql688/ling/releases/latest).

```sh
git clone https://github.com/tyql688/ling.git
cd ling
pnpm install --frozen-lockfile
pnpm dev
```

Start the browser client with:

```sh
pnpm dev:web
```

Open the authenticated local URL printed by Host. Its fragment contains a private access token. The browser works with directories on the Host machine; the desktop app also provides native folder dialogs. Both clients use the same project, session and file services.

On first launch, configure a provider under Models in Settings with OAuth or an API key, then start a conversation with "No project" or open a project folder. Conversations without a project share Ling's persistent working directory. Existing Pi authentication is reused. Installing a separate Pi CLI executable is optional; model requests use the embedded SDK and may incur provider charges.

Host binds to loopback by default. Pi retains ownership of its credentials, settings and session files. Ling stores application state separately, including SQLite metadata and built-in feature state. See [Architecture](docs/architecture.md) and [Development](docs/development.md) for data ownership and isolated runs.

## Technology and libraries

Workspace manifests list direct dependencies, and [pnpm-lock.yaml](pnpm-lock.yaml) pins their resolved versions.

| Area | Technologies and libraries |
| --- | --- |
| Language and workspace | TypeScript, pnpm workspaces; TypeScript 7 for compilation and language services, a separate TypeScript 6 compatibility dependency for ESLint |
| Agent runtime | [`@earendil-works/pi-coding-agent`](https://github.com/earendil-works/pi/tree/main/packages/coding-agent); bundled [`@juicesharp/rpiv-todo`](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-todo#readme), [`@gotgenes/pi-permission-system`](https://github.com/gotgenes/pi-packages/tree/main/packages/pi-permission-system#readme), [`@earendil-works/pi-voice`](https://github.com/earendil-works/pi-voice#readme) and [official Pi MCP / Codemode / tool search](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/mcp.md) adapters |
| Desktop | Electron, electron-vite, electron-builder, electron-updater, node-mac-permissions |
| Web and state | React 19, Vite, Jotai, jotai-family |
| Interface | Tailwind CSS 4, Radix UI, Floating UI, Motion, cmdk, react-resizable-panels |
| Editing and rendering | Monaco Editor, Tiptap/ProseMirror, Markstream, Shiki, Pierre Diffs, Mermaid, KaTeX |
| Lists and visualization | TanStack Virtual, use-stick-to-bottom, Recharts |
| Terminal and project files | xterm.js, node-pty, Parcel Watcher, simple-git, diff |
| Transport and validation | WebSocket (`ws`, PartySocket), `birpc` worker RPC, Zod; vscode-jsonrpc and the Language Server Protocol for editor services |
| Persistence and concurrency | Node.js SQLite (`node:sqlite`), write-file-atomic, proper-lockfile, p-limit, lru-cache |
| Localization and icons | i18next, react-i18next, Lucide, LobeHub icons, Material Icon Theme |
| Quality checks | Vitest, ESLint, typescript-eslint, Prettier, GitHub Actions |

## Repository layout

| Directory | Responsibility |
| --- | --- |
| [`apps/web`](apps/web/package.json) | Shared React interface, feature state and browser/native adapters |
| [`apps/desktop`](apps/desktop/package.json) | Native window, OS integration, updates and Host supervision |
| [`packages/host`](packages/host/package.json) | Projects, sessions, files, Git, terminals, persistence and worker supervision |
| [`packages/core`](packages/core/package.json) | Pi SDK adaptation and shared business data processing |
| [`packages/contracts`](packages/contracts/package.json) | Data types, validation and protocol declarations usable in browsers |
| [`packages/node-runtime`](packages/node-runtime/package.json) | Atomic file publication, launch logs and process cleanup |
| [`packages/builtin-extensions`](packages/builtin-extensions/package.json) | Pi tools that forward built-in features to Host |
| [`builtin-skills`](builtin-skills) | Skills shipped to Ling users |
| [`.agents/skills`](.agents/skills) | Workflows for repository maintainers, kept in the source checkout |

## Development

```sh
pnpm verify         # lint, formatting, type checks and tests
pnpm build          # production Web, Host and Desktop builds
pnpm package        # build installers for the current platform
pnpm format         # format source and documentation
```

- [Development](docs/development.md): local commands, contribution checks, isolated acceptance and version/tag policy.
- [Architecture](docs/architecture.md): package dependencies, data storage and runtime responsibilities.
- [Design](docs/design.md): interface behavior, shared controls and accessibility.
- [Processes](docs/processes.md): worker lifecycle, supervision and diagnostics.
- [AGENTS.md](AGENTS.md): repository conventions and test selection.

## Acknowledgements and licenses

Ling builds on Pi and the open-source libraries listed above. The initial art-skin gallery was inspired by [heige-codex-skin-studio](https://github.com/HeiGeAi/heige-codex-skin-studio).

Ling source code is licensed under [MIT](LICENSE). Third-party software retains its own license; see [Third-Party Notices](THIRD_PARTY_NOTICES.md). Artwork, videos, provider logos and other brand assets require their own usage permission. "Bundled with Ling" describes inclusion in the app. The code license grants rights to the code; permission to use these assets must come from their rights holders.
