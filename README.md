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

- **Project conversations:** streaming responses, model and thinking controls, session history, forks, queued messages and context compaction. Open a project before starting a conversation.
- **Files and change review:** an independent reading area, Monaco editing, language support, Git history, diffs and review annotations. Reading a file keeps the original conversation and draft in place.
- **Terminal and tasks:** project terminals, background commands and scheduled agent tasks.
- **Pi resources:** manage packages, extensions, skills and prompts; reload resources into open projects and sessions. Pi extension prompts and status are adapted to the shared interface.
- **Built-in features:** Todo, access mode, voice input, questions, background tasks and schedules each have their own switch. Todo, permissions and voice adapt upstream Pi packages; an installed Pi copy takes precedence over the bundled copy.
- **Voice input:** off by default; enable it in Plugins. One Composer button records and transcribes locally with Pi Voice. Use `Cmd+Option+V` on macOS or `Ctrl+Alt+V` on Windows/Linux; add Shift to open settings, or right-click the button. Choose and download a model on first use; supported transcription languages depend on that model. Review the text in your draft before sending. An installed `@earendil-works/pi-voice` keeps Ling’s recording controls and settings. The original `transcribe_file` tool remains available and requires FFmpeg for audio-file decoding.
- **Personalization and usage:** light/dark themes, built-in and custom declarative skins, token/cost statistics and supported provider quota views. Application languages include English, Simplified Chinese, Japanese and Korean.

## Run from source

Install Node.js **22.19 or newer**, Git and the pnpm version declared in [package.json](package.json) (currently **11.25.0**).

The macOS desktop app requires **macOS 13 or newer**.

Windows installers are currently unsigned and may show an unknown-publisher warning. Download and install updates manually from [Releases](https://github.com/tyql688/ling/releases/latest); the Windows app links to that page from Settings.

```sh
git clone https://github.com/tyql688/ling.git
cd ling
pnpm install --frozen-lockfile
pnpm dev
```

For the browser client, run this instead of `pnpm dev`:

```sh
pnpm dev:web
```

Open the authenticated local URL printed by Host. Its fragment contains a private access token. The browser works with directories on the **Host machine**; the desktop app also provides native folder dialogs. Both clients use the same project, session and file services.

On first launch, configure a provider in **Settings → Models** with OAuth or an API key, then open a project. Existing Pi authentication is reused. Installing a separate Pi CLI executable is optional; model requests use the embedded SDK and may incur provider charges.

Host binds to loopback by default. Pi retains ownership of its credentials, settings and session files. Ling stores application state separately, including SQLite metadata and built-in feature state. See [Architecture](docs/architecture.md) and [Development](docs/development.md) for data ownership and isolated runs.

## Technology and libraries

The table lists the main technologies and their actual roles. Exact direct dependencies live in the workspace manifests below; [pnpm-lock.yaml](pnpm-lock.yaml) pins the resolved dependency graph.

| Area | Technologies and libraries |
| --- | --- |
| Language and workspace | TypeScript, pnpm workspaces; TypeScript 7 for compilation and language services, a separate TypeScript 6 compatibility dependency for ESLint |
| Agent runtime | `@earendil-works/pi-coding-agent`; bundled `@juicesharp/rpiv-todo`, `@gotgenes/pi-permission-system` and `@earendil-works/pi-voice` adapters |
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
| [`packages/core`](packages/core/package.json) | Pi SDK adaptation and shared business interpretation |
| [`packages/contracts`](packages/contracts/package.json) | Browser-safe data contracts, validation and protocol declarations |
| [`packages/node-runtime`](packages/node-runtime/package.json) | Atomic file publication, launch logs and process cleanup |
| [`packages/builtin-extensions`](packages/builtin-extensions/package.json) | Pi tools that forward built-in features to Host |
| [`builtin-skills`](builtin-skills) | Skills shipped to Ling users |
| [`.agents/skills`](.agents/skills) | Repository maintenance workflows; excluded from the application |

## Development

```sh
pnpm verify         # lint, formatting, type checks and tests
pnpm build          # production Web, Host and Desktop builds; no installer
pnpm format         # format source and documentation
```

- [Development](docs/development.md): local commands, contribution checks, isolated acceptance and version/tag policy.
- [Architecture](docs/architecture.md): package boundaries, data ownership and runtime responsibilities.
- [Design](docs/design.md): interface behavior, shared controls and accessibility.
- [Processes](docs/processes.md): worker lifecycle, supervision and diagnostics.
- [AGENTS.md](AGENTS.md): repository conventions and test selection.

## Acknowledgements and licenses

Ling builds on Pi and the open-source libraries listed above. The initial art-skin gallery was inspired by [heige-codex-skin-studio](https://github.com/HeiGeAi/heige-codex-skin-studio).

Ling source code is licensed under [MIT](LICENSE). Third-party software retains its own license; see [Third-Party Notices](THIRD_PARTY_NOTICES.md). Artwork, videos, provider logos and other brand assets are separate from the code license. “Bundled with Ling” describes inclusion in the app and is not a license grant for those assets.
