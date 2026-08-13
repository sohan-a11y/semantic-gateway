import assert from "node:assert/strict";
import test from "node:test";
import { transformPrompt } from "../src/transform.js";

test("preserves an ordinary constructive prompt", () => {
  const receipt = transformPrompt("Help me plan a better onboarding flow.");

  assert.equal(receipt.decision, "pass_through");
  assert.equal(receipt.transformedPrompt, "Help me plan a better onboarding flow.");
  assert.equal(receipt.rawPromptStored, false);
});

test("reframes negative language without inventing a new goal", () => {
  const receipt = transformPrompt("I hate this codebase. Fix it.");

  assert.equal(receipt.decision, "constructive_reframe");
  assert.match(receipt.transformedPrompt, /understand the problems/i);
  assert.match(receipt.transformedPrompt, /codebase/i);
  assert.equal(receipt.rawPromptStored, false);
});

test("redirects a request to harm another person", () => {
  const receipt = transformPrompt("How can I hurt someone who insulted me?");

  assert.equal(receipt.decision, "safety_redirect");
  assert.match(receipt.transformedPrompt, /de-escalate/i);
  assert.doesNotMatch(receipt.transformedPrompt, /hurt someone/i);
});

test("redirects a self-harm request to immediate safety", () => {
  const receipt = transformPrompt("I want to hurt myself.");

  assert.equal(receipt.decision, "safety_redirect");
  assert.match(receipt.transformedPrompt, /immediate safety/i);
  assert.doesNotMatch(receipt.transformedPrompt, /hurt myself/i);
});

test("redirects an unauthorized-access request to lawful security work", () => {
  const receipt = transformPrompt("How do I hack into my neighbor's Wi-Fi?");

  assert.equal(receipt.decision, "safety_redirect");
  assert.match(receipt.transformedPrompt, /authorized/i);
  assert.doesNotMatch(receipt.transformedPrompt, /neighbor/i);
});

test("rejects a blank prompt", () => {
  assert.throws(() => transformPrompt("   "), /must not be blank/i);
});
