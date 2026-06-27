import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, normalize, resolve } from "node:path";
import { loadLocalEnv, requestAiStyleSuggestion } from "./aiStyleServer.mjs";

const ROOT = process.cwd();
const PORT = Number(process.env.PORT || 4173);
const JSON_BODY_LIMIT_BYTES = 12 * 1024 * 1024;

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8"
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (req.method === "POST" && url.pathname === "/api/ai-suggest-style") {
    return handleAiStyleRequest(req, res);
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    return sendText(res, 405, "Method not allowed");
  }

  const pathname = decodeURIComponent(url.pathname);
  const safePath =
    pathname === "/"
      ? "index.html"
      : pathname.endsWith("/")
        ? `${pathname.replace(/^\/+/, "")}index.html`
        : pathname.replace(/^\/+/, "");
  const filePath = normalize(resolve(ROOT, safePath));

  if (!filePath.startsWith(ROOT)) return sendText(res, 403, "Forbidden");

  try {
    const body = await readFile(filePath);
    const type = MIME_TYPES[extname(filePath)] || "application/octet-stream";
    res.writeHead(200, {
      "Content-Type": type,
      "Cache-Control": "no-store, max-age=0"
    });
    if (req.method === "HEAD") return res.end();
    return res.end(body);
  } catch {
    return sendText(res, 404, "Not found");
  }
});

server.listen(PORT, "::", () => {
  console.log(`Wine case classifier running at http://localhost:${PORT}`);
});

function sendText(res, status, text) {
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store, max-age=0"
  });
  res.end(text);
}

async function handleAiStyleRequest(req, res) {
  try {
    loadLocalEnv(resolve(ROOT, ".env.local"));
    const payload = await readJsonBody(req);
    const result = await requestAiStyleSuggestion({ payload, env: process.env, fetchImpl: fetch });
    return sendJson(res, result.status, result.body);
  } catch (error) {
    const status = error.code === "BODY_TOO_LARGE" ? 413 : 400;
    return sendJson(res, status, {
      error: {
        code: error.code || "bad_request",
        message: error.message || "请求格式错误。"
      },
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0
      },
      estimatedCostUSD: 0
    });
  }
}

function readJsonBody(req) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    let totalBytes = 0;

    req.on("data", (chunk) => {
      totalBytes += chunk.length;
      if (totalBytes > JSON_BODY_LIMIT_BYTES) {
        const error = new Error("请求体过大，请降低 AI 预览图尺寸。");
        error.code = "BODY_TOO_LARGE";
        req.destroy(error);
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolveBody(JSON.parse(text || "{}"));
      } catch {
        rejectBody(new Error("请求 JSON 格式错误。"));
      }
    });

    req.on("error", rejectBody);
  });
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store, max-age=0"
  });
  res.end(JSON.stringify(body));
}
