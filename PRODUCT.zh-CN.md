# 产品

[English](PRODUCT.md) | [简体中文](PRODUCT.zh-CN.md)

<!-- impeccable:product-schema 1 -->

## 平台

macOS 桌面应用（Tauri 外壳包住 Bun sidecar，`sessionrecall://` 深链），加上它在随机 loopback 端口上服务的 Web UI。

## 技术栈

Bun + TypeScript，零运行时依赖：`Bun.serve` 提供 HTTP，`bun:sqlite` 做索引，原生 TypeScript + CSS 做 UI，用 `Bun.build` 打包。在 Bun/TypeScript 选型后由 owner 委托实现；当时 npm registry 不可达（`bun add` 超时），而这个工具受益于无依赖的单仓库安装。

## 用户

The owner：一个 macOS 开发者，跨多个项目运行多个 coding agent（omp、pi、OpenCode、Cursor、Alma、Cindy、Claude Code、Codex），经常中英文混用。任务是找回过去的一件事——“我在哪里解决过这个？”——当唯一线索只剩提问或回答里的半句话时。

## 产品目的

为本机每个 agent 会话建立本地、只读索引，并让问答对能在 Web UI 里搜索。成功意味着半句中文或一个代码标识符能在一秒内返回正确的会话、正确的 agent、正确的项目和周围回答。

## 定位

一个回忆工具，不是 agent 仪表盘或用量表。它跨 agent 持久化 turn 级全文索引，所以搜索即时且有排序，结果是问答对而不是文件或 token 总量。它从不写入 agent 的存储。

## 运行环境

- macOS；仅本地 `http://127.0.0.1`。
- v1 主要数据源：omp（`~/.omp/agent/sessions`）、OpenCode（`~/.local/share/opencode/opencode.db`）、Cursor IDE（`~/.cursor/projects/*/agent-transcripts`、`state.vscdb`）。
- Agent 从终端和 Cursor 启动；索引运行时会话持续增长。
- Owner 在笔记本屏幕上读结果，通常另一个 agent 还在工作。

## 能力与约束

- 适配器：omp、pi、OpenCode（v1 和 v2 表）、Cursor（transcripts + composer/bubble KV）、Alma、Cindy、Claude Code、Codex。
- 跨提问、回答和过程事件（工具调用、命令、错误）搜索，支持 agent、项目、日期、范围和角色过滤。
- 会话视图把每个提问和紧随其后的回答配对；`过程` 折叠区打开工具/推理轨迹。
- 只读：agent 数据库以只读方式打开；索引在 `~/Library/Application Support/session-recall` 下。
- 写入时脱敏密钥和 PII，并支持「忘记会话」（`forget` / `unforget`）把会话从索引移除而不碰 transcript。
- Agent 可访问的回忆：`sr` CLI 和只读 stdio MCP server。
- 日报 standup 和 ISO 周报，在侧栏和 `bun run brief` 中提供。
- WorkBuddy 只暴露本地会话元数据；transcript 在云端。已延期，并明确显示“无本地 transcript”状态。
- 假设（尚未确认）：owner 想要本地存储、不做云同步。

## 现有证据

- 真实本地数据：89 个 omp 会话、181 个 OpenCode v2 会话、425 个 Cursor composer、256 个 Cursor transcript。
- 一次一次性可行性运行产生 3,141 个 turn / 6.6 MB 文本；中文 trigram 查询 0.3 ms，两字 LIKE 回退 7 ms。
- 截图在 `docs/screenshots/en/` 和 `docs/screenshots/zh/`，由 `scripts/capture-screenshots.sh` 从合成会话生成（真实索引从不打开）。没有 testimonial 或品牌资产；也不应该编造。

## 产品原则

1. 找到那个瞬间，不是文件：每个结果都是问答对。
2. 构造上只读：坏掉的索引绝不能损坏 agent 的历史。
3. 默认本地：没有网络调用、没有账号、没有 telemetry。
4. 精确优先于装饰：界面是工作档案，密集而安静。
5. 诚实降级：读不了的来源要说明，而不是消失。

## 可访问性与包容性

键盘优先的搜索和导航、可见 focus、WCAG AA 对比度、reduced-motion 支持。中文和英文内容都必须正确渲染和搜索。
