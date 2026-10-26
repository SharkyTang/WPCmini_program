import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(resolve(process.cwd(), "src/components/CaseEditorDrawer.tsx"), "utf8");

describe("CaseEditorDrawer media lifecycle contract", () => {
  it("treats cleanup as a blocking file operation and guards save synchronously", () => {
    expect(source).toMatch(
      /const hasActiveUpload\s*=\s*saving\s*\|\|\s*uploading\s*\|\|\s*mediaUploadKind !== null\s*\|\|\s*mediaCleanupInProgress/,
    );
    expect(source).toContain("mediaCleanupInProgressRef.current = true");
    expect(source).toContain("mediaCleanupInProgressRef.current = false");

    const resultHelperStart = source.indexOf("function safelyHandledCleanupFileIDs");
    const resultHelperEnd = source.indexOf("export function CaseEditorDrawer", resultHelperStart);
    const resultHelperSection = source.slice(resultHelperStart, resultHelperEnd);
    expect(resultHelperSection).toContain("result.deletedFileIds");
    expect(resultHelperSection).toContain("result.skippedFileIds");
    expect(resultHelperSection).toContain("result.failedFileIds");

    const mediaCleanupStart = source.indexOf("const cleanupMediaIDs");
    const mediaCleanupEnd = source.indexOf("const cleanupPendingMedia", mediaCleanupStart);
    const mediaCleanupSection = source.slice(mediaCleanupStart, mediaCleanupEnd);
    expect(mediaCleanupSection).toContain(
      "if (safelyHandledFileIDs.has(fileID)) pendingMediaIdsRef.current.delete(fileID)",
    );
    expect(mediaCleanupSection).toContain(
      "return uniqueIDs.every((fileID) => safelyHandledFileIDs.has(fileID))",
    );

    const variantCleanupStart = source.indexOf("const cleanupVariantEntries");
    const variantCleanupEnd = source.indexOf("const cleanupPendingVariants", variantCleanupStart);
    const variantCleanupSection = source.slice(variantCleanupStart, variantCleanupEnd);
    expect(variantCleanupSection).toContain("remainingFileIDs.length");
    expect(variantCleanupSection).toContain("return false");

    const saveStart = source.indexOf("const save = async");
    const saveGuardEnd = source.indexOf("savingInProgressRef.current = true", saveStart);
    expect(source.slice(saveStart, saveGuardEnd)).toContain("mediaCleanupInProgressRef.current");

    const sourceChangeStart = source.indexOf("const changeVideoSource");
    const removeVideoStart = source.indexOf("const removeUploadedVideo");
    const sourceChangeSection = source.slice(sourceChangeStart, removeVideoStart);
    expect(sourceChangeSection.indexOf("await cleanupMediaIDs(pendingIDs)"))
      .toBeLessThan(sourceChangeSection.indexOf("setVideoSource(nextSource)"));

    const removePosterStart = source.indexOf("const removeUploadedPoster");
    const removeVideoSection = source.slice(removeVideoStart, removePosterStart);
    expect(removeVideoSection.indexOf("await cleanupMediaIDs(pendingIDs)"))
      .toBeLessThan(removeVideoSection.indexOf("setUploadedVideo(null)"));
  });

  it("registers saving synchronously before validation and includes it in the shared busy state", () => {
    expect(source).toMatch(
      /const hasActiveUpload\s*=\s*saving\s*\|\|\s*uploading/,
    );
    const saveStart = source.indexOf("const save = async");
    const saveSection = source.slice(saveStart, source.indexOf("return (", saveStart));
    expect(saveSection.indexOf("savingInProgressRef.current = true"))
      .toBeLessThan(saveSection.indexOf("form.validateFields()"));
    expect(saveSection).toContain("savingInProgressRef.current = false");
    expect(source).toContain("disabled={hasActiveUpload}");
  });

  it("registers each uploaded file for cleanup before creating its local preview", () => {
    const videoStart = source.indexOf("const uploadVideoFile");
    const posterStart = source.indexOf("const uploadPosterFile");
    const sourceChangeStart = source.indexOf("const changeVideoSource");

    const videoSection = source.slice(videoStart, posterStart);
    const posterSection = source.slice(posterStart, sourceChangeStart);
    expect(videoSection.indexOf("pendingMediaIdsRef.current.add(result.fileID)")).toBeGreaterThan(-1);
    expect(videoSection.indexOf("pendingMediaIdsRef.current.add(result.fileID)"))
      .toBeLessThan(videoSection.indexOf("createLocalMediaUrl(file)"));
    expect(posterSection.indexOf("pendingMediaIdsRef.current.add(result.fileID)")).toBeGreaterThan(-1);
    expect(posterSection.indexOf("pendingMediaIdsRef.current.add(result.fileID)"))
      .toBeLessThan(posterSection.indexOf("createLocalMediaUrl(file)"));
  });
});
