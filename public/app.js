import { renderTranslationMarkup } from "./term-highlighter.js";
import { normalizePastedText, shouldRoutePasteToBatch } from "./paste-routing.js";

const state = {
  bootstrap: null,
  serverVersion: "0.0.0",
  view: "workbench",
  workbenchLocale: "ja-JP",
  assetLocale: "ja-JP",
  styleLocale: "ja-JP",
  learningLocale: "ja-JP",
  autoQaLocale: "ja-JP",
  learningData: null,
  learningLoading: false,
  learningSelectedSkillId: "",
  tasks: [],
  shareFeedbackScope: null,
  feedbackPending: [],
  feedbackLastCount: 0,
  feedbackAll: [],
  feedbackStatusFilter: "pending",
  styleData: null,
  assets: {},
  lastResult: null,
  importFile: null,
  importPreview: null,
  importCompleted: false,
  importCandidateTab: "terms",
  importBatchLearning: [],
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
let batchSaveChain = Promise.resolve();
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

function updateImportProgress(progress = {}) {
  const container = $("#importProgress");
  if (!container) return;
  const percent = Math.max(0, Math.min(100, Number(progress.percent) || 0));
  container.hidden = false;
  $("#importProgressText").textContent = progress.message || "正在识别与清洗";
  const batchMeta = Number(progress.total) > 0 ? ` · ${Number(progress.completed) || 0} / ${progress.total} 批` : "";
  const concurrencyMeta = progress.concurrency ? ` · ${progress.concurrency} 路并发` : "";
  $("#importProgressMeta").textContent = `${percent}%${batchMeta}${concurrencyMeta}`;
  $("#importProgressBar").style.width = `${percent}%`;
}

async function watchImportProgress(progressId, control) {
  while (!control.done) {
    try {
      const response = await fetch(`/api/term-import/progress/${encodeURIComponent(progressId)}`, { cache: "no-store" });
      if (response.ok) {
        const progress = await response.json();
        updateImportProgress(progress);
        if (progress.status === "completed" || progress.status === "failed") return;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 350));
  }
}

function renderProviderSecurity(provider) {
  const note = $("#providerSecurityNote");
  if (!note) return;
  const keys = [
    provider.persistence?.apiKeyPersisted ? "主 API Key" : "",
    provider.persistence?.embeddingApiKeyPersisted ? "Embedding API Key" : ""
  ].filter(Boolean);
  if (keys.length) note.textContent = `${keys.join("与")}已使用 Windows 当前用户级 DPAPI 加密保存，重启后会自动恢复。`;
  else if (provider.apiKeyConfigured || provider.embeddingApiKeyConfigured) note.textContent = "当前 Key 已载入内存，但尚未加密持久化；再次保存设置后即可永久保存。";
  else note.textContent = "保存后使用 Windows 当前用户级 DPAPI 加密，不会以明文写入项目。Embedding 地址与 Key 可独立于主模型配置。";
}

function renderLocaleStrip(container, selected, onSelect) {
  container.innerHTML = Object.entries(state.bootstrap.locales).map(([locale, details]) => `
    <button class="locale-button ${selected === locale ? "active" : ""}" data-locale="${locale}">
      <img class="locale-flag" src="${escapeHtml(details.flagAsset)}" alt="" aria-hidden="true" />
      <span>${details.label}</span>
    </button>
  `).join("");
  container.querySelectorAll("button").forEach((button) => button.addEventListener("click", () => onSelect(button.dataset.locale)));
}

function pageCopy(view) {
  if (view === "learning") return ["LEARNING CENTER", "学习中心", "将翻译轨迹沉淀为可评测、可批准、可回滚的翻译技能。"];
  return {
    workbench: ["TRANSLATION", "翻译", "按目标语言调用独立术语库，并自动识别语体。"],
    autoqa: ["AUTO QA", "Auto QA", "逐句切分对齐后，按基本检查、语义忠实性（着重）与 nuance 一致性三层独立审查。"],
    feedback: ["FEEDBACK CENTER", "反馈中心", "同事在分享验证页提出的要求：逐条批准入风格或忽略。"],
    tasks: ["TASK CENTER", "任务中心", "查看、恢复、审校并导出所有历史翻译任务。"],
    import: ["TERM INGESTION", "术语导入", "只需拖入中外文表格，系统会自动分类并生成待确认结果。"],
    assets: ["TERM ASSETS", "术语库", "查看四个物理隔离的目标语言术语集合。"],
    styles: ["STYLE GUIDANCE", "风格指导", "查看并控制已沉淀的翻译风格规则。"]
  }[view];
}

function refreshActions() {
  if (state.busy) return;
  const primary = $("#primaryAction");
  const secondary = $("#secondaryAction");
  const tertiary = $("#tertiaryAction");
  [secondary, tertiary].forEach((button) => { button.hidden = true; button.disabled = false; });
  primary.disabled = false;
  primary.title = "";
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
    primary.textContent = state.importPreview && !state.importCompleted ? "确认选中项入库" : state.importFile ? "重新智能识别" : "等待拖入表格";
    primary.disabled = state.importCompleted || (!state.importPreview && !state.importFile);
    if (state.importFile || state.importPreview) {
      secondary.hidden = false;
      secondary.textContent = "重新选择";
    }
  } else if (state.view === "assets") {
    primary.textContent = "新增单条";
  } else if (state.view === "tasks") {
    primary.textContent = "刷新任务";
  } else if (state.view === "styles") {
    primary.textContent = "刷新风格";
  } else if (state.view === "autoqa") {
    primary.textContent = "运行 Auto QA";
    primary.disabled = !$("#autoQaSource")?.value.trim() || !$("#autoQaTarget")?.value.trim();
    if ($("#autoQaSource")?.value.trim() || $("#autoQaTarget")?.value.trim()) {
      secondary.hidden = false;
      secondary.textContent = "清空";
    }
  } else if (state.view === "feedback") {
    primary.textContent = "刷新反馈";
  }
  if (state.view === "learning") {
    primary.textContent = state.learningLoading ? "正在读取学习轨迹……" : "根据近期轨迹生成候选技能";
    const payload = state.learningData?.data || state.learningData || {};
    const usableCount = state.learningData ? validLearningTrajectories(payload.trajectories || payload.evidence).length : 0;
    primary.disabled = state.learningLoading || !state.learningData || usableCount === 0;
    if (!state.learningLoading && usableCount === 0) primary.title = "当前语言、语体与领域还没有带最终译文的完成或复核轨迹";
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
  if (view === "tasks") loadTasks().catch((error) => toast(error.message));
  if (view === "styles") loadStyleGuidance(state.styleLocale).catch((error) => toast(error.message));
  if (view === "workbench") setTranslationMode(state.translationMode);
  if (view === "learning") loadLearning(state.learningLocale);
  if (view === "autoqa") updateAutoQaLocale(state.autoQaLocale);
  if (view === "feedback") loadFeedbackPage().catch((error) => toast(error.message));
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
  $("#targetOutput").contentEditable = "false";
  $("#toggleTargetEdit").hidden = true;
  $("#acceptTranslation").disabled = true;
  $("#targetLegend").hidden = true;
  $("#termMatches").textContent = "尚未匹配";
  $("#termMatches").className = "term-matches empty-list";
  $("#qaList").textContent = "翻译后显示相似译例、评分与修订结果";
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
  $("#issueCount").textContent = result.aiQa?.fallbackReason ? "AIQA 未完成" : Number.isFinite(result.qaScore) ? `AIQA ${result.qaScore} 分 · ${result.aiQa?.iterations || 0} 次修订` : errors.length ? `${errors.length} 个阻断项` : result.issues.length ? `${result.issues.length} 条建议` : "硬校验通过";
  const reflection = result.reflection ? `<div class="reflection-box"><strong>模型反思</strong>\n${escapeHtml(result.reflection)}</div>` : "";
  const retrieval = result.aiQa?.references?.length ? `<div class="reflection-box"><strong>相似译例检索</strong>\n${result.aiQa.references.map((item) => `${Math.round(item.similarity * 100)}% · ${item.source} → ${item.target}`).map(escapeHtml).join("\n")}</div>` : "";
  const qaCases = result.aiQa?.qaCases?.length ? `<div class="reflection-box"><strong>历史 AIQA 反例</strong>\n${result.aiQa.qaCases.map((item) => `${Math.round(item.similarity * 100)}% · ${item.rejectedTranslation} → ${item.correctedTranslation}`).map(escapeHtml).join("\n")}</div>` : "";
  const issues = result.issues.map((issue, index) => `<div class="qa-item ${issue.severity}"><div>${escapeHtml(issue.message)}</div><div class="qa-decision-actions"><button class="button ghost small single-qa-action" data-action="revise" data-issue-index="${index}">让 AI 按建议修订</button>${issue.severity !== "error" || issue.mqmSeverity === "minor" ? `<button class="button ghost small single-qa-action" data-action="approve" data-issue-index="${index}">批准当前译文</button>` : ""}</div></div>`).join("");
  const humanDecisions = result.aiQa?.humanDecisions?.length ? `<div class="reflection-box"><strong>人工 QA 决定</strong>\n${result.aiQa.humanDecisions.map((item) => `${item.decision === "approved_as_is" ? "已批准当前译文" : "已要求 AI 修订"} · ${item.issue?.message || "QA 意见"}`).map(escapeHtml).join("\n")}</div>` : "";
  $("#qaList").className = "qa-list";
  const fallback = result.aiQa?.fallbackReason ? `<div class="qa-item warning">AIQA 暂未完成：${escapeHtml(result.aiQa.fallbackReason)}</div>` : "";
  $("#qaList").innerHTML = `${reflection}${retrieval}${qaCases}${humanDecisions}${fallback}${issues || (!fallback ? '<div class="qa-item">硬规则与检索式 AIQA 均通过</div>' : '')}`;
  $$(".single-qa-action").forEach((button) => button.addEventListener("click", () => resolveSingleQaIssue(Number(button.dataset.issueIndex), button.dataset.action, button)));
}

const AUTO_QA_DIMENSIONS = [
  ["basic", "基本检查", "语言正确性专项（拼写/语法/标点，模型）+ 品牌名、格式与句内一致性（本地规则）"],
  ["fidelity", "语义忠实性", "漏译、增译、错译与语义偏差，着重检查项"],
  ["nuance", "Nuance 一致性", "敬语级别、语气词、正式度与句式节奏的细微差异"]
];

function updateAutoQaLocale(locale) {
  state.autoQaLocale = locale;
  renderLocaleStrip($("#autoQaLocales"), locale, updateAutoQaLocale);
  const details = state.bootstrap.locales[locale];
  $("#autoQaTargetKicker").textContent = `TARGET · ${locale.toUpperCase()}`;
  $("#autoQaTargetTitle").textContent = `${details.label}译文`;
  $("#autoQaState").textContent = "等待质检";
  $("#autoQaState").className = "badge neutral";
  $("#autoQaReport").hidden = true;
  refreshActions();
}

function clearAutoQa() {
  $("#autoQaSource").value = "";
  $("#autoQaTarget").value = "";
  $("#autoQaSourceCount").textContent = "0 字";
  $("#autoQaState").textContent = "等待质检";
  $("#autoQaState").className = "badge neutral";
  $("#autoQaReport").hidden = true;
  refreshActions();
}

async function runAutoQa() {
  const source = $("#autoQaSource").value.trim();
  const translation = $("#autoQaTarget").value.trim();
  if (!source || !translation) {
    toast("请同时填写中文原文与译文");
    return;
  }
  setBusy(true, "Auto QA 质检中…");
  $("#autoQaState").textContent = "质检中…";
  $("#autoQaState").className = "badge warning";
  try {
    const payload = await api("/api/auto-qa", {
      method: "POST",
      body: JSON.stringify({
        source, translation,
        locale: state.autoQaLocale,
        contentType: $("#autoQaContentType").value,
        domain: $("#autoQaDomain").value
      })
    });
    renderAutoQaReport(payload);
    toast(`质检完成：${payload.scores.overall} 分 · 已保存到任务中心`);
  } catch (error) {
    $("#autoQaState").textContent = "质检失败";
    $("#autoQaState").className = "badge error";
    toast(error.message);
  } finally {
    setBusy(false);
  }
}

function autoQaScoreTone(score) {
  return score >= 90 ? "good" : score >= 70 ? "warn" : "bad";
}

function renderAutoQaReport(payload) {
  const { scores, summary, segments = [], alignmentIssues = [], alignmentNote, tagsStripped, segmentCounts, fallbackReason, references, qaCases, classification, styleProfile } = payload;
  const scoreCard = (score, label, caption, tone) => `
    <div class="autoqa-score-card ${tone}"><strong>${score}</strong><span>${escapeHtml(label)}</span><small>${escapeHtml(caption)}</small></div>`;
  $("#autoQaScores").innerHTML =
    scoreCard(scores.overall, "综合分", "基本 20% · 忠实性 50% · Nuance 30%", "overall")
    + AUTO_QA_DIMENSIONS.map(([dimension, label]) => {
      const value = scores.dimensions[dimension];
      const stats = summary[dimension] || {};
      const counts = stats.total
        ? `${stats.total} 条问题 · 阻断 ${stats.error} · 主要 ${stats.major} · 轻微 ${stats.minor}`
        : "未发现问题";
      return scoreCard(value, label, counts, autoQaScoreTone(value));
    }).join("");

  const evidenceLines = [];
  if (styleProfile?.name) evidenceLines.push(`风格规范：${styleProfile.name} v${styleProfile.version || 1}`);
  if (references?.length) evidenceLines.push(`已批准译例 ${references.length} 条`);
  if (qaCases?.length) evidenceLines.push(`历史 QA 反例 ${qaCases.length} 条`);
  if (classification?.contentType) evidenceLines.push(`识别语体：${classification.contentType}`);
  const evidenceBox = evidenceLines.length
    ? `<div class="reflection-box"><strong>Nuance 对照证据</strong>\n${escapeHtml(evidenceLines.join("\n"))}</div>`
    : "";
  const notes = [];
  if (tagsStripped) notes.push("输入含 HTML 标签，已剥离后分析。");
  if (alignmentNote) notes.push(alignmentNote);
  const noteBox = notes.length ? `<div class="reflection-box"><strong>逐句对齐说明</strong>\n${escapeHtml(notes.join("\n"))}</div>` : "";
  const fallback = fallbackReason
    ? `<div class="qa-item error">部分句子模型层质检未完成：${escapeHtml(fallbackReason)}</div>`
    : "";
  const alignmentBlock = alignmentIssues.length
    ? `<section class="autoqa-dimension">
        <div class="autoqa-dimension-head"><div><span class="card-kicker">SENTENCE ALIGNMENT</span><h3>整句级问题</h3><small>按语义向量逐句对齐时发现的疑似漏译 / 增译</small></div><span class="asset-count">${alignmentIssues.length} 条</span></div>
        ${alignmentIssues.map(renderAutoQaIssue).join("")}
      </section>`
    : "";
  const openByDefault = segments.length <= 6;
  const segmentCards = segments.map((segment, index) => renderAutoQaSegment(segment, openByDefault || index < 2)).join("");
  $("#autoQaIssues").innerHTML = `
    ${evidenceBox}${noteBox}${fallback}${alignmentBlock}
    <section class="autoqa-dimension">
      <div class="autoqa-dimension-head"><div><span class="card-kicker">PER-SENTENCE CHECKS</span><h3>逐句检查</h3><small>原文 ${segmentCounts?.source ?? segments.length} 句 / 译文 ${segmentCounts?.translation ?? segments.length} 句，每一句按三个维度独立审查</small></div><span class="asset-count subtle">${segments.length} 组</span></div>
      ${segmentCards || `<div class="qa-item warning">未能配对任何句子，请检查输入内容。</div>`}
    </section>`;
  $("#autoQaReport").hidden = false;

  const overall = scores.overall;
  $("#autoQaState").textContent = fallbackReason ? "部分模型检查失败" : `${overall} 分`;
  $("#autoQaState").className = `badge ${overall >= 90 ? "success" : overall >= 70 ? "warning" : "error"}`;
}

function renderAutoQaSegment(segment, open) {
  const { index, sourceIndices, translationIndices, source, translation, issues, scores, fallbackReason: segmentFallback } = segment;
  const metrics = AUTO_QA_DIMENSIONS.map(([dimension, label]) =>
    `<span class="autoqa-segment-metric ${autoQaScoreTone(scores.dimensions[dimension])}"><i>${scores.dimensions[dimension]}</i>${label}</span>`).join("");
  const sourceLabel = sourceIndices.length > 1 ? `原文第 ${sourceIndices.join("、")} 句合并` : `原文第 ${sourceIndices[0] || index} 句`;
  const translationLabel = translationIndices.length > 1 ? `译文第 ${translationIndices.join("、")} 句合并` : `译文第 ${translationIndices[0] || index} 句`;
  const segmentFailure = segmentFallback ? `<div class="qa-item warning">本组模型检查失败：${escapeHtml(segmentFallback)}，仅展示本地基本检查。</div>` : "";
  const body = `<div class="autoqa-segment-body">
      <div class="autoqa-segment-pair">
        <div><span>${escapeHtml(sourceLabel)}</span><p>${escapeHtml(source)}</p></div>
        <div><span>${escapeHtml(translationLabel)}</span><p>${escapeHtml(translation)}</p></div>
      </div>
      ${segmentFailure}
      ${issues.length ? issues.map(renderAutoQaIssue).join("") : `<div class="qa-item">本句三层检查通过</div>`}
    </div>`;
  return `<details class="autoqa-segment"${open ? " open" : ""}>
    <summary>
      <span class="autoqa-segment-index">#${index}</span>
      <span class="autoqa-segment-score ${autoQaScoreTone(scores.overall)}">${scores.overall}</span>
      ${metrics}
      <span class="autoqa-segment-text">${escapeHtml(source.length > 42 ? `${source.slice(0, 42)}…` : source)}</span>
    </summary>
    ${body}
  </details>`;
}

function renderAutoQaIssue(issue) {
  const severityLabel = issue.severity === "critical" || issue.severity === "error" ? "阻断"
    : issue.severity === "major" ? "主要" : "轻微";
  const spans = issue.sourceSpan || issue.targetSpan
    ? `<div class="autoqa-span-pair">${issue.sourceSpan ? `<span>原文「${escapeHtml(issue.sourceSpan)}」</span>` : ""}${issue.targetSpan ? `<span>译文「${escapeHtml(issue.targetSpan)}」</span>` : ""}</div>`
    : "";
  const suggestion = issue.suggestion ? `<small class="autoqa-suggestion">建议：${escapeHtml(issue.suggestion)}</small>` : "";
  const confidence = Number.isFinite(Number(issue.confidence))
    ? `<span class="autoqa-confidence">置信 ${Math.round(Number(issue.confidence) * 100)}%</span>`
    : "";
  return `<div class="autoqa-issue ${issue.severity}">
    <div class="autoqa-issue-head"><span class="autoqa-category">${escapeHtml(issue.category || "other")}</span><span class="autoqa-severity ${issue.severity}">${severityLabel}</span>${confidence}</div>
    <p>${escapeHtml(issue.message)}</p>${spans}${suggestion}
  </div>`;
}

function compactQaReferences(aiQa = {}) {
  return [...(aiQa.references || []), ...(aiQa.qaCases || []).map((item) => ({ ...item, kind: "qa_case" }))]
    .slice(0, 12)
    .map(({ embedding, ...item }) => item);
}

function qaResolutionBody({ source, translation, result, action, issueIndex, contentType, domain, batchId }) {
  return {
    source, translation, action, issueIndex,
    issues: result.issues || [], qaScore: result.qaScore,
    locale: state.workbenchLocale, contentType, domain, batchId,
    trajectoryId: result.trajectoryId || result.trajectory_id || "",
    iterations: result.aiQa?.iterations || 0,
    references: compactQaReferences(result.aiQa),
    termDecisions: result.aiQa?.termDecisions || [],
    humanDecisions: result.aiQa?.humanDecisions || []
  };
}

async function resolveSingleQaIssue(issueIndex, action, button) {
  const result = state.lastResult;
  if (!result?.issues?.[issueIndex]) return;
  if (action === "approve" && !confirm("确认批准当前译文并豁免这一条 QA 建议？该决定会写入审核记录。")) return;
  button.disabled = true;
  button.textContent = action === "revise" ? "AI 修订中…" : "批准中…";
  try {
    const resolved = await api("/api/qa/resolve", { method: "POST", body: JSON.stringify(qaResolutionBody({
      source: $("#sourceText").value.trim(), translation: result.translation, result, action, issueIndex,
      contentType: result.classification?.contentType || "general", domain: $("#domain").value, batchId: "single-review"
    })) });
    state.lastResult = { ...result, ...resolved, translation: resolved.translation, issues: resolved.issues, qaScore: resolved.qaScore, aiQa: resolved.aiQa };
    renderTranslationOutput();
    renderQa(state.lastResult);
    setResultStatus(state.lastResult.issues, state.lastResult.aiQa);
    toast(action === "revise" ? `AI 已按建议修订并重新 QA：${resolved.qaScore} 分` : "已批准当前译文，该建议已从待处理项移除");
  } catch (error) {
    button.disabled = false;
    button.textContent = action === "revise" ? "让 AI 按建议修订" : "批准当前译文";
    toast(error.message);
  }
}

function setResultStatus(issues = [], aiQa = null) {
  if (aiQa?.fallbackReason) return setTranslationStatus("warning", "AIQA 未完成");
  if (Number.isFinite(aiQa?.score) && aiQa.score < 90) return setTranslationStatus("error", "AIQA 待复核");
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
  const editable = $("#targetOutput").isContentEditable;
  if (editable) {
    $("#targetOutput").textContent = result.translation;
  }
  $("#toggleTargetEdit").hidden = false;
  $("#toggleTargetEdit").textContent = editable ? "完成编辑" : "编辑译文";
  $("#acceptTranslation").disabled = !result.translation;
}

function toggleTargetEdit() {
  const output = $("#targetOutput");
  const editable = output.isContentEditable;
  output.contentEditable = String(!editable);
  if (!editable) {
    output.textContent = state.lastResult.translation;
    $("#toggleTargetEdit").textContent = "完成编辑";
  } else {
    state.lastResult.translation = output.textContent.trim();
    renderTranslationOutput();
  }
}

async function acceptSingleTranslation() {
  if (!state.lastResult) return;
  const output = $("#targetOutput");
  const translation = output.isContentEditable ? output.textContent.trim() : state.lastResult.translation;
  if (!translation) return toast("没有可采纳的译文");
  if (output.isContentEditable) state.lastResult.translation = translation;
  setBusy(true, "采纳中…");
  try {
    const result = await api("/api/feedback/accept", { method: "POST", body: JSON.stringify({
      source: $("#sourceText").value.trim(),
      translation,
      locale: state.workbenchLocale,
      contentType: state.lastResult.classification.contentType,
      domain: $("#domain").value,
      styleProfileId: state.lastResult.styleProfile?.id || "",
      qaCaseId: state.lastResult.aiQa?.qaCases?.[0]?.id || "",
      trajectoryId: state.lastResult.trajectoryId || state.lastResult.trajectory_id || ""
    }) });
    if (output.isContentEditable) toggleTargetEdit();
    toast(`已采纳为正式译法${result.demoted ? `，${result.demoted} 条旧机器译文已降权` : ""}，并沉淀为风格证据`);
  } catch (error) { toast(error.message); }
  finally { setBusy(false); }
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
      domain: $("#domain").value,
      aiQa: true
    }) });
    state.lastResult.translation = qa.translation;
    state.lastResult.matches = qa.matches;
    state.lastResult.issues = qa.issues;
    state.lastResult.qaScore = qa.qaScore;
    state.lastResult.aiQa = qa.aiQa;
  } catch (error) { toast(`替换成功，但 QA 刷新失败：${error.message}`); }
  renderTranslationOutput();
  renderMatches(state.lastResult.matches);
  renderQa(state.lastResult);
  setResultStatus(state.lastResult.issues, state.lastResult.aiQa);
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
    setResultStatus(result.issues, result.aiQa);
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

