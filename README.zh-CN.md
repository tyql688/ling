<p align="center">
  <img src="resources/icon.png" alt="Ling logo" width="128">
</p>
<p align="center"><a href="https://github.com/earendil-works/pi">Pi coding agent</a> 的桌面与 Web 工作台。</p>
<p align="center">
  <a href="https://github.com/tyql688/ling/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/tyql688/ling/ci.yml?style=flat-square&branch=main" /></a>
  <a href="LICENSE"><img alt="Code license" src="https://img.shields.io/badge/code-MIT-blue?style=flat-square" /></a>
</p>
<p align="center"><a href="README.md">English</a> | 简体中文 | <a href="README.ja.md">日本語</a> | <a href="README.ko.md">한국어</a></p>

Ling 将 Pi 会话、项目文件、变更审阅和终端放在同一个工作台中。Electron 桌面端与浏览器端共用界面和本地 Host。Ling 直接嵌入 Pi SDK，使用 Pi 默认的 `~/.pi/agent` 目录，认证、模型、包、技能和设置与 CLI 共用。

## 功能

- 会话支持流式回复、模型与思考等级选择、历史会话、分支、消息队列和上下文压缩。可以直接开始无项目对话，也可以打开文件夹处理项目文件。
- 在独立阅读区查看文件，使用 Monaco 编辑器、语言服务、Git 历史、差异视图和审阅批注。阅读文件时，会话和输入草稿保持打开。
- 运行项目终端、后台命令和定时执行的智能体任务。
- 管理 Pi 包、扩展、技能和提示词，并将其重新加载到已打开的项目和会话。Ling 在共用界面中显示 Pi 扩展的提问与状态。
- [内置功能](docs/design.md)包括 Todo、访问模式、本地语音输入、MCP 服务（全局／项目配置）、提问、后台任务和定时任务。可在设置的“插件”页面分别开关。语音默认关闭。MCP 遵循 Pi 的全局扩展设置，升级时保留已保存的选择。通过 Pi 安装的版本优先于内置版本。
- 选择明暗主题、内置或自定义声明式皮肤，查看 Token、费用统计和受支持供应商的额度信息。界面支持英语、简体中文、日语和韩语。

## 从源码运行

安装 Git，以及 [package.json](package.json) 声明的 Node.js 和 pnpm 版本。

macOS 桌面端要求 macOS 13 或更新版本。

Windows 安装包使用 Ling 固定的自签名发布证书，首次安装时系统可能提示未知发布者或 SmartScreen 警告。应用会自动检查更新，默认自动下载，并在重启或正常退出时安装；可在设置中关闭自动下载。仅支持手动更新的版本需要先从 [Releases](https://github.com/tyql688/ling/releases/latest) 安装一次新版。

```sh
git clone https://github.com/tyql688/ling.git
cd ling
pnpm install --frozen-lockfile
pnpm dev
```

使用下列命令启动浏览器端：

```sh
pnpm dev:web
```

打开 Host 输出的本地访问地址。地址片段含有访问令牌，需要保密。浏览器操作 Host 所在机器的目录，桌面端还提供系统文件夹选择窗口。两端使用相同的项目、会话和文件服务。

首次启动后，在设置的“模型”页面通过 OAuth 或 API Key 配置供应商，即可选择“无项目”开始对话，也可以打开项目文件夹。无项目会话共享 Ling 管理的持久工作目录。Ling 使用 Pi 的认证信息，通过内嵌 SDK 发送模型请求，可能产生供应商用量费用。Pi CLI 可执行文件可以按需安装。

Host 默认只监听本机回环地址。Pi 管理认证、设置和会话文件。Ling 保存应用状态，包括 SQLite 元数据和内置功能状态。数据归属与隔离运行方式见[架构](docs/architecture.md)和[开发说明](docs/development.md)。

## 技术栈与主要依赖

各工作区清单列出直接依赖，[pnpm-lock.yaml](pnpm-lock.yaml) 固定解析后的依赖版本。

| 领域 | 技术与库 |
| --- | --- |
| 语言与工作区 | TypeScript、pnpm workspaces；TypeScript 7 用于编译与语言服务，ESLint 使用独立的 TypeScript 6 兼容依赖 |
| 智能体运行时 | [`@earendil-works/pi-coding-agent`](https://github.com/earendil-works/pi/tree/main/packages/coding-agent)；内置 [`@juicesharp/rpiv-todo`](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-todo#readme)、[`@gotgenes/pi-permission-system`](https://github.com/gotgenes/pi-packages/tree/main/packages/pi-permission-system#readme)、[`@earendil-works/pi-voice`](https://github.com/earendil-works/pi-voice#readme)、[official Pi MCP / Codemode / tool search](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/mcp.md) 适配 |
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
| [`packages/core`](packages/core/package.json) | Pi SDK 适配与业务数据处理 |
| [`packages/contracts`](packages/contracts/package.json) | 可在浏览器使用的数据类型、校验与协议声明 |
| [`packages/node-runtime`](packages/node-runtime/package.json) | 原子文件写入、启动日志与进程清理 |
| [`packages/builtin-extensions`](packages/builtin-extensions/package.json) | 向 Host 转发内置功能的 Pi 工具 |
| [`builtin-skills`](builtin-skills) | 随 Ling 提供给用户的技能 |
| [`.agents/skills`](.agents/skills) | 供仓库维护者使用的流程，仅保留在源码仓库中 |

## 开发

```sh
pnpm verify         # lint、格式检查、类型检查与测试
pnpm build          # Web、Host 和 Desktop 生产构建
pnpm package        # 构建当前平台的安装包
pnpm format         # 格式化源码与文档
```

- [开发说明](docs/development.md)：本地命令、贡献检查、隔离验收及版本/tag 规范。
- [架构](docs/architecture.md)：包依赖、数据存储和运行时职责。
- [设计](docs/design.md)：界面行为、共享控件与无障碍约定。
- [进程](docs/processes.md)：worker 生命周期、监督与诊断。
- [AGENTS.md](AGENTS.md)：仓库约定与测试选择。

## 致谢与许可

感谢 Pi 及上文列出的开源项目。初期艺术皮肤图库受 [heige-codex-skin-studio](https://github.com/HeiGeAi/heige-codex-skin-studio) 启发。

Ling 源代码采用 [MIT 许可](LICENSE)。第三方软件保留各自的许可证，见[第三方声明](THIRD_PARTY_NOTICES.md)。图片、视频、供应商标志及其他品牌素材的使用需要获得各自权利人的许可。“Bundled with Ling” 表示素材随应用附带，代码许可证授权的范围是代码。
