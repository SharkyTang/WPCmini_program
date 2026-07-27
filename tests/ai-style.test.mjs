import assert from "node:assert/strict";
import {
  addAiSessionUsage,
  applyAiStyleSuggestion,
  STYLE_GUIDE,
  createEmptyAiSession,
  ignoreAiStyleSuggestion,
  isAiCostLimitReached,
  sanitizeAiStyleSuggestion,
  storeAiStyleSuggestion
} from "../aiStyleLogic.mjs";
import {
  buildStylePrompt,
  estimateOpenAiCostUSD,
  normalizeUsageForResponse,
  parseStyleResponse,
  requestAiStyleSuggestion
} from "../aiStyleServer.mjs";
import { buildExportRecord, createEmptyRecord } from "../classifierLogic.mjs";

async function test(name, fn) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

const baseRecord = createEmptyRecord({ name: "demo.jpg", size: 1024, lastModified: 1 }, 0);

await test("sanitizes AI style suggestions and filters illegal styles", () => {
  const suggestion = sanitizeAiStyleSuggestion({
    styles: ["国潮", "高端", "不存在", "时尚"],
    confidence: 0.9,
    reason: "测试",
    usage: { prompt_tokens: 100, completion_tokens: 20 },
    estimatedCostUSD: 0.001
  });

  assert.deepEqual(suggestion.styles, ["国风", "轻奢", "时尚"]);
  assert.equal(suggestion.usage.inputTokens, 100);
  assert.equal(suggestion.usage.outputTokens, 20);
  assert.equal(suggestion.estimatedCostUSD, 0.001);
});

await test("accepting AI suggestion only changes styles and AI review fields", () => {
  const record = {
    ...baseRecord,
    packageTypes: ["礼盒"],
    styles: ["商务"],
    priceLevel: "基础款",
    crafts: ["烫金"],
    scenes: ["送礼"],
    statuses: ["热门产品"]
  };
  const nextRecord = applyAiStyleSuggestion(record, {
    styles: ["国潮"],
    confidence: 0.8,
    reason: "测试",
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    estimatedCostUSD: 0.0001
  });

  assert.deepEqual(nextRecord.styles, ["国风"]);
  assert.deepEqual(nextRecord.packageTypes, ["礼盒"]);
  assert.equal(nextRecord.priceLevel, "基础款");
  assert.equal(Object.hasOwn(nextRecord, "crafts"), false);
  assert.deepEqual(nextRecord.scenes, ["送礼"]);
  assert.deepEqual(nextRecord.statuses, ["热门产品"]);
  assert.equal(nextRecord.aiStyleReviewed, true);
});

await test("ignoring AI suggestion does not change styles", () => {
  const record = storeAiStyleSuggestion({ ...baseRecord, styles: ["商务"] }, {
    styles: ["国风"],
    confidence: 0.8,
    reason: "测试"
  });
  const nextRecord = ignoreAiStyleSuggestion(record);

  assert.deepEqual(nextRecord.styles, ["商务"]);
  assert.equal(nextRecord.aiStyleReviewed, true);
});

await test("export records do not include AI internal fields", () => {
  const record = applyAiStyleSuggestion({ ...baseRecord, packageTypes: ["礼盒"] }, {
    styles: ["国风"],
    confidence: 0.8,
    reason: "测试",
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    estimatedCostUSD: 0.0001
  });
  const exported = buildExportRecord(record);

  assert.equal(Object.hasOwn(exported, "aiStyleSuggestion"), false);
  assert.equal(Object.hasOwn(exported, "aiStyleReviewed"), false);
  assert.equal(Object.hasOwn(exported, "aiUsage"), false);
  assert.equal(Object.hasOwn(exported, "aiEstimatedCostUSD"), false);
  assert.deepEqual(exported.styles, ["国风"]);
  assert.equal(Object.hasOwn(exported, "crafts"), false);
});

