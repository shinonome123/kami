import { renderTranslationMarkup } from "./term-highlighter.js";

const state = {
  bootstrap: null,
  serverVersion: "0.0.0",
  view: "workbench",
  workbenchLocale: "ja-JP",
  assetLocale: "ja-JP",
  assets: {},
  lastResult: null,
  importFile: null,
  importPreview: null,
  importCompleted: false,
  busy: false,
  activeSuggestion: null,
  translationMode: "single",
  batchFile: null,
  batchBase64: "",
  batchPreview: null,
  batchRunning: false,
  batchPaused: false,
  batchClassification: null,
  batchStyleProfile: null
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

function supportsBatchApi(version) {
  const [major, minor] = String(version || "0.0.0").split(".").map(Number);
  return major > 0 || minor >= 5;
}

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { "content-type": "application/json", ...(options.headers || {}) } });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `请求失败：${response.status}`);
  return payload;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
}

let toastTimer;
function toast(message) {
  const element = $("#toast");
  element.textContent = message;
  element.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.classList.remove("show"), 3000);
}

function setBusy(busy, label) {
  state.busy = busy;
  const button = $("#primaryAction");
  button.disabled = busy;
  if (busy && label) button.textContent = label;
  if (!busy) refreshActions();
}

function renderProviderSecurity(provider) {
  const note = $("#providerSecurityNote");
  if (!note) return;
  if (provider.persistence?.apiKeyPersisted) note.textContent = "API Key 已使用 Windows 当前用户级 DPAPI 加密保存，重启后会自动恢复。";
  else if (provider.apiKeyConfigured) note.textContent = "当前 Key 已载入内存，但尚未加密持久化；再次保存设置后即可永久保存。";
  else note.textContent = "保存后使用 Windows 当前用户级 DPAPI 加密，不会以明文写入项目。";
}

function renderLocaleStrip(container, selected, onSelect) {
  container.innerHTML = Object.entries(state.bootstrap.locales).map(([locale, details]) => `
    <button class="locale-button ${selected === locale ? "active" : ""}" data-locale="${locale}"><strong>${details.shortLabel}</strong><span>${details.label}</span></button>
  `).join("");
  container.querySelectorAll("button").forEach((button) => button.addEventListener("click", () => onSelect(button.dataset.locale)));
}

function pageCopy(view) {
  return {
    workbench: ["TRANSLATION", "翻译", "按目标语言调用独立术语库，并自动识别语体。"],
    import: ["TERM INGESTION", "术语导入", "从中外文表格批量筛选、审核并写入术语库。"],
    assets: ["TERM ASSETS", "术语库", "查看四个物理隔离的目标语言术语集合。"]
  }[view];
}

function refreshActions() {
  if (state.busy) return;
  const primary = $("#primaryAction");
  const secondary = $("#secondaryAction");
  const tertiary = $("#tertiaryAction");
  [secondary, tertiary].forEach((button) => { button.hidden = true; button.disabled = false; });
  primary.disabled = false;
  if (state.view === "workbench") {
    if (state.translationMode === "single") {
      primary.textContent = "开始翻译";
      secondary.hidden = false;
      secondary.textContent = "清空";
      if (state.lastResult) {
        tertiary.hidden = false;
        tertiary.textContent = "复制译文";
      }
    } else {
      const segments = state.batchPreview?.segments || [];
      const hasPending = segments.some((segment) => segment.selected && segment.status !== "done");
      const hasCompleted = segments.some((segment) => segment.status === "done" && segment.translation);
      primary.textContent = state.batchRunning ? (state.batchPaused ? "暂停中…" : "暂停批次") : !state.batchPreview ? "解析并分段" : hasPending ? (segments.some((segment) => segment.status === "error") ? "继续 / 重试" : "开始批次翻译") : "批次已完成";
      primary.disabled = state.batchRunning ? state.batchPaused : (!state.batchPreview && !state.batchFile && !$("#batchPasteText")?.value.trim()) || (Boolean(state.batchPreview) && !hasPending);
      if (state.batchFile || state.batchPreview || $("#batchPasteText")?.value.trim()) {
        secondary.hidden = false;
        secondary.textContent = "清空批次";
      }
      if (hasCompleted) {
        tertiary.hidden = false;
        tertiary.textContent = "导出译文";
      }
    }
  } else if (state.view === "import") {
    primary.textContent = state.importPreview && !state.importCompleted ? "导入已选术语" : "开始智能清洗";
    primary.disabled = state.importCompleted || (!state.importPreview && !state.importFile);
    if (state.importFile || state.importPreview) {
      secondary.hidden = false;
      secondary.textContent = "重新选择";
    }
  } else {
    primary.textContent = "新增单条";
  }
}

function setTranslationMode(mode) {
  if (mode === "batch" && !supportsBatchApi(state.serverVersion)) {
    toast("批次模块已安装，需重启服务后启用");
    return;
  }
  state.translationMode = mode === "batch" ? "batch" : "single";
  $$(".translation-mode").forEach((button) => button.classList.toggle("active", button.dataset.translationMode === state.translationMode));
  $("#singleWorkspace").hidden = state.translationMode !== "single";
  $("#batchWorkspace").hidden = state.translationMode !== "batch";
  $("#viewDescription").textContent = state.translationMode === "batch"
    ? "上传长文或文件，自动分段、逐段审校并合并导出。"
    : "按目标语言调用独立术语库，并自动识别语体。";
  refreshActions();
}

function switchView(view) {
  state.view = view;
  $$(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.view === view));
  $$(".view").forEach((element) => element.classList.toggle("active", element.id === `view-${view}`));
  const [eyebrow, title, description] = pageCopy(view);
  $("#viewEyebrow").textContent = eyebrow;
  $("#viewTitle").textContent = title;
  $("#viewDescription").textContent = description;
  if (view === "assets") updateAssetLocale(state.assetLocale);
  if (view === "workbench") setTranslationMode(state.translationMode);
  refreshActions();
}

