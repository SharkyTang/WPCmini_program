import {
  CLASSIFICATION_CONFIG,
  CLASSIFIER_STORAGE_KEY,
  IMAGE_QUALITY,
  MAX_IMAGE_EDGE,
  SOFT_SIZE_LIMIT_KB,
  buildExportRecord,
  buildKeywords,
  createEmptyRecord,
  imageSignature,
  isSupportedImageFile,
  isComplete,
  sanitizeRecord,
  setRequiredSingleValue,
  setSingleValue,
  sortImageFiles,
  summarizeRecords,
  toggleMultiValue,
  validateRecord
} from "./classifierLogic.mjs?v=20260616-tag-migration";

const state = {
  files: [],
  fileUrls: new Map(),
  records: [],
  currentIndex: 0,
  savedRecords: loadSavedRecords()
};

const elements = {
  fileInput: document.querySelector("#file-input"),
  stats: document.querySelector("#stats"),
  caseList: document.querySelector("#case-list"),
  progressLabel: document.querySelector("#progress-label"),
  currentTitle: document.querySelector("#current-title"),
  imageStage: document.querySelector("#image-stage"),
  imageMeta: document.querySelector("#image-meta"),
  titleInput: document.querySelector("#title-input"),
  notesInput: document.querySelector("#notes-input"),
  taxonomyGroups: document.querySelector("#taxonomy-groups"),
  validation: document.querySelector("#validation"),
  prevButton: document.querySelector("#prev-button"),
  nextButton: document.querySelector("#next-button"),
  skipButton: document.querySelector("#skip-button"),
  completeButton: document.querySelector("#complete-button"),
  exportButton: document.querySelector("#export-button"),
  clearButton: document.querySelector("#clear-button"),
  exportLog: document.querySelector("#export-log")
};

elements.fileInput.addEventListener("change", handleFileSelection);
elements.titleInput.addEventListener("input", () => updateCurrentRecord({ title: elements.titleInput.value }));
elements.notesInput.addEventListener("input", () => updateCurrentRecord({ notes: elements.notesInput.value }));
elements.prevButton.addEventListener("click", () => selectIndex(state.currentIndex - 1));
elements.nextButton.addEventListener("click", () => selectIndex(state.currentIndex + 1));
elements.skipButton.addEventListener("click", skipCurrent);
elements.completeButton.addEventListener("click", markCurrentComplete);
elements.exportButton.addEventListener("click", exportAll);
elements.clearButton.addEventListener("click", clearProgress);

renderTaxonomyGroups();
render();

function loadSavedRecords() {
  try {
    const raw = localStorage.getItem(CLASSIFIER_STORAGE_KEY);
    if (!raw) return {};
    return Object.fromEntries(
      Object.entries(JSON.parse(raw)).map(([signature, record]) => [signature, sanitizeRecord(record)])
    );
  } catch {
    return {};
  }
}

function persistRecords() {
  const bySignature = {};
  for (let index = 0; index < state.files.length; index += 1) {
    bySignature[imageSignature(state.files[index])] = sanitizeRecord(state.records[index]);
  }
  state.savedRecords = bySignature;
  localStorage.setItem(CLASSIFIER_STORAGE_KEY, JSON.stringify(bySignature));
}

function handleFileSelection(event) {
  for (const url of state.fileUrls.values()) URL.revokeObjectURL(url);
  state.fileUrls.clear();

  const selectedFiles = [...(event.target.files || [])];
  const unsupportedCount = selectedFiles.filter((file) => !isSupportedImageFile(file)).length;
  state.files = sortImageFiles(selectedFiles);
  state.records = state.files.map((file, index) => {
    const previous = state.savedRecords[imageSignature(file)];
    return createEmptyRecord(file, index, previous);
  });
  state.currentIndex = 0;
  persistRecords();
  render();
  if (unsupportedCount) {
    appendLog(`已忽略 ${unsupportedCount} 个非 jpg/jpeg/png 文件。`);
  }
}

function currentRecord() {
  return state.records[state.currentIndex] || null;
}

function currentFile() {
  return state.files[state.currentIndex] || null;
}

function selectIndex(index) {
  if (index < 0 || index >= state.records.length) return;
  state.currentIndex = index;
  render();
}

function updateCurrentRecord(patch) {
  const record = currentRecord();
  if (!record) return;
  const completionPatch = Object.prototype.hasOwnProperty.call(patch, "completed")
    ? patch.completed
    : Object.prototype.hasOwnProperty.call(patch, "skipped")
      ? false
      : false;
  state.records[state.currentIndex] = {
    ...sanitizeRecord({
      ...record,
      ...patch
    }),
    completed: completionPatch
  };
  persistRecords();
  render({ keepFocus: true });
}

