import {
  DeleteOutlined,
  HolderOutlined,
  PictureOutlined,
  PlusOutlined,
  RedoOutlined,
  ReloadOutlined,
  SaveOutlined,
  UploadOutlined,
  VideoCameraOutlined,
} from "@ant-design/icons";
import {
  Alert,
  Button,
  Checkbox,
  Divider,
  Drawer,
  Form,
  Input,
  InputNumber,
  message,
  Modal,
  Progress,
  Segmented,
  Select,
  Space,
  Spin,
  Switch,
  Tag,
  Typography,
} from "antd";
import { useEffect, useMemo, useRef, useState } from "react";
import { useBlocker } from "react-router-dom";
import { HOME_SECTION_META } from "../constants";
import { useAdminConfig } from "../context/AdminConfigContext";
import { getSceneOptions } from "../lib/sceneOptions";
import { adminApi } from "../lib/api";
import { canAddGalleryImages, isSupportedImage, moveItem } from "../lib/caseLogic";
import { AdminApiError, getErrorMessage } from "../lib/errors";
import { appendUploadedGallery, type GalleryState } from "../lib/galleryLogic";
import { normalizeStableHttpsUrl } from "../lib/normalizers";
import {
  formatFileSize,
  formatVideoDuration,
  inspectCaseVideoFile,
  validateVideoPosterFile,
} from "../lib/videoUpload";
import type {
  CaseDraft,
  CaseRecord,
  CleanupUnreferencedFilesResult,
  HomeSection,
  UploadedCaseImages,
  VideoPatch,
} from "../types";
import { OrderMoveButtons } from "./OrderMoveButtons";
import { PageError } from "./PageStates";

interface EditorValues {
  title: string;
  caseId: string;
  wineType: string;
  packageTypes: string[];
  styles: string[];
  priceLevel: string;
  scenes: string[];
  statuses: string[];
  homeSections: HomeSection[];
  sortOrder: number;
  videoUrl: string;
  videoPoster: string;
  videoDurationSeconds: number | null;
  notes: string;
  isVisible: boolean;
  isPinned: boolean;
}

type VideoSource = "upload" | "external";

interface UploadedVideoDraft {
  fileID: string;
  previewUrl: string;
  durationSeconds: number;
  fileSizeBytes: number | null;
  width?: number;
  height?: number;
  fileName: string;
}

interface UploadedPosterDraft {
  fileID: string;
  previewUrl: string;
  fileName: string;
}

function galleryFromItem(item: CaseRecord): GalleryState {
  return {
    galleryImages: item.galleryImages,
    sourceGalleryImages: item.sourceGalleryImages,
    galleryThumbnails: item.galleryThumbnails,
    galleryBanners: item.galleryBanners,
    galleryImageUrls: item.galleryImageUrls,
  };
}

function align(values: string[], length: number, fallback: string[] = []): string[] {
  return Array.from({ length }, (_, index) => values[index] || fallback[index] || "");
}

function safelyHandledCleanupFileIDs(
  requestedFileIDs: string[],
  result: CleanupUnreferencedFilesResult,
): Set<string> {
  const failedFileIDs = new Set(result.failedFileIds);
  const reportedSafeFileIDs = new Set([
    ...result.deletedFileIds,
    ...result.skippedFileIds,
  ].filter((fileID) => !failedFileIDs.has(fileID)));
  return new Set(requestedFileIDs.filter((fileID) => reportedSafeFileIDs.has(fileID)));
}

