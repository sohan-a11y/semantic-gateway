# Semantic Gateway MVP

This local-first gateway transforms each user message before it is forwarded to OpenAI or Anthropic. It always returns a transformation receipt and never stores the raw prompt. Version 0.1.0 is a deterministic policy engine; it deliberately does **not** claim full semantic understanding or universal interception of hosted chat apps.

## What works and what does not

Read [docs/EXAMPLES_AND_LIMITATIONS.md](docs/EXAMPLES_AND_LIMITATIONS.md) before relying on the gateway. It contains exact examples, the current rule boundaries, the Codex/Claude Code integration status, and source-file locations for every behavior.

## Run locally

```powershell
Copy-Item .env.example .env
# Set SEMANTIC_GATEWAY_TOKEN in your shell or a local secret manager.
$env:SEMANTIC_GATEWAY_TOKEN = "use-a-long-random-local-token"
npm run build
npm start
```

The server listens only on `127.0.0.1:8787` by default. `POST /v1/semantic/transform` and `POST /v1/gateway/chat` require `Authorization: Bearer <SEMANTIC_GATEWAY_TOKEN>`.

```powershell
$headers = @{ Authorization = "Bearer $env:SEMANTIC_GATEWAY_TOKEN"; "Content-Type" = "application/json" }
Invoke-RestMethod http://127.0.0.1:8787/v1/semantic/transform -Method Post -Headers $headers -Body '{"prompt":"I hate this codebase. Fix it."}'
```

For OpenAI-compatible forwarding, set `OPENAI_API_KEY`; for Anthropic forwarding, set `ANTHROPIC_API_KEY`. The gateway supports non-streaming text messages only in this MVP. It transforms every `user` message, then sends the transformed message to the configured provider. It will never accept a caller-provided upstream URL, avoiding SSRF and bypass routes.

## MCP policy surface

```powershell
npm run build
npm run mcp
```

Configure the compiled command as a local stdio MCP server in a supported host. It provides:

- `transform_prompt`: locally return a transformation receipt.
- `get_policy_status`: expose version, privacy boundary, and enforcement limitation.

MCP gives Codex and Claude Code access to the same policy surface. It does not itself intercept the host's initial user message; strict pre-provider enforcement requires calls to use the gateway endpoint or a controlled client wrapper.

## Verification

```powershell
npm test
npm run test:coverage
npm run build
```
