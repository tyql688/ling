<p align="center">
  <img src="resources/icon.png" alt="Ling ロゴ" width="128">
</p>
<p align="center"><a href="https://github.com/earendil-works/pi">Pi coding agent</a> のデスクトップ・Web ワークスペース。</p>
<p align="center">
  <a href="https://github.com/tyql688/ling/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/tyql688/ling/ci.yml?style=flat-square&branch=main" /></a>
  <a href="LICENSE"><img alt="Code license" src="https://img.shields.io/badge/code-MIT-blue?style=flat-square" /></a>
</p>
<p align="center"><a href="README.md">English</a> | <a href="README.zh-CN.md">简体中文</a> | 日本語 | <a href="README.ko.md">한국어</a></p>

Ling は Pi の会話、プロジェクトファイル、変更レビュー、ターミナルを一つのワークスペースにまとめます。Electron アプリとブラウザー版は同じ UI とローカル Host を使用します。Pi SDK を直接組み込み、Pi の既定ディレクトリ `~/.pi/agent` を利用するため、認証情報、モデル、パッケージ、スキル、設定を CLI と共有できます。

## 機能

- **プロジェクトの会話：** ストリーミング応答、モデルと思考レベルの選択、会話履歴、分岐、メッセージキュー、コンテキストの圧縮。会話を始めるにはプロジェクトを開きます。
- **ファイルと変更レビュー：** 独立した閲覧エリア、Monaco エディター、言語サービス、Git 履歴、差分表示、レビューコメント。ファイルを開いても元の会話と入力中の下書きは保持されます。
- **ターミナルとタスク：** プロジェクト用ターミナル、バックグラウンドコマンド、定期実行するエージェントタスク。
- **Pi リソース：** パッケージ、拡張機能、スキル、プロンプトを管理し、開いているプロジェクトとセッションに再読み込みします。Pi 拡張機能の質問や状態表示も共通 UI に統合されます。
- **組み込み機能：** Todo、アクセスモード、音声入力、質問、バックグラウンドタスク、定期タスクを個別に切り替えられます。Todo、権限、音声機能は上流の Pi パッケージを利用し、ユーザーが Pi 経由でインストールした版を組み込み版より優先します。
- **音声入力：** 初期状態ではオフです。プラグイン画面で有効にすると、入力欄の音声ボタンひとつで録音し、Pi Voice でローカル文字起こしを行えます。macOS は `Cmd+Option+V`、Windows/Linux は `Ctrl+Alt+V` を使用します。Shift を加えるかボタンを右クリックすると設定を開けます。初回にモデルを選択してダウンロードしてください。対応する文字起こし言語はモデルによって異なります。下書きのテキストを確認してから送信します。`@earendil-works/pi-voice` をインストール済みでも Ling の録音・設定画面を使えます。元の `transcribe_file` ツールも利用でき、音声ファイルのデコードには FFmpeg が必要です。
- **外観と使用量：** ライト・ダークテーマ、組み込みおよびカスタムの宣言型スキン、トークンと費用の統計、対応プロバイダーの利用枠表示。UI は英語、簡体字中国語、日本語、韓国語に対応しています。

## ソースから実行

Node.js **22.19 以降**、Git、および [package.json](package.json) に指定された pnpm（現在は **11.25.0**）をインストールしてください。

macOS デスクトップ版には **macOS 13 以降**が必要です。