async function loadPastedTextAsBatch(value) {
  if (!shouldRoutePasteToBatch(value)) return false;
  if (state.batchRunning) {
    toast("当前批次仍在翻译，请暂停或完成后再粘贴新内容");
    return false;
  }
  const pasted = normalizePastedText(value);
  state.batchFile = null;
  state.batchBase64 = "";
  state.batchPreview = null;
  state.batchClassification = null;
  state.batchStyleProfile = null;
  localStorage.removeItem("kami-batch-id");
  $("#batchFile").value = "";
  $("#batchPasteText").value = pasted;
  $("#batchFilePrompt").textContent = "已载入粘贴文本";
  $("#batchFileMeta").textContent = `${[...pasted].length} 字 · 正在自动分句`;
  $("#batchDropZone").classList.add("has-file");
  $("#batchSourceMeta").textContent = "正在解析";
  setTranslationMode("batch");
  renderBatchSegments();
  refreshActions();
  await prepareBatch();
  return true;
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
  localStorage.removeItem("kami-batch-id");
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
    if (segment.result?.aiQa?.fallbackReason) {
      const reason = String(segment.result.aiQa.fallbackReason).replace(/\s+/g, " ").slice(0, 90);
      return ["warning", "AIQA 未完成", reason || "需要重试或人工复核"];
    }
    if (Number.isFinite(segment.result?.qaScore) && segment.result.qaScore < 90) return ["warning", "需要复核", `AIQA ${segment.result.qaScore} 分`];
    const errors = issues.filter((issue) => issue.severity === "error").length;
    if (errors) return ["warning", "需要复核", `${errors} 个阻断项`];
    if (issues.length) return ["warning", "建议确认", `${issues.length} 条建议`];
    return ["success", "QA 通过", `${Number.isFinite(segment.result?.qaScore) ? `${segment.result.qaScore} 分 · ` : ""}${segment.result?.matches?.length || 0} 条术语`];
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

function renderBatchTarget(segment) {
  const running = segment.status === "running";
  const rendered = segment.result && segment.translation
    ? renderTranslationMarkup(segment.translation, segment.result.matches || [], [])
    : { html: escapeHtml(segment.translation || ""), officialCount: 0 };
  const placeholder = running ? "正在翻译…" : "译文将在这里显示";
  return `<div class="batch-segment-target${running ? " disabled" : ""}" data-id="${escapeHtml(segment.id)}" data-placeholder="${placeholder}" role="textbox" aria-label="第 ${segment.index} 段译文" aria-multiline="true" contenteditable="${running ? "false" : "true"}">${rendered.html}</div>${rendered.officialCount ? `<div class="batch-term-legend"><i></i>${rendered.officialCount} 处正式术语</div>` : ""}`;
}

function batchIssueHtml(issue, index, segmentId) {
  const severity = issue.mqmSeverity || issue.severity || "warning";
  const label = severity === "critical" ? "严重" : severity === "major" || severity === "error" ? "主要" : "次要";
  const spans = [issue.sourceSpan ? `原文：${issue.sourceSpan}` : "", issue.targetSpan ? `译文：${issue.targetSpan}` : ""].filter(Boolean).join(" · ");
  const approve = issue.severity !== "error" || issue.mqmSeverity === "minor" ? `<button class="button ghost small batch-qa-action" data-action="approve" data-id="${escapeHtml(segmentId)}" data-issue-index="${index}">批准当前译文</button>` : "";
  return `<div class="batch-qa-issue ${escapeHtml(severity)}"><strong>${label} · ${escapeHtml(issue.category || issue.type || "QA")}</strong><p>${escapeHtml(issue.message || "未说明问题")}</p>${issue.suggestion ? `<p class="suggestion">建议：${escapeHtml(issue.suggestion)}</p>` : ""}${spans ? `<small>${escapeHtml(spans)}</small>` : ""}<div class="qa-decision-actions"><button class="button ghost small batch-qa-action" data-action="revise" data-id="${escapeHtml(segmentId)}" data-issue-index="${index}">让 AI 按建议修订</button>${approve}</div></div>`;
}

function renderBatchDetails(segment) {
  const result = segment.result;
  if (segment.status !== "done" || !result) return "";
  const aiQa = result.aiQa || {};
  const matches = result.matches || [];
  const issues = result.issues || [];
  const references = aiQa.references || [];
  const qaCases = aiQa.qaCases || [];
  const termDecisions = aiQa.termDecisions || [];
  const humanDecisions = aiQa.humanDecisions || [];
  const summary = [
    Number.isFinite(result.qaScore) ? `AIQA ${result.qaScore} 分` : "规则 QA",
    `${matches.length} 条术语`,
    `${references.length} 条译例`,
    `${aiQa.iterations || 0} 次修订`,
    issues.length ? `${issues.length} 条建议` : "无问题"
  ].join(" · ");
  const termsHtml = matches.length ? matches.map((match) => `<div class="batch-detail-item"><strong>${escapeHtml(match.term?.source)} → ${escapeHtml(match.term?.target)}</strong><small>${match.mode === "exact" ? "正式/别名命中" : `疑似命中：${escapeHtml(match.matchPhrase || "")}`} · ${Math.round((match.score || 0) * 100)}%</small></div>`).join("") : '<div class="batch-detail-empty">本段没有命中术语</div>';
  const issuesHtml = issues.length ? issues.map((issue, index) => batchIssueHtml(issue, index, segment.id)).join("") : `<div class="batch-detail-empty">${aiQa.fallbackReason ? "硬规则通过；AIQA 尚待重试" : "硬规则与 AIQA 均未发现问题"}</div>`;
  const referencesHtml = references.length ? references.map((item) => `<div class="batch-memory-item"><div><strong>${Math.round((item.similarity || 0) * 100)}% · ${escapeHtml(item.qualityStatus === "human_approved" ? "人工批准" : "机器验证")}</strong><p>${escapeHtml(item.source)}</p><p class="target">${escapeHtml(item.target)}</p></div></div>`).join("") : '<div class="batch-detail-empty">没有召回可用的相似译例</div>';
  const qaCasesHtml = qaCases.length ? `<section><h5>历史 AIQA 反例</h5>${qaCases.map((item) => `<div class="batch-memory-item"><div><p>${escapeHtml(item.rejectedTranslation || "")}</p><p class="target">修订：${escapeHtml(item.correctedTranslation || "")}</p></div></div>`).join("")}</section>` : "";
  const decisionsHtml = termDecisions.length ? `<section><h5>AI 术语裁决</h5>${termDecisions.map((item) => `<div class="batch-detail-item"><strong>${item.decision === "apply" ? "已采用" : "不强制替换"} · ${escapeHtml(item.matchedSource)} → ${escapeHtml(item.officialTarget)}</strong><small>${escapeHtml(item.reason)}</small></div>`).join("")}</section>` : "";
  const humanDecisionsHtml = humanDecisions.length ? `<section><h5>人工 QA 决定</h5>${humanDecisions.map((item) => `<div class="batch-detail-item"><strong>${item.decision === "approved_as_is" ? "已批准当前译文" : "已要求 AI 修订"}</strong><small>${escapeHtml(item.issue?.message || item.reason || "QA 意见")}</small></div>`).join("")}</section>` : "";
  const fallback = aiQa.fallbackReason ? `<div class="batch-qa-fallback"><strong>AIQA 未完成</strong><span>${escapeHtml(aiQa.fallbackReason)}</span><button type="button" class="button ghost small retry-segment-qa" data-id="${escapeHtml(segment.id)}">仅重跑本段 QA</button></div>` : "";
  return `<details class="batch-segment-details${aiQa.fallbackReason ? " has-warning" : ""}">
    <summary>${escapeHtml(summary)}<span>查看术语、译例与 QA 意见</span></summary>
    ${fallback}
    <div class="batch-detail-grid">
      <section><h5>术语命中</h5>${termsHtml}</section>
      <section><h5>QA 意见</h5>${issuesHtml}</section>
      <section><h5>相似译例检索</h5>${referencesHtml}</section>
      ${qaCasesHtml}
      ${decisionsHtml}
      ${humanDecisionsHtml}
    </div>
  </details>`;
}

function renderBatchSegments() {
  const container = $("#batchSegments");
  const segments = state.batchPreview?.segments || [];
  if (!segments.length) {
    container.innerHTML = '<div class="empty-list batch-empty">粘贴文本或拖入文件后，会自动识别正文并生成分句队列。</div>';
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
    const acceptEnabled = segment.status === "done" && segment.translation && !segment.accepted;
    return `<div class="batch-segment ${segment.status === "running" ? "is-running" : ""} ${segment.status === "error" ? "has-error" : ""}" data-segment-id="${segment.id}">
      <div class="batch-segment-index"><input class="batch-segment-check" data-id="${segment.id}" type="checkbox" ${segment.selected ? "checked" : ""} ${state.batchRunning ? "disabled" : ""} aria-label="选择第 ${segment.index} 段" /><span class="row-ref">${segment.index}</span></div>
      <div class="batch-segment-source"><div class="segment-source-text">${escapeHtml(segment.source)}</div>${segment.context?.metadata?.length || segment.context?.referenceTranslations?.length ? `<div class="segment-context">${(segment.context.metadata || []).map((item) => `<span class="${item.role === "constraint" ? "constraint" : ""}" title="${escapeHtml(item.value)}">${escapeHtml(item.label)}：${escapeHtml(item.value)}</span>`).join("")}${(segment.context.referenceTranslations || []).map((item) => `<span class="reference" title="${escapeHtml(item.value)}">参考 · ${escapeHtml(item.label)}：${escapeHtml(item.value)}</span>`).join("")}</div>` : ""}</div>
      <div class="batch-target-cell">${renderBatchTarget(segment)}</div>
      <div class="segment-status ${className}"><strong>${segment.accepted ? "已采纳" : label}</strong><small>${escapeHtml(meta)}</small>${acceptEnabled ? `<button class="button ghost small accept-segment" data-id="${segment.id}">采纳</button>` : ""}</div>
      ${renderBatchDetails(segment)}
    </div>`;
  }).join("");
  $("#acceptAllSegments").hidden = !segments.some((segment) => segment.status === "done" && segment.translation && !segment.accepted);
  $$(".batch-segment-check").forEach((checkbox) => checkbox.addEventListener("change", () => {
    const segment = segments.find((item) => item.id === checkbox.dataset.id);
    if (segment) segment.selected = checkbox.checked;
    renderBatchSegments();
    refreshActions();
    saveBatchProgress();
  }));
  $$(".batch-segment-target[contenteditable='true']").forEach((target) => {
    target.addEventListener("input", () => {
      const segment = segments.find((item) => item.id === target.dataset.id);
      if (!segment) return;
      segment.translation = target.innerText.replace(/\n+$/u, "").trim();
      segment.accepted = false;
    });
    target.addEventListener("blur", () => {
      const segment = segments.find((item) => item.id === target.dataset.id);
      if (!segment) return;
      segment.translation = target.innerText.replace(/\n+$/u, "").trim();
      if (segment.translation) {
        segment.status = "done";
        segment.result = segment.result || { issues: [], matches: [] };
        segment.result.translation = segment.translation;
      }
      segment.accepted = false;
      renderBatchSegments();
      refreshActions();
      saveBatchProgress();
    });
  });
  $$(".accept-segment").forEach((button) => button.addEventListener("click", () => acceptSegment(button.dataset.id)));
  $$(".retry-segment-qa").forEach((button) => button.addEventListener("click", () => retrySegmentQa(button.dataset.id)));
  $$(".batch-qa-action").forEach((button) => button.addEventListener("click", () => resolveBatchQaIssue(button.dataset.id, Number(button.dataset.issueIndex), button.dataset.action, button)));
}

