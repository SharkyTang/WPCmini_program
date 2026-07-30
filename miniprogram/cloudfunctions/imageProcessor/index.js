const cloud = require("wx-server-sdk");
const {
  MAX_FILES,
  buildVariantPaths,
  generateVariantBuffers,
  isAdminOpenid,
  normalizeSourceFiles,
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

async function processFile(fileID, imageFactory) {
  const paths = buildVariantPaths(fileID);
  const response = await cloud.downloadFile({ fileID });
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
        await cloud.deleteFile({ fileList });
      } catch (cleanupError) {
        console.error("imageProcessor cleanup error", cleanupError);
      }
    }
    throw error;
  }
}

async function generateCaseVariants(event, imageFactory) {
  const requested = Array.isArray(event.files) ? event.files : event.fileIDs;
  const fileIDs = normalizeSourceFiles(requested);
  if (!fileIDs.length) return fail("INVALID_FILES", "缺少有效的云存储图片");
  if ((requested || []).length > fileIDs.length) {
    return fail(
      "INVALID_FILES",
      `图片必须是 ${MAX_FILES} 张以内且不能重复的云存储文件`
    );
  }
  const variants = [];
  try {
    for (const fileID of fileIDs) {
      variants.push(await processFile(fileID, imageFactory));
    }
  } catch (error) {
    const fileList = variants.flatMap((variant) => [
      variant.displayFileID,
      variant.thumbnailFileID,
      variant.bannerFileID,
    ]).filter(Boolean);
    if (fileList.length) {
      try {
        await cloud.deleteFile({ fileList });
      } catch (cleanupError) {
        console.error("imageProcessor batch cleanup error", cleanupError);
      }
    }
    throw error;
  }
  return ok({ variants });
}

exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext();
  if (!isAdminOpenid(OPENID, process.env.ADMIN_OPENIDS)) {
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
      return await generateCaseVariants(event, loadImageFactory());
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
