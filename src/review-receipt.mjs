/** Structured human review decisions and reviewer-facing processing receipts. */
export const REVIEW_RECEIPT_SCHEMA_VERSION = 1;
export const REVIEW_ACTIONS = Object.freeze(["accept", "partial", "reject", "revise"]);

const ACTION_LABELS = Object.freeze({
  accept: "接受",
  partial: "部分接受",
  reject: "拒绝",
  revise: "要求修订"
});

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function requiredText(value, label) {
  const normalized = text(value);
  if (!normalized) throw new TypeError(`${label}不能为空`);
  return normalized;
}

function stringList(value, label) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new TypeError(`${label}必须是数组`);
  return [...new Set(value.map((item, index) => requiredText(item, `${label}第 ${index + 1} 项`)))];
}

function displayLocation(decision) {
  return [decision.segmentId ? `句段 ${decision.segmentId}` : "", decision.field ? `字段 ${decision.field}` : ""]
    .filter(Boolean).join(" · ");
}

/**
 * A decision records disposition, explanation, and translation delta. It never
 * mutates a task or promotes an asset; integration code must apply an accepted
 * result explicitly after persisting the audit record.
 */
export function normalizeReviewDecision(input = {}, index = 0) {
  if (!isPlainObject(input)) throw new TypeError(`审阅决定第 ${index + 1} 项必须是对象`);
  const action = text(input.action || input.decision).toLowerCase();
  if (!REVIEW_ACTIONS.includes(action)) throw new TypeError(`审阅决定第 ${index + 1} 项 action 无效：${action || "空"}`);
  const acceptedParts = stringList(input.acceptedParts, `审阅决定第 ${index + 1} 项 acceptedParts`);
  const rejectedParts = stringList(input.rejectedParts, `审阅决定第 ${index + 1} 项 rejectedParts`);
  const reason = text(input.reason || input.note);
  const revisionInstruction = text(input.revisionInstruction || input.request);
  const beforeTranslation = text(input.beforeTranslation ?? input.currentTranslation);
  const afterTranslation = text(input.afterTranslation ?? input.finalTranslation);
  if (action === "partial" && (!acceptedParts.length || !rejectedParts.length)) {
    throw new TypeError("部分接受必须同时说明接受部分和未接受部分");
  }
  if (action === "reject" && !reason) throw new TypeError("拒绝审阅意见时必须填写原因");
  if (action === "revise" && !revisionInstruction && !afterTranslation) {
    throw new TypeError("要求修订时必须填写修订要求或修订后译文");
  }
  const revisionPending = action === "revise" && !afterTranslation;
  return {
    id: text(input.id) || `review-decision-${index + 1}`,
    issueId: requiredText(input.issueId, `审阅决定第 ${index + 1} 项 issueId`),
    segmentId: text(input.segmentId),
    field: text(input.field),
    category: text(input.category) || "其他问题",
    severity: text(input.severity) || "minor",
    issue: requiredText(input.issue || input.message, `审阅决定第 ${index + 1} 项 issue`),
    suggestion: text(input.suggestion),
    action,
    actionLabel: ACTION_LABELS[action],
    reason,
    acceptedParts,
    rejectedParts,
    revisionInstruction,
    beforeTranslation,
    afterTranslation,
    translationChanged: Boolean(afterTranslation) && afterTranslation !== beforeTranslation,
    resolutionStatus: revisionPending ? "pending_revision" : "resolved",
    decidedBy: text(input.decidedBy || input.reviewer),
    decidedAt: text(input.decidedAt),
    metadata: isPlainObject(input.metadata) ? structuredClone(input.metadata) : {}
  };
}

function receiptText(receipt) {
  const lines = [
    "审阅意见处理回执",
    `任务：${receipt.taskName || receipt.taskId}`,
    receipt.batchId ? `批次：${receipt.batchId}` : "",
    receipt.locale ? `目标语言：${receipt.locale}` : "",
    `处理人：${receipt.processedBy}`,
    `处理结果：共 ${receipt.summary.total} 条；接受 ${receipt.summary.accept} 条，部分接受 ${receipt.summary.partial} 条，拒绝 ${receipt.summary.reject} 条，要求修订 ${receipt.summary.revise} 条。`,
    receipt.summary.pending ? `待完成修订：${receipt.summary.pending} 条。` : "",
    ""
  ].filter((line, index) => line || index === 7);
  receipt.items.forEach((item, index) => {
    lines.push(`${index + 1}. [${item.actionLabel}] [${item.category}] ${item.issue}`);
    const location = displayLocation(item);
    if (location) lines.push(`   位置：${location}`);
    if (item.suggestion) lines.push(`   审阅建议：${item.suggestion}`);
    if (item.reason) lines.push(`   处理说明：${item.reason}`);
    if (item.acceptedParts.length) lines.push(`   已接受：${item.acceptedParts.join("；")}`);
    if (item.rejectedParts.length) lines.push(`   未接受：${item.rejectedParts.join("；")}`);
    if (item.revisionInstruction) lines.push(`   修订要求：${item.revisionInstruction}`);
    if (item.beforeTranslation) lines.push(`   修改前：${item.beforeTranslation}`);
    if (item.afterTranslation) lines.push(`   修改后：${item.afterTranslation}`);
    if (item.resolutionStatus === "pending_revision") lines.push("   状态：等待修订完成");
  });
  return lines.join("\n").trim();
}

/** Build both a structured audit artifact and a readable Chinese receipt. */
export function buildReviewReceipt(input = {}) {
  if (!isPlainObject(input)) throw new TypeError("审阅回执必须是对象");
  if (!Array.isArray(input.decisions) || !input.decisions.length) throw new TypeError("审阅回执至少需要一条决定");
  const items = input.decisions.map(normalizeReviewDecision);
  const ids = items.map((item) => item.issueId);
  if (new Set(ids).size !== ids.length) throw new RangeError("同一回执不能重复处理同一个 issueId");
  const processedBy = requiredText(input.processedBy || input.reviewer, "回执处理人");
  const counts = Object.fromEntries(REVIEW_ACTIONS.map((action) => [action, items.filter((item) => item.action === action).length]));
  const pending = items.filter((item) => item.resolutionStatus === "pending_revision").length;
  const receipt = {
    schemaVersion: REVIEW_RECEIPT_SCHEMA_VERSION,
    kind: "review_receipt",
    id: requiredText(input.id, "审阅回执 id"),
    taskId: requiredText(input.taskId, "审阅回执 taskId"),
    taskName: text(input.taskName),
    batchId: text(input.batchId),
    locale: text(input.locale),
    processedBy,
    processedAt: text(input.processedAt),
    status: pending ? "pending_revision" : "completed",
    summary: {
      total: items.length,
      ...counts,
      pending,
      resolved: items.length - pending,
      translationChanges: items.filter((item) => item.translationChanged).length
    },
    items,
    note: text(input.note),
    metadata: isPlainObject(input.metadata) ? structuredClone(input.metadata) : {}
  };
  receipt.textZh = receiptText(receipt);
  return receipt;
}
