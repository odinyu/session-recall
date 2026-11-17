# 从源码构建与运行

本页面向开发 Session Recall 或自行构建 `.app` 的人。只想使用应用的话，直接从
[releases](https://github.com/odinyu/session-recall/releases) 下载即可——打包好的
应用自带运行环境，不需要额外安装任何东西。

## 环境要求

- macOS 11 或更高版本。
- Bun 1.3+，用于构建和源码版 CLI。
- Rust 工具链与 Tauri CLI，用于桌面外壳：
  `cargo install tauri-cli --version "^2.12"`。

## 从仓库运行

```bash
git clone https://github.com/odinyu/session-recall.git
cd session-recall
bun run scan                       # 建立索引（第一次几秒钟）
bun run sr "websocket" --limit 3   # 在终端里搜索
bun run start                      # 构建 UI 并服务 http://127.0.0.1:4319
```

`bun run start` 启动时也会扫描一次，之后每 90 秒刷新索引。偏好保存在
`<app dir>/prefs.json`（见 `src/prefs.ts`），而不是 `localStorage`，所以开发服务器
换端口重启后仍然保留；`localStorage` 只用于首屏同源缓存。

## 构建 macOS 应用

```bash
bash scripts/make-app.sh
```

脚本会构建 Web UI，把 Bun CLI 编译成自包含的 sidecar 二进制（约 61 MB，按宿主
target triple 命名），再交给 Tauri 打包：

```text
src-tauri/target/release/bundle/macos/Session Recall.app
```

bundle 是 ad-hoc 签名的（`signingIdentity: "-"`）。拷贝到别处后，首次启动前需要
清除 quarantine 标记：

```bash
xattr -dr com.apple.quarantine "Session Recall.app"
```

`bash scripts/make-app.sh` 只构建宿主架构（Apple silicon 上是 arm64，约 72 MB）。
`--arch aarch64-apple-darwin` / `--arch x86_64-apple-darwin` 构建指定切片，
必要时交叉编译 sidecar；`--universal` 构建同时覆盖 arm64 和 x86_64 的 bundle
（约 141 MB，体积大约翻倍，因为带了两份 Bun runtime）。

**它如何找到自己的部件。** Tauri 把 Bun CLI 作为 `externalBin` sidecar 放在
`Contents/MacOS/session-recall`，把构建好的 Web UI 作为 bundle resource 放在
`Contents/Resources/web/dist`。启动时 Rust 外壳（`src-tauri/src/main.rs`）会：

1. 预留一个空闲的 loopback 端口；
2. 定位 sidecar：先看 `$SESSION_RECALL_SIDECAR`，再看主可执行文件旁的
   `session-recall*` 文件，最后看 `src-tauri/binaries/`（用于 `cargo tauri dev`）；
3. 用 `SESSION_RECALL_PORT` 指向预留端口、`SESSION_RECALL_WEB_DIST` 指向资源目录
   来启动它；
4. 等端口可连接后，在 `http://127.0.0.1:<port>` 上打开 `WKWebView` 窗口；
5. 通过驱动 UI 的 hash router 来响应 `sessionrecall://` 深链，必要时把窗口带到
   前台；
6. 退出时杀掉 sidecar，不留下孤儿进程。

UI 由 Bun 以和 `bun run serve` 完全相同的方式提供，所以应用和 CLI 共用
`~/Library/Application Support/session-recall/index.db`，窗口只是同一套 HTTP API
的视图。Web 资源作为 bundle resource 发布而不是嵌进二进制，所以在没有 `web/dist`
的新克隆里 `bun run scan` 仍然可用。

图标在 `src-tauri/app-icon.png`；用 `python3 scripts/make-icon.py` 重新生成 PNG，
在 `src-tauri/` 下用 `cargo tauri icon` 重新生成整套图标。

**链接如何找到应用。** 预留端口每次启动都会变，所以任何
`http://127.0.0.1:<port>` URL 都只能在一次运行内有效。因此 bundle 注册了自己的
URL scheme（`sessionrecall`，在 `tauri.conf.json` 的 `plugins.deep-link` 里声明，
这也是 `Info.plist` 里 `CFBundleURLTypes` 的来源）。像
`sessionrecall://session/alma%3Amwbhgpzz9n7zy56fdm` 这样的链接会：应用没运行时
启动它，已在运行时聚焦它，并且最终都落到那个会话。如果链接在 webview 加载完成前
到达，会先排队，等第一次页面加载完成后再应用，所以冷启动不会丢链接。

## 开发

```bash
bun test          # 284 个测试、37 个文件
bun run build     # bundle web/app.ts -> web/dist
```

没有运行时依赖。`bun:sqlite` 提供带两种 tokenizer 的 FTS5。

## 项目结构

```text
src/
  adapters/       omp/pi、OpenCode、Cursor、Alma、Cindy、Claude Code、Codex、
                  以及 custom.ts（读 sources.json 的声明式数据源）
  brief.ts        日报 standup / archive / 周报 / 月报生成
  cli-search.ts   search 子命令：参数解析、文本/JSON 输出
  config.ts       路径和端口（APP_DIR 遵循 SESSION_RECALL_HOME）
  freshness.ts    indexAgeMs、scanIfStale、后台刷新
  index-read.ts   带 schema 版本检查的只读索引打开
  mcp.ts          stdio MCP server：JSON-RPC、紧凑工具、深链
  db.ts           schema、FTS 触发器、upsert
  handoff.ts      会话交接卡生成
  prefs.ts        prefs.json：默认值、写时合并、原子写入
  scan.ts         增量扫描编排
  scan-lock.ts    跨进程扫描锁（O_EXCL + 过期接管）
  search.ts       查询构建、排序、facets
  server.ts       Bun.serve API + 静态 UI
  util/resume.ts  shell 恢复命令和应用深链
  util/redact.ts  写入时脱敏密钥和 PII
web/
  app.ts          hash 路由 UI
  handoff.ts      交接卡缓存键、有界缓存与有界等待
  markdown.ts     安全的 Markdown 渲染器
  links.ts        应用内链接（深链、loopback）-> hash 路由映射
  styles.css      设计 token 和组件
src-tauri/
  src/main.rs     外壳：预留端口、启动 sidecar、打开窗口、深链
  tauri.conf.json bundle 配置；sidecar、Web 资源、深链 scheme
scripts/
  build.ts        Bun.build bundle
  make-app.sh     打包 macOS .app
  make-icon.py    渲染 app-icon.png（PIL，镜像 web/favicon.svg）
test/             markdown、搜索、过程搜索、事件、brief/reports、handoff、
                  links、prefs、web app 与适配器测试
brief/            生成的报告（git-ignored）
doc/              长篇文档，每篇都有英文和中文版
```

## 文档

- [`../README.zh-CN.md`](../README.zh-CN.md)——应用能做什么、怎么用。
- [`USAGE.zh-CN.md`](USAGE.zh-CN.md)——所有 CLI 与 MCP 选项、JSON schema、退出码和 recipes。
- [`MCP.zh-CN.md`](MCP.zh-CN.md)——应用和 stdio MCP 客户端如何共用一个索引。
- [`REPORTS.zh-CN.md`](REPORTS.zh-CN.md)——日报、周报和月报的模板。
- [`DESIGN.zh-CN.md`](DESIGN.zh-CN.md)——布局、字号阶梯、设计 token 和交互规则。
- [`PRODUCT.zh-CN.md`](PRODUCT.zh-CN.md)——这个应用是什么、给谁用、故意不做什么。
- [`POSITIONING.zh-CN.md`](POSITIONING.zh-CN.md)——和其他 agent 记忆工具的位置关系，以及路线图。

## License

MIT —— 见 [LICENSE](../LICENSE)。