export function CaseEditorDrawer({
  id,
  onClose,
  onSaved,
}: {
  id: string;
  onClose: () => void;
  onSaved: (item: CaseRecord) => void;
}) {
  const [form] = Form.useForm<EditorValues>();
  const { config } = useAdminConfig();
  const [item, setItem] = useState<CaseRecord | null>(null);
  const [gallery, setGallery] = useState<GalleryState | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [videoSource, setVideoSource] = useState<VideoSource>("upload");
  const [uploadedVideo, setUploadedVideo] = useState<UploadedVideoDraft | null>(null);
  const [uploadedPoster, setUploadedPoster] = useState<UploadedPosterDraft | null>(null);
  const [videoChanged, setVideoChanged] = useState(false);
  const [mediaUploadKind, setMediaUploadKind] = useState<"video" | "poster" | null>(null);
  const [mediaCleanupInProgress, setMediaCleanupInProgress] = useState(false);
  const [videoUploadProgress, setVideoUploadProgress] = useState(0);
  const [posterUploadProgress, setPosterUploadProgress] = useState(0);
  const [videoUploadError, setVideoUploadError] = useState("");
  const [posterUploadError, setPosterUploadError] = useState("");
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState("");
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const videoInputRef = useRef<HTMLInputElement>(null);
  const posterInputRef = useRef<HTMLInputElement>(null);
  const retryVideoFileRef = useRef<File | null>(null);
  const retryPosterFileRef = useRef<File | null>(null);
  const pendingVariantIdsRef = useRef(new Map<string, string[]>());
  const pendingMediaIdsRef = useRef(new Set<string>());
  const mediaCleanupCountRef = useRef(0);
  const mediaCleanupInProgressRef = useRef(false);
  const localMediaUrlsRef = useRef(new Set<string>());
  const saveMutationRef = useRef<{ fingerprint: string; id: string } | null>(null);
  const savingInProgressRef = useRef(false);
  const allowNavigationRef = useRef(false);
  const blockerDialogOpenRef = useRef(false);
  const hasActiveUpload = saving || uploading || mediaUploadKind !== null || mediaCleanupInProgress;
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      (
        dirty ||
        hasActiveUpload ||
        savingInProgressRef.current ||
        mediaCleanupInProgressRef.current
      ) &&
      !allowNavigationRef.current &&
      currentLocation.pathname !== nextLocation.pathname,
  );

  const cleanupVariantEntries = async (entries: Array<[string, string[]]>) => {
    const fileIDs = [...new Set(entries.flatMap(([, entryFileIDs]) => entryFileIDs).filter(Boolean))];
    if (!fileIDs.length) return true;
    try {
      const result = await adminApi.cleanupUnreferencedFiles(fileIDs);
      const safelyHandledFileIDs = safelyHandledCleanupFileIDs(fileIDs, result);
      entries.forEach(([displayFileID, attemptedFileIDs]) => {
        const currentFileIDs = pendingVariantIdsRef.current.get(displayFileID);
        if (!currentFileIDs) return;
        const attempted = new Set(attemptedFileIDs);
        const remainingFileIDs = currentFileIDs.filter(
          (fileID) => !attempted.has(fileID) || !safelyHandledFileIDs.has(fileID),
        );
        if (remainingFileIDs.length) {
          pendingVariantIdsRef.current.set(displayFileID, remainingFileIDs);
        } else {
          pendingVariantIdsRef.current.delete(displayFileID);
        }
      });
      return fileIDs.every((fileID) => safelyHandledFileIDs.has(fileID));
    } catch {
      // Keep every pending ID so closing or a later cleanup can retry safely.
      return false;
    }
  };

  const cleanupPendingVariants = async () => cleanupVariantEntries(
    [...pendingVariantIdsRef.current.entries()],
  );

  const cleanupMediaIDs = async (fileIDs: string[]) => {
    const uniqueIDs = [...new Set(fileIDs.filter(Boolean))];
    if (!uniqueIDs.length) return true;
    mediaCleanupCountRef.current += 1;
    mediaCleanupInProgressRef.current = true;
    setMediaCleanupInProgress(true);
    try {
      const result = await adminApi.cleanupUnreferencedFiles(uniqueIDs);
      const safelyHandledFileIDs = safelyHandledCleanupFileIDs(uniqueIDs, result);
      uniqueIDs.forEach((fileID) => {
        if (safelyHandledFileIDs.has(fileID)) pendingMediaIdsRef.current.delete(fileID);
      });
      return uniqueIDs.every((fileID) => safelyHandledFileIDs.has(fileID));
    } catch {
      // The server only deletes unreferenced files. A later cleanup retry may
      // safely handle a transient failure without blocking the current edit.
      return false;
    } finally {
      mediaCleanupCountRef.current = Math.max(0, mediaCleanupCountRef.current - 1);
      if (mediaCleanupCountRef.current === 0) {
        mediaCleanupInProgressRef.current = false;
        setMediaCleanupInProgress(false);
      }
    }
  };

  const cleanupPendingMedia = async () => {
    const fileIDs = [...pendingMediaIdsRef.current];
    return cleanupMediaIDs(fileIDs);
  };

  const cleanupPendingUploads = async () => {
    const [variantCleanupSucceeded, mediaCleanupSucceeded] = await Promise.all([
      cleanupPendingVariants(),
      cleanupPendingMedia(),
    ]);
    return variantCleanupSucceeded && mediaCleanupSucceeded;
  };

  const createLocalMediaUrl = (file: File) => {
    const url = URL.createObjectURL(file);
    localMediaUrlsRef.current.add(url);
    return url;
  };

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const next = await adminApi.getCase(id);
      setItem(next);
      setGallery(galleryFromItem(next));
      const nextVideoSource: VideoSource = next.videoFileID ? "upload" : next.videoUrl ? "external" : "upload";
      setVideoSource(nextVideoSource);
      setUploadedVideo(next.videoFileID
        ? {
            fileID: next.videoFileID,
            previewUrl: next.videoPreviewUrl || "",
            durationSeconds: next.videoDurationSeconds || 0,
            fileSizeBytes: next.videoFileSizeBytes ?? null,
            fileName: "已上传视频.mp4",
          }
        : null);
      setUploadedPoster(next.videoPosterFileID
        ? {
            fileID: next.videoPosterFileID,
            previewUrl: next.videoPosterPreviewUrl || "",
            fileName: "已上传封面",
          }
        : null);
      setVideoChanged(false);
      setVideoUploadError("");
      setPosterUploadError("");
      retryVideoFileRef.current = null;
      retryPosterFileRef.current = null;
      form.setFieldsValue({
        title: next.title,
        caseId: next.caseId,
        wineType: next.wineType,
        packageTypes: next.packageTypes,
        styles: next.styles,
        priceLevel: next.priceLevel,
        scenes: next.scenes,
        statuses: next.statuses,
        homeSections: next.homeSections,
        sortOrder: next.sortOrder,
        videoUrl: next.videoFileID ? "" : next.videoUrl || "",
        videoPoster: next.videoFileID ? "" : next.videoPoster || "",
        videoDurationSeconds: next.videoDurationSeconds ?? null,
        notes: next.notes,
        isVisible: next.isVisible,
        isPinned: next.isPinned,
      });
      setDirty(false);
    } catch (reason) {
      setError(getErrorMessage(reason, "案例读取失败"));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // The id is the identity of this drawer; form is stable across renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => () => {
    localMediaUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    localMediaUrlsRef.current.clear();
  }, []);

  useEffect(() => {
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      if (
        !dirty &&
        !hasActiveUpload &&
        !savingInProgressRef.current &&
        !mediaCleanupInProgressRef.current
      ) return;
      event.preventDefault();
    };
    window.addEventListener("beforeunload", warnBeforeUnload);
    return () => window.removeEventListener("beforeunload", warnBeforeUnload);
  }, [dirty, hasActiveUpload]);

  useEffect(() => {
    if (blocker.state !== "blocked" || blockerDialogOpenRef.current) return;
    if (
      hasActiveUpload ||
      savingInProgressRef.current ||
      mediaCleanupInProgressRef.current
    ) {
      message.warning("案例正在保存或处理文件，请稍后再离开");
      blocker.reset();
      return;
    }
    blockerDialogOpenRef.current = true;
    Modal.confirm({
      title: "离开并放弃未保存的修改？",
      content: "本次编辑内容尚未保存。继续离开后无法恢复。",
      okText: "放弃并离开",
      cancelText: "继续编辑",
      okButtonProps: { danger: true },
      async onOk() {
        const cleanupSucceeded = await cleanupPendingUploads();
        if (!cleanupSucceeded) {
          message.error("未保存视频清理失败，已保留待重试，请稍后再离开");
          blocker.reset();
          return;
        }
        allowNavigationRef.current = true;
        blocker.proceed();
      },
      onCancel() {
        blocker.reset();
      },
      afterClose() {
        blockerDialogOpenRef.current = false;
      },
    });
  }, [blocker, hasActiveUpload]);

  const close = async () => {
    if (
      hasActiveUpload ||
      savingInProgressRef.current ||
      mediaCleanupInProgressRef.current
    ) {
      message.warning("案例正在保存或处理文件，请稍后再关闭");
      return;
    }
    if (!dirty) {
      const cleanupSucceeded = await cleanupPendingUploads();
      if (!cleanupSucceeded) {
        message.error("未保存视频清理失败，已保留待重试，请稍后再关闭");
        return;
      }
      onClose();
      return;
    }
    Modal.confirm({
      title: "放弃未保存的修改？",
      content: "关闭后，本次编辑内容不会保留。",
      okText: "放弃修改",
      cancelText: "继续编辑",
      okButtonProps: { danger: true },
      async onOk() {
        const cleanupSucceeded = await cleanupPendingUploads();
        if (!cleanupSucceeded) {
          message.error("未保存视频清理失败，已保留待重试，请稍后再关闭");
          return;
        }
        allowNavigationRef.current = true;
        onClose();
      },
    });
  };

  const imageCount = gallery?.galleryImages.length || 0;
  const legacyVariantsIncomplete = Boolean(
    item &&
      item.galleryImages.length &&
      (
        item.sourceGalleryImages.length !== item.galleryImages.length ||
        item.galleryThumbnails.length !== item.galleryImages.length ||
        item.galleryBanners.length !== item.galleryImages.length
      ),
  );
  const canAddImages = canAddGalleryImages(
    config.writeEnabled,
    imageCount,
    config.limits.gallery,
    hasActiveUpload,
    legacyVariantsIncomplete,
  );
  const imageUrls = useMemo(() => gallery?.galleryImageUrls || [], [gallery]);
  const videoPosterPreview = uploadedPoster?.previewUrl || imageUrls[0] || "";
  const mediaControlsDisabled = !config.writeEnabled || hasActiveUpload;

  const addImages = async (files: File[]) => {
    if (!gallery || !files.length) return;
    if (
      hasActiveUpload ||
      savingInProgressRef.current ||
      mediaCleanupInProgressRef.current
    ) return;
    if (!config.writeEnabled) {
      message.warning("当前环境处于只读模式，无法上传图片");
      return;
    }
    if (legacyVariantsIncomplete) {
      message.warning("这个旧案例尚未完成图片变体迁移，当前可编辑元数据，但暂不能追加图片");
      return;
    }
    const remaining = config.limits.gallery - gallery.galleryImages.length;
    if (remaining <= 0) {
      message.warning(`每个案例最多 ${config.limits.gallery} 张图片`);
      return;
    }
    if (files.length > remaining) {
      message.warning(`还可以添加 ${remaining} 张图片`);
      files = files.slice(0, remaining);
    }
    const invalid = files.map((file) => isSupportedImage(file, config.limits.uploadBytes)).find(Boolean);
    if (invalid) {
      message.error(invalid);
      return;
    }
    setUploading(true);
    try {
      const result: UploadedCaseImages = await adminApi.uploadCaseImages(
        files,
        `edit-${id}-${Date.now()}`,
      );
      const localUrls = files.map((file) => URL.createObjectURL(file));
      result.variants.forEach((variant) => {
        pendingVariantIdsRef.current.set(variant.displayFileID, [
          variant.sourceFileID,
          variant.displayFileID,
          variant.thumbnailFileID,
          variant.bannerFileID,
        ]);
      });
      setGallery((current) => {
        if (!current) return current;
        return appendUploadedGallery(current, result, localUrls);
      });
      setDirty(true);
      message.success(`已添加 ${files.length} 张图片`);
    } catch (reason) {
      message.error(getErrorMessage(reason, "图片上传失败"));
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  const uploadVideoFile = async (file: File) => {
    if (
      !item ||
      !config.writeEnabled ||
      !config.features.videoUploadEnabled ||
      hasActiveUpload ||
      savingInProgressRef.current ||
      mediaCleanupInProgressRef.current
    ) return;
    const previousPendingID = uploadedVideo && pendingMediaIdsRef.current.has(uploadedVideo.fileID)
      ? uploadedVideo.fileID
      : "";
    setMediaUploadKind("video");
    setVideoUploadProgress(0);
    setVideoUploadError("");
    retryVideoFileRef.current = file;
    try {
      const metadata = await inspectCaseVideoFile(file, {
        maxBytes: config.limits.videoUploadBytes,
        maxDurationSeconds: config.limits.videoDurationSeconds,
        maxLongEdge: 1920,
        maxShortEdge: 1080,
      });
      const result = await adminApi.uploadCaseVideo(item._id, file, metadata, (progress) => {
        setVideoUploadProgress(progress.percent);
      });
      pendingMediaIdsRef.current.add(result.fileID);
      let previewUrl: string;
      try {
        previewUrl = createLocalMediaUrl(file);
      } catch (previewError) {
        await cleanupMediaIDs([result.fileID]);
        throw previewError;
      }
      if (previousPendingID && previousPendingID !== result.fileID) {
        await cleanupMediaIDs([previousPendingID]);
      }
      setUploadedVideo({
        fileID: result.fileID,
        previewUrl,
        durationSeconds: result.durationSeconds,
        fileSizeBytes: result.fileSizeBytes,
        width: result.width,
        height: result.height,
        fileName: file.name,
      });
      setVideoSource("upload");
      setVideoChanged(true);
      setDirty(true);
      retryVideoFileRef.current = null;
      message.success("视频已上传，保存案例后正式生效");
    } catch (reason) {
      setVideoUploadError(getErrorMessage(reason, "视频上传失败"));
    } finally {
      setMediaUploadKind(null);
      if (videoInputRef.current) videoInputRef.current.value = "";
    }
  };

  const uploadPosterFile = async (file: File) => {
    if (
      !item ||
      !uploadedVideo ||
      !config.writeEnabled ||
      !config.features.videoUploadEnabled ||
      hasActiveUpload ||
      savingInProgressRef.current ||
      mediaCleanupInProgressRef.current
    ) return;
    const previousPendingID = uploadedPoster && pendingMediaIdsRef.current.has(uploadedPoster.fileID)
      ? uploadedPoster.fileID
      : "";
    setPosterUploadError("");
    retryPosterFileRef.current = file;
    try {
      validateVideoPosterFile(file, config.limits.videoPosterUploadBytes);
    } catch (reason) {
      setPosterUploadError(getErrorMessage(reason, "封面格式不正确"));
      return;
    }
    setMediaUploadKind("poster");
    setPosterUploadProgress(0);
    try {
      const result = await adminApi.uploadVideoPoster(item._id, file, (progress) => {
        setPosterUploadProgress(progress.percent);
      });
      pendingMediaIdsRef.current.add(result.fileID);
      let previewUrl: string;
      try {
        previewUrl = createLocalMediaUrl(file);
      } catch (previewError) {
        await cleanupMediaIDs([result.fileID]);
        throw previewError;
      }
      if (previousPendingID && previousPendingID !== result.fileID) {
        await cleanupMediaIDs([previousPendingID]);
      }
      setUploadedPoster({ fileID: result.fileID, previewUrl, fileName: file.name });
      setVideoChanged(true);
      setDirty(true);
      retryPosterFileRef.current = null;
      message.success("视频封面已上传，保存案例后正式生效");
    } catch (reason) {
      setPosterUploadError(getErrorMessage(reason, "视频封面上传失败"));
    } finally {
      setMediaUploadKind(null);
      if (posterInputRef.current) posterInputRef.current.value = "";
    }
  };

  const changeVideoSource = async (nextSource: VideoSource) => {
    if (
      nextSource === videoSource ||
      hasActiveUpload ||
      savingInProgressRef.current ||
      mediaCleanupInProgressRef.current
    ) return;
    if (nextSource === "external") {
      const pendingIDs = [uploadedVideo?.fileID, uploadedPoster?.fileID]
        .filter((fileID): fileID is string => Boolean(fileID && pendingMediaIdsRef.current.has(fileID)));
      await cleanupMediaIDs(pendingIDs);
      if (uploadedVideo && pendingIDs.includes(uploadedVideo.fileID)) setUploadedVideo(null);
      if (uploadedPoster && pendingIDs.includes(uploadedPoster.fileID)) setUploadedPoster(null);
    }
    setVideoSource(nextSource);
    setVideoChanged(true);
    setDirty(true);
  };

  const removeUploadedVideo = async () => {
    if (
      !config.writeEnabled ||
      hasActiveUpload ||
      savingInProgressRef.current ||
      mediaCleanupInProgressRef.current
    ) return;
    const pendingIDs = [uploadedVideo?.fileID, uploadedPoster?.fileID]
      .filter((fileID): fileID is string => Boolean(fileID && pendingMediaIdsRef.current.has(fileID)));
    await cleanupMediaIDs(pendingIDs);
    setUploadedVideo(null);
    setUploadedPoster(null);
    setVideoUploadError("");
    setPosterUploadError("");
    retryVideoFileRef.current = null;
    retryPosterFileRef.current = null;
    setVideoChanged(true);
    setDirty(true);
  };

  const removeUploadedPoster = async () => {
    if (
      !config.writeEnabled ||
      hasActiveUpload ||
      savingInProgressRef.current ||
      mediaCleanupInProgressRef.current ||
      !uploadedPoster
    ) return;
    if (pendingMediaIdsRef.current.has(uploadedPoster.fileID)) {
      await cleanupMediaIDs([uploadedPoster.fileID]);
    }
    setUploadedPoster(null);
    setPosterUploadError("");
    retryPosterFileRef.current = null;
    setVideoChanged(true);
    setDirty(true);
  };

  const removeImage = (index: number) => {
    if (!config.writeEnabled || hasActiveUpload || savingInProgressRef.current) return;
    const displayFileID = gallery?.galleryImages[index];
    const pending = displayFileID ? pendingVariantIdsRef.current.get(displayFileID) : undefined;
    if (pending && displayFileID) {
      void cleanupVariantEntries([[displayFileID, [...pending]]]);
    }
    setGallery((current) => {
      if (!current) return current;
      const remove = (values: string[]) => values.filter((_, itemIndex) => itemIndex !== index);
      return {
        galleryImages: remove(current.galleryImages),
        sourceGalleryImages: remove(
          align(current.sourceGalleryImages, current.galleryImages.length, current.galleryImages),
        ),
        galleryThumbnails: remove(
          align(current.galleryThumbnails, current.galleryImages.length),
        ),
        galleryBanners: remove(
          align(current.galleryBanners, current.galleryImages.length),
        ),
        galleryImageUrls: remove(
          align(current.galleryImageUrls, current.galleryImages.length, current.galleryImages),
        ),
      };
    });
    setDirty(true);
  };

  const reorderImage = (from: number, to: number) => {
    if (!config.writeEnabled || hasActiveUpload || savingInProgressRef.current) return;
    setGallery((current) => {
      if (!current) return current;
      return {
        galleryImages: moveItem(current.galleryImages, from, to),
        sourceGalleryImages: moveItem(
          align(current.sourceGalleryImages, current.galleryImages.length, current.galleryImages),
          from,
          to,
        ),
        galleryThumbnails: moveItem(
          align(current.galleryThumbnails, current.galleryImages.length),
          from,
          to,
        ),
        galleryBanners: moveItem(
          align(current.galleryBanners, current.galleryImages.length),
          from,
          to,
        ),
        galleryImageUrls: moveItem(
          align(current.galleryImageUrls, current.galleryImages.length, current.galleryImages),
          from,
          to,
        ),
      };
    });
    setDirty(true);
  };

  const save = async () => {
    if (!item || !gallery) return;
    if (
      savingInProgressRef.current ||
      uploading ||
      mediaUploadKind !== null ||
      mediaCleanupInProgressRef.current
    ) {
      message.warning("案例或文件正在处理中，请稍后再保存");
      return;
    }
    savingInProgressRef.current = true;
    setSaving(true);
    let values: EditorValues;
    try {
      values = await form.validateFields();
    } catch {
      message.warning("请先补齐必填信息");
      savingInProgressRef.current = false;
      setSaving(false);
      return;
    }
    if (!gallery.galleryImages.length) {
      message.error("案例至少需要 1 张图片");
      savingInProgressRef.current = false;
      setSaving(false);
      return;
    }
    try {
      const {
        videoUrl,
        videoPoster,
        videoDurationSeconds,
        ...caseValues
      } = values;
      const draft: Partial<CaseDraft> = {
        ...caseValues,
        galleryImages: gallery.galleryImages,
        coverImage: gallery.galleryImages[0],
      };
      let videoPatch: VideoPatch | undefined;
      if (videoChanged) {
        if (videoSource === "upload" && uploadedVideo) {
          if (!Number.isSafeInteger(uploadedVideo.durationSeconds) || uploadedVideo.durationSeconds <= 0) {
            message.error("当前视频缺少有效时长，请重新上传视频");
            return;
          }
          videoPatch = {
            mode: "upload",
            fileID: uploadedVideo.fileID,
            durationSeconds: uploadedVideo.durationSeconds,
            ...(uploadedPoster?.fileID ? { posterFileID: uploadedPoster.fileID } : {}),
          };
        } else if (videoSource === "external" && normalizeStableHttpsUrl(videoUrl)) {
          videoPatch = {
            mode: "external",
            url: normalizeStableHttpsUrl(videoUrl),
            ...(videoPoster.trim() ? { posterUrl: normalizeStableHttpsUrl(videoPoster) } : {}),
            ...(videoDurationSeconds ? { durationSeconds: videoDurationSeconds } : {}),
          };
        } else {
          videoPatch = { mode: "clear" };
        }
      }
      const sources = align(gallery.sourceGalleryImages, gallery.galleryImages.length);
      const thumbnails = align(gallery.galleryThumbnails, gallery.galleryImages.length);
      const banners = align(gallery.galleryBanners, gallery.galleryImages.length);
      if (sources.length === gallery.galleryImages.length && sources.every(Boolean)) {
        draft.sourceGalleryImages = sources;
      }
      if (thumbnails.length === gallery.galleryImages.length && thumbnails.every(Boolean)) {
        draft.galleryThumbnails = thumbnails;
        draft.coverThumbnail = thumbnails[0];
      }
      if (banners.length === gallery.galleryImages.length && banners.every(Boolean)) {
        draft.galleryBanners = banners;
        draft.coverBanner = banners[0];
      }
      const fingerprint = JSON.stringify({ draft, videoPatch });
      if (saveMutationRef.current?.fingerprint !== fingerprint) {
        saveMutationRef.current = { fingerprint, id: crypto.randomUUID() };
      }
      const updated = await adminApi.updateCase(
        item._id,
        draft,
        item.version,
        saveMutationRef.current.id,
        videoPatch,
      );
      const retainedMediaIDs = new Set([
        updated.videoFileID || "",
        updated.videoPosterFileID || "",
      ].filter(Boolean));
      retainedMediaIDs.forEach((fileID) => pendingMediaIdsRef.current.delete(fileID));
      const replacedMediaIDs = [item.videoFileID, item.videoPosterFileID]
        .filter((fileID): fileID is string => Boolean(fileID && !retainedMediaIDs.has(fileID)));
      replacedMediaIDs.forEach((fileID) => pendingMediaIdsRef.current.add(fileID));
      setItem(updated);
      setGallery(galleryFromItem(updated));
      setVideoSource(updated.videoFileID ? "upload" : updated.videoUrl ? "external" : "upload");
      setUploadedVideo(updated.videoFileID
        ? {
            fileID: updated.videoFileID,
            previewUrl: updated.videoPreviewUrl || uploadedVideo?.previewUrl || "",
            durationSeconds: updated.videoDurationSeconds || uploadedVideo?.durationSeconds || 0,
            fileSizeBytes: updated.videoFileSizeBytes ?? uploadedVideo?.fileSizeBytes ?? null,
            width: uploadedVideo?.width,
            height: uploadedVideo?.height,
            fileName: uploadedVideo?.fileName || "已上传视频.mp4",
          }
        : null);
      setUploadedPoster(updated.videoPosterFileID
        ? {
            fileID: updated.videoPosterFileID,
            previewUrl: updated.videoPosterPreviewUrl || uploadedPoster?.previewUrl || "",
            fileName: uploadedPoster?.fileName || "已上传封面",
          }
        : null);
      gallery.galleryImages.forEach((displayFileID) => {
        pendingVariantIdsRef.current.delete(displayFileID);
      });
      // The update has committed before cleanup starts. This includes replaced
      // persisted media plus any abandoned draft file whose earlier cleanup
      // failed; the endpoint only removes files that are still unreferenced.
      await cleanupPendingUploads();
      saveMutationRef.current = null;
      setVideoChanged(false);
      setDirty(false);
      message.success("案例已保存");
      onSaved(updated);
    } catch (reason) {
      if (reason instanceof AdminApiError && reason.code === "VERSION_CONFLICT") {
        const pendingVideoDraft = uploadedVideo && pendingMediaIdsRef.current.has(uploadedVideo.fileID)
          ? uploadedVideo
          : null;
        const pendingPosterDraft = uploadedPoster && pendingMediaIdsRef.current.has(uploadedPoster.fileID)
          ? uploadedPoster
          : null;
        Modal.confirm({
          title: "案例已有更新",
          content: pendingVideoDraft || pendingPosterDraft
            ? "另一位管理员刚刚修改了这个案例。加载最新内容后，刚上传的视频文件会继续保留在当前草稿中，请再次保存。"
            : "另一位管理员刚刚修改了这个案例。为避免覆盖，请加载最新内容后重新编辑。",
          okText: "加载最新内容",
          cancelText: "留在当前页面",
          async onOk() {
            await cleanupPendingVariants();
            await load();
            if (pendingVideoDraft) {
              setUploadedVideo(pendingVideoDraft);
              setVideoSource("upload");
              setVideoChanged(true);
              setDirty(true);
            }
            if (pendingPosterDraft) {
              setUploadedPoster(pendingPosterDraft);
              setVideoSource("upload");
              setVideoChanged(true);
              setDirty(true);
            }
          },
        });
      } else {
        message.error(getErrorMessage(reason, "保存失败"));
      }
    } finally {
      savingInProgressRef.current = false;
      setSaving(false);
    }
  };

  return (
    <Drawer
      open
      size={720}
      mask={false}
      title={
        <div className="drawer-title">
          <span>
            <Typography.Text className="page-eyebrow">CASE EDITOR</Typography.Text>
            <Typography.Title level={4}>编辑案例</Typography.Title>
          </span>
          {item ? <Tag>{item.caseId}</Tag> : null}
        </div>
      }
      onClose={() => void close()}
      closable={!hasActiveUpload}
      destroyOnHidden
      footer={
        <div className="drawer-footer">
          <span className="secondary-text">
            {dirty ? "有未保存的修改" : item ? `版本 ${item.version} · 已同步` : ""}
          </span>
          <Space>
            <Button disabled={hasActiveUpload} onClick={() => void close()}>取消</Button>
            <Button
              type="primary"
              icon={<SaveOutlined />}
              loading={saving}
              disabled={!config.writeEnabled || loading || hasActiveUpload}
              onClick={() => void save()}
            >
              保存修改
            </Button>
          </Space>
        </div>
      }
      className="case-editor-drawer"
    >
      {loading ? (
        <div className="drawer-loading">
          <Spin />
          <span>正在加载案例…</span>
        </div>
      ) : error ? (
        <PageError message={error} onRetry={() => void load()} />
      ) : (
        <Form<EditorValues>
          form={form}
          layout="vertical"
          disabled={hasActiveUpload}
          requiredMark="optional"
          onValuesChange={(changedValues) => {
            if (savingInProgressRef.current) return;
            setDirty(true);
            if (
              "videoUrl" in changedValues ||
              "videoPoster" in changedValues ||
              "videoDurationSeconds" in changedValues
            ) {
              setVideoChanged(true);
            }
          }}
          className="editor-form"
        >
          <section className="editor-section">
            <div className="editor-section-heading">
              <span>
                <Typography.Title level={5}>图片</Typography.Title>
                <Typography.Text>
                  第一张为封面，可拖拽或使用前移、后移按钮排序，最多 {config.limits.gallery} 张。
                </Typography.Text>
              </span>
              <Button
                icon={<PlusOutlined />}
                disabled={!canAddImages}
                loading={uploading}
                onClick={() => inputRef.current?.click()}
              >
                添加图片
              </Button>
              <input
                ref={inputRef}
                type="file"
                hidden
                disabled={!canAddImages}
                multiple
                accept="image/jpeg,image/png,image/webp"
                onChange={(event) => void addImages(Array.from(event.target.files || []))}
              />
            </div>

            {legacyVariantsIncomplete ? (
              <Alert
                type="warning"
                showIcon
                title="旧案例图片待迁移"
                description="为避免把展示图误写成原图，本次仍可修改标题、标签和展示设置；完成图片变体迁移后再追加图片。"
                className="editor-legacy-alert"
              />
            ) : null}

            {!imageCount ? (
              <Alert type="warning" showIcon title="还没有图片，请先添加至少一张案例图。" />
            ) : (
              <div className="editor-gallery">
                {gallery?.galleryImages.map((image, index) => (
                  <div
                    key={`${image}-${index}`}
                    className={`editor-gallery-item ${dragIndex === index ? "is-dragging" : ""}`}
                    draggable={!legacyVariantsIncomplete && config.writeEnabled}
                    onDragStart={() => {
                      if (!legacyVariantsIncomplete && config.writeEnabled) setDragIndex(index);
                    }}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={() => {
                      if (dragIndex !== null) reorderImage(dragIndex, index);
                      setDragIndex(null);
                    }}
                    onDragEnd={() => setDragIndex(null)}
                  >
                    {imageUrls[index] ? (
                      <img src={imageUrls[index]} alt={`案例图片 ${index + 1}`} />
                    ) : (
                      <div className="editor-image-placeholder">图片链接待刷新</div>
                    )}
                    <span className="gallery-position">{index === 0 ? "封面" : index + 1}</span>
                    <span className="gallery-drag"><HolderOutlined /></span>
                    <OrderMoveButtons
                      index={index}
                      total={gallery.galleryImages.length}
                      axis="horizontal"
                      className="gallery-order-buttons"
                      ariaContext={`“${item?.title || "当前案例"}”的第 ${index + 1} 张图片`}
                      disabled={legacyVariantsIncomplete || !config.writeEnabled}
                      onMove={(to) => reorderImage(index, to)}
                    />
                    <Button
                      type="text"
                      danger
                      size="small"
                      icon={<DeleteOutlined />}
                      disabled={legacyVariantsIncomplete || !config.writeEnabled}
                      className="gallery-delete"
                      aria-label={`删除第 ${index + 1} 张图片`}
                      onClick={() => removeImage(index)}
                    />
                  </div>
                ))}
              </div>
            )}
          </section>

          <Divider />

          <section className="editor-section">
            <div className="editor-section-heading">
              <span>
                <Typography.Title level={5}>展示视频（可选）</Typography.Title>
                <Typography.Text>
                  每个案例最多 1 个视频。推荐 MP4（H.264 + AAC），最长 {config.limits.videoDurationSeconds} 秒、最大 {formatFileSize(config.limits.videoUploadBytes)}、不超过 1080p。
                </Typography.Text>
              </span>
            </div>
            {!config.features.videoDisplayEnabled ? (
              <Alert
                type="info"
                showIcon
                title="前台视频展示开关当前关闭"
                description="可以先完成配置；开启展示开关前，普通客户详情页不会显示视频。"
                className="editor-video-alert"
              />
            ) : null}

            <Segmented<VideoSource>
              className="editor-video-source"
              block
              value={videoSource}
              disabled={hasActiveUpload}
              options={[
                {
                  value: "upload",
                  label: "上传 MP4",
                  icon: <UploadOutlined />,
                  disabled: !config.features.videoUploadEnabled && !uploadedVideo,
                },
                { value: "external", label: "HTTPS 外链（高级）", icon: <VideoCameraOutlined /> },
              ]}
              onChange={(value) => void changeVideoSource(value)}
            />

            {videoSource === "upload" ? (
              <div className="editor-video-upload-panel">
                {!config.features.videoUploadEnabled ? (
                  <Alert
                    type="warning"
                    showIcon
                    title="当前环境尚未开启视频上传"
                    description="已有视频仍可预览。需要替换时，请先开启 VIDEO_UPLOAD_ENABLED。"
                  />
                ) : null}

                {uploadedVideo ? (
                  <div className="editor-video-card">
                    <div className="editor-video-preview">
                      {uploadedVideo.previewUrl ? (
                        <video
                          src={uploadedVideo.previewUrl}
                          poster={videoPosterPreview || undefined}
                          controls
                          preload="metadata"
                        />
                      ) : (
                        <div className="editor-video-placeholder">
                          <VideoCameraOutlined />
                          <span>视频已保存，预览地址暂不可用</span>
                        </div>
                      )}
                    </div>
                    <div className="editor-video-details">
                      <strong>{uploadedVideo.fileName}</strong>
                      <Space size={[6, 6]} wrap>
                        <Tag>{formatVideoDuration(uploadedVideo.durationSeconds)}</Tag>
                        {uploadedVideo.fileSizeBytes ? <Tag>{formatFileSize(uploadedVideo.fileSizeBytes)}</Tag> : null}
                        {uploadedVideo.width && uploadedVideo.height ? (
                          <Tag>{uploadedVideo.width}×{uploadedVideo.height}</Tag>
                        ) : null}
                      </Space>
                      <Space wrap>
                        <Button
                          icon={<ReloadOutlined />}
                          disabled={mediaControlsDisabled || !config.features.videoUploadEnabled}
                          onClick={() => videoInputRef.current?.click()}
                        >
                          替换视频
                        </Button>
                        <Button
                          danger
                          icon={<DeleteOutlined />}
                          disabled={mediaControlsDisabled}
                          onClick={() => void removeUploadedVideo()}
                        >
                          移除视频
                        </Button>
                      </Space>
                    </div>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="editor-video-picker"
                    disabled={mediaControlsDisabled || !config.features.videoUploadEnabled}
                    onClick={() => videoInputRef.current?.click()}
                  >
                    <VideoCameraOutlined />
                    <strong>选择 MP4 视频</strong>
                    <span>系统会在上传前读取真实大小、时长和分辨率</span>
                  </button>
                )}
                <input
                  ref={videoInputRef}
                  type="file"
                  hidden
                  accept=".mp4,video/mp4"
                  disabled={mediaControlsDisabled || !config.features.videoUploadEnabled}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) void uploadVideoFile(file);
                  }}
                />

                {mediaUploadKind === "video" ? (
                  <div className="editor-media-progress">
                    <Progress percent={videoUploadProgress} status="active" />
                    <span>{videoUploadProgress ? "视频上传中，请勿关闭页面" : "正在校验视频信息…"}</span>
                  </div>
                ) : null}
                {videoUploadError ? (
                  <Alert
                    type="error"
                    showIcon
                    title="视频上传失败"
                    description={videoUploadError}
                    action={retryVideoFileRef.current ? (
                      <Button
                        size="small"
                        icon={<RedoOutlined />}
                        disabled={hasActiveUpload}
                        onClick={() => {
                          const retryFile = retryVideoFileRef.current;
                          if (retryFile) void uploadVideoFile(retryFile);
                        }}
                      >
                        重试
                      </Button>
                    ) : undefined}
                  />
                ) : null}

                {uploadedVideo ? (
                  <div className="editor-poster-row">
                    <div className="editor-poster-preview">
                      {videoPosterPreview ? (
                        <img src={videoPosterPreview} alt="视频封面预览" />
                      ) : (
                        <PictureOutlined />
                      )}
                    </div>
                    <div className="editor-poster-copy">
                      <strong>视频封面（可选）</strong>
                      <span>
                        {uploadedPoster
                          ? uploadedPoster.fileName
                          : `未上传时使用案例第一张图片；支持 JPEG、PNG、WebP，最大 ${formatFileSize(config.limits.videoPosterUploadBytes)}`}
                      </span>
                      <Space wrap>
                        <Button
                          size="small"
                          icon={<PictureOutlined />}
                          disabled={mediaControlsDisabled || !config.features.videoUploadEnabled}
                          onClick={() => posterInputRef.current?.click()}
                        >
                          {uploadedPoster ? "替换封面" : "上传封面"}
                        </Button>
                        {uploadedPoster ? (
                          <Button
                            size="small"
                            danger
                            disabled={mediaControlsDisabled}
                            onClick={() => void removeUploadedPoster()}
                          >
                            使用案例首图
                          </Button>
                        ) : null}
                      </Space>
                    </div>
                    <input
                      ref={posterInputRef}
                      type="file"
                      hidden
                      accept="image/jpeg,image/png,image/webp"
                      disabled={mediaControlsDisabled || !config.features.videoUploadEnabled}
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        if (file) void uploadPosterFile(file);
                      }}
                    />
                  </div>
                ) : null}
                {mediaUploadKind === "poster" ? <Progress percent={posterUploadProgress} status="active" /> : null}
                {posterUploadError ? (
                  <Alert
                    type="error"
                    showIcon
                    title="封面上传失败"
                    description={posterUploadError}
                    action={retryPosterFileRef.current ? (
                      <Button
                        size="small"
                        icon={<RedoOutlined />}
                        disabled={hasActiveUpload}
                        onClick={() => {
                          const retryFile = retryPosterFileRef.current;
                          if (retryFile) void uploadPosterFile(retryFile);
                        }}
                      >
                        重试
                      </Button>
                    ) : undefined}
                  />
                ) : null}
              </div>
            ) : (
              <div className="form-grid form-grid-two editor-video-external-panel">
                <Alert
                  type="warning"
                  showIcon
                  title="高级设置：仅使用长期有效的 HTTPS 直链"
                  description="外链服务的有效期、访问权限和流量费用需由链接提供方保证。"
                  className="form-grid-span-two"
                />
                <Form.Item
                  name="videoUrl"
                  label="视频地址"
                  className="form-grid-span-two"
                  validateTrigger={["onBlur", "onSubmit"]}
                  rules={[
                    { max: 2048, message: "视频地址最多 2048 个字符" },
                    {
                      validator(_, value: string) {
                        if (!value?.trim() || normalizeStableHttpsUrl(value)) return Promise.resolve();
                        return Promise.reject(new Error("请输入有效的 HTTPS 视频链接"));
                      },
                    },
                  ]}
                >
                  <Input
                    allowClear
                    placeholder="https://example.com/case-video.mp4"
                    onChange={(event) => {
                      if (!event.target.value.trim()) {
                        form.setFieldsValue({ videoPoster: "", videoDurationSeconds: null });
                      }
                    }}
                  />
                </Form.Item>
                <Form.Item
                  name="videoPoster"
                  label="视频封面地址"
                  className="form-grid-span-two"
                  dependencies={["videoUrl"]}
                  validateTrigger={["onBlur", "onSubmit"]}
                  rules={[
                    { max: 2048, message: "封面地址最多 2048 个字符" },
                    ({ getFieldValue }) => ({
                      validator(_, value: string) {
                        if (!value?.trim()) return Promise.resolve();
                        if (!getFieldValue("videoUrl")?.trim()) {
                          return Promise.reject(new Error("请先填写视频地址"));
                        }
                        if (normalizeStableHttpsUrl(value)) return Promise.resolve();
                        return Promise.reject(new Error("请输入有效的 HTTPS 封面链接"));
                      },
                    }),
                  ]}
                >
                  <Input allowClear placeholder="可不填，详情页将使用第一张案例图" />
                </Form.Item>
                <Form.Item
                  name="videoDurationSeconds"
                  label="视频时长（秒）"
                  dependencies={["videoUrl"]}
                  rules={[
                    ({ getFieldValue }) => ({
                      validator(_, value: number | null) {
                        if (value === null || value === undefined) return Promise.resolve();
                        if (!getFieldValue("videoUrl")?.trim()) {
                          return Promise.reject(new Error("请先填写视频地址"));
                        }
                        if (
                          Number.isSafeInteger(value) &&
                          value > 0 &&
                          value <= config.limits.videoDurationSeconds
                        ) return Promise.resolve();
                        return Promise.reject(new Error(`请输入 1–${config.limits.videoDurationSeconds} 的整数秒数`));
                      },
                    }),
                  ]}
                >
                  <InputNumber
                    min={1}
                    max={config.limits.videoDurationSeconds}
                    precision={0}
                    className="full-width"
                    placeholder="可选，例如：88"
                  />
                </Form.Item>
              </div>
            )}
          </section>

          <Divider />

          <section className="editor-section">
            <div className="editor-section-heading">
              <span>
                <Typography.Title level={5}>分类</Typography.Title>
                <Typography.Text>补充完整标签，案例会更容易被客户找到。</Typography.Text>
              </span>
            </div>
            <div className="form-grid form-grid-two">
              <Form.Item
                name="title"
                label="案例标题"
                rules={[{ required: true, whitespace: true, message: "请输入案例标题" }]}
              >
                <Input placeholder="例如：山河酿·典藏礼盒" maxLength={60} showCount />
              </Form.Item>
              <Form.Item name="caseId" label="案例编号">
                <Input disabled suffix={<ReloadOutlined />} />
              </Form.Item>
              <Form.Item name="wineType" label="酒类">
                <Select options={config.options.wineTypes.map((value) => ({ value, label: value }))} />
              </Form.Item>
              <Form.Item
                name="packageTypes"
                label="包装"
                rules={[
                  ({ getFieldValue }) => ({
                    validator(_, value: string[]) {
                      if (!getFieldValue("isVisible") || value?.length) return Promise.resolve();
                      return Promise.reject(new Error("上架前至少选择一个包装标签"));
                    },
                  }),
                ]}
              >
                <Select
                  mode="multiple"
                  maxTagCount="responsive"
                  placeholder="选择包装内容"
                  options={config.options.packageTypes.map((value) => ({ value, label: value }))}
                />
              </Form.Item>
              <Form.Item name="styles" label="风格">
                <Select
                  mode="multiple"
                  maxTagCount="responsive"
                  placeholder="选择视觉风格"
                  options={config.options.styles.map((value) => ({ value, label: value }))}
                />
              </Form.Item>
              <Form.Item name="priceLevel" label="价位">
                <Select
                  allowClear
                  placeholder="选择价位"
                  options={config.options.priceLevels.map((value) => ({ value, label: value }))}
                />
              </Form.Item>
              <Form.Item name="scenes" label="场景" className="form-grid-span-two">
                <Select
                  aria-label="适用场景"
                  mode="multiple"
                  maxTagCount="responsive"
                  placeholder="选择适用场景"
                  options={getSceneOptions(config.options.scenes)}
                />
              </Form.Item>
            </div>
          </section>

          <Divider />

          <section className="editor-section">
            <div className="editor-section-heading">
              <span>
                <Typography.Title level={5}>展示</Typography.Title>
                <Typography.Text>运营标签不会决定首页位置，首页位置请单独编排。</Typography.Text>
              </span>
            </div>
            <div className="form-grid form-grid-two">
              <Form.Item name="statuses" label="运营标签">
                <Select
                  mode="multiple"
                  placeholder="可选"
                  options={config.options.statuses.map((value) => ({ value, label: value }))}
                />
              </Form.Item>
              <Form.Item name="sortOrder" label="全局排序">
                <InputNumber min={1} precision={0} className="full-width" />
              </Form.Item>
              <Form.Item name="homeSections" label="首页位置" className="form-grid-span-two">
                <Checkbox.Group className="home-section-checkboxes">
                  {(Object.keys(HOME_SECTION_META) as HomeSection[]).map((section) => (
                    <Checkbox value={section} key={section}>
                      <span>
                        <strong>{HOME_SECTION_META[section].label}</strong>
                        <small>{HOME_SECTION_META[section].description}</small>
                      </span>
                    </Checkbox>
                  ))}
                </Checkbox.Group>
              </Form.Item>
              <Form.Item name="isVisible" label="前台显示" valuePropName="checked">
                <Switch checkedChildren="已上架" unCheckedChildren="已隐藏" />
              </Form.Item>
              <Form.Item name="isPinned" label="默认排序置顶" valuePropName="checked">
                <Switch checkedChildren="已置顶" unCheckedChildren="未置顶" />
              </Form.Item>
            </div>
          </section>

          <Divider />

          <section className="editor-section">
            <div className="editor-section-heading">
              <span>
                <Typography.Title level={5}>备注</Typography.Title>
                <Typography.Text>仅后台管理员可见，不会展示给客户。</Typography.Text>
              </span>
            </div>
            <Form.Item name="notes">
              <Input.TextArea rows={4} maxLength={500} showCount placeholder="记录客户偏好或后续调整事项…" />
            </Form.Item>
          </section>
        </Form>
      )}
    </Drawer>
  );
}