async function resolveBatchQaIssue(segmentId, issueIndex, action, button) {
  const segment = state.batchPreview?.segments.find((item) => item.id === segmentId);
  if (!segment?.result?.issues?.[issueIndex]) return;
  if (action === "approve" && !confirm("确认批准当前译文并豁免这一条 QA 建议？该决定会写入审核记录。")) return;
  button.disabled = true;
  button.textContent = action === "revise" ? "AI 修订中…" : "批准中…";
  try {
    const resolved = await api("/api/qa/resolve", { method: "POST", body: JSON.stringify(qaResolutionBody({
      source: segment.source, translation: segment.translation, result: segment.result, action, issueIndex,
      contentType: state.batchClassification?.contentType || "general", domain: $("#domain").value,
      batchId: state.batchPreview.batchId || "batch-review"
    })) });
    segment.translation = resolved.translation || segment.translation;
    segment.result = { ...segment.result, ...resolved, translation: segment.translation, issues: resolved.issues, qaScore: resolved.qaScore, aiQa: resolved.aiQa };
    segment.status = "done";
    segment.accepted = false;
    await saveBatchProgress();
    renderBatchSegments();
    toast(action === "revise" ? `第 ${segment.index} 段已由 AI 修订并重新 QA：${resolved.qaScore} 分` : `第 ${segment.index} 段已批准当前译文`);
  } catch (error) {
    button.disabled = false;
    button.textContent = action === "revise" ? "让 AI 按建议修订" : "批准当前译文";
    toast(error.message);
  }
}

async function retrySegmentQa(segmentId) {
  const segment = state.batchPreview?.segments.find((item) => item.id === segmentId);
  if (!segment?.translation) return;
  const button = document.querySelector(`.retry-segment-qa[data-id="${CSS.escape(segmentId)}"]`);
  if (button) { button.disabled = true; button.textContent = "AIQA 重试中…"; }
  try {
    const qa = await api("/api/qa", { method: "POST", body: JSON.stringify({
      source: segment.source,
      translation: segment.translation,
      locale: state.workbenchLocale,
      contentType: state.batchClassification?.contentType || "general",
      domain: $("#domain").value,
      batchId: state.batchPreview.batchId || "manual-recheck",
      aiQa: true
    }) });
    segment.translation = qa.translation || segment.translation;
    segment.result = {
      ...(segment.result || {}),
      translation: segment.translation,
      matches: qa.matches || segment.result?.matches || [],
      issues: qa.issues || [],
      qaScore: qa.qaScore,
      aiQa: qa.aiQa,
      styleProfile: qa.styleProfile || segment.result?.styleProfile || null
    };
    segment.status = "done";
    segment.accepted = false;
    await saveBatchProgress();
    renderBatchSegments();
    toast(qa.aiQa?.fallbackReason ? `AIQA 仍未完成：${qa.aiQa.fallbackReason}` : `本段 AIQA 已完成：${qa.qaScore} 分`);
  } catch (error) {
    if (button) { button.disabled = false; button.textContent = "仅重跑本段 QA"; }
    toast(`AIQA 重试失败：${error.message}`);
  }
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
    prepared.segments.forEach((segment) => Object.assign(segment, { selected: true, status: "pending", translation: "", result: null, error: "", accepted: false }));
    state.batchPreview = prepared;
    state.batchClassification = null;
    state.batchStyleProfile = null;
    localStorage.setItem("kami-batch-id", prepared.batchId || "");
    await saveBatchProgress();
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
      // 本批已定稿译文作为风格锚点：后续各行严格仿照同一句式与用词。
      const batchReferences = segments.slice(0, position).filter((item) => item.translation).slice(-3).map((item) => ({ source: item.source, target: item.translation }));
      const result = await api("/api/translate", { method: "POST", body: JSON.stringify({
        source: segment.source,
        locale: state.workbenchLocale,
        contentType: state.batchClassification.contentType,
        domain: $("#domain").value,
        neighborContext: context,
        styleProfile: state.batchStyleProfile,
        batchId: state.batchPreview.batchId || state.batchPreview.filename,
        segmentId: segment.id,
        batchReferences,
        reflect: $("#reflect").checked,
        useModelClassification: false
      }) });
      if (result.styleProfile?.source === "style-library") state.batchStyleProfile = result.styleProfile;
      segment.translation = result.translation;
      segment.result = result;
      segment.status = "done";
      segment.accepted = false;
    } catch (error) {
      segment.status = "error";
      segment.error = error.message;
    }
    renderBatchSegments();
    saveBatchProgress();
  }
  state.batchRunning = false;
  const paused = state.batchPaused;
  state.batchPaused = false;
  renderBatchSegments();
  refreshActions();
  await saveBatchProgress();
  if (!paused && segments.some((segment) => segment.status === "done")) {
    try {
      const review = await api("/api/evolution/review", { method: "POST", body: JSON.stringify({
        locale: state.workbenchLocale,
        contentType: state.batchClassification?.contentType || "general",
        domain: $("#domain").value,
        batchId: state.batchPreview.batchId || ""
      }) });
      const parts = [];
      if (review.distilled) parts.push(`已生成风格规范草稿 v${review.distilled.version}`);
      else if (review.distillPending) parts.push(`风格证据 ${review.distillPending.evidenceCount}/${review.distillPending.threshold}`);
      if (review.profile) parts.push(`已生成译者画像草稿 v${review.profile.version}`);
      else if (review.profilePending) parts.push(`画像证据 ${review.profilePending.acceptedCount}/${review.profilePending.threshold}`);
      if (review.review?.trend?.length) parts.push(`复盘发现 ${review.review.trend.length} 类问题趋势`);
      toast(parts.length ? `任务后复盘完成：${parts.join("；")}` : "任务后复盘完成，暂无新的风格发现");
    } catch {}
  }
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

function taskStatusLabel(status) {
  return { in_progress: "进行中", review: "QA 待处理", needs_attention: "存在失败", completed: "已完成" }[status] || "待处理";
}

function formatTaskTime(value) {
  if (!value) return "时间未知";
  try { return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value)); }
  catch { return String(value); }
}

async function loadTasks() {
  const query = new URLSearchParams();
  if ($("#taskType")?.value) query.set("type", $("#taskType").value);
  if ($("#taskLocale")?.value) query.set("locale", $("#taskLocale").value);
  if ($("#taskStatus")?.value) query.set("status", $("#taskStatus").value);
  if ($("#taskSearch")?.value.trim()) query.set("search", $("#taskSearch").value.trim());
  state.tasks = await api(`/api/tasks?${query}`);
  renderTasks();
}

function renderTasks() {
  const tasks = state.tasks || [];
  $("#taskCount").textContent = `${tasks.length} 个任务`;
  const completed = tasks.filter((item) => item.status === "completed").length;
  const review = tasks.filter((item) => item.status === "review" || item.status === "needs_attention").length;
  const pending = tasks.filter((item) => item.status === "in_progress").length;
  const unitCount = tasks.reduce((sum, item) => sum + (item.totalSegments || 0), 0);
  $("#taskSummary").innerHTML = `<span>进行中 ${pending}</span><span>待处理 QA ${review}</span><span>已完成 ${completed}</span><span>共 ${tasks.length} 个任务 · ${unitCount} 个翻译单元</span>`;
  $("#taskList").innerHTML = tasks.length ? tasks.map((task) => task.type === "autoqa" ? renderQaTaskRow(task) : renderBatchTaskRow(task)).join("") : '<div class="empty-list task-empty">没有符合当前筛选条件的历史任务</div>';
  $$(".task-row [data-action]").forEach((button) => button.addEventListener("click", () => {
    const id = button.closest(".task-row").dataset.taskId;
    const action = button.dataset.action;
    if (action === "open-task") openTask(id);
    else if (action === "export-task") exportTaskExcel(id, button);
    else if (action === "share-task") createBatchShare(id, button);
    else if (action === "share-qa-task") createQaTaskShare(id, button);
    else if (action === "feedback-task") openShareFeedbackDialog({ batchId: id });
    else if (action === "feedback-qa-task") openShareFeedbackDialog({ qaTaskId: id });
    else if (action === "open-qa-task") openQaTask(id);
    else if (action === "delete-qa-task") deleteQaTaskRow(id, button);
  }));
}

function renderBatchTaskRow(task) {
  const locale = state.bootstrap.locales[task.locale];
  const progress = task.totalSegments ? Math.round(task.completedSegments / task.totalSegments * 100) : 0;
  return `<article class="task-row" data-task-id="${escapeHtml(task.batchId)}">
    <div class="task-main"><div class="task-title"><strong>${escapeHtml(task.filename)}</strong><span class="task-status ${escapeHtml(task.status)}">${taskStatusLabel(task.status)}</span><span class="task-type-chip">批次</span></div><small>${escapeHtml(locale?.label || task.locale)} · ${escapeHtml(contentTypeLabel(task.contentType))} · ${escapeHtml(task.domain)} · ${formatTaskTime(task.updatedAt)}</small></div>
    <div class="task-progress"><div><i style="width:${progress}%"></i></div><span>${task.completedSegments} / ${task.totalSegments}</span></div>
    <div class="task-qa"><strong>${task.qaPending ? `${task.qaPending} 条待处理` : "QA 已清"}</strong>${task.failedSegments ? `<small>${task.failedSegments} 段失败</small>` : `<small>${task.format || "text"}</small>`}</div>
    <div class="task-actions"><button class="button ghost small" data-action="open-task">打开任务</button><button class="button ghost small" data-action="share-task">分享验证</button><button class="button ghost small" data-action="feedback-task">反馈</button><button class="button secondary small" data-action="export-task">导出 Excel</button></div>
  </article>`;
}

function renderQaTaskRow(task) {
  const locale = state.bootstrap.locales[task.locale];
  const scoreTone = task.overallScore == null ? "neutral" : task.overallScore >= 90 ? "success" : task.overallScore >= 70 ? "warning" : "error";
  return `<article class="task-row" data-task-id="${escapeHtml(task.id)}">
    <div class="task-main"><div class="task-title"><strong>${escapeHtml(task.title)}</strong><span class="badge ${scoreTone}">${task.overallScore == null ? "未评分" : `${task.overallScore} 分`}</span><span class="task-type-chip">Auto QA</span></div><small>${escapeHtml(locale?.label || task.locale)} · ${escapeHtml(contentTypeLabel(task.contentType))} · ${escapeHtml(task.domain)} · ${formatTaskTime(task.updatedAt)}</small></div>
    <div class="task-progress"><div><i style="width:100%"></i></div><span>${task.totalSegments} 句原文</span></div>
    <div class="task-qa"><strong>${task.qaPending ? `${task.qaPending} 个问题` : "未发现问题"}</strong><small>${escapeHtml(task.status === "review" ? "需要复核" : "已通过")}</small></div>
    <div class="task-actions"><button class="button secondary small" data-action="open-qa-task">查看报告</button><button class="button ghost small" data-action="share-qa-task">分享验证</button><button class="button ghost small" data-action="feedback-qa-task">反馈</button><button class="button ghost small" data-action="delete-qa-task">删除</button></div>
  </article>`;
}

async function openQaTask(id) {
  try {
    const payload = await api(`/api/qa-tasks/${encodeURIComponent(id)}`);
    const { task, report } = payload;
    $("#autoQaSource").value = task.sourceText || "";
    $("#autoQaTarget").value = task.translationText || "";
    $("#autoQaSourceCount").textContent = `${[...(task.sourceText || "")].length} 字`;
    state.autoQaLocale = task.locale;
    renderLocaleStrip($("#autoQaLocales"), state.autoQaLocale, updateAutoQaLocale);
    $("#autoQaTargetKicker").textContent = `TARGET · ${task.locale.toUpperCase()}`;
    $("#autoQaTargetTitle").textContent = `${state.bootstrap.locales[task.locale]?.label || task.locale}译文`;
    switchView("autoqa");
    renderAutoQaReport(report);
    toast("已回放质检报告（未重新调用模型）");
  } catch (error) { toast(error.message); }
}

async function deleteQaTaskRow(id, button) {
  if (!confirm("确认删除这条质检任务？删除后无法恢复。")) return;
  button.disabled = true;
  button.textContent = "删除中…";
  try {
    await api(`/api/qa-tasks/${encodeURIComponent(id)}`, { method: "DELETE" });
    await loadTasks();
    toast("已删除质检任务");
  } catch (error) {
    button.disabled = false;
    button.textContent = "删除";
    toast(error.message);
  }
}

async function createBatchShare(batchId, button) {
  button.disabled = true;
  button.textContent = "生成中…";
  try {
    const payload = await api(`/api/tasks/${encodeURIComponent(batchId)}/share`, { method: "POST" });
    showShareLinkDialog(payload);
  } catch (error) { toast(error.message); }
  finally { button.disabled = false; button.textContent = "分享验证"; }
}

function showShareLinkDialog(payload) {
  const primary = `${location.origin}${payload.sharePath}`;
  const urls = [...new Set([primary, ...(payload.shareUrls || [])])];
  $("#shareUrlList").innerHTML = urls.map((url) => `
    <div class="share-url-row"><input readonly value="${escapeHtml(url)}" /><button class="button ghost small share-copy" data-url="${escapeHtml(url)}">复制</button></div>`).join("");
  $("#shareGlossNote").textContent = `已为 ${payload.glossedSegments} / ${payload.totalSegments} 段生成语素拆解与直译${payload.glossedSegments < payload.totalSegments ? "（超出 30 段的部分未生成）" : ""}。`;
  $$(".share-copy").forEach((copyButton) => copyButton.addEventListener("click", async () => {
    await navigator.clipboard.writeText(copyButton.dataset.url);
    toast("链接已复制");
  }));
  $("#shareLinkDialog").showModal();
}

async function createQaTaskShare(id, button) {
  button.disabled = true;
  button.textContent = "生成中…";
  try {
    const payload = await api(`/api/qa-tasks/${encodeURIComponent(id)}/share`, { method: "POST" });
    showShareLinkDialog(payload);
  } catch (error) { toast(error.message); }
  finally { button.disabled = false; button.textContent = "分享验证"; }
}

async function openShareFeedbackDialog(scope = {}) {
  state.shareFeedbackScope = scope;
  $("#shareFeedbackDialog").showModal();
  $("#shareFeedbackList").innerHTML = '<div class="empty-list">正在读取反馈……</div>';
  try {
    const query = new URLSearchParams();
    if (scope.batchId) query.set("batchId", scope.batchId);
    if (scope.qaTaskId) query.set("qaTaskId", scope.qaTaskId);
    const shares = await api(`/api/shares?${query}`);
    const feedbacks = shares.flatMap((share) => (share.feedbacks || []).map((feedback) => ({ ...feedback, token: share.token, filename: share.filename })));
    if (!feedbacks.length) {
      $("#shareFeedbackList").innerHTML = '<div class="empty-list">该任务还没有同事反馈。生成分享链接发给同事后，反馈会出现在这里。</div>';
      return;
    }
    $("#shareFeedbackList").innerHTML = feedbacks.map((feedback) => {
      const statusLabel = feedback.status === "adopted" ? "已采纳" : feedback.status === "ignored" ? "已忽略" : "待采纳";
      const statusClass = feedback.status === "adopted" ? "success" : feedback.status === "ignored" ? "neutral" : "warning";
      return `<article class="share-feedback-item ${feedback.status}">
        <div class="share-feedback-head"><span class="badge ${statusClass}">${statusLabel}</span><strong>第 ${feedback.segmentIndex} 段</strong><small>${escapeHtml(feedback.reviewer || "匿名")} · ${formatTaskTime(feedback.createdAt)}</small></div>
        <p class="share-feedback-request">${escapeHtml(feedback.request)}</p>
        ${feedback.suggestedTranslation ? `<p class="share-feedback-suggestion">建议译法：${escapeHtml(feedback.suggestedTranslation)}</p>` : ""}
        ${feedback.status === "pending" ? `<div class="task-actions"><button class="button secondary small" data-feedback-action="adopt" data-token="${escapeHtml(feedback.token)}" data-feedback-id="${escapeHtml(feedback.id)}">采纳 → 风格证据</button><button class="button ghost small" data-feedback-action="ignore" data-token="${escapeHtml(feedback.token)}" data-feedback-id="${escapeHtml(feedback.id)}">忽略</button></div>` : ""}
      </article>`;
    }).join("");
    $$(".share-feedback-item [data-feedback-action]").forEach((button) => button.addEventListener("click", () =>
      resolveShareFeedback(button.dataset.token, button.dataset.feedbackId, button.dataset.feedbackAction, button)));
  } catch (error) {
    $("#shareFeedbackList").innerHTML = `<div class="qa-item error">读取失败：${escapeHtml(error.message)}</div>`;
  }
}

async function resolveShareFeedback(token, feedbackId, action, button) {
  if (action === "adopt" && !confirm("采纳后写入风格证据池（满 8 条会生成风格草稿），确认采纳这条意见？")) return;
  button.disabled = true;
  try {
    await api(`/api/share/${encodeURIComponent(token)}/resolve`, { method: "POST", body: JSON.stringify({ feedbackId, action }) });
    toast(action === "adopt" ? "已采纳并写入风格证据" : "已忽略该意见");
    if (state.shareFeedbackScope) await openShareFeedbackDialog(state.shareFeedbackScope);
    loadTasks().catch(() => {});
    loadPendingFeedback({ silent: true });
  } catch (error) {
    button.disabled = false;
    toast(error.message);
  }
}

// ---------- 右上角反馈铃铛 + 反馈中心整页 ----------

async function loadPendingFeedback({ silent = false } = {}) {
  try {
    const pending = await api("/api/feedback/pending");
    state.feedbackPending = Array.isArray(pending) ? pending : [];
    const count = state.feedbackPending.length;
    for (const badge of [$("#feedbackBellBadge"), $("#feedbackNavBadge")]) {
      if (!badge) continue;
      badge.textContent = count > 99 ? "99+" : String(count);
      badge.hidden = count === 0;
    }
    if (!silent && count > state.feedbackLastCount) {
      toast(`收到 ${count - state.feedbackLastCount} 条新同事反馈，点击右上角铃铛处理`);
      const bell = $("#feedbackBell");
      bell.classList.add("has-new");
      setTimeout(() => bell.classList.remove("has-new"), 2500);
    }
    state.feedbackLastCount = count;
  } catch {
    // 轮询失败保持静默，避免反复打扰
  }
}

