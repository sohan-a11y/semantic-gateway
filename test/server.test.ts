import assert from "node:assert/strict";
import test from "node:test";
import type { PromptIntelligence } from "../src/intelligence.js";
import { createGatewayServer } from "../src/server.js";

async function withServer(run: (baseUrl: string) => Promise<void>) {
  const server = createGatewayServer({ token: "test-token-123456", maxRequestsPerMinute: 2 });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test("health is available without exposing policy data", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "ok", service: "semantic-gateway" });
  });
});

test("transform endpoint requires a bearer token", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/semantic/transform`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "I hate this project" })
    });
    assert.equal(response.status, 401);
  });
});

test("transform endpoint returns a receipt without the raw prompt", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/semantic/transform`, {
      method: "POST",
      headers: { authorization: "Bearer test-token-123456", "content-type": "application/json" },
      body: JSON.stringify({ prompt: "I hate this project" })
    });
    const body = await response.json() as { receipt: { transformedPrompt: string; rawPromptStored: boolean }; policyVersion: string };
    assert.equal(response.status, 200);
    assert.equal(body.receipt.rawPromptStored, false);
    assert.doesNotMatch(JSON.stringify(body), /I hate this project/);
    assert.match(body.policyVersion, /\S/);
  });
});

test("transform endpoint rejects unexpected request fields", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/semantic/transform`, {
      method: "POST",
      headers: { authorization: "Bearer test-token-123456", "content-type": "application/json" },
      body: JSON.stringify({ prompt: "hello", upstreamUrl: "https://example.invalid" })
    });
    assert.equal(response.status, 400);
  });
});

test("transform endpoint rate limits a caller", async () => {
  await withServer(async (baseUrl) => {
    const init = {
      method: "POST",
      headers: { authorization: "Bearer test-token-123456", "content-type": "application/json" },
      body: JSON.stringify({ prompt: "hello" })
    };
    const first = await fetch(`${baseUrl}/v1/semantic/transform`, init);
    const second = await fetch(`${baseUrl}/v1/semantic/transform`, init);
    const third = await fetch(`${baseUrl}/v1/semantic/transform`, init);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(third.status, 429);
  });
});

test("chat gateway forwards only the transformed user message", async () => {
  let forwardedBody = "";
  const server = createGatewayServer({
    token: "test-token-123456",
    forward: async (_provider, body) => {
      forwardedBody = JSON.stringify(body);
      return { id: "mock-response", choices: [] };
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/gateway/chat`, {
      method: "POST",
      headers: { authorization: "Bearer test-token-123456", "content-type": "application/json" },
      body: JSON.stringify({
        provider: "openai",
        model: "test-model",
        messages: [{ role: "user", content: "I hate this codebase" }]
      })
    });
    const body = await response.json() as { transformationReceipts: Array<{ decision: string }> };
    assert.equal(response.status, 200);
    assert.equal(body.transformationReceipts[0].decision, "constructive_reframe");
    assert.match(forwardedBody, /understand the problems/i);
    assert.doesNotMatch(forwardedBody, /I hate this codebase/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("gateway uses prompt intelligence before forwarding and returns the derived goal", async () => {
  let analyzedPrompt = "";
  let forwardedBody = "";
  const intelligence: PromptIntelligence = {
    analyze: async (prompt) => {
      analyzedPrompt = prompt;
      return {
        transformedPrompt: "Create a prioritized plan to improve the release process.",
        userGoal: "Make releases predictable and less frustrating.",
        explanation: "Kept the objective and removed negative framing.",
        instructions: ["Prefer a concrete release checklist."],
        confidence: 0.95,
        requiresReview: false,
        provider: "openai",
        model: "test-model",
        savedInstructions: 1
      };
    }
  };
  const server = createGatewayServer({
    token: "test-token-123456",
    intelligence,
    forward: async (_provider, body) => {
      forwardedBody = JSON.stringify(body);
      return { id: "mock-response" };
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/gateway/chat`, {
      method: "POST",
      headers: { authorization: "Bearer test-token-123456", "content-type": "application/json" },
      body: JSON.stringify({ provider: "openai", model: "main-model", messages: [{ role: "user", content: "I hate the release process." }] })
    });
    const body = await response.json() as { promptIntelligence: Array<{ userGoal: string }> };
    assert.equal(response.status, 200);
    assert.equal(analyzedPrompt, "I hate the release process.");
    assert.equal(body.promptIntelligence[0].userGoal, "Make releases predictable and less frustrating.");
    assert.match(forwardedBody, /prioritized plan to improve the release process/i);
    assert.doesNotMatch(forwardedBody, /I hate the release process/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("gateway returns safe validation and upstream failure responses", async () => {
  const server = createGatewayServer({
    token: "test-token-123456",
    forward: async () => { throw new Error("provider offline"); }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    const malformed = await fetch(`${baseUrl}/v1/semantic/transform`, {
      method: "POST",
      headers: { authorization: "Bearer test-token-123456", "content-type": "application/json" },
      body: "not-json"
    });
    assert.equal(malformed.status, 400);

    const invalidChat = await fetch(`${baseUrl}/v1/gateway/chat`, {
      method: "POST",
      headers: { authorization: "Bearer test-token-123456", "content-type": "application/json" },
      body: JSON.stringify({ provider: "openai", model: "m", messages: [] })
    });
    assert.equal(invalidChat.status, 400);

    const upstreamFailure = await fetch(`${baseUrl}/v1/gateway/chat`, {
      method: "POST",
      headers: { authorization: "Bearer test-token-123456", "content-type": "application/json" },
      body: JSON.stringify({ provider: "openai", model: "m", messages: [{ role: "user", content: "hello" }] })
    });
    assert.equal(upstreamFailure.status, 502);

    const missing = await fetch(`${baseUrl}/not-a-route`);
    assert.equal(missing.status, 404);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