function setTranslationStatus(type, text) {
  const badge = $("#translationState");
  badge.className = `badge ${type}`;
  badge.textContent = text;
}

function updateWorkbenchLocale(locale) {
  const localeChanged = state.workbenchLocale !== locale;
  state.workbenchLocale = locale;
  renderLocaleStrip($("#workbenchLocales"), locale, updateWorkbenchLocale);
  const details = state.bootstrap.locales[locale];
  $("#targetKicker").textContent = `TARGET · ${locale.toUpperCase()}`;
  $("#targetTitle").textContent = `${details.label}译文`;
  state.lastResult = null;
  $("#targetOutput").textContent = "译文将在这里显示";
  $("#targetOutput").classList.add("empty");
  $("#targetLegend").hidden = true;
  $("#termMatches").textContent = "尚未匹配";
  $("#termMatches").className = "term-matches empty-list";
  $("#qaList").textContent = "翻译后显示审校结果";
  $("#qaList").className = "qa-list empty-list";
  setTranslationStatus("neutral", "等待翻译");
  if (localeChanged && state.batchPreview) {
    state.batchPreview.segments.forEach((segment) => {
      segment.translation = "";
      segment.result = null;
      segment.error = "";
      segment.status = "pending";
    });
    state.batchClassification = null;
    state.batchStyleProfile = null;
    renderBatchSegments();
  }
  refreshActions();
  previewClassificationAndMatches();
}

function renderMatches(matches) {
  $("#matchCount").textContent = `${matches.length} 条`;
  if (!matches.length) {
    $("#termMatches").className = "term-matches empty-list";
    $("#termMatches").textContent = "当前语言库没有命中项";
    return;
  }
  $("#termMatches").className = "term-matches";
  $("#termMatches").innerHTML = matches.map(({ term, score, mode, matchPhrase }) => `
    <div class="term-chip ${mode === "exact" ? "" : "potential"}"><div><strong>${escapeHtml(term.source)} → ${escapeHtml(term.target)}</strong><small>${mode === "exact" ? "精确或别名匹配" : mode === "smart" ? `智能近似：${escapeHtml(matchPhrase)}` : `字符近似：${escapeHtml(matchPhrase)}`} · ${mode === "exact" && term.enforcement === "required" ? "强制采用" : "待判断"}</small></div><span class="match-score">${Math.round(score * 100)}</span></div>
  `).join("");
}

function renderQa(result) {
  const errors = result.issues.filter((issue) => issue.severity === "error");
  $("#issueCount").textContent = errors.length ? `${errors.length} 个阻断项` : result.issues.length ? `${result.issues.length} 条建议` : "硬校验通过";
  const reflection = result.reflection ? `<div class="reflection-box"><strong>模型反思</strong>\n${escapeHtml(result.reflection)}</div>` : "";
  const issues = result.issues.map((issue) => `<div class="qa-item ${issue.severity}">${escapeHtml(issue.message)}</div>`).join("");
  $("#qaList").className = "qa-list";
  $("#qaList").innerHTML = `${reflection}${issues || '<div class="qa-item">数字、占位符与强制术语检查通过</div>'}`;
}

function setResultStatus(issues = []) {
  if (issues.some((issue) => issue.severity === "error")) setTranslationStatus("error", "需要处理");
  else if (issues.length) setTranslationStatus("warning", "建议确认");
  else setTranslationStatus("success", "QA 通过");
}

function renderTranslationOutput() {
  const result = state.lastResult;
  if (!result) return;
  const rendered = renderTranslationMarkup(result.translation, result.matches, result.termSuggestions || []);
  $("#targetOutput").classList.remove("empty");
  $("#targetOutput").innerHTML = rendered.html;
  $("#targetLegend").hidden = rendered.officialCount + rendered.suggestionCount === 0;
  $("#officialLegend").hidden = rendered.officialCount === 0;
  $("#officialCount").textContent = `${rendered.officialCount} 处正式术语`;
  $("#suggestionLegend").hidden = rendered.suggestionCount === 0;
  $("#suggestionCount").textContent = `${rendered.suggestionCount} 处疑似术语`;
  $$(".term-suggestion").forEach((button) => button.addEventListener("click", () => openTermSuggestion(button.dataset.suggestionId)));
}

function openTermSuggestion(id) {
  const suggestion = state.lastResult?.termSuggestions?.find((item) => item.id === id);
  if (!suggestion) return;
  state.activeSuggestion = suggestion;
  $("#suggestionSource").textContent = `${suggestion.matchedSource} ≈ ${suggestion.sourceTerm}`;
  $("#suggestionCurrent").textContent = suggestion.currentText;
  $("#suggestionReplacement").textContent = suggestion.replacement;
  $("#suggestionConfidence").textContent = `综合置信度 ${Math.round(Math.min(suggestion.matchScore, suggestion.confidence) * 100)}% · ${suggestion.reason}`;
  $("#termSuggestionDialog").showModal();
}

async function applyTermSuggestion() {
  const suggestion = state.activeSuggestion;
  if (!suggestion || !state.lastResult) return;
  state.lastResult.translation = state.lastResult.translation.split(suggestion.currentText).join(suggestion.replacement);
  state.lastResult.termSuggestions = (state.lastResult.termSuggestions || []).filter((item) => item.id !== suggestion.id);
  $("#termSuggestionDialog").close();
  state.activeSuggestion = null;
  try {
    const qa = await api("/api/qa", { method: "POST", body: JSON.stringify({
      source: $("#sourceText").value,
      translation: state.lastResult.translation,
      locale: state.workbenchLocale,
      contentType: state.lastResult.classification.contentType,
      domain: $("#domain").value
    }) });
    state.lastResult.matches = qa.matches;
    state.lastResult.issues = qa.issues;
  } catch (error) { toast(`替换成功，但 QA 刷新失败：${error.message}`); }
  renderTranslationOutput();
  renderMatches(state.lastResult.matches);
  renderQa(state.lastResult);
  setResultStatus(state.lastResult.issues);
  toast(`已将“${suggestion.currentText}”替换为正式译法“${suggestion.replacement}”`);
}

