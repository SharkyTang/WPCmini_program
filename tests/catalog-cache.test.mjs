import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const __dirname = dirname(fileURLToPath(import.meta.url));
let storedValue = null;
let removedKey = "";
let deferAsyncStorage = false;
const pendingStorageWrites = [];

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
    setStorage(options) {
      if (deferAsyncStorage) {
        pendingStorageWrites.push(options);
        return;
      }
      storedValue = { key: options.key, ...options.data };
      options.success();
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
  CATALOG_CACHE_KEY,
  HOME_CACHE_KEY,
  clearCache,
  normalizeCacheEntry,
  readCache,
  touchCache,
  touchCacheAsync,
  writeCache,
  writeCacheAsync,
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

async function asyncTest(name, fn) {
  try {
    await fn();
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
  assert.equal(normalizeCacheEntry({
    schemaVersion: CACHE_SCHEMA_VERSION,
    revision: 1,
    cachedAt: Date.now(),
    data: { items: [null] },
  }), null);
  assert.equal(normalizeCacheEntry({
    schemaVersion: CACHE_SCHEMA_VERSION,
    revision: 1,
    cachedAt: Date.now(),
    data: { banners: [], popularCases: "bad", latestCases: [] },
  }), null);
  assert.equal(normalizeCacheEntry({
    schemaVersion: CACHE_SCHEMA_VERSION,
    revision: -1,
    cachedAt: Date.now(),
    data: { items: [] },
  }), null);
});

test("revision zero remains displayable but is not promoted to one", () => {
  const entry = normalizeCacheEntry({
    schemaVersion: CACHE_SCHEMA_VERSION,
    revision: 0,
    cachedAt: Date.now(),
    data: { items: [] },
  });
  assert.equal(entry.revision, 0);

  storedValue = null;
  writeCache(CATALOG_CACHE_KEY, 0, { items: [] });
  assert.equal(storedValue.revision, 0);
  assert.equal(touchCache(CATALOG_CACHE_KEY, 0), true);
  assert.equal(storedValue.revision, 0);
});

test("cache writes schema, revision and timestamp and can be cleared", () => {
  storedValue = null;
  writeCache(HOME_CACHE_KEY, 8, {
    banners: [],
    popularCases: [],
    latestCases: [],
  });
  assert.equal(storedValue.key, HOME_CACHE_KEY);
  assert.equal(storedValue.schemaVersion, CACHE_SCHEMA_VERSION);
  assert.equal(storedValue.revision, 8);
  assert.equal(readCache(HOME_CACHE_KEY).data.banners.length, 0);
  assert.equal(touchCache(HOME_CACHE_KEY, 9), true);
  assert.equal(storedValue.revision, 9);
  clearCache(HOME_CACHE_KEY);
  assert.equal(removedKey, HOME_CACHE_KEY);
});

test("readCache removes a malformed deep payload so it cannot fail repeatedly", () => {
  removedKey = "";
  const invalidReasons = [];
  storedValue = {
    schemaVersion: CACHE_SCHEMA_VERSION,
    revision: 1,
    cachedAt: Date.now(),
    data: { items: {} },
  };

  assert.equal(readCache(CATALOG_CACHE_KEY, {
    onInvalid(reason) {
      invalidReasons.push(reason);
    },
  }), null);
  assert.equal(removedKey, CATALOG_CACHE_KEY);
  assert.deepEqual(invalidReasons, ["invalid_data_shape"]);
});

test("writeCache refuses and clears data that violates the key contract", () => {
  removedKey = "";
  storedValue = null;

  assert.equal(writeCache(CATALOG_CACHE_KEY, 1, { items: [null] }), false);
  assert.equal(storedValue, null);
  assert.equal(removedKey, CATALOG_CACHE_KEY);
});

await asyncTest("async cache persistence keeps the same envelope and revision", async () => {
  storedValue = null;
  assert.equal(await writeCacheAsync(CATALOG_CACHE_KEY, 0, { items: [] }), true);
  assert.equal(storedValue.key, CATALOG_CACHE_KEY);
  assert.equal(storedValue.schemaVersion, CACHE_SCHEMA_VERSION);
  assert.equal(storedValue.revision, 0);
  assert.equal(await touchCacheAsync(CATALOG_CACHE_KEY, 7), true);
  assert.equal(storedValue.revision, 7);
});

await asyncTest("async writes for one cache key are serialized in request order", async () => {
  storedValue = null;
  deferAsyncStorage = true;
  const first = writeCacheAsync(CATALOG_CACHE_KEY, 1, { items: [{ id: "old" }] });
  const second = writeCacheAsync(CATALOG_CACHE_KEY, 2, { items: [{ id: "new" }] });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(pendingStorageWrites.length, 1);

  const firstWrite = pendingStorageWrites.shift();
  storedValue = { key: firstWrite.key, ...firstWrite.data };
  firstWrite.success();
  await first;
  await Promise.resolve();
  assert.equal(pendingStorageWrites.length, 1);

  const secondWrite = pendingStorageWrites.shift();
  storedValue = { key: secondWrite.key, ...secondWrite.data };
  secondWrite.success();
  await second;
  deferAsyncStorage = false;
  assert.equal(storedValue.revision, 2);
  assert.equal(storedValue.data.items[0].id, "new");
});
