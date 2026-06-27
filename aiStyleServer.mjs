import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  STYLE_GUIDE,
  allowedStyleOptions,
  emptyAiUsage,
  normalizeAiUsage,
  sanitizeAiStyleSuggestion
} from "./aiStyleLogic.mjs";

const DEFAULT_MODEL = "gpt-4.1-mini";
const DEFAULT_INPUT_COST_PER_1M = 0.4;
const DEFAULT_OUTPUT_COST_PER_1M = 1.6;

export function parseEnvFile(content) {
  return String(content || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .reduce((env, line) => {
      const separatorIndex = line.indexOf("=");
      if (separatorIndex === -1) return env;

      const key = line.slice(0, separatorIndex).trim();
      let value = line.slice(separatorIndex + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }

      if (key) env[key] = value;
      return env;
    }, {});
}

export function loadLocalEnv(envPath = resolve(process.cwd(), ".env.local"), targetEnv = process.env) {
  if (!existsSync(envPath)) return false;
  const env = parseEnvFile(readFileSync(envPath, "utf8"));
  Object.entries(env).forEach(([key, value]) => {
    if (targetEnv[key] === undefined) targetEnv[key] = value;
  });
  return true;
}

export async function requestAiStyleSuggestion({
  payload,
  env = process.env,
  fetchImpl = fetch
}) {
  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) {
    return errorResponse(400, "missing_api_key", "缺少 OPENAI_API_KEY：请在 .env.local 中配置。");
  }

  const validationError = validatePayload(payload);
  if (validationError) return errorResponse(400, "invalid_request", validationError);

  const model = env.OPENAI_STYLE_MODEL || DEFAULT_MODEL;
  const allowedStyles = cleanAllowedStyles(payload.allowedStyles);
  const openAiPayload = buildOpenAiPayload(payload, allowedStyles, model);

  try {
    const response = await fetchImpl("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify(openAiPayload)
    });

    const responseBody = await safeReadJson(response);
    if (!response.ok) {
      return errorResponse(
        response.status,
        "openai_request_failed",
        responseBody?.error?.message || `OpenAI 请求失败：HTTP ${response.status}`
      );
    }

    const outputText = extractOutputText(responseBody);
    const parsedSuggestion = parseStyleResponse(outputText);
    const usage = normalizeUsageForResponse(responseBody.usage);
    const estimatedCostUSD = estimateOpenAiCostUSD(usage, env);
    const suggestion = sanitizeAiStyleSuggestion(
      {
        ...parsedSuggestion,
        usage,
        estimatedCostUSD,
        model
      },
      allowedStyles
    );

    if (!suggestion.styles.length) {
      return errorResponse(502, "invalid_ai_response", "AI 没有返回可用风格，请手动判断或重试。", usage, estimatedCostUSD, model);
    }

    return {
      status: 200,
      body: {
        ...suggestion,
        usage,
        estimatedCostUSD,
        model
      }
    };
  } catch (error) {
    return errorResponse(502, "ai_request_error", error.message || "AI 请求失败。");
  }
}

export function buildOpenAiPayload(payload, allowedStyles = allowedStyleOptions(), model = DEFAULT_MODEL) {
  const imageUrl = `data:${payload.image.mimeType};base64,${payload.image.dataBase64}`;
  return {
    model,
    response_format: { type: "json_object" },
    max_completion_tokens: 450,
    messages: [
      {
        role: "system",
        content: [
          "你是酒包装设计案例的风格初标助手。",
          "你只能根据图片视觉判断风格，不能猜客户或价格。",
          "只能从 allowedStyles 中选择 1 到 3 个风格。",
          "必须返回 JSON，不要输出 Markdown。"
        ].join("\n")
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: buildStylePrompt(allowedStyles)
          },
          {
            type: "image_url",
            image_url: { url: imageUrl }
          }
        ]
      }
    ]
  };
}

export function buildStylePrompt(allowedStyles = allowedStyleOptions()) {
  const guideByStyle = new Map(STYLE_GUIDE.map((item) => [item.style, item.description]));
  const guideLines = allowedStyles
    .filter((style) => guideByStyle.has(style))
    .map((style) => `${style}：${guideByStyle.get(style)}`);

  return [
    `allowedStyles: ${allowedStyles.join(" / ")}`,
    "",
    "重点区分：",
    ...guideLines,
    "",
    "返回 JSON 格式：",
    "{\"styles\":[\"国风\"],\"confidence\":0.8,\"reason\":\"一句中文理由\",\"needsHumanReview\":true}"
  ].join("\n");
}

export function parseStyleResponse(outputText) {
  try {
    const parsed = JSON.parse(String(outputText || "").trim());
    return {
      styles: Array.isArray(parsed.styles) ? parsed.styles : [],
      confidence: parsed.confidence,
      reason: parsed.reason,
      needsHumanReview: parsed.needsHumanReview
    };
  } catch {
    throw new Error("AI 返回的内容不是合法 JSON。");
  }
}

export function extractOutputText(responseBody = {}) {
  const content = responseBody.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => item.text || item.content || "")
      .join("")
      .trim();
  }
  throw new Error("AI 返回格式异常，找不到文本内容。");
}

export function normalizeUsageForResponse(usage) {
  return normalizeAiUsage(usage || emptyAiUsage());
}

export function estimateOpenAiCostUSD(usage = emptyAiUsage(), env = process.env) {
  const cleanUsage = normalizeUsageForResponse(usage);
  const inputCostPerMillion = readCostEnv(env.OPENAI_STYLE_INPUT_COST_PER_1M, DEFAULT_INPUT_COST_PER_1M);
  const outputCostPerMillion = readCostEnv(env.OPENAI_STYLE_OUTPUT_COST_PER_1M, DEFAULT_OUTPUT_COST_PER_1M);
  const cost =
    (cleanUsage.inputTokens / 1_000_000) * inputCostPerMillion +
    (cleanUsage.outputTokens / 1_000_000) * outputCostPerMillion;
  return Number(cost.toFixed(6));
}

function validatePayload(payload = {}) {
  if (!payload.id) return "缺少案例 id。";
  if (!payload.image || typeof payload.image !== "object") return "缺少图片数据。";
  if (!/^image\/(jpeg|png)$/i.test(payload.image.mimeType || "")) return "图片格式必须是 JPEG 或 PNG。";
  if (!payload.image.dataBase64 || typeof payload.image.dataBase64 !== "string") return "缺少 base64 图片内容。";
  if (payload.image.dataBase64.length > 10_000_000) return "预览图过大，请降低预览尺寸。";
  return "";
}

function cleanAllowedStyles(styles) {
  const configuredStyles = allowedStyleOptions();
  const allowedSet = new Set(configuredStyles);
  const cleanStyles = Array.isArray(styles) ? styles.filter((style) => allowedSet.has(style)) : [];
  return cleanStyles.length ? cleanStyles : configuredStyles;
}

async function safeReadJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function errorResponse(status, code, message, usage = emptyAiUsage(), estimatedCostUSD = 0, model = "") {
  return {
    status,
    body: {
      error: {
        code,
        message
      },
      usage: normalizeUsageForResponse(usage),
      estimatedCostUSD,
      model
    }
  };
}

function readCostEnv(value, fallback) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) && numericValue >= 0 ? numericValue : fallback;
}
