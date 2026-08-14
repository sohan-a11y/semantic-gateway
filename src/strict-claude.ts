import { spawn } from "node:child_process";
import { z } from "zod";

const transformationSchema = z.object({
  transformedPrompt: z.string().min(1),
  policyVersion: z.string().min(1),
  decision: z.string().min(1),
  userGoal: z.string().min(1)
}).strict();

const claudeResultSchema = z.object({
  result: z.string(),
  session_id: z.string().min(1)
}).passthrough();

export type SemanticTransformation = z.infer<typeof transformationSchema>;

export interface SemanticGatewayClient {
  transform(rawPrompt: string): Promise<SemanticTransformation>;
}

export interface ClaudeRunResult {
  text: string;
  sessionId: string;
}

export interface ClaudeRunner {
  run(transformedPrompt: string, sessionId?: string): Promise<ClaudeRunResult>;
}

export class HttpSemanticGatewayClient implements SemanticGatewayClient {
  constructor(
    private readonly options: { baseUrl: string; token: string; fetcher?: typeof fetch }
  ) {}

  async transform(rawPrompt: string): Promise<SemanticTransformation> {
    if (!rawPrompt.trim()) throw new Error("A prompt is required.");
    if (!this.options.token || this.options.token.length < 16) throw new Error("SEMANTIC_GATEWAY_TOKEN is not configured.");

    const response = await (this.options.fetcher ?? fetch)(`${this.options.baseUrl.replace(/\/$/, "")}/v1/semantic/intelligence`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.options.token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ prompt: rawPrompt })
    });
    if (!response.ok) throw new Error(`Semantic gateway rejected the prompt (HTTP ${response.status}).`);

    const parsed = transformationSchema.safeParse(await response.json());
    if (!parsed.success) throw new Error("Semantic gateway returned an invalid transformation.");
    return parsed.data;
  }
}

export class ClaudeCliRunner implements ClaudeRunner {
  constructor(private readonly options: { command?: string; cwd?: string } = {}) {}

  async run(transformedPrompt: string, sessionId?: string): Promise<ClaudeRunResult> {
    const args = ["-p", "--output-format", "json"];
    if (sessionId) args.push("--resume", sessionId);
    args.push(transformedPrompt);

    const child = spawn(this.options.command ?? process.env.CLAUDE_COMMAND ?? "claude.exe", args, {
      cwd: this.options.cwd ?? process.cwd(),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const output = await new Promise<string>((resolve, reject) => {
      let stdout = "";
      let size = 0;
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        size += Buffer.byteLength(chunk);
        if (size > 8 * 1024 * 1024) {
          child.kill();
          reject(new Error("Claude Code produced too much output."));
          return;
        }
        stdout += chunk;
      });
      child.on("error", () => reject(new Error("Unable to start Claude Code. Set CLAUDE_COMMAND to its executable path.")));
      child.on("close", (code) => {
        if (code !== 0) {
          reject(new Error(`Claude Code failed (exit code ${code ?? "unknown"}).`));
          return;
        }
        resolve(stdout);
      });
    });

    let decoded: unknown;
    try {
      decoded = JSON.parse(output);
    } catch {
      throw new Error("Claude Code returned invalid JSON.");
    }
    const parsed = claudeResultSchema.safeParse(decoded);
    if (!parsed.success) throw new Error("Claude Code returned an unexpected response.");
    return { text: parsed.data.result, sessionId: parsed.data.session_id };
  }
}

export class StrictClaudeSession {
  private sessionId: string | undefined;

  constructor(
    private readonly gateway: SemanticGatewayClient,
    private readonly claude: ClaudeRunner
  ) {}

  async submit(rawPrompt: string): Promise<ClaudeRunResult & Pick<SemanticTransformation, "userGoal" | "decision" | "policyVersion">> {
    const transformation = await this.gateway.transform(rawPrompt);
    const result = await this.claude.run(transformation.transformedPrompt, this.sessionId);
    this.sessionId = result.sessionId;
    return { ...result, userGoal: transformation.userGoal, decision: transformation.decision, policyVersion: transformation.policyVersion };
  }

  reset(): void {
    this.sessionId = undefined;
  }
}
