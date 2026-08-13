import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { createMcpServer } from "../src/mcp.js";

test("MCP factory exposes a named server", () => {
  const server = createMcpServer();
  assert.ok(server);
});

test("MCP server returns a local transformation receipt", async () => {
  const child = spawn(process.execPath, ["--import", "tsx", "src/mcp.ts"], {
    cwd: path.resolve(import.meta.dirname, ".."),
    stdio: ["pipe", "pipe", "pipe"]
  });
  let buffer = "";
  const messages: Array<{ id?: number; result?: unknown }> = [];
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim()) messages.push(JSON.parse(line));
    }
  });

  const waitFor = async (id: number) => {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const found = messages.find((message) => message.id === id);
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`Timed out waiting for MCP response ${id}.`);
  };

  try {
    child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1.0.0" } }
    })}\n`);
    await waitFor(1);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "transform_prompt", arguments: { prompt: "I hate this codebase" } }
    })}\n`);
    const response = await waitFor(2);
    const text = (response.result as { content: Array<{ text: string }> }).content[0].text;
    const receipt = JSON.parse(text) as { decision: string; rawPromptStored: boolean };
    assert.equal(receipt.decision, "constructive_reframe");
    assert.equal(receipt.rawPromptStored, false);
  } finally {
    child.kill();
  }
});
