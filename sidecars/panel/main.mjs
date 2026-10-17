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

let lastInternalConfigWriteMs = 0;

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

function scanAntigravityProjects() {
  const projectList = [];
  if (!fs.existsSync(PROJECTS_DIR)) return projectList;

  // 1. 读取侧边栏拖拽顺序与伴生容器配置
  const appStorage = readJsonSafe(APP_STORAGE_FILE, {});
  const hostConfig = readJsonSafe(CONFIG_FILE, {});
  const sidecarProjectIds = new Set();
  if (hostConfig && hostConfig.sidecars && typeof hostConfig.sidecars === "object") {
    for (const sc of Object.values(hostConfig.sidecars)) {
      if (sc && sc.projectId) sidecarProjectIds.add(sc.projectId);
    }
  }

  let orderArray = [];
  try {
    orderArray = JSON.parse(appStorage.projectsOrder || "[]");
  } catch (e) {}

  const orderMap = new Map();
  orderArray.forEach((id, index) => {
    orderMap.set(id, index);
  });
  const lastCreatedId = appStorage.lastCreatedProjectId || "";

  // 2. 读取 projects 目录下全部项目配置
  try {
    const files = fs.readdirSync(PROJECTS_DIR);
    for (const f of files) {
      if (!f.endsWith(".json") || f === "outside-of-project.json") continue;
      const fullPath = path.join(PROJECTS_DIR, f);
      const data = readJsonSafe(fullPath, null);
      if (!data || !data.id || data.archived === true || data.isArchived === true) continue;
      // 严密过滤内部伴生容器与自动化虚拟项目（严禁污染业务工程下拉菜单）
      if (
        sidecarProjectIds.has(data.id) ||
        (data.name && (data.name.startsWith("plugin-") || data.name.includes("/sidecars/") || data.name.includes("/panel") || data.name.includes("/")))
      ) {
        continue;
      }

      const id = data.id;
      const name = data.name || id;
      const paths = [];

      const resources = (data.projectResources && data.projectResources.resources) || [];
      for (const res of resources) {
        const uri = res.folderUri || (res.gitFolder && res.gitFolder.folderUri) || "";
        if (uri && uri.startsWith("file:///")) {
          try {
            let p = decodeURIComponent(uri.replace(/^file:\/\/\//, ""));
            p = p.replace(/\\/g, "/");
            p = p.replace(/^([a-zA-Z])%3A/i, "$1:").replace(/^([a-zA-Z])%3a/i, "$1:");
            while (p.endsWith("/")) p = p.slice(0, -1);
            if (p) paths.push(p);
          } catch (e) {}
        }
      }

      projectList.push({
        id,
        name,
        paths,
        primaryPath: paths[0] || "",
        isPureChat: paths.length === 0
      });
    }
  } catch (e) {}

  // 3. 严格按侧边栏拖拽顺序排序
  projectList.sort((a, b) => {
    const aHas = orderMap.has(a.id);
    const bHas = orderMap.has(b.id);

    if (aHas && bHas) {
      return orderMap.get(a.id) - orderMap.get(b.id);
    }
    if (a.id === lastCreatedId) return -1;
    if (b.id === lastCreatedId) return 1;
    if (aHas && !bHas) return -1;
    if (!aHas && bHas) return 1;
    return a.name.localeCompare(b.name, "zh-CN");
  });

  return projectList;
}

function normalizePath(str) {
  if (!str || typeof str !== "string") return "";
  let p = str.trim();
  p = p.replace(/^file:\/\/\//i, "").replace(/^file:\/\//i, "");
  try {
    p = decodeURIComponent(p);
  } catch (e) {}
  p = p.replace(/\\/g, "/");
  p = p.replace(/^([a-zA-Z])%3A/i, "$1:").replace(/^([a-zA-Z])%3a/i, "$1:");
  p = p.replace(/^\/([a-zA-Z]:)/, "$1");
  while (p.endsWith("/")) {
    p = p.slice(0, -1);
  }
  return p.toLowerCase();
}

function findProjectIdByWorkspaceUris(uris, projects = []) {
  if (!uris || !projects || !projects.length) return "";
  let uriList = [];
  if (Array.isArray(uris)) {
    uriList = uris;
  } else if (typeof uris === "string") {
    const trimmed = uris.trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) uriList = parsed;
      } catch (e) {}
    }
    if (!uriList.length) {
      uriList = trimmed.split("|").map(s => s.trim());
    }
  }
  uriList = uriList.filter(Boolean);
  if (!uriList.length) return "";

  let bestProjectId = "";
  let maxScore = -1;

  for (const uri of uriList) {
    const normUri = normalizePath(uri);
    if (!normUri) continue;
    for (const proj of projects) {
      for (const p of proj.paths || []) {
        const normProjPath = normalizePath(p);
        if (!normProjPath) continue;

        let score = -1;
        if (normUri === normProjPath) {
          score = 10000 + normProjPath.length;
        } else if (normUri.startsWith(normProjPath + "/")) {
          score = normProjPath.length;
        }

        if (score > maxScore) {
          maxScore = score;
          bestProjectId = proj.id;
        }
      }
    }
  }

  return bestProjectId;
}

