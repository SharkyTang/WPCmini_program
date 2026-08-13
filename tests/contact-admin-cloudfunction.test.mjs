import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const __dirname = dirname(fileURLToPath(import.meta.url));
const functionPath = resolve(
  __dirname,
  "../miniprogram/cloudfunctions/contactAdmin/index.js"
);

const STORE_1 = "cloud://test-env/contact-assets/store/store-1.jpg";
const STORE_2 = "cloud://test-env/contact-assets/store/store-2.jpg";
const STORE_3 = "cloud://test-env/contact-assets/store/store-3.jpg";
const STORE_4 = "cloud://test-env/contact-assets/store/store-4.jpg";
const STORE_5 = "cloud://test-env/contact-assets/store/store-5.jpg";
const STORE_6 = "cloud://test-env/contact-assets/store/store-6.jpg";
const STORE_7 = "cloud://test-env/contact-assets/store/store-7.jpg";
const STORE_8 = "cloud://test-env/contact-assets/store/store-8.jpg";
const STORE_9 = "cloud://test-env/contact-assets/store/store-9.jpg";
const STORE_10 = "cloud://test-env/contact-assets/store/store-10.jpg";
const QR_1 = "cloud://test-env/contact-assets/wechat/qr-1.png";
const QR_2 = "cloud://test-env/contact-assets/wechat/qr-2.png";
const QR_3 = "cloud://test-env/contact-assets/wechat/qr-3.png";

function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function createDocumentNotFoundError() {
  const error = new Error("document not found");
  error.errCode = -502005;
  return error;
}

function loadContactAdminFunction(options = {}) {
  const state = {
    document: options.document === undefined ? null : clone(options.document),
  };
  const calls = {
    deletes: [],
    tempFileRequests: [],
    writes: [],
    transactions: 0,
  };

  function createDatabaseApi() {
    return {
      collection(collectionName) {
        assert.equal(collectionName, "contact_settings");
        return {
          doc(documentId) {
            assert.equal(documentId, "current");
            return {
              async get() {
                if (!state.document) throw createDocumentNotFoundError();
                return {
                  data: clone(state.document),
                };
              },
              async set(payload) {
                const nextDocument = clone(payload.data || {});
                state.document = {
                  _id: "current",
                  ...nextDocument,
                };
                calls.writes.push(clone(nextDocument));
                return {};
              },
            };
          },
        };
      },
    };
  }

  const databaseApi = {
    ...createDatabaseApi(),
    serverDate() {
      return "server-date";
    },
    async runTransaction(callback) {
      calls.transactions += 1;
      return callback(createDatabaseApi());
    },
  };

  const mockCloud = {
    DYNAMIC_CURRENT_ENV: "dynamic-env",
    init() {},
    database() {
      return databaseApi;
    },
    getWXContext() {
      return {
        OPENID: options.openid || "admin_openid",
      };
    },
    async getTempFileURL({ fileList }) {
      calls.tempFileRequests.push(...fileList);
      if (options.tempFileError) throw options.tempFileError;
      return {
        fileList: fileList.map((fileID) => ({
          fileID,
          tempFileURL: options.unresolvedFileIds?.includes(fileID)
            ? ""
            : `https://temp.example/${encodeURIComponent(fileID)}`,
        })),
      };
    },
    async deleteFile({ fileList }) {
      if (options.deleteFailures?.includes(fileList[0])) {
        throw new Error("delete failed");
      }
      calls.deletes.push(...fileList);
      return {
        fileList,
      };
    },
  };

  const sandbox = {
    module: {
      exports: {},
    },
    exports: {},
    console: {
      error() {},
      warn() {},
    },
    process: {
      env: {
        ADMIN_OPENIDS: options.adminOpenids === undefined
          ? "admin_openid"
          : options.adminOpenids,
        CONTACT_ADMIN_OPENIDS: options.contactAdminOpenids === undefined
          ? ""
          : options.contactAdminOpenids,
      },
    },
    require(moduleName) {
      if (moduleName === "wx-server-sdk") return mockCloud;
      throw new Error(`Unexpected require: ${moduleName}`);
    },
  };
  sandbox.exports = sandbox.module.exports;
  vm.runInNewContext(readFileSync(functionPath, "utf8"), sandbox, {
    filename: functionPath,
  });

  return {
    main: sandbox.module.exports.main,
    state,
    calls,
  };
}