function startFeedbackPolling() {
  loadPendingFeedback({ silent: true });
  setInterval(() => {
    if (document.visibilityState === "visible") loadPendingFeedback();
  }, 15_000);
}

async function loadFeedbackPage() {
  try {
    state.feedbackAll = await api("/api/feedback");
    renderFeedbackPage();
  } catch (error) {
    $("#feedbackPageList").innerHTML = `<div class="qa-item error">读取失败：${escapeHtml(error.message)}</div>`;
  }
}

function renderFeedbackPage() {
  const all = state.feedbackAll || [];
  const filter = state.feedbackStatusFilter;
  const list = filter === "all" ? all : all.filter((item) => item.status === filter);
  $("#feedbackPageCount").textContent = `${list.length} 条`;
  if (!list.length) {
    $("#feedbackPageList").innerHTML = filter === "pending"
      ? '<div class="empty-list">暂时没有待批准的反馈。把分享链接发给同事后，新反馈会自动出现在这里。</div>'
      : '<div class="empty-list">该状态下没有反馈。</div>';
    return;
  }
  $("#feedbackPageList").innerHTML = list.map((feedback) => {
    const statusLabel = feedback.status === "adopted" ? "已批准入风格" : feedback.status === "ignored" ? "已忽略" : "待批准";
    const statusClass = feedback.status === "adopted" ? "success" : feedback.status === "ignored" ? "neutral" : "warning";
    const locale = state.bootstrap.locales[feedback.locale];
    return `<article class="share-feedback-item ${feedback.status}">
      <div class="share-feedback-head"><span class="badge ${statusClass}">${statusLabel}</span><strong>${escapeHtml(feedback.filename)} · 第 ${feedback.segmentIndex} 段</strong><small>${escapeHtml(feedback.reviewer)} · ${formatTaskTime(feedback.createdAt)}${feedback.resolvedAt ? ` · 处理于 ${formatTaskTime(feedback.resolvedAt)}` : ""}${locale ? ` · ${escapeHtml(locale.label)}` : ""}</small></div>
      <div class="feedback-bell-pair">
        <p><span>原文</span>${escapeHtml(feedback.source)}</p>
        <p><span>当前译文</span>${escapeHtml(feedback.translation)}</p>
      </div>
      <p class="share-feedback-request"><strong>要求：</strong>${escapeHtml(feedback.request)}</p>
      ${feedback.suggestedTranslation ? `<p class="share-feedback-suggestion">建议译法：${escapeHtml(feedback.suggestedTranslation)}</p>` : ""}
      ${feedback.status === "pending" ? `<div class="task-actions"><button class="button secondary small" data-bell-action="adopt" data-token="${escapeHtml(feedback.token)}" data-feedback-id="${escapeHtml(feedback.id)}">批准入风格</button><button class="button ghost small" data-bell-action="ignore" data-token="${escapeHtml(feedback.token)}" data-feedback-id="${escapeHtml(feedback.id)}">忽略</button></div>` : ""}
    </article>`;
  }).join("");
  $$("#feedbackPageList [data-bell-action]").forEach((button) => button.addEventListener("click", () =>
    resolveFeedbackOnPage(button.dataset.token, button.dataset.feedbackId, button.dataset.bellAction, button)));
}

async function resolveFeedbackOnPage(token, feedbackId, action, button) {
  if (action === "adopt" && !confirm("批准后进入风格证据池（满 8 条会生成风格草稿），确认批准这条反馈？")) return;
  button.disabled = true;
  try {
    await api(`/api/share/${encodeURIComponent(token)}/resolve`, { method: "POST", body: JSON.stringify({ feedbackId, action }) });
    toast(action === "adopt" ? "已批准并进入风格证据池" : "已忽略该反馈");
    await Promise.all([loadFeedbackPage(), loadPendingFeedback({ silent: true })]);
  } catch (error) {
    button.disabled = false;
    toast(error.message);
  }
}

async function exportTaskExcel(batchId, button) {
  button.disabled = true;
  button.textContent = "导出中…";
  try {
    const payload = await api(`/api/tasks/${encodeURIComponent(batchId)}/export`, { method: "POST" });
    downloadBase64File(payload);
    toast(`已导出 ${payload.filename}`);
  } catch (error) { toast(error.message); }
  finally { button.disabled = false; button.textContent = "导出 Excel"; }
}

function applyStoredBatchRun(run) {
  state.batchBase64 = "";
  state.batchFile = null;
  state.batchPreview = {
    batchId: run.batchId, filename: run.filename, format: run.format,
    segmentationMode: run.segmentationMode, structure: run.structure,
    segments: run.segments.map((segment, index) => ({
      id: segment.id, index: index + 1, source: segment.source, translation: segment.translation || "",
      status: segment.status || "pending", selected: segment.selected !== false, accepted: Boolean(segment.accepted),
      locator: segment.locator || undefined, context: segment.context || undefined, result: segment.result || null, error: segment.error || ""
    }))
  };
  state.batchClassification = { contentType: run.contentType || "general", source: "restored" };
  state.batchStyleProfile = null;
  state.workbenchLocale = run.locale || state.workbenchLocale;
  $("#domain").value = run.domain || "game";
  $("#contentType").value = run.contentType || "auto";
  localStorage.setItem("kami-batch-id", run.batchId);
  renderLocaleStrip($("#workbenchLocales"), state.workbenchLocale, updateWorkbenchLocale);
  $("#batchSourceMeta").textContent = `${run.segments.length} 段 · 历史任务`;
  $("#batchFilePrompt").textContent = run.filename || "已恢复历史任务";
  $("#batchFileMeta").textContent = "任务内容已从后台恢复，可继续 QA、编辑或导出 Excel";
  $("#batchDropZone").classList.add("has-file");
  switchView("workbench");
  setTranslationMode("batch");
  renderBatchSegments();
  refreshActions();
}

async function openTask(batchId) {
  try {
    const run = await api(`/api/batch/run/${encodeURIComponent(batchId)}`);
    applyStoredBatchRun(run);
    toast(`已打开任务：${run.filename}`);
  } catch (error) { toast(error.message); }
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
    const restoredWithoutSource = !state.batchBase64 && ["docx", "xlsx"].includes(state.batchPreview.format);
    const payload = await api("/api/batch/export", { method: "POST", body: JSON.stringify({
      filename: state.batchPreview.filename,
      locale: state.workbenchLocale,
      format: restoredWithoutSource ? "task-xlsx" : state.batchPreview.format,
      structure: state.batchPreview.structure,
      base64: state.batchBase64 || undefined,
      segments: state.batchPreview.segments.map(({ id, source, selected, translation }) => ({ id, source, selected, translation }))
    }) });
    downloadBase64File(payload);
    toast(restoredWithoutSource ? `原文件未随历史任务保存，已导出可继续编辑的任务 Excel：${payload.filename}` : `已导出 ${payload.filename}`);
  } catch (error) { toast(error.message); }
  finally { setBusy(false); }
}

function batchFeedbacks() {
  return state.batchPreview?.segments.filter((segment) => segment.status === "done" && segment.translation && !segment.accepted) || [];
}

async function acceptSegment(segmentId) {
  const segment = state.batchPreview?.segments.find((item) => item.id === segmentId);
  if (!segment || !segment.translation) return;
  try {
    const result = await api("/api/feedback/accept", { method: "POST", body: JSON.stringify({
      source: segment.source,
      translation: segment.translation,
      locale: state.workbenchLocale,
      contentType: state.batchClassification?.contentType || "general",
      domain: $("#domain").value,
      styleProfileId: state.batchStyleProfile?.id || "",
      qaCaseId: segment.result?.aiQa?.qaCases?.[0]?.id || "",
      batchId: state.batchPreview.batchId || "",
      sourceFile: state.batchPreview.filename || "",
      trajectoryId: segment.result?.trajectoryId || segment.result?.trajectory_id || ""
    }) });
    segment.accepted = true;
    saveBatchProgress();
    renderBatchSegments();
    refreshActions();
    toast(`已采纳：${segment.source.slice(0, 20)}…${result.demoted ? `（${result.demoted} 条旧译降权）` : ""}`);
  } catch (error) { toast(error.message); }
}

async function acceptAllSegments() {
  const pending = batchFeedbacks();
  if (!pending.length) return;
  if (!confirm(`确认采纳全部 ${pending.length} 段译文？采纳后将写入翻译记忆与风格证据。`)) return;
  setBusy(true, `采纳中（0 / ${pending.length}）…`);
  let done = 0;
  for (const segment of pending) {
    try {
      await api("/api/feedback/accept", { method: "POST", body: JSON.stringify({
        source: segment.source,
        translation: segment.translation,
        locale: state.workbenchLocale,
        contentType: state.batchClassification?.contentType || "general",
        domain: $("#domain").value,
        styleProfileId: state.batchStyleProfile?.id || "",
        qaCaseId: segment.result?.aiQa?.qaCases?.[0]?.id || "",
        batchId: state.batchPreview.batchId || "",
        sourceFile: state.batchPreview.filename || "",
        trajectoryId: segment.result?.trajectoryId || segment.result?.trajectory_id || ""
      }) });
      segment.accepted = true;
      done += 1;
      setBusy(true, `采纳中（${done} / ${pending.length}）…`);
      saveBatchProgress();
    } catch (error) {
      toast(`第 ${segment.index} 段采纳失败：${error.message}`);
    }
  }
  setBusy(false);
  renderBatchSegments();
  toast(`已采纳 ${done} / ${pending.length} 段译文`);
}

async function saveBatchProgress() {
  if (!state.batchPreview?.batchId) return;
  const preview = state.batchPreview;
  localStorage.setItem("kami-batch-id", preview.batchId);
  const payload = {
      batchId: preview.batchId,
      filename: preview.filename,
      locale: state.workbenchLocale,
      contentType: state.batchClassification?.contentType || "general",
      domain: $("#domain").value,
      format: preview.format,
      segmentationMode: preview.segmentationMode,
      structure: preview.structure,
      segments: preview.segments.map(({ id, source, translation, status, selected, accepted, locator, context, result }) => ({ id, source, translation, status, selected, accepted, locator, context, result: compactBatchResult(result) }))
  };
  batchSaveChain = batchSaveChain.catch(() => undefined).then(() => api("/api/batch/run", { method: "POST", body: JSON.stringify(payload) }));
  try { await batchSaveChain; }
  catch (error) { console.warn("批次进度保存失败：", error.message); }
}

function compactBatchResult(result) {
  if (!result) return null;
  const compactText = (value, limit = 800) => String(value || "").slice(0, limit);
  return {
    translation: compactText(result.translation, 10_000),
    qaScore: Number.isFinite(result.qaScore) ? result.qaScore : null,
    matches: (result.matches || []).slice(0, 20).map((match) => ({ mode: match.mode, matchPhrase: compactText(match.matchPhrase, 120), score: match.score, term: { source: compactText(match.term?.source, 120), target: compactText(match.term?.target, 120), enforcement: match.term?.enforcement, forbidden: match.term?.forbidden || [] } })),
    issues: (result.issues || []).slice(0, 30),
    aiQa: result.aiQa ? {
      score: Number.isFinite(result.aiQa.score) ? result.aiQa.score : null,
      status: result.aiQa.status,
      iterations: result.aiQa.iterations || 0,
      used: Boolean(result.aiQa.used),
      fallbackReason: compactText(result.aiQa.fallbackReason, 500),
      termDecisions: (result.aiQa.termDecisions || []).slice(0, 12),
      humanDecisions: (result.aiQa.humanDecisions || []).slice(0, 30),
      referenceCount: (result.aiQa.references || []).length,
      qaCaseCount: (result.aiQa.qaCases || []).length
    } : null,
    styleProfile: result.styleProfile ? { id: result.styleProfile.id, name: result.styleProfile.name, version: result.styleProfile.version } : null
  };
}

async function restoreBatchProgress() {
  const batchId = localStorage.getItem("kami-batch-id");
  if (!batchId) return;
  try {
    const run = await api(`/api/batch/run/${encodeURIComponent(batchId)}`);
    if (!run?.segments?.length) return;
    state.batchPreview = {
      batchId: run.batchId,
      filename: run.filename,
      format: run.format,
      segmentationMode: run.segmentationMode,
      structure: run.structure,
      segments: run.segments.map((segment, index) => ({
        id: segment.id,
        index: index + 1,
        source: segment.source,
        translation: segment.translation || "",
        status: segment.status || "pending",
        selected: segment.selected !== false,
        accepted: Boolean(segment.accepted),
        locator: segment.locator || undefined,
        context: segment.context || undefined,
        result: segment.result || null,
        error: ""
      }))
    };
    state.batchClassification = { contentType: run.contentType || "general", source: "restored" };
    state.batchStyleProfile = null;
    state.workbenchLocale = run.locale || state.workbenchLocale;
    setTranslationMode("batch");
    renderLocaleStrip($("#workbenchLocales"), state.workbenchLocale, updateWorkbenchLocale);
    const details = state.bootstrap.locales[state.workbenchLocale];
    $("#targetKicker").textContent = `TARGET · ${state.workbenchLocale.toUpperCase()}`;
    $("#targetTitle").textContent = `${details.label}译文`;
    $("#batchSourceMeta").textContent = `${run.segments.length} 段 · 已恢复保存的进度`;
    if (run.format === "text" || run.format === "markdown") {
      $("#batchFilePrompt").textContent = "已恢复粘贴长文进度";
      $("#batchFileMeta").textContent = `${run.segments.length} 段 · 刷新后自动恢复`;
      $("#batchDropZone").classList.add("has-file");
    } else {
      $("#batchFilePrompt").textContent = run.filename;
      $("#batchFileMeta").textContent = "进度已恢复 · 导出前请重新选择同名原文件";
      $("#batchDropZone").classList.add("has-file");
    }
    renderBatchSegments();
    refreshActions();
    toast("已恢复上次未完成的批次进度");
  } catch {
    localStorage.removeItem("kami-batch-id");
  }
}

async function updateAssetLocale(locale) {
  state.assetLocale = locale;
  renderLocaleStrip($("#assetLocales"), locale, updateAssetLocale);
  const details = state.bootstrap.locales[locale];
  $("#assetListTitle").textContent = `${details.label}术语库`;
  $("#targetTermLabel").textContent = `${details.label}正式译法`;
  await loadAssets(locale);
}

async function loadStyleProfiles(locale) {
  try {
    const [drafts, active, pending] = await Promise.all([
      api(`/api/style-profiles?locale=${encodeURIComponent(locale)}&status=draft`),
      api(`/api/style-profiles?locale=${encodeURIComponent(locale)}&status=active`),
      api(`/api/qa-cases/pending?locale=${encodeURIComponent(locale)}`)
    ]);
    renderStyleProfiles(drafts, active, pending);
  } catch (error) {
    $("#styleProfileList").innerHTML = `<div class="empty-list">风格规范加载失败：${escapeHtml(error.message)}</div>`;
  }
}

function contentTypeLabel(value) {
  return state.bootstrap?.contentTypes?.[value]?.label || value;
}

function renderStyleProfiles(drafts, active, pending) {
  const activeById = new Map([...(active.styleProfiles || []), ...(active.userProfiles || [])].map((item) => [item.id, item]));
  const profileCards = [];
  for (const item of drafts.styleProfiles || []) {
    const previous = item.parentId ? activeById.get(item.parentId) : null;
    profileCards.push({ ...item, kind: "style", kindLabel: `风格规范 · ${contentTypeLabel(item.contentType)} / ${item.domain}`, previous });
  }
  for (const item of drafts.userProfiles || []) {
    const previous = item.parentId ? activeById.get(item.parentId) : null;
    profileCards.push({ ...item, kind: "user", kindLabel: "译者画像 · 全局", previous });
  }
  profileCards.sort((a, b) => b.version - a.version);
  $("#styleProfileCount").textContent = `${profileCards.length} 待审核`;

  const profileHtml = profileCards.map((item) => `
    <div class="style-profile-card" data-profile-id="${escapeHtml(item.id)}">
      <div class="style-profile-head"><strong>v${item.version} · ${escapeHtml(item.name)}</strong><span>${escapeHtml(item.kindLabel)} · ${item.evidenceCount} 条证据${item.status === "draft" ? " · 草稿" : ""}</span></div>
      <div class="style-profile-instruction">${escapeHtml(item.instruction)}</div>
      <div class="style-profile-diff" hidden><div><strong>当前生效版本</strong><p>${escapeHtml(item.previous?.instruction || "无（首个版本）")}</p></div><div><strong>本草稿</strong><p>${escapeHtml(item.instruction)}</p></div></div>
      <div class="style-profile-actions">
        <button class="button ghost small" data-action="diff">对比新旧</button>
        <button class="button ghost small" data-action="activate">激活</button>
        <button class="button ghost small" data-action="reject">拒绝</button>
      </div>
    </div>
  `).join("");
  const pendingHtml = pending.length ? `<div class="qa-case-pending"><strong>AIQA 待复核案例（${pending.length}）</strong>${pending.map((item) => `
    <div class="qa-case-row" data-case-id="${escapeHtml(item.id)}">
      <div><small>${Math.round(item.scoreBefore)} → ${Math.round(item.scoreAfter)} · ${escapeHtml(item.source.slice(0, 40))}</small><p><s>${escapeHtml((item.rejectedTranslation || "").slice(0, 60))}</s> → <strong>${escapeHtml((item.correctedTranslation || "").slice(0, 60))}</strong></p></div>
      <div class="qa-case-actions"><button class="button ghost small" data-action="approve-case">采纳为反例</button><button class="button ghost small" data-action="dispose-case">作废</button></div>
    </div>
  `).join("")}</div>` : "";
  $("#styleProfileList").innerHTML = profileHtml || '<div class="empty-list">当前语言没有待审核的风格草稿</div>' + pendingHtml;

  $$(".style-profile-card [data-action]").forEach((button) => button.addEventListener("click", async () => {
    const card = button.closest(".style-profile-card");
    const id = card.dataset.profileId;
    if (button.dataset.action === "diff") {
      card.querySelector(".style-profile-diff").hidden = !card.querySelector(".style-profile-diff").hidden;
      return;
    }
    try {
      await api(`/api/style-profiles/${encodeURIComponent(id)}/${button.dataset.action}`, { method: "POST" });
      toast(button.dataset.action === "activate" ? "已激活，开始参与翻译" : "已拒绝该草稿");
      await loadStyleProfiles(state.assetLocale);
    } catch (error) { toast(error.message); }
  }));
  $$(".qa-case-row [data-action]").forEach((button) => button.addEventListener("click", async () => {
    const id = button.closest(".qa-case-row").dataset.caseId;
    try {
      await api(`/api/qa-cases/${encodeURIComponent(id)}/${button.dataset.action === "approve-case" ? "approve" : "dispose"}`, { method: "POST" });
      toast(button.dataset.action === "approve-case" ? "已采纳为反例，将参与后续 QA 指导" : "已作废该案例");
      await loadStyleProfiles(state.assetLocale);
    } catch (error) { toast(error.message); }
  }));
}

