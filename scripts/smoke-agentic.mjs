#!/usr/bin/env node
import { writeFile } from "node:fs/promises";

const BASE_URL = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const MAX_STEPS = Number(process.env.SMOKE_MAX_STEPS ?? 5);
const LEGACY = process.argv.includes("--legacy");
const EXPECTED_MODE = LEGACY ? "legacy" : "agent";
const REPORT_PATH = process.env.SMOKE_REPORT_PATH;

const user = (text, id) => ({ id, role: "user", parts: [{ type: "text", text }] });
const assistant = (text, id) => ({ id, role: "assistant", parts: [{ type: "text", text }] });

const cases = [
  {
    name: "greeting",
    messages: [user("Hello", "greeting-1")],
    zeroTools: true,
    requireCitation: false,
  },
  {
    name: "capability",
    messages: [user("What can you help me with?", "capability-1")],
    zeroTools: true,
    requireCitation: false,
  },
  {
    name: "thanks",
    messages: [
      user("What is a lease?", "thanks-1"),
      assistant("A lease is an agreement to rent property.", "thanks-2"),
      user("Thanks, that is clear.", "thanks-3"),
    ],
    zeroTools: true,
    requireCitation: false,
  },
  {
    name: "clic-employment",
    messages: [user("My employer wants to fire me. What are my basic employment rights in Hong Kong?", "clic-employment-1")],
    requiredTools: ["search_clic"],
    forbiddenTools: ["search_judgments", "search_legislation"],
    requireCitation: true,
  },
  {
    name: "clic-rental",
    messages: [user("How do I rent a flat in Hong Kong and what should a tenancy agreement include?", "clic-rental-1")],
    requiredTools: ["search_clic"],
    requireCitation: true,
  },
  {
    name: "clic-consumer",
    messages: [user("What can I do about a defective product bought in Hong Kong?", "clic-consumer-1")],
    requiredTools: ["search_clic"],
    requireCitation: true,
  },
  {
    name: "clic-defamation",
    messages: [user("What are my options if someone defames me online in Hong Kong?", "clic-defamation-1")],
    requiredTools: ["search_clic"],
    requireCitation: true,
  },
  {
    name: "ordinance-eo-section-7",
    messages: [user("What does section 7 of the Employment Ordinance (Cap. 57) say?", "ordinance-eo-section-7-1")],
    requiredTools: ["search_legislation", "get_ordinance_section"],
    requireCitation: true,
  },
  {
    name: "ordinance-eo-section-31",
    messages: [user("Quote and explain section 31 of the Employment Ordinance, Cap 57.", "ordinance-eo-section-31-1")],
    requiredTools: ["search_legislation", "get_ordinance_section"],
    requireCitation: true,
  },
  {
    name: "regulation-cap-57a",
    messages: [user("What does regulation 8 of the Employment Agency Regulations (Cap. 57A) provide?", "regulation-cap-57a-1")],
    requiredTools: ["search_legislation", "get_ordinance_section"],
    requireCitation: true,
  },
  {
    name: "cases-unfair-dismissal",
    messages: [user("Find Hong Kong cases about unfair dismissal and explain the court's approach.", "cases-unfair-dismissal-1")],
    requiredTools: ["search_judgments", "get_case"],
    requireCitation: true,
  },
  {
    name: "cases-negligence",
    messages: [user("What have Hong Kong courts decided about a duty of care in negligence cases?", "cases-negligence-1")],
    requiredTools: ["search_judgments", "get_case"],
    requireCitation: true,
  },
  {
    name: "cases-judicial-review",
    messages: [user("Find a Hong Kong judicial review case about procedural fairness and summarize the decision.", "cases-judicial-review-1")],
    requiredTools: ["search_judgments", "get_case"],
    requireCitation: true,
  },
  {
    name: "simplified-chinese",
    messages: [user("简体中文：香港雇员被解雇后有没有遣散费？请用简体中文回答。", "simplified-chinese-1")],
    requiredTools: ["search_clic"],
    requireCitation: true,
  },
  {
    name: "traditional-chinese",
    messages: [user("請用繁體中文解釋香港租客被業主收樓時有什麼權利。", "traditional-chinese-1")],
    requiredTools: ["search_clic"],
    requireCitation: true,
  },
  {
    name: "traditional-chinese-legislation",
    messages: [user("請用繁體中文說明《僱傭條例》（第57章）第7條的內容。", "traditional-chinese-legislation-1")],
    requiredTools: ["search_legislation", "get_ordinance_section"],
    requireCitation: true,
  },
  {
    name: "follow-up-context",
    messages: [
      user("I worked for my employer for eight years and was dismissed yesterday.", "follow-up-context-1"),
      assistant("I can help you explore the general Hong Kong legal information that may apply.", "follow-up-context-2"),
      user("Using that same situation, what payments or claims should I ask about?", "follow-up-context-3"),
    ],
    anyTools: ["search_clic", "search_judgments"],
    requireCitation: true,
  },
];

