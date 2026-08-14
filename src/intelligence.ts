import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { MAX_PROMPT_CHARS } from "./transform.js";

const MAX_INSTRUCTIONS = 20;
const MAX_INSTRUCTION_CHARS = 500;

const modelResultSchema = z.object({
  transformedPrompt: z.string().min(1).max(MAX_PROMPT_CHARS),
  userGoal: z.string().min(1).max(1_500),
  explanation: z.string().min(1).max(2_000),
  instructions: z.array(z.string().min(1).max(MAX_INSTRUCTION_CHARS)).max(MAX_INSTRUCTIONS),
  confidence: z.number().min(0).max(1),
  requiresReview: z.boolean()
}).strict();

export type PromptIntelligenceProvider = "openai" | "gemini" | "openai-compatible";

export interface PromptIntelligenceResult extends z.infer<typeof modelResultSchema> {
  provider: PromptIntelligenceProvider;
  model: string;
  savedInstructions: number;
}

export interface PromptIntelligence {
  analyze(prompt: string): Promise<PromptIntelligenceResult>;
}

export interface InstructionStore {
  load(): Promise<string[]>;
  save(instructions: string[]): Promise<number>;
}

export class PromptIntelligenceUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PromptIntelligenceUnavailableError";
  }
}

interface StoredInstructions {
  version: 1;
  updatedAt: string;
  instructions: string[];
}

export class FileInstructionStore implements InstructionStore {
  constructor(private readonly filePath: string) {}

  async load(): Promise<string[]> {
    let existing: StoredInstructions = { version: 1, updatedAt: new Date(0).toISOString(), instructions: [] };
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<StoredInstructions>;
      if (parsed.version === 1 && Array.isArray(parsed.instructions)) {
        existing.instructions = parsed.instructions.map(normalizeInstruction).filter(Boolean).slice(0, MAX_INSTRUCTIONS);
      }
    } catch (error) {
      const code = error instanceof Error && "code" in error ? (error as NodeJS.ErrnoException).code : undefined;
      if (code !== "ENOENT") throw new PromptIntelligenceUnavailableError("Unable to read the local instruction store.");
    }
    return existing.instructions;
  }

  async save(instructions: string[]): Promise<number> {
    const normalized = [...new Set(instructions.map(normalizeInstruction).filter(Boolean))].slice(0, MAX_INSTRUCTIONS);
    if (normalized.length === 0) return 0;
    const existingInstructions = await this.load();
    const existing: StoredInstructions = { version: 1, updatedAt: new Date(0).toISOString(), instructions: existingInstructions };

    const existingSet = new Set(existing.instructions.map((instruction) => instruction.toLocaleLowerCase()));
    const additions = normalized.filter((instruction) => !existingSet.has(instruction.toLocaleLowerCase()));
    if (additions.length === 0) return 0;

    const next: StoredInstructions = {
      version: 1,
      updatedAt: new Date().toISOString(),
      instructions: [...existing.instructions, ...additions].slice(0, MAX_INSTRUCTIONS)
    };
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, this.filePath);
    return additions.length;
  }
}

export interface ConfiguredIntelligenceOptions {
  environment?: NodeJS.ProcessEnv;
  fetcher?: typeof fetch;
  instructionStore?: InstructionStore;
}

interface ProviderConfig {
  provider: PromptIntelligenceProvider;
  model: string;
  apiKey: string;
  baseUrl: string;
}

const intelligenceJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    transformedPrompt: { type: "string" },
    userGoal: { type: "string" },
    explanation: { type: "string" },
    instructions: { type: "array", items: { type: "string" } },
    confidence: { type: "number" },
    requiresReview: { type: "boolean" }
  },
  required: ["transformedPrompt", "userGoal", "explanation", "instructions", "confidence", "requiresReview"]
};

const intelligenceSystemPrompt = `You are a prompt-intelligence stage. Return only JSON matching the requested schema. Preserve the user's legitimate objective, convert destructive framing into a constructive and safe request, and never invent authority or actions. Explain the actual user goal in userGoal. instructions must be short reusable preferences derived from the request, never include API keys, credentials, private identifiers, or the raw prompt. If meaning is ambiguous, set requiresReview to true.`;

function normalizeInstruction(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, MAX_INSTRUCTION_CHARS);
}

