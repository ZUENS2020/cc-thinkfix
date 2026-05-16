# cc-thinkfix

[![npm](https://img.shields.io/npm/v/cc-thinkfix.svg)](https://www.npmjs.com/package/cc-thinkfix)
[![node](https://img.shields.io/node/v/cc-thinkfix.svg)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/cc-thinkfix.svg)](LICENSE)

A drop-in proxy that makes **Claude Code** work cleanly against **LiteLLM** (or any
OpenAI-compatible reasoning model endpoint) by correctly round-tripping
Anthropic `thinking` blocks ↔ OpenAI `reasoning_content`.

零配置代理 — 让 **Claude Code** 通过 **LiteLLM** 调用 DeepSeek 等推理模型时，
能正确处理 Anthropic `thinking` 块 ↔ OpenAI `reasoning_content` 的多轮往返。

**[English](#english)** · **[中文](#中文)**

---

## English

### Why this exists

When Claude Code has a multi-turn conversation using a reasoning model
(DeepSeek-V4 Pro, DeepSeek-R1, etc.) through LiteLLM, the conversation
breaks after the second turn with:

```
The `reasoning_content` in the thinking mode must be passed back to the API.
```

This happens because LiteLLM's built-in `/v1/messages` adapter parses
incoming Anthropic `thinking` blocks but drops them when serializing the
outbound OpenAI request. The reasoning model then rejects the multi-turn
history for missing prior reasoning.

`cc-thinkfix` sits between Claude Code and your LiteLLM (or any
OpenAI-compatible endpoint) and does the translation correctly.

### What it actually does

- **Translates Anthropic Messages API ↔ OpenAI Chat Completions** including:
  - `thinking` blocks ↔ `reasoning_content` (the actual bug fix)
  - `tool_use` / `tool_result` ↔ `tool_calls` / role-`tool` messages
  - Multimodal `image` blocks ↔ `image_url` parts
  - `system` blocks ↔ first `role: system` message
- **Bridges SSE streams in real time** — `text_delta`, `thinking_delta`,
  and `input_json_delta` are emitted as the upstream chunks arrive.
- **Runs as a detached background daemon** — first `cc-thinkfix claude`
  invocation spawns one, subsequent invocations share it. The daemon
  shuts itself down (and restores `~/.claude/settings.json`) only after
  the last wrapper exits.
- **Self-heals after crashes** — a sidecar file mirrors the original
  upstream URL; on startup, cc-thinkfix detects an interrupted previous
  run and restores `settings.json` automatically.

### Install

```bash
npm install -g cc-thinkfix
```

Two binaries are installed: `cc-thinkfix` and the shorter alias `ccthx`.
They're identical.

Requires Node.js ≥ 20.

### Quick start

You should already have Claude Code configured to talk to LiteLLM (or
another OpenAI-compatible Anthropic-format endpoint) via
`~/.claude/settings.json` like this:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://litellm.example.com",
    "ANTHROPIC_AUTH_TOKEN": "sk-…",
    "ANTHROPIC_MODEL": "deepseek-v4-pro"
  }
}
```

Just prefix your normal `claude` invocations with `ccthx`:

```bash
ccthx claude                       # interactive
ccthx claude -p "explain memoization"  # one-shot
ccthx claude --dangerously-skip-permissions
```

`cc-thinkfix` reads your existing `settings.json`, spawns a background
daemon on a free local port, temporarily rewrites `ANTHROPIC_BASE_URL` to
point at the daemon, and launches Claude Code. When you exit, everything
is restored.

### How it works

```
              ┌───────────────────────────────────────────┐
              │  ccthx claude (terminal A)                │
              │     ↓ spawns/attaches                     │
              │   ┌────────────────────────────┐          │
              │   │ cc-thinkfix daemon         │          │
ccthx claude  │   │  (detached, OS-picked port)│          │
(terminal B) →│   │   /v1/messages handler     │          │
              │   │   Anthropic ←→ OpenAI      │          │
              │   │   reference-counted        │          │
              │   └──────────────┬─────────────┘          │
              │                  ↓                         │
              │           your LiteLLM / OpenAI            │
              └────────────────────────────────────────────┘
```

- **One daemon per machine.** State (pid + port + wrapper list) lives in
  `~/.claude/.cc-thinkfix-state.json`. A second `ccthx claude` finds the
  daemon via that file and just registers as another wrapper.
- **Random free port** picked by the OS — no fixed port to conflict with.
  Wrappers learn the port from the state file.
- **`~/.claude/settings.json` is patched** to point at the daemon while
  it's running, and restored on shutdown. A sidecar file
  (`~/.claude/.cc-thinkfix-original.json`) records the original
  `ANTHROPIC_BASE_URL` for crash recovery.
- **Reference counting**: the daemon survives any individual wrapper
  exiting. Only when the *last* wrapper exits does it tear down. A
  periodic prune handles `kill -9` of wrappers.

### Standalone mode

For non-Claude-Code clients, run a foreground proxy on a fixed port:

```bash
ccthx serve                  # binds 127.0.0.1:28080
ccthx serve --port 4000      # custom port
```

This mode does **not** patch `~/.claude/settings.json`. Point your client
at `http://127.0.0.1:28080/v1/messages` yourself.

### Configuration

cc-thinkfix reads from these places (first one wins):

1. `~/.claude/settings.json` → `env.ANTHROPIC_BASE_URL` and
   `env.ANTHROPIC_AUTH_TOKEN` (or `env.ANTHROPIC_API_KEY`)
2. Process env vars `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`
   (or `ANTHROPIC_API_KEY`)
3. Otherwise: error out

| Env var | Purpose |
|---|---|
| `ANTHROPIC_BASE_URL` | Upstream URL (LiteLLM root, with or without `/v1` suffix) |
| `ANTHROPIC_AUTH_TOKEN` | Bearer token sent to upstream |
| `ANTHROPIC_API_KEY` | Same as above, alternative name |
| `CC_THINKFIX_PORT` | Override the standalone-`serve` port (default 28080) |
| `CC_THINKFIX_DISABLE_UPDATE_CHECK` | Set to `1` to silence the daily update banner |

### Files cc-thinkfix touches

| Path | When | Cleaned up |
|---|---|---|
| `~/.claude/settings.json` | Patched while daemon is running | On daemon exit |
| `~/.claude/.cc-thinkfix-original.json` | Mirrors the original upstream URL | On daemon exit |
| `~/.claude/.cc-thinkfix-state.json` | Daemon pid + port + active wrappers | On daemon exit |
| `~/.claude/.cc-thinkfix-state.lock` | Short-lived state-file lock | After each critical section |
| `~/.claude/.cc-thinkfix-daemon.log` | Daemon stdout/stderr (appended) | Never |
| `~/.claude/.cc-thinkfix-update-check.json` | Cache of latest known npm version | Never |

### Troubleshooting

- **`ANTHROPIC_BASE_URL` got stuck on `http://127.0.0.1:NNNN`.** A previous
  `cc-thinkfix` was killed with `-9`. The next launch will self-heal
  automatically via the sidecar file. If the sidecar is also gone, just
  edit `settings.json` back to your real upstream — cc-thinkfix's
  loopback guard will refuse to start until you do.
- **`daemon did not become ready within 15s`.** Check
  `~/.claude/.cc-thinkfix-daemon.log` for the daemon's actual error —
  usually a bad upstream URL or unreachable LiteLLM.
- **Need to nuke everything and start over.**
  ```bash
  rm -f ~/.claude/.cc-thinkfix-state.json \
        ~/.claude/.cc-thinkfix-original.json \
        ~/.claude/.cc-thinkfix-update-check.json \
        ~/.claude/.cc-thinkfix-daemon.log
  rmdir ~/.claude/.cc-thinkfix-state.lock 2>/dev/null
  ```

### Development

```bash
git clone https://github.com/ZUENS2020/cc-thinkfix.git
cd cc-thinkfix
npm install
npm run build       # tsc → dist/
npm run dev         # tsc --watch
npm link            # link the global `cc-thinkfix` / `ccthx` commands
```

### License

MIT.

---

## 中文

### 为什么需要这个工具

当你用 Claude Code 通过 LiteLLM 调 DeepSeek-V4 Pro、DeepSeek-R1 这类推理模型，
**多轮对话第二轮就会失败**，报错：

```
The `reasoning_content` in the thinking mode must be passed back to the API.
```

原因：LiteLLM 自带的 `/v1/messages` 适配器解析 Anthropic 的 `thinking` 块时
有 bug ——它读得到，但**序列化给上游 OpenAI 请求时给丢了**。推理模型一看
对话历史里有 thinking-mode 的 assistant 消息但没带回 reasoning，立刻拒。

`cc-thinkfix` 是个本地小代理，挂在 Claude Code 和 LiteLLM 之间，**把翻译做对**。

### 它实际在做什么

- **完整翻译 Anthropic Messages API ↔ OpenAI Chat Completions**：
  - `thinking` 块 ↔ `reasoning_content`（核心 bug 修复）
  - `tool_use` / `tool_result` ↔ `tool_calls` / role-`tool`
  - 多模态 `image` 块 ↔ `image_url`
  - `system` 块 ↔ 首条 `role: system`
- **流式 SSE 实时桥接**：`text_delta`、`thinking_delta`、`input_json_delta`
  随上游分块到达即时发出
- **后台 daemon 引用计数**：第一次 `ccthx claude` 启 daemon，后续 `ccthx claude`
  共享它；最后一个 wrapper 退出才关 daemon 并还原 `~/.claude/settings.json`
- **崩溃自愈**：sidecar 文件记下原始上游 URL；下次启动检测到上次没收尾，
  自动还原 settings.json

### 安装

```bash
npm install -g cc-thinkfix
```

会装两个命令：`cc-thinkfix` 和短别名 `ccthx`，完全等价。

需要 Node.js ≥ 20。

### 快速上手

前提：你的 Claude Code 已经能通过 LiteLLM 调通，`~/.claude/settings.json` 里
类似：

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://litellm.example.com",
    "ANTHROPIC_AUTH_TOKEN": "sk-…",
    "ANTHROPIC_MODEL": "deepseek-v4-pro"
  }
}
```

把你原来跑 `claude` 的命令前面加上 `ccthx`：

```bash
ccthx claude                            # 交互模式
ccthx claude -p "解释一下 memoization"   # one-shot
ccthx claude --dangerously-skip-permissions
```

cc-thinkfix 会自动读你已有的 `settings.json`、在空闲端口起一个后台 daemon、
临时把 `ANTHROPIC_BASE_URL` 改成 daemon 的本地地址、然后启动 Claude Code。
退出时全部还原。

### 工作原理

```
              ┌───────────────────────────────────────────┐
              │  ccthx claude (终端 A)                     │
              │     ↓ spawn / 加入                         │
              │   ┌────────────────────────────┐          │
              │   │ cc-thinkfix daemon         │          │
ccthx claude  │   │  (detached，OS 自选端口)    │          │
(终端 B)    → │   │   /v1/messages 处理         │          │
              │   │   Anthropic ←→ OpenAI      │          │
              │   │   引用计数                  │          │
              │   └──────────────┬─────────────┘          │
              │                  ↓                         │
              │           你的 LiteLLM / OpenAI             │
              └────────────────────────────────────────────┘
```

- **一台机器一个 daemon**。状态（pid + port + wrapper 列表）写在
  `~/.claude/.cc-thinkfix-state.json`。第二个 `ccthx claude` 通过它发现
  daemon，直接登记为新 wrapper
- **端口由 OS 随机选**，不会和别人冲突。wrapper 从 state 文件读端口
- **`~/.claude/settings.json` 在 daemon 运行期间被改写**，退出时还原。
  sidecar 文件 `~/.claude/.cc-thinkfix-original.json` 记下原始
  `ANTHROPIC_BASE_URL` 用于崩溃恢复
- **引用计数**：daemon 跨越单个 wrapper 的退出。只有**最后一个** wrapper
  退出时才会拆台。周期性 prune 处理被 `kill -9` 的 wrapper

### 独立模式

如果你想给非-Claude-Code 客户端用，可以前台跑代理：

```bash
ccthx serve                  # 监听 127.0.0.1:28080
ccthx serve --port 4000      # 自定义端口
```

这个模式**不**碰 `~/.claude/settings.json`。自己把客户端指向
`http://127.0.0.1:28080/v1/messages`。

### 配置项

cc-thinkfix 按这个顺序查上游配置（第一个命中就用）：

1. `~/.claude/settings.json` 里的 `env.ANTHROPIC_BASE_URL` 和
   `env.ANTHROPIC_AUTH_TOKEN`（或 `env.ANTHROPIC_API_KEY`）
2. 进程环境变量 `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`
   （或 `ANTHROPIC_API_KEY`）
3. 都没有 → 报错退出

| 环境变量 | 作用 |
|---|---|
| `ANTHROPIC_BASE_URL` | 上游 URL（LiteLLM 根路径，带不带 `/v1` 都行） |
| `ANTHROPIC_AUTH_TOKEN` | 发给上游的 Bearer token |
| `ANTHROPIC_API_KEY` | 同上，备选名 |
| `CC_THINKFIX_PORT` | 覆盖 `serve` 独立模式的端口（默认 28080） |
| `CC_THINKFIX_DISABLE_UPDATE_CHECK` | 设为 `1` 关掉每日更新提示 |

### 涉及的文件

| 路径 | 何时写 | 何时清 |
|---|---|---|
| `~/.claude/settings.json` | daemon 运行期间被 patch | daemon 退出时还原 |
| `~/.claude/.cc-thinkfix-original.json` | 记录原始上游 URL | daemon 退出时删 |
| `~/.claude/.cc-thinkfix-state.json` | daemon pid + port + 活跃 wrapper | daemon 退出时删 |
| `~/.claude/.cc-thinkfix-state.lock` | 短暂状态锁 | 每个临界区结束 |
| `~/.claude/.cc-thinkfix-daemon.log` | daemon 的 stdout/stderr（追加） | 永不（你自己清） |
| `~/.claude/.cc-thinkfix-update-check.json` | 缓存 npm 上的最新版本号 | 永不 |

### 常见问题

- **`ANTHROPIC_BASE_URL` 卡在 `http://127.0.0.1:NNNN` 不变了**。上次
  `cc-thinkfix` 被 `kill -9` 没收尾。下次启动会通过 sidecar 自动还原。
  万一连 sidecar 都丢了，手动把 `settings.json` 改回真上游即可——loopback
  guard 会拒绝启动直到这步做完
- **`daemon did not become ready within 15s`**。看
  `~/.claude/.cc-thinkfix-daemon.log` 里 daemon 自己报的错——通常是上游
  URL 错或者 LiteLLM 不可达
- **想全部清空重来**：
  ```bash
  rm -f ~/.claude/.cc-thinkfix-state.json \
        ~/.claude/.cc-thinkfix-original.json \
        ~/.claude/.cc-thinkfix-update-check.json \
        ~/.claude/.cc-thinkfix-daemon.log
  rmdir ~/.claude/.cc-thinkfix-state.lock 2>/dev/null
  ```

### 开发

```bash
git clone https://github.com/ZUENS2020/cc-thinkfix.git
cd cc-thinkfix
npm install
npm run build       # tsc → dist/
npm run dev         # tsc --watch
npm link            # 把 `cc-thinkfix` / `ccthx` 链到全局
```

### 许可证

MIT。