let previewTimer;
function previewClassificationAndMatches() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(async () => {
    const text = $("#sourceText").value.trim();
    $("#sourceCount").textContent = `${[...text].length} 字`;
    if (!text || !state.bootstrap) return;
    try {
      const classification = await api("/api/classify", { method: "POST", body: JSON.stringify({ text, hint: $("#contentType").value }) });
      const matched = await api("/api/match", { method: "POST", body: JSON.stringify({ text, locale: state.workbenchLocale, contentType: classification.contentType, domain: $("#domain").value }) });
      const label = state.bootstrap.contentTypes[classification.contentType].label;
      $("#classificationPreview").innerHTML = `<span class="pulse-dot"></span><span>识别为 <strong>${label}</strong> · 置信度 ${Math.round(classification.confidence * 100)}% · 命中 ${matched.matches.length} 条术语</span>`;
      renderMatches(matched.matches);
    } catch (error) {
      $("#classificationPreview").textContent = error.message;
    }
  }, 300);
}

async function translate() {
  const source = $("#sourceText").value.trim();
  if (!source) return toast("请先输入中文原文");
  setBusy(true, "翻译与审校中…");
  setTranslationStatus("warning", "处理中");
  try {
    const result = await api("/api/translate", { method: "POST", body: JSON.stringify({
      source, locale: state.workbenchLocale, contentType: $("#contentType").value, domain: $("#domain").value,
      neighborContext: $("#neighborContext").value, reflect: $("#reflect").checked, useModelClassification: true
    }) });
    state.lastResult = result;
    renderTranslationOutput();
    $("#classificationPreview").innerHTML = `<span class="pulse-dot"></span><span>语体：<strong>${state.bootstrap.contentTypes[result.classification.contentType].label}</strong> · ${result.classification.source === "model" ? "模型识别" : "规则识别"}</span>`;
    renderMatches(result.matches);
    renderQa(result);
    setResultStatus(result.issues);
  } catch (error) {
    setTranslationStatus("error", "翻译失败");
    toast(error.message);
  } finally { setBusy(false); }
}

function clearTranslation() {
  $("#sourceText").value = "";
  $("#neighborContext").value = "";
  updateWorkbenchLocale(state.workbenchLocale);
}

async function setBatchFile(file) {
  if (!file) return;
  if (!/\.(txt|md|docx|xlsx)$/i.test(file.name)) return toast("请选择 TXT、Markdown、DOCX 或 XLSX 文件");
  if (file.size > 10 * 1024 * 1024) return toast("文件不能超过 10MB");
  state.batchFile = file;
  state.batchBase64 = "";
  state.batchPreview = null;
  state.batchClassification = null;
  state.batchStyleProfile = null;
  $("#batchPasteText").value = "";
  $("#batchFilePrompt").textContent = file.name;
  $("#batchFileMeta").textContent = `${(file.size / 1024).toFixed(1)} KB · 正在智能识别`;
  $("#batchDropZone").classList.add("has-file");
  $("#batchSourceMeta").textContent = "AI 结构识别中";
  $("#spreadsheetAnalysis").hidden = true;
  renderBatchSegments();
  refreshActions();
  await prepareBatch();
}

function resetBatch() {
  if (state.batchRunning) state.batchPaused = true;
  state.batchFile = null;
  state.batchBase64 = "";
  state.batchPreview = null;
  state.batchRunning = false;
  state.batchClassification = null;
  state.batchStyleProfile = null;
  $("#batchFile").value = "";
  $("#batchPasteText").value = "";
  $("#batchFilePrompt").textContent = "拖入或点击选择文件";
  $("#batchFileMeta").textContent = "拖入后自动识别；支持 TXT、Markdown、DOCX、XLSX，最大 10MB";
  $("#batchDropZone").classList.remove("has-file");
  $("#batchSourceMeta").textContent = "尚未载入";
  $("#spreadsheetAnalysis").hidden = true;
  renderBatchSegments();
  refreshActions();
}

function batchStatus(segment) {
  if (!segment.selected) return ["pending", "已跳过", "导出时保留原文"];
  if (segment.status === "running") return ["running", "翻译中", "术语匹配与 QA"];
  if (segment.status === "error") return ["error", "翻译失败", segment.error || "可继续重试"];
  if (segment.status === "done") {
    const issues = segment.result?.issues || [];
    const errors = issues.filter((issue) => issue.severity === "error").length;
    if (errors) return ["warning", "需要复核", `${errors} 个阻断项`];
    if (issues.length) return ["warning", "建议确认", `${issues.length} 条建议`];
    return ["success", "QA 通过", `${segment.result?.matches?.length || 0} 条术语`];
  }
  return ["pending", "待翻译", "等待队列"];
}