function resolveConvIdFromToken(token, appStorage) {
  if (!token) return { convId: "", newConvoProjId: "" };
  try {
    const storage = appStorage || readJsonSafe(APP_STORAGE_FILE, {});
    let v2 = storage["aux-pane-v2-session"];
    if (typeof v2 === "string") {
      try { v2 = JSON.parse(v2); } catch (e) { v2 = {}; }
    }
    if (!v2) return { convId: "", newConvoProjId: "" };

    const matchedConvIds = [];
    const conversationPanes = v2.conversationPanes || {};
    for (const [cId, pane] of Object.entries(conversationPanes)) {
      const tabs = pane?.tabs || [];
      for (const tab of tabs) {
        const scUrl = tab?.content?.sidecarView?.url || "";
        if (scUrl.includes(`token=${token}`)) {
          matchedConvIds.push(cId);
          break;
        }
      }
    }

    let tokenMatchedNewConvoProjId = "";
    const newConversationPanes = v2.newConversationPanes || {};
    for (const [projId, pane] of Object.entries(newConversationPanes)) {
      const tabs = pane?.tabs || [];
      for (const tab of tabs) {
        const scUrl = tab?.content?.sidecarView?.url || "";
        if (scUrl.includes(`token=${token}`)) {
          tokenMatchedNewConvoProjId = projId;
          break;
        }
      }
      if (tokenMatchedNewConvoProjId) break;
    }

    if (matchedConvIds.length === 1) {
      return { convId: matchedConvIds[0], newConvoProjId: tokenMatchedNewConvoProjId };
    }
    if (matchedConvIds.length > 1) {
      let pco = storage.projectsConversationOrder;
      if (typeof pco === "string") {
        try { pco = JSON.parse(pco); } catch (e) { pco = []; }
      }
      if (Array.isArray(pco) && pco.length > 0) {
        const found = pco.find(id => matchedConvIds.includes(id));
        if (found) return { convId: found, newConvoProjId: tokenMatchedNewConvoProjId };
      }
      return { convId: matchedConvIds[0], newConvoProjId: tokenMatchedNewConvoProjId };
    }

    return { convId: "", newConvoProjId: tokenMatchedNewConvoProjId };
  } catch (e) {
    return { convId: "", newConvoProjId: "" };
  }
}

function resolveCurrentActiveProjectId(params = {}, projects = []) {
  let convId = "";
  let clientProjectId = "";
  let clientWorkspaceUri = "";
  let token = "";

  if (typeof params === "string") {
    convId = params;
  } else if (params && typeof params === "object") {
    convId = params.convId || params.conversationId || "";
    clientProjectId = params.clientProjectId || params.projectId || "";
    clientWorkspaceUri = params.clientWorkspaceUri || params.workspaceUri || "";
    token = params.token || "";
  }

  const appStorage = readJsonSafe(APP_STORAGE_FILE, {});

  // 优先级 1：严格校验 clientProjectId：必须是合法的 36 位 UUID 且在 projects 中存在才采信
  if (clientProjectId && /^[0-9a-f-]{36}$/i.test(clientProjectId) && projects && projects.length) {
    const found = projects.find(p => p.id === clientProjectId);
    if (found) {
      const activeWorkspace = (clientWorkspaceUri || process.env.WORKSPACE_ROOT || "").replace(/\\/g, "/");
      return { activeProjectId: clientProjectId, effectiveConvId: convId, activeWorkspace };
    }
  }

  // 补全 convId：若 !convId && token，通过 resolveConvIdFromToken 反查
  let tokenMatchedNewConvoProjId = "";
  if (!convId && token) {
    const tokenRes = resolveConvIdFromToken(token, appStorage);
    if (tokenRes.convId) {
      convId = tokenRes.convId;
    }
    if (tokenRes.newConvoProjId) {
      tokenMatchedNewConvoProjId = tokenRes.newConvoProjId;
    }
  }

  // 计算两个核心信号
  let convProjId = "";
  if (convId) {
    const pId = resolveProjectIdFromDb(convId);
    if (pId && projects.some(p => p.id === pId)) {
      convProjId = pId;
    }
  } else if (tokenMatchedNewConvoProjId && projects.some(p => p.id === tokenMatchedNewConvoProjId)) {
    convProjId = tokenMatchedNewConvoProjId;
  }

  let wsProjId = "";
  if (clientWorkspaceUri) {
    wsProjId = findProjectIdByWorkspaceUris(clientWorkspaceUri, projects);
  }

  let activeProjectId = "";

  // 智能协同裁决（优先级 2 & 3）
  if (convProjId && wsProjId) {
    if (convProjId === wsProjId) {
      activeProjectId = convProjId;
    } else {
      const convProj = projects.find(p => p.id === convProjId);
      const wsProj = projects.find(p => p.id === wsProjId);

      let isConvSubOfWs = false;
      if (convProj && wsProj) {
        for (const cp of convProj.paths || []) {
          const normCp = normalizePath(cp);
          for (const wp of wsProj.paths || []) {
            const normWp = normalizePath(wp);
            if (normCp && normWp && normCp.startsWith(normWp + "/")) {
              isConvSubOfWs = true;
              break;
            }
          }
          if (isConvSubOfWs) break;
        }
      }

      if (isConvSubOfWs) {
        // 历史对话挂在父目录 Visual Studio 下，但对话本身属于子项目 Fox Server
        activeProjectId = convProjId;
      } else if (convProj && convProj.isPureChat && !clientWorkspaceUri) {
        activeProjectId = convProjId;
      } else {
        // 其他跨项目切换场景，优先返回实时推送的 wsProjId
        activeProjectId = wsProjId;
      }
    }
  } else if (wsProjId) {
    activeProjectId = wsProjId;
  } else if (convProjId) {
    activeProjectId = convProjId;
  }

  // 优先级 4（无目录新对话草稿页兜底）
  if (!activeProjectId) {
    const lastSelected = appStorage["new-convo-last-selected-project"];
    if (lastSelected && projects.some(p => p.id === lastSelected)) {
      activeProjectId = lastSelected;
    } else {
      const storageConvId = getActiveConversationIdFromStorage();
      if (storageConvId) {
        const storageProjId = resolveProjectIdFromDb(storageConvId);
        if (storageProjId && projects.some(p => p.id === storageProjId)) {
          activeProjectId = storageProjId;
        }
      }
    }
  }

  // 优先级 5（getLatestActiveProjectIdFromDb() 兜底）
  if (!activeProjectId) {
    const latestId = getLatestActiveProjectIdFromDb();
    if (latestId && projects.some(p => p.id === latestId)) {
      activeProjectId = latestId;
    }
  }

  let effectiveConvId = convId || getActiveConversationIdFromStorage();
  const activeWorkspace = (clientWorkspaceUri || "").replace(/\\/g, "/");

  return { activeProjectId, effectiveConvId, activeWorkspace };
}