function providerConfig(environment: NodeJS.ProcessEnv): ProviderConfig | undefined {
  const selected = (environment.SEMANTIC_INTELLIGENCE_PROVIDER ?? "disabled").toLocaleLowerCase();
  if (selected === "disabled") return undefined;
  if (selected === "openai") {
    const apiKey = environment.OPENAI_API_KEY;
    if (!apiKey) throw new PromptIntelligenceUnavailableError("OPENAI_API_KEY is required when SEMANTIC_INTELLIGENCE_PROVIDER=openai.");
    return { provider: "openai", apiKey, model: environment.SEMANTIC_INTELLIGENCE_MODEL ?? "gpt-5-mini", baseUrl: (environment.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, "") };
  }
  if (selected === "gemini") {
    const apiKey = environment.GEMINI_API_KEY;
    if (!apiKey) throw new PromptIntelligenceUnavailableError("GEMINI_API_KEY is required when SEMANTIC_INTELLIGENCE_PROVIDER=gemini.");
    return { provider: "gemini", apiKey, model: environment.SEMANTIC_INTELLIGENCE_MODEL ?? "gemini-2.5-flash-lite", baseUrl: (environment.GEMINI_BASE_URL ?? "https://generativelanguage.googleapis.com/v1beta").replace(/\/$/, "") };
  }
  if (selected === "openai-compatible") {
    const apiKey = environment.SEMANTIC_INTELLIGENCE_API_KEY;
    const baseUrl = environment.SEMANTIC_INTELLIGENCE_BASE_URL;
    if (!apiKey || !baseUrl) throw new PromptIntelligenceUnavailableError("SEMANTIC_INTELLIGENCE_API_KEY and SEMANTIC_INTELLIGENCE_BASE_URL are required when SEMANTIC_INTELLIGENCE_PROVIDER=openai-compatible.");
    return { provider: "openai-compatible", apiKey, model: environment.SEMANTIC_INTELLIGENCE_MODEL ?? "default", baseUrl: baseUrl.replace(/\/$/, "") };
  }
  throw new PromptIntelligenceUnavailableError("SEMANTIC_INTELLIGENCE_PROVIDER must be disabled, openai, gemini, or openai-compatible.");
}

function jsonFromResponse(payload: unknown): unknown {
  if (!payload || typeof payload !== "object") throw new PromptIntelligenceUnavailableError("Prompt-intelligence provider returned an invalid response.");
  const record = payload as Record<string, unknown>;
  const text = typeof record.output_text === "string"
    ? record.output_text
    : typeof record.text === "string"
      ? record.text
      : (record.choices as Array<{ message?: { content?: string } }> | undefined)?.[0]?.message?.content;
  if (typeof text !== "string") throw new PromptIntelligenceUnavailableError("Prompt-intelligence provider did not return text output.");
  try {
    return JSON.parse(text);
  } catch {
    throw new PromptIntelligenceUnavailableError("Prompt-intelligence provider did not return valid JSON.");
  }
}

async function requestModel(config: ProviderConfig, prompt: string, persistentInstructions: string[], fetcher: typeof fetch): Promise<unknown> {
  const instructionsContext = persistentInstructions.length > 0
    ? `\n\nPersisted user preferences:\n${persistentInstructions.map((instruction) => `- ${instruction}`).join("\n")}`
    : "";
  const systemPrompt = `${intelligenceSystemPrompt}${instructionsContext}`;
  let url: string;
  let headers: Record<string, string>;
  let body: Record<string, unknown>;
  if (config.provider === "gemini") {
    url = `${config.baseUrl}/interactions`;
    headers = { "x-goog-api-key": config.apiKey, "content-type": "application/json" };
    body = {
      model: config.model,
      input: `${systemPrompt}\n\nUser message:\n${prompt}`,
      response_format: { type: "text", mime_type: "application/json", schema: intelligenceJsonSchema }
    };
  } else if (config.provider === "openai") {
    url = `${config.baseUrl}/responses`;
    headers = { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" };
    body = {
      model: config.model,
      input: [
        { role: "developer", content: [{ type: "input_text", text: systemPrompt }] },
        { role: "user", content: [{ type: "input_text", text: prompt }] }
      ],
      text: { format: { type: "json_schema", name: "prompt_intelligence", strict: true, schema: intelligenceJsonSchema } }
    };
  } else {
    url = `${config.baseUrl}/chat/completions`;
    headers = { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" };
    body = {
      model: config.model,
      messages: [{ role: "system", content: systemPrompt }, { role: "user", content: prompt }],
      response_format: { type: "json_schema", json_schema: { name: "prompt_intelligence", strict: true, schema: intelligenceJsonSchema } }
    };
  }
  let response: Response;
  try {
    response = await fetcher(url, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
  } catch {
    throw new PromptIntelligenceUnavailableError("Prompt-intelligence provider could not be reached.");
  }
  if (!response.ok) throw new PromptIntelligenceUnavailableError(`Prompt-intelligence provider request failed with status ${response.status}.`);
  return jsonFromResponse(await response.json());
}

export function createConfiguredPromptIntelligence(options: ConfiguredIntelligenceOptions = {}): PromptIntelligence | undefined {
  const environment = options.environment ?? process.env;
  const config = providerConfig(environment);
  if (!config) return undefined;
  const fetcher = options.fetcher ?? fetch;
  const instructionsPath = environment.SEMANTIC_INTELLIGENCE_INSTRUCTIONS_PATH ?? path.resolve(".semantic-gateway", "prompt-intelligence-instructions.json");
  const store = options.instructionStore ?? new FileInstructionStore(instructionsPath);

  return {
    async analyze(prompt: string): Promise<PromptIntelligenceResult> {
      if (prompt.length === 0 || prompt.length > MAX_PROMPT_CHARS) throw new PromptIntelligenceUnavailableError("Prompt length is invalid for prompt intelligence.");
      const persistentInstructions = await store.load();
      const parsed = modelResultSchema.safeParse(await requestModel(config, prompt, persistentInstructions, fetcher));
      if (!parsed.success) throw new PromptIntelligenceUnavailableError("Prompt-intelligence provider output did not match the required schema.");
      const savedInstructions = await store.save(parsed.data.instructions);
      return { ...parsed.data, provider: config.provider, model: config.model, savedInstructions };
    }
  };
}
