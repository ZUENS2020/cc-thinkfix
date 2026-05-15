# cc-thinkfix

Transparent proxy that fixes Anthropic thinking blocks so Claude Code + LiteLLM just work.

## The Problem

When Claude Code has a multi-turn conversation using thinking mode, it sends back
`thinking` and `redacted_thinking` blocks in the message history. Most OpenAI-compatible
endpoints (including LiteLLM's Anthropic adapter) choke on these blocks or silently drop
them, breaking reasoning model round-trips.

## The Solution

`cc-thinkfix` sits between Claude Code and your upstream Anthropic endpoint and:

1. **Strips `redacted_thinking` blocks** — they're opaque and can't be used anyway
2. **Converts `thinking` blocks to `<thinking>...</thinking>` text** — preserves reasoning context as plain text that any model can read
3. **Passes everything else through unchanged** — no protocol translation, no SSE re-parsing

Responses flow back untouched. Claude Code natively handles Anthropic-format responses
including thinking blocks, so no reverse transformation is needed.

## Install

```bash
npm install -g cc-thinkfix
```

Requires Node 20+.

## Usage

### With Claude Code CLI (recommended)

```bash
# Just prefix your normal claude command:
cc-thinkfix claude

# Pass any claude arguments:
cc-thinkfix claude --model deepseek-v4-pro
cc-thinkfix claude -p "explain quantum computing"
```

No config changes needed. `cc-thinkfix` auto-detects your upstream from
`~/.claude/settings.json` or `ANTHROPIC_BASE_URL` environment variable.

### Standalone proxy mode

```bash
cc-thinkfix serve --port 3456
```

Then point any Anthropic client at `http://127.0.0.1:3456`.

## How it detects the upstream

1. Reads `~/.claude/settings.json` → `env.ANTHROPIC_BASE_URL` + `env.ANTHROPIC_API_KEY`
2. Falls back to `ANTHROPIC_BASE_URL` + `ANTHROPIC_API_KEY` environment variables
3. Exits with an error if neither is found

## What happens to thinking blocks

| Anthropic Block | Transformation | Why |
|---|---|---|
| `thinking` | → text block: `<thinking>original content</thinking>` | Preserves reasoning context as readable text |
| `redacted_thinking` | Removed entirely | It's encrypted/opaque — can't be forwarded |
| `thinking` request param | Passed through unchanged | Enables thinking mode for current turn |

## Dev

```bash
npm install
npm run build       # tsc → dist/
npm run dev         # tsc --watch
```

## License

MIT