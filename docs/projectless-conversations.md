# 无项目对话

Ling 首次启动直接提供“无项目”对话，用户配置好模型即可发送消息。Host 在 `LING_HOME/conversations` 下维护持久工作目录，默认路径为 `~/.ling/conversations`。Pi 按 cwd 加载会话、资源和权限配置。界面区分用户项目与 Ling 管理的对话目录。

## 竞品的实际做法

本节记录固定版本的代码行为。T3 Code、ZCode 和 DeepSeek Harness 为用户准备工作目录，用户可以直接开始对话，工具在这些目录中运行。

| 项目 | 用户入口与目录模型 | 代码证据 |
| --- | --- | --- |
| T3 Code | `No project` 对应当前 environment 的 scratch project。服务端创建目录，每个 thread 使用独立子目录，文件浏览和 provider 执行共享该线程的目录。客户端等待项目进入状态后才创建草稿，初始化失败显示错误。 | [入口及环境选择](https://github.com/pingdotgg/t3code/blob/54084ae1e6c32809db040e4fa571c80fdf2d8ae4/apps/web/src/hooks/useScratchProject.ts)、[服务端 scratch project 与 thread folder](https://github.com/pingdotgg/t3code/blob/54084ae1e6c32809db040e4fa571c80fdf2d8ae4/apps/server/src/ws.ts) |
| ZCode | 应用维护 `.zcode/workspace/default`，多个对话共享 cwd。`workspacePurpose: "conversation"` 标记对话目录，创建对话时解除工作台当前项目绑定；目录创建失败保留错误。 | [目录定义](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/services/src/paths.ts)、[目录创建](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/services/src/file/fileService.ts)、[对话入口](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/root/useConversationWorkspaceActions.ts) |
| DeepSeek Harness | 首次使用初始化默认 workspace。实际位置由系统 Documents 目录解析得到，再使用 `deepseek-harness/default-workspace`。磁盘目录名固定，展示名称可本地化。 | [默认目录解析](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/api/workspace-controller/src/default-directory.ts)、[默认 workspace 初始化](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/api/workspace-controller/src/index.ts)、[目录常量](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/api/workspace-controller/src/default-workspace.ts) |
| Maka | 本地 Host 支持 `selectedProjectId: null`，Host workspace 模式关闭该能力。选择无项目时保留当前 `selection.path`，初始路径候选是 `process.cwd()` 和 `app.getAppPath()`；任务入口仍读取 Host 的实际路径。该操作更新所选项目，文件位置取决于 Host 当前选择的路径。 | [任务入口](https://github.com/apache/maka/blob/c7fa6bb6a5f3731f1f591dbeb60433fba79ccb6e/apps/desktop/src/renderer/features/task-entry/controller/use-task-entry-controller.ts)、[选择操作](https://github.com/apache/maka/blob/c7fa6bb6a5f3731f1f591dbeb60433fba79ccb6e/apps/desktop/src/main/project-management-service.ts)、[启动路径与能力](https://github.com/apache/maka/blob/c7fa6bb6a5f3731f1f591dbeb60433fba79ccb6e/apps/desktop/src/main/runtime-host-boot.ts) |
| pi-gui | 已检查的新会话入口要求有效的 `rootWorkspaceId`，其目标来自已有 workspace；缺少该值时 `startThread` 返回。此入口采用先有 workspace 再创建会话的交互。 | [新会话控制器](https://github.com/minghinmatthewlam/pi-gui/blob/51bed8d0ddee047ae84873149cb3bd89ee633a61/apps/desktop/src/features/threads/hooks/use-new-thread-controller.tsx) |

T3 的线程子目录分别存放各个对话的文件。共享目录则让后续对话可以直接使用已有文件。Ling 按解析后的 cwd 管理 Pi 服务、终端、文件、权限和项目资源，因此无项目对话共用一个持久目录。界面说明这些对话共享文件。各会话保有自己的历史和草稿，适用于问答、轻量文件任务和首次使用。

## 用户流程

1. 首次启动看到主界面、输入框和“无项目”目标。有 Pi 凭据时可选择模型发送；未配置凭据时显示“连接模型提供商”，草稿在进入设置并返回后保留。
2. “无项目”使用对话图标，目标选择器和侧边栏显示本地化名称。说明告知这些会话共用 Ling 管理的文件目录；文件管理动作能打开实际目录。
3. 用户通过目标选择器打开文件夹后，新对话使用所选项目。已经建立的无项目会话继续保留在原目录下，可从侧边栏恢复。
4. 新对话使用用户指定的目标；未指定时使用上次开始对话的目标；两者都没有时使用无项目目标。无项目会话和项目会话之间切换时，每个会话保留独立草稿、历史和阅读区域。
5. 关闭普通项目后，无项目入口继续可用。无项目目标的菜单提供新对话、文件、终端、置顶和归档等适用操作，其持久目录由 Host 管理。

## 运行时与数据归属

| 内容 | 管理方式 |
| --- | --- |
| 工作目录 | Host 从 `HostRuntimePaths.dataHome` 生成路径，由项目管理模块创建目录、解析真实路径并打开 Pi 服务。 |
| 展示分类 | `OpenProjectInfo.purpose` 为 `project` 或 `conversation`。Web 根据这个字段显示名称、图标和操作。Git worktree 信息由其元数据记录。 |
| 会话与历史 | Pi session manager 和 Ling catalog 按 cwd 和 session ID 保存会话，重启后按这两个标识恢复。 |
| 工作文件 | 无项目会话共享 `conversations` 目录；归档会话保留文件。目录的保留时间独立于单个会话。 |
| 项目列表 | 持久化列表记录用户选择的项目。无项目目录由每次启动的生命周期自动恢复，用户增删项目列表时，对话目录保持可用。 |
| 工具与权限 | Pi 的工具、MCP、扩展和访问模式照常生效。cwd 是默认工作目录和文件服务的归属，工具的访问范围由权限策略决定。 |
| Web | 工作目录位于运行 Host 的机器。Host 验证文件请求的身份和路径。 |
| 退出 | Host 停止接收新操作并等待会话、项目资源和 worker 清理；工作目录与已保存会话保持持久。 |

目录身份依据 Host 配置和真实路径确定。普通项目的名称即使叫 `conversations` 也仍然是普通项目。项目移除 API 拒绝关闭默认对话目录，界面也按这项规则提供操作。

## 失败与恢复

目录创建、真实路径解析或 Pi 服务初始化失败时，项目列表返回包含具体目录错误的 partial 结果，已经成功打开的普通项目仍然可用。重试会重新准备无项目目录。若目标位置是普通文件，界面显示创建失败，文件内容保持完整。项目数据库读取失败时，界面显示错误并提供数据恢复操作。

共享目录意味着两个无项目会话可能读写同名文件。需要固定项目资源或独立存放文件时，可选择自己的项目目录。切换会话后，文件和历史仍保存在各自目录。

## 复验方法

使用 [Development](development.md) 的隔离运行器，分别隔离应用数据、Pi agent 目录和 `LING_HOME`。先以空凭据冷启动，确认输入框和“无项目”可见、模型配置入口可用、进入设置后草稿保留。随后在同一隔离数据上启用模型凭据，完成模型回复和一次需要批准的文件操作，核对实际文件内容。再打开样例项目、在两个目标之间切换、重启、恢复历史，并检查工作目录和未发送草稿。

`project-lifecycle.test.ts` 使用临时目录，覆盖的首次创建、重复恢复、文件保留、普通项目增删后的持久化列表、默认目录关闭保护，以及目录被文件占用时的 partial 结果与修复后重试。locale 检查验证四种语言的键和插值。将 UI、模型执行和审批的验收结果保存在隔离运行的 evidence 目录中。
