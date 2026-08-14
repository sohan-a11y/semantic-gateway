# Prompt Intelligence: Optional First Model Stage

## What it does

When enabled, prompt intelligence runs for every `user` message received by `POST /v1/gateway/chat`:

```text
User message
  -> selected prompt-intelligence provider
  -> structured result: transformedPrompt, userGoal, explanation, instructions
  -> local deterministic guard
  -> configured main OpenAI or Anthropic provider
```

The response adds a `promptIntelligence` array. Its `userGoal` states what the first model believes you are trying to achieve; `explanation` tells you how it reframed the message; `instructions` are reusable preferences derived from the request.

This is an API-gateway flow. It does not intercept text typed directly into Codex Desktop, Codex CLI, Claude Code, Claude Desktop, or browser chat. Those clients need a controlled composer/wrapper that sends their message to `/v1/gateway/chat`.

## Privacy boundary

Prompt intelligence is **off by default**. Set `SEMANTIC_INTELLIGENCE_PROVIDER` only when you accept that raw messages submitted to `/v1/gateway/chat` will be sent to that selected provider.

- The gateway does not persist raw prompts.
- It writes only generated reusable instructions to `.semantic-gateway/prompt-intelligence-instructions.json` by default.
- That directory is excluded from Git via `.gitignore`.
- API keys remain environment variables and are neither returned by the API nor saved in the instructions file.
- Model failure, malformed output, a missing key, or an unrecognized provider stops the request before the main provider is called. There is no silent downgrade to a different provider.

“Discreet” here means minimal local persistence and clear provider selection. It does not mean secretly sending prompts to a third party.

## Configure one provider

Copy the relevant values from `.env.example` into your process environment or a secret manager. Do not commit `.env`.

### OpenAI

```powershell
$env:SEMANTIC_INTELLIGENCE_PROVIDER = "openai"
$env:OPENAI_API_KEY = "your-key"
$env:SEMANTIC_INTELLIGENCE_MODEL = "gpt-5-mini"
```

The implementation uses the OpenAI Responses API with a strict JSON schema. [OpenAI structured output documentation](https://platform.openai.com/docs/guides/structured-outputs) describes the JSON-schema response format.

### Google Gemini

```powershell
$env:SEMANTIC_INTELLIGENCE_PROVIDER = "gemini"
$env:GEMINI_API_KEY = "your-key"
$env:SEMANTIC_INTELLIGENCE_MODEL = "gemini-2.5-flash-lite"
```

The implementation uses Gemini's Interactions API structured JSON output. [Google Gemini structured output documentation](https://ai.google.dev/gemini-api/docs/structured-output) documents this response format.

### OpenAI-compatible provider or router

Use this for a provider that offers an OpenAI-compatible `chat/completions` endpoint with JSON-schema output:

```powershell
$env:SEMANTIC_INTELLIGENCE_PROVIDER = "openai-compatible"
$env:SEMANTIC_INTELLIGENCE_API_KEY = "your-provider-key"
$env:SEMANTIC_INTELLIGENCE_BASE_URL = "https://your-provider.example/v1"
$env:SEMANTIC_INTELLIGENCE_MODEL = "your-model-name"
```

Compatibility depends on the selected provider supporting `response_format: json_schema`; the gateway does not claim support for a provider until that provider is configured and exercised with its real credentials.

## Instruction file format

The gateway writes an atomic local JSON file, by default:

```text
.semantic-gateway/prompt-intelligence-instructions.json
```

It has this shape:

```json
{
  "version": 1,
  "updatedAt": "2026-08-14T00:00:00.000Z",
  "instructions": [
    "Prefer a concrete release checklist.",
    "Ask for deployment constraints before changing a release process."
  ]
}
```

Instructions are trimmed, deduplicated case-insensitively, capped at 20 entries, and capped at 500 characters each. No raw user prompt is written there.

Before every later first-stage request, the gateway reads these derived instructions and supplies them as persisted user preferences to the selected intelligence provider. A newly generated instruction takes effect on the next request; it is not added to the same model call that created it.

## Main provider remains separate

Prompt intelligence decides how to describe the goal; the existing `provider` field selects the main model:

```json
{
  "provider": "anthropic",
  "model": "your-main-model",
  "messages": [
    { "role": "user", "content": "I hate the release process." }
  ]
}
```

With the intelligence stage configured, the selected intelligence provider first receives that raw user content. The main provider receives the model-generated prompt after it has passed through the gateway's local deterministic guard.

## Source locations

- [`src/intelligence.ts`](../src/intelligence.ts): provider adapters, structured result validation, and local instruction storage.
- [`src/server.ts`](../src/server.ts): first-stage invocation, final local guard, main-provider forwarding, and API response.
- [`test/intelligence.test.ts`](../test/intelligence.test.ts): disabled mode, OpenAI result handling, malformed output, Gemini endpoint use, and instruction persistence.
- [`test/server.test.ts`](../test/server.test.ts): proves the raw prompt reaches the first-stage test double and only the transformed prompt reaches the main-provider test double.
