import { randomUUID } from "node:crypto";

export const POLICY_VERSION = "0.1.0";
export const MAX_PROMPT_CHARS = 12_000;

export type Decision = "pass_through" | "constructive_reframe" | "safety_redirect";

export interface TransformationReceipt {
  id: string;
  createdAt: string;
  policyVersion: string;
  decision: Decision;
  ruleId: string;
  explanation: string;
  transformedPrompt: string;
  rawPromptStored: false;
}

function receipt(
  decision: Decision,
  ruleId: string,
  explanation: string,
  transformedPrompt: string
): TransformationReceipt {
  return {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    policyVersion: POLICY_VERSION,
    decision,
    ruleId,
    explanation,
    transformedPrompt,
    rawPromptStored: false
  };
}

function safeSubject(value: string): string {
  return value
    .replace(/[\r\n]+/g, " ")
    .replace(/[^\p{L}\p{N}\s.,'/-]/gu, "")
    .trim()
    .slice(0, 180) || "the situation";
}

/**
 * Deterministic v1 policy engine. It intentionally never retains the source
 * prompt: callers receive only the generated constructive prompt and receipt.
 */
export function transformPrompt(rawPrompt: string): TransformationReceipt {
  if (typeof rawPrompt !== "string" || rawPrompt.trim().length === 0) {
    throw new Error("Prompt must not be blank.");
  }
  if (rawPrompt.length > MAX_PROMPT_CHARS) {
    throw new Error(`Prompt exceeds the ${MAX_PROMPT_CHARS}-character limit.`);
  }

  const normalized = rawPrompt.replace(/\s+/g, " ").trim();

  if (/\b(suicide|kill myself|hurt myself|harm myself|end my life)\b/i.test(normalized)) {
    return receipt(
      "safety_redirect",
      "self-harm-support-v1",
      "Replaced self-harm wording with an immediate-safety and support request.",
      "I am feeling overwhelmed and need help focusing on immediate safety, contacting trusted support, and identifying appropriate professional or emergency resources in my area."
    );
  }

  if (/\b(hurt|harm|kill|attack|assault)\s+(someone|somebody|a person|people|him|her|them)\b/i.test(normalized)) {
    return receipt(
      "safety_redirect",
      "interpersonal-harm-deescalation-v1",
      "Replaced interpersonal-harm wording with a de-escalation and safety request.",
      "Help me de-escalate this conflict safely, manage my anger, set boundaries, and find a lawful way to address what happened."
    );
  }

  if (/\b(hack into|break into|steal (?:a |an )?(?:password|account|credential)|bypass (?:a |an )?(?:password|login|security))\b/i.test(normalized)) {
    return receipt(
      "safety_redirect",
      "unauthorized-access-redirect-v1",
      "Replaced an unauthorized-access request with authorized security learning.",
      "Help me learn authorized defensive security testing, secure my own accounts and network, and practice only in an explicitly permitted lab environment."
    );
  }

  const hateMatch = normalized.match(/^\s*i\s+hate\s+(.+?)(?:[.!?]|$)/i);
  if (hateMatch) {
    const subject = safeSubject(hateMatch[1]);
    return receipt(
      "constructive_reframe",
      "negative-framing-reframe-v1",
      "Preserved the subject while turning negative framing into an improvement goal.",
      `Help me understand the problems with ${subject} and create a prioritized, constructive plan to address them.`
    );
  }

  if (/\b(destroy|sabotage|ruin)\b/i.test(normalized)) {
    return receipt(
      "constructive_reframe",
      "damage-prevention-reframe-v1",
      "Replaced destructive framing with damage prevention and constructive change.",
      "Help me prevent harm, identify the underlying problem, and pursue a constructive and lawful solution."
    );
  }

  return receipt(
    "pass_through",
    "no-change-v1",
    "No policy transformation was needed.",
    normalized
  );
}
