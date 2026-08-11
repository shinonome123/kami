import { normalizeSource, splitSegments } from "./text.mjs";

const STOPWORDS = new Set([
  "我们", "你们", "他们", "这个", "那个", "以及", "进行", "可以", "需要", "已经", "如果", "因为", "所以",
  "一种", "一个", "没有", "不是", "通过", "所有", "相关", "内容", "活动期间"
]);

export function extractTermCandidates(text, { minFrequency = 2, maxCandidates = 50 } = {}) {
  const normalized = normalizeSource(text).replace(/[a-z0-9]+/gi, (value) => ` ${value} `);
  const chunks = normalized.split(/[\s，。！？；：“”‘’、（）【】《》〈〉…—·,.!?;:()\[\]{}<>/\\|]+/u).filter(Boolean);
  const counts = new Map();
  const record = (term, left, right) => {
    const current = counts.get(term) ?? { frequency: 0, left: new Set(), right: new Set() };
    current.frequency += 1;
    current.left.add(left);
    current.right.add(right);
    counts.set(term, current);
  };
  for (const chunk of chunks) {
    const chars = [...chunk];
    if (/^[a-z0-9][a-z0-9+_.-]*$/i.test(chunk)) {
      record(chunk, "^", "$");
      continue;
    }
    for (let size = 2; size <= Math.min(8, chars.length); size += 1) {
      for (let index = 0; index <= chars.length - size; index += 1) {
        const phrase = chars.slice(index, index + size).join("");
        if (STOPWORDS.has(phrase) || /^(的|了|和|与|在|是|为|后)/u.test(phrase) || /将$/u.test(phrase)) continue;
        if (/(将在|将于|可以|即可|已经|进行|结束后|束后|后发|现已|领取|发放|完成|购买)/u.test(phrase)) continue;
        record(phrase, index === 0 ? "^" : chars[index - 1], index + size >= chars.length ? "$" : chars[index + size]);
      }
    }
  }
  return [...counts.entries()]
    .filter(([term, stats]) => stats.frequency >= minFrequency && term.length >= 2)
    .map(([term, stats]) => ({
      term,
      frequency: stats.frequency,
      score: Number((stats.frequency * Math.log2([...term].length + 1)).toFixed(2))
    }))
    .sort((a, b) => b.score - a.score || b.term.length - a.term.length)
    .filter((candidate, index, all) => !all.slice(0, index).some((higher) => higher.term.includes(candidate.term) && higher.frequency === candidate.frequency))
    .slice(0, maxCandidates);
}

export function refineCorpus(text, options = {}) {
  const segments = splitSegments(text);
  return {
    segments,
    candidates: extractTermCandidates(text, options),
    statistics: {
      characters: [...String(text)].length,
      segments: segments.length
    }
  };
}
