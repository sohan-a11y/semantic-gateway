import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { ClaudeCliRunner, HttpSemanticGatewayClient, StrictClaudeSession } from "./strict-claude.js";

async function main(): Promise<void> {
  const token = process.env.SEMANTIC_GATEWAY_TOKEN;
  if (!token) throw new Error("SEMANTIC_GATEWAY_TOKEN is required.");

  const gateway = new HttpSemanticGatewayClient({
    baseUrl: process.env.SEMANTIC_GATEWAY_URL ?? "http://127.0.0.1:8787",
    token
  });
  const session = new StrictClaudeSession(gateway, new ClaudeCliRunner());
  const terminal = createInterface({ input: stdin, output: stdout, terminal: true, historySize: 0 });

  stdout.write("Strict Semantic Claude. Your raw prompt is sent to the local gateway, not to Claude. Type /exit to quit or /reset to start a fresh Claude session.\n");
  try {
    while (true) {
      const rawPrompt = await terminal.question("\nYou > ");
      if (rawPrompt === "/exit") return;
      if (rawPrompt === "/reset") {
        session.reset();
        stdout.write("Started a fresh Claude session.\n");
        continue;
      }
      if (!rawPrompt.trim()) continue;

      try {
        const result = await session.submit(rawPrompt);
        stdout.write(`Semantic goal: ${result.userGoal}\nSent to Claude: ${result.sentToClaude}\n\nClaude > ${result.text}\n`);
      } catch (error) {
        const message = error instanceof Error ? error.message : "The turn could not be processed.";
        stdout.write(`Turn blocked: ${message}\n`);
      }
    }
  } finally {
    terminal.close();
  }
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : "Unable to start strict Claude.";
  console.error(message);
  process.exitCode = 1;
});
