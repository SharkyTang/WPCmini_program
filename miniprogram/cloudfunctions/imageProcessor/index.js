const cloud = require("wx-server-sdk");
const {
  MAX_FILES,
  buildVariantPaths,
  detectSupportedImageType,
  generateVariantBuffers,
  isAdminActor,
  isWebAdminUploadFile,
  isWebWriteEnabled,
  normalizeSourceFiles,
  resolveAdminActor,
  trimText,
} = require("./imageProcessorLogic");
const { createJimpSharpCompat } = require("./jimpSharpCompat");

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV,
});

function ok(data = {}) {
  return { ok: true, ...data };
}

function fail(code, message) {
  return { ok: false, code, message };
}

async function loadOfficialCloudbaseUserInfo() {
  let sdk;
  try {
    sdk = require("@cloudbase/node-sdk");
  } catch (error) {
    return { available: false, userInfo: null, error: null };
  }
  try {
    const app = sdk.init({
      env: sdk.SYMBOL_CURRENT_ENV || process.env.TCB_ENV || process.env.SCF_NAMESPACE,
    });
    return { available: true, userInfo: app.auth().getUserInfo(), error: null };
  } catch (error) {
    return { available: true, userInfo: null, error };
  }
}

async function resolveRequestIdentity() {
  let wxContext = {};
  try {
    wxContext = cloud.getWXContext() || {};
  } catch (error) {
    return { identity: null, error };
  }
  const official = await loadOfficialCloudbaseUserInfo();
  if (official.error && !trimText(wxContext.OPENID)) {
    return { identity: null, error: official.error };
  }
  const userInfo = official.userInfo || {};
  if (userInfo.isAnonymous === true && !trimText(wxContext.OPENID || userInfo.openId)) {
    return {
      identity: { authenticated: false, actor: null },
      error: null,
    };
  }
  return {
    identity: resolveAdminActor({
      ...wxContext,
      OPENID: trimText(wxContext.OPENID || userInfo.openId),
      UID: userInfo.isAnonymous === true ? "" : trimText(userInfo.uid),
    }, process.env),
    error: null,
  };
}

function loadImageFactory() {
  try {
    const Jimp = require("jimp");
    const { version } = require("jimp/package.json");
    return createJimpSharpCompat(Jimp, version);
  } catch (error) {
    error.code = "IMAGE_PROCESSOR_UNAVAILABLE";
    throw error;
  }
}

async function uploadVariant(cloudPath, fileContent) {
  const response = await cloud.uploadFile({
    cloudPath,
    fileContent,
  });
  return response.fileID || response.fileId || "";
}

async function isGeneratedFileReferenced(fileID) {
  if (!fileID || typeof cloud.database !== "function") return false;
  try {
    const database = cloud.database();
    const command = database.command;
    const scalarFields = ["coverImage", "coverThumbnail", "coverBanner"];
    const arrayFields = [
      "galleryImages",
      "sourceGalleryImages",
      "galleryThumbnails",
      "galleryBanners",
    ];
    const requests = [
      ...scalarFields.map((field) =>
        database.collection("wine_packaging")
          .where({ [field]: fileID })
          .field({ _id: true })
          .limit(1)
          .get()
      ),
      ...arrayFields.map((field) =>
        database.collection("wine_packaging")
          .where({
            [field]: command && typeof command.in === "function"
              ? command.in([fileID])
              : fileID,
          })
          .field({ _id: true })
          .limit(1)
          .get()
      ),
    ];
    const responses = await Promise.all(requests);
    return responses.some((response) => (response.data || []).length > 0);
  } catch (error) {
    // Failing closed avoids deleting a deterministic variant that may already
    // be referenced after a lost createCase response.
    console.error("imageProcessor reference check error", error);
    return true;
  }
}

async function deleteUnreferencedGeneratedFiles(fileList = []) {
  const deletable = [];
  for (const fileID of Array.from(new Set(fileList.filter(Boolean)))) {
    if (!(await isGeneratedFileReferenced(fileID))) deletable.push(fileID);
  }
  if (deletable.length) {
    await cloud.deleteFile({ fileList: deletable });
  }
  return deletable;
}

