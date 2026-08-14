import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  FileInstructionStore,
  PromptIntelligenceUnavailableError,
  createConfiguredPromptIntelligence
} from "../src/intelligence.js";

test("disabled prompt intelligence does not create a third-party client", () => {
  const intelligence = createConfiguredPromptIntelligence({
    environment: { SEMANTIC_INTELLIGENCE_PROVIDER: "disabled" }
  });

  assert.equal(intelligence, undefined);
});

test("configured prompt intelligence returns a validated goal and saves derived instructions only", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "semantic-gateway-"));
  const instructionsPath = path.join(directory, "instructions.json");
  const rawPrompt = "I hate the release process. Fix it.";
  const intelligence = createConfiguredPromptIntelligence({
    environment: {
      SEMANTIC_INTELLIGENCE_PROVIDER: "openai",
      OPENAI_API_KEY: "test-key",
      SEMANTIC_INTELLIGENCE_MODEL: "test-model",
      SEMANTIC_INTELLIGENCE_INSTRUCTIONS_PATH: instructionsPath
    },
    fetcher: async () => new Response(JSON.stringify({
      output_text: JSON.stringify({
        transformedPrompt: "Create a prioritized plan to improve the release process.",
        userGoal: "Make releases predictable and less frustrating.",
        explanation: "Kept the release-process goal and removed negative framing.",
        instructions: ["Prefer a concrete release checklist.", "Ask for release constraints before changing deployment."],
        confidence: 0.93,
        requiresReview: false
      })
    }), { status: 200 })
  });

  assert.ok(intelligence);
  const result = await intelligence.analyze(rawPrompt);
  assert.equal(result.provider, "openai");
  assert.equal(result.model, "test-model");
  assert.equal(result.userGoal, "Make releases predictable and less frustrating.");
  assert.equal(result.savedInstructions, 2);

  const saved = await readFile(instructionsPath, "utf8");
  assert.doesNotMatch(saved, new RegExp(rawPrompt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(saved, /concrete release checklist/);
});

test("configured prompt intelligence rejects malformed model output", async () => {
  const intelligence = createConfiguredPromptIntelligence({
    environment: {
      SEMANTIC_INTELLIGENCE_PROVIDER: "openai",
      OPENAI_API_KEY: "test-key"
    },
    fetcher: async () => new Response(JSON.stringify({ output_text: "not-json" }), { status: 200 })
  });

  assert.ok(intelligence);
  await assert.rejects(() => intelligence.analyze("hello"), PromptIntelligenceUnavailableError);
});

test("Gemini provider uses its explicit API key header and structured-output endpoint", async () => {
  let requestUrl = "";
  let requestHeaders: HeadersInit | undefined;
  const intelligence = createConfiguredPromptIntelligence({
    environment: {
      SEMANTIC_INTELLIGENCE_PROVIDER: "gemini",
      GEMINI_API_KEY: "google-test-key",
      SEMANTIC_INTELLIGENCE_MODEL: "gemini-test-model"
    },
    instructionStore: { load: async () => ["Prefer concise output."], save: async () => 0 },
    fetcher: async (url, init) => {
      requestUrl = String(url);
      requestHeaders = init?.headers;
      return new Response(JSON.stringify({
        output_text: JSON.stringify({
          transformedPrompt: "Clarify the goal.",
          userGoal: "Clarify the goal.",
          explanation: "The request is short.",
          instructions: [],
          confidence: 0.5,
          requiresReview: true
        })
      }), { status: 200 });
    }
  });

  assert.ok(intelligence);
  await intelligence.analyze("hello");
  assert.match(requestUrl, /generativelanguage\.googleapis\.com\/v1beta\/interactions$/);
  assert.equal((requestHeaders as Record<string, string>)["x-goog-api-key"], "google-test-key");
});

test("file instruction store deduplicates instructions", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "semantic-gateway-"));
  const store = new FileInstructionStore(path.join(directory, "instructions.json"));

  assert.equal(await store.save(["Prefer clear goals.", "Prefer clear goals.", "  Prefer explicit constraints.  "]), 2);
  assert.equal(await store.save(["Prefer clear goals."]), 0);
  assert.deepEqual(await store.load(), ["Prefer clear goals.", "Prefer explicit constraints."]);
});
