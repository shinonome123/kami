/**
 * Persistence for the workbench tuning parameters.
 *
 * Mirrors `provider-store.mjs`: machine-local JSON under `data/runtime/`, with
 * environment variables taking precedence over the stored value. Settings are
 * operational configuration for one installation, not language assets, so they
 * deliberately do NOT live in Directus — that store is reserved for terms,
 * memories, style profiles and learning trajectories, and it is already close
 * to the collection cap of the Directus edition in use.
 *
 * The process keeps a cached copy so hot paths (every translation reads the QA
 * pass score and the retrieval limits) do not hit the disk per request.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultSettings, sanitizeSettings } from "./settings.mjs";

const PROJECT_ROOT = fileURLToPath(new URL("../", import.meta.url));

function settingsPath() {
  const directory = process.env.KAMI_PROVIDER_DIRECTORY || join(PROJECT_ROOT, "data", "runtime");
  return join(directory, "settings.json");
}

/**
 * Environment overrides, kept for the knobs that already had documented env
 * vars before this panel existed. Env still wins so existing deployment
 * scripts keep working; the panel shows which fields are being overridden.
 */
const ENV_OVERRIDES = Object.freeze({
  "learning.styleDistillThreshold": "KAMI_STYLE_DISTILL_THRESHOLD",
  "learning.styleDistillGrowthWindow": "KAMI_STYLE_DISTILL_GROWTH_WINDOW",
  "learning.autoProposeThreshold": "KAMI_AUTO_PROPOSE_THRESHOLD",
  "learning.autoProposeGrowthWindow": "KAMI_AUTO_PROPOSE_GROWTH_WINDOW"
});

let cached = null;

function assignPath(target, path, value) {
  const keys = path.split(".");
  const last = keys.pop();
  const parent = keys.reduce((carry, key) => {
    if (!carry[key] || typeof carry[key] !== "object") carry[key] = {};
    return carry[key];
  }, target);
  parent[last] = value;
}

function readStored() {
  const path = settingsPath();
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    // 配置文件损坏不该让工作台起不来：回落默认并在下一次保存时覆盖。
    console.error(`[Kami] 设置文件无法解析，已按默认值运行：${path}`);
    return {};
  }
}

/** Fields currently forced by an environment variable, so the panel can mark them read-only. */
export function environmentOverrides() {
  const active = {};
  for (const [path, variable] of Object.entries(ENV_OVERRIDES)) {
    const raw = process.env[variable];
    if (raw === undefined || String(raw).trim() === "") continue;
    active[path] = { variable, value: Number(raw) };
  }
  return active;
}

export function getSettings() {
  if (cached) return cached;
  const { settings } = sanitizeSettings(readStored());
  for (const [path, override] of Object.entries(environmentOverrides())) {
    if (Number.isFinite(override.value)) assignPath(settings, path, override.value);
  }
  // 环境变量注入后再净化一次：环境变量同样可能越界。
  cached = sanitizeSettings(settings).settings;
  return cached;
}

export function saveSettings(input) {
  const { settings, notes } = sanitizeSettings(input);
  const path = settingsPath();
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, { encoding: "utf8" });
  renameSync(temporary, path);
  cached = null;
  return { settings: getSettings(), notes };
}

export function resetSettings() {
  return saveSettings(defaultSettings());
}

/** 测试用：清掉进程内缓存，让下一次读取重新走磁盘与环境变量。 */
export function invalidateSettingsCache() {
  cached = null;
}