async function processFile(fileID, imageFactory, actor) {
  const paths = buildVariantPaths(fileID);
  const response = await cloud.downloadFile({ fileID });
  if (
    actor &&
    actor.type === "cloudbase_uid" &&
    !detectSupportedImageType(response.fileContent)
  ) {
    const error = new Error("仅支持 JPEG、PNG 或 WebP 图片");
    error.code = "UNSUPPORTED_IMAGE_TYPE";
    throw error;
  }
  const buffers = await generateVariantBuffers(imageFactory, response.fileContent);
  const uploadedFileIDs = [];
  try {
    const uploadResults = await Promise.allSettled([
      uploadVariant(paths.displayPath, buffers.displayBuffer),
      uploadVariant(paths.thumbnailPath, buffers.thumbnailBuffer),
      uploadVariant(paths.bannerPath, buffers.bannerBuffer),
    ]);
    uploadResults.forEach((result) => {
      if (result.status === "fulfilled" && result.value) {
        uploadedFileIDs.push(result.value);
      }
    });
    const failedUpload = uploadResults.find((result) => result.status === "rejected");
    if (failedUpload) throw failedUpload.reason;
    const [displayFileID, thumbnailFileID, bannerFileID] = uploadResults.map(
      (result) => result.value
    );
    if (!displayFileID || !thumbnailFileID || !bannerFileID) {
      throw new Error("图片变体上传失败");
    }
    return {
      sourceFileID: fileID,
      displayFileID,
      thumbnailFileID,
      bannerFileID,
      ...buffers.metadata,
    };
  } catch (error) {
    const fileList = uploadedFileIDs.filter(Boolean);
    if (fileList.length) {
      try {
        await deleteUnreferencedGeneratedFiles(fileList);
      } catch (cleanupError) {
        console.error("imageProcessor cleanup error", cleanupError);
      }
    }
    throw error;
  }
}

async function generateCaseVariants(event, imageFactory, actor) {
  const requested = Array.isArray(event.files) ? event.files : event.fileIDs;
  const fileIDs = normalizeSourceFiles(requested);
  if (!fileIDs.length) return fail("INVALID_FILES", "缺少有效的云存储图片");
  if ((requested || []).length > fileIDs.length) {
    return fail(
      "INVALID_FILES",
      `图片必须是 ${MAX_FILES} 张以内且不能重复的云存储文件`
    );
  }
  if (
    actor &&
    actor.type === "cloudbase_uid" &&
    fileIDs.some((fileID) => !isWebAdminUploadFile(fileID, actor.id))
  ) {
    return fail(
      "INVALID_UPLOAD_PATH",
      "图片必须来自当前管理员的后台上传目录，且格式为 JPEG、PNG 或 WebP"
    );
  }
  const variants = [];
  try {
    for (const fileID of fileIDs) {
      variants.push(await processFile(fileID, imageFactory, actor));
    }
  } catch (error) {
    const fileList = variants.flatMap((variant) => [
      variant.displayFileID,
      variant.thumbnailFileID,
      variant.bannerFileID,
    ]).filter(Boolean);
    if (fileList.length) {
      try {
        await deleteUnreferencedGeneratedFiles(fileList);
      } catch (cleanupError) {
        console.error("imageProcessor batch cleanup error", cleanupError);
      }
    }
    throw error;
  }
  return ok({ variants });
}

exports.main = async (event = {}) => {
  const resolved = await resolveRequestIdentity();
  if (resolved.error) {
    console.error("imageProcessor identity error", resolved.error);
    return fail("SERVER_ERROR", "管理员身份服务异常，请稍后重试");
  }
  const identity = resolved.identity || { authenticated: false, actor: null };
  if (!identity.authenticated) {
    return fail("UNAUTHENTICATED", "登录已过期，请重新登录");
  }
  if (!isAdminActor(identity.actor, process.env)) {
    return fail("FORBIDDEN", "无权限处理案例图片");
  }
  try {
    const action = trimText(event.action);
    if (action === "healthCheck") {
      const imageFactory = loadImageFactory();
      return ok({
        imageLibrary: "jimp",
        imageLibraryVersion: imageFactory.versions && imageFactory.versions.jimp,
      });
    }
    if (action === "generateCaseVariants") {
      if (
        identity.actor.type === "cloudbase_uid" &&
        !isWebWriteEnabled(process.env.ADMIN_WEB_WRITE_ENABLED)
      ) {
        return fail("WEB_WRITE_DISABLED", "电脑后台当前为只读模式");
      }
      return await generateCaseVariants(event, loadImageFactory(), identity.actor);
    }
    return fail("UNKNOWN_ACTION", "未知图片处理操作");
  } catch (error) {
    console.error("imageProcessor error", error);
    return fail(
      error.code || "IMAGE_PROCESSING_FAILED",
      error.message || "图片处理失败"
    );
  }
};
