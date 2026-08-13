import { embed, getProviderConfig, isEmbeddingConfigured } from "./provider.mjs";

const LOCAL_MODEL = "local-cjk-char-ngram-v1";
const LOCAL_DIMENSIONS = 512;

function hashFeature(value) {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function localEmbedding(source) {
  const normalized = String(source || "").normalize("NFKC").toLowerCase().replace(/\s+/gu, "").slice(0, 16_000);
  if (!normalized) return null;
  const characters = [...normalized];
  const vector = Array(LOCAL_DIMENSIONS).fill(0);
  for (let size = 1; size <= 3; size += 1) {
    const weight = size === 1 ? 0.45 : size === 2 ? 1 : 1.2;
    for (let index = 0; index <= characters.length - size; index += 1) {
      const hash = hashFeature(`${size}:${characters.slice(index, index + size).join("")}`);
      vector[hash % LOCAL_DIMENSIONS] += (hash & 1 ? 1 : -1) * weight;
    }
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (!norm) return null;
  return { vector: vector.map((value) => value / norm), model: LOCAL_MODEL, dimensions: LOCAL_DIMENSIONS, local: true };
}

export function embeddingEnabled() {
  return true;
}

export function embeddingModelName() {
  return getProviderConfig().embeddingModel || LOCAL_MODEL;
}

export async function embedSource(source) {
  if (isEmbeddingConfigured()) {
    try {
      const { vector, model, dimensions } = await embed(source);
      return { vector, model, dimensions };
    } catch {
      // 外部向量服务异常时继续使用本地索引，不能让知识检索整体失效。
    }
  }
  return localEmbedding(source);
}
