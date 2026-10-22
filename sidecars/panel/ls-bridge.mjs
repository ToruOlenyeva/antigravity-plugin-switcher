import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.ANTIGRAVITY_SIDECAR_WEB_PORT || process.env.PORT || 8088);

// 跨账户同源解析：优先从插件自身所在的物理路径向上反推宿主用户主目录（防止桌面登录非管理员账户 toru-work 而 Antigravity 以管理员 z9685 运行时 os.homedir() 错位）
function resolveHostHomeDir() {
  const normalized = __dirname.replace(/\\/g, "/");
  const geminiIdx = normalized.toLowerCase().indexOf("/.gemini/");
  if (geminiIdx > 0) {
    const candidate = path.normalize(__dirname.slice(0, geminiIdx));
    if (fs.existsSync(candidate)) return candidate;
  }
  return os.homedir();
}

const homeDir = resolveHostHomeDir();
const appDataDir = (process.platform === "win32" && fs.existsSync(path.join(homeDir, "AppData", "Roaming")))
  ? path.join(homeDir, "AppData", "Roaming")
  : (process.env.APPDATA || (process.platform === "darwin" ? path.join(homeDir, "Library", "Application Support") : path.join(homeDir, ".config")));

// 后端核心模块热自愈监听：当 main.mjs / scanner.mjs / ls-bridge.mjs 发生磁盘更新时自动退出，由宿主 restart_policy: always 秒级重拉最新代码
for (const backendFile of ["main.mjs", "scanner.mjs", "ls-bridge.mjs"]) {
  const fullBackendPath = path.join(__dirname, backendFile);
  try {
    fs.watchFile(fullBackendPath, { interval: 1500 }, (curr, prev) => {
      if (curr.mtimeMs !== prev.mtimeMs) {
        console.log(`[PluginSwitcher Sidecar] Backend file ${backendFile} updated on disk, restarting sidecar...`);
        setTimeout(() => process.exit(0), 200);
      }
    });
  } catch (e) {}
}

// 若当前进程为 Antigravity 宿主拉起的内置 Sidecar（携带动态端口），自动驱逐可能霸占 8088 端口的旧独立进程，确保单进程双端口同源输出
if (PORT !== 8088 && process.env.ANTIGRAVITY_SIDECAR_WEB_PORT) {
  try {
    const evictReq = http.request({
      hostname: "127.0.0.1",
      port: 8088,
      path: "/api/restart-sidecar",
      method: "POST",
      timeout: 600
    }, () => {});
    evictReq.on("error", () => {});
    evictReq.end();
  } catch (e) {}
}

const PLUGINS_DIR = path.join(homeDir, ".gemini", "config", "plugins");
const CONFIG_FILE = path.join(homeDir, ".gemini", "config", "config.json");
const PROFILES_FILE = path.join(homeDir, ".gemini", "config", "project-plugin-profiles.json");
const PROJECTS_DIR = path.join(homeDir, ".gemini", "config", "projects");
const APP_STORAGE_FILE = path.join(appDataDir, "Antigravity", "app_storage.json");
const DEVTOOLS_ACTIVE_PORT_FILE = path.join(appDataDir, "Antigravity", "DevToolsActivePort");
const LS_LOG_FILE = path.join(appDataDir, "Antigravity", "logs", "language_server.log");
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

const convIdProjectCache = new Map();

let cachedDatabaseSyncCtor = null;
try {
  const mod = await import("node:sqlite");
  cachedDatabaseSyncCtor = mod.DatabaseSync || null;
} catch (_) {}

