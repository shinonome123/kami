const token = decodeURIComponent(location.pathname.replace(/^\/share\/?/, ""));
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
let shareStatus = "ready";

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
}

let toastTimer;
function toast(message) {
  const element = $("#toast");
  element.textContent = message;
  element.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.classList.remove("show"), 3200);
}

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { "content-type": "application/json", ...(options.headers || {}) } });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `请求失败：${response.status}`);
  return payload;
}

const DIMENSION_LABELS = { basic: "基本", fidelity: "忠实性", nuance: "Nuance" };

function scoreTone(score) {
  return score >= 90 ? "good" : score >= 70 ? "warn" : "bad";
}

function dimensionBadges(dimensionScores, modelIncomplete = false) {
  if (!dimensionScores) return "";
  return Object.entries(DIMENSION_LABELS).map(([dimension, label]) =>
    `<span class="autoqa-segment-metric ${modelIncomplete ? "" : scoreTone(Number(dimensionScores[dimension]) ?? 100)}"><i>${modelIncomplete ? "—" : Number(dimensionScores[dimension]) ?? "—"}</i>${label}</span>`).join("");
}

function renderMeta(meta) {
  if (!meta || meta.source !== "autoqa") return "";
  const modelIncomplete = Boolean(meta.fallbackReason);
  const scoreCards = `<div class="autoqa-score-row share-score-row">
      <div class="autoqa-score-card overall"><strong>${!modelIncomplete && Number.isFinite(meta.overallScore) ? meta.overallScore : "—"}</strong><span>综合分</span><small>${modelIncomplete ? "模型层未完成" : "基本 20% · 忠实性 50% · Nuance 30%"}</small></div>
      ${Object.entries(DIMENSION_LABELS).map(([dimension, label]) => {
        const value = Number(meta.dimensionScores?.[dimension]);
        const counts = meta.summary?.[dimension];
        const caption = modelIncomplete ? "模型层未完成" : counts?.total ? `${counts.total} 条问题 · 阻断 ${counts.error} · 主要 ${counts.major} · 轻微 ${counts.minor}` : "未发现问题";
        return `<div class="autoqa-score-card ${!modelIncomplete && Number.isFinite(value) ? scoreTone(value) : ""}"><strong>${!modelIncomplete && Number.isFinite(value) ? value : "—"}</strong><span>${escapeHtml(label)}</span><small>${escapeHtml(caption)}</small></div>`;
      }).join("")}
    </div>`;
  const modelWarning = modelIncomplete
    ? `<div class="qa-item warning"><strong>模型质检未完成</strong>：${/Insufficient Balance|QUOTA|402/iu.test(meta.fallbackReason) ? "模型服务余额不足。" : "模型服务调用失败。"}当前只完成了本地规则检查，不能视为完整 QA 通过。</div>`
    : "";
  const alignmentNote = meta.alignmentNote ? `<p class="share-meta-note">${escapeHtml(meta.alignmentNote)}</p>` : "";
  const alignmentIssues = (meta.alignmentIssues || []).length
    ? `<div class="share-issues"><div class="share-issues-title">整句级问题（漏译 / 增译）</div>${meta.alignmentIssues.map((issue) =>
        `<div class="qa-item ${issue.severity === "critical" ? "error" : ""}"><strong>[${escapeHtml(issue.displayCategory || issue.category || "整句对齐")}]</strong> ${escapeHtml(issue.displayMessage || issue.message)}</div>`).join("")}</div>`
    : "";
  return `<section class="share-meta">${scoreCards}${modelWarning}${alignmentNote}${alignmentIssues}</section>`;
}

const FEEDBACK_STATUS_LABEL = { pending: "待处理", adopted: "已采纳", ignored: "未采纳" };

/**
 * 逐条显示这一段收到的意见和它最后被怎么处理了。
 * 只显示数量等于让审阅人把意见投进黑洞，他们下次就不提了。
 */