async function updateStyleLocale(locale) {
  state.styleLocale = locale;
  renderLocaleStrip($("#styleLocales"), locale, updateStyleLocale);
  const details = state.bootstrap.locales[locale];
  $("#styleGuidanceTitle").textContent = `${details.label}翻译风格指导`;
  await loadStyleGuidance(locale);
}

function splitStyleRules(instruction) {
  return String(instruction || "").split(/\r?\n|；/u).map((item) => item.trim()).filter(Boolean).slice(0, 24);
}

async function loadStyleGuidance(locale = state.styleLocale) {
  const [profiles, pending] = await Promise.all([
    api(`/api/style-profiles?locale=${encodeURIComponent(locale)}`),
    api(`/api/qa-cases/pending?locale=${encodeURIComponent(locale)}`)
  ]);
  state.styleData = { profiles, pending };
  renderStyleGuidance();
}

function renderStyleGuidance() {
  const profiles = state.styleData?.profiles || { styleProfiles: [], userProfiles: [], evidencePools: [] };
  const pending = state.styleData?.pending || [];
  const learningRuns = learningRunsFromPayload(profiles);
  const statusFilter = $("#styleStatus")?.value || "";
  const items = [
    ...(profiles.userProfiles || []).map((item) => ({ ...item, kind: "user", scopeLabel: "全局译者画像" })),
    ...(profiles.styleProfiles || []).map((item) => ({ ...item, kind: "style", scopeLabel: `${contentTypeLabel(item.contentType)} · ${item.domain}` }))
  ].filter((item) => !statusFilter || item.status === statusFilter);
  const activeCount = [...(profiles.userProfiles || []), ...(profiles.styleProfiles || [])].filter((item) => item.status === "active").length;
  $("#styleGuidanceCount").textContent = `${activeCount} 条启用 · ${items.length} 条显示`;
  $("#styleLearningCount").textContent = `${learningRuns.length} 个批次范围`;
  $("#styleLearningRuns").innerHTML = learningRuns.length ? renderLearningCards(learningRuns) : '<div class="empty-list compact">还没有可展示的批次学习记录；导入完整双语句段后会在这里说明 AI 具体学到了什么。</div>';
  const pools = profiles.evidencePools || [];
  $("#styleEvidencePools").innerHTML = pools.length ? `<div class="style-pool-heading"><strong>正在积累的证据池</strong><small>每个分类独立累计，达到 8 条才生成风格草稿</small></div>${pools.map((pool) => {
    const percent = Math.min(100, Math.round((pool.evidenceCount / Math.max(1, pool.threshold)) * 100));
    const sources = pool.sources || {};
    return `<div class="style-pool"><div><strong>${escapeHtml(contentTypeLabel(pool.contentType))} · ${escapeHtml(pool.domain)}</strong><small>直接证据：表格导入 ${sources.tableImport || 0} · 人工采纳 ${sources.humanAccept || 0}${sources.other ? ` · 历史/其他 ${sources.other}` : ""}</small><small>辅助复盘：AIQA 记录 ${sources.qaReview || 0}（不计入 8 条直接证据）</small></div><div class="style-pool-progress"><i style="width:${percent}%"></i></div><span>${pool.evidenceCount} / ${pool.threshold}</span></div>`;
  }).join("")}` : '<div class="empty-list compact">还没有完整双语句段进入风格证据池；导入短术语不会产生风格。</div>';
  $("#styleGuidanceList").innerHTML = items.length ? items.map((item) => {
    const rules = splitStyleRules(item.instruction);
    const examples = (item.examples || []).slice(0, 4);
    const sourceBatchId = item.sourceBatchId || item.source_batch_id || "";
    const learningSummary = item.learningSummary || item.learning_summary || "";
    return `<article class="style-guidance-card ${escapeHtml(item.status)}" data-profile-id="${escapeHtml(item.id)}">
      <div class="style-guidance-head"><div><strong>${escapeHtml(item.name)}</strong><small>适用范围：${escapeHtml(state.bootstrap.locales[state.styleLocale].label)} × ${escapeHtml(item.scopeLabel)} · v${item.version}</small><small>生成方式：${escapeHtml(item.name.includes("复盘修订") ? "AIQA 复盘结合已沉淀语料" : "同类双语语料自动精炼")} · ${item.evidenceCount} 条证据${sourceBatchId ? ` · 来源批次 ${escapeHtml(String(sourceBatchId).slice(0, 8))}` : ""}</small></div><span class="style-state ${escapeHtml(item.status)}">${item.status === "active" ? "已启用" : item.status === "draft" ? "待批准" : "已停用"}</span></div>
      ${learningSummary ? `<p class="style-learning-summary">本批浓缩：${escapeHtml(learningSummary)}</p>` : ""}
      <div class="style-rule-list">${rules.length ? rules.map((rule, index) => `<div><span>${String(index + 1).padStart(2, "0")}</span><p>${escapeHtml(rule)}</p></div>`).join("") : '<div class="batch-detail-empty">该版本没有可展示的规则条目</div>'}</div>
      ${examples.length ? `<details class="style-examples"><summary>查看 ${examples.length} 个正反例</summary>${examples.map((example) => `<div><strong>${example.type === "negative" ? "反例" : "正例"}</strong><p>${escapeHtml(example.source || "")}</p><p>${escapeHtml(example.target || "")}</p><small>${escapeHtml(example.reason || "")}</small></div>`).join("")}</details>` : ""}
      <div class="style-guidance-actions"><button class="button ${item.status === "active" ? "ghost" : "secondary"} small" data-action="${item.status === "active" ? "disable" : "activate"}">${item.status === "active" ? "停用（保留历史）" : "批准并启用"}</button></div>
    </article>`;
  }).join("") : '<div class="empty-list">当前筛选条件下没有风格规则</div>';
  $("#styleQaCount").textContent = `${pending.length} 条`;
  $("#styleQaList").innerHTML = pending.length ? pending.map((item) => `<div class="qa-case-row" data-case-id="${escapeHtml(item.id)}"><div><small>${Math.round(item.scoreBefore)} → ${Math.round(item.scoreAfter)} · ${escapeHtml(item.source.slice(0, 55))}</small><p><s>${escapeHtml((item.rejectedTranslation || "").slice(0, 90))}</s> → <strong>${escapeHtml((item.correctedTranslation || "").slice(0, 90))}</strong></p></div><div class="qa-case-actions"><button class="button secondary small" data-action="approve-case">采纳为反例</button><button class="button ghost small" data-action="dispose-case">作废</button></div></div>`).join("") : '<div class="empty-list">当前没有待审核案例</div>';

  $$(".style-guidance-card [data-action]").forEach((button) => button.addEventListener("click", async () => {
    const id = button.closest(".style-guidance-card").dataset.profileId;
    const action = button.dataset.action;
    button.disabled = true;
    try {
      await api(`/api/style-profiles/${encodeURIComponent(id)}/${action === "activate" ? "activate" : "reject"}`, { method: "POST" });
      toast(action === "activate" ? "风格已启用，后续翻译将注入该规则" : "风格已关闭，历史版本仍保留但不参与翻译");
      await loadStyleGuidance(state.styleLocale);
    } catch (error) { button.disabled = false; toast(error.message); }
  }));
  $$("#styleQaList .qa-case-row [data-action]").forEach((button) => button.addEventListener("click", async () => {
    const id = button.closest(".qa-case-row").dataset.caseId;
    try {
      await api(`/api/qa-cases/${encodeURIComponent(id)}/${button.dataset.action === "approve-case" ? "approve" : "dispose"}`, { method: "POST" });
      toast(button.dataset.action === "approve-case" ? "已采纳为 AIQA 反例" : "已作废该案例");
      await loadStyleGuidance(state.styleLocale);
    } catch (error) { toast(error.message); }
  }));
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

async function setImportFile(file) {
  if (!file) return;
  if (!/\.(xlsx|csv)$/i.test(file.name)) return toast("请选择 .xlsx 或 .csv 表格");
  if (file.size > 10 * 1024 * 1024) return toast("表格不能超过 10MB");
  state.importFile = file;
  state.importPreview = null;
  state.importCompleted = false;
  state.importCandidateTab = "terms";
  state.importBatchLearning = [];
  $("#filePrompt").textContent = file.name;
  $("#fileMeta").textContent = `${(file.size / 1024).toFixed(1)} KB · AI 正在识别表格结构`;
  $("#dropZone").classList.add("has-file");
  $("#mappingNote").textContent = "正在自动识别中文列、目标语言列和无表头数据结构……";
  $("#importSummary").innerHTML = "<span>AI 结构识别中</span>";
  updateImportProgress({ message: "正在上传并解析表格", percent: 2 });
  $("#termImportSummary").innerHTML = "<span>等待术语识别</span>";
  $("#styleImportSummary").innerHTML = "<span>等待译例识别</span>";
  $("#termImportCandidates").innerHTML = '<tr><td colspan="6" class="table-empty">清洗后将在此处审核术语候选</td></tr>';
  $("#styleImportCandidates").innerHTML = '<tr><td colspan="6" class="table-empty">清洗后将在此处审核完整译例</td></tr>';
  $("#importBatchLearningPanel").hidden = true;
  $("#importBatchLearningList").innerHTML = '<div class="empty-list">提交译例后显示本批风格学习结果</div>';
  setImportCandidateTab("terms");
  refreshActions();
  await cleanTable();
}

function resetImport() {
  state.importFile = null;
  state.importPreview = null;
  state.importCompleted = false;
  state.importCandidateTab = "terms";
  state.importBatchLearning = [];
  $("#termFile").value = "";
  $("#filePrompt").textContent = "拖入或点击选择 .xlsx / .csv";
  $("#fileMeta").textContent = "拖入后自动识别；不要求表头，支持日、韩、繁中、泰列";
  $("#dropZone").classList.remove("has-file");
  $("#mappingNote").textContent = "拖入表格后会自动识别结构并生成审核队列。";
  $("#importSummary").innerHTML = "<span>尚未清洗</span>";
  $("#importProgress").hidden = true;
  $("#importProgressBar").style.width = "0%";
  $("#termImportSummary").innerHTML = "<span>0 条术语</span>";
  $("#styleImportSummary").innerHTML = "<span>0 条译例</span>";
  $("#termImportCandidates").innerHTML = '<tr><td colspan="6" class="table-empty">还没有术语候选</td></tr>';
  $("#styleImportCandidates").innerHTML = '<tr><td colspan="6" class="table-empty">还没有完整译例</td></tr>';
  $("#importBatchLearningPanel").hidden = true;
  $("#importBatchLearningList").innerHTML = '<div class="empty-list">提交译例后显示本批风格学习结果</div>';
  setImportCandidateTab("terms");
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

function importCandidateKind(candidate) {
  const nested = Boolean(candidate?.nested || candidate?.parentCandidateKey || candidate?.parent_candidate_key);
  return candidate?.assetType === "memory" && !nested ? "styles" : "terms";
}

function indexedImportCandidates(kind) {
  return (state.importPreview?.candidates || [])
    .map((candidate, index) => ({ candidate, index }))
    .filter(({ candidate }) => importCandidateKind(candidate) === kind);
}

function setImportCandidateTab(tab) {
  const next = tab === "styles" ? "styles" : "terms";
  state.importCandidateTab = next;
  $$('[data-import-candidate-tab]').forEach((button) => {
    const active = button.dataset.importCandidateTab === next;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  });
  const termsPane = $("#importTermsPane");
  const stylesPane = $("#importStylesPane");
  if (termsPane) {
    termsPane.hidden = next !== "terms";
    termsPane.classList.toggle("active", next === "terms");
  }
  if (stylesPane) {
    stylesPane.hidden = next !== "styles";
    stylesPane.classList.toggle("active", next === "styles");
  }
}

function updateCandidateSelectAll(id, entries) {
  const checkbox = $(id);
  if (!checkbox) return;
  const selectable = entries.map(({ candidate }) => candidate).filter((candidate) => !candidate.existing && candidate.decision !== "excluded");
  checkbox.checked = selectable.length > 0 && selectable.every((candidate) => candidate.selected);
  checkbox.indeterminate = selectable.some((candidate) => candidate.selected) && !selectable.every((candidate) => candidate.selected);
}

function updateImportSummary() {
  if (!state.importPreview) return;
  const candidates = state.importPreview.candidates;
  const ai = state.importPreview.ai;
  const terms = indexedImportCandidates("terms");
  const styles = indexedImportCandidates("styles");
  const selected = selectedCandidates();
  $("#importSummary").innerHTML = `
    <span>总候选 <strong>${candidates.length}</strong></span><span>术语 <strong>${terms.length}</strong></span><span>完整译例 <strong>${styles.length}</strong></span><span>已选 <strong>${selected.length}</strong></span><span>${ai?.used ? `AI 已逐条归类 ${ai.reviewed} 条` : ai?.requested ? "AI 不可用 · 已用本地规则" : "本地规则归类"}</span>
  `;
  const nestedCount = terms.filter(({ candidate }) => candidate.nested || candidate.parentCandidateKey || candidate.parent_candidate_key).length;
  const termSelected = terms.filter(({ candidate }) => candidate.selected).length;
  const styleSelected = styles.filter(({ candidate }) => candidate.selected).length;
  const styleScopes = new Set(styles.map(({ candidate }) => `${candidate.locale}\u0000${candidate.contentType || "general"}\u0000${candidate.domain || "general"}`));
  $("#termImportSummary").innerHTML = `<span>术语 <strong>${terms.length}</strong></span><span>句内提取 <strong>${nestedCount}</strong></span><span>已选 <strong>${termSelected}</strong></span><span>需复核 <strong>${terms.filter(({ candidate }) => candidate.decision === "review").length}</strong></span>`;
  $("#styleImportSummary").innerHTML = `<span>完整译例 <strong>${styles.length}</strong></span><span>风格范围 <strong>${styleScopes.size}</strong></span><span>已选 <strong>${styleSelected}</strong></span><span>需复核 <strong>${styles.filter(({ candidate }) => candidate.decision === "review").length}</strong></span>`;
  updateCandidateSelectAll("#selectAllTermCandidates", terms);
  updateCandidateSelectAll("#selectAllStyleCandidates", styles);
}

function renderImportCandidateRows(entries, kind) {
  if (!entries.length) return `<tr><td colspan="6" class="table-empty">${kind === "terms" ? "没有识别到独立或句内术语候选" : "没有识别到可用的完整双语译例"}</td></tr>`;
  return entries.map(({ candidate, index }) => {
    const [label, className] = decisionLabel(candidate);
    const disabled = candidate.existing || candidate.decision === "excluded" || state.importCompleted;
    const locale = state.bootstrap.locales[candidate.locale] || { shortLabel: candidate.locale, label: candidate.locale };
    const rowLabel = candidate.rowNumber ? `第 ${candidate.rowNumber} 行` : "来源行未知";
    const nested = Boolean(candidate.nested || candidate.parentCandidateKey || candidate.parent_candidate_key);
    const evidenceMeta = nested && Number(candidate.occurrences) > 1 ? ` · ${candidate.occurrences} 条父句证据` : "";
    const meta = kind === "terms"
      ? `${nested ? "句内提取术语" : "独立术语"} · ${candidate.domain || "general"} · ${candidate.enforcement === "required" ? "强制采用" : "优先参考"}${evidenceMeta} · ${rowLabel}`
      : `${contentTypeLabel(candidate.contentType || "general")} · ${candidate.domain || "general"} · ${rowLabel}`;
    const sourceEditor = kind === "terms"
      ? `<input class="table-input candidate-source" data-index="${index}" value="${escapeHtml(candidate.source)}" ${disabled ? "disabled" : ""} />`
      : `<textarea class="table-input table-textarea candidate-source" data-index="${index}" rows="2" ${disabled ? "disabled" : ""}>${escapeHtml(candidate.source)}</textarea>`;
    const targetEditor = kind === "terms"
      ? `<input class="table-input candidate-target" data-index="${index}" value="${escapeHtml(candidate.target)}" ${disabled ? "disabled" : ""} />`
      : `<textarea class="table-input table-textarea candidate-target" data-index="${index}" rows="2" ${disabled ? "disabled" : ""}>${escapeHtml(candidate.target)}</textarea>`;
    return `<tr class="candidate-${className}">
      <td class="check-cell"><input class="candidate-check" data-index="${index}" type="checkbox" ${candidate.selected ? "checked" : ""} ${disabled ? "disabled" : ""} /></td>
      <td><span class="locale-tag">${escapeHtml(locale.shortLabel)} · ${escapeHtml(locale.label)}</span><small class="row-ref">${escapeHtml(meta)}</small></td>
      <td>${sourceEditor}</td>
      <td>${targetEditor}</td>
      <td><span class="decision-badge ${className}">${label}</span><small class="score">${Math.round((Number(candidate.score) || 0) * 100)} 分</small></td>
      <td class="reason-cell">${escapeHtml((candidate.reasons || []).join("；") || "短语长度与语言特征通过")}</td>
    </tr>`;
  }).join("");
}

function renderImportCandidates() {
  const terms = indexedImportCandidates("terms");
  const styles = indexedImportCandidates("styles");
  $("#termImportCandidates").innerHTML = renderImportCandidateRows(terms, "terms");
  $("#styleImportCandidates").innerHTML = renderImportCandidateRows(styles, "styles");
  $$(".candidate-check").forEach((checkbox) => checkbox.addEventListener("change", () => { state.importPreview.candidates[Number(checkbox.dataset.index)].selected = checkbox.checked; updateImportSummary(); }));
  $$(".candidate-source").forEach((input) => input.addEventListener("change", () => { state.importPreview.candidates[Number(input.dataset.index)].source = input.value.trim(); }));
  $$(".candidate-target").forEach((input) => input.addEventListener("change", () => { state.importPreview.candidates[Number(input.dataset.index)].target = input.value.trim(); }));
  if (!indexedImportCandidates(state.importCandidateTab).length && (terms.length || styles.length)) setImportCandidateTab(terms.length ? "terms" : "styles");
  else setImportCandidateTab(state.importCandidateTab);
  updateImportSummary();
}

function normalizeLearningRules(value, instruction = "") {
  const raw = Array.isArray(value) ? value : value ? [value] : splitStyleRules(instruction);
  return raw.map((rule) => {
    if (typeof rule === "string") return { category: "风格规则", text: rule };
    return {
      category: String(rule?.category || rule?.dimension || rule?.type || "风格规则"),
      text: String(rule?.guidance || rule?.instruction || rule?.rule || rule?.observation || rule?.text || "").trim(),
      confidence: Number(rule?.confidence)
    };
  }).filter((rule) => rule.text).slice(0, 12);
}

function normalizeStyleLearningRun(item = {}) {
  const profile = item.profile || item.styleProfile || {};
  const locale = item.locale || item.targetLocale || item.target_locale || profile.locale || profile.targetLocale || profile.target_locale || "";
  const contentType = item.contentType || item.content_type || profile.contentType || profile.content_type || "general";
  const domain = item.domain || profile.domain || "general";
  const instruction = String(item.instruction || item.instructions || profile.instruction || profile.instructions || "").trim();
  const evidenceCount = Number(item.evidenceCount ?? item.evidence_count ?? item.batchEvidenceCount ?? item.batch_evidence_count ?? profile.evidenceCount ?? profile.evidence_count) || 0;
  const profileId = item.profileId || item.profile_id || item.promotedProfileId || item.promoted_profile_id || profile.id || "";
  const profileStatus = item.profileStatus || item.profile_status || profile.status || (profileId ? "draft" : "");
  return {
    ...item,
    locale,
    contentType,
    domain,
    evidenceCount,
    summary: String(item.summary || item.learningSummary || item.learning_summary || item.reason || instruction || "已完成本批风格观察，等待更多同类证据。"),
    rules: normalizeLearningRules(item.rules || item.learnedRules || item.learned_rules, instruction),
    examples: (Array.isArray(item.examples) ? item.examples : Array.isArray(profile.examples) ? profile.examples : []).slice(0, 4),
    confidence: Number(item.confidence ?? item.learningConfidence ?? item.learning_confidence),
    caveat: String(item.caveat || item.limitation || item.warning || ""),
    status: String(item.status || item.learningStatus || item.learning_status || (profileId ? "promoted" : "observed")),
    batchId: String(item.batchId || item.batch_id || ""),
    filename: String(item.filename || item.sourceFile || item.source_file || ""),
    profileId: String(profileId),
    profileName: String(item.profileName || item.profile_name || profile.name || ""),
    profileStatus: String(profileStatus),
    profileVersion: Number(item.profileVersion ?? item.profile_version ?? profile.version) || null
  };
}

function learningRunsFromPayload(payload = {}, { includeProfileFallback = false } = {}) {
  const direct = payload.batchLearning || payload.learningRuns || payload.recentLearningRuns || payload.styleLearningRuns || payload.styleLearning || [];
  if (Array.isArray(direct) && direct.length) return direct.map(normalizeStyleLearningRun);
  if (!includeProfileFallback) return [];
  const profiles = Array.isArray(payload.styleProfiles) ? payload.styleProfiles.map((profile) => normalizeStyleLearningRun({ ...profile, profile, status: profile.status || "promoted" })) : [];
  const pending = Array.isArray(payload.styleFallbacks) ? payload.styleFallbacks.map((item) => normalizeStyleLearningRun({ ...item, status: "collecting", summary: item.reason })) : [];
  return [...profiles, ...pending];
}

function learningStatus(run) {
  const status = String(run.profileStatus || run.status || "").toLowerCase();
  if (status === "active") return ["已启用", "active"];
  if (["draft", "promoted", "ready"].includes(status) || run.profileId) return ["已形成待批准规范", "draft"];
  if (["failed", "error"].includes(status)) return ["学习失败", "error"];
  if (["dismissed", "rejected", "inactive"].includes(status)) return ["已关闭", "inactive"];
  return ["已学习 · 继续积累", "observed"];
}

function renderLearningCards(runs, { showJump = false } = {}) {
  return runs.map((run) => {
    const [statusLabel, statusClass] = learningStatus(run);
    const locale = state.bootstrap.locales[run.locale] || { shortLabel: run.locale || "--", label: run.locale || "未知语言" };
    const rules = run.rules || [];
    const examples = run.examples || [];
    const confidence = Number.isFinite(run.confidence) ? `${Math.round((run.confidence <= 1 ? run.confidence * 100 : run.confidence))}% 置信` : "";
    const profileMeta = run.profileId
      ? `${run.profileName || "风格规范"}${run.profileVersion ? ` v${run.profileVersion}` : ""} · ${run.profileStatus === "active" ? "已启用" : "待批准"}`
      : "尚未形成正式规范";
    const sourceMeta = [run.filename, run.batchId ? `批次 ${run.batchId.slice(0, 8)}` : "", `${run.evidenceCount} 条本批证据`, confidence].filter(Boolean).join(" · ");
    return `<article class="batch-learning-card ${escapeHtml(statusClass)}">
      <div class="batch-learning-head"><div><span class="locale-tag">${escapeHtml(locale.shortLabel)} · ${escapeHtml(locale.label)}</span><strong>${escapeHtml(contentTypeLabel(run.contentType))} · ${escapeHtml(run.domain)}</strong><small>${escapeHtml(sourceMeta || `${run.evidenceCount} 条本批证据`)}</small></div><span class="style-state ${escapeHtml(statusClass)}">${statusLabel}</span></div>
      <p class="batch-learning-summary">${escapeHtml(run.summary)}</p>
      ${rules.length ? `<div class="batch-learning-rules">${rules.map((rule) => `<div><span>${escapeHtml(rule.category)}</span><p>${escapeHtml(rule.text)}</p>${Number.isFinite(rule.confidence) ? `<small>${Math.round((rule.confidence <= 1 ? rule.confidence * 100 : rule.confidence))}%</small>` : ""}</div>`).join("")}</div>` : '<div class="batch-detail-empty">模型没有返回可拆分的规则条目，已保留学习摘要。</div>'}
      ${examples.length ? `<details class="style-examples"><summary>查看 ${examples.length} 个本批代表例句</summary>${examples.map((example) => `<div><strong>${example.type === "negative" ? "反例" : "正例"}</strong><p>${escapeHtml(example.source || "")}</p><p>${escapeHtml(example.target || "")}</p><small>${escapeHtml(example.reason || "")}</small></div>`).join("")}</details>` : ""}
      ${run.caveat ? `<p class="batch-learning-caveat">${escapeHtml(run.caveat)}</p>` : ""}
      <div class="batch-learning-foot"><small>${escapeHtml(profileMeta)}</small>${showJump && run.locale ? `<button class="button ghost small style-learning-link" type="button" data-style-learning-locale="${escapeHtml(run.locale)}">查看风格指导</button>` : ""}</div>
    </article>`;
  }).join("");
}

function bindStyleLearningLinks(container) {
  container?.querySelectorAll(".style-learning-link").forEach((button) => button.addEventListener("click", () => {
    const locale = button.dataset.styleLearningLocale;
    if (state.bootstrap.locales[locale]) state.styleLocale = locale;
    renderLocaleStrip($("#styleLocales"), state.styleLocale, updateStyleLocale);
    switchView("styles");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }));
}

function renderImportBatchLearning() {
  const panel = $("#importBatchLearningPanel");
  const list = $("#importBatchLearningList");
  const runs = state.importBatchLearning || [];
  panel.hidden = !runs.length;
  $("#importBatchLearningCount").textContent = `${runs.length} 个范围`;
  list.innerHTML = runs.length ? renderLearningCards(runs, { showJump: true }) : '<div class="empty-list">本批没有完整译例，因此没有产生风格学习记录。</div>';
  bindStyleLearningLinks(list);
}

function learningArray(value) {
  if (Array.isArray(value)) return value;
  return value ? [value] : [];
}

function learningId(item = {}) {
  return String(item.id || item.skillId || item.skill_id || item.versionId || item.version_id || "");
}

function learningScopeMatches(item = {}) {
  const locale = item.locale || item.targetLocale || item.target_locale || item.scope?.locale;
  const contentType = item.contentType || item.content_type || item.scope?.contentType || item.scope?.content_type;
  const domain = item.domain || item.scope?.domain;
  const project = item.project || item.scope?.project;
  return (!locale || locale === state.learningLocale)
    && (!contentType || contentType === $("#learningContentType").value)
    && (!domain || domain === $("#learningDomain").value)
    && (!project || project === "default");
}

function validLearningTrajectories(items = []) {
  return learningArray(items).filter((item) => learningScopeMatches(item)
    && ["completed", "review"].includes(String(item.status || "").toLowerCase())
    && String(item.finalTranslation || item.final_translation || "").trim());
}

function learningPayload() {
  const payload = state.learningData?.data || state.learningData || {};
  const allSkills = learningArray(payload.skills);
  const champions = learningArray(payload.champions || payload.champion || payload.activeSkill || payload.active_skill)
    .concat(allSkills.filter((skill) => ["active", "champion"].includes(String(skill.status || skill.lifecycle || "").toLowerCase())));
  const explicitCandidates = learningArray(payload.candidates || payload.challengers || payload.candidateSkills || payload.candidate_skills);
  const candidates = explicitCandidates.concat(explicitCandidates.length ? [] : allSkills.filter((skill) => ["draft", "challenger", "candidate", "ready", "evaluated", "evaluating"].includes(String(skill.status || skill.lifecycle || "").toLowerCase())));
  const unique = (items) => [...new Map(items.map((item) => [learningId(item) || JSON.stringify(item), item])).values()];
  return {
    payload,
    champion: unique(champions).find(learningScopeMatches) || null,
    candidates: unique(candidates).filter(learningScopeMatches),
    evaluations: learningArray(payload.evaluations || payload.skillEvaluations || payload.skill_evaluations),
    evidence: learningArray(payload.evidence || payload.trajectories || payload.recentTrajectories || payload.recent_trajectories)
  };
}

function learningStatusMeta(item = {}) {
  const status = String(item.status || item.lifecycle || item.state || "candidate").toLowerCase();
  if (["active", "champion"].includes(status)) return ["生产冠军", "active"];
  if (["ready", "passed", "evaluated"].includes(status)) return ["评测通过", "ready"];
  if (["evaluating", "running"].includes(status)) return ["评测中", "running"];
  if (["rejected", "dismissed"].includes(status)) return ["已拒绝", "rejected"];
  if (["failed", "blocked"].includes(status)) return ["未通过", "failed"];
  if (["reject", "insufficient"].includes(status)) return [status === "insufficient" ? "证据不足" : "评测未通过", "failed"];
  if (status === "needs_review") return ["证据不足", "insufficient"];
  if (status === "stale") return ["评测基线已过期", "stale"];
  if (status === "promote") return ["评测通过", "ready"];
  return ["待评测", "candidate"];
}

function learningSkillTitle(skill = {}) {
  const contentType = skill.contentType || skill.content_type || skill.scope?.contentType || skill.scope?.content_type || $("#learningContentType").value;
  const domain = skill.domain || skill.scope?.domain || $("#learningDomain").value;
  return skill.name || skill.title || `${contentTypeLabel(contentType)} · ${domain}`;
}

function learningVersion(skill = {}) {
  const version = skill.version ?? skill.revision ?? skill.skillVersion ?? skill.skill_version;
  return version === undefined || version === null || version === "" ? "未标记版本" : `v${version}`;
}

function learningEvaluationFor(skill, evaluations) {
  const id = learningId(skill);
  return skill.evaluation || evaluations.find((item) => String(item.skillId || item.skill_id || item.candidateId || item.candidate_id || item.challengerSkillId || item.challenger_skill_id || item.challengerId || item.challenger_id || "") === id) || null;
}

function learningEvaluationResult(evaluation = {}) {
  return {
    ...evaluation,
    ...(evaluation.report && typeof evaluation.report === "object" ? evaluation.report : {}),
    ...(evaluation.result && typeof evaluation.result === "object" ? evaluation.result : {})
  };
}

function learningRules(skill = {}) {
  const strategy = skill.strategy || {};
  const output = [];
  const instruction = strategy.prompting?.additionalInstruction || strategy.instruction;
  if (instruction) output.push(`增量执行指导：${instruction}`);
  const additionalRules = learningArray(strategy.prompting?.additionalRules || strategy.additionalRules);
  output.push(...additionalRules.map((item) => `增量规则：${String(item)}`));
  if (Number.isFinite(Number(strategy.retrieval?.translationMemory?.limit))) output.push(`相似译例召回上限：${Number(strategy.retrieval.translationMemory.limit)} 条`);
  if (Number.isFinite(Number(strategy.retrieval?.qaCases?.limit))) output.push(`历史 QA 反例召回上限：${Number(strategy.retrieval.qaCases.limit)} 条`);
  if (Number.isFinite(Number(strategy.qa?.minimumScore))) output.push(`AIQA 通过分数：${Number(strategy.qa.minimumScore)} 分`);
  if (Number.isFinite(Number(strategy.qa?.maximumRevisionAttempts))) output.push(`AIQA 自动修订上限：${Number(strategy.qa.maximumRevisionAttempts)} 次`);
  if (output.length) return output.slice(0, 8);
  const raw = skill.changes || skill.rules || skill.instructions || skill.steps || [];
  if (Array.isArray(raw)) return raw.map((item) => typeof item === "string" ? item : item.text || item.rule || item.instruction || item.summary).filter(Boolean).slice(0, 8);
  if (typeof raw === "string") return raw.split(/\r?\n/u).map((item) => item.replace(/^[-*\d.\s]+/u, "").trim()).filter(Boolean).slice(0, 8);
  const changedPaths = learningArray(skill.metadata?.changedPaths || skill.metadata?.changed_paths);
  if (changedPaths.length) return changedPaths.map((item) => String(item)).slice(0, 8);
  return [];
}

function renderLearningChampion(champion) {
  const container = $("#learningChampion");
  if (!champion) {
    $("#learningChampionStatus").textContent = "尚无冠军";
    container.innerHTML = '<div class="empty-list learning-empty"><div><strong>这个范围还没有生产技能</strong><span>先根据已积累轨迹生成候选，完成评测并批准后，它才会成为冠军。</span></div></div>';
    return;
  }
  const rules = learningRules(champion);
  const [statusLabel, statusClass] = learningStatusMeta({ ...champion, status: "active" });
  const evidenceCount = Number(champion.evidenceCount ?? champion.evidence_count ?? champion.trajectoryCount ?? champion.trajectory_count)
    || learningArray(champion.evidenceIds || champion.evidence_ids).length;
  const canRollback = Boolean(champion.parentId || champion.parent_id || Number(champion.version) > 1);
  const autoPropose = champion.metadata?.autoPropose || champion.metadata?.auto_propose;
  const autoProposeNote = autoPropose
    ? (autoPropose.lastError
      ? `<span class="learning-auto-note error">自动候选生成上次失败：${escapeHtml(autoPropose.lastError)}（新的人工终稿到达后会重试）</span>`
      : `<span class="learning-auto-note">自动候选生成已启用 · ${escapeHtml(String(autoPropose.lastAcceptedCount ?? ""))} 条人工终稿时触发${autoPropose.lastProposedAt ? ` · ${escapeHtml(formatLearningDate(autoPropose.lastProposedAt))}` : ""}</span>`)
    : "";
  $("#learningChampionStatus").textContent = `${learningVersion(champion)} · 已启用`;
  container.innerHTML = `<article class="learning-skill-card champion">
    <div class="learning-skill-head"><div><span class="learning-skill-version">${escapeHtml(learningVersion(champion))}</span><h3>${escapeHtml(learningSkillTitle(champion))}</h3><small>${evidenceCount} 条轨迹支撑${champion.activatedAt || champion.activated_at ? ` · ${escapeHtml(formatLearningDate(champion.activatedAt || champion.activated_at))} 启用` : ""}</small></div><span class="learning-status ${statusClass}">${statusLabel}</span></div>
    <p class="learning-skill-summary">${escapeHtml(champion.summary || champion.description || champion.instruction || "当前稳定生产版本。所有新候选都将以此版本作为评测基线。")}</p>
    ${autoProposeNote}
    ${rules.length ? `<div class="learning-rule-grid">${rules.map((rule, index) => `<div><span>${String(index + 1).padStart(2, "0")}</span><p>${escapeHtml(rule)}</p></div>`).join("")}</div>` : ""}
    <div class="learning-card-footer"><small>回滚会恢复上一已验证版本，并保留本版本审计记录。</small><div class="learning-actions"><button class="button ghost small" type="button" data-learning-action="rollback" data-skill-id="${escapeHtml(learningId(champion))}" ${canRollback ? "" : "disabled"}>${canRollback ? "回滚上一版本" : "无可回滚版本"}</button></div></div>
  </article>`;
}

function formatLearningDate(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(date);
}

function evaluationPassed(evaluation, skill = {}) {
  const result = learningEvaluationResult(evaluation);
  if (typeof result.promotable === "boolean") return result.promotable;
  if (typeof evaluation?.passed === "boolean") return evaluation.passed;
  const gate = String(evaluation?.decision || result.status || evaluation?.gateStatus || evaluation?.gate_status || skill.status || "").toLowerCase();
  return ["passed", "ready", "evaluated", "promote", "approved"].includes(gate);
}

function renderLearningCandidates(candidates, evaluations, champion, validTrajectoryCount) {
  const list = $("#learningCandidateList");
  $("#learningCandidateCount").textContent = `${candidates.length} 个候选`;
  if (!candidates.length) {
    list.innerHTML = validTrajectoryCount
      ? '<div class="empty-list learning-empty"><div><strong>当前没有候选技能</strong><span>可使用顶部主操作从当前范围的有效轨迹中提炼隔离候选，或等人工批准终稿达到阈值后由系统自动提议；生成不会直接改变生产翻译。</span></div></div>'
      : '<div class="empty-list learning-empty"><div><strong>当前范围还没有可学习的完成轨迹</strong><span>请先完成翻译并通过 QA 或进入复核；有最终译文后，系统才会开放候选技能生成。</span></div></div>';
    return;
  }
  if (!candidates.some((item) => learningId(item) === state.learningSelectedSkillId)) state.learningSelectedSkillId = learningId(candidates[0]);
  list.innerHTML = candidates.map((skill) => {
    const id = learningId(skill);
    const evaluation = learningEvaluationFor(skill, evaluations);
    const evaluationResult = learningEvaluationResult(evaluation);
    const currentChampionId = learningId(champion);
    const evaluationChampionId = String(evaluation?.championSkillId || evaluation?.champion_skill_id || evaluationResult.championId || evaluationResult.champion_id || "");
    const candidateParentId = String(skill.parentId || skill.parent_id || "");
    const baselineCurrent = !currentChampionId
      || ((!evaluationChampionId || evaluationChampionId === currentChampionId) && (!candidateParentId || candidateParentId === currentChampionId));
    const resolvedStatus = !baselineCurrent ? "stale" : evaluationPassed(evaluation, skill) ? "ready" : (evaluationResult.status || evaluation?.decision || evaluation?.status || skill.status);
    const [statusLabel, statusClass] = learningStatusMeta({ ...skill, status: resolvedStatus });
    const selected = id === state.learningSelectedSkillId;
    const reason = skill.changeReason || skill.change_reason || skill.reason || skill.rationale || skill.summary || "由近期高频修订与成功翻译轨迹提出。";
    const sanitizationWarnings = skill.metadata?.sanitization?.warnings || skill.metadata?.sanitization_warnings || [];
    const sanitizationNote = sanitizationWarnings.length
      ? `<div class="learning-auto-note" title="模型补丁中超出白名单、越界或疑似注入的内容已被净化，不影响候选生成。">模型补丁已净化 ${sanitizationWarnings.length} 处：${escapeHtml(String(sanitizationWarnings[0].reason || sanitizationWarnings[0] || ""))}${sanitizationWarnings.length > 1 ? " 等" : ""}</div>`
      : "";
    const rules = learningRules(skill);
    const evidenceCount = Number(skill.evidenceCount ?? skill.evidence_count ?? skill.trajectoryCount ?? skill.trajectory_count) || learningArray(skill.evidence || skill.evidenceIds || skill.evidence_ids).length;
    const canActivate = Boolean(evaluation && baselineCurrent && evaluationPassed(evaluation, skill));
    const insufficient = evaluation && ["insufficient", "needs_review"].includes(String(evaluationResult.status || evaluation.decision || "").toLowerCase());
    const footerText = !baselineCurrent
      ? "该候选基于旧冠军生成，不能再晋升；请拒绝它，并从当前冠军重新生成候选。"
      : !evaluation
        ? "尚未与当前冠军进行隔离评测。"
        : canActivate
          ? "已在当前冠军基线上通过完整门槛，可由人工批准启用。"
          : insufficient
            ? "未参与本候选学习的人工终稿不足 20 条，当前没有形成优劣结论。"
            : "评测门槛未通过，不能进入生产。";
    return `<article class="learning-skill-card candidate ${selected ? "selected" : ""}" data-learning-select="${escapeHtml(id)}" tabindex="0">
      <div class="learning-skill-head"><div><span class="learning-skill-version">${escapeHtml(learningVersion(skill))}</span><h3>${escapeHtml(learningSkillTitle(skill))}</h3><small>${evidenceCount} 条来源证据${skill.createdAt || skill.created_at ? ` · ${escapeHtml(formatLearningDate(skill.createdAt || skill.created_at))}` : ""}</small></div><span class="learning-status ${statusClass}">${statusLabel}</span></div>
      <div class="learning-change-reason"><span>为什么提出这次变更</span><p>${escapeHtml(reason)}</p></div>
      ${sanitizationNote}
      ${rules.length ? `<details class="learning-change-details"><summary>查看 ${rules.length} 项候选执行配置</summary>${rules.map((rule) => `<p>${escapeHtml(rule)}</p>`).join("")}</details>` : ""}
      <div class="learning-card-footer"><small>${escapeHtml(footerText)}</small><div class="learning-actions"><button class="button secondary small" type="button" data-learning-action="evaluate" data-skill-id="${escapeHtml(id)}" ${baselineCurrent ? "" : "disabled"}>${evaluation ? "重新评测" : "运行评测"}</button><button class="button primary small" type="button" data-learning-action="activate" data-skill-id="${escapeHtml(id)}" ${canActivate ? "" : "disabled"}>批准启用</button><button class="button ghost small danger" type="button" data-learning-action="reject" data-skill-id="${escapeHtml(id)}">拒绝</button></div></div>
    </article>`;
  }).join("");
}

const learningMetricLabels = {
  qaScore: ["AIQA 平均分", "分", true], qa_score: ["AIQA 平均分", "分", true],
  termAccuracy: ["术语正确率", "%", true], term_accuracy: ["术语正确率", "%", true], mandatoryTermAccuracy: ["强制术语正确率", "%", true],
  acceptanceRate: ["相对人工终稿的近似通过率", "%", true], acceptance_rate: ["相对人工终稿的近似通过率", "%", true], humanAcceptanceRate: ["相对人工终稿的近似通过率", "%", true],
  editDistance: ["相对人工终稿的编辑距离", "%", false], edit_distance: ["相对人工终稿的编辑距离", "%", false], humanEditDistance: ["相对人工终稿的编辑距离", "%", false],
  hardErrorRate: ["硬错误率", "%", false], hard_error_rate: ["硬错误率", "%", false], hardErrorCount: ["硬错误数", "", false], hardErrorFreeRate: ["无硬错误率", "%", true],
  averageCost: ["平均模型成本", "", false], averageLatencyMs: ["平均延迟", "ms", false]
};

function learningNumber(value) {
  return value === null || value === undefined || value === "" ? Number.NaN : Number(value);
}

function learningMetricDefinition(key, fallbackLabel = "", fallbackUnit = "", fallbackHigher = true) {
  const definition = learningMetricLabels[key];
  return definition || [fallbackLabel || key, fallbackUnit, fallbackHigher];
}

function normalizeLearningMetrics(evaluation = {}) {
  const result = learningEvaluationResult(evaluation);
  if (Array.isArray(result.metrics)) return result.metrics.map((metric, index) => {
    const key = metric.key || metric.name || `metric-${index}`;
    const [label, unit, higher] = learningMetricDefinition(key, metric.label || `指标 ${index + 1}`, metric.unit || "", metric.higherIsBetter ?? metric.higher_is_better ?? true);
    return {
      key, label, unit: metric.unit || unit, higher: metric.higherIsBetter ?? metric.higher_is_better ?? higher,
      champion: learningNumber(metric.champion ?? metric.baseline ?? metric.control),
      candidate: learningNumber(metric.candidate ?? metric.challenger ?? metric.value),
      delta: learningNumber(metric.delta)
    };
  });
  const baseline = result.championMetrics || result.champion_metrics || result.champion || result.baseline || result.baselineMetrics || result.baseline_metrics || {};
  const candidate = result.challengerMetrics || result.challenger_metrics || result.candidate || result.challenger || result.candidateMetrics || result.candidate_metrics || {};
  const metricObject = result.metrics && typeof result.metrics === "object" ? result.metrics : {};
  const preferredKeys = ["mandatoryTermAccuracy", "hardErrorCount", "hardErrorFreeRate", "qaScore", "humanEditDistance", "humanAcceptanceRate"];
  const keys = [...new Set([...preferredKeys.filter((key) => key in baseline || key in candidate), ...Object.keys(metricObject)])];
  if (baseline.cost || candidate.cost) keys.push("averageCost");
  if (baseline.latencyMs || candidate.latencyMs) keys.push("averageLatencyMs");
  return keys.map((key) => {
    const item = metricObject[key];
    const definition = learningMetricLabels[key] || [key, item?.unit || "", item?.higherIsBetter ?? item?.higher_is_better ?? true];
    const baselineValue = key === "averageCost" ? baseline.cost?.average : key === "averageLatencyMs" ? baseline.latencyMs?.average : baseline[key];
    const candidateValue = key === "averageCost" ? candidate.cost?.average : key === "averageLatencyMs" ? candidate.latencyMs?.average : candidate[key];
    return {
      key, label: item?.label || definition[0], unit: item?.unit || definition[1], higher: item?.higherIsBetter ?? item?.higher_is_better ?? definition[2],
      champion: learningNumber(item?.champion ?? item?.baseline ?? baselineValue), candidate: learningNumber(item?.candidate ?? item?.challenger ?? item?.value ?? candidateValue), delta: learningNumber(item?.delta ?? result.deltas?.[key] ?? result.metricDeltas?.[key] ?? result.metric_deltas?.[key])
    };
  }).filter((metric) => Number.isFinite(metric.champion) || Number.isFinite(metric.candidate));
}

function learningMetricDisplay(value, unit) {
  if (!Number.isFinite(value)) return "—";
  const normalized = unit === "%" && Math.abs(value) <= 1 ? value * 100 : value;
  return `${normalized.toFixed(Math.abs(normalized) >= 100 ? 0 : 1)}${unit}`;
}

function renderLearningEvaluation(candidate, evaluation, champion) {
  const matrix = $("#learningEvaluationMatrix");
  if (!candidate || !evaluation) {
    matrix.innerHTML = '<div class="empty-list learning-empty"><div><strong>还没有可对比的评测</strong><span>在候选卡片底部运行评测，结果会在这里与当前冠军逐项比较。</span></div></div>';
    return;
  }
  const metrics = normalizeLearningMetrics(evaluation);
  const result = learningEvaluationResult(evaluation);
  const passed = evaluationPassed(evaluation, candidate);
  const evaluationStatus = String(result.status || evaluation.decision || "").toLowerCase();
  const insufficient = ["insufficient", "needs_review"].includes(evaluationStatus);
  const currentChampionId = learningId(champion);
  const evaluatedChampionId = String(evaluation.championSkillId || evaluation.champion_skill_id || result.championId || result.champion_id || "");
  const stale = Boolean(currentChampionId && evaluatedChampionId && currentChampionId !== evaluatedChampionId);
  const comparisonLabel = stale ? "旧冠军基线评测" : insufficient ? "证据不足 · 暂不形成优劣结论" : "已完成 Champion / Challenger 对比";
  const gateClass = stale ? "stale" : insufficient ? "insufficient" : passed ? "passed" : "failed";
  const gateLabel = stale ? "基线已过期" : insufficient ? "留出样本不足" : passed ? "通过晋升门槛" : "未通过晋升门槛";
  const evaluationBasis = result.evaluationBasis || "编辑距离与近似通过率均由候选译文相对人工批准终稿自动计算，不代表新增人工投票或主观打分。";
  const conclusion = result.reportZh || (typeof evaluation.report === "string" ? evaluation.report : "") || result.conclusion || result.summary || result.reason || (passed ? "候选通过全部晋升门槛。" : "候选尚未通过全部晋升门槛。将在批准前保持隔离。 ");
  matrix.innerHTML = `<div class="learning-evaluation-title"><div><span>${escapeHtml(comparisonLabel)}</span><strong>${escapeHtml(learningSkillTitle(candidate))} ${escapeHtml(learningVersion(candidate))}</strong></div><span class="learning-gate ${gateClass}">${gateLabel}</span></div>
    <p class="learning-evaluation-basis">${escapeHtml(evaluationBasis)}</p>
    ${metrics.length ? `<div class="learning-metric-table"><div class="learning-metric-row heading"><span>指标</span><span>当前冠军</span><span>候选版本</span><span>变化</span></div>${metrics.map((metric) => {
      const rawDelta = Number.isFinite(metric.delta) ? metric.delta : metric.candidate - metric.champion;
      const improved = metric.higher ? rawDelta >= 0 : rawDelta <= 0;
      return `<div class="learning-metric-row"><strong>${escapeHtml(metric.label)}</strong><span>${learningMetricDisplay(metric.champion, metric.unit)}</span><span>${learningMetricDisplay(metric.candidate, metric.unit)}</span><span class="metric-delta ${improved ? "positive" : "negative"}">${rawDelta > 0 ? "+" : ""}${learningMetricDisplay(rawDelta, metric.unit)}</span></div>`;
    }).join("")}</div>` : '<div class="empty-list learning-empty">评测已完成，但服务端没有返回可展示的指标。</div>'}
    <p class="learning-evaluation-conclusion">${escapeHtml(conclusion)}</p>`;
}

function renderLearningEvidence(evidence, candidates) {
  const nested = candidates.flatMap((skill) => learningArray(skill.evidence || skill.references).map((item) => ({ ...item, skillId: learningId(skill) })));
  const allRows = validLearningTrajectories(evidence.length ? evidence : nested);
  const rows = allRows.slice(0, 30);
  const selectedCandidate = candidates.find((item) => learningId(item) === state.learningSelectedSkillId);
  const selectedEvidenceIds = new Set(learningArray(selectedCandidate?.evidenceIds || selectedCandidate?.evidence_ids).map(String));
  $("#learningEvidenceCount").textContent = allRows.length > rows.length ? `${allRows.length} 条证据 · 显示 ${rows.length}` : `${allRows.length} 条证据`;
  $("#learningEvidenceList").innerHTML = rows.length ? rows.map((item) => {
    const accepted = item.humanDecision?.accepted === true || item.human_decision?.accepted === true;
    const typeLabel = accepted ? "人工采纳轨迹" : item.status === "review" ? "待复核轨迹" : "完成轨迹";
    const attribution = item.attribution || {};
    const title = item.title || item.reason || item.changeReason || item.change_reason || item.summary
      || ({ improved: "发现正向改进信号", needs_learning: "发现需要继续学习的修订信号", observed: "已记录轨迹，尚不能可靠归因" }[attribution.outcome])
      || "已记录完成轨迹，尚未形成可靠归因";
    const attributionText = String(attribution.reportZh || attribution.report || "").slice(0, 800);
    const source = item.source || item.sourceText || item.source_text || "";
    const target = item.correctedTranslation || item.corrected_translation || item.finalTranslation || item.final_translation || item.translation || item.target || "";
    const ref = item.taskId || item.task_id || item.trajectoryId || item.trajectory_id || item.id || "";
    const linked = selectedEvidenceIds.has(String(item.id || ref));
    return `<article class="learning-evidence-item ${linked ? "linked" : ""}"><div class="learning-evidence-meta"><span>${escapeHtml(typeLabel)}</span><small>${escapeHtml(ref ? `#${String(ref).slice(0, 12)}` : "可追溯来源")}${linked ? " · 本候选来源" : ""}${item.createdAt || item.created_at ? ` · ${escapeHtml(formatLearningDate(item.createdAt || item.created_at))}` : ""}</small></div><div><strong>${escapeHtml(title)}</strong>${attributionText ? `<p class="learning-evidence-reason">${escapeHtml(attributionText)}</p>` : ""}${source ? `<p>${escapeHtml(source)}</p>` : ""}${target ? `<p class="learning-evidence-target">→ ${escapeHtml(target)}</p>` : ""}</div></article>`;
  }).join("") : '<div class="empty-list learning-empty"><div><strong>当前范围还没有学习证据</strong><span>完成翻译、AIQA 修订或人工采纳后，证据会连同轨迹编号出现在这里。</span></div></div>';
}

function renderLearning() {
  if (!state.learningData) return;
  const { payload, champion, candidates, evaluations, evidence } = learningPayload();
  const trajectories = validLearningTrajectories(payload.trajectories || evidence);
  const scopedSkills = learningArray(payload.skills).filter(learningScopeMatches);
  const trajectoryCount = trajectories.length;
  const skillCount = scopedSkills.length || candidates.length + (champion ? 1 : 0);
  const pendingCount = candidates.filter((skill) => !learningEvaluationFor(skill, evaluations)).length;
  $("#learningTrajectoryCount").textContent = trajectoryCount.toLocaleString("zh-CN");
  $("#learningSkillCount").textContent = skillCount.toLocaleString("zh-CN");
  $("#learningPendingCount").textContent = pendingCount.toLocaleString("zh-CN");
  renderLearningChampion(champion);
  renderLearningCandidates(candidates, evaluations, champion, trajectoryCount);
  const selected = candidates.find((item) => learningId(item) === state.learningSelectedSkillId) || candidates[0];
  renderLearningEvaluation(selected, selected ? learningEvaluationFor(selected, evaluations) : null, champion);
  renderLearningEvidence(evidence, candidates);
  bindLearningCardEvents();
  refreshActions();
}

function bindLearningCardEvents() {
  $$("[data-learning-select]").forEach((card) => {
    const select = () => { state.learningSelectedSkillId = card.dataset.learningSelect; renderLearning(); };
    card.addEventListener("click", (event) => { if (!event.target.closest("button, summary, a")) select(); });
    card.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); select(); } });
  });
  $$("[data-learning-action]").forEach((button) => button.addEventListener("click", () => runLearningAction(button.dataset.skillId, button.dataset.learningAction, button)));
}