function percentile(values, fraction) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

function isRecord(value) {
  return typeof value === "object" && value !== null;
}

function parseSseEvents(body) {
  const decoder = new TextDecoder();
  let buffer = "";
  const events = [];
  return (async () => {
    const reader = body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary;
      while ((boundary = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        for (const line of frame.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (!data || data === "[DONE]") continue;
          events.push(JSON.parse(data));
        }
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) {
      for (const line of buffer.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data && data !== "[DONE]") events.push(JSON.parse(data));
      }
    }
    return events;
  })();
}

function summarizeEvents(events) {
  const tools = new Set();
  const toolCallIds = new Set();
  const sourceIds = [];
  const sourceMetadataKeys = [];
  let text = "";
  let steps = 0;
  let metadata;

  for (const event of events) {
    if (!isRecord(event)) continue;
    if (event.type === "tool-input-start" || event.type === "tool-input-available") {
      if (typeof event.toolName === "string") tools.add(event.toolName);
      if (typeof event.toolCallId === "string") toolCallIds.add(event.toolCallId);
    }
    if (event.type === "source-url" && typeof event.sourceId === "string") {
      sourceIds.push(event.sourceId);
      const custom = isRecord(event.providerMetadata) ? event.providerMetadata.custom : undefined;
      sourceMetadataKeys.push(isRecord(custom) ? Object.keys(custom).sort().join(",") : "");
    }
    if (event.type === "text-delta" && typeof event.delta === "string") text += event.delta;
    if (event.type === "start-step") steps += 1;
    if (
      (event.type === "message-metadata" || event.type === "finish") &&
      isRecord(event.messageMetadata)
    ) {
      metadata = event.messageMetadata;
    }
  }

  return { tools, toolCallCount: toolCallIds.size, sourceIds, sourceMetadataKeys, text, steps, metadata };
}

