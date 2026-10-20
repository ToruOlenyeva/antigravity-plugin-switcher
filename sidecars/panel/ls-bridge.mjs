import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.ANTIGRAVITY_SIDECAR_WEB_PORT || process.env.PORT || 8088);

const homeDir = os.homedir();
const appDataDir = process.env.APPDATA || (process.platform === "darwin" ? path.join(homeDir, "Library", "Application Support") : path.join(homeDir, ".config"));

const PLUGINS_DIR = path.join(homeDir, ".gemini", "config", "plugins");
const CONFIG_FILE = path.join(homeDir, ".gemini", "config", "config.json");
const PROFILES_FILE = path.join(homeDir, ".gemini", "config", "project-plugin-profiles.json");
const PROJECTS_DIR = path.join(homeDir, ".gemini", "config", "projects");
const APP_STORAGE_FILE = path.join(appDataDir, "Antigravity", "app_storage.json");
const CONV_DB_PATH = path.join(homeDir, ".gemini", "antigravity", "conversation_summaries.db");
const PROTECTED_PLUGINS = new Set(["plugin-switcher"]);
const DEFAULT_KEY = "__default__";

const PRELOAD_SDK_PATH = path.join(homeDir, ".gemini", "antigravity", "lib", "node_modules", "sidecar_sdk", "preload.js");

function isValidPluginDirectory(dirName) {
  if (!dirName || typeof dirName !== "string" || dirName.startsWith(".") || dirName.includes("..") || dirName.includes("/") || dirName.includes("\\")) return false;
  const fullDir = path.join(PLUGINS_DIR, dirName);
  const candidates = [
    path.join(fullDir, "plugin.json"),
    path.join(fullDir, ".antigravity-plugin", "plugin.json"),
    path.join(fullDir, ".gemini-plugin", "plugin.json"),
    path.join(fullDir, ".claude-plugin", "plugin.json")
  ];
  return candidates.some((p) => fs.existsSync(p));
}

let sqliteDb = null;
try {
  const { DatabaseSync } = await import("node:sqlite");
  if (fs.existsSync(CONV_DB_PATH)) {
    sqliteDb = new DatabaseSync(CONV_DB_PATH, { readOnly: true, open: true });
  }
} catch (e) {
  sqliteDb = null;
}

function resolveProjectIdFromDb(convId) {
  if (!convId) return "";

  // 1. 原生 node:sqlite 毫秒级直查
  if (sqliteDb) {
    try {
      const stmt = sqliteDb.prepare("SELECT project_id FROM conversation_summaries WHERE conversation_id = ?");
      const row = stmt.get(convId);
      if (row && row.project_id) {
        return row.project_id;
      }
    } catch (e) {}
  }

  // 2. Python sqlite3 兜底直查（如果原生未就绪）
  try {
    if (fs.existsSync(CONV_DB_PATH)) {
      const pyScript = "import sqlite3, sys; conn = sqlite3.connect(sys.argv[1]); c = conn.cursor(); c.execute('SELECT project_id FROM conversation_summaries WHERE conversation_id = ?', (sys.argv[2],)); r = c.fetchone(); print(r[0] if r else '')";
      const out = execFileSync("python", ["-c", pyScript, CONV_DB_PATH, convId], {
        encoding: "utf-8",
        timeout: 1000,
        windowsHide: true
      });
      const pId = out.trim();
      if (pId) return pId;
    }
  } catch (e) {}

  // 3. agentapi CLI 官方探测兜底
  try {
    const exe = process.env.ANTIGRAVITY_AGENTAPI_EXE;
    const file = exe || "agentapi";
    const args = exe ? ["agentapi", "get-conversation-metadata", convId] : ["get-conversation-metadata", convId];
    const out = execFileSync(file, args, { encoding: "utf-8", timeout: 1000, windowsHide: true });
    const json = JSON.parse(out);
    const meta = json?.response?.conversationMetadata?.metadata || json?.response?.conversation_metadata?.metadata;
    const pId = meta?.projectId || meta?.project_id || "";
    if (pId) return pId;
  } catch (e) {}

  return "";
}

function getLatestActiveProjectIdFromDb() {
  if (sqliteDb) {
    try {
      const stmt = sqliteDb.prepare("SELECT project_id FROM conversation_summaries ORDER BY last_user_input_time DESC LIMIT 1");
      const row = stmt.get();
      if (row && row.project_id) {
        return row.project_id;
      }
    } catch (e) {}
  }
  try {
    if (fs.existsSync(CONV_DB_PATH)) {
      const pyScript = "import sqlite3, sys; conn = sqlite3.connect(sys.argv[1]); c = conn.cursor(); c.execute('SELECT project_id FROM conversation_summaries ORDER BY last_user_input_time DESC LIMIT 1'); r = c.fetchone(); print(r[0] if r else '')";
      const out = execFileSync("python", ["-c", pyScript, CONV_DB_PATH], {
        encoding: "utf-8",
        timeout: 1000,
        windowsHide: true
      });
      const pId = out.trim();
      if (pId) return pId;
    }
  } catch (e) {}
  return "";
}

