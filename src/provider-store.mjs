import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = fileURLToPath(new URL("../", import.meta.url));
const SECRET_SCRIPT = join(PROJECT_ROOT, "scripts", "provider-secret.ps1");
export const DEFAULT_PROVIDER_DIRECTORY = process.env.KAMI_PROVIDER_DIRECTORY || join(PROJECT_ROOT, "data", "runtime");

function paths(directory) {
  return {
    config: join(directory, "provider.json"),
    secret: join(directory, "provider-key.dpapi")
  };
}

function runDpapi(action, value) {
  if (process.platform !== "win32") throw new Error("当前系统不支持 Windows DPAPI");
  return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", SECRET_SCRIPT, action], {
    input: String(value || ""),
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 1024 * 1024
  });
}

function atomicWrite(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, content, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, path);
}

export function saveProviderConfig(config, directory = DEFAULT_PROVIDER_DIRECTORY) {
  const target = paths(directory);
  const baseUrl = String(config.baseUrl || "").replace(/\/$/, "");
  const model = String(config.model || "");
  const apiKey = String(config.apiKey || "");
  if (apiKey) atomicWrite(target.secret, runDpapi("protect", apiKey));
  else if (existsSync(target.secret)) rmSync(target.secret);
  atomicWrite(target.config, JSON.stringify({ baseUrl, model, apiKeyConfigured: Boolean(apiKey), updatedAt: new Date().toISOString() }, null, 2));
  return { mode: "windows-dpapi", persisted: true, apiKeyPersisted: Boolean(apiKey) };
}

export function loadProviderConfig(directory = DEFAULT_PROVIDER_DIRECTORY) {
  const target = paths(directory);
  if (!existsSync(target.config)) return { config: {}, persistence: { mode: "windows-dpapi", persisted: false, apiKeyPersisted: false } };
  try {
    const metadata = JSON.parse(readFileSync(target.config, "utf8"));
    let apiKey = "";
    if (existsSync(target.secret)) apiKey = runDpapi("unprotect", readFileSync(target.secret, "utf8"));
    return {
      config: { baseUrl: metadata.baseUrl || "", model: metadata.model || "", apiKey },
      persistence: { mode: "windows-dpapi", persisted: true, apiKeyPersisted: Boolean(apiKey) }
    };
  } catch (error) {
    return {
      config: {},
      persistence: { mode: "windows-dpapi", persisted: false, apiKeyPersisted: false, warning: `本地模型配置读取失败：${error.message}` }
    };
  }
}