function renderFeedbackReceipts(feedbacks = []) {
  if (!feedbacks.length) return "";
  const rows = feedbacks.map((item) => {
    const status = item.status || "pending";
    const resolution = item.resolution;
    const detail = resolution
      ? `<p class="share-receipt-reason">${escapeHtml(resolution.actionLabel || FEEDBACK_STATUS_LABEL[status])}：${escapeHtml(resolution.reason || "")}</p>`
        + (resolution.translationChanged && resolution.afterTranslation
          ? `<p class="share-receipt-after"><span>已更新为</span>${escapeHtml(resolution.afterTranslation)}</p>`
          : "")
        + `<p class="share-receipt-meta">处理人 ${escapeHtml(resolution.decidedBy || "工作台")}${resolution.decidedAt ? ` · ${new Date(resolution.decidedAt).toLocaleString("zh-CN")}` : ""}</p>`
      : status === "pending"
        ? '<p class="share-receipt-meta">尚未处理，处理后会在这里显示结果。</p>'
        : `<p class="share-receipt-meta">已于 ${item.resolvedAt ? new Date(item.resolvedAt).toLocaleString("zh-CN") : "早前"}处理，该条早于回执功能上线，没有留下详细说明。</p>`;
    return `<li class="share-receipt-item" data-status="${escapeHtml(status)}">
      <div class="share-receipt-head">
        <span class="share-receipt-status">${escapeHtml(FEEDBACK_STATUS_LABEL[status] || status)}</span>
        <strong>${escapeHtml(item.reviewer || "匿名")}</strong>
        <small>${item.createdAt ? new Date(item.createdAt).toLocaleString("zh-CN") : ""}</small>
      </div>
      ${item.request ? `<p class="share-receipt-request">${escapeHtml(item.request)}</p>` : ""}
      ${item.suggestedTranslation ? `<p class="share-receipt-suggestion"><span>建议译法</span>${escapeHtml(item.suggestedTranslation)}</p>` : ""}
      ${detail}
    </li>`;
  }).join("");
  return `<div class="share-receipts"><div class="share-receipts-title">本段收到的意见与处理结果（${feedbacks.length}）</div><ul>${rows}</ul></div>`;
}