async function loadLearning(locale = state.learningLocale) {
  state.learningLocale = locale;
  renderLocaleStrip($("#learningLocales"), locale, loadLearning);
  $("#learningError").hidden = true;
  state.learningLoading = true;
  refreshActions();
  try {
    const scope = learningActionBody();
    const params = new URLSearchParams({ locale, contentType: scope.contentType, domain: scope.domain, project: scope.project });
    state.learningData = await api(`/api/learning?${params}`);
    state.learningLoading = false;
    renderLearning();
  } catch (error) {
    state.learningData = null;
    state.learningLoading = false;
    $("#learningErrorMessage").textContent = error.message;
    $("#learningError").hidden = false;
    $("#learningTrajectoryCount").textContent = "—";
    $("#learningSkillCount").textContent = "—";
    $("#learningPendingCount").textContent = "—";
    $("#learningChampionStatus").textContent = "未加载";
    $("#learningCandidateCount").textContent = "—";
    $("#learningEvidenceCount").textContent = "—";
    $("#learningChampion").innerHTML = '<div class="empty-list learning-empty">学习数据读取失败</div>';
    $("#learningCandidateList").innerHTML = '<div class="empty-list learning-empty">学习数据读取失败</div>';
    $("#learningEvaluationMatrix").innerHTML = '<div class="empty-list learning-empty">学习数据读取失败</div>';
    $("#learningEvidenceList").innerHTML = '<div class="empty-list learning-empty">学习数据读取失败</div>';
    refreshActions();
  }
}