function getActiveConversationIdFromStorage() {
  try {
    const appStorage = readJsonSafe(APP_STORAGE_FILE, {});
    const convOrder = JSON.parse(appStorage.projectsConversationOrder || "[]");
    if (Array.isArray(convOrder) && convOrder.length > 0) {
      return convOrder[0] || "";
    }
  } catch (e) {}
  return "";
}

function readJsonSafe(filePath, fallback = {}) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, "utf-8"));
    }
  } catch (e) {}
  return fallback;
}

function getPluginManifest(dir) {
  if (!dir || typeof dir !== "string" || dir.includes("..") || dir.includes("/") || dir.includes("\\")) {
    return {};
  }
  const candidateManifests = [
    path.join(PLUGINS_DIR, dir, "plugin.json"),
    path.join(PLUGINS_DIR, dir, ".antigravity-plugin", "plugin.json"),
    path.join(PLUGINS_DIR, dir, ".gemini-plugin", "plugin.json"),
    path.join(PLUGINS_DIR, dir, ".claude-plugin", "plugin.json")
  ];
  for (const mPath of candidateManifests) {
    if (fs.existsSync(mPath)) {
      return readJsonSafe(mPath, {});
    }
  }
  return {};
}

function resolvePluginLogoFile(dir, manifest = {}) {
  if (!dir || typeof dir !== "string" || dir.includes("..") || dir.includes("/") || dir.includes("\\")) {
    return null;
  }
  const pluginBaseDir = path.resolve(PLUGINS_DIR, dir);
  const probeCandidates = [];

  if (typeof manifest.logo === "string" && manifest.logo.trim()) {
    const trimmed = manifest.logo.trim();
    if (!/^(https?:|data:)/i.test(trimmed)) {
      probeCandidates.push(trimmed);
    }
  }

  probeCandidates.push("assets/logo.svg", "assets/logo.png", "logo.svg", "logo.png");

  for (const relPath of probeCandidates) {
    const fullLogoPath = path.resolve(pluginBaseDir, relPath);
    if (fullLogoPath.startsWith(pluginBaseDir + path.sep) && fs.existsSync(fullLogoPath)) {
      return fullLogoPath;
    }
  }

  return null;
}

function resolvePluginLogoUrl(dir, manifest = {}) {
  if (!dir || typeof dir !== "string") return "";
  if (typeof manifest.logo === "string" && manifest.logo.trim()) {
    const trimmed = manifest.logo.trim();
    if (/^(https?:|data:)/i.test(trimmed)) {
      return trimmed;
    }
  }

  const localFile = resolvePluginLogoFile(dir, manifest);
  if (localFile) {
    return `/api/plugin-logo?dir=${encodeURIComponent(dir)}`;
  }

  return "";
}

let lastInternalConfigWriteMs = 0;

function extractConfigPluginSnapshot(config) {
  const snap = {};
  if (config && config.plugins && typeof config.plugins === "object") {
    for (const [dir, entry] of Object.entries(config.plugins)) {
      if (dir.startsWith(".") || PROTECTED_PLUGINS.has(dir)) continue;
      snap[dir] = Boolean(!entry || entry.enabled !== false);
    }
  }
  return snap;
}

function recordConfigWriteMeta(profiles, config) {
  if (!profiles || typeof profiles !== "object") return;
  if (!profiles.__meta__) profiles.__meta__ = {};
  const now = Date.now();
  lastInternalConfigWriteMs = now;
  profiles.__meta__.lastInternalConfigWriteAt = now;
  profiles.__meta__.lastAppliedConfigSnapshot = extractConfigPluginSnapshot(config);
}

function writeJsonSafe(filePath, data) {
  try {
    if (filePath === CONFIG_FILE) {
      lastInternalConfigWriteMs = Date.now();
    }
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
    return true;
  } catch (e) {
    return false;
  }
}

function notifyLanguageServer(pluginUpdates) {
  const lsAddr = process.env.ANTIGRAVITY_LS_ADDRESS || "localhost:5387";
  const csrf = process.env.ANTIGRAVITY_CSRF_TOKEN || "";
  if (!csrf) return;

  try {
    const [hostname, portStr] = lsAddr.split(":");
    const req = http.request({
      hostname,
      port: Number(portStr || 5387),
      path: "/exa.language_server_pb.LanguageServerService/JetboxWriteState",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-codeium-csrf-token": csrf
      },
      timeout: 1000
    }, () => {});
    req.on("error", () => {});
    req.write(JSON.stringify({ userConfig: { plugins: pluginUpdates } }));
    req.end();
  } catch (e) {}
}

export function getLastInternalConfigWriteMs() {
  return lastInternalConfigWriteMs;
}

export {
  PLUGINS_DIR,
  CONFIG_FILE,
  PROFILES_FILE,
  PROJECTS_DIR,
  APP_STORAGE_FILE,
  CONV_DB_PATH,
  PROTECTED_PLUGINS,
  DEFAULT_KEY,
  PRELOAD_SDK_PATH,
  isValidPluginDirectory,
  resolveProjectIdFromDb,
  getLatestActiveProjectIdFromDb,
  getActiveConversationIdFromStorage,
  readJsonSafe,
  getPluginManifest,
  resolvePluginLogoFile,
  resolvePluginLogoUrl,
  extractConfigPluginSnapshot,
  recordConfigWriteMeta,
  writeJsonSafe,
  notifyLanguageServer
};