function renderSegment(segment, modelIncomplete = false, feedbacks = []) {
  const formId = `share-feedback-${Number(segment.index)}`;
  const qa = modelIncomplete
    ? '<span class="autoqa-segment-score">QA —</span>'
    : Number.isFinite(segment.qaScore)
    ? `<span class="autoqa-segment-score ${scoreTone(segment.qaScore)}">QA ${segment.qaScore}</span>`
    : "";
  const badges = dimensionBadges(segment.dimensionScores, modelIncomplete);
  const gloss = segment.gloss?.tokens?.length
    ? `<div class="share-gloss">
        ${segment.gloss.approximate ? '<p class="share-gloss-note">⚠️ 拆解为模型近似切分，仅供参考。</p>' : ""}
        <div class="share-gloss-tokens">${segment.gloss.tokens.map((tokenItem) =>
          `<span class="share-gloss-token"><b>${escapeHtml(tokenItem.surface)}</b><i>${escapeHtml(tokenItem.pos || "")}</i><em>${escapeHtml(tokenItem.gloss || "")}</em></span>`).join("")}</div>
        ${segment.gloss.literal ? `<p class="share-gloss-literal"><strong>字面直译</strong>${escapeHtml(segment.gloss.literal)}</p>` : ""}
        ${segment.gloss.note ? `<p class="share-gloss-note">${escapeHtml(segment.gloss.note)}</p>` : ""}
      </div>`
    : `<div class="share-gloss-empty">${shareStatus === "generating" ? "辅助拆解生成中，请稍后刷新……" : shareStatus === "failed" ? "辅助拆解生成失败" : "本段未生成辅助拆解"}</div>`;
  const issues = (segment.issues || []).length
    ? `<div class="share-issues share-known-issues">
        <div class="share-known-issues-intro"><strong>已知问题</strong><span>未勾选表示译者坚持当前译法；复核后仍需上报的问题请打勾。</span></div>
        ${segment.issues.map((issue, issueIndex) => {
          const sourceEvidence = issue.sourceSpan ? `<small class="share-known-issue-evidence"><b>原文片段</b> ${escapeHtml(issue.sourceSpan)}</small>` : "";
          const targetEvidence = issue.targetSpan ? `<small class="share-known-issue-evidence"><b>译文片段</b> ${escapeHtml(issue.targetSpan)}</small>` : "";
          return `<label class="qa-item share-known-issue ${issue.severity === "error" || issue.severity === "critical" ? "error" : ""}">
            <input type="checkbox" name="knownIssueIndexes" value="${issueIndex}" form="${formId}" />
            <span><strong>[${escapeHtml(issue.displayCategory || issue.category || issue.type || "其他问题")}]</strong> ${escapeHtml(issue.displayMessage || issue.message)}${sourceEvidence}${targetEvidence}${issue.displaySuggestion || issue.suggestion ? ` <small class="share-known-issue-suggestion"><b>建议</b> ${escapeHtml(issue.displaySuggestion || issue.suggestion)}</small>` : ""}</span>
          </label>`;
        }).join("")}
      </div>`
    : modelIncomplete
      ? '<div class="qa-item warning">本地规则未发现问题；模型质检尚未完成</div>'
      : '<div class="qa-item">该段 QA 未发现问题</div>';
  return `<article class="share-segment" data-segment-index="${segment.index}">
    <div class="share-segment-head"><span class="share-segment-index">第 ${segment.index} 段</span>${qa}<span class="share-segment-badges">${badges}</span>${segment.locator ? `<span class="share-segment-locator">${escapeHtml(segment.locator)}</span>` : ""}</div>
    <div class="autoqa-segment-pair share-pair">
      <div><span>原文（简体中文）</span><p>${escapeHtml(segment.source)}</p></div>
      <div><span>译文</span><p>${escapeHtml(segment.translation)}</p></div>
    </div>
    ${gloss}
    ${issues}
    ${renderFeedbackReceipts(feedbacks)}
    <form class="share-feedback-form" id="${formId}">
      <div class="share-feedback-fields">
        <input name="reviewer" placeholder="你的名字（可留空）" maxlength="80" />
        <input name="suggestedTranslation" placeholder="建议译法（可留空）" />
      </div>
      <div class="share-feedback-submit">
        <textarea name="request" placeholder="补充新问题或说明（可留空；仅勾选已知问题也能提交）" rows="2"></textarea>
        <button class="button primary small" type="submit">提交要求</button>
      </div>
      <p class="share-feedback-hint">未勾选的已知问题不会重复上报。</p>
    </form>
  </article>`;
}

function selectedKnownIssueIndexes(segment) {
  return [...segment.querySelectorAll('input[name="knownIssueIndexes"]:checked')].map((input) => Number(input.value));
}

function updateFeedbackButton(form) {
  const segment = form.closest(".share-segment");
  const count = selectedKnownIssueIndexes(segment).length;
  const button = form.querySelector("button[type=submit]");
  if (!button.disabled) button.textContent = count ? `提交已勾选问题（${count}）` : "提交要求";
}

async function submitFeedback(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const segment = form.closest(".share-segment");
  const request = form.elements.request.value.trim();
  const knownIssueIndexes = selectedKnownIssueIndexes(segment);
  if (!request && !knownIssueIndexes.length) {
    toast("请勾选仍需上报的已知问题，或填写新的具体要求");
    return;
  }
  const button = form.querySelector("button[type=submit]");
  button.disabled = true;
  button.textContent = "提交中…";
  try {
    await api(`/api/share/${encodeURIComponent(token)}/feedback`, {
      method: "POST",
      body: JSON.stringify({
        segmentIndex: Number(segment.dataset.segmentIndex),
        request,
        knownIssueIndexes,
        suggestedTranslation: form.elements.suggestedTranslation.value.trim(),
        reviewer: form.elements.reviewer.value.trim()
      })
    });
    toast("已提交，感谢反馈！");
    form.reset();
    updateFeedbackButton(form);
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
    updateFeedbackButton(form);
  }
}