function assertCase(testCase, result) {
  const errors = [];
  const metadata = result.metadata;
  if (!isRecord(metadata)) {
    errors.push("missing message metadata");
    return errors;
  }

  if (metadata.searchMode !== EXPECTED_MODE) {
    errors.push(`expected searchMode=${EXPECTED_MODE}, got ${String(metadata.searchMode)}`);
  }
  if (typeof metadata.stepCount === "number" && metadata.stepCount > MAX_STEPS) {
    errors.push(`stepCount ${metadata.stepCount} exceeds maxSteps ${MAX_STEPS}`);
  }
  if (metadata.stepCount !== result.steps) {
    errors.push(`metadata stepCount ${String(metadata.stepCount)} does not match streamed steps ${result.steps}`);
  }
  if (metadata.toolCallCount !== result.toolCallCount) {
    errors.push(`metadata toolCallCount ${String(metadata.toolCallCount)} does not match streamed tool calls ${result.toolCallCount}`);
  }

  const uniqueSources = new Set(result.sourceIds);
  if (uniqueSources.size !== result.sourceIds.length) errors.push("duplicate sourceIds");
  if (result.sourceMetadataKeys.some((keys) => keys !== "rerank_score,rrf_score,snippet")) {
    errors.push("source metadata must contain exactly rrf_score, rerank_score, snippet");
  }

  if (LEGACY) {
    if (result.toolCallCount !== 0) errors.push("legacy mode unexpectedly emitted typed tools");
    if (!Array.isArray(metadata.searchQueries) || metadata.searchQueries.length === 0) {
      errors.push("legacy mode did not emit rewritten searchQueries");
    }
    return errors;
  }

  for (const tool of testCase.requiredTools ?? []) {
    if (!result.tools.has(tool)) errors.push(`missing required tool ${tool}`);
  }
  for (const tool of testCase.forbiddenTools ?? []) {
    if (result.tools.has(tool)) errors.push(`forbidden tool ${tool} was called`);
  }
  if (testCase.anyTools && !testCase.anyTools.some((tool) => result.tools.has(tool))) {
    errors.push(`expected one of ${testCase.anyTools.join(", ")}`);
  }
  if (testCase.zeroTools && result.tools.size !== 0) {
    errors.push(`expected zero tools, got ${[...result.tools].join(", ")}`);
  }
  if (testCase.requireCitation && result.text.trim().length === 0) {
    errors.push("grounded question produced no final answer text");
  }
  if (testCase.requireCitation && result.sourceIds.length === 0) {
    errors.push("grounded question produced no streamed sources");
  }
  if (testCase.requireCitation && !/\]\(https?:\/\/[^\s)]+\)/i.test(result.text)) {
    errors.push("answer is missing an inline markdown source citation");
  }
  return errors;
}

async function runCase(testCase) {
  const startedAt = performance.now();
  const response = await fetch(`${BASE_URL}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      messages: testCase.messages,
      maxSteps: MAX_STEPS,
      searchDepth: 2,
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok || !response.body) {
    throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  }

  const events = await parseSseEvents(response.body);
  const latencyMs = performance.now() - startedAt;
  const result = summarizeEvents(events);
  const errors = assertCase(testCase, result);
  return {
    name: testCase.name,
    pass: errors.length === 0,
    errors,
    latencyMs,
    tools: [...result.tools],
    toolCallCount: result.toolCallCount,
    sourceCount: result.sourceIds.length,
    steps: result.steps,
    metadata: result.metadata,
  };
}

const results = [];
for (const testCase of cases) {
  try {
    const result = await runCase(testCase);
    results.push(result);
    const status = result.pass ? "PASS" : "FAIL";
    console.log(`${status} ${result.name} ${result.latencyMs.toFixed(0)}ms tools=${result.tools.join(",") || "none"}`);
    for (const error of result.errors) console.log(`  - ${error}`);
  } catch (error) {
    results.push({
      name: testCase.name,
      pass: false,
      errors: [error instanceof Error ? error.message : String(error)],
      latencyMs: 0,
      tools: [],
      toolCallCount: 0,
      sourceCount: 0,
      steps: 0,
    });
    console.log(`FAIL ${testCase.name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const latencies = results.map((result) => result.latencyMs);
const toolCounts = results.map((result) => result.toolCallCount);
const totalFoundryCost = results.reduce((total, result) => {
  const cost = isRecord(result.metadata) && isRecord(result.metadata.usage)
    ? Number(result.metadata.usage.foundryCost ?? 0)
    : 0;
  return total + (Number.isFinite(cost) ? cost : 0);
}, 0);
const summary = {
  mode: EXPECTED_MODE,
  baseUrl: BASE_URL,
  maxSteps: MAX_STEPS,
  passed: results.filter((result) => result.pass).length,
  failed: results.filter((result) => !result.pass).length,
  latencyMs: {
    p50: percentile(latencies, 0.5),
    p95: percentile(latencies, 0.95),
  },
  toolCalls: {
    p50: percentile(toolCounts, 0.5),
    p95: percentile(toolCounts, 0.95),
    total: toolCounts.reduce((total, count) => total + count, 0),
  },
  foundryCost: totalFoundryCost,
  results,
};

console.log(JSON.stringify(summary, null, 2));
if (REPORT_PATH) {
  await writeFile(REPORT_PATH, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
}
process.exitCode = summary.failed === 0 ? 0 : 1;