function resolveProjectIdFromDb(convId) {
  if (!convId) return "";
  if (convIdProjectCache.has(convId)) {
    const cached = convIdProjectCache.get(convId);
    // 命中真实 projectId 长期缓存；若上次未命中（""），仅短防抖 800ms，严禁缓存 15s 空结果导致切换历史对话断链
    if (cached.projectId || (Date.now() - cached.at < 800)) {
      return cached.projectId;
    }
  }

  // 1. 原生 node:sqlite 毫秒级直查（若常驻连接因 WAL 快照未见新行，自动用短连接复核一次）
  if (sqliteDb) {
    try {
      const stmt = sqliteDb.prepare("SELECT project_id FROM conversation_summaries WHERE conversation_id = ?");
      let row = stmt.get(convId);
      if ((!row || !row.project_id) && cachedDatabaseSyncCtor && fs.existsSync(CONV_DB_PATH)) {
        const freshDb = new cachedDatabaseSyncCtor(CONV_DB_PATH, { readOnly: true, open: true });
        try {
          row = freshDb.prepare("SELECT project_id FROM conversation_summaries WHERE conversation_id = ?").get(convId);
        } finally {
          try { freshDb.close(); } catch (_) {}
        }
      }
      const pId = (row && row.project_id) ? String(row.project_id) : "";
      if (pId) {
        convIdProjectCache.set(convId, { projectId: pId, at: Date.now() });
        return pId;
      }
    } catch (e) {}
  } else {
    // 2. 仅当当前 Node 运行时不支持 node:sqlite (sqliteDb === null) 时才使用一次 Python 兜底
    try {
      if (fs.existsSync(CONV_DB_PATH)) {
        const pyScript = "import sqlite3, sys; conn = sqlite3.connect(sys.argv[1]); c = conn.cursor(); c.execute('SELECT project_id FROM conversation_summaries WHERE conversation_id = ?', (sys.argv[2],)); r = c.fetchone(); print(r[0] if r else '')";
        const out = execFileSync("python", ["-c", pyScript, CONV_DB_PATH, convId], {
          encoding: "utf-8",
          timeout: 400,
          windowsHide: true
        });
        const pId = out.trim();
        if (pId) {
          convIdProjectCache.set(convId, { projectId: pId, at: Date.now() });
          return pId;
        }
      }
    } catch (e) {}
  }

  // 2.5 从 profiles.__meta__.convProjectMap 共享映射中快查（由 Hook 或 Sidecar 写入）
  try {
    if (fs.existsSync(PROFILES_FILE)) {
      const prof = JSON.parse(fs.readFileSync(PROFILES_FILE, "utf-8"));
      const mapped = prof?.__meta__?.convProjectMap?.[convId];
      if (mapped && typeof mapped === "string") {
        convIdProjectCache.set(convId, { projectId: mapped, at: Date.now() });
        return mapped;
      }
    }
  } catch (e) {}

  // 3. agentapi CLI 官方探测兜底（仅对尚未入 SQLite 的纯聊天/新会话执行一次，结果写入 convIdProjectCache 防止重复阻塞）
  try {
    const exe = process.env.ANTIGRAVITY_AGENTAPI_EXE;
    const file = exe || "agentapi";
    const args = exe ? ["agentapi", "get-conversation-metadata", convId] : ["get-conversation-metadata", convId];
    const out = execFileSync(file, args, { encoding: "utf-8", timeout: 450, windowsHide: true });
    const json = JSON.parse(out);
    const meta = json?.response?.conversationMetadata?.metadata || json?.response?.conversation_metadata?.metadata;
    const pId = meta?.projectId || meta?.project_id || "";
    if (pId) {
      convIdProjectCache.set(convId, { projectId: pId, at: Date.now() });
      return pId;
    }
  } catch (e) {}

  convIdProjectCache.set(convId, { projectId: "", at: Date.now() });
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
  return "";
}

// 动态发现 Antigravity Electron 主窗口的本地 CDP 端口（绝不写死端口）
// 优先级 1：读取 Chromium 官方标准动态端口文件 <AppData>/Antigravity/DevToolsActivePort 第 1 行
// 优先级 2：从 <AppData>/Antigravity/logs/language_server.log 尾部提取最新 WS URL 端口
let cachedCdpPort = 0;
let cachedCdpPortAt = 0;