async function initialize() {
  if (!token) {
    $("#shareError").hidden = false;
    $("#shareError").textContent = "链接缺少分享令牌。";
    return;
  }
  try {
    const [payload, bootstrap] = await Promise.all([api(`/api/share/${encodeURIComponent(token)}`), api("/api/bootstrap")]);
    shareStatus = payload.status || "ready";
    const locale = bootstrap.locales?.[payload.locale];
    document.title = `${payload.filename} · Kami 分享验证`;
    $("#shareTitle").textContent = payload.filename;
    $("#shareMeta").textContent = `${locale?.label || payload.locale} · ${payload.segments.length} 段 · ${payload.feedbackCount} 条反馈 · 分享于 ${new Date(payload.createdAt).toLocaleString("zh-CN")}`;
    const summary = payload.feedbackSummary || { total: payload.feedbackCount, pending: payload.feedbackCount, adopted: 0, ignored: 0 };
    $("#shareSummary").hidden = false;
    $("#shareSummary").innerHTML = `<span>共 ${payload.segments.length} 段</span>`
      + `<span>已收反馈 ${summary.total} 条</span>`
      + `<span>已采纳 ${summary.adopted} 条</span>`
      + `<span>未采纳 ${summary.ignored} 条</span>`
      + `<span>待处理 ${summary.pending} 条</span>`;
    if (shareStatus === "generating") {
      $("#shareGeneratingBanner").hidden = false;
      $("#shareGeneratingText").textContent = `语素拆解与字面直译正在后台生成（${payload.glossedSegments} / ${Math.min(payload.totalSegments, 30)}），页面会自动刷新；您可以先查看原文、译文与评分。`;
      pollGlossStatus(token);
    }
    if (shareStatus === "failed") {
      $("#shareError").hidden = false;
      $("#shareError").textContent = `辅助拆解生成失败：${payload.generationError || "模型服务调用失败，请由项目负责人检查模型配置或余额后重新生成分享。"} 分享链接仍可用于核对原文与译文。`;
    }
    const modelIncomplete = Boolean(payload.meta?.fallbackReason);
    const feedbacksBySegment = new Map();
    for (const item of payload.feedbacks || []) {
      const key = Number(item.segmentIndex);
      if (!feedbacksBySegment.has(key)) feedbacksBySegment.set(key, []);
      feedbacksBySegment.get(key).push(item);
    }
    $("#shareSegments").innerHTML = (payload.segments.length || payload.meta)
      ? `${renderMeta(payload.meta)}${payload.segments.map((segment) => renderSegment(segment, modelIncomplete, feedbacksBySegment.get(Number(segment.index)) || [])).join("")}`
      : '<div class="empty-list">该分享没有可展示的段落。</div>';
    $$(".share-feedback-form").forEach((form) => {
      form.addEventListener("submit", submitFeedback);
      form.closest(".share-segment").querySelectorAll('input[name="knownIssueIndexes"]').forEach((input) => {
        input.addEventListener("change", () => updateFeedbackButton(form));
      });
    });
  } catch (error) {
    $("#shareError").hidden = false;
    $("#shareError").textContent = error.message;
    $("#shareSegments").innerHTML = "";
  }
}

/** 拆解生成期间轮询：完成后自动刷新页面展示拆解结果。 */
function pollGlossStatus(shareToken) {
  let checks = 0;
  const timer = setInterval(async () => {
    checks += 1;
    try {
      const payload = await api(`/api/share/${encodeURIComponent(shareToken)}`);
      if (payload.status !== "generating") {
        clearInterval(timer);
        location.reload();
        return;
      }
      $("#shareGeneratingText").textContent = `语素拆解与字面直译正在后台生成（${payload.glossedSegments} / ${Math.min(payload.totalSegments, 30)}），页面会自动刷新；您可以先查看原文、译文与评分。`;
    } catch {
      // 网络抖动忽略，继续轮询
    }
    if (checks > 120) clearInterval(timer); // 最多等 16 分钟，避免无限轮询
  }, 8_000);
}

initialize();