await test("style guide and prompt include all style definitions", () => {
  const guideStyles = STYLE_GUIDE.map((item) => item.style);
  assert.deepEqual(guideStyles, ["轻奢", "国风", "新中式", "复古", "简约", "商务", "时尚", "喜庆"]);

  const prompt = buildStylePrompt(["轻奢", "简约", "商务", "喜庆"]);
  assert.equal(prompt.includes("轻奢：精致高级"), true);
  assert.equal(prompt.includes("简约：元素少"), true);
  assert.equal(prompt.includes("商务：稳重"), true);
  assert.equal(prompt.includes("喜庆：婚宴"), true);
});

await test("AI session tracks usage and stops at cost limit", () => {
  const session = addAiSessionUsage(createEmptyAiSession(), {
    usage: { inputTokens: 1000, outputTokens: 100, totalTokens: 1100 },
    estimatedCostUSD: 1.01
  });

  assert.equal(session.recognizedCount, 1);
  assert.equal(isAiCostLimitReached(session, 1), true);
});

await test("normalizes missing token usage to zero", () => {
  assert.deepEqual(normalizeUsageForResponse({}), {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0
  });
});

await test("estimates OpenAI cost from usage", () => {
  const cost = estimateOpenAiCostUSD(
    { inputTokens: 1_000_000, outputTokens: 1_000_000, totalTokens: 2_000_000 },
    { OPENAI_STYLE_INPUT_COST_PER_1M: "0.4", OPENAI_STYLE_OUTPUT_COST_PER_1M: "1.6" }
  );
  assert.equal(cost, 2);
});

await test("parses style JSON responses", () => {
  assert.deepEqual(parseStyleResponse('{"styles":["国风"],"confidence":0.7,"reason":"测试","needsHumanReview":true}'), {
    styles: ["国风"],
    confidence: 0.7,
    reason: "测试",
    needsHumanReview: true
  });
});

await test("server response reports missing API key clearly", async () => {
  const result = await requestAiStyleSuggestion({
    payload: {
      id: "case_001",
      image: { mimeType: "image/jpeg", dataBase64: "abc" },
      allowedStyles: ["国风"]
    },
    env: {},
    fetchImpl: async () => {
      throw new Error("should not call fetch");
    }
  });

  assert.equal(result.status, 400);
  assert.equal(result.body.error.code, "missing_api_key");
  assert.deepEqual(result.body.usage, { inputTokens: 0, outputTokens: 0, totalTokens: 0 });
  assert.equal(result.body.estimatedCostUSD, 0);
});

await test("server success response includes usage and estimated cost", async () => {
  const result = await requestAiStyleSuggestion({
    payload: {
      id: "case_001",
      image: { mimeType: "image/jpeg", dataBase64: "abc" },
      allowedStyles: ["国风", "轻奢", "时尚"]
    },
    env: {
      OPENAI_API_KEY: "test-key",
      OPENAI_STYLE_INPUT_COST_PER_1M: "1",
      OPENAI_STYLE_OUTPUT_COST_PER_1M: "2"
    },
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: '{"styles":["国潮","高端"],"confidence":0.88,"reason":"传统纹样","needsHumanReview":true}' } }],
        usage: { prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200 }
      })
    })
  });

  assert.equal(result.status, 200);
  assert.deepEqual(result.body.styles, ["国风", "轻奢"]);
  assert.deepEqual(result.body.usage, { inputTokens: 1000, outputTokens: 200, totalTokens: 1200 });
  assert.equal(result.body.estimatedCostUSD, 0.0014);
});

await test("server reports malformed AI JSON", async () => {
  const result = await requestAiStyleSuggestion({
    payload: {
      id: "case_001",
      image: { mimeType: "image/jpeg", dataBase64: "abc" },
      allowedStyles: ["国风"]
    },
    env: { OPENAI_API_KEY: "test-key" },
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: "not json" } }],
        usage: {}
      })
    })
  });

  assert.equal(result.status, 502);
  assert.equal(result.body.error.code, "ai_request_error");
  assert.equal(result.body.estimatedCostUSD, 0);
});
