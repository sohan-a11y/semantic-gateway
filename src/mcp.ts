import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { MAX_PROMPT_CHARS, POLICY_VERSION, transformPrompt } from "./transform.js";

export function createMcpServer(): McpServer {
  const server = new McpServer({ name: "semantic-gateway", version: POLICY_VERSION });

  server.registerTool(
    "transform_prompt",
    {
      title: "Transform a prompt constructively",
      description: "Returns a transparent local policy receipt. This tool does not send the prompt to any model.",
      inputSchema: { prompt: z.string().min(1).max(MAX_PROMPT_CHARS) },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
    },
    async ({ prompt }) => {
      const output = transformPrompt(prompt);
      return { content: [{ type: "text", text: JSON.stringify(output) }], structuredContent: output };
    }
  );

  server.registerTool(
    "get_policy_status",
    {
      title: "Get semantic gateway policy status",
      description: "Describes the local policy engine and its privacy boundary.",
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
    },
    async () => {
      const output = {
        policyVersion: POLICY_VERSION,
        rawPromptStorage: "disabled",
        enforcement: "Use the local gateway endpoint for pre-provider enforcement.",
        limitation: "An MCP tool itself cannot intercept a host application's initial chat message."
      };
      return { content: [{ type: "text", text: JSON.stringify(output) }], structuredContent: output };
    }
  );
  return server;
}

if (process.argv[1]?.endsWith("mcp.js") || process.argv[1]?.endsWith("mcp.ts")) {
  serveStdio(createMcpServer, { onerror: (error) => console.error(`semantic-gateway MCP error: ${error.message}`) });
}
