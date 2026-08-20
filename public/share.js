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

function dimensionBadges(dimensionScores) {
  if (!dimensionScores) return "";
  return Object.entries(DIMENSION_LABELS).map(([dimension, label]) =>
    `<span class="autoqa-segment-metric ${scoreTone(Number(dimensionScores[dimension]) ?? 100)}"><i>${Number(dimensionScores[dimension]) ?? "—"}</i>${label}</span>`).join("");
}

function renderMeta(meta) {
  if (!meta || meta.source !== "autoqa") return "";
  const scoreCards = `<div class="autoqa-score-row share-score-row">
      <div class="autoqa-score-card overall"><strong>${Number.isFinite(meta.overallScore) ? meta.overallScore : "—"}</strong><span>综合分</span><small>基本 20% · 忠实性 50% · Nuance 30%</small></div>
      ${Object.entries(DIMENSION_LABELS).map(([dimension, label]) => {
        const value = Number(meta.dimensionScores?.[dimension]);
        const counts = meta.summary?.[dimension];
        const caption = counts?.total ? `${counts.total} 条问题 · 阻断 ${counts.error} · 主要 ${counts.major} · 轻微 ${counts.minor}` : "未发现问题";
        return `<div class="autoqa-score-card ${Number.isFinite(value) ? scoreTone(value) : ""}"><strong>${Number.isFinite(value) ? value : "—"}</strong><span>${escapeHtml(label)}</span><small>${escapeHtml(caption)}</small></div>`;
      }).join("")}
    </div>`;
  const alignmentNote = meta.alignmentNote ? `<p class="share-meta-note">${escapeHtml(meta.alignmentNote)}</p>` : "";
  const alignmentIssues = (meta.alignmentIssues || []).length
    ? `<div class="share-issues"><div class="share-issues-title">整句级问题（漏译 / 增译）</div>${meta.alignmentIssues.map((issue) =>
        `<div class="qa-item ${issue.severity === "critical" ? "error" : ""}"><strong>[${escapeHtml(issue.category || "alignment")}]</strong> ${escapeHtml(issue.message)}</div>`).join("")}</div>`
    : "";
  return `<section class="share-meta">${scoreCards}${alignmentNote}${alignmentIssues}</section>`;
}

function renderSegment(segment) {
  const qa = Number.isFinite(segment.qaScore)
    ? `<span class="autoqa-segment-score ${scoreTone(segment.qaScore)}">QA ${segment.qaScore}</span>`
    : "";
  const badges = dimensionBadges(segment.dimensionScores);
  const gloss = segment.gloss?.tokens?.length
    ? `<div class="share-gloss">
        ${segment.gloss.approximate ? '<p class="share-gloss-note">⚠️ 拆解为模型近似切分，仅供参考。</p>' : ""}
        <div class="share-gloss-tokens">${segment.gloss.tokens.map((tokenItem) =>
          `<span class="share-gloss-token"><b>${escapeHtml(tokenItem.surface)}</b><i>${escapeHtml(tokenItem.pos || "")}</i><em>${escapeHtml(tokenItem.gloss || "")}</em></span>`).join("")}</div>
        ${segment.gloss.literal ? `<p class="share-gloss-literal"><strong>字面直译</strong>${escapeHtml(segment.gloss.literal)}</p>` : ""}
        ${segment.gloss.note ? `<p class="share-gloss-note">${escapeHtml(segment.gloss.note)}</p>` : ""}
      </div>`
    : `<div class="share-gloss-empty">${shareStatus === "generating" ? "辅助拆解生成中，请稍后刷新……" : "本段未生成辅助拆解"}</div>`;
  const issues = (segment.issues || []).length
    ? `<div class="share-issues">${segment.issues.map((issue) =>
        `<div class="qa-item ${issue.severity === "error" || issue.severity === "critical" ? "error" : ""}"><strong>[${escapeHtml(issue.category || issue.type || "qa")}]</strong> ${escapeHtml(issue.message)}${issue.suggestion ? ` <small>建议：${escapeHtml(issue.suggestion)}</small>` : ""}</div>`).join("")}</div>`
    : '<div class="qa-item">该段 QA 未发现问题</div>';
  return `<article class="share-segment" data-segment-index="${segment.index}">
    <div class="share-segment-head"><span class="share-segment-index">第 ${segment.index} 段</span>${qa}<span class="share-segment-badges">${badges}</span>${segment.locator ? `<span class="share-segment-locator">${escapeHtml(segment.locator)}</span>` : ""}</div>
    <div class="autoqa-segment-pair share-pair">
      <div><span>原文（简体中文）</span><p>${escapeHtml(segment.source)}</p></div>
      <div><span>译文</span><p>${escapeHtml(segment.translation)}</p></div>
    </div>
    ${gloss}
    ${issues}
    <form class="share-feedback-form">
      <div class="share-feedback-fields">
        <input name="reviewer" placeholder="你的名字（可留空）" maxlength="80" />
        <input name="suggestedTranslation" placeholder="建议译法（可留空）" />
      </div>
      <div class="share-feedback-submit">
        <textarea name="request" required placeholder="提出具体要求，例如：这句应该用敬语体；‘登场’统一译成 ‘등장’……" rows="2"></textarea>
        <button class="button primary small" type="submit">提交要求</button>
      </div>
    </form>
  </article>`;
}

async function submitFeedback(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const segment = form.closest(".share-segment");
  const request = form.elements.request.value.trim();
  if (!request) return;
  const button = form.querySelector("button[type=submit]");
  button.disabled = true;
  button.textContent = "提交中…";
  try {
    await api(`/api/share/${encodeURIComponent(token)}/feedback`, {
      method: "POST",
      body: JSON.stringify({
        segmentIndex: Number(segment.dataset.segmentIndex),
        request,
        suggestedTranslation: form.elements.suggestedTranslation.value.trim(),
        reviewer: form.elements.reviewer.value.trim()
      })
    });
    toast("已提交，感谢反馈！");
    form.reset();
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
    button.textContent = "提交要求";
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
    const pending = payload.feedbackCount;
    $("#shareSummary").hidden = false;
    $("#shareSummary").innerHTML = `<span>共 ${payload.segments.length} 段</span><span>已收反馈 ${pending} 条</span>`;
    if (shareStatus === "generating") {
      $("#shareGeneratingBanner").hidden = false;
      $("#shareGeneratingText").textContent = `语素拆解与字面直译正在后台生成（${payload.glossedSegments} / ${Math.min(payload.totalSegments, 30)}），页面会自动刷新；您可以先查看原文、译文与评分。`;
      pollGlossStatus(token);
    }
    $("#shareSegments").innerHTML = (payload.segments.length || payload.meta)
      ? `${renderMeta(payload.meta)}${payload.segments.map(renderSegment).join("")}`
      : '<div class="empty-list">该分享没有可展示的段落。</div>';
    $$(".share-feedback-form").forEach((form) => form.addEventListener("submit", submitFeedback));
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