function discoverElectronCdpPort(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && cachedCdpPort > 1024 && (now - cachedCdpPortAt < 5000)) {
    return cachedCdpPort;
  }

  // 1. 首选读取 DevToolsActivePort 第一行（每次客户端重启分配随机端口都会自动刷新该文件）
  try {
    if (fs.existsSync(DEVTOOLS_ACTIVE_PORT_FILE)) {
      const raw = fs.readFileSync(DEVTOOLS_ACTIVE_PORT_FILE, "utf-8");
      const firstLine = (raw.split(/\r?\n/)[0] || "").trim();
      const port = Number(firstLine);
      if (port > 1024 && port < 65535) {
        cachedCdpPort = port;
        cachedCdpPortAt = now;
        return port;
      }
    }
  } catch (e) {}

  // 2. 次选从 language_server.log 尾部动态提取
  try {
    if (fs.existsSync(LS_LOG_FILE)) {
      const stat = fs.statSync(LS_LOG_FILE);
      const readSize = Math.min(stat.size, 24576);
      const fd = fs.openSync(LS_LOG_FILE, "r");
      const buf = Buffer.alloc(readSize);
      fs.readSync(fd, buf, 0, readSize, Math.max(0, stat.size - readSize));
      fs.closeSync(fd);
      const tail = buf.toString("utf-8");
      const matches = [...tail.matchAll(/ws:\/\/127\.0\.0\.1:(\d+)\/devtools\/browser\//g)];
      if (matches.length > 0) {
        const port = Number(matches[matches.length - 1][1]);
        if (port > 1024 && port < 65535) {
          cachedCdpPort = port;
          cachedCdpPortAt = now;
          return port;
        }
      }
    }
  } catch (e) {}

  return cachedCdpPort || 13305;
}

let latestWindowRoute = {
  projectId: "",
  convId: "",
  sectionProjId: "",
  rawUrl: "",
  title: "",
  port: 0,
  updatedAt: 0
};
let inflightRoutePromise = null;

function fetchCdpTargetsJson(port) {
  return new Promise((resolve, reject) => {
    const req = http.get({
      hostname: "127.0.0.1",
      port,
      path: "/json",
      timeout: 300
    }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      let body = "";
      res.setEncoding("utf-8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("timeout"));
    });
    req.on("error", reject);
  });
}

// 实时读取 Antigravity Electron 主窗口 page 路由 (/c/<convId>?section=<projectId>)
async function refreshFocusedWindowRoute(force = false) {
  const now = Date.now();
  if (!force && latestWindowRoute.updatedAt > 0 && (now - latestWindowRoute.updatedAt < 250)) {
    return latestWindowRoute;
  }
  if (inflightRoutePromise) return inflightRoutePromise;

  inflightRoutePromise = (async () => {
    let port = discoverElectronCdpPort(false);
    let targets = null;
    try {
      targets = await fetchCdpTargetsJson(port);
    } catch (e) {
      // 若缓存端口失效（如客户端重启换了新随机端口），强制重读 DevToolsActivePort 重试一次
      const freshPort = discoverElectronCdpPort(true);
      if (freshPort !== port) {
        port = freshPort;
        try {
          targets = await fetchCdpTargetsJson(port);
        } catch (e2) {}
      }
    }

    if (Array.isArray(targets)) {
      const pageTarget = targets.find((t) =>
        t &&
        t.type === "page" &&
        typeof t.url === "string" &&
        (t.url.includes("/c/") || t.url.includes("section=") || (t.title || "").includes("Antigravity"))
      );
      if (pageTarget && pageTarget.url) {
        const rawUrl = pageTarget.url;
        const convMatch = rawUrl.match(/\/c\/([0-9a-f-]{36})/i);
        const secMatch = rawUrl.match(/[?&]section=([0-9a-f-]{36})/i);
        const convId = convMatch ? convMatch[1] : "";
        const sectionProjId = secMatch ? secMatch[1] : "";

        // 先查 SQLite 确认会话归属；若为尚未落库的新会话/纯聊天会话，则直接用路由中的 ?section=<projectId> 注入内存缓存，0ms 免拉起子进程
        let dbProjId = "";
        if (convId && sqliteDb) {
          try {
            const stmt = sqliteDb.prepare("SELECT project_id FROM conversation_summaries WHERE conversation_id = ?");
            const row = stmt.get(convId);
            if (row && row.project_id) {
              dbProjId = String(row.project_id);
              convIdProjectCache.set(convId, { projectId: dbProjId, at: Date.now() });
            }
          } catch (e) {}
        }
        if (convId && !dbProjId && sectionProjId) {
          convIdProjectCache.set(convId, { projectId: sectionProjId, at: Date.now() });
        }

        const resolvedProjectId = sectionProjId || dbProjId || (convId ? resolveProjectIdFromDb(convId) : "");
        latestWindowRoute = {
          projectId: resolvedProjectId || "",
          convId,
          sectionProjId,
          rawUrl,
          title: pageTarget.title || "",
          port,
          updatedAt: Date.now()
        };
      }
    }
    return latestWindowRoute;
  })().finally(() => {
    inflightRoutePromise = null;
  });

  return inflightRoutePromise;
}

function getFocusedWindowRoute() {
  return latestWindowRoute;
}

// 启动时立即探测一次主窗口路由
refreshFocusedWindowRoute(true).catch(() => {});

const lastValidJsonCache = new Map();
const PROFILES_BAK_FILE = `${PROFILES_FILE}.bak`;

function isWellFormedProfilesObject(obj) {
  return Boolean(
    obj &&
    typeof obj === "object" &&
    !Array.isArray(obj) &&
    obj[DEFAULT_KEY] &&
    typeof obj[DEFAULT_KEY] === "object" &&
    obj[DEFAULT_KEY].plugins &&
    typeof obj[DEFAULT_KEY].plugins === "object" &&
    Object.keys(obj[DEFAULT_KEY].plugins).length > 0
  );
}

function countUuidProjectKeys(obj) {
  if (!obj || typeof obj !== "object") return 0;
  let count = 0;
  for (const k of Object.keys(obj)) {
    if (/^[0-9a-f-]{36}$/i.test(k)) count++;
  }
  return count;
}

function readJsonSafe(filePath, fallback = {}) {
  const isProfiles = filePath === PROFILES_FILE;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      if (fs.existsSync(filePath)) {
        const raw = fs.readFileSync(filePath, "utf-8");
        if (raw && raw.trim()) {
          const parsed = JSON.parse(raw);
          if (!isProfiles || isWellFormedProfilesObject(parsed)) {
            lastValidJsonCache.set(filePath, raw);
            return parsed;
          }
        }
      }
    } catch (e) {}
    // 短暂自旋等待并发写盘完成（约 2ms）
    const waitUntil = Date.now() + 2;
    while (Date.now() < waitUntil) {}
  }

  // 防线 1：若读取发生瞬时并发截断或半截 JSON，优先从进程内最后一次合法快照恢复，绝不裸返空对象 {}
  if (lastValidJsonCache.has(filePath)) {
    try {
      return JSON.parse(lastValidJsonCache.get(filePath));
    } catch (e) {}
  }

  // 防线 2：针对 PROFILES_FILE 额外从磁盘 .bak 热备恢复
  if (isProfiles && fs.existsSync(PROFILES_BAK_FILE)) {
    try {
      const bakRaw = fs.readFileSync(PROFILES_BAK_FILE, "utf-8");
      const bakParsed = JSON.parse(bakRaw);
      if (isWellFormedProfilesObject(bakParsed)) {
        lastValidJsonCache.set(filePath, bakRaw);
        try {
          fs.writeFileSync(PROFILES_FILE, bakRaw, "utf-8");
        } catch (e) {}
        return bakParsed;
      }
    } catch (e) {}
  }

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
let inflightLsRpcCount = 0;
let lastLsRpcDoneMs = 0;
let cachedLsRpcTarget = null;
let cachedLsRpcTargetAt = 0;

