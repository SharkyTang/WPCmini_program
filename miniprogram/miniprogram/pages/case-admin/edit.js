const {
  CASE_ADMIN_FORM_OPTIONS,
  buildCaseAdminImagePath,
  buildCaseAdminPayload,
  createEmptyCaseForm,
  validateCaseAdminForm,
} = require("../../utils/caseAdminData");
const {
  createCaseAdmin,
  fetchCaseAdminDetail,
  updateCaseAdmin,
  uploadCaseCoverImage,
} = require("../../utils/caseAdminService");

function toggleValue(values = [], value) {
  if (!value) return values;
  return values.includes(value)
    ? values.filter((item) => item !== value)
    : values.concat(value);
}

function getMediaPath(result = {}) {
  const file = result.tempFiles && result.tempFiles[0];
  return file && (file.tempFilePath || file.path);
}

Page({
  data: {
    id: "",
    isEdit: false,
    loading: false,
    saving: false,
    uploading: false,
    errorMessage: "",
    coverImageUrl: "",
    form: createEmptyCaseForm(),
    formOptions: CASE_ADMIN_FORM_OPTIONS,
  },

  onLoad(options = {}) {
    if (options.id) {
      this.loadCase(options.id);
    }
  },

  async loadCase(id) {
    this.setData({
      id,
      isEdit: true,
      loading: true,
      errorMessage: "",
    });

    try {
      const caseItem = await fetchCaseAdminDetail(id);
      this.setData({
        loading: false,
        coverImageUrl: caseItem.coverImageUrl || caseItem.coverImage || "",
        form: {
          title: caseItem.title || "",
          caseId: caseItem.caseId || "",
          coverImage: caseItem.coverImage || "",
          wineType: caseItem.wineType || "白酒",
          packageTypes: caseItem.packageTypes || [],
          styles: caseItem.styles || [],
          priceLevel: caseItem.priceLevel || "",
          scenes: caseItem.scenes || [],
          statuses: caseItem.statuses || [],
          sortOrder:
            caseItem.sortOrder === undefined || caseItem.sortOrder === null
              ? ""
              : String(caseItem.sortOrder),
          notes: caseItem.notes || "",
          isVisible: caseItem.isVisible !== false,
        },
      });
    } catch (error) {
      console.warn("读取案例详情失败", error);
      this.setData({
        loading: false,
        errorMessage: "案例读取失败，请返回后重试",
      });
    }
  },

  updateFormField(field, value) {
    this.setData({
      [`form.${field}`]: value,
    });
  },

  onTitleInput(event) {
    this.updateFormField("title", event.detail.value || "");
  },

  onCaseIdInput(event) {
    this.updateFormField("caseId", event.detail.value || "");
  },

  onSortOrderInput(event) {
    this.updateFormField("sortOrder", event.detail.value || "");
  },

  onNotesInput(event) {
    this.updateFormField("notes", event.detail.value || "");
  },

  onVisibleChange(event) {
    this.updateFormField("isVisible", event.detail.value === true);
  },

  selectSingle(event) {
    const { field, value } = event.currentTarget.dataset;
    if (!field) return;
    const current = this.data.form[field];
    this.updateFormField(field, current === value ? "" : value);
  },

  toggleMulti(event) {
    const { field, value } = event.currentTarget.dataset;
    if (!field) return;
    const nextValues = toggleValue(this.data.form[field] || [], value);
    this.updateFormField(field, nextValues);
  },

  chooseCoverImage() {
    wx.chooseMedia({
      count: 1,
      mediaType: ["image"],
      sourceType: ["album", "camera"],
      sizeType: ["compressed"],
      success: async (result) => {
        const filePath = getMediaPath(result);
        if (!filePath) return;
        await this.uploadCover(filePath);
      },
    });
  },

  compressImage(filePath) {
    if (!wx.compressImage) {
      return Promise.resolve(filePath);
    }

    return new Promise((resolve) => {
      wx.compressImage({
        src: filePath,
        quality: 70,
        success: (result) => resolve(result.tempFilePath || filePath),
        fail: () => resolve(filePath),
      });
    });
  },

  async uploadCover(filePath) {
    this.setData({
      uploading: true,
    });

    try {
      const compressedPath = await this.compressImage(filePath);
      const cloudPath = buildCaseAdminImagePath(compressedPath);
      const fileID = await uploadCaseCoverImage({
        filePath: compressedPath,
        cloudPath,
      });
      this.setData({
        uploading: false,
        coverImageUrl: compressedPath,
        "form.coverImage": fileID,
      });
      wx.showToast({
        title: "图片已上传",
        icon: "none",
      });
    } catch (error) {
      console.warn("上传案例封面失败", error);
      this.setData({
        uploading: false,
      });
      wx.showToast({
        title: "图片上传失败",
        icon: "none",
      });
    }
  },

  async saveCase() {
    const validation = validateCaseAdminForm(this.data.form, {
      isCreate: !this.data.isEdit,
    });

    if (!validation.valid) {
      wx.showToast({
        title: validation.message,
        icon: "none",
      });
      return;
    }

    this.setData({
      saving: true,
    });

    try {
      const payload = buildCaseAdminPayload(this.data.form);
      if (this.data.isEdit) {
        await updateCaseAdmin(this.data.id, payload);
      } else {
        await createCaseAdmin(payload);
      }
      wx.showToast({
        title: "已保存",
        icon: "none",
      });
      setTimeout(() => {
        wx.navigateBack({
          delta: 1,
        });
      }, 350);
    } catch (error) {
      console.warn("保存案例失败", error);
      wx.showToast({
        title: "保存失败，请稍后重试",
        icon: "none",
      });
    } finally {
      this.setData({
        saving: false,
      });
    }
  },
});