function skipCurrent() {
  const record = currentRecord();
  if (!record) return;
  updateCurrentRecord({ skipped: true, completed: false });
  if (state.currentIndex < state.records.length - 1) selectIndex(state.currentIndex + 1);
}

function markCurrentComplete() {
  const record = currentRecord();
  if (!record) return;
  const errors = validateRecord(record);
  if (errors.length) {
    render();
    return;
  }
  updateCurrentRecord({ completed: true, skipped: false });
  if (state.currentIndex < state.records.length - 1) selectIndex(state.currentIndex + 1);
}

function clearProgress() {
  const confirmed = window.confirm("确定清空当前分类进度？原始图片不会被修改。");
  if (!confirmed) return;
  localStorage.removeItem(CLASSIFIER_STORAGE_KEY);
  state.savedRecords = {};
  state.records = state.files.map((file, index) => createEmptyRecord(file, index));
  state.currentIndex = 0;
  render();
}

function render(options = {}) {
  renderStats();
  renderCaseList();
  renderCurrent(options);
}

function renderStats() {
  const stats = summarizeRecords(state.records);
  elements.stats.innerHTML = [
    ["总数", stats.total],
    ["已完成", stats.completed],
    ["未完成", stats.invalid],
    ["需复查", stats.needsReview]
  ]
    .map(([label, value]) => `<div class="stat"><strong>${value}</strong><span>${label}</span></div>`)
    .join("");
  elements.progressLabel.textContent = `${state.records.length ? state.currentIndex + 1 : 0} / ${state.records.length}`;
}

function renderCaseList() {
  elements.caseList.innerHTML = state.records
    .map((record, index) => {
      const complete = isComplete(record);
      const current = index === state.currentIndex ? " is-current" : "";
      const status = record.skipped ? "已跳过" : complete ? "已完成" : "未完成";
      return `<button type="button" class="case-item${current}" data-index="${index}">
        <strong>${escapeHtml(record.id)} · ${escapeHtml(status)}</strong>
        <span>${escapeHtml(record.originalFileName)}</span>
      </button>`;
    })
    .join("");

  for (const button of elements.caseList.querySelectorAll(".case-item")) {
    button.addEventListener("click", () => selectIndex(Number(button.dataset.index)));
  }
}

function renderCurrent(options = {}) {
  const record = currentRecord();
  const file = currentFile();
  const hasRecord = Boolean(record && file);

  elements.prevButton.disabled = !hasRecord || state.currentIndex === 0;
  elements.nextButton.disabled = !hasRecord || state.currentIndex >= state.records.length - 1;
  elements.skipButton.disabled = !hasRecord;
  elements.completeButton.disabled = !hasRecord;
  elements.exportButton.disabled = !state.records.length;

  if (!hasRecord) {
    elements.currentTitle.textContent = "请选择图片文件夹";
    elements.imageStage.innerHTML = "<p>选择图片文件夹后开始分类。</p>";
    elements.imageMeta.innerHTML = "";
    elements.titleInput.value = "";
    elements.notesInput.value = "";
    elements.titleInput.disabled = true;
    elements.notesInput.disabled = true;
    elements.validation.innerHTML = "";
    updateTaxonomySelection(null);
    return;
  }

  elements.titleInput.disabled = false;
  elements.notesInput.disabled = false;
  if (!options.keepFocus || document.activeElement !== elements.titleInput) elements.titleInput.value = record.title || "";
  if (!options.keepFocus || document.activeElement !== elements.notesInput) elements.notesInput.value = record.notes || "";

  elements.currentTitle.textContent = `${record.id} · ${record.title || record.originalFileName}`;
  renderImage(file);
  renderMeta(record, file);
  renderValidation(record);
  updateTaxonomySelection(record);
}

function renderImage(file) {
  let url = state.fileUrls.get(file.name);
  if (!url) {
    url = URL.createObjectURL(file);
    state.fileUrls.set(file.name, url);
  }
  elements.imageStage.innerHTML = `<img src="${url}" alt="${escapeHtml(file.name)}" />`;
}

