# ai-space

[English](README.md) | 中文

AI 的家：把多个 AI agent、app 和它们的数据连接、组织进同一个系统，跑在一台专用服务器上。

它是所有这些的统一入口。不必在不同的 AI 工具之间来回切换，你通过一个 web 界面使用和管理自己的 AI 系统。这个界面由三样东西组成：

- **Apps** 承载结构化的信息和工作场景，同时为 AI 提供持续的上下文。
- **Agents** 负责理解和处理复杂、非结构化的需求，并执行具体任务。
- **Widgets** 把重要的状态和结果以轻量、直观的方式呈现，随时可见。

在底层，ai-space 把 apps、agents、widgets、skills 和数据组织进同一个系统，而不是一堆各自为战的工具：它们共享上下文和数据，调用彼此的能力，传递任务与结果，并围绕你设定的目标持续推进。核心提供一个 AI 系统运行所需的基础能力：按时间或事件触发的定时任务，任务完成或出现重要结果时的通知，数据和产出的备份，存储，以及多台机器共用一个面板。

## 架构

![ai-space 架构](docs/architecture.svg)

自上而下：

- **应用层。** 统一的 web UI 是唯一入口。它列出已安装的 app，可以和任意 agent 对话，在首页面板上展示 app 的 widget，并承载通知和设置。每个 app 拥有一个或多个 agent，可以贡献一个或多个 widget。
- **空间层（ai-space 核心）。** 每个 app 和 agent 都能通过同一个 Space API 调用的共享服务，不必各自造轮子：云存储、定时任务、通知、数据备份、配置与密钥、日志与监控。核心还维护 app 注册表，把请求路由到正确的 agent，并处理鉴权。
- **运行时层。** Agent 以 [Claude Code](https://claude.com/claude-code) 或 Codex 会话的形式运行。Skills、MCP 工具、记忆和模型访问来自运行时；agent 把 Space API 当作工具来调用。
- **基础设施层。** 一切跑在一台专用 Linux 服务器上：Bun、SQLite 和文件系统、cron、一个公开域名。

架构图源文件是 `docs/architecture.svg`。

## 工作区

ai-space 在一台机器上拥有的一切都放在一个目录里，默认 `~/.ai-space`（用 `SPACE_HOME` 覆盖）。首次启动或 `bun run init` 时创建：

```
~/.ai-space/
├── core/    ai-space 本身（本仓库），用 deploy/ 部署时放在这里
├── apps/    一个 app 一个目录；任何带 space.yaml 的 app 自动进入调度
├── data/    运行时状态（SQLite）和每个 app 的数据目录
├── logs/
└── .env     ai-space 配置，以及 app manifest 通过 ${VAR} 引用的密钥
```

## 开发

```bash
bun install
bun run init           # 创建 ~/.ai-space（幂等）
bun run start          # 在 127.0.0.1:8700 启动 Space API 和面板
bun run dev            # 热重载，包括 web UI
bun run check          # 类型检查 + 测试
```

本地配置放在 `~/.ai-space/.env`（见 `.env.example`）；进程环境变量优先于它。

## 部署

把整个流程交给一个 coding agent（Claude Code、Codex）：在你本机的 checkout 里，让它按 `docs/install-by-agent.md` 把 ai-space 装到 `<host>` 上；或者在服务器上 clone 到 `~/.ai-space/core`，在该目录里启动 agent，让它按同一份文档装这台机器。遇到需要浏览器登录的步骤它会停下来告诉你怎么做。见 [docs/install-by-agent.md](docs/install-by-agent.md) 和 [docs/install.md](docs/install.md)。

手工方式：用户级 systemd，不需要 sudo。目标机器上装好 Bun（在 `~/.bun` 下）之后：

```bash
ssh <host> "git init --bare ~/ai-space.git"
scp deploy/post-receive <host>:~/ai-space.git/hooks/post-receive && ssh <host> chmod +x ~/ai-space.git/hooks/post-receive
git remote add <host> <host>:~/ai-space.git
git push <host> main      # 检出到 ~/.ai-space/core，运行 deploy/install.sh，重启单元
```

`deploy/install.sh` 把 `deploy/ai-space.service` 装进 `~/.config/systemd/user/`，开启 linger，重启服务。日志：`journalctl --user -u ai-space -f`。

新机器上，在 `~/.ai-space/core` 里运行 `bun run setup` 交互式地完成其余部分：检查 ai-space 会调用的工具（claude、gh、cloudflared），逐节询问工作区 `.env` 的每个值，发一条测试通知，探测存储桶，并打印 Cloudflare 上还需要做的事。从一个空用户到域名和访问层之后的面板，完整流程见 [docs/install.md](docs/install.md)。

App 规范（什么是 app、目录布局、`space.yaml` 契约）见 [docs/app-spec.md](docs/app-spec.md)；引导 agent 按该规范创建、收编或修改 app 的共享 skill 见 [skills/space-app](skills/space-app/SKILL.md)（app 模板在 `skills/space-app/templates/`）；agent 和贡献者指南（含提交格式）见 [AGENTS.md](AGENTS.md)；Bun 约定见 [CLAUDE.md](CLAUDE.md)。

## 服务

- **调度器**（`src/space/scheduler/`）：app 的定时任务和事件驱动任务。`at` / `every` / `cron` 三种时间表，由 `POST /api/events` 喂入的事件 `triggers`（去抖、合并，作为运行的 payload 传入），`http` / `command` / `agent` 三种目标，在每个 app 的 `space.yaml` 里声明，通过 `/api/tasks` 管理。见 [docs/scheduler.md](docs/scheduler.md)。
- **存储**（`src/space/storage/`）：每个 app 一个 SQLite 或 PostgreSQL 数据库，以及一个放在文件系统或任意 S3 兼容桶上的对象存储，在 `space.yaml` 里声明，同步时开通，通过 `<workspace>/data/<app>/space.env` 交接（`DATABASE_URL`、`BLOB_URL`、`S3_*`）。设计中的托管 blob API 尚未实现。见 [docs/storage.md](docs/storage.md)。
- **备份**（`src/space/storage/backup/`）：每个 app 的数据目录每天快照到 S3 桶（SQLite 用 `VACUUM INTO`，状态文件，每 app 一个 `tar.zst` 加一份清单），按数量保留，每周一次打开最新快照的校验任务，以及 `restore` 到目录或原地恢复。见 [docs/backup.md](docs/backup.md)。
- **通知**（`src/space/notify/`）：向聊天软件的单向通知（Telegram、Discord、Slack、飞书、钉钉、企业微信、Bark、ntfy、通用 webhook）。渠道在工作区 `.env` 里以 `SPACE_NOTIFY_<NAME>` URL 配置一次；app 在 `space.yaml` 里声明可用的渠道，发一个 `POST /api/notify` 即可。投递有队列、限速、重试和记录；调度器通过它上报失败的任务。见 [docs/notify.md](docs/notify.md)。
- **面板**（`src/space/panel/`、`src/space/agents/`、`src/web/`）：`/` 上的 web 入口。工作区里每个 app 的启动器（图标、入口 URL、健康状态），以任意声明的 agent 或空间 agent 身份打开 Claude Code 会话的聊天窗口，由 app 提供数据的 widget 卡片，所有定时任务及其运行历史的只读视图，以及从链接添加 app、隐藏、排序或卸载的编辑模式。中英文跟随浏览器或设置；app 在 `space.yaml` 里翻译自己的标题（[docs/i18n.md](docs/i18n.md)）。见 [docs/panel.md](docs/panel.md)。

## 状态

早期阶段。调度器（时间表和事件触发）、存储（数据库和对象存储交接）、备份、通知、面板（agent 聊天、widget、从链接添加、卸载）、peers（多台机器共用一个面板，[docs/peers.md](docs/peers.md)）和交互式 `setup` 已就位。后续工作，大致按顺序：

- **服务托管**：启动 `service.command`，失败时重启，把日志收集到 `<workspace>/logs/<app>/`；在此之前服务是操作员自己安装的 systemd 单元，面板直接探测健康状态。
- **Skills 挂载**：把 manifest 里的 `skills:` 和 `memory:` 提供给 agent 会话；目前两者只解析不挂载。
- **托管 blob API**：在已经开通并交接的对象存储之上加索引表、流式路由和预签名。
- **App 工具链**：`schema/space.schema.json`、`validate`、`/api/spec` 和 `bun run new-app`；目前由共享 skill `skills/space-app/` 手工完成。

分区状态表见 [docs/app-spec.md](docs/app-spec.md#implementation-status)。