function validConfig(overrides = {}) {
  return {
    storeImageFileIds: [STORE_1, STORE_2],
    wechatQrFileIds: [QR_1],
    phoneNumbers: [
      {
        displayNumber: "0851-2233 4455",
      },
      {
        displayNumber: "+86 (188) 8527-4143",
      },
    ],
    ...overrides,
  };
}

async function test(name, fn) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

await test("getPublicContact is public and never exposes cloud file IDs", async () => {
  const { main, calls } = loadContactAdminFunction({
    openid: "visitor_openid",
    document: {
      _id: "current",
      storeImageFileIds: [STORE_1, STORE_2],
      wechatQrFileIds: [QR_1, QR_2],
      phoneNumbers: [{
        displayNumber: "0851-22334455",
        dialNumber: "085122334455",
      }],
      revision: 7,
      updatedByOpenid: "secret_admin_openid",
    },
  });

  const result = await main({
    action: "getPublicContact",
  });

  assert.equal(result.ok, true);
  assert.equal(result.isAdmin, false);
  assert.equal(result.config.revision, 7);
  assert.deepEqual(
    clone(result.config.storeImages),
    [
      `https://temp.example/${encodeURIComponent(STORE_1)}`,
      `https://temp.example/${encodeURIComponent(STORE_2)}`,
    ]
  );
  assert.deepEqual(
    clone(result.config.storeImageUrls),
    clone(result.config.storeImages)
  );
  assert.deepEqual(clone(result.config.wechatQrImages), [
    `https://temp.example/${encodeURIComponent(QR_1)}`,
    `https://temp.example/${encodeURIComponent(QR_2)}`,
  ]);
  assert.deepEqual(
    clone(result.config.wechatQrImageUrls),
    clone(result.config.wechatQrImages)
  );
  assert.equal(
    result.config.wechatQrImage,
    `https://temp.example/${encodeURIComponent(QR_1)}`
  );
  assert.equal(
    result.config.wechatQrImageUrl,
    result.config.wechatQrImage
  );
  assert.deepEqual(clone(result.config.phoneNumbers), [{
    displayNumber: "0851-22334455",
    dialNumber: "085122334455",
  }]);
  assert.equal(JSON.stringify(result).includes("secret_admin_openid"), false);
  assert.equal(JSON.stringify(result).includes("cloud://"), false);
  assert.deepEqual(calls.tempFileRequests, [STORE_1, STORE_2, QR_1, QR_2]);
});

await test("getPublicContact returns an empty version-zero config before initialization", async () => {
  const { main } = loadContactAdminFunction({
    openid: "visitor_openid",
  });

  const result = await main({
    action: "getPublicContact",
  });

  assert.equal(result.ok, true);
  assert.deepEqual(clone(result.config.storeImages), []);
  assert.deepEqual(clone(result.config.wechatQrImages), []);
  assert.deepEqual(clone(result.config.wechatQrImageUrls), []);
  assert.equal(result.config.wechatQrImage, "");
  assert.deepEqual(clone(result.config.phoneNumbers), []);
  assert.equal(result.config.revision, 0);
});

await test("legacy singular QR fields remain readable during migration", async () => {
  const legacyFileId = loadContactAdminFunction({
    openid: "visitor_openid",
    document: {
      wechatQrFileId: QR_1,
      revision: 1,
    },
  });
  const legacyObject = loadContactAdminFunction({
    openid: "visitor_openid",
    document: {
      wechatQr: {
        fileID: QR_2,
      },
      revision: 2,
    },
  });

  const fileIdResult = await legacyFileId.main({
    action: "getPublicContact",
  });
  const objectResult = await legacyObject.main({
    action: "getPublicContact",
  });

  assert.deepEqual(clone(fileIdResult.config.wechatQrImages), [
    `https://temp.example/${encodeURIComponent(QR_1)}`,
  ]);
  assert.equal(
    fileIdResult.config.wechatQrImage,
    fileIdResult.config.wechatQrImages[0]
  );
  assert.deepEqual(clone(objectResult.config.wechatQrImages), [
    `https://temp.example/${encodeURIComponent(QR_2)}`,
  ]);
  assert.equal(
    objectResult.config.wechatQrImageUrl,
    objectResult.config.wechatQrImages[0]
  );
});