function learningActionBody() {
  return { locale: state.learningLocale, contentType: $("#learningContentType").value, domain: $("#learningDomain").value, project: "default" };
}

async function runLearningAction(skillId, action, button) {
  if (!skillId) return toast("技能缺少可操作的版本 ID");
  if (action === "evaluate") return runSkillEvaluation(skillId, button);
  const prompts = { activate: "确认批准这个候选并替换当前生产冠军？原冠军仍可回滚。", reject: "确认拒绝这个候选技能？它会保留在审计记录中。", rollback: "确认回滚到上一已验证版本？当前版本不会被删除。" };
  if (prompts[action] && !confirm(prompts[action])) return;
  const original = button?.textContent;
  if (button) { button.disabled = true; button.textContent = "处理中……"; }
  try {
    await api(`/api/learning/skills/${encodeURIComponent(skillId)}/${action}`, { method: "POST", body: JSON.stringify(learningActionBody()) });
    toast({ activate: "候选已批准并成为生产冠军", reject: "候选已拒绝", rollback: "已回滚到上一验证版本" }[action] || "操作已完成");
    await loadLearning(state.learningLocale);
  } catch (error) {
    toast(error.message);
    if (button) { button.disabled = false; button.textContent = original; }
  }
}

async function runSkillEvaluation(skillId, button) {
  const original = button?.textContent;
  try {
    const created = await api(`/api/learning/skills/${encodeURIComponent(skillId)}/evaluate`, { method: "POST", body: JSON.stringify(learningActionBody()) });
    if (!created.jobId) {
      // 留出集不足 20 条：服务端已生成可审计的 insufficient 结论，无需模型调用。
      toast(created.result?.conclusion || "证据不足，暂不能发起真实评测");
      await loadLearning(state.learningLocale);
      return;
    }
    if (created.alreadyRunning) toast("该候选已有进行中的评测任务，已接续跟踪");
    await watchEvaluationJob(created.jobId, button, original);
    await loadLearning(state.learningLocale);
  } catch (error) {
    toast(error.message);
    if (button) { button.disabled = false; button.textContent = original; }
  }
}