function resolveLsRpcTarget(profilesHint = null) {
  const envAddr = process.env.ANTIGRAVITY_LS_ADDRESS || "";
  const envCsrf = process.env.ANTIGRAVITY_CSRF_TOKEN || "";
  if (envAddr && envCsrf) {
    const [hostname, portStr] = envAddr.split(":");
    const port = Number(portStr || 5387);
    if (hostname && port > 0) {
      cachedLsRpcTarget = { hostname, port, csrf: envCsrf };
      cachedLsRpcTargetAt = Date.now();
      return cachedLsRpcTarget;
    }
  }
  if (cachedLsRpcTarget && (Date.now() - cachedLsRpcTargetAt < 30000)) {
    return cachedLsRpcTarget;
  }
  const metaTarget = profilesHint?.__meta__?.lsRpcTarget;
  if (metaTarget && metaTarget.port && metaTarget.csrf) {
    cachedLsRpcTarget = {
      hostname: metaTarget.hostname || "127.0.0.1",
      port: Number(metaTarget.port),
      csrf: String(metaTarget.csrf)
    };
    cachedLsRpcTargetAt = Date.now();
    return cachedLsRpcTarget;
  }
  return null;
}

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

function recordConfigWriteMeta(profiles, config, appliedProjectId = "") {
  if (!profiles || typeof profiles !== "object") return;
  if (!profiles.__meta__) profiles.__meta__ = {};
  const now = Date.now();
  lastInternalConfigWriteMs = now;
  profiles.__meta__.lastInternalConfigWriteAt = now;
  profiles.__meta__.lastAppliedConfigSnapshot = extractConfigPluginSnapshot(config);
  if (appliedProjectId && appliedProjectId !== DEFAULT_KEY) {
    profiles.__meta__.lastAppliedProjectId = appliedProjectId;
  } else if (profiles.__meta__.lastActiveProjectId) {
    profiles.__meta__.lastAppliedProjectId = profiles.__meta__.lastActiveProjectId;
  }
  const target = resolveLsRpcTarget(profiles);
  if (target) {
    profiles.__meta__.lsRpcTarget = {
      hostname: target.hostname,
      port: target.port,
      csrf: target.csrf,
      updatedAt: now
    };
  }
}

