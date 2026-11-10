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
  const realEnv = String(process.env.AGY_REAL_USERPROFILE || "").trim();
  if (realEnv && fs.existsSync(realEnv)) return path.normalize(realEnv);
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
    fs.watchFile(fullBackendPath, { interval: 1500, persistent: false }, (curr, prev) => {
      if (curr.mtimeMs !== prev.mtimeMs) {
        console.log(`[PluginSwitcher Sidecar] Backend file ${backendFile} updated on disk, restarting sidecar...`);
        setTimeout(() => process.exit(0), 200);
      }
    });
  } catch (e) {}
}

// 若当前进程为 Antigravity 宿主拉起的内置 Sidecar（携带动态端口），仅驱逐可能霸占 8088 端口的旧独立进程（onlyStandalone=1），绝不误杀其他多开宿主窗口的内置 Sidecar
if (PORT !== 8088 && process.env.ANTIGRAVITY_SIDECAR_WEB_PORT && process.env.PLUGIN_SWITCHER_DISABLE_8088 !== "1") {
  try {
    const evictReq = http.request({
      hostname: "127.0.0.1",
      port: 8088,
      path: "/api/restart-sidecar?onlyStandalone=1",
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
const MAIN_USER_DATA_DIR = path.join(appDataDir, "Antigravity");
const INSTANCES_ROOT_DIR = path.join(homeDir, ".gemini", "antigravity-instances");
const APP_STORAGE_FILE = path.join(MAIN_USER_DATA_DIR, "app_storage.json");
const DEVTOOLS_ACTIVE_PORT_FILE = path.join(MAIN_USER_DATA_DIR, "DevToolsActivePort");
const LS_LOG_FILE = path.join(MAIN_USER_DATA_DIR, "logs", "language_server.log");
const CONV_DB_PATH = path.join(homeDir, ".gemini", "antigravity", "conversation_summaries.db");
const PROTECTED_PLUGINS = new Set(["plugin-switcher"]);
const DEFAULT_KEY = "__default__";

const PRELOAD_SDK_PATH = path.join(homeDir, ".gemini", "antigravity", "lib", "node_modules", "sidecar_sdk", "preload.js");

function extractActiveSegmentFromLsLog(logFilePath) {
  try {
    if (!logFilePath || !fs.existsSync(logFilePath)) return { pid: 0, httpPort: 0, segment: "" };
    const logText = fs.readFileSync(logFilePath, "utf-8");
    const pidMatches = [...logText.matchAll(/Starting language server process with pid (\d+)/gi)];
    let pid = 0;
    let segment = logText;
    if (pidMatches.length > 0) {
      const last = pidMatches[pidMatches.length - 1];
      pid = Number(last[1] || 0);
      segment = typeof last.index === "number" ? logText.slice(last.index) : logText;
    }
    const httpMatches = [...segment.matchAll(/Language server listening on random port at (\d+) for HTTP\b/gi)];
    const httpPort = httpMatches.length > 0 ? Number(httpMatches[httpMatches.length - 1][1] || 0) : 0;
    return { pid, httpPort, segment };
  } catch (e) {
    return { pid: 0, httpPort: 0, segment: "" };
  }
}

function buildInstanceContextObject(instanceId, userDataDir, isIsolatedInstance) {
  const dir = userDataDir || MAIN_USER_DATA_DIR;
  return {
    instanceId: instanceId || "main",
    isIsolatedInstance: Boolean(isIsolatedInstance),
    userDataDir: dir,
    devToolsActivePortFile: path.join(dir, "DevToolsActivePort"),
    lsLogFile: path.join(dir, "logs", "language_server.log"),
    appStorageFile: path.join(dir, "app_storage.json"),
    standalonePort: isIsolatedInstance ? 8098 : 8088
  };
}

function listAllSwitcherInstances() {
  const list = [];
  try {
    if (fs.existsSync(INSTANCES_ROOT_DIR)) {
      const dirs = fs.readdirSync(INSTANCES_ROOT_DIR);
      const isoList = [];
      for (const dirName of dirs) {
        if (dirName.startsWith(".")) continue;
        const fullDir = path.join(INSTANCES_ROOT_DIR, dirName);
        const logFile = path.join(fullDir, "logs", "language_server.log");
        const devPortFile = path.join(fullDir, "DevToolsActivePort");
        if (fs.existsSync(logFile) || fs.existsSync(devPortFile)) {
          let mtimeMs = 0;
          try {
            if (fs.existsSync(logFile)) mtimeMs = fs.statSync(logFile).mtimeMs;
            else if (fs.existsSync(devPortFile)) mtimeMs = fs.statSync(devPortFile).mtimeMs;
          } catch (e) {}
          isoList.push({
            ...buildInstanceContextObject(dirName, fullDir, true),
            mtimeMs
          });
        }
      }
      isoList.sort((a, b) => b.mtimeMs - a.mtimeMs);
      list.push(...isoList);
    }
  } catch (e) {}
  list.push(buildInstanceContextObject("main", MAIN_USER_DATA_DIR, false));
  return list;
}

const portInstanceCache = new Map();

function resolveSwitcherInstanceContext(localPort = 0) {
  const targetPort = Number(localPort || PORT || 0);
  const now = Date.now();
  if (portInstanceCache.has(targetPort)) {
    const cached = portInstanceCache.get(targetPort);
    if (cached.confirmed || (now - cached.at < 1500)) {
      return cached.ctx;
    }
  }

  const allInstances = listAllSwitcherInstances();
  const mainCtx = allInstances.find((x) => !x.isIsolatedInstance) || buildInstanceContextObject("main", MAIN_USER_DATA_DIR, false);
  const primaryIsoCtx = allInstances.find((x) => x.isIsolatedInstance) || null;

  // 1. 显式克隆端口映射：8088 固定映射主实例，8098 固定映射多开实例
  if (targetPort === 8088) {
    portInstanceCache.set(targetPort, { ctx: mainCtx, confirmed: true, at: now });
    return mainCtx;
  }
  if (targetPort === 8098 && primaryIsoCtx) {
    portInstanceCache.set(targetPort, { ctx: primaryIsoCtx, confirmed: true, at: now });
    return primaryIsoCtx;
  }

  // 2. 精确匹配各实例 language_server.log 中分配给 plugin-switcher/panel 的动态端口或父进程 PID
  const switcherPortRegex = targetPort > 0
    ? new RegExp(`Sidecar\\s+plugin-switcher/panel\\s+gateway[^\\r\\n]*proxying to loopback port\\s+${targetPort}\\b`, "i")
    : null;
  const genericPortRegex = targetPort > 0
    ? new RegExp(`proxying to loopback port\\s+${targetPort}\\b`, "i")
    : null;
  const ppid = Number(process.ppid || 0);

  for (const cand of allInstances) {
    const { pid, httpPort, segment } = extractActiveSegmentFromLsLog(cand.lsLogFile);
    const matchedPort = Boolean(
      segment &&
      ((switcherPortRegex && switcherPortRegex.test(segment)) || (genericPortRegex && genericPortRegex.test(segment)))
    );
    const matchedPpid = Boolean(targetPort === PORT && ppid > 0 && pid > 0 && pid === ppid);
    if (matchedPort || matchedPpid) {
      const resolved = { ...cand, lsPid: pid, lsHttpPort: httpPort };
      portInstanceCache.set(targetPort, { ctx: resolved, confirmed: true, at: now });
      return resolved;
    }
  }

  // 3. 环境变量与隔离 HOME 路径匹配（适用于当前进程默认上下文）
  if (targetPort === PORT || targetPort === 0) {
    const envDir = String(process.env.AGY_RELAY_INSTANCE_USER_DATA_DIR || "").trim();
    const envId = String(process.env.AGY_RELAY_INSTANCE_ID || "").trim();
    if (envDir && fs.existsSync(envDir)) {
      const id = envId || path.basename(envDir);
      const resolved = buildInstanceContextObject(id, envDir, id !== "main");
      portInstanceCache.set(targetPort, { ctx: resolved, confirmed: true, at: now });
      return resolved;
    }
    const rawUserProfile = String(process.env.USERPROFILE || process.env.HOME || "").replace(/\\/g, "/");
    const isoMatch = rawUserProfile.match(/antigravity-instances\/([^/]+)/i);
    if (isoMatch && isoMatch[1]) {
      const id = isoMatch[1].trim();
      const isoDir = path.join(INSTANCES_ROOT_DIR, id);
      if (fs.existsSync(isoDir)) {
        const resolved = buildInstanceContextObject(id, isoDir, true);
        portInstanceCache.set(targetPort, { ctx: resolved, confirmed: true, at: now });
        return resolved;
      }
    }
  }

  portInstanceCache.set(targetPort, { ctx: mainCtx, confirmed: false, at: now });
  return mainCtx;
}

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

// 动态发现指定实例 Antigravity Electron 主窗口的本地 CDP 端口（按实例隔离，绝不串窗）
// 优先级 1：读取该实例 userDataDir 下的 DevToolsActivePort 第 1 行
// 优先级 2：从该实例 logs/language_server.log 尾部提取最新 WS URL 端口
const cdpPortCacheByInstance = new Map();
const routeCacheByInstance = new Map();
const inflightRouteByInstance = new Map();

function discoverElectronCdpPort(forceRefresh = false, instanceCtx = null) {
  const ctx = instanceCtx || resolveSwitcherInstanceContext(PORT);
  const instKey = ctx.instanceId || "main";
  const now = Date.now();
  const cached = cdpPortCacheByInstance.get(instKey);
  if (!forceRefresh && cached && cached.port > 1024 && (now - cached.at < 5000)) {
    return cached.port;
  }

  const devToolsFile = ctx.devToolsActivePortFile || DEVTOOLS_ACTIVE_PORT_FILE;
  const lsLogFile = ctx.lsLogFile || LS_LOG_FILE;

  // 1. 首选读取该实例专属 DevToolsActivePort 第一行
  try {
    if (fs.existsSync(devToolsFile)) {
      const raw = fs.readFileSync(devToolsFile, "utf-8");
      const firstLine = (raw.split(/\r?\n/)[0] || "").trim();
      const port = Number(firstLine);
      if (port > 1024 && port < 65535) {
        cdpPortCacheByInstance.set(instKey, { port, at: now });
        return port;
      }
    }
  } catch (e) {}

  // 2. 次选从该实例专属 language_server.log 尾部动态提取
  try {
    if (fs.existsSync(lsLogFile)) {
      const stat = fs.statSync(lsLogFile);
      const readSize = Math.min(stat.size, 24576);
      const fd = fs.openSync(lsLogFile, "r");
      const buf = Buffer.alloc(readSize);
      fs.readSync(fd, buf, 0, readSize, Math.max(0, stat.size - readSize));
      fs.closeSync(fd);
      const tail = buf.toString("utf-8");
      const matches = [...tail.matchAll(/ws:\/\/127\.0\.0\.1:(\d+)\/devtools\/browser\//g)];
      if (matches.length > 0) {
        const port = Number(matches[matches.length - 1][1]);
        if (port > 1024 && port < 65535) {
          cdpPortCacheByInstance.set(instKey, { port, at: now });
          return port;
        }
      }
    }
  } catch (e) {}

  return (cached && cached.port) || 13305;
}

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

// 实时读取指定实例 Antigravity Electron 窗口 page 路由 (/c/<convId>?section=<projectId>)
async function refreshFocusedWindowRoute(force = false, instanceCtx = null) {
  const ctx = instanceCtx || resolveSwitcherInstanceContext(PORT);
  const instKey = ctx.instanceId || "main";
  const now = Date.now();
  const prevRoute = routeCacheByInstance.get(instKey) || {
    instanceId: instKey,
    projectId: "",
    convId: "",
    sectionProjId: "",
    rawUrl: "",
    title: "",
    port: 0,
    updatedAt: 0
  };

  if (!force && prevRoute.updatedAt > 0 && (now - prevRoute.updatedAt < 250)) {
    return prevRoute;
  }
  if (inflightRouteByInstance.has(instKey)) {
    return inflightRouteByInstance.get(instKey);
  }

  const p = (async () => {
    let port = discoverElectronCdpPort(false, ctx);
    let targets = null;
    try {
      targets = await fetchCdpTargetsJson(port);
    } catch (e) {
      const freshPort = discoverElectronCdpPort(true, ctx);
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
        (t.url.includes("/c/") || t.url.includes("section=") || t.url.includes("project=") || (t.title || "").includes("Antigravity"))
      );
      if (pageTarget && pageTarget.url) {
        const rawUrl = pageTarget.url;
        const convMatch = rawUrl.match(/\/c\/([0-9a-f-]{36})/i);
        const secMatch = rawUrl.match(/[?&](?:section|project)=([0-9a-f-]{36})/i);
        const convId = convMatch ? convMatch[1] : "";
        const sectionProjId = secMatch ? secMatch[1] : "";

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
        const nextRoute = {
          instanceId: instKey,
          projectId: resolvedProjectId || "",
          convId,
          sectionProjId,
          rawUrl,
          title: pageTarget.title || "",
          port,
          updatedAt: Date.now()
        };
        routeCacheByInstance.set(instKey, nextRoute);
        return nextRoute;
      }
    }
    return prevRoute;
  })().finally(() => {
    inflightRouteByInstance.delete(instKey);
  });

  inflightRouteByInstance.set(instKey, p);
  return p;
}

function getFocusedWindowRoute(instanceCtx = null) {
  const ctx = instanceCtx || resolveSwitcherInstanceContext(PORT);
  const instKey = ctx.instanceId || "main";
  return routeCacheByInstance.get(instKey) || {
    instanceId: instKey,
    projectId: "",
    convId: "",
    sectionProjId: "",
    rawUrl: "",
    title: "",
    port: 0,
    updatedAt: 0
  };
}

// 启动时立即探测一次当前实例窗口路由
refreshFocusedWindowRoute(true, resolveSwitcherInstanceContext(PORT)).catch(() => {});

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
let lastInternalProfilesWriteMs = 0;
let inflightLsRpcCount = 0;
let lastLsRpcDoneMs = 0;
const lsRpcTargetByInstance = new Map();

function resolveLsRpcTarget(profilesHint = null, instanceCtx = null) {
  const selfCtx = resolveSwitcherInstanceContext(PORT);
  const ctx = instanceCtx || selfCtx;
  const instKey = ctx.instanceId || "main";

  // 若查询的正是当前 Sidecar 宿主所属实例，优先使用宿主注入的环境变量
  if (instKey === selfCtx.instanceId) {
    const envAddr = process.env.ANTIGRAVITY_LS_ADDRESS || "";
    const envCsrf = process.env.ANTIGRAVITY_CSRF_TOKEN || "";
    if (envAddr && envCsrf) {
      const [hostname, portStr] = envAddr.split(":");
      const port = Number(portStr || 5387);
      if (hostname && port > 0) {
        const target = { hostname, port, csrf: envCsrf };
        lsRpcTargetByInstance.set(instKey, { target, at: Date.now() });
        return target;
      }
    }
  }

  const cached = lsRpcTargetByInstance.get(instKey);
  if (cached && (Date.now() - cached.at < 30000)) {
    return cached.target;
  }

  const instMetaTarget = profilesHint?.__meta__?.instances?.[instKey]?.lsRpcTarget;
  if (instMetaTarget && instMetaTarget.port && instMetaTarget.csrf) {
    const target = {
      hostname: instMetaTarget.hostname || "127.0.0.1",
      port: Number(instMetaTarget.port),
      csrf: String(instMetaTarget.csrf)
    };
    lsRpcTargetByInstance.set(instKey, { target, at: Date.now() });
    return target;
  }

  // 兜底：从 antigravity-relay 的共享配置中读取该实例已发现的 lsRpcTarget（含 csrf 与 http 端口）
  try {
    const relayCfgPath = path.join(PLUGINS_DIR, "antigravity-relay", "data", "agy-relay-config.json");
    if (fs.existsSync(relayCfgPath)) {
      const relayCfg = JSON.parse(fs.readFileSync(relayCfgPath, "utf-8"));
      const relayTarget = relayCfg?.__meta__?.instances?.[instKey]?.lsRpcTarget || (!ctx.isIsolatedInstance ? relayCfg?.__meta__?.lsRpcTarget : null);
      if (relayTarget && relayTarget.csrf) {
        const { httpPort } = extractActiveSegmentFromLsLog(ctx.lsLogFile);
        const port = Number(httpPort || (relayTarget.protocol === "http" ? relayTarget.port : relayTarget.altPort) || relayTarget.port || 0);
        if (port > 0) {
          const target = {
            hostname: relayTarget.hostname || "127.0.0.1",
            port,
            csrf: String(relayTarget.csrf)
          };
          lsRpcTargetByInstance.set(instKey, { target, at: Date.now() });
          return target;
        }
      }
    }
  } catch (e) {}

  if (!ctx.isIsolatedInstance) {
    const metaTarget = profilesHint?.__meta__?.lsRpcTarget;
    if (metaTarget && metaTarget.port && metaTarget.csrf) {
      const target = {
        hostname: metaTarget.hostname || "127.0.0.1",
        port: Number(metaTarget.port),
        csrf: String(metaTarget.csrf)
      };
      lsRpcTargetByInstance.set(instKey, { target, at: Date.now() });
      return target;
    }
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

function recordConfigWriteMeta(profiles, config, appliedProjectId = "", didWriteConfigFile = true, instanceCtx = null) {
  if (!profiles || typeof profiles !== "object") return;
  if (!profiles.__meta__) profiles.__meta__ = {};
  if (!profiles.__meta__.instances || typeof profiles.__meta__.instances !== "object") {
    profiles.__meta__.instances = {};
  }
  const ctx = instanceCtx || resolveSwitcherInstanceContext(PORT);
  const instKey = ctx.instanceId || "main";
  if (!profiles.__meta__.instances[instKey] || typeof profiles.__meta__.instances[instKey] !== "object") {
    profiles.__meta__.instances[instKey] = {};
  }
  const instMeta = profiles.__meta__.instances[instKey];

  const now = Date.now();
  if (didWriteConfigFile) {
    lastInternalConfigWriteMs = now;
    profiles.__meta__.lastInternalConfigWriteAt = now;
    instMeta.lastInternalConfigWriteAt = now;
  }
  const snap = extractConfigPluginSnapshot(config);
  profiles.__meta__.lastAppliedConfigSnapshot = snap;
  instMeta.lastAppliedConfigSnapshot = snap;

  const effectiveProjId = (appliedProjectId && appliedProjectId !== DEFAULT_KEY)
    ? appliedProjectId
    : (instMeta.lastActiveProjectId || profiles.__meta__.lastActiveProjectId || "");
  if (effectiveProjId) {
    profiles.__meta__.lastAppliedProjectId = effectiveProjId;
    instMeta.lastAppliedProjectId = effectiveProjId;
  }
  const target = resolveLsRpcTarget(profiles, ctx);
  if (target) {
    const rpcObj = {
      hostname: target.hostname,
      port: target.port,
      csrf: target.csrf,
      updatedAt: now
    };
    instMeta.lsRpcTarget = rpcObj;
    if (!ctx.isIsolatedInstance) {
      profiles.__meta__.lsRpcTarget = rpcObj;
    }
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
      lastInternalProfilesWriteMs = Date.now();
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

function sendJetboxWriteStateToTarget(target, pluginUpdates) {
  if (!target || !target.csrf || !target.port) return;
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
      hostname: target.hostname || "127.0.0.1",
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

function notifyLanguageServer(pluginUpdates, profilesHint = null, instanceCtx = null) {
  const target = resolveLsRpcTarget(profilesHint, instanceCtx);
  sendJetboxWriteStateToTarget(target, pluginUpdates);
}

// 当某个项目的配置被修改时，同步通知所有正处于该项目下的实例 Language Server（实现跨实例实时生效）
function notifyMatchingInstancesLanguageServers(projectIds, pluginUpdates, profilesHint = null, currentCtx = null, currentActiveId = "") {
  const idSet = new Set(Array.isArray(projectIds) ? projectIds : [projectIds]);
  const sentPorts = new Set();
  const ctx = currentCtx || resolveSwitcherInstanceContext(PORT);

  if (currentActiveId && idSet.has(currentActiveId)) {
    const t = resolveLsRpcTarget(profilesHint, ctx);
    if (t && t.port) {
      sentPorts.add(Number(t.port));
      sendJetboxWriteStateToTarget(t, pluginUpdates);
    }
  }

  const allInstances = listAllSwitcherInstances();
  for (const cand of allInstances) {
    const instMeta = profilesHint?.__meta__?.instances?.[cand.instanceId];
    const route = getFocusedWindowRoute(cand);
    const activeIdForCand = (route && route.projectId) || instMeta?.lastActiveProjectId || "";
    if (activeIdForCand && idSet.has(activeIdForCand)) {
      const t = resolveLsRpcTarget(profilesHint, cand);
      if (t && t.port && !sentPorts.has(Number(t.port))) {
        sentPorts.add(Number(t.port));
        sendJetboxWriteStateToTarget(t, pluginUpdates);
      }
    }
  }
}

export function getLastInternalConfigWriteMs() {
  return Math.max(lastInternalConfigWriteMs, lastLsRpcDoneMs);
}

export function isInternalConfigWriteSettled(minSettleMs = 450) {
  if (inflightLsRpcCount > 0) return false;
  return (Date.now() - Math.max(lastInternalConfigWriteMs, lastLsRpcDoneMs)) > minSettleMs;
}

export function isInternalProfilesWriteSettled(minSettleMs = 600) {
  return (Date.now() - lastInternalProfilesWriteMs) > minSettleMs;
}

export {
  PLUGINS_DIR,
  CONFIG_FILE,
  PROFILES_FILE,
  PROFILES_BAK_FILE,
  PROJECTS_DIR,
  MAIN_USER_DATA_DIR,
  INSTANCES_ROOT_DIR,
  APP_STORAGE_FILE,
  DEVTOOLS_ACTIVE_PORT_FILE,
  CONV_DB_PATH,
  PROTECTED_PLUGINS,
  DEFAULT_KEY,
  PRELOAD_SDK_PATH,
  listAllSwitcherInstances,
  resolveSwitcherInstanceContext,
  resolveLsRpcTarget,
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
  notifyLanguageServer,
  notifyMatchingInstancesLanguageServers
};