function renderSpreadsheetAnalysis(analysis) {
  const element = $("#spreadsheetAnalysis");
  if (!analysis?.sheets?.length) {
    element.hidden = true;
    return;
  }
  const roleLabels = { source_text: "正文", context: "补充信息", constraint: "约束", existing_translation: "已有译文", ignore: "忽略" };
  const sourceLabel = analysis.usedModel ? "AI 已识别" : "规则降级识别";
  element.hidden = false;
  element.innerHTML = `<div class="analysis-head"><strong>Excel 结构识别</strong><span>${sourceLabel}${analysis.fallbackReason ? ` · ${escapeHtml(analysis.fallbackReason)}` : ""}</span></div>${analysis.sheets.map((sheet) => `
    <div class="analysis-sheet"><strong>${escapeHtml(sheet.sheet)} · ${sheet.headerRow ? `表头第 ${sheet.headerRow} 行` : "无表头自动推断"} · ${Math.round((sheet.confidence || 0) * 100)}%</strong><div class="analysis-columns">${sheet.columns.map((column) => `<span class="analysis-column ${column.role}" title="${escapeHtml(column.reason)}">${escapeHtml(column.letter)} · ${escapeHtml(column.label)} → ${roleLabels[column.role] || column.role}</span>`).join("")}</div></div>
  `).join("")}`;
}

function renderBatchSegments() {
  const container = $("#batchSegments");
  const segments = state.batchPreview?.segments || [];
  if (!segments.length) {
    container.innerHTML = '<div class="empty-list batch-empty">拖入文件后会自动识别正文、补充信息并生成翻译队列。</div>';
    $("#batchProgressText").textContent = "等待解析";
    $("#batchProgressMeta").textContent = "0 / 0";
    $("#batchProgressBar").style.width = "0%";
    return;
  }
  const selected = segments.filter((segment) => segment.selected);
  const completed = selected.filter((segment) => segment.status === "done").length;
  const failed = selected.filter((segment) => segment.status === "error").length;
  const percent = selected.length ? Math.round((completed / selected.length) * 100) : 0;
  const styleSuffix = state.batchStyleProfile?.name ? ` · ${state.batchStyleProfile.name}` : "";
  $("#batchProgressText").textContent = `${state.batchRunning ? (state.batchPaused ? "将在当前段后暂停" : "批次翻译中") : completed === selected.length ? "批次已完成" : failed ? "部分分段待重试" : "分段已就绪"}${styleSuffix}`;
  $("#batchProgressMeta").textContent = `${completed} / ${selected.length}${failed ? ` · ${failed} 失败` : ""}`;
  $("#batchProgressBar").style.width = `${percent}%`;
  container.innerHTML = segments.map((segment) => {
    const [className, label, meta] = batchStatus(segment);
    return `<div class="batch-segment ${segment.status === "running" ? "is-running" : ""} ${segment.status === "error" ? "has-error" : ""}" data-segment-id="${segment.id}">
      <div class="batch-segment-index"><input class="batch-segment-check" data-id="${segment.id}" type="checkbox" ${segment.selected ? "checked" : ""} ${state.batchRunning ? "disabled" : ""} aria-label="选择第 ${segment.index} 段" /><span class="row-ref">${segment.index}</span></div>
      <div class="batch-segment-source"><div class="segment-source-text">${escapeHtml(segment.source)}</div>${segment.context?.metadata?.length || segment.context?.referenceTranslations?.length ? `<div class="segment-context">${(segment.context.metadata || []).map((item) => `<span class="${item.role === "constraint" ? "constraint" : ""}" title="${escapeHtml(item.value)}">${escapeHtml(item.label)}：${escapeHtml(item.value)}</span>`).join("")}${(segment.context.referenceTranslations || []).map((item) => `<span class="reference" title="${escapeHtml(item.value)}">参考 · ${escapeHtml(item.label)}：${escapeHtml(item.value)}</span>`).join("")}</div>` : ""}</div>
      <textarea class="batch-segment-target" data-id="${segment.id}" placeholder="${segment.status === "running" ? "正在翻译…" : "译文将在这里显示"}" ${segment.status === "running" ? "disabled" : ""}>${escapeHtml(segment.translation || "")}</textarea>
      <div class="segment-status ${className}"><strong>${label}</strong><small>${escapeHtml(meta)}</small></div>
    </div>`;
  }).join("");
  $$(".batch-segment-check").forEach((checkbox) => checkbox.addEventListener("change", () => {
    const segment = segments.find((item) => item.id === checkbox.dataset.id);
    if (segment) segment.selected = checkbox.checked;
    renderBatchSegments();
    refreshActions();
  }));
  $$(".batch-segment-target").forEach((textarea) => textarea.addEventListener("change", () => {
    const segment = segments.find((item) => item.id === textarea.dataset.id);
    if (!segment) return;
    segment.translation = textarea.value.trim();
    if (segment.translation) {
      segment.status = "done";
      segment.result = segment.result || { issues: [], matches: [] };
    }
    renderBatchSegments();
    refreshActions();
  }));
}

async function prepareBatch() {
  const pasted = $("#batchPasteText").value.trim();
  if (!state.batchFile && !pasted) return toast("请先上传文件或粘贴长文");
  setBusy(true, state.batchFile?.name.toLowerCase().endsWith(".xlsx") ? "AI 识别表格结构中…" : "解析与分段中…");
  try {
    state.batchBase64 = state.batchFile ? await fileToBase64(state.batchFile) : "";
    const prepared = await api("/api/batch/prepare", { method: "POST", body: JSON.stringify({
      filename: state.batchFile?.name || "粘贴长文.txt",
      base64: state.batchBase64 || undefined,
      text: state.batchFile ? undefined : pasted,
      segmentationMode: $("#batchSegmentationMode").value,
      locale: state.workbenchLocale,
      useAiStructure: true
    }) });
    prepared.segments.forEach((segment) => Object.assign(segment, { selected: true, status: "pending", translation: "", result: null, error: "" }));
    state.batchPreview = prepared;
    state.batchClassification = null;
    state.batchStyleProfile = null;
    $("#batchSourceMeta").textContent = `${prepared.statistics.characters} 字 · ${prepared.statistics.segments} 段`;
    renderSpreadsheetAnalysis(prepared.spreadsheetAnalysis);
    if (!state.batchFile) {
      $("#batchFilePrompt").textContent = "已载入粘贴长文";
      $("#batchFileMeta").textContent = `${prepared.statistics.characters} 字 · ${prepared.format.toUpperCase()}`;
      $("#batchDropZone").classList.add("has-file");
    } else $("#batchFileMeta").textContent = `${(state.batchFile.size / 1024).toFixed(1)} KB · ${prepared.spreadsheetAnalysis?.usedModel ? "AI 已识别正文与补充信息" : prepared.format === "xlsx" ? "已按规则识别表格" : "已完成分段"}`;
    renderBatchSegments();
    toast(prepared.format === "xlsx" ? `已识别 ${prepared.statistics.segments} 个翻译单元，补充信息不会作为正文翻译` : `已自动拆分为 ${prepared.statistics.segments} 段，可取消不需要翻译的段落`);
  } catch (error) { toast(error.message); }
  finally { setBusy(false); }
}

