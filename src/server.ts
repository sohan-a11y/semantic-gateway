import { createServer, IncomingMessage, Server, ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { createConfiguredPromptIntelligence, PromptIntelligence, PromptIntelligenceResult } from "./intelligence.js";
import { MAX_PROMPT_CHARS, POLICY_VERSION, TransformationReceipt, transformPrompt } from "./transform.js";

const MAX_BODY_BYTES = 64 * 1024;
const roles = ["system", "user", "assistant"] as const;

const transformRequestSchema = z.object({
  prompt: z.string().max(MAX_PROMPT_CHARS)
}).strict();

const chatRequestSchema = z.object({
  provider: z.enum(["openai", "anthropic"]),
  model: z.string().min(1).max(256),
  messages: z.array(z.object({
    role: z.enum(roles),
    content: z.string().min(1).max(MAX_PROMPT_CHARS)
  }).strict()).min(1).max(32),
  maxTokens: z.number().int().min(1).max(4096).optional()
}).strict();

type ChatRequest = z.infer<typeof chatRequestSchema>;
type Forwarder = (provider: ChatRequest["provider"], body: Record<string, unknown>) => Promise<unknown>;

export interface GatewayOptions {
  token: string;
  maxRequestsPerMinute?: number;
  forward?: Forwarder;
  intelligence?: PromptIntelligence;
}

class RateLimiter {
  private readonly entries = new Map<string, number[]>();

  constructor(private readonly maxRequests: number, private readonly windowMs = 60_000) {}

  allows(key: string): boolean {
    const now = Date.now();
    const recent = (this.entries.get(key) ?? []).filter((time) => now - time < this.windowMs);
    if (recent.length >= this.maxRequests) return false;
    recent.push(now);
    this.entries.set(key, recent);
    return true;
  }
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  response.end(JSON.stringify(body));
}

function isAuthorized(request: IncomingMessage, token: string): boolean {
  const supplied = request.headers.authorization;
  if (!supplied?.startsWith("Bearer ")) return false;
  const value = Buffer.from(supplied.slice("Bearer ".length));
  const expected = Buffer.from(token);
  return value.length === expected.length && timingSafeEqual(value, expected);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_BODY_BYTES) throw new Error("Request body is too large.");
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("Request body must be valid JSON.");
  }
}

async function transformedChat(
  input: ChatRequest,
  intelligence?: PromptIntelligence
): Promise<{ body: Record<string, unknown>; receipts: TransformationReceipt[]; intelligenceResults: PromptIntelligenceResult[] }> {
  const receipts: TransformationReceipt[] = [];
  const intelligenceResults: PromptIntelligenceResult[] = [];
  const messages = await Promise.all(input.messages.map(async (message) => {
    if (message.role !== "user") return message;
    const analysis = intelligence ? await intelligence.analyze(message.content) : undefined;
    if (analysis) intelligenceResults.push(analysis);
    const receipt = transformPrompt(analysis?.transformedPrompt ?? message.content);
    receipts.push(receipt);
    return { ...message, content: receipt.transformedPrompt };
  }));

  return { body: { ...input, messages }, receipts, intelligenceResults };
}

function configuredForwarder(): Forwarder {
  return async (provider, body) => {
    const keyName = provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY";
    const apiKey = process.env[keyName];
    if (!apiKey) throw new Error(`${keyName} is not configured.`);

    if (provider === "openai") {
      const baseUrl = (process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, "");
      const { maxTokens, ...openAiBody } = body as ChatRequest;
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ ...openAiBody, ...(maxTokens ? { max_tokens: maxTokens } : {}) })
      });
      if (!response.ok) throw new Error(`OpenAI request failed with status ${response.status}.`);
      return response.json();
    }

    const anthropicBody = body as ChatRequest & { messages: Array<{ role: string; content: string }> };
    const system = anthropicBody.messages.filter((message) => message.role === "system").map((message) => message.content).join("\n\n");
    const response = await fetch(`${(process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com/v1").replace(/\/$/, "")}/messages`, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: anthropicBody.model,
        max_tokens: anthropicBody.maxTokens ?? 1024,
        ...(system ? { system } : {}),
        messages: anthropicBody.messages.filter((message) => message.role !== "system")
      })
    });
    if (!response.ok) throw new Error(`Anthropic request failed with status ${response.status}.`);
    return response.json();
  };
}

export function createGatewayServer(options: GatewayOptions): Server {
  if (!options.token || options.token.length < 16) throw new Error("A gateway token of at least 16 characters is required.");
  const limiter = new RateLimiter(options.maxRequestsPerMinute ?? 60);
  const forward = options.forward ?? configuredForwarder();
  const intelligence = options.intelligence ?? createConfiguredPromptIntelligence();

  return createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      json(response, 200, { status: "ok", service: "semantic-gateway" });
      return;
    }
    if (request.method !== "POST" || !["/v1/semantic/transform", "/v1/gateway/chat"].includes(request.url ?? "")) {
      json(response, 404, { error: "Not found" });
      return;
    }
    if (!isAuthorized(request, options.token)) {
      json(response, 401, { error: "Unauthorized" });
      return;
    }
    if (!limiter.allows(options.token)) {
      json(response, 429, { error: "Rate limit exceeded" });
      return;
    }

    try {
      const data = await readJson(request);
      if (request.url === "/v1/semantic/transform") {
        const parsed = transformRequestSchema.safeParse(data);
        if (!parsed.success) {
          json(response, 400, { error: "Invalid transform request" });
          return;
        }
        json(response, 200, { policyVersion: POLICY_VERSION, receipt: transformPrompt(parsed.data.prompt) });
        return;
      }

      const parsed = chatRequestSchema.safeParse(data);
      if (!parsed.success) {
        json(response, 400, { error: "Invalid chat request" });
        return;
      }
      const { body, receipts, intelligenceResults } = await transformedChat(parsed.data, intelligence);
      const providerResponse = await forward(parsed.data.provider, body);
      json(response, 200, {
        policyVersion: POLICY_VERSION,
        transformationReceipts: receipts,
        promptIntelligence: intelligenceResults,
        providerResponse
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Request failed.";
      const status = /must not be blank|exceeds the|too large|valid JSON/.test(message) ? 400 : 502;
      json(response, status, { error: status === 400 ? message : "Upstream provider request failed." });
    }
  });
}

if (process.argv[1]?.endsWith("server.js")) {
  const token = process.env.SEMANTIC_GATEWAY_TOKEN;
  if (!token) {
    console.error("SEMANTIC_GATEWAY_TOKEN must be set to a value of at least 16 characters.");
    process.exitCode = 1;
  } else {
    const port = Number(process.env.SEMANTIC_GATEWAY_PORT ?? 8787);
    createGatewayServer({ token }).listen(port, "127.0.0.1", () => {
      console.error(`semantic-gateway listening on http://127.0.0.1:${port}`);
    });
  }
}