await test("contact-specific admins override the general admin fallback", async () => {
  const contactAdmin = loadContactAdminFunction({
    openid: "contact_admin",
    contactAdminOpenids: " contact_admin,other_contact_admin ",
    adminOpenids: "general_admin",
  });
  const generalAdmin = loadContactAdminFunction({
    openid: "general_admin",
    contactAdminOpenids: "contact_admin",
    adminOpenids: "general_admin",
  });
  const fallbackAdmin = loadContactAdminFunction({
    openid: "general_admin",
    contactAdminOpenids: "   ",
    adminOpenids: " general_admin ",
  });

  assert.deepEqual(
    clone(await contactAdmin.main({ action: "checkAccess" })),
    { ok: true, isAdmin: true }
  );
  assert.deepEqual(
    clone(await generalAdmin.main({ action: "checkAccess" })),
    { ok: true, isAdmin: false }
  );
  assert.deepEqual(
    clone(await fallbackAdmin.main({ action: "checkAccess" })),
    { ok: true, isAdmin: true }
  );
});

await test("all draft and mutation actions reject non-admin OPENIDs", async () => {
  const { main, calls } = loadContactAdminFunction({
    openid: "visitor_openid",
  });

  for (const action of [
    "getContactDraft",
    "saveContact",
    "cleanupUnreferencedFiles",
  ]) {
    const result = await main({
      action,
      isAdmin: true,
      config: validConfig(),
      expectedRevision: 0,
      fileIDs: [STORE_1],
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, "FORBIDDEN");
  }
  assert.equal(calls.transactions, 0);
  assert.deepEqual(calls.deletes, []);
});

await test("getContactDraft returns file IDs only to admins with preview URLs", async () => {
  const { main } = loadContactAdminFunction({
    document: {
      storeImageFileIds: [STORE_1, STORE_2],
      wechatQrFileIds: [QR_1, QR_2],
      phoneNumbers: [{
        displayNumber: "400-123-4567",
        dialNumber: "4001234567",
      }],
      revision: 3,
    },
  });

  const result = await main({
    action: "getContactDraft",
  });

  assert.equal(result.ok, true);
  assert.equal(result.item.revision, 3);
  assert.deepEqual(clone(result.item.storeImages), [
    {
      fileID: STORE_1,
      url: `https://temp.example/${encodeURIComponent(STORE_1)}`,
    },
    {
      fileID: STORE_2,
      url: `https://temp.example/${encodeURIComponent(STORE_2)}`,
    },
  ]);
  assert.deepEqual(clone(result.storeImageFileIds), [STORE_1, STORE_2]);
  assert.deepEqual(clone(result.item.wechatQrs), [
    {
      fileID: QR_1,
      url: `https://temp.example/${encodeURIComponent(QR_1)}`,
    },
    {
      fileID: QR_2,
      url: `https://temp.example/${encodeURIComponent(QR_2)}`,
    },
  ]);
  assert.deepEqual(clone(result.wechatQrFileIds), [QR_1, QR_2]);
  assert.deepEqual(clone(result.wechatQrImageUrls), [
    `https://temp.example/${encodeURIComponent(QR_1)}`,
    `https://temp.example/${encodeURIComponent(QR_2)}`,
  ]);
  assert.deepEqual(clone(result.item.wechatQr), {
    fileID: QR_1,
    url: `https://temp.example/${encodeURIComponent(QR_1)}`,
  });
  assert.deepEqual(clone(result.phoneNumbers), [{
    displayNumber: "400-123-4567",
    dialNumber: "4001234567",
  }]);
});

await test("saveContact accepts contact and revision aliases and normalizes phones", async () => {
  const { main, state, calls } = loadContactAdminFunction();

  const result = await main({
    action: "saveContact",
    revision: 0,
    contact: validConfig({
      storeImages: [
        {
          fileID: STORE_1,
        },
      ],
      storeImageFileIds: undefined,
      wechatQrFileIds: undefined,
      wechatQr: {
        fileID: QR_1,
      },
      phoneNumbers: [
        {
          displayNumber: "0577（8888）6666",
          dialNumber: "client-value-is-not-trusted",
        },
        "+86 188-8527-4143",
      ],
    }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.revision, 1);
  assert.equal(calls.transactions, 1);
  assert.deepEqual(clone(state.document.storeImageFileIds), [STORE_1]);
  assert.deepEqual(clone(state.document.wechatQrFileIds), [QR_1]);
  assert.equal(state.document.wechatQrFileId, QR_1);
  assert.deepEqual(clone(state.document.phoneNumbers), [
    {
      displayNumber: "0577（8888）6666",
      dialNumber: "057788886666",
    },
    {
      displayNumber: "+86 188-8527-4143",
      dialNumber: "+8618885274143",
    },
  ]);
  assert.equal(state.document.updatedByOpenid, "admin_openid");
});

await test("saveContact accepts the legacy singular QR file ID alias", async () => {
  const { main, state } = loadContactAdminFunction();

  const result = await main({
    action: "saveContact",
    config: validConfig({
      wechatQrFileIds: undefined,
      wechatQrFileId: QR_2,
    }),
    expectedRevision: 0,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(clone(state.document.wechatQrFileIds), [QR_2]);
  assert.deepEqual(clone(result.config.wechatQrFileIds), [QR_2]);
  assert.equal(result.config.wechatQrFileId, QR_2);
});

await test("saveContact supports zero phones and at most nine store images", async () => {
  const { main, state } = loadContactAdminFunction();

  const result = await main({
    action: "saveContact",
    config: validConfig({
      storeImageFileIds: [
        STORE_1,
        STORE_2,
        STORE_3,
        STORE_4,
        STORE_5,
        STORE_6,
        STORE_7,
        STORE_8,
        STORE_9,
      ],
      wechatQrFileIds: [],
      phoneNumbers: [],
    }),
    expectedRevision: 0,
    clientStoreImageLimit: 9,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(clone(state.document.storeImageFileIds), [
    STORE_1,
    STORE_2,
    STORE_3,
    STORE_4,
    STORE_5,
    STORE_6,
    STORE_7,
    STORE_8,
    STORE_9,
  ]);
  assert.deepEqual(clone(state.document.wechatQrFileIds), []);
  assert.equal(state.document.wechatQrFileId, "");
  assert.deepEqual(clone(state.document.phoneNumbers), []);
});

await test("saving more than four images requires the new client capability", async () => {
  const { main, calls } = loadContactAdminFunction();

  const result = await main({
    action: "saveContact",
    config: validConfig({
      storeImageFileIds: [STORE_1, STORE_2, STORE_3, STORE_4, STORE_5],
    }),
    expectedRevision: 0,
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "CLIENT_UPDATE_REQUIRED");
  assert.equal(calls.transactions, 0);
  assert.equal(calls.writes.length, 0);
  assert.deepEqual(calls.deletes, []);
});

await test("legacy admin clients cannot truncate an existing nine-image gallery", async () => {
  const originalStoreImages = [
    STORE_1,
    STORE_2,
    STORE_3,
    STORE_4,
    STORE_5,
    STORE_6,
    STORE_7,
    STORE_8,
    STORE_9,
  ];
  const { main, state, calls } = loadContactAdminFunction({
    document: {
      storeImageFileIds: originalStoreImages,
      wechatQrFileIds: [QR_1],
      phoneNumbers: [],
      revision: 3,
    },
  });

  const legacyResult = await main({
    action: "saveContact",
    config: validConfig({
      storeImageFileIds: originalStoreImages.slice(0, 4),
      phoneNumbers: [],
    }),
    expectedRevision: 3,
  });

  assert.equal(legacyResult.ok, false);
  assert.equal(legacyResult.code, "CLIENT_UPDATE_REQUIRED");
  assert.equal(calls.writes.length, 0);
  assert.deepEqual(calls.deletes, []);
  assert.deepEqual(clone(state.document.storeImageFileIds), originalStoreImages);

  const currentClientResult = await main({
    action: "saveContact",
    config: validConfig({
      storeImageFileIds: originalStoreImages.slice(0, 4),
      phoneNumbers: [],
    }),
    expectedRevision: 3,
    clientStoreImageLimit: 9,
  });

  assert.equal(currentClientResult.ok, true);
  assert.deepEqual(
    clone(state.document.storeImageFileIds),
    originalStoreImages.slice(0, 4)
  );
  assert.deepEqual(
    calls.deletes.sort(),
    originalStoreImages.slice(4).sort()
  );
});

await test("saveContact rejects invalid asset locations without starting a transaction", async () => {
  const invalidCases = [
    validConfig({
      storeImageFileIds: [
        "cloud://test-env/case-images/not-contact.jpg",
      ],
    }),
    validConfig({
      storeImageFileIds: [
        STORE_1,
        STORE_2,
        STORE_3,
        STORE_4,
        STORE_5,
        STORE_6,
        STORE_7,
        STORE_8,
        STORE_9,
        STORE_10,
      ],
    }),
    validConfig({
      storeImageFileIds: [
        "cloud://test-env/contact-assets/store/../private.jpg",
      ],
    }),
  ];

  for (const config of invalidCases) {
    const { main, calls } = loadContactAdminFunction();
    const result = await main({
      action: "saveContact",
      config,
      expectedRevision: 0,
    });
    assert.equal(result.ok, false);
    assert.equal(calls.transactions, 0);
  }
});

await test("saveContact strictly rejects invalid QR arrays", async () => {
  const invalidCases = [
    {
      wechatQrFileIds: [QR_1, QR_2, QR_3],
      code: "INVALID_WECHAT_QRS",
    },
    {
      wechatQrFileIds: [QR_1, QR_1],
      code: "DUPLICATE_WECHAT_QR",
    },
    {
      wechatQrFileIds: [
        "cloud://test-env/contact-assets/store/not-a-qr.png",
      ],
      code: "INVALID_WECHAT_QR",
    },
    {
      wechatQrFileIds: [
        "cloud://test-env/contact-assets/wechat/../private.png",
      ],
      code: "INVALID_WECHAT_QR",
    },
    {
      wechatQrFileIds: QR_1,
      code: "INVALID_WECHAT_QRS",
    },
  ];

  for (const { wechatQrFileIds, code } of invalidCases) {
    const { main, calls } = loadContactAdminFunction();
    const result = await main({
      action: "saveContact",
      config: validConfig({
        wechatQrFileIds,
      }),
      expectedRevision: 0,
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, code);
    assert.equal(calls.transactions, 0);
  }
});

await test("saveContact enforces phone characters, leading plus, length, count, and uniqueness", async () => {
  const invalidPhoneLists = [
    ["18885274143", "188-8527-4143"],
    ["18885274143", "085122334455", "4001234567"],
    ["1888A5274143"],
    ["188+85274143"],
    ["1888\n5274143"],
    ["1234"],
    ["1".repeat(21)],
    ["1".repeat(33)],
  ];

  for (const phoneNumbers of invalidPhoneLists) {
    const { main, calls } = loadContactAdminFunction();
    const result = await main({
      action: "saveContact",
      config: validConfig({
        phoneNumbers,
      }),
      expectedRevision: 0,
    });
    assert.equal(result.ok, false);
    assert.equal(calls.transactions, 0);
  }
});

await test("revision transactions prevent stale administrators from overwriting data", async () => {
  const { main, state, calls } = loadContactAdminFunction({
    document: {
      storeImageFileIds: [STORE_1],
      wechatQrFileId: QR_1,
      phoneNumbers: [],
      revision: 4,
    },
  });

  const staleResult = await main({
    action: "saveContact",
    config: validConfig({
      storeImageFileIds: [STORE_2],
    }),
    expectedRevision: 3,
  });

  assert.equal(staleResult.ok, false);
  assert.equal(staleResult.code, "REVISION_CONFLICT");
  assert.equal(staleResult.currentRevision, 4);
  assert.deepEqual(clone(state.document.storeImageFileIds), [STORE_1]);
  assert.equal(calls.writes.length, 0);

  const firstResult = await main({
    action: "saveContact",
    config: validConfig({
      storeImageFileIds: [STORE_2],
    }),
    expectedRevision: 4,
  });
  const secondResult = await main({
    action: "saveContact",
    config: validConfig({
      storeImageFileIds: [STORE_3],
    }),
    expectedRevision: 4,
  });

  assert.equal(firstResult.ok, true);
  assert.equal(firstResult.revision, 5);
  assert.equal(secondResult.ok, false);
  assert.equal(secondResult.code, "REVISION_CONFLICT");
  assert.equal(secondResult.currentRevision, 5);
  assert.deepEqual(clone(state.document.storeImageFileIds), [STORE_2]);
});

await test("saveContact writes first, then deletes only replaced contact assets", async () => {
  const { main, calls, state } = loadContactAdminFunction({
    document: {
      storeImageFileIds: [STORE_1, STORE_2],
      wechatQrFileIds: [QR_1, QR_2],
      phoneNumbers: [],
      revision: 2,
    },
  });

  const result = await main({
    action: "saveContact",
    config: validConfig({
      storeImageFileIds: [STORE_2, STORE_3],
      wechatQrFileIds: [QR_2, QR_3],
    }),
    expectedRevision: 2,
  });

  assert.equal(result.ok, true);
  assert.equal(state.document.revision, 3);
  assert.deepEqual(calls.deletes.sort(), [QR_1, STORE_1].sort());
  assert.deepEqual(clone(result.deletedFileIds).sort(), [QR_1, STORE_1].sort());
  assert.equal(calls.deletes.includes(STORE_2), false);
  assert.equal(calls.deletes.includes(QR_2), false);
});

await test("cleanupUnreferencedFiles ignores other directories and preserves current references", async () => {
  const unusedStore = STORE_3;
  const unusedQr = QR_3;
  const unrelated = "cloud://test-env/case-images/case-1.jpg";
  const traversal = "cloud://test-env/contact-assets/store/../case-2.jpg";
  const { main, calls } = loadContactAdminFunction({
    document: {
      storeImageFileIds: [STORE_1],
      wechatQrFileIds: [QR_1, QR_2],
      phoneNumbers: [],
      revision: 1,
    },
  });

  const result = await main({
    action: "cleanupUnreferencedFiles",
    fileIDs: [
      STORE_1,
      QR_1,
      QR_2,
      unusedStore,
      unusedQr,
      unrelated,
      traversal,
      unusedStore,
    ],
  });

  assert.equal(result.ok, true);
  assert.deepEqual(calls.deletes.sort(), [unusedQr, unusedStore].sort());
  assert.deepEqual(clone(result.deletedFileIds).sort(), [unusedQr, unusedStore].sort());
});

await test("cleanup continues safely when an individual cloud deletion fails", async () => {
  const { main, calls } = loadContactAdminFunction({
    deleteFailures: [STORE_2],
  });

  const result = await main({
    action: "cleanupUnreferencedFiles",
    fileIDs: [STORE_2, STORE_3],
  });

  assert.equal(result.ok, true);
  assert.deepEqual(calls.deletes, [STORE_3]);
  assert.deepEqual(clone(result.deletedFileIds), [STORE_3]);
});

await test("temporary URL failures return a controlled service error", async () => {
  const { main } = loadContactAdminFunction({
    openid: "visitor_openid",
    document: {
      storeImageFileIds: [STORE_1],
      revision: 1,
    },
    tempFileError: new Error("temporary URL service unavailable"),
  });

  const result = await main({
    action: "getPublicContact",
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "SERVER_ERROR");
});
