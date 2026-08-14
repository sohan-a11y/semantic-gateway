# Semantic Gateway: Actual Behavior, Examples, and Limits

This document describes what version `0.1.0` does **today**. It separates verified behavior from ideas for a future version.

## Short answer

The gateway can transform prompts **before forwarding them to OpenAI or Anthropic only when the caller sends the request to `POST /v1/gateway/chat`**. The gateway transforms every `user` message in that request, then forwards the transformed message to the selected provider.

The Codex and Claude Code MCP registrations make two tools available:

- `transform_prompt` transforms a prompt locally and shows a receipt.
- `get_policy_status` shows the current policy boundary.

An MCP tool does **not** intercept the text you type into Codex Desktop, Codex CLI, Claude Code, Claude Desktop, or web chat. Those clients choose whether to call an MCP tool after they have already received your initial message. A controlled API client or wrapper that sends every request to this gateway is required for mandatory “gateway first” enforcement.

## Tested prompt outcomes

| You send | Result | Decision | Why |
|---|---|---|---|
| `Help me plan a better onboarding flow.` | Same text | `pass_through` | No current rule applies. |
| `I hate this codebase. Fix it.` | `Help me understand the problems with this codebase and create a prioritized, constructive plan to address them.` | `constructive_reframe` | The prompt starts with `I hate ...`. |
| `How can I hurt someone who insulted me?` | A conflict de-escalation, safety, boundaries, and lawful-resolution request | `safety_redirect` | Matches interpersonal-harm wording. |
| `I want to hurt myself.` | An immediate-safety and trusted-support request | `safety_redirect` | Matches the self-harm rule. |
| `How do I hack into my neighbor's Wi-Fi?` | An authorized defensive-security and lab-learning request | `safety_redirect` | Matches unauthorized-access wording. |
| `I want to sabotage this project.` | A harm-prevention and constructive-solution request | `constructive_reframe` | Matches `destroy`, `sabotage`, or `ruin`. |

These examples are backed by executable tests in [`test/transform.test.ts`](../test/transform.test.ts) and [`test/server.test.ts`](../test/server.test.ts).

## Exact v1 rule boundaries

The transformer is deterministic regular-expression logic; it is not an LLM or semantic classifier yet. The current recognized patterns are:

| Rule ID | It matches | It does not guarantee |
|---|---|---|
| `self-harm-support-v1` | `suicide`, `kill myself`, `hurt myself`, `harm myself`, `end my life` | Synonyms or indirect statements such as `I do not want to be here`. |
| `interpersonal-harm-deescalation-v1` | `hurt`, `harm`, `kill`, `attack`, or `assault` followed by `someone`, `somebody`, `a person`, `people`, `him`, `her`, or `them` | Every violent phrasing, target, spelling variation, or language. |
| `unauthorized-access-redirect-v1` | `hack into`, `break into`, stealing a password/account/credential, or bypassing a password/login/security | All cyber-risk requests. For example, many ambiguous security questions pass through. |
| `negative-framing-reframe-v1` | A prompt that **starts with** `I hate ` | `This codebase is terrible` or `Can you explain why I hate this codebase?`; neither starts with the required form. |
| `damage-prevention-reframe-v1` | Any use of `destroy`, `sabotage`, or `ruin` | Context-sensitive meaning. For example `ruin a surprise` is also reframed even if harmless. |
| `no-change-v1` | Anything not matched above | Sentiment analysis, nuance, sarcasm, languages other than the covered English phrases, or universal positivity. |

The exact implementation is [`src/transform.ts`](../src/transform.ts). Add or change rules there, and add matching tests in [`test/transform.test.ts`](../test/transform.test.ts).

## What works in each integration

| Surface | Current state | What works | What will not happen automatically |
|---|---|---|---|
| Gateway API | Implemented | Every `user` message sent to `/v1/gateway/chat` is transformed before provider forwarding. Receipts are returned. | It cannot control calls sent directly to OpenAI, Anthropic, or any other endpoint. |
| Claude Code MCP | Installed and connected at user scope | Claude can call `transform_prompt` and `get_policy_status`. | A normal initial Claude Code prompt is not automatically rewritten before Claude sees it. |
| Codex MCP | Installed and enabled in user config | Codex can call the same two MCP tools in a new/restarted session. | A normal initial Codex prompt is not automatically rewritten before Codex sees it. |
| Codex Desktop / hosted ChatGPT | Not an ingress proxy | The configured MCP tool can be available in a session. | This repository cannot transparently intercept text typed into hosted chat UI. |
| Claude Desktop / claude.ai chat | Not configured by this repository | You could separately connect an MCP tool where supported. | This user-scoped Claude Code installation does not automatically configure Claude Desktop or claude.ai chat. |
| Any unsupported provider / local model | Not implemented | None through `/v1/gateway/chat`. | It will not forward to Ollama, Gemini, Bedrock, or other providers in v1. |

