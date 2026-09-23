<p align="center">
  <img src="resources/icon.png" alt="Ling logo" width="128">
</p>
<p align="center"><a href="https://github.com/earendil-works/pi">Pi coding agent</a> 的桌面与 Web 工作台。</p>
<p align="center">
  <a href="https://github.com/tyql688/ling/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/tyql688/ling/ci.yml?style=flat-square&branch=main" /></a>
  <a href="LICENSE"><img alt="Code license" src="https://img.shields.io/badge/code-MIT-blue?style=flat-square" /></a>
</p>
<p align="center"><a href="README.md">English</a> | 简体中文 | <a href="README.ja.md">日本語</a> | <a href="README.ko.md">한국어</a></p>

Ling 将 Pi 会话、项目文件、变更审阅和终端放在同一个工作台中。Electron 桌面端与浏览器端共用界面和本地 Host。Ling 直接嵌入 Pi SDK，使用 Pi 默认的 `~/.pi/agent` 目录，已有的认证、模型、包、技能和设置可以继续与 CLI 共用。

## 功能

- **项目会话：** 流式回复、模型与思考等级选择、历史会话、分支、消息队列和上下文压缩。开始会话前需要打开项目。
- **文件与变更审阅：** 独立阅读区、Monaco 编辑器、语言服务、Git 历史、差异视图和审阅批注。阅读文件时保留原会话及输入草稿。
- **终端与任务：** 项目终端、后台命令和定时执行的智能体任务。
- **Pi 资源：** 管理包、扩展、技能和提示词，并将资源重新加载到已打开的项目和会话。Pi 扩展的提问与状态展示适配到统一界面。
- **内置功能：** Todo、访问模式、提问、后台任务和定时任务均有独立开关。Todo 与权限功能适配上游 Pi 包，用户通过 Pi 安装的版本优先于内置版本。
- **外观与用量：** 明暗主题、内置与自定义声明式皮肤、Token 与费用统计，以及受支持供应商的额度信息。界面支持英语、简体中文、日语和韩语。

## 从源码运行

安装 Node.js **22.19 或更新版本**、Git，以及 [package.json](package.json) 声明的 pnpm 版本（目前为 **11.25.0**）。

macOS 桌面端要求 **macOS 13 或更新版本**。

Windows 安装包目前未签名，系统可能提示发布者未知。请从 [Releases](https://github.com/tyql688/ling/releases/latest) 手动下载安装更新；Windows 版设置页提供下载入口。

```sh
git clone https://github.com/tyql688/ling.git
cd ling
pnpm install --frozen-lockfile
pnpm dev
```

浏览器端使用以下命令启动，无需同时运行 `pnpm dev`：

```sh
pnpm dev:web
```

打开 Host 输出的本地访问地址。地址片段含有私有访问令牌，请勿公开。浏览器操作的是 **Host 所在机器**的目录；桌面端还提供系统原生文件夹选择窗口。两端使用相同的项目、会话和文件服务。

首次启动后，在**设置 → 模型**中通过 OAuth 或 API Key 配置供应商，再打开项目。已有的 Pi 认证会直接复用。无需另行安装 Pi CLI 可执行文件；模型请求通过内嵌 SDK 发出，可能产生供应商用量费用。

Host 默认只监听本机回环地址。认证、设置和会话文件仍由 Pi 管理；Ling 单独保存应用状态，包括 SQLite 元数据和内置功能状态。数据归属与隔离运行方式见[架构](docs/architecture.md)和[开发说明](docs/development.md)。

## 技术栈与主要依赖

下表说明主要技术及实际用途。完整直接依赖见下方各工作区的清单，解析后的依赖树由 [pnpm-lock.yaml](pnpm-lock.yaml) 固定。

| 领域 | 技术与库 |
| --- | --- |
| 语言与工作区 | TypeScript、pnpm workspaces；TypeScript 7 用于编译与语言服务，另保留 TypeScript 6 兼容依赖供 ESLint 使用 |
| 智能体运行时 | `@earendil-works/pi-coding-agent`；内置 `@juicesharp/rpiv-todo`、`@gotgenes/pi-permission-system` 适配 |
| 桌面端 | Electron、electron-vite、electron-builder、electron-updater、node-mac-permissions |
| Web 与状态 | React 19、Vite、Jotai、jotai-family |
| 界面 | Tailwind CSS 4、Radix UI、Floating UI、Motion、cmdk、react-resizable-panels |
| 编辑与内容渲染 | Monaco Editor、Tiptap/ProseMirror、Markstream、Shiki、Pierre Diffs、Mermaid、KaTeX |
| 列表与图表 | TanStack Virtual、use-stick-to-bottom、Recharts |
| 终端与项目文件 | xterm.js、node-pty、Parcel Watcher、simple-git、diff |
| 通信与校验 | WebSocket（`ws`、PartySocket）、`birpc` 进程通信、Zod；编辑器服务使用 vscode-jsonrpc 与 Language Server Protocol |
| 存储与并发 | Node.js SQLite（`node:sqlite`）、write-file-atomic、proper-lockfile、p-limit、lru-cache |
| 国际化与图标 | i18next、react-i18next、Lucide、LobeHub icons、Material Icon Theme |
| 质量检查 | Vitest、ESLint、typescript-eslint、Prettier、GitHub Actions |

## 仓库结构

| 目录 | 职责 |
| --- | --- |
| [`apps/web`](apps/web/package.json) | 共用 React 界面、功能状态及浏览器/原生适配 |
| [`apps/desktop`](apps/desktop/package.json) | 原生窗口、系统集成、更新和 Host 监督 |
| [`packages/host`](packages/host/package.json) | 项目、会话、文件、Git、终端、持久化及进程管理 |
| [`packages/core`](packages/core/package.json) | Pi SDK 适配与共享业务解释逻辑 |
| [`packages/contracts`](packages/contracts/package.json) | 浏览器安全的数据契约、校验与协议声明 |
| [`packages/node-runtime`](packages/node-runtime/package.json) | 原子文件写入、启动日志与进程清理 |
| [`packages/builtin-extensions`](packages/builtin-extensions/package.json) | 向 Host 转发内置功能的 Pi 工具 |
| [`builtin-skills`](builtin-skills) | 随 Ling 提供给用户的技能 |
| [`.agents/skills`](.agents/skills) | 仓库维护流程，不随应用分发 |

## 开发

```sh
pnpm verify         # lint、格式检查、类型检查与测试
pnpm build          # Web、Host 和 Desktop 生产构建，不生成安装包
pnpm format         # 格式化源码与文档
```

- [开发说明](docs/development.md)：本地命令、贡献检查、隔离验收及版本/tag 规范。
- [架构](docs/architecture.md)：包边界、数据归属和运行时职责。
- [设计](docs/design.md)：界面行为、共享控件与无障碍约定。
- [进程](docs/processes.md)：worker 生命周期、监督与诊断。
- [AGENTS.md](AGENTS.md)：仓库约定与测试选择。

## 致谢与许可

感谢 Pi 及上文列出的开源项目。初期艺术皮肤图库受 [heige-codex-skin-studio](https://github.com/HeiGeAi/heige-codex-skin-studio) 启发。

Ling 源代码采用 [MIT 许可](LICENSE)。第三方软件保留各自的许可证，见[第三方声明](THIRD_PARTY_NOTICES.md)。图片、视频、供应商标志及其他品牌素材与代码许可分开；“Bundled with Ling” 仅表示随应用附带，不构成这些素材的使用授权。