async function runBatch() {
  if (!state.batchPreview || state.batchRunning) return;
  const segments = state.batchPreview.segments;
  const queue = segments.filter((segment) => segment.selected && segment.status !== "done");
  if (!queue.length) return toast("没有待翻译的分段");
  state.batchRunning = true;
  state.batchPaused = false;
  refreshActions();
  renderBatchSegments();
  if (!state.batchClassification) {
    const documentText = segments.filter((segment) => segment.selected).map((segment) => segment.source).join("\n").slice(0, 8_000);
    try {
      state.batchClassification = await api("/api/classify", { method: "POST", body: JSON.stringify({
        text: documentText,
        hint: $("#contentType").value,
        useModel: true
      }) });
      const contentType = state.batchClassification.contentType;
      state.batchStyleProfile = {
        id: `batch-${contentType}`,
        name: state.bootstrap.contentTypes[contentType].label,
        source: "batch-content-type",
        instruction: state.bootstrap.contentTypes[contentType].register
      };
      renderBatchSegments();
    } catch (error) {
      state.batchRunning = false;
      refreshActions();
      renderBatchSegments();
      return toast(`批次语体识别失败：${error.message}`);
    }
  }
  for (const segment of queue) {
    if (state.batchPaused) break;
    segment.status = "running";
    segment.error = "";
    renderBatchSegments();
    const position = segments.indexOf(segment);
    const context = {
      ...(segment.context || {}),
      previous: segments[position - 1]?.source || "",
      next: segments[position + 1]?.source || "",
      document: state.batchPreview.filename,
      segmentIndex: position + 1,
      segmentCount: segments.length
    };
    try {
      const result = await api("/api/translate", { method: "POST", body: JSON.stringify({
        source: segment.source,
        locale: state.workbenchLocale,
        contentType: state.batchClassification.contentType,
        domain: $("#domain").value,
        neighborContext: context,
        styleProfile: state.batchStyleProfile,
        reflect: $("#reflect").checked,
        useModelClassification: false
      }) });
      segment.translation = result.translation;
      segment.result = result;
      segment.status = "done";
    } catch (error) {
      segment.status = "error";
      segment.error = error.message;
    }
    renderBatchSegments();
  }
  state.batchRunning = false;
  const paused = state.batchPaused;
  state.batchPaused = false;
  renderBatchSegments();
  refreshActions();
  const failed = segments.filter((segment) => segment.selected && segment.status === "error").length;
  if (paused) toast("批次已暂停，当前进度已保留");
  else if (failed) toast(`批次运行结束，${failed} 段失败，可点击“继续 / 重试”`);
  else toast("批次翻译完成，可以导出原格式文件");
}

