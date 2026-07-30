import {
  DeleteOutlined,
  HolderOutlined,
  PlusOutlined,
  ReloadOutlined,
  SaveOutlined,
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
import { adminApi } from "../lib/api";
import { canAddGalleryImages, isSupportedImage, moveItem } from "../lib/caseLogic";
import { AdminApiError, getErrorMessage } from "../lib/errors";
import { appendUploadedGallery, type GalleryState } from "../lib/galleryLogic";
import type { CaseDraft, CaseRecord, HomeSection, UploadedCaseImages } from "../types";
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
  notes: string;
  isVisible: boolean;
  isPinned: boolean;
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
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState("");
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const pendingVariantIdsRef = useRef(new Map<string, string[]>());
  const saveMutationRef = useRef<{ fingerprint: string; id: string } | null>(null);
  const allowNavigationRef = useRef(false);
  const blockerDialogOpenRef = useRef(false);
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      dirty &&
      !allowNavigationRef.current &&
      currentLocation.pathname !== nextLocation.pathname,
  );

  const cleanupPendingVariants = async () => {
    const fileIDs = [...new Set([...pendingVariantIdsRef.current.values()].flat())];
    pendingVariantIdsRef.current.clear();
    if (!fileIDs.length) return;
    try {
      await adminApi.cleanupUnreferencedFiles(fileIDs);
    } catch {
      // Cleanup is reference-safe and best effort; keep the user's primary action unblocked.
    }
  };

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const next = await adminApi.getCase(id);
      setItem(next);
      setGallery(galleryFromItem(next));
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

  useEffect(() => {
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirty) return;
      event.preventDefault();
    };
    window.addEventListener("beforeunload", warnBeforeUnload);
    return () => window.removeEventListener("beforeunload", warnBeforeUnload);
  }, [dirty]);

  useEffect(() => {
    if (blocker.state !== "blocked" || blockerDialogOpenRef.current) return;
    blockerDialogOpenRef.current = true;
    Modal.confirm({
      title: "离开并放弃未保存的修改？",
      content: "本次编辑内容尚未保存。继续离开后无法恢复。",
      okText: "放弃并离开",
      cancelText: "继续编辑",
      okButtonProps: { danger: true },
      async onOk() {
        await cleanupPendingVariants();
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
  }, [blocker]);

  const close = () => {
    if (!dirty) {
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
        await cleanupPendingVariants();
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
    uploading,
    legacyVariantsIncomplete,
  );
  const imageUrls = useMemo(() => gallery?.galleryImageUrls || [], [gallery]);

  const addImages = async (files: File[]) => {
    if (!gallery || !files.length) return;
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

  const removeImage = (index: number) => {
    if (!config.writeEnabled) return;
    const displayFileID = gallery?.galleryImages[index];
    const pending = displayFileID ? pendingVariantIdsRef.current.get(displayFileID) : undefined;
    if (pending && displayFileID) {
      pendingVariantIdsRef.current.delete(displayFileID);
      void adminApi.cleanupUnreferencedFiles(pending).catch(() => undefined);
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
    if (!config.writeEnabled) return;
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
    let values: EditorValues;
    try {
      values = await form.validateFields();
    } catch {
      message.warning("请先补齐必填信息");
      return;
    }
    if (!gallery.galleryImages.length) {
      message.error("案例至少需要 1 张图片");
      return;
    }
    setSaving(true);
    try {
      const draft: Partial<CaseDraft> = {
        ...values,
        galleryImages: gallery.galleryImages,
        coverImage: gallery.galleryImages[0],
      };
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
      const fingerprint = JSON.stringify(draft);
      if (saveMutationRef.current?.fingerprint !== fingerprint) {
        saveMutationRef.current = { fingerprint, id: crypto.randomUUID() };
      }
      const updated = await adminApi.updateCase(
        item._id,
        draft,
        item.version,
        saveMutationRef.current.id,
      );
      setItem(updated);
      setGallery(galleryFromItem(updated));
      pendingVariantIdsRef.current.clear();
      saveMutationRef.current = null;
      setDirty(false);
      message.success("案例已保存");
      onSaved(updated);
    } catch (reason) {
      if (reason instanceof AdminApiError && reason.code === "VERSION_CONFLICT") {
        Modal.confirm({
          title: "案例已有更新",
          content: "另一位管理员刚刚修改了这个案例。为避免覆盖，请加载最新内容后重新编辑。",
          okText: "加载最新内容",
          cancelText: "留在当前页面",
          async onOk() {
            await cleanupPendingVariants();
            await load();
          },
        });
      } else {
        message.error(getErrorMessage(reason, "保存失败"));
      }
    } finally {
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
      onClose={close}
      destroyOnHidden
      footer={
        <div className="drawer-footer">
          <span className="secondary-text">
            {dirty ? "有未保存的修改" : item ? `版本 ${item.version} · 已同步` : ""}
          </span>
          <Space>
            <Button onClick={close}>取消</Button>
            <Button
              type="primary"
              icon={<SaveOutlined />}
              loading={saving}
              disabled={!config.writeEnabled || loading || uploading}
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
          requiredMark="optional"
          onValuesChange={() => setDirty(true)}
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
                  mode="multiple"
                  maxTagCount="responsive"
                  placeholder="选择适用场景"
                  options={config.options.scenes.map((value) => ({ value, label: value }))}
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