async function watchEvaluationJob(jobId, button, original) {
  const deadline = Date.now() + 2 * 60 * 60 * 1000;
  while (Date.now() < deadline) {
    let job;
    try {
      ({ job } = await api(`/api/learning/evaluation-jobs/${encodeURIComponent(jobId)}`));
    } catch (error) {
      toast(error.message);
      if (button) { button.disabled = false; button.textContent = original; }
      return;
    }
    const { requested, completed, failed } = job.progress;
    if (button) {
      button.disabled = true;
      button.textContent = `评测中 ${completed}/${requested}${failed ? `（${failed} 失败）` : ""}……`;
    }
    if (job.status === "interrupted") {
      try {
        ({ job } = await api(`/api/learning/evaluation-jobs/${encodeURIComponent(jobId)}/resume`, { method: "POST" }));
      } catch (error) {
        toast(`评测任务无法续跑：${error.message}`);
        return;
      }
    }
    if (["completed", "failed"].includes(job.status)) {
      if (job.status === "completed") {
        const report = job.result?.report;
        toast(report?.promotable ? "候选评测完成并通过晋升门槛，可批准启用" : `候选评测完成：${report?.conclusion || "未通过晋升门槛"}`);
      } else {
        toast(`评测任务失败：${job.error || "未知错误"}`);
      }
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 2500));
  }
  toast("评测任务长时间未结束，请稍后在学习中心查看");
}

async function generateLearningSkill() {
  setBusy(true, "正在提炼候选技能……");
  try {
    const result = await api("/api/learning/skills/generate", { method: "POST", body: JSON.stringify(learningActionBody()) });
    const generated = result.skill || result.candidate || result.data;
    if (generated) state.learningSelectedSkillId = learningId(generated);
    toast("已根据近期轨迹生成隔离候选，下一步请运行评测");
    await loadLearning(state.learningLocale);
  } catch (error) { toast(error.message); }
  finally { setBusy(false); }
}

async function cleanTable() {
  if (!state.importFile) return toast("请先选择表格");
  setBusy(true, "识别与清洗中…");
  state.importBatchLearning = [];
  renderImportBatchLearning();
  const progressId = globalThis.crypto?.randomUUID?.() || `import-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const progressControl = { done: false };
  const progressWatcher = watchImportProgress(progressId, progressControl);
  try {
    const result = await api("/api/term-import/preview", { method: "POST", body: JSON.stringify({
      filename: state.importFile.name,
      base64: await fileToBase64(state.importFile),
      progressId
    }) });
    result.candidates.forEach((candidate) => { candidate.selected = candidate.decision === "ready" && !candidate.existing; });
    state.importPreview = result;
    state.importCompleted = false;
    const mappings = result.sheets.map((sheet) => `${sheet.sheet}：中文列 ${sheet.sourceColumn}，目标列 ${Object.entries(sheet.targetColumns).map(([locale, column]) => `${state.bootstrap.locales[locale].shortLabel} ${column}`).join(" / ")}`).join("；");
    const structureText = result.structureAnalysis?.used
      ? "AI 已识别列结构（支持无表头）"
      : result.structureAnalysis?.requested ? "AI 结构识别不可用，已回退本地整列推断" : "使用本地整列推断";
    const aiText = result.ai?.used ? `AI 已复核 ${result.ai.reviewed} 条` : result.ai?.requested ? `AI 清洗不可用，已回退本地规则` : "使用本地规则清洗";
    $("#mappingNote").textContent = `${mappings}。${structureText}；${aiText}。候选不会在确认前写入正式术语库。`;
    renderImportCandidates();
    toast(`已筛出 ${result.candidates.length} 组候选，请审核后导入`);
  } catch (error) {
    updateImportProgress({ message: `识别失败：${error.message}`, percent: 100 });
    toast(error.message);
  }
  finally {
    progressControl.done = true;
    await progressWatcher;
    setBusy(false);
  }
}

async function commitImport() {
  if (!state.importPreview) return;
  if (!selectedCandidates().length) return toast("请至少选择一组候选资产");
  setBusy(true, "正在分库写入…");
  try {
    const result = await api("/api/term-import/commit", { method: "POST", body: JSON.stringify({
      batchId: state.importPreview.batchId,
      filename: state.importPreview.filename,
      candidates: state.importPreview.candidates
    }) });
    state.importCompleted = true;
    const importedIds = new Set(result.imported.map((item) => `${item.locale}\u0000${item.source}\u0000${item.target}`));
    state.importPreview.candidates.forEach((candidate) => {
      if (importedIds.has(`${candidate.locale}\u0000${candidate.source}\u0000${candidate.target}`)) candidate.existing = true;
      candidate.selected = false;
    });
    state.importBatchLearning = learningRunsFromPayload(result, { includeProfileFallback: true });
    renderImportBatchLearning();
    const pendingStyles = (result.styleFallbacks || []).slice(0, 4).map((item) => `${state.bootstrap.locales[item.locale]?.shortLabel || item.locale} ${contentTypeLabel(item.contentType)} ${item.evidenceCount}/${item.threshold}`).join("；");
    const learnedText = state.importBatchLearning.length ? `本批已形成 ${state.importBatchLearning.length} 个风格学习范围，具体内容见下方。` : "本批没有生成可展示的风格学习结果。";
    $("#mappingNote").textContent = `批次已完成：写入术语 ${result.summary.terms || 0} 条、完整译例 / 风格证据 ${result.summary.memories || 0} 条、生成风格草稿 ${result.summary.styleProfiles || 0} 个，跳过 ${result.skipped.length} 条。${learnedText}${pendingStyles ? ` 尚在积累：${pendingStyles}。` : ""}所有资产均按目标语言与自动识别语体隔离。`;
    renderImportCandidates();
    await Promise.all([...new Set(result.imported.filter((item) => item.assetType === "term").map((item) => item.locale))].map((locale) => loadAssets(locale)));
    toast(`已导入 ${result.summary.terms || 0} 条术语和 ${result.summary.memories || 0} 条翻译记忆`);
  } catch (error) { toast(error.message); }
  finally { setBusy(false); }
}

function populateSelects() {
  const contentOptions = Object.entries(state.bootstrap.contentTypes).map(([value, details]) => `<option value="${value}">${details.label}</option>`).join("");
  $("#contentType").insertAdjacentHTML("beforeend", contentOptions);
  $("#assetForm select[name=contentType]").innerHTML = contentOptions;
  $("#learningContentType").innerHTML = contentOptions;
  $("#autoQaContentType").insertAdjacentHTML("beforeend", contentOptions);
  if ([...$("#learningContentType").options].some((option) => option.value === "general")) $("#learningContentType").value = "general";
  $("#taskLocale").insertAdjacentHTML("beforeend", Object.entries(state.bootstrap.locales).map(([locale, details]) => `<option value="${locale}">${details.label}</option>`).join(""));
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
    else if (state.view === "tasks") loadTasks().catch((error) => toast(error.message));
    else if (state.view === "styles") loadStyleGuidance(state.styleLocale).catch((error) => toast(error.message));
    else if (state.view === "learning") generateLearningSkill();
    else if (state.view === "autoqa") runAutoQa().catch((error) => toast(error.message));
    else if (state.view === "feedback") loadFeedbackPage().catch((error) => toast(error.message));
    else $("#assetDialog").showModal();
  });
  $("#secondaryAction").addEventListener("click", () => {
    if (state.view === "autoqa") return clearAutoQa();
    return state.view === "workbench" ? (state.translationMode === "batch" ? resetBatch() : clearTranslation()) : resetImport();
  });
  $("#tertiaryAction").addEventListener("click", async () => {
    if (state.view === "workbench" && state.translationMode === "batch") return exportBatch();
    await navigator.clipboard.writeText(state.lastResult.translation);
    toast("译文已复制");
  });
  $("#sourceText").addEventListener("input", previewClassificationAndMatches);
  $("#sourceText").addEventListener("paste", (event) => {
    const text = event.clipboardData?.getData("text/plain") || "";
    if (!shouldRoutePasteToBatch(text)) return;
    event.preventDefault();
    loadPastedTextAsBatch(text).catch((error) => toast(error.message));
  });
  $("#contentType").addEventListener("change", () => {
    previewClassificationAndMatches();
    invalidateBatchTranslations("批次语体已改变，请重新运行翻译");
  });
  $("#domain").addEventListener("change", () => {
    previewClassificationAndMatches();
    invalidateBatchTranslations("批次领域已改变，请重新运行翻译");
  });
  $("#autoQaSource").addEventListener("input", () => {
    $("#autoQaSourceCount").textContent = `${[...$("#autoQaSource").value].length} 字`;
    $("#autoQaState").textContent = "等待质检";
    $("#autoQaState").className = "badge neutral";
    refreshActions();
  });
  $("#autoQaTarget").addEventListener("input", () => {
    $("#autoQaState").textContent = "等待质检";
    $("#autoQaState").className = "badge neutral";
    refreshActions();
  });
  ["autoQaSource", "autoQaTarget"].forEach((id) => $(`#${id}`).addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) runAutoQa().catch((error) => toast(error.message));
  }));
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
  $("#batchPasteText").addEventListener("paste", (event) => {
    const text = event.clipboardData?.getData("text/plain") || "";
    if (!shouldRoutePasteToBatch(text)) return;
    event.preventDefault();
    loadPastedTextAsBatch(text).catch((error) => toast(error.message));
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
  $("#taskLocale").addEventListener("change", loadTasks);
  $("#taskStatus").addEventListener("change", loadTasks);
  $("#taskType").addEventListener("change", loadTasks);
  $("#taskSearch").addEventListener("input", () => { clearTimeout(state.taskSearchTimer); state.taskSearchTimer = setTimeout(() => loadTasks().catch((error) => toast(error.message)), 250); });
  $("#refreshTasks").addEventListener("click", () => loadTasks().catch((error) => toast(error.message)));
  $("#styleStatus").addEventListener("change", renderStyleGuidance);
  $("#refreshStyles").addEventListener("click", () => loadStyleGuidance(state.styleLocale).catch((error) => toast(error.message)));
  $("#retryLearning").addEventListener("click", () => loadLearning(state.learningLocale));
  $("#learningContentType").addEventListener("change", () => loadLearning(state.learningLocale));
  $("#learningDomain").addEventListener("change", () => loadLearning(state.learningLocale));
  $("#termFile").addEventListener("change", (event) => setImportFile(event.target.files[0]));
  $("#dropZone").addEventListener("dragover", (event) => { event.preventDefault(); $("#dropZone").classList.add("dragging"); });
  $("#dropZone").addEventListener("dragleave", () => $("#dropZone").classList.remove("dragging"));
  $("#dropZone").addEventListener("drop", (event) => { event.preventDefault(); $("#dropZone").classList.remove("dragging"); setImportFile(event.dataTransfer.files[0]); });
  $$('[data-import-candidate-tab]').forEach((button) => button.addEventListener("click", () => setImportCandidateTab(button.dataset.importCandidateTab)));
  [["#selectAllTermCandidates", "terms"], ["#selectAllStyleCandidates", "styles"]].forEach(([selector, kind]) => $(selector).addEventListener("change", (event) => {
    indexedImportCandidates(kind).forEach(({ candidate }) => { if (!candidate.existing && candidate.decision !== "excluded") candidate.selected = event.target.checked; });
    renderImportCandidates();
  }));
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
  $("#feedbackBell").addEventListener("click", () => {
    switchView("feedback");
    loadFeedbackPage().catch((error) => toast(error.message));
  });
  $("#refreshFeedback").addEventListener("click", () => loadFeedbackPage().catch((error) => toast(error.message)));
  $("#feedbackStatusFilter").addEventListener("change", () => {
    state.feedbackStatusFilter = $("#feedbackStatusFilter").value;
    renderFeedbackPage();
  });
  $("#openProvider").addEventListener("click", () => {
    const provider = state.bootstrap.provider;    $("#providerForm [name=baseUrl]").value = provider.baseUrl;
    $("#providerForm [name=model]").value = provider.model;
    $("#providerForm [name=embeddingModel]").value = provider.embeddingModel || "";
    $("#providerForm [name=embeddingBaseUrl]").value = provider.embeddingBaseUrl || "";
    $("#providerForm [name=inputPricePerMTok]").value = provider.inputPricePerMTok || "";
    $("#providerForm [name=outputPricePerMTok]").value = provider.outputPricePerMTok || "";
    const apiKeyInput = $("#providerForm [name=apiKey]");
    apiKeyInput.value = "";
    apiKeyInput.placeholder = provider.apiKeyConfigured ? "已配置 · 留空保持不变" : "未配置 · 如需鉴权请填写";
    const embeddingKeyInput = $("#providerForm [name=embeddingApiKey]");
    embeddingKeyInput.value = "";
    embeddingKeyInput.placeholder = provider.embeddingApiKeyConfigured ? "已配置 · 留空保持不变" : "未配置 · 留空复用主 Key";
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
  $("#toggleTargetEdit").addEventListener("click", toggleTargetEdit);
  $("#acceptTranslation").addEventListener("click", acceptSingleTranslation);
  $("#acceptAllSegments").addEventListener("click", acceptAllSegments);
  $$('[data-close]').forEach((button) => button.addEventListener("click", () => $(`#${button.dataset.close}`).close()));
}

async function initialize() {
  try {
    const [bootstrap, health] = await Promise.all([api("/api/bootstrap"), api("/api/health")]);
    state.bootstrap = bootstrap;
    state.serverVersion = health.version || "0.0.0";
    const fallback = bootstrap.storeFallback || health.storeFallback;
    if (fallback?.active) {
      const banner = $("#storeFallbackBanner");
      banner.hidden = false;
      banner.textContent = `资产后台（Directus）不可用，已回退到本地 JSON 存储：${fallback.reason}。当前写入保存在 data/ 下；Directus 恢复后重启服务即可回到资产后台模式（回退期间的写入不会自动同步）。`;
    }
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
    renderLocaleStrip($("#styleLocales"), state.styleLocale, updateStyleLocale);
    renderLocaleStrip($("#learningLocales"), state.learningLocale, loadLearning);
    renderLocaleStrip($("#autoQaLocales"), state.autoQaLocale, updateAutoQaLocale);
    bindEvents();
    setTranslationMode("single");
    await loadAssets(state.assetLocale);
    updateWorkbenchLocale(state.workbenchLocale);
    updateAutoQaLocale(state.autoQaLocale);
    startFeedbackPolling();
    refreshActions();
    await restoreBatchProgress();
  } catch (error) {
    $("#serverStatus").textContent = "连接失败";
    $("#providerLabel").textContent = error.message;
  }
}

initialize();
