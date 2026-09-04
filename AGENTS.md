# AGENTS.md - AI Agent Coding Guide

本文件面向在 ai-space 仓库中工作的 AI 编码 agent。改代码之前先读完本文件。人类贡献者也请遵守同样的规则。

## Project Snapshot

ai-space 是一个 AI 相关实验与工具的工作空间，使用 TypeScript 编写，由 Bun 负责安装依赖、运行、测试和构建。项目处于初始阶段，目录结构会随着模块加入而演进；新增目录时同步更新本文件的 Repository Map。

## Work Style

- 一次改动只解决一个问题，保持 diff 聚焦。
- 优先沿用当前文件或相邻模块中已有的模式，不要引入新的抽象。
- 不做无关的格式化、重命名、依赖变更或大范围重写。
- 行为变化必须补充或更新测试。
- 安装方式、命令、对外行为变化时同步更新文档。
- 新功能、较大重构、新增依赖、运行时变更，先开 issue 或在 PR 描述中说明动机，再动手。
- 提交前本地跑完对应的检查，不要推送未验证的代码。

## Stack And Conventions

- TypeScript，`strict` 模式，ESM 导入；本地文件导入带 `.ts` 后缀（`allowImportingTsExtensions`）。
- Bun 1.3+ 作为运行时和包管理器：`bun install` / `bun run` / `bun test`，不要使用 npm、yarn、pnpm、node、ts-node、jest、vitest。
- 优先使用 Bun 内置 API（`Bun.serve`、`Bun.file`、`bun:sqlite`、`Bun.$`），Bun 相关约定见 [CLAUDE.md](CLAUDE.md)。
- 依赖锁定在 `bun.lock`，必须随改动一起提交。
- 使用英文命名代码标识符；注释和文档可用中文。
- 配置、密钥一律走环境变量或 `.env`（已在 `.gitignore` 中忽略），禁止提交任何凭据。
- 脚本和命令写进各子项目的 README 或 `package.json` / `Makefile`，不要只存在于聊天记录中。

## Repository Map

- `src/` - 源码，入口为 `src/index.ts`；测试文件与被测文件同目录，命名 `*.test.ts`。
- `package.json` - 脚本与依赖；`bun.lock` 为锁文件。
- `tsconfig.json` - TypeScript 配置（strict、bundler 模式、noEmit）。
- `AGENTS.md` - 本文件，agent 工作规范。
- `CLAUDE.md` - Bun 使用约定。
- `.gitignore` - 全局忽略规则。

新增目录时在此处补一行说明。

## Commit Format

所有提交信息遵循 [Conventional Commits](https://www.conventionalcommits.org/)：

```
<type>(<scope>): <subject>

[optional body]

[optional footer]
```

规则：

- `type` 必填，取值见下表。
- `scope` 可选，指明受影响的模块或子项目，例如 `launcher`、`deps`、`release`、`typecheck`。没有明确范围时省略括号。
- `subject` 用英文、小写开头、祈使语气、不加句号，控制在 72 字符以内。
- 关联 PR 或 issue 时在 subject 末尾追加 `(#123)`。
- body 用于解释"为什么"而不是"做了什么"；破坏性变更在 footer 写 `BREAKING CHANGE: ...`。
- 回滚提交使用 git 默认格式：`Revert "<原提交信息>"`。

| type        | 用途                                           |
| ----------- | ---------------------------------------------- |
| `feat`      | 新功能                                         |
| `fix`       | 修复缺陷                                       |
| `docs`      | 仅文档变更                                     |
| `chore`     | 构建、发布、依赖版本、工具配置等杂项           |
| `refactor`  | 不改变行为的代码重构                           |
| `perf`      | 性能优化                                       |
| `test`      | 新增或修改测试                                 |
| `style`     | 格式调整，不影响逻辑                           |
| `ci`        | CI 配置与脚本                                  |
| `build`     | 构建系统或外部依赖变更                         |
| `hardening` | 安全加固、权限收紧、隔离第三方路径             |
| `revert`    | 回滚（通常直接使用 git 生成的 `Revert "..."`） |

示例：

```
feat(zai): add GLM-5.3-Flash Coding Plan support (#2185)
fix(launcher): route direct Node launch paths through launcher
fix(deps): ship a zero-warning, minimal install (#1784)
chore(main): release 0.30.0 (#2165)
chore: centralize Bun version and refresh CI tool pins (#1123)
docs: add security policy
docs: tighten PR review expectations in CONTRIBUTING and AGENTS
hardening: isolate third-party paths and clean external-build inputs
Revert "fix(release): synchronize web changelog entries (#2100)"
```

不合规示例：

```
update stuff              # 缺少 type
Fix: Bug                  # type 大写、subject 大写、无信息量
feat(api): 添加登录接口。   # subject 应为英文且不加句号
```

Agent 生成的提交同样遵守以上格式，并在 body 末尾保留工具要求的署名行（如 `Co-Authored-By`）。

## Validation

提交前必须通过：

```bash
bun install
bun run typecheck
bun test
```

或一步执行 `bun run check`。迭代时可用 `bun test ./src/path/to/file.test.ts` 缩小范围，但推送前仍要跑完整检查。检查失败不要绕过；确认是既有失败时在 PR 中说明证据。

## Things To Avoid

- 不要在没有说明的情况下更换 Bun 运行时、包管理器或构建工具，也不要引入 Node 专属工具链。
- 不要引入没有明确收益的依赖。
- 不要跳过行为变化的测试。
- 不要提交 `.env`、密钥、token 或个人数据。
- 不要用 `git push --force` 覆盖远端分支；需要时使用 `--force-with-lease`。
- 不要忽略 review 意见；超出范围的建议要说明理由后再拒绝。
- 不要对反复出现的 review 问题做表面修补；重复出现通常意味着设计问题，要找根因。
