# CLI 用法

[English](USAGE.md) | [简体中文](USAGE.zh-CN.md)

在 shell、脚本或带 shell 权限的 agent 里搜索本地会话索引。不需要 server——CLI 打开的是 UI 使用的同一个 `index.db`。

这是 [POSITIONING.zh-CN.md](POSITIONING.zh-CN.md) 里路线图 **A** 的命令行形态：让人*或 agent* 查以前是怎么解决的。

## 开始之前

索引必须存在。先构建一次（并在会话变化后重跑——`serve`/应用每 90 秒刷新，CLI 自己从不扫描）：

```bash
bun run scan
```

索引位置：`~/Library/Application Support/session-recall/index.db`。用 `SESSION_RECALL_DB=/path/to/index.db` 覆盖。

## 快速开始

```bash
bun run sr "websocket" --limit 3        # `sr` 是 search 子命令的别名
bun run sr "websocket" --agent omp --json
bun run sr "ENOENT" --scope process
```

`bun run sr …` 是 `bun run src/cli.ts search …` 的简写；两者等价。在打包应用里，同样的逻辑可以通过 sidecar 二进制 `session-recall search …` 使用。

## 选项

| 选项 | 含义 |
| --- | --- |
| `<query>` | 一个或多个裸词（AND），或 `"精确短语"`。省略 → 退出 2。 |
| `--limit <n>` | 最多返回的**会话**数（不是 turn）。1–5000，默认 10。 |
| `--agent <id>` | 限定 agent：`omp`、`pi`、`opencode`、`cursor`、`alma`、`cindy`、`claude-code`、`codex`。可重复或用逗号分隔（`--agent omp,pi`）。 |
| `--scope qa\|process` | `qa`（默认）搜索提问和回答；`process` 搜索工具输入、工具输出和提取出的错误行。 |
| `--json` | 机器可读输出（见下）。 |
| `-h`, `--help` | 打印用法并退出 0。 |
| `--` | 选项结束；之后的所有内容都属于查询。 |

`--flag=value` 和 `--flag value` 都接受。

## 文本输出

```
query "websocket" · 50 hit(s) in 3 session(s) · 14.6 ms · scope: qa · mode: fts

1. cindy:a3764542-066a-4e16-9a64-ce173d1b9325  [cindy]  2026-11-11
   ~/projects/example
   · Q  看一下 websocket 重连的实现
     A  读完了 `/Users/you/projects/example/README.md`，重连逻辑在 `src/socket.ts`…
```

- 每个会话一个块；会话按最后活动时间排序（最新在前），会话内 turn 也最新在前。
- 每条命中打印提问和紧随其后的回答，并截断。`process` 范围下命中打印工具名、状态和匹配片段。
- `$HOME` 下的项目路径显示为 `~/…`。

## JSON 输出

```json
{
  "query": "frontmatter",
  "scope": "qa",
  "mode": "fts",
  "limit": 1,
  "agents": [],
  "tookMs": 27.2,
  "totalTurns": 5,
  "totalSessions": 5,
  "returned": 1,
  "results": [
    {
      "sessionId": "omp:2026-11-11T07-24-53-192Z_01a1c97e-…",
      "agent": "omp",
      "project": "/Users/you/projects/example",
      "date": "2026-11-11",
      "updatedAt": 1794384516436,
      "title": "📰 ART: Investigate inconsistent article display in app",
      "hits": [
        {
          "turnIdx": 1,
          "ts": 1794383882500,
          "date": "2026-11-11",
          "matchField": "assistant",
          "snippet": "已加上。编辑器现在把文档开头的 `---…---` 收成一个独立的 `FrontMatter` 块…",
          "question": "Re \"要不要给编辑器加 front-matter 解析支持…\": 加",
          "answer": "已加上。编辑器现在把文档开头的 `---…---` …",
          "tool": "",
          "status": ""
        }
      ]
    }
  ]
}
```

顶层字段：`query`、`scope`、`mode`（`fts` / `like`）、`limit`、`agents`、`tookMs`、`totalTurns`、`totalSessions`、`returned`、`results[]`。