function getSystemState(query = {}) {
  let convId = "";
  let clientProjectId = "";
  let clientWorkspaceUri = "";
  let token = "";
  let isPassive = false;

  if (typeof query === "string") {
    convId = query;
  } else if (query && typeof query === "object") {
    convId = query.convId || query.conversationId || "";
    clientProjectId = query.clientProjectId || query.projectId || "";
    clientWorkspaceUri = query.clientWorkspaceUri || query.workspaceUri || "";
    token = query.token || "";
    isPassive = query.isPassive === true;
  }
  const config = readJsonSafe(CONFIG_FILE, { plugins: {} });
  const rawProfiles = readJsonSafe(PROFILES_FILE, {});

  // 1. 初始化纯净基准默认配置（动态发现已安装插件）
  if (!rawProfiles[DEFAULT_KEY] || rawProfiles[DEFAULT_KEY].name !== "默认配置") {
    const initialDefaultPlugins = {};
    if (fs.existsSync(PLUGINS_DIR)) {
      for (const entry of fs.readdirSync(PLUGINS_DIR, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          initialDefaultPlugins[entry.name] = (config.plugins?.[entry.name]?.enabled !== false);
        }
      }
    }
    rawProfiles[DEFAULT_KEY] = {
      id: DEFAULT_KEY,
      name: "默认配置",
      paths: [],
      plugins: (rawProfiles[DEFAULT_KEY] && rawProfiles[DEFAULT_KEY].plugins) || initialDefaultPlugins
    };
  }

  // 2. 清洗 profiles：剔除所有基于磁盘物理路径的冗余顶层 Key 与伴生容器，仅保留真实项目 UUID 和特殊 Key
  const sidecarProjectIds = new Set();
  if (config && config.sidecars && typeof config.sidecars === "object") {
    for (const sc of Object.values(config.sidecars)) {
      if (sc && sc.projectId) sidecarProjectIds.add(sc.projectId);
    }
  }

  const profiles = {};
  let profilesModified = false;
  for (const [k, v] of Object.entries(rawProfiles)) {
    if (sidecarProjectIds.has(k)) {
      profilesModified = true;
      continue;
    }
    if (k === DEFAULT_KEY || k === "__meta__" || /^[0-9a-f-]{36}$/i.test(k)) {
      profiles[k] = v;
    } else {
      // 检测到存量路径冗余 Key，标记需要覆写落盘净化
      profilesModified = true;
    }
  }

  const projects = scanAntigravityProjects();
  const defaultPlugins = profiles[DEFAULT_KEY].plugins || {};

  // 3. 彻底独立隔离：为每个真实项目建立独立的深拷贝 Profile
  for (const proj of projects) {
    if (!profiles[proj.id]) {
      // 首次发现项目：从默认配置深拷贝一份完全独立的对象
      profiles[proj.id] = {
        id: proj.id,
        name: proj.name,
        paths: proj.paths || [],
        plugins: JSON.parse(JSON.stringify(defaultPlugins))
      };
      profilesModified = true;
    } else {
      // 确保基础元数据最新
      profiles[proj.id].name = proj.name;
      profiles[proj.id].paths = proj.paths || [];
      if (!profiles[proj.id].plugins) {
        profiles[proj.id].plugins = JSON.parse(JSON.stringify(defaultPlugins));
        profilesModified = true;
      }
    }
  }

  const installedPlugins = [];
  if (fs.existsSync(PLUGINS_DIR)) {
    const entries = fs.readdirSync(PLUGINS_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const dir = entry.name;
        const manifestPath = path.join(PLUGINS_DIR, dir, "plugin.json");
        const manifest = readJsonSafe(manifestPath, {});
        const configEntry = (config.plugins && config.plugins[dir]) || {};
        const isEnabled = configEntry.enabled !== false;

        installedPlugins.push({
          dir,
          name: manifest.name || dir,
          displayName: manifest.displayName || manifest.name || dir,
          description: manifest.description || "本地安装的 Antigravity 插件",
          enabled: isEnabled,
          protected: PROTECTED_PLUGINS.has(dir)
        });
      }
    }
  }

  // 4. 精准探测当前活跃项目（以客户端直传、工作区路径、会话或数据库最新活跃会话为准）
  const { activeProjectId, effectiveConvId, activeWorkspace } = resolveCurrentActiveProjectId(
    { convId, clientProjectId, clientWorkspaceUri, token },
    projects
  );

  // 5. 核心状态机：分清「跨项目切换（配置 -> 软件）」与「同项目内同步（软件 -> 配置）」
  if (!profiles.__meta__) {
    profiles.__meta__ = {};
  }
  const lastActiveId = profiles.__meta__.lastActiveProjectId || "";

  if (activeProjectId && activeProjectId !== DEFAULT_KEY && profiles[activeProjectId]) {
    const activeProfile = profiles[activeProjectId];

    if (lastActiveId !== activeProjectId) {
      if (isPassive && lastActiveId) {
        // 禁止在被动心跳中执行分支 A 的跨项目 config.json 覆写与 lastActiveProjectId 篡改！
      } else {
        // 分支 A：跨项目切换跃变！正向将该项目的独立配置写入 config.json
        if (!config.plugins) config.plugins = {};
        const rpcUpdates = {};
        let configChanged = false;

        for (const [pluginDir, shouldEnable] of Object.entries(activeProfile.plugins || {})) {
          if (PROTECTED_PLUGINS.has(pluginDir)) continue;
          if (!config.plugins[pluginDir]) config.plugins[pluginDir] = {};
          const cur = config.plugins[pluginDir].enabled !== false;
          const target = Boolean(shouldEnable);
          if (cur !== target) {
            config.plugins[pluginDir].enabled = target;
            rpcUpdates[pluginDir] = { enabled: target };
            configChanged = true;
          }
        }

        if (configChanged) {
          writeJsonSafe(CONFIG_FILE, config);
          notifyLanguageServer(rpcUpdates);
          // 同步更新 installedPlugins 内存显示
          for (const p of installedPlugins) {
            if (!p.protected && activeProfile.plugins[p.dir] !== undefined) {
              p.enabled = Boolean(activeProfile.plugins[p.dir]);
            }
          }
        }

        profiles.__meta__.lastActiveProjectId = activeProjectId;
        profilesModified = true;
      }
    } else {
      // 分支 B：停留在同一项目内！检测用户在 Antigravity 软件原生设置中的变动，反向同步进 activeProfile
      let profileChanged = false;
      for (const p of installedPlugins) {
        if (p.protected) continue;
        if (activeProfile.plugins[p.dir] !== p.enabled) {
          activeProfile.plugins[p.dir] = p.enabled;
          profileChanged = true;
        }
      }
      if (profileChanged) {
        profilesModified = true;
      }
    }
  }

  if (profilesModified) {
    writeJsonSafe(PROFILES_FILE, profiles);
  }

  const userSettings = config.userSettings || {};

  return {
    plugins: installedPlugins,
    profiles,
    projects,
    activeWorkspace,
    activeProjectId,
    activeConversationId: effectiveConvId,
    themeSettings: {
      themeMode: userSettings.themeMode || "THEME_MODE_INHERIT",
      customThemeSeedsLight: userSettings.customThemeSeedsLight || {
        background: "#F9F9F9",
        foregroundOverride: "#101010",
        primary: "#007acc"
      },
      customThemeSeedsDark: userSettings.customThemeSeedsDark || {
        background: "#101010",
        foregroundOverride: "#cccccc",
        primary: "#007acc"
      }
    }
  };
}

