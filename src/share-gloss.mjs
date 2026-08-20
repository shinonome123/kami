function metaObject(meta) {
  return meta && typeof meta === "object" && !Array.isArray(meta) ? { ...meta } : {};
}

/** 把模型错误收敛成可以安全展示在公开分享页上的简短原因。 */
export function summarizeShareGlossFailures(failures = []) {
  const messages = (Array.isArray(failures) ? failures : [failures])
    .map((failure) => String(failure?.message || failure || "").replace(/\s+/gu, " ").trim())
    .filter(Boolean);
  if (messages.some((message) => /Insufficient Balance|QUOTA|\b402\b/iu.test(message))) {
    return "模型服务余额不足，语素拆解与字面直译未完成。";
  }
  if (messages.some((message) => /timeout|timed out|超时/iu.test(message))) {
    return "模型服务请求超时，语素拆解与字面直译未完成。";
  }
  if (!messages.length) return "模型未返回有效的语素拆解结果。";
  return `模型拆解失败：${messages[0].slice(0, 180)}`;
}

/**
 * 根据实际生成出的 gloss 数量结算分享状态。只有目标段全部完成才是 ready；
 * 任意缺失都进入 failed，并在 meta 中保存公开页可展示的错误摘要。
 */
export function finalizeShareGlossGeneration(share, { failures = [], maxSegments = 30 } = {}) {
  const segments = Array.isArray(share?.segments) ? share.segments : [];
  const limit = Math.min(segments.length, Math.max(0, Number(maxSegments) || 0));
  const glossedSegments = segments.slice(0, limit).filter((segment) => segment?.gloss).length;
  const failedSegments = Math.max(0, limit - glossedSegments);
  const meta = metaObject(share?.meta);
  if (failedSegments) {
    meta.generationError = summarizeShareGlossFailures(failures);
    meta.generationFailedSegments = failedSegments;
  } else {
    delete meta.generationError;
    delete meta.generationFailedSegments;
  }
  return {
    ...share,
    status: failedSegments ? "failed" : "ready",
    glossedSegments,
    totalSegments: Number(share?.totalSegments) || segments.length,
    meta: Object.keys(meta).length ? meta : null
  };
}