function renderMeta(record, file) {
  const items = [
    ["编号", record.id],
    ["原文件名", record.originalFileName],
    ["导出文件名", record.uploadFileName],
    ["原始大小", `${record.originalSizeKB} KB`],
    ["格式", file.type || "未知"],
    ["压缩状态", record.needsReview ? "需复查" : "未导出"]
  ];
  elements.imageMeta.innerHTML = items
    .map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`)
    .join("");
}

function renderValidation(record) {
  const errors = validateRecord(record);
  if (!errors.length) {
    elements.validation.innerHTML = "<p class=\"hint\">必填项完整，可以标记完成。</p>";
    return;
  }
  elements.validation.innerHTML = `<ul>${errors.map((error) => `<li>${escapeHtml(error)}</li>`).join("")}</ul>`;
}

function renderTaxonomyGroups() {
  elements.taxonomyGroups.innerHTML = Object.entries(CLASSIFICATION_CONFIG)
    .map(([field, config]) => {
      const required = config.required ? " · 必填" : "";
      const buttons = config.options
        .map(
          (option) =>
            `<button type="button" class="tax-option" data-field="${field}" data-type="${config.type}" data-required="${config.required}" data-value="${option}">${option}</button>`
        )
        .join("");
      return `<section class="tax-group" data-group="${field}">
        <h3>${config.label}${required}</h3>
        <div class="tax-options">${buttons}</div>
      </section>`;
    })
    .join("");

  for (const button of elements.taxonomyGroups.querySelectorAll(".tax-option")) {
    button.addEventListener("click", () => {
      const record = currentRecord();
      if (!record) return;
      const field = button.dataset.field;
      const value = button.dataset.value;
      const type = button.dataset.type;
      const required = button.dataset.required === "true";
      const next =
        type === "multi"
          ? toggleMultiValue(record, field, value)
          : required
            ? setRequiredSingleValue(record, field, value)
            : setSingleValue(record, field, value);
      state.records[state.currentIndex] = { ...sanitizeRecord(next), completed: false };
      persistRecords();
      render();
    });
  }
}

function updateTaxonomySelection(record) {
  for (const button of elements.taxonomyGroups.querySelectorAll(".tax-option")) {
    if (!record) {
      button.disabled = true;
      button.classList.remove("is-selected");
      continue;
    }
    button.disabled = false;
    const field = button.dataset.field;
    const value = button.dataset.value;
    const selected = Array.isArray(record[field]) ? record[field].includes(value) : record[field] === value;
    button.classList.toggle("is-selected", selected);
  }
}

async function exportAll() {
  if (!state.records.length) return;

  const invalid = state.records.filter((record) => !record.skipped && !isComplete(record));
  if (invalid.length) {
    const confirmed = window.confirm(`还有 ${invalid.length} 张图片缺少必填字段。继续导出会跳过未完成图片。是否继续？`);
    if (!confirmed) return;
  }

  elements.exportLog.textContent = "开始压缩图片...\n";
  const completePairs = state.records
    .map((record, index) => ({ record, file: state.files[index] }))
    .filter(({ record }) => !record.skipped && isComplete(record));

  const exportedRecords = [];
  const optimizedImages = [];

  for (let index = 0; index < completePairs.length; index += 1) {
    const { record, file } = completePairs[index];
    appendLog(`处理 ${record.id} (${index + 1}/${completePairs.length})`);
    const optimized = await optimizeImage(file);
    const nextRecord = sanitizeRecord({
      ...record,
      width: optimized.width,
      height: optimized.height,
      optimizedSizeKB: optimized.optimizedSizeKB,
      needsReview: optimized.optimizedSizeKB > SOFT_SIZE_LIMIT_KB
    });
    exportedRecords.push(buildExportRecord(nextRecord, optimized));
    optimizedImages.push({ fileName: record.uploadFileName, blob: optimized.blob });
    state.records[state.records.findIndex((item) => item.id === record.id)] = nextRecord;
  }

  persistRecords();
  const jsonBlob = new Blob([JSON.stringify(exportedRecords, null, 2)], { type: "application/json;charset=utf-8" });

  if ("showDirectoryPicker" in window) {
    await exportToDirectory(jsonBlob, optimizedImages);
  } else {
    downloadBlob(jsonBlob, "cases.json");
    for (const image of optimizedImages) downloadBlob(image.blob, image.fileName);
    appendLog("浏览器不支持选择导出目录，已改为逐个下载文件。");
  }

  appendLog(`完成：导出 ${exportedRecords.length} 条记录，${optimizedImages.length} 张 JPG。`);
  render();
}

async function exportToDirectory(jsonBlob, images) {
  const root = await window.showDirectoryPicker({ mode: "readwrite" });
  const exportDir = await root.getDirectoryHandle("export", { create: true });
  const imageDir = await exportDir.getDirectoryHandle("optimized-images", { create: true });

  await writeFile(exportDir, "cases.json", jsonBlob);
  for (const image of images) {
    await writeFile(imageDir, image.fileName, image.blob);
  }
  appendLog("已写入 export/cases.json 和 export/optimized-images/。");
}

async function writeFile(directoryHandle, fileName, blob) {
  const handle = await directoryHandle.getFileHandle(fileName, { create: true });
  const writable = await handle.createWritable();
  await writable.write(blob);
  await writable.close();
}

async function optimizeImage(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", IMAGE_QUALITY));
  return {
    blob,
    width,
    height,
    optimizedSizeKB: Math.round(blob.size / 1024)
  };
}

function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function appendLog(message) {
  elements.exportLog.textContent += `${message}\n`;
  elements.exportLog.scrollTop = elements.exportLog.scrollHeight;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