每个结果：`sessionId`、`agent`、`project`、`date`、`updatedAt`（epoch ms）、`title`、`hits[]`。每条命中：`turnIdx`、`ts`、`date`、`matchField`（`user`/`assistant`/`tool`/`input`/`error`）、`snippet`、`question`、`answer`、`tool`、`status`。`qa` 范围下 `tool`/`status` 为空；`process` 范围下 `question`/`answer` 为空。

## 退出码

| 码 | 含义 |
| --- | --- |
| `0` | 打印了结果，**或**合法查询但没有匹配。 |
| `1` | 索引缺失或不可读（`index not found: …`）。 |
| `2` | 参数非法（缺查询、`--limit`/`--agent`/`--scope` 错误、未知选项）。 |

## 常用例子

```bash
# 某个中文短语最近出现的位置
bun run sr "目录范围" --limit 5

# 只搜一个 agent，输出 JSON，然后只保留 session id
bun run sr "websocket" --agent omp --json | jq -r '.results[].sessionId'

# 找某条命令/工具在哪里运行过，或某个路径在哪里出现过（不在提问里）
bun run sr "ENOENT" --scope process --limit 20

# 某个项目最近工作的错误行
bun run sr "Cannot find module" --scope process --json \
  | jq '.results[] | select(.project|contains("example"))'

# 把最上面的回答喂给新 prompt
bun run sr "setext heading" --json --limit 1 | jq -r '.results[0].hits[0].answer'
```

## 从 agent 使用

有 shell 权限的 agent 可以直接调用 CLI；`--json` 给它稳定字段。一个最小包装：

```bash
# recall "query" [--agent id] [--scope qa|process]
bun run sr "$@" --json --limit 5
```

因为 `search` 只读且离线，交给 agent 是安全的：它从不扫描、不修改索引，也不碰 agent 自己的存储。（下面的 `forget` / `unforget` 是唯一会写入的命令，不要交给你不信任其修改索引的 agent。）

## 报告

`brief` 生成日报 standup、旧的 archive dump 或周报：

```bash
bun run src/cli.ts brief [YYYY-MM-DD] [--format standup|archive|week] [--week YYYY-Www] [--lang zh|en]
```

`--lang` 选择中文或英文模板，front matter 的 `lang:` 记录实际使用的语言。不带这个参数时用保存的语言偏好；`auto` 表示中文。

## 忘记会话

从索引移除会话不会改动原始 transcript：

```bash
bun run src/cli.ts forget omp:2026-11-10T01-13-16-427Z_01a1c304
bun run src/cli.ts unforget omp:2026-11-10T01-13-16-427Z_01a1c304
```

id 是搜索输出和 JSON 字段里使用的 `<agent>:<id>` 形式。`forget` 删除会话行和 FTS 条目，重建并压缩索引，并把 id 记到 `forgotten_session`，之后每次扫描都会跳过它。`unforget` 清除标记；下次扫描重新索引。两者都会拿共享扫描锁，扫描进行中会拒绝运行。

生成的报告是纯 Markdown，从不改写，所以 `forget` 会列出仍提到该会话的文件——请自行重新生成或删除。在应用里，同一操作是会话页上的「忘记此会话」按钮，状态行提供「撤销」。

## 说明与限制

- **只读搜索。** `search` 只调用 `src/search.ts` 的 `searchTurns`；它从不扫描、不写索引，也不以写方式打开 agent 存储。
- **短查询 / CJK。** 少于三个字符的查询（例如两字中文词）会回退到带相同过滤条件的索引 `LIKE`；`mode` 显示 `like`。
- **索引是快照**，来自最后一次 `bun run scan`（或 `serve`/应用运行时的最近 90 秒刷新）。如果最近的会话缺失，运行 `bun run scan`。
- **限制是会话级。** `--limit` 统计会话，不是命中；每个会话可以包含多个匹配 turn。
- **暂不支持按项目/日期过滤。** CLI 暴露 `--agent` 和 `--scope`；项目和日期过滤存在于 HTTP API 和 UI，但还没有命令行选项。
