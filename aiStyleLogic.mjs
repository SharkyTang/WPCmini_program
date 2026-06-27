import { CLASSIFICATION_CONFIG, sanitizeRecord } from "./classifierLogic.mjs";

export const AI_STYLE_SESSION_STORAGE_KEY = "wine-case-classifier-ai-session-v1";
export const AI_PREVIEW_SIZES = [512, 768, 1024];
export const DEFAULT_AI_PREVIEW_EDGE = 768;
export const DEFAULT_AI_BATCH_LIMIT = 10;
export const DEFAULT_AI_COST_LIMIT_USD = 1;

export const STYLE_GUIDE = [
  {
    style: "轻奢",
    description: "精致高级、低调贵气，常见金属细节、留白、质感材质，不是强烈奢华堆料。"
  },
  {
    style: "国风",
    description: "明显中国传统视觉符号，例如山水、祥云、书法、印章、传统纹样、龙凤、红金配色。"
  },
  {
    style: "新中式",
    description: "东方感更现代克制，传统元素被简化，常见留白、细线条、雅致排版。"
  },
  {
    style: "复古",
    description: "有年代感、老酒标、老字号、怀旧色调或旧包装质感，不一定是中国风。"
  },
  {
    style: "简约",
    description: "元素少、信息层级清楚、色彩克制、排版干净，整体视觉不拥挤。"
  },
  {
    style: "商务",
    description: "稳重、正式，有企业礼赠或商务招待感，常见深色、金色、对称或规整布局。"
  },
  {
    style: "时尚",
    description: "年轻、潮流、现代品牌感，常见鲜明配色、现代字体、轻快或新消费视觉。"
  },
  {
    style: "喜庆",
    description: "婚宴、节庆、祝福感明显，常见红色、金色、吉祥元素和热闹氛围。"
  }
];

export function allowedStyleOptions() {
  return CLASSIFICATION_CONFIG.styles.options;
}

export function emptyAiUsage() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0
  };
}

export function createEmptyAiSession() {
  return {
    cumulativeCostUSD: 0,
    recognizedCount: 0,
    lastUsage: emptyAiUsage(),
    lastCostUSD: 0
  };
}

export function normalizeAiUsage(usage = {}) {
  const inputTokens = toNonNegativeInteger(usage.inputTokens ?? usage.prompt_tokens ?? usage.input_tokens);
  const outputTokens = toNonNegativeInteger(usage.outputTokens ?? usage.completion_tokens ?? usage.output_tokens);
  const totalTokens = toNonNegativeInteger(usage.totalTokens ?? usage.total_tokens) || inputTokens + outputTokens;
  return {
    inputTokens,
    outputTokens,
    totalTokens
  };
}

export function sanitizeAiStyleSuggestion(suggestion = {}, allowedStyles = allowedStyleOptions()) {
  const allowedSet = new Set(allowedStyles);
  const styles = Array.isArray(suggestion.styles)
    ? sanitizeRecord({ styles: suggestion.styles }).styles.filter((style) => allowedSet.has(style))
    : [];
  const confidence = clampNumber(suggestion.confidence, 0, 1, 0);
  const reason = String(suggestion.reason || "").trim();
  const usage = normalizeAiUsage(suggestion.usage);
  const estimatedCostUSD = normalizeCost(suggestion.estimatedCostUSD);

  return {
    styles: [...new Set(styles)],
    confidence,
    reason,
    needsHumanReview: Boolean(suggestion.needsHumanReview ?? confidence < 0.85),
    usage,
    estimatedCostUSD,
    model: suggestion.model || ""
  };
}

export function applyAiStyleSuggestion(record, suggestion, allowedStyles = allowedStyleOptions()) {
  const cleanSuggestion = sanitizeAiStyleSuggestion(suggestion, allowedStyles);
  return sanitizeRecord({
    ...record,
    styles: cleanSuggestion.styles,
    aiStyleSuggestion: cleanSuggestion,
    aiStyleReviewed: true,
    aiUsage: cleanSuggestion.usage,
    aiEstimatedCostUSD: cleanSuggestion.estimatedCostUSD,
    completed: false
  });
}

export function storeAiStyleSuggestion(record, suggestion, allowedStyles = allowedStyleOptions()) {
  const cleanSuggestion = sanitizeAiStyleSuggestion(suggestion, allowedStyles);
  return sanitizeRecord({
    ...record,
    aiStyleSuggestion: cleanSuggestion,
    aiStyleReviewed: false,
    aiUsage: cleanSuggestion.usage,
    aiEstimatedCostUSD: cleanSuggestion.estimatedCostUSD
  });
}

export function storeAiStyleError(record, message) {
  return sanitizeRecord({
    ...record,
    aiStyleSuggestion: {
      styles: [],
      confidence: 0,
      reason: "",
      needsHumanReview: true,
      error: String(message || "AI 识别失败"),
      usage: emptyAiUsage(),
      estimatedCostUSD: 0,
      model: ""
    },
    aiStyleReviewed: false,
    aiUsage: emptyAiUsage(),
    aiEstimatedCostUSD: 0
  });
}

export function ignoreAiStyleSuggestion(record) {
  return sanitizeRecord({
    ...record,
    aiStyleReviewed: true
  });
}

export function addAiSessionUsage(session, suggestion) {
  const cleanSession = {
    ...createEmptyAiSession(),
    ...(session || {})
  };
  const usage = normalizeAiUsage(suggestion?.usage);
  const estimatedCostUSD = normalizeCost(suggestion?.estimatedCostUSD);
  return {
    cumulativeCostUSD: roundCost(cleanSession.cumulativeCostUSD + estimatedCostUSD),
    recognizedCount: toNonNegativeInteger(cleanSession.recognizedCount) + 1,
    lastUsage: usage,
    lastCostUSD: estimatedCostUSD
  };
}

export function isAiCostLimitReached(session, costLimitUSD = DEFAULT_AI_COST_LIMIT_USD) {
  return normalizeCost(session?.cumulativeCostUSD) >= normalizeCost(costLimitUSD);
}

export function clampAiPreviewEdge(value) {
  const numericValue = Number(value);
  return AI_PREVIEW_SIZES.includes(numericValue) ? numericValue : DEFAULT_AI_PREVIEW_EDGE;
}

export function clampBatchLimit(value) {
  const numericValue = Math.floor(Number(value));
  if (!Number.isFinite(numericValue)) return DEFAULT_AI_BATCH_LIMIT;
  return Math.min(DEFAULT_AI_BATCH_LIMIT, Math.max(1, numericValue));
}

export function normalizeCostLimit(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue) || numericValue <= 0) return DEFAULT_AI_COST_LIMIT_USD;
  return roundCost(numericValue);
}

function toNonNegativeInteger(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue) || numericValue < 0) return 0;
  return Math.round(numericValue);
}

function clampNumber(value, min, max, fallback) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) return fallback;
  return Math.min(max, Math.max(min, numericValue));
}

function normalizeCost(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue) || numericValue < 0) return 0;
  return roundCost(numericValue);
}

function roundCost(value) {
  return Number(value.toFixed(6));
}