async function requestHandler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname;

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Sidecar-Token");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // 0. 重启 Sidecar 容器自身（触发进程平滑终止，由 Antigravity 宿主 restart_policy: always 毫秒级重拉）
  if (req.method === "POST" && pathname === "/api/restart-sidecar") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: true, message: "Sidecar restarting..." }));
    setTimeout(() => {
      process.exit(0);
    }, 200);
    return;
  }

  // 0.1 动态切换中英文元数据及外层 Tab 标题
  if (req.method === "POST" && pathname === "/api/set-language") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      try {
        const { lang } = JSON.parse(body || "{}");
        const isEn = lang === "en";
        const pluginJsonPath = path.join(PLUGINS_DIR, "plugin-switcher", "plugin.json");
        const localSidecarPath = path.join(__dirname, "sidecar.json");
        const globalSidecarPath = path.join(homeDir, ".gemini", "config", "sidecars", "plugin-switcher-panel", "sidecar.json");

        const targetDisplayName = isEn ? "Project Plugin Switcher" : "项目插件独立开关管理器";
        const targetDesc = isEn
          ? "Configure and switch Antigravity plugins independently per project with an interactive Auxiliary Pane web console."
          : "按项目独立配置与切换 Antigravity 插件启用状态，提供辅助侧边栏可视化 Web 交互面板。";
        const targetSidecarDisplayName = isEn ? "Project Plugin Switcher" : "项目插件独立开关";
        const targetViewTitle = isEn ? "Plugin Switcher" : "项目插件开关";

        // 1. 更新 plugin.json
        const pluginJson = readJsonSafe(pluginJsonPath, null);
        if (pluginJson) {
          pluginJson.displayName = targetDisplayName;
          pluginJson.description = targetDesc;
          writeJsonSafe(pluginJsonPath, pluginJson);
        }

        // 2. 更新 local & global sidecar.json
        for (const sPath of [localSidecarPath, globalSidecarPath]) {
          const scJson = readJsonSafe(sPath, null);
          if (scJson) {
            scJson.display_name = targetSidecarDisplayName;
            if (scJson.ui_config?.views?.[0]) {
              scJson.ui_config.views[0].title = targetViewTitle;
            }
            writeJsonSafe(sPath, scJson);
          }
        }

        // 3. 更新 app_storage.json 中的 Tab 标题
        const appStorage = readJsonSafe(APP_STORAGE_FILE, null);
        if (appStorage) {
          let storageChanged = false;
          for (const sessionKey of ["aux-pane-v2-session", "aux-pane-session"]) {
            if (!appStorage[sessionKey]) continue;
            let isStr = false;
            let session = appStorage[sessionKey];
            if (typeof session === "string") {
              isStr = true;
              try { session = JSON.parse(session); } catch (e) { continue; }
            }
            let sessionChanged = false;
            for (const paneGroup of [session.conversationPanes, session.newConversationPanes, session.panes]) {
              if (!paneGroup || typeof paneGroup !== "object") continue;
              for (const pane of Object.values(paneGroup)) {
                if (!pane || !Array.isArray(pane.tabs)) continue;
                for (const tab of pane.tabs) {
                  const id = tab.id || "";
                  const url = tab.content?.sidecarView?.url || "";
                  const sidecarId = tab.content?.sidecarView?.sidecarId || "";
                  if (id.includes("plugin-switcher") || url.includes("plugin-switcher") || sidecarId.includes("plugin-switcher")) {
                    if (tab.content?.sidecarView) {
                      if (tab.content.sidecarView.title !== targetViewTitle) {
                        tab.content.sidecarView.title = targetViewTitle;
                        sessionChanged = true;
                      }
                    }
                    if (tab.title && tab.title !== targetViewTitle) {
                      tab.title = targetViewTitle;
                      sessionChanged = true;
                    }
                  }
                }
              }
            }
            if (sessionChanged) {
              appStorage[sessionKey] = isStr ? JSON.stringify(session) : session;
              storageChanged = true;
            }
          }
          if (storageChanged) {
            writeJsonSafe(APP_STORAGE_FILE, appStorage);
          }
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, lang: isEn ? "en" : "zh" }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // 1. 静态主页
  if (req.method === "GET" && pathname === "/") {
    const htmlPath = path.join(__dirname, "index.html");
    if (fs.existsSync(htmlPath)) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(fs.readFileSync(htmlPath, "utf-8"));
    } else {
      res.writeHead(404);
      res.end("index.html not found");
    }
    return;
  }

  // 2. 托管 preload.js 支持宿主广播与主题无缝同步
  if (req.method === "GET" && pathname === "/preload.js") {
    if (fs.existsSync(PRELOAD_SDK_PATH)) {
      res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8" });
      res.end(fs.readFileSync(PRELOAD_SDK_PATH, "utf-8"));
    } else {
      res.writeHead(200, { "Content-Type": "application/javascript" });
      res.end("// preload shim");
    }
    return;
  }

  // 3. 状态接口（支持通过 conversationId、projectId、workspaceUri、token、passive 毫秒级直达当前 project_id）
  if (req.method === "GET" && pathname === "/api/status") {
    const convId = url.searchParams.get("conversationId") || "";
    const clientProjectId = url.searchParams.get("projectId") || "";
    const clientWorkspaceUri = url.searchParams.get("workspaceUri") || "";
    const token = url.searchParams.get("token") || "";
    const isPassive = url.searchParams.get("passive") === "1";
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(getSystemState({ convId, clientProjectId, clientWorkspaceUri, token, isPassive })));
    return;
  }

  // 4. 补齐官方 SDK preload 内部反查接口契约
  if (req.method === "POST" && pathname === "/_sidecar/get-conversation-metadata") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      try {
        const { conversationId } = JSON.parse(body || "{}");
        const projectId = resolveProjectIdFromDb(conversationId);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          response: {
            conversationMetadata: {
              conversationId,
              metadata: {
                projectId
              }
            }
          }
        }));
      } catch (err) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ response: {} }));
      }
    });
    return;
  }

  if (req.method === "POST" && pathname === "/api/toggle-plugin") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      try {
        const { dir, enabled } = JSON.parse(body);
        if (!dir || PROTECTED_PLUGINS.has(dir)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ success: false, error: "受保护插件不可关闭" }));
        }

        const config = readJsonSafe(CONFIG_FILE, { plugins: {} });
        if (!config.plugins) config.plugins = {};
        if (!config.plugins[dir]) config.plugins[dir] = {};
        config.plugins[dir].enabled = Boolean(enabled);
        writeJsonSafe(CONFIG_FILE, config);

        notifyLanguageServer({ [dir]: { enabled: Boolean(enabled) } });

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, dir, enabled: Boolean(enabled) }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  if (req.method === "POST" && pathname === "/api/set-plugin-state") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      try {
        const { projectId, pluginDir, enabled, hostActiveId, conversationId } = JSON.parse(body);
        if (!projectId || !pluginDir) {
          res.writeHead(400, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ success: false, error: "缺少 projectId 或 pluginDir" }));
        }

        if (PROTECTED_PLUGINS.has(pluginDir)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ success: false, error: "受保护插件不可关闭" }));
        }

        const profiles = readJsonSafe(PROFILES_FILE, {});
        const projects = scanAntigravityProjects();

        // 1. 即动即存：落盘持久化至 Profiles（物理独立，杜绝路径别名共享）
        if (projectId === DEFAULT_KEY) {
          if (!profiles[DEFAULT_KEY]) {
            profiles[DEFAULT_KEY] = { id: DEFAULT_KEY, name: "默认配置", paths: [], plugins: {} };
          }
          if (!profiles[DEFAULT_KEY].plugins) profiles[DEFAULT_KEY].plugins = {};
          profiles[DEFAULT_KEY].plugins[pluginDir] = Boolean(enabled);
        } else {
          let targetProfile = profiles[projectId];
          if (!targetProfile) {
            const proj = projects.find(p => p.id === projectId);
            const defaultPlugins = (profiles[DEFAULT_KEY] && profiles[DEFAULT_KEY].plugins) || {};
            targetProfile = {
              id: projectId,
              name: proj ? proj.name : projectId,
              paths: proj ? proj.paths : [],
              plugins: JSON.parse(JSON.stringify(defaultPlugins))
            };
            profiles[projectId] = targetProfile;
          }
          if (!targetProfile.plugins) targetProfile.plugins = {};
          targetProfile.plugins[pluginDir] = Boolean(enabled);
        }

        writeJsonSafe(PROFILES_FILE, profiles);

        // 2. 双态路由判据：检查修改的项目是否正是 Antigravity 当前宿主活跃项目
        let currentHostActiveId = hostActiveId || "";
        if (!currentHostActiveId) {
          const resolved = resolveCurrentActiveProjectId(conversationId, projects);
          currentHostActiveId = resolved.activeProjectId;
        }

        let runtimeSynced = false;
        if (currentHostActiveId && projectId === currentHostActiveId) {
          runtimeSynced = true;
          const config = readJsonSafe(CONFIG_FILE, { plugins: {} });
          if (!config.plugins) config.plugins = {};
          if (!config.plugins[pluginDir]) config.plugins[pluginDir] = {};
          config.plugins[pluginDir].enabled = Boolean(enabled);
          writeJsonSafe(CONFIG_FILE, config);

          notifyLanguageServer({ [pluginDir]: { enabled: Boolean(enabled) } });
        }

        if (!profiles.__meta__) profiles.__meta__ = {};
        profiles.__meta__.lastPanelActionAt = Date.now();
        if (currentHostActiveId && projectId === currentHostActiveId) {
          profiles.__meta__.lastActiveProjectId = currentHostActiveId;
        }
        writeJsonSafe(PROFILES_FILE, profiles);

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          success: true,
          projectId,
          pluginDir,
          enabled: Boolean(enabled),
          runtimeSynced,
          profiles
        }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // 恢复默认接口：深拷贝默认配置至该项目，永不改变默认配置本身
  if (req.method === "POST" && (pathname === "/api/reset-profile" || pathname === "/api/delete-profile")) {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      try {
        const { projectId, hostActiveId, conversationId } = JSON.parse(body);
        if (!projectId || projectId === DEFAULT_KEY) {
          res.writeHead(400, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ success: false, error: "默认配置不可重置" }));
        }

        const profiles = readJsonSafe(PROFILES_FILE, {});
        const defaultPlugins = (profiles[DEFAULT_KEY] && profiles[DEFAULT_KEY].plugins) || {};

        if (!profiles[projectId]) {
          const projects = scanAntigravityProjects();
          const proj = projects.find(p => p.id === projectId);
          profiles[projectId] = {
            id: projectId,
            name: proj ? proj.name : projectId,
            paths: proj ? proj.paths : [],
            plugins: {}
          };
        }

        // 深拷贝照抄默认配置，绝对保持独立对象
        profiles[projectId].plugins = JSON.parse(JSON.stringify(defaultPlugins));

        // 如果重置的是当前活跃项目，则同步热生效到运行态！
        let currentHostActiveId = hostActiveId || "";
        if (!currentHostActiveId) {
          const resolved = resolveCurrentActiveProjectId(conversationId, []);
          currentHostActiveId = resolved.activeProjectId;
        }

        if (currentHostActiveId === projectId) {
          const config = readJsonSafe(CONFIG_FILE, { plugins: {} });
          if (!config.plugins) config.plugins = {};
          const rpcUpdates = {};
          for (const [pluginDir, shouldEnable] of Object.entries(defaultPlugins)) {
            if (PROTECTED_PLUGINS.has(pluginDir)) continue;
            if (!config.plugins[pluginDir]) config.plugins[pluginDir] = {};
            config.plugins[pluginDir].enabled = Boolean(shouldEnable);
            rpcUpdates[pluginDir] = { enabled: Boolean(shouldEnable) };
          }
          writeJsonSafe(CONFIG_FILE, config);
          notifyLanguageServer(rpcUpdates);
        }

        if (!profiles.__meta__) profiles.__meta__ = {};
        profiles.__meta__.lastPanelActionAt = Date.now();
        if (currentHostActiveId && projectId === currentHostActiveId) {
          profiles.__meta__.lastActiveProjectId = currentHostActiveId;
        }
        writeJsonSafe(PROFILES_FILE, profiles);

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, profiles, resetPlugins: profiles[projectId].plugins }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // 批量修改插件状态接口
  if (req.method === "POST" && pathname === "/api/batch-set-plugin-state") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      try {
        const { projectIds, pluginDir, enabled, hostActiveId, conversationId } = JSON.parse(body || "{}");
        if (!Array.isArray(projectIds) || !pluginDir) {
          res.writeHead(400, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ success: false, error: "缺少 projectIds 或 pluginDir" }));
        }

        if (PROTECTED_PLUGINS.has(pluginDir)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ success: false, error: "受保护插件不可关闭" }));
        }

        const validProjectIds = projectIds.filter(id => id && id !== DEFAULT_KEY && id !== "__batch__");
        if (validProjectIds.length === 0) {
          res.writeHead(400, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ success: false, error: "请至少指定一个有效的项目 ID" }));
        }

        const profiles = readJsonSafe(PROFILES_FILE, {});
        const projects = scanAntigravityProjects();
        const defaultPlugins = (profiles[DEFAULT_KEY] && profiles[DEFAULT_KEY].plugins) || {};

        for (const pid of validProjectIds) {
          let target = profiles[pid];
          if (!target) {
            const proj = projects.find(p => p.id === pid);
            target = {
              id: pid,
              name: proj ? proj.name : pid,
              paths: proj ? proj.paths : [],
              plugins: JSON.parse(JSON.stringify(defaultPlugins))
            };
            profiles[pid] = target;
          }
          if (!target.plugins) target.plugins = {};
          target.plugins[pluginDir] = Boolean(enabled);
        }

        if (!profiles.__meta__) profiles.__meta__ = {};
        profiles.__meta__.lastPanelActionAt = Date.now();

        let currentHostActiveId = hostActiveId || "";
        if (!currentHostActiveId) {
          const resolved = resolveCurrentActiveProjectId(conversationId, projects);
          currentHostActiveId = resolved.activeProjectId;
        }

        let runtimeSynced = false;
        if (currentHostActiveId && validProjectIds.includes(currentHostActiveId)) {
          runtimeSynced = true;
          profiles.__meta__.lastActiveProjectId = currentHostActiveId;
          const config = readJsonSafe(CONFIG_FILE, { plugins: {} });
          if (!config.plugins) config.plugins = {};
          if (!config.plugins[pluginDir]) config.plugins[pluginDir] = {};
          config.plugins[pluginDir].enabled = Boolean(enabled);
          writeJsonSafe(CONFIG_FILE, config);

          notifyLanguageServer({ [pluginDir]: { enabled: Boolean(enabled) } });
        }

        writeJsonSafe(PROFILES_FILE, profiles);

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          success: true,
          updatedCount: validProjectIds.length,
          runtimeSynced,
          profiles
        }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // 批量恢复默认接口
  if (req.method === "POST" && pathname === "/api/batch-reset-profiles") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      try {
        const { projectIds, hostActiveId, conversationId } = JSON.parse(body || "{}");
        if (!Array.isArray(projectIds)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ success: false, error: "缺少 projectIds" }));
        }

        const validProjectIds = projectIds.filter(id => id && id !== DEFAULT_KEY && id !== "__batch__");
        if (validProjectIds.length === 0) {
          res.writeHead(400, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ success: false, error: "请至少指定一个有效的项目 ID" }));
        }

        const profiles = readJsonSafe(PROFILES_FILE, {});
        const projects = scanAntigravityProjects();
        const defaultPlugins = (profiles[DEFAULT_KEY] && profiles[DEFAULT_KEY].plugins) || {};

        for (const pid of validProjectIds) {
          let target = profiles[pid];
          if (!target) {
            const proj = projects.find(p => p.id === pid);
            target = {
              id: pid,
              name: proj ? proj.name : pid,
              paths: proj ? proj.paths : [],
              plugins: {}
            };
            profiles[pid] = target;
          }
          target.plugins = JSON.parse(JSON.stringify(defaultPlugins));
        }

        if (!profiles.__meta__) profiles.__meta__ = {};
        profiles.__meta__.lastPanelActionAt = Date.now();

        let currentHostActiveId = hostActiveId || "";
        if (!currentHostActiveId) {
          const resolved = resolveCurrentActiveProjectId(conversationId, projects);
          currentHostActiveId = resolved.activeProjectId;
        }

        let runtimeSynced = false;
        if (currentHostActiveId && validProjectIds.includes(currentHostActiveId)) {
          runtimeSynced = true;
          profiles.__meta__.lastActiveProjectId = currentHostActiveId;
          const config = readJsonSafe(CONFIG_FILE, { plugins: {} });
          if (!config.plugins) config.plugins = {};
          const rpcUpdates = {};
          for (const [pluginDir, shouldEnable] of Object.entries(defaultPlugins)) {
            if (PROTECTED_PLUGINS.has(pluginDir)) continue;
            if (!config.plugins[pluginDir]) config.plugins[pluginDir] = {};
            config.plugins[pluginDir].enabled = Boolean(shouldEnable);
            rpcUpdates[pluginDir] = { enabled: Boolean(shouldEnable) };
          }
          writeJsonSafe(CONFIG_FILE, config);
          notifyLanguageServer(rpcUpdates);
        }

        writeJsonSafe(PROFILES_FILE, profiles);

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          success: true,
          updatedCount: validProjectIds.length,
          runtimeSynced,
          profiles,
          resetPlugins: defaultPlugins
        }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  if (req.method === "POST" && pathname === "/api/apply-profile") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      try {
        const { projectId } = JSON.parse(body);
        const key = projectId || DEFAULT_KEY;
        const profiles = readJsonSafe(PROFILES_FILE, {});
        const targetProfile = profiles[key] || profiles[DEFAULT_KEY];

        if (!targetProfile || !targetProfile.plugins) {
          res.writeHead(404, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ success: false, error: "未找到该项目预设" }));
        }

        const config = readJsonSafe(CONFIG_FILE, { plugins: {} });
        if (!config.plugins) config.plugins = {};
        const rpcUpdates = {};

        for (const [pluginDir, shouldEnable] of Object.entries(targetProfile.plugins)) {
          if (PROTECTED_PLUGINS.has(pluginDir)) continue;
          if (!config.plugins[pluginDir]) config.plugins[pluginDir] = {};
          config.plugins[pluginDir].enabled = Boolean(shouldEnable);
          rpcUpdates[pluginDir] = { enabled: Boolean(shouldEnable) };
        }

        writeJsonSafe(CONFIG_FILE, config);
        notifyLanguageServer(rpcUpdates);

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, projectId: key, applied: rpcUpdates }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end("Not Found");
}