function downloadBase64File(payload) {
  const binary = atob(payload.base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  const url = URL.createObjectURL(new Blob([bytes], { type: payload.mimeType }));
  const link = document.createElement("a");
  link.href = url;
  link.download = payload.filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

function invalidateBatchTranslations(message) {
  if (!state.batchPreview || state.batchRunning) return;
  const hadTranslations = state.batchPreview.segments.some((segment) => segment.status === "done");
  state.batchPreview.segments.forEach((segment) => {
    segment.translation = "";
    segment.result = null;
    segment.error = "";
    segment.status = "pending";
  });
  state.batchClassification = null;
  state.batchStyleProfile = null;
  renderBatchSegments();
  refreshActions();
  if (hadTranslations) toast(message);
}

async function exportBatch() {
  if (!state.batchPreview) return;
  setBusy(true, "正在合并文件…");
  try {
    const payload = await api("/api/batch/export", { method: "POST", body: JSON.stringify({
      filename: state.batchPreview.filename,
      locale: state.workbenchLocale,
      format: state.batchPreview.format,
      structure: state.batchPreview.structure,
      base64: state.batchBase64 || undefined,
      segments: state.batchPreview.segments.map(({ id, source, selected, translation }) => ({ id, source, selected, translation }))
    }) });
    downloadBase64File(payload);
    toast(`已导出 ${payload.filename}`);
  } catch (error) { toast(error.message); }
  finally { setBusy(false); }
}

async function updateAssetLocale(locale) {
  state.assetLocale = locale;
  renderLocaleStrip($("#assetLocales"), locale, updateAssetLocale);
  const details = state.bootstrap.locales[locale];
  $("#assetListTitle").textContent = `${details.label}术语库`;
  $("#targetTermLabel").textContent = `${details.label}正式译法`;
  await loadAssets(locale);
}

async function loadAssets(locale) {
  const assets = await api(`/api/assets?locale=${encodeURIComponent(locale)}`);
  state.assets[locale] = assets;
  $("#assetRevision").textContent = `${assets.terms.length} 条`;
  renderAssets();
}

function renderAssets() {
  const data = state.assets[state.assetLocale];
  if (!data) return;
  const query = $("#assetSearch").value.trim().toLowerCase();
  const terms = data.terms.filter((term) => [term.source, term.target, ...(term.aliases || [])].some((value) => value.toLowerCase().includes(query)));
  $("#assetList").innerHTML = terms.length ? terms.map((term) => `
    <div class="asset-row"><div class="asset-row-main"><strong>${escapeHtml(term.source)}</strong><span class="arrow">→</span><strong>${escapeHtml(term.target)}</strong><div class="asset-meta"><span>${term.enforcement === "required" ? "强制" : "优先"}</span>${(term.contentTypes || []).map((type) => `<span>${escapeHtml(state.bootstrap.contentTypes[type]?.label || type)}</span>`).join("")}${term.provenance ? `<span>${escapeHtml(term.provenance)}</span>` : ""}</div></div><button class="delete-term" data-id="${term.id}" title="删除术语" aria-label="删除术语">×</button></div>
  `).join("") : '<div class="empty-list asset-empty">当前筛选没有术语</div>';
  $$(".delete-term").forEach((button) => button.addEventListener("click", async () => {
    if (!confirm("确认从当前语言库删除这条术语？其他语言库不会受影响。")) return;
    await api(`/api/assets/${encodeURIComponent(button.dataset.id)}?locale=${encodeURIComponent(state.assetLocale)}`, { method: "DELETE" });
    await loadAssets(state.assetLocale);
    toast("已从当前语言库删除");
  }));
}

function setImportFile(file) {
  if (!file) return;
  if (!/\.(xlsx|csv)$/i.test(file.name)) return toast("请选择 .xlsx 或 .csv 表格");
  if (file.size > 10 * 1024 * 1024) return toast("表格不能超过 10MB");
  state.importFile = file;
  state.importPreview = null;
  state.importCompleted = false;
  $("#filePrompt").textContent = file.name;
  $("#fileMeta").textContent = `${(file.size / 1024).toFixed(1)} KB · 等待清洗`;
  $("#dropZone").classList.add("has-file");
  $("#mappingNote").textContent = "文件已就绪。点击页头的“开始智能清洗”。";
  $("#importSummary").innerHTML = "<span>等待清洗</span>";
  $("#importCandidates").innerHTML = '<tr><td colspan="6" class="table-empty">清洗后将在此处审核候选</td></tr>';
  refreshActions();
}

function resetImport() {
  state.importFile = null;
  state.importPreview = null;
  state.importCompleted = false;
  $("#termFile").value = "";
  $("#filePrompt").textContent = "拖入或点击选择 .xlsx / .csv";
  $("#fileMeta").textContent = "最大 10MB；支持一张表内同时包含日、韩、繁中、泰列";
  $("#dropZone").classList.remove("has-file");
  $("#mappingNote").textContent = "选择表格后，点击页头的“开始智能清洗”。";
  $("#importSummary").innerHTML = "<span>尚未清洗</span>";
  $("#importCandidates").innerHTML = '<tr><td colspan="6" class="table-empty">还没有候选数据</td></tr>';
  refreshActions();
}

async function fileToBase64(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}

function decisionLabel(candidate) {
  if (candidate.existing) return ["已存在", "existing"];
  if (candidate.conflict) return ["译法冲突", "review"];
  if (candidate.decision === "ready") return ["可入库", "ready"];
  if (candidate.decision === "review") return ["需复核", "review"];
  return ["已排除", "excluded"];
}

function selectedCandidates() {
  return state.importPreview?.candidates.filter((candidate) => candidate.selected) || [];
}

function updateImportSummary() {
  if (!state.importPreview) return;
  const candidates = state.importPreview.candidates;
  const ai = state.importPreview.ai;
  $("#importSummary").innerHTML = `
    <span>候选 <strong>${candidates.length}</strong></span><span>已选 <strong>${selectedCandidates().length}</strong></span><span>需复核 <strong>${candidates.filter((item) => item.decision === "review").length}</strong></span><span>已存在 <strong>${candidates.filter((item) => item.existing).length}</strong></span><span>${ai?.used ? `AI 已审核 ${ai.reviewed} 条` : ai?.requested ? "AI 回退为规则" : "规则清洗"}</span>
  `;
  const selectable = candidates.filter((candidate) => !candidate.existing && candidate.decision !== "excluded");
  $("#selectAllCandidates").checked = selectable.length > 0 && selectable.every((candidate) => candidate.selected);
  $("#selectAllCandidates").indeterminate = selectable.some((candidate) => candidate.selected) && !selectable.every((candidate) => candidate.selected);
}

function renderImportCandidates() {
  const candidates = state.importPreview.candidates;
  $("#importCandidates").innerHTML = candidates.map((candidate, index) => {
    const [label, className] = decisionLabel(candidate);
    const disabled = candidate.existing || candidate.decision === "excluded" || state.importCompleted;
    return `<tr class="candidate-${className}">
      <td class="check-cell"><input class="candidate-check" data-index="${index}" type="checkbox" ${candidate.selected ? "checked" : ""} ${disabled ? "disabled" : ""} /></td>
      <td><span class="locale-tag">${state.bootstrap.locales[candidate.locale].shortLabel} · ${state.bootstrap.locales[candidate.locale].label}</span><small class="row-ref">第 ${candidate.rowNumber} 行</small></td>
      <td><input class="table-input candidate-source" data-index="${index}" value="${escapeHtml(candidate.source)}" ${disabled ? "disabled" : ""} /></td>
      <td><input class="table-input candidate-target" data-index="${index}" value="${escapeHtml(candidate.target)}" ${disabled ? "disabled" : ""} /></td>
      <td><span class="decision-badge ${className}">${label}</span><small class="score">${Math.round(candidate.score * 100)} 分</small></td>
      <td class="reason-cell">${escapeHtml((candidate.reasons || []).join("；") || "短语长度与语言特征通过")}</td>
    </tr>`;
  }).join("");
  $$(".candidate-check").forEach((checkbox) => checkbox.addEventListener("change", () => { state.importPreview.candidates[Number(checkbox.dataset.index)].selected = checkbox.checked; updateImportSummary(); }));
  $$(".candidate-source").forEach((input) => input.addEventListener("change", () => { state.importPreview.candidates[Number(input.dataset.index)].source = input.value.trim(); }));
  $$(".candidate-target").forEach((input) => input.addEventListener("change", () => { state.importPreview.candidates[Number(input.dataset.index)].target = input.value.trim(); }));
  updateImportSummary();
}

async function cleanTable() {
  if (!state.importFile) return toast("请先选择表格");
  setBusy(true, "识别与清洗中…");
  try {
    const result = await api("/api/term-import/preview", { method: "POST", body: JSON.stringify({
      filename: state.importFile.name,
      base64: await fileToBase64(state.importFile),
      locale: $("#importLocale").value,
      useModel: $("#useAiCleaning").checked
    }) });
    result.candidates.forEach((candidate) => { candidate.selected = candidate.decision === "ready" && !candidate.existing; });
    state.importPreview = result;
    state.importCompleted = false;
    const mappings = result.sheets.map((sheet) => `${sheet.sheet}：中文列 ${sheet.sourceColumn}，目标列 ${Object.entries(sheet.targetColumns).map(([locale, column]) => `${state.bootstrap.locales[locale].shortLabel} ${column}`).join(" / ")}`).join("；");
    const aiText = result.ai?.used ? `AI 已复核 ${result.ai.reviewed} 条` : result.ai?.requested ? `AI 不可用，已回退本地规则` : "使用本地规则清洗";
    $("#mappingNote").textContent = `${mappings}。${aiText}。候选不会在确认前写入正式术语库。`;
    renderImportCandidates();
    toast(`已筛出 ${result.candidates.length} 组候选，请审核后导入`);
  } catch (error) { toast(error.message); }
  finally { setBusy(false); }
}

async function commitImport() {
  if (!state.importPreview) return;
  if (!selectedCandidates().length) return toast("请至少选择一组候选术语");
  setBusy(true, "正在分库写入…");
  try {
    const result = await api("/api/term-import/commit", { method: "POST", body: JSON.stringify({
      batchId: state.importPreview.batchId,
      filename: state.importPreview.filename,
      candidates: state.importPreview.candidates,
      domain: $("#importDomain").value,
      contentType: $("#importContentType").value,
      enforcement: $("#importEnforcement").value
    }) });
    state.importCompleted = true;
    const importedIds = new Set(result.imported.map((item) => `${item.locale}\u0000${item.source}\u0000${item.target}`));
    state.importPreview.candidates.forEach((candidate) => {
      if (importedIds.has(`${candidate.locale}\u0000${candidate.source}\u0000${candidate.target}`)) candidate.existing = true;
      candidate.selected = false;
    });
    $("#mappingNote").textContent = `批次已完成：成功写入 ${result.imported.length} 条，跳过 ${result.skipped.length} 条。每条术语只进入自己的目标语言物理表。`;
    renderImportCandidates();
    await Promise.all([...new Set(result.imported.map((item) => item.locale))].map((locale) => loadAssets(locale)));
    toast(`已导入 ${result.imported.length} 条术语`);
  } catch (error) { toast(error.message); }
  finally { setBusy(false); }
}

function populateSelects() {
  const contentOptions = Object.entries(state.bootstrap.contentTypes).map(([value, details]) => `<option value="${value}">${details.label}</option>`).join("");
  $("#contentType").insertAdjacentHTML("beforeend", contentOptions);
  $("#importContentType").innerHTML = contentOptions;
  $("#importContentType").value = "general";
  $("#assetForm select[name=contentType]").innerHTML = contentOptions;
  $("#importLocale").insertAdjacentHTML("beforeend", Object.entries(state.bootstrap.locales).map(([locale, details]) => `<option value="${locale}">仅识别 ${details.label}</option>`).join(""));
}

function bindEvents() {
  $$(".nav-item").forEach((button) => button.addEventListener("click", () => switchView(button.dataset.view)));
  $$(".translation-mode").forEach((button) => button.addEventListener("click", () => setTranslationMode(button.dataset.translationMode)));
  $("#primaryAction").addEventListener("click", () => {
    if (state.view === "workbench" && state.translationMode === "single") translate();
    else if (state.view === "workbench" && state.batchRunning) {
      state.batchPaused = true;
      refreshActions();
      renderBatchSegments();
    }
    else if (state.view === "workbench") state.batchPreview ? runBatch() : prepareBatch();
    else if (state.view === "import") state.importPreview && !state.importCompleted ? commitImport() : cleanTable();
    else $("#assetDialog").showModal();
  });
  $("#secondaryAction").addEventListener("click", () => state.view === "workbench" ? (state.translationMode === "batch" ? resetBatch() : clearTranslation()) : resetImport());
  $("#tertiaryAction").addEventListener("click", async () => {
    if (state.view === "workbench" && state.translationMode === "batch") return exportBatch();
    await navigator.clipboard.writeText(state.lastResult.translation);
    toast("译文已复制");
  });
  $("#sourceText").addEventListener("input", previewClassificationAndMatches);
  $("#contentType").addEventListener("change", () => {
    previewClassificationAndMatches();
    invalidateBatchTranslations("批次语体已改变，请重新运行翻译");
  });
  $("#domain").addEventListener("change", () => {
    previewClassificationAndMatches();
    invalidateBatchTranslations("批次领域已改变，请重新运行翻译");
  });
  $("#batchPasteText").addEventListener("input", () => {
    if ($("#batchPasteText").value.trim()) {
      state.batchFile = null;
      state.batchBase64 = "";
      state.batchPreview = null;
      state.batchClassification = null;
      state.batchStyleProfile = null;
      $("#batchFile").value = "";
      $("#batchFilePrompt").textContent = "已输入粘贴长文";
      $("#batchFileMeta").textContent = `${[...$("#batchPasteText").value.trim()].length} 字 · 等待解析`;
      $("#batchDropZone").classList.add("has-file");
      renderBatchSegments();
    }
    refreshActions();
  });
  $("#batchFile").addEventListener("change", (event) => setBatchFile(event.target.files[0]));
  $("#batchSegmentationMode").addEventListener("change", () => {
    if (!state.batchPreview) return;
    state.batchPreview = null;
    state.batchClassification = null;
    state.batchStyleProfile = null;
    renderBatchSegments();
    refreshActions();
    if (state.batchFile || $("#batchPasteText").value.trim()) prepareBatch();
  });
  $("#batchDropZone").addEventListener("dragover", (event) => { event.preventDefault(); $("#batchDropZone").classList.add("dragging"); });
  $("#batchDropZone").addEventListener("dragleave", () => $("#batchDropZone").classList.remove("dragging"));
  $("#batchDropZone").addEventListener("drop", (event) => { event.preventDefault(); $("#batchDropZone").classList.remove("dragging"); setBatchFile(event.dataTransfer.files[0]); });
  $("#assetSearch").addEventListener("input", renderAssets);
  $("#termFile").addEventListener("change", (event) => setImportFile(event.target.files[0]));
  $("#dropZone").addEventListener("dragover", (event) => { event.preventDefault(); $("#dropZone").classList.add("dragging"); });
  $("#dropZone").addEventListener("dragleave", () => $("#dropZone").classList.remove("dragging"));
  $("#dropZone").addEventListener("drop", (event) => { event.preventDefault(); $("#dropZone").classList.remove("dragging"); setImportFile(event.dataTransfer.files[0]); });
  $("#selectAllCandidates").addEventListener("change", (event) => {
    state.importPreview?.candidates.forEach((candidate) => { if (!candidate.existing && candidate.decision !== "excluded") candidate.selected = event.target.checked; });
    renderImportCandidates();
  });
  $("#assetForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      await api("/api/assets", { method: "POST", body: JSON.stringify({ locale: state.assetLocale, term: {
        source: form.get("source"), target: form.get("target"), aliases: String(form.get("aliases") || "").split(/[,，]/).map((value) => value.trim()).filter(Boolean),
        forbidden: String(form.get("forbidden") || "").split(/[,，]/).map((value) => value.trim()).filter(Boolean), contentTypes: [form.get("contentType")], domains: ["game"], enforcement: form.get("enforcement"), note: form.get("note")
      } }) });
      event.currentTarget.reset();
      $("#assetDialog").close();
      await loadAssets(state.assetLocale);
      toast(`已保存到${state.bootstrap.locales[state.assetLocale].label}术语库`);
    } catch (error) { toast(error.message); }
  });
  $("#openProvider").addEventListener("click", () => {
    const provider = state.bootstrap.provider;
    $("#providerForm [name=baseUrl]").value = provider.baseUrl;
    $("#providerForm [name=model]").value = provider.model;
    const apiKeyInput = $("#providerForm [name=apiKey]");
    apiKeyInput.value = "";
    apiKeyInput.placeholder = provider.apiKeyConfigured ? "已配置 · 留空保持不变" : "未配置 · 如需鉴权请填写";
    renderProviderSecurity(provider);
    $("#providerDialog").showModal();
  });
  $("#providerForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      const provider = await api("/api/provider", { method: "POST", body: JSON.stringify(Object.fromEntries(form)) });
      state.bootstrap.provider = provider;
      $("#providerLabel").textContent = `${provider.model} · ${new URL(provider.baseUrl).hostname}`;
      renderProviderSecurity(provider);
      $("#providerDialog").close();
      toast("模型设置已更新");
    } catch (error) { toast(error.message); }
  });
  $("#confirmTermReplace").addEventListener("click", applyTermSuggestion);
  $$('[data-close]').forEach((button) => button.addEventListener("click", () => $(`#${button.dataset.close}`).close()));
}