function writeFileAtomicSync(targetPath, content) {
  const tmpPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmpPath, content, "utf-8");
    fs.renameSync(tmpPath, targetPath);
    return true;
  } catch (err) {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch (e) {}
    try {
      fs.writeFileSync(targetPath, content, "utf-8");
      return true;
    } catch (e2) {
      return false;
    }
  }
}

function writeJsonSafe(filePath, data) {
  try {
    if (filePath === PROFILES_FILE) {
      // 硬熔断：绝不允许将缺失 DEFAULT_KEY 或空插件列表的残缺对象写入 PROFILES_FILE
      if (!isWellFormedProfilesObject(data)) {
        return false;
      }
      // 防全量丢失熔断：若缓存或备份中已有 >= 2 个项目独立配置，而待写入对象项目数为 0，立即拒绝写盘
      const prevRaw = lastValidJsonCache.get(PROFILES_FILE);
      if (prevRaw) {
        try {
          const prevObj = JSON.parse(prevRaw);
          if (countUuidProjectKeys(prevObj) >= 2 && countUuidProjectKeys(data) === 0) {
            return false;
          }
        } catch (e) {}
      }
    }
    if (filePath === CONFIG_FILE) {
      lastInternalConfigWriteMs = Date.now();
    }
    const serialized = JSON.stringify(data, null, 2);
    const ok = writeFileAtomicSync(filePath, serialized);
    if (ok) {
      lastValidJsonCache.set(filePath, serialized);
      if (filePath === PROFILES_FILE && countUuidProjectKeys(data) > 0) {
        writeFileAtomicSync(PROFILES_BAK_FILE, serialized);
      }
    }
    return ok;
  } catch (e) {
    return false;
  }
}

function notifyLanguageServer(pluginUpdates, profilesHint = null) {
  const target = resolveLsRpcTarget(profilesHint);
  if (!target || !target.csrf) return;

  try {
    inflightLsRpcCount++;
    let settled = false;
    const markSettled = () => {
      if (settled) return;
      settled = true;
      inflightLsRpcCount = Math.max(0, inflightLsRpcCount - 1);
      lastLsRpcDoneMs = Date.now();
    };
    const req = http.request({
      hostname: target.hostname,
      port: Number(target.port || 5387),
      path: "/exa.language_server_pb.LanguageServerService/JetboxWriteState",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-codeium-csrf-token": target.csrf
      },
      timeout: 1000
    }, (res) => {
      res.resume();
      res.on("end", markSettled);
    });
    req.on("error", markSettled);
    req.on("timeout", () => {
      req.destroy();
      markSettled();
    });
    req.write(JSON.stringify({ userConfig: { plugins: pluginUpdates } }));
    req.end();
  } catch (e) {}
}

export function getLastInternalConfigWriteMs() {
  return Math.max(lastInternalConfigWriteMs, lastLsRpcDoneMs);
}

export function isInternalConfigWriteSettled(minSettleMs = 450) {
  if (inflightLsRpcCount > 0) return false;
  return (Date.now() - Math.max(lastInternalConfigWriteMs, lastLsRpcDoneMs)) > minSettleMs;
}