const server = http.createServer(requestHandler);

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[PluginSwitcher Sidecar] Listening on http://0.0.0.0:${PORT} (Antigravity Port: ${process.env.ANTIGRAVITY_SIDECAR_WEB_PORT || "custom"})`);
});

if (PORT !== 8088) {
  try {
    const standaloneServer = http.createServer(requestHandler);
    standaloneServer.on("error", (err) => {
      console.log(`[PluginSwitcher Sidecar] Standalone port 8088 listener notice: ${err.message}`);
    });
    standaloneServer.listen(8088, "127.0.0.1", () => {
      console.log(`[PluginSwitcher Sidecar] Dual listening enabled on http://127.0.0.1:8088`);
    });
  } catch (e) {
    console.log(`[PluginSwitcher Sidecar] Standalone port 8088 listen error: ${e.message}`);
  }
}

// 后台监听 config.json 物理变更：支持无前端面板（如 GCP 登录或未打开右侧面板）下，在软件原生 Settings 中改开关立即同步保存到当前活跃项目档案
try {
  fs.watchFile(CONFIG_FILE, { interval: 1000 }, (curr, prev) => {
    if (curr.mtimeMs === prev.mtimeMs) return;
    // 忽略 Sidecar 自身刚写入 config.json 触发的回调
    if (Date.now() - lastInternalConfigWriteMs < 800) return;
    try {
      const profiles = readJsonSafe(PROFILES_FILE, {});
      const lastActiveId = profiles?.__meta__?.lastActiveProjectId || "";
      if (!lastActiveId || !profiles[lastActiveId] || !profiles[lastActiveId].plugins) return;

      const config = readJsonSafe(CONFIG_FILE, { plugins: {} });
      const activeProfile = profiles[lastActiveId];
      let changed = false;

      for (const [pluginDir, pluginCfg] of Object.entries(config.plugins || {})) {
        if (PROTECTED_PLUGINS.has(pluginDir)) continue;
        const enabledInConfig = Boolean(pluginCfg && pluginCfg.enabled !== false);
        if (activeProfile.plugins[pluginDir] !== enabledInConfig) {
          activeProfile.plugins[pluginDir] = enabledInConfig;
          changed = true;
        }
      }

      if (changed) {
        writeJsonSafe(PROFILES_FILE, profiles);
        console.log(`[PluginSwitcher Sidecar] Headless sync: native Settings changes saved to project ${lastActiveId}`);
      }
    } catch (e) {}
  });
} catch (e) {}