Claude Code documents MCP servers as external tools/resources, with user-scoped stdio configuration available across projects; its tool model is why MCP alone is not a pre-message interceptor. See [Claude Code MCP documentation](https://code.claude.com/docs/en/mcp). Codex also supports MCP as an extension surface; see [official OpenAI MCP documentation](https://learn.chatgpt.com/docs/extend/mcp).

## Where it is configured on this Windows machine

These are machine-local configuration files, so they are not committed to GitHub:

| Client | Configuration location | Registered command |
|---|---|---|
| Codex | `C:\Users\kalya\.codex\config.toml` under `[mcp_servers.semantic_gateway]` | `C:\Program Files\nodejs\node.exe` running this repository’s `dist\mcp.js` |
| Claude Code | `C:\Users\kalya\.claude.json` as user-scoped `semantic-gateway` | `C:\Program Files\nodejs\node.exe` running this repository’s `dist\mcp.js` |

To verify after an update:

```powershell
# In this repository
npm run build

# Claude Code
claude mcp get semantic-gateway

# Codex CLI installation bundled with the desktop app
& "C:\Users\kalya\AppData\Local\OpenAI\Codex\bin\8e8bf206e63ac436\codex.exe" mcp list
```

Restart Codex Desktop after changing its MCP configuration. Claude Code reported this server as `Connected` at the time this guide was written.

## Real gateway request example

Start the local gateway in one terminal after setting a local token and relevant provider key:

```powershell
$env:SEMANTIC_GATEWAY_TOKEN = "replace-with-a-long-random-local-token"
$env:OPENAI_API_KEY = "your-key-in-your-shell-or-secret-manager"
npm run build
npm start
```

Then make the model request through the gateway—not directly to the provider:

```powershell
$headers = @{
  Authorization = "Bearer $env:SEMANTIC_GATEWAY_TOKEN"
  "Content-Type" = "application/json"
}

$body = @{
  provider = "openai"
  model = "your-model-name"
  messages = @(
    @{ role = "user"; content = "I hate this codebase. Fix it." }
  )
} | ConvertTo-Json -Depth 4

Invoke-RestMethod `
  -Uri "http://127.0.0.1:8787/v1/gateway/chat" `
  -Method Post `
  -Headers $headers `
  -Body $body
```

The response contains `transformationReceipts` and `providerResponse`. The provider receives the transformed user message, not the original negative wording. This path is tested with a mock upstream in [`test/server.test.ts`](../test/server.test.ts).

## Privacy and security behavior

- The receipt deliberately does not include the raw prompt; `rawPromptStored` is always `false` in v1.
- The server binds to `127.0.0.1`, requires a bearer token, limits request bodies to 64 KiB, validates strict JSON schemas, and rate-limits requests.
- Provider API keys are read from environment variables, never accepted in a request body, saved to the repository, or written to the MCP configuration.
- The supplied upstream URL is not caller-controlled; only the configured OpenAI or Anthropic base URL is used. This prevents endpoint injection and bypass routes.

See [`src/server.ts`](../src/server.ts) for the HTTP boundary and provider adapters, [`src/mcp.ts`](../src/mcp.ts) for the MCP tools, and [`.env.example`](../.env.example) for the names of required environment variables.

## Not yet built

These would require future work and should not be assumed from the current repository:

- A true semantic/embedding or local-model classifier.
- Full multilingual coverage and context-aware transformation.
- A desktop composer, browser extension, Codex/Claude hook, or provider-network proxy that enforces gateway-first for ordinary hosted-chat typing.
- Streaming responses, multimodal content, tool-call forwarding, conversation persistence, encrypted local audit storage, team policy administration, or provider adapters beyond OpenAI and Anthropic.
- A guarantee that every negative prompt becomes “good”; v1 only applies the exact rules above and prioritizes safe redirects for requests involving harm.
