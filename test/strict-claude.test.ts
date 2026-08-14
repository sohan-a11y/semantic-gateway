import assert from "node:assert/strict";
import test from "node:test";
import { StrictClaudeSession, type ClaudeRunner, type SemanticGatewayClient } from "../src/strict-claude.js";

test("strict Claude session sends the raw turn only to the gateway and only the transformed turn to Claude", async () => {
  let gatewayInput = "";
  let claudeInput = "";
  const gateway: SemanticGatewayClient = {
    transform: async (rawPrompt) => {
      gatewayInput = rawPrompt;
      return {
        transformedPrompt: "Create a prioritized plan to improve this codebase.",
        policyVersion: "test-policy",
        decision: "constructive_reframe",
        userGoal: "Improve the codebase."
      };
    }
  };
  const claude: ClaudeRunner = {
    run: async (transformedPrompt) => {
      claudeInput = transformedPrompt;
      return { text: "Here is the plan.", sessionId: "session-123" };
    }
  };

  const session = new StrictClaudeSession(gateway, claude);
  const result = await session.submit("I hate this codebase. Fix it.");

  assert.equal(gatewayInput, "I hate this codebase. Fix it.");
  assert.equal(claudeInput, "Create a prioritized plan to improve this codebase.");
  assert.doesNotMatch(claudeInput, /hate this codebase/i);
  assert.equal(result.text, "Here is the plan.");
  assert.equal(result.userGoal, "Improve the codebase.");
});

test("strict Claude session fails closed when the gateway cannot transform a turn", async () => {
  let claudeCalled = false;
  const gateway: SemanticGatewayClient = {
    transform: async () => { throw new Error("Gateway unavailable"); }
  };
  const claude: ClaudeRunner = {
    run: async () => {
      claudeCalled = true;
      return { text: "must not run", sessionId: "session-123" };
    }
  };

  const session = new StrictClaudeSession(gateway, claude);
  await assert.rejects(() => session.submit("I hate this codebase. Fix it."), /Gateway unavailable/);
  assert.equal(claudeCalled, false);
});

test("strict Claude session resumes with only its in-memory Claude session identifier", async () => {
  const receivedSessionIds: Array<string | undefined> = [];
  const gateway: SemanticGatewayClient = {
    transform: async (rawPrompt) => ({
      transformedPrompt: `Constructive: ${rawPrompt}`,
      policyVersion: "test-policy",
      decision: "pass_through",
      userGoal: "Continue the task."
    })
  };
  const claude: ClaudeRunner = {
    run: async (_transformedPrompt, sessionId) => {
      receivedSessionIds.push(sessionId);
      return { text: "ok", sessionId: "session-123" };
    }
  };

  const session = new StrictClaudeSession(gateway, claude);
  await session.submit("First request");
  await session.submit("Second request");

  assert.deepEqual(receivedSessionIds, [undefined, "session-123"]);
});