async function initialize() {
  try {
    const [bootstrap, health] = await Promise.all([api("/api/bootstrap"), api("/api/health")]);
    state.bootstrap = bootstrap;
    state.serverVersion = health.version || "0.0.0";
    const batchModeButton = $('.translation-mode[data-translation-mode="batch"]');
    if (!supportsBatchApi(state.serverVersion)) {
      batchModeButton.title = "批次模块等待服务重启后启用";
      batchModeButton.querySelector("small").textContent = "等待服务重启后启用";
    }
    $("#serverDot").classList.add("online");
    $("#serverStatus").textContent = "服务在线";
    $("#providerLabel").textContent = `${state.bootstrap.provider.model} · ${new URL(state.bootstrap.provider.baseUrl).hostname}`;
    if (state.bootstrap.backend?.adminUrl) {
      $("#openAdmin").href = state.bootstrap.backend.adminUrl;
      $("#openAdmin").title = `${state.bootstrap.backend.label} · 四语术语后台`;
    } else $("#openAdmin").hidden = true;
    populateSelects();
    renderLocaleStrip($("#workbenchLocales"), state.workbenchLocale, updateWorkbenchLocale);
    renderLocaleStrip($("#assetLocales"), state.assetLocale, updateAssetLocale);
    bindEvents();
    setTranslationMode("single");
    await loadAssets(state.assetLocale);
    updateWorkbenchLocale(state.workbenchLocale);
    refreshActions();
  } catch (error) {
    $("#serverStatus").textContent = "连接失败";
    $("#providerLabel").textContent = error.message;
  }
}

initialize();