export function syncNativeSettingsFromLsMemory(expectedProjectId = "") {
  const target = resolveLsRpcTarget();
  if (!target || !target.csrf || !isInternalConfigWriteSettled(600)) {
    return Promise.resolve(false);
  }

  return new Promise((resolve) => {
    try {
      const req = http.request({
        hostname: target.hostname,
        port: Number(target.port || 5387),
        path: "/exa.language_server_pb.LanguageServerService/GetAllPlugins",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-codeium-csrf-token": target.csrf
        },
        timeout: 450
      }, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return resolve(false);
        }
        let body = "";
        res.setEncoding("utf-8");
        res.on("data", (chunk) => { body += chunk; });
        res.on("end", () => {
          try {
            if (!isInternalConfigWriteSettled(600)) return resolve(false);
            const data = JSON.parse(body);
            const list = data?.plugins || data?.pluginInfos || data?.items || [];
            if (!Array.isArray(list) || list.length === 0) return resolve(false);

            const profiles = readJsonSafe(PROFILES_FILE, {});
            const lastActiveId = profiles?.__meta__?.lastActiveProjectId || "";
            if (!lastActiveId || lastActiveId === DEFAULT_KEY || !profiles[lastActiveId] || !profiles[lastActiveId].plugins) return resolve(false);
            if (expectedProjectId && expectedProjectId !== lastActiveId) return resolve(false);
            if (profiles?.__meta__?.lastAppliedProjectId && profiles.__meta__.lastAppliedProjectId !== lastActiveId) return resolve(false);

            const nowMs = Date.now();
            const lastProfileWriteAt = Number(profiles?.__meta__?.lastInternalConfigWriteAt || 0);
            const lastSwitchAt = Number(profiles?.__meta__?.lastProjectSwitchAt || 0);
            const lastBgHookAt = Number(profiles?.__meta__?.lastBgHookAt || 0);
            if (nowMs - lastProfileWriteAt <= 1200 || nowMs - lastSwitchAt <= 2000 || nowMs - lastBgHookAt <= 2000) {
              return resolve(false);
            }

            const snap = profiles?.__meta__?.lastAppliedConfigSnapshot || null;
            if (!snap) return resolve(false);
            const config = readJsonSafe(CONFIG_FILE, { plugins: {} });
            if (!config.plugins) config.plugins = {};
            const activeProfile = profiles[lastActiveId];
            let changed = false;

            for (const item of list) {
              const rawKey = item?.id || item?.name || item?.pluginId || item?.directory || "";
              const dir = String(rawKey).split("@")[0].trim();
              if (!dir || PROTECTED_PLUGINS.has(dir) || !isValidPluginDirectory(dir)) continue;
              const enabledInLs = typeof item?.userConfig?.enabled === "boolean"
                ? item.userConfig.enabled
                : (typeof item?.disabled === "boolean" ? !item.disabled : item?.enabled);
              if (typeof enabledInLs !== "boolean") continue;
              if (snap[dir] === undefined) continue;
              const profileVal = Boolean(activeProfile.plugins[dir]);
              const configVal = Boolean(config.plugins?.[dir]?.enabled !== false);
              // 仅当基准快照、config.json 与当前项目 Profile 三者完全一致（确认为同项目稳定基线），且 LS 内存值偏离该基线时，才认定为用户在原生 Settings 中手动拨动了开关
              if (Boolean(snap[dir]) !== profileVal || configVal !== profileVal) continue;
              if (enabledInLs !== profileVal) {
                activeProfile.plugins[dir] = enabledInLs;
                if (!config.plugins[dir]) config.plugins[dir] = {};
                config.plugins[dir].enabled = enabledInLs;
                changed = true;
              }
            }

            if (changed) {
              recordConfigWriteMeta(profiles, config, lastActiveId);
              writeJsonSafe(PROFILES_FILE, profiles);
              writeJsonSafe(CONFIG_FILE, config);
              return resolve(true);
            }
            resolve(false);
          } catch (err) {
            resolve(false);
          }
        });
      });
      req.on("timeout", () => {
        req.destroy();
        resolve(false);
      });
      req.on("error", () => resolve(false));
      req.write("{}");
      req.end();
    } catch (e) {
      resolve(false);
    }
  });
}

export {
  PLUGINS_DIR,
  CONFIG_FILE,
  PROFILES_FILE,
  PROFILES_BAK_FILE,
  PROJECTS_DIR,
  APP_STORAGE_FILE,
  DEVTOOLS_ACTIVE_PORT_FILE,
  CONV_DB_PATH,
  PROTECTED_PLUGINS,
  DEFAULT_KEY,
  PRELOAD_SDK_PATH,
  isValidPluginDirectory,
  resolveProjectIdFromDb,
  getLatestActiveProjectIdFromDb,
  discoverElectronCdpPort,
  refreshFocusedWindowRoute,
  getFocusedWindowRoute,
  readJsonSafe,
  getPluginManifest,
  resolvePluginLogoFile,
  resolvePluginLogoUrl,
  extractConfigPluginSnapshot,
  recordConfigWriteMeta,
  writeJsonSafe,
  notifyLanguageServer
};
