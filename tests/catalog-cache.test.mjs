import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const __dirname = dirname(fileURLToPath(import.meta.url));
let storedValue = null;
let removedKey = "";

const modulePath = resolve(
  __dirname,
  "../miniprogram/miniprogram/utils/catalogCache.js"
);
const sandbox = {
  module: { exports: {} },
  exports: {},
  console,
  wx: {
    getStorageSync() {
      return storedValue;
    },
    setStorageSync(key, value) {
      storedValue = { key, ...value };
    },
    removeStorageSync(key) {
      removedKey = key;
    },
  },
};
sandbox.exports = sandbox.module.exports;
vm.runInNewContext(readFileSync(modulePath, "utf8"), sandbox, {
  filename: modulePath,
});

const {
  CACHE_SCHEMA_VERSION,
  CACHE_TTL_MS,
  HOME_CACHE_KEY,
  clearCache,
  normalizeCacheEntry,
  readCache,
  writeCache,
} = sandbox.module.exports;

function test(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

test("cache is fresh inside twenty minutes and stale afterwards", () => {
  const fresh = normalizeCacheEntry({
    schemaVersion: CACHE_SCHEMA_VERSION,
    revision: 3,
    cachedAt: Date.now() - CACHE_TTL_MS + 1000,
    data: { items: [] },
  });
  const stale = normalizeCacheEntry({
    schemaVersion: CACHE_SCHEMA_VERSION,
    revision: 3,
    cachedAt: Date.now() - CACHE_TTL_MS - 1000,
    data: { items: [] },
  });
  assert.equal(fresh.fresh, true);
  assert.equal(stale.fresh, false);
});

test("cache rejects old schemas and malformed payloads", () => {
  assert.equal(normalizeCacheEntry(null), null);
  assert.equal(normalizeCacheEntry({
    schemaVersion: CACHE_SCHEMA_VERSION - 1,
    revision: 1,
    cachedAt: Date.now(),
    data: {},
  }), null);
  assert.equal(normalizeCacheEntry({
    schemaVersion: CACHE_SCHEMA_VERSION,
    revision: "bad",
    cachedAt: Date.now(),
    data: {},
  }), null);
});

test("cache writes schema, revision and timestamp and can be cleared", () => {
  storedValue = null;
  writeCache(HOME_CACHE_KEY, 8, { banners: [] });
  assert.equal(storedValue.key, HOME_CACHE_KEY);
  assert.equal(storedValue.schemaVersion, CACHE_SCHEMA_VERSION);
  assert.equal(storedValue.revision, 8);
  assert.equal(readCache(HOME_CACHE_KEY).data.banners.length, 0);
  clearCache(HOME_CACHE_KEY);
  assert.equal(removedKey, HOME_CACHE_KEY);
});
