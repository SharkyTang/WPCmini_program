import assert from "node:assert/strict";
import {
  buildCloudFileManifest,
  parseBackupArgs,
  sha256,
} from "../scripts/backup-cloudbase-data.mjs";

function test(name, callback) {
  try {
    callback();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

test("backup arguments require an explicit environment source", () => {
  assert.deepEqual(parseBackupArgs([], {}), {
    envId: "",
    outputDir: "",
    help: false,
  });
  assert.deepEqual(
    parseBackupArgs(["--env", "staging-env", "--output", "backups/staging"], {
      CLOUDBASE_ENV_ID: "fallback",
    }),
    {
      envId: "staging-env",
      outputDir: "backups/staging",
      help: false,
    }
  );
  assert.equal(parseBackupArgs(["legacy-env"], {}).envId, "legacy-env");
  assert.throws(() => parseBackupArgs(["--bad"], {}), /未知参数/);
});

test("cloud file manifest deduplicates file ids and records every reference", () => {
  const files = buildCloudFileManifest({
    wine_packaging: [
      {
        _id: "case_doc_1",
        coverImage: "cloud://env/display/one.jpg",
        galleryImages: [
          "cloud://env/display/one.jpg",
          "https://example.com/not-cloud.jpg",
        ],
      },
    ],
    home_banners: [
      {
        _id: "banner_1",
        image: "cloud://env/banner/one.jpg",
      },
    ],
  });

  assert.deepEqual(files, [
    {
      fileID: "cloud://env/banner/one.jpg",
      references: [
        {
          collection: "home_banners",
          documentId: "banner_1",
          field: "image",
        },
      ],
    },
    {
      fileID: "cloud://env/display/one.jpg",
      references: [
        {
          collection: "wine_packaging",
          documentId: "case_doc_1",
          field: "coverImage",
        },
        {
          collection: "wine_packaging",
          documentId: "case_doc_1",
          field: "galleryImages[0]",
        },
      ],
    },
  ]);
});

test("sha256 output is stable", () => {
  assert.equal(
    sha256("wine-admin\n"),
    "f20eacf83d34c37836933a42e50101e2a105a2d57f16893aa104ab3319bfd0b8"
  );
});