Windows インストーラーは現在未署名のため、発行元不明の警告が表示される場合があります。[Releases](https://github.com/tyql688/ling/releases/latest) から更新を手動でダウンロードしてインストールしてください。Windows 版の設定画面にもダウンロードページへのリンクがあります。

```sh
git clone https://github.com/tyql688/ling.git
cd ling
pnpm install --frozen-lockfile
pnpm dev
```

ブラウザー版では、`pnpm dev` の代わりに次を実行します。

```sh
pnpm dev:web
```

Host が出力する認証付きローカル URL を開きます。URL のフラグメントには非公開のアクセストークンが含まれます。ブラウザー版で操作するのは **Host が動作しているマシン**のディレクトリです。デスクトップ版では OS 標準のフォルダー選択ダイアログも利用できます。両方のクライアントが同じプロジェクト、セッション、ファイルサービスを使用します。

初回起動後、**設定 → モデル**で OAuth または API キーを使ってプロバイダーを設定し、プロジェクトを開きます。既存の Pi 認証情報も利用できます。Pi CLI の実行ファイルを別途インストールする必要はありません。モデルへのリクエストは組み込み SDK から送信され、プロバイダーの利用料金が発生する場合があります。

Host は既定でループバックアドレスのみを使用します。Pi の認証情報、設定、セッションファイルは引き続き Pi が管理します。SQLite のメタデータや組み込み機能の状態など、Ling のアプリケーションデータは別に保存されます。データの管理主体と隔離実行については[アーキテクチャ](docs/architecture.md)と[開発ガイド](docs/development.md)を参照してください。

## 技術スタックと主なライブラリ

主な技術と実際の用途をまとめています。直接依存するパッケージの全一覧は各ワークスペースのマニフェストに、解決済みの依存関係は [pnpm-lock.yaml](pnpm-lock.yaml) に記録されています。

| 分野 | 技術とライブラリ |
| --- | --- |
| 言語とワークスペース | TypeScript、pnpm workspaces。コンパイルと言語サービスには TypeScript 7、ESLint の互換性維持には別の TypeScript 6 依存関係を使用 |
| エージェント実行環境 | `@earendil-works/pi-coding-agent`、組み込みの `@juicesharp/rpiv-todo`、`@gotgenes/pi-permission-system`、`@earendil-works/pi-voice` のアダプター |
| デスクトップ | Electron、electron-vite、electron-builder、electron-updater、node-mac-permissions |
| Web と状態管理 | React 19、Vite、Jotai、jotai-family |
| UI | Tailwind CSS 4、Radix UI、Floating UI、Motion、cmdk、react-resizable-panels |
| 編集と表示 | Monaco Editor、Tiptap/ProseMirror、Markstream、Shiki、Pierre Diffs、Mermaid、KaTeX |
| リストとグラフ | TanStack Virtual、use-stick-to-bottom、Recharts |
| ターミナルとプロジェクトファイル | xterm.js、node-pty、Parcel Watcher、simple-git、diff |
| 通信と検証 | WebSocket（`ws`、PartySocket）、`birpc` による worker RPC、Zod。エディターサービスには vscode-jsonrpc と Language Server Protocol を使用 |
| 永続化と並行処理 | Node.js SQLite（`node:sqlite`）、write-file-atomic、proper-lockfile、p-limit、lru-cache |
| 国際化とアイコン | i18next、react-i18next、Lucide、LobeHub icons、Material Icon Theme |
| 品質確認 | Vitest、ESLint、typescript-eslint、Prettier、GitHub Actions |

## リポジトリ構成

| ディレクトリ | 役割 |
| --- | --- |
| [`apps/web`](apps/web/package.json) | 共通 React UI、機能の状態管理、ブラウザー・ネイティブ環境のアダプター |
| [`apps/desktop`](apps/desktop/package.json) | ネイティブウィンドウ、OS 連携、更新、Host の監視 |
| [`packages/host`](packages/host/package.json) | プロジェクト、セッション、ファイル、Git、ターミナル、永続化、worker の管理 |
| [`packages/core`](packages/core/package.json) | Pi SDK のアダプターと共通の業務データ処理 |
| [`packages/contracts`](packages/contracts/package.json) | ブラウザーで扱えるデータ契約、検証、プロトコル定義 |
| [`packages/node-runtime`](packages/node-runtime/package.json) | アトミックなファイル書き込み、起動ログ、プロセスの終了処理 |
| [`packages/builtin-extensions`](packages/builtin-extensions/package.json) | 組み込み機能の呼び出しを Host に転送する Pi ツール |
| [`builtin-skills`](builtin-skills) | Ling ユーザーに同梱するスキル |
| [`.agents/skills`](.agents/skills) | リポジトリ保守用の手順。アプリには同梱されません |

## 開発

```sh
pnpm verify         # lint、書式、型、テストの確認
pnpm build          # Web・Host・Desktop の本番ビルド。インストーラーは生成しません
pnpm format         # ソースとドキュメントの書式を整える
```

- [開発ガイド](docs/development.md)：実行コマンド、貢献時の確認、隔離環境での検証、バージョンとタグの方針。
- [アーキテクチャ](docs/architecture.md)：パッケージの境界、データの管理主体、実行時の役割。
- [デザイン](docs/design.md)：UI の動作、共通コントロール、アクセシビリティ。
- [プロセス](docs/processes.md)：worker のライフサイクル、監視、診断。
- [AGENTS.md](AGENTS.md)：リポジトリの規約とテストの選び方。

## 謝辞とライセンス

Pi と上記のオープンソースプロジェクトに感謝します。初期のアートスキンギャラリーは [heige-codex-skin-studio](https://github.com/HeiGeAi/heige-codex-skin-studio) から着想を得ています。

Ling のソースコードは [MIT ライセンス](LICENSE)で提供されます。第三者のソフトウェアにはそれぞれのライセンスが適用されます。[第三者に関する通知](THIRD_PARTY_NOTICES.md)を参照してください。画像、動画、プロバイダーのロゴ、その他のブランド素材はコードのライセンスとは別です。「Bundled with Ling」はアプリに同梱されることを示す表示であり、それらの素材の利用許諾ではありません。
