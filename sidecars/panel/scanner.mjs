import fs from "node:fs";
import path from "node:path";
import {
  PLUGINS_DIR,
  CONFIG_FILE,
  PROFILES_FILE,
  PROJECTS_DIR,
  APP_STORAGE_FILE,
  PROTECTED_PLUGINS,
  DEFAULT_KEY,
  resolveSwitcherInstanceContext,
  resolveLsRpcTarget,
  isValidPluginDirectory,
  resolveProjectIdFromDb,
  getFocusedWindowRoute,
  readJsonSafe,
  getPluginManifest,
  resolvePluginLogoUrl,
  recordConfigWriteMeta,
  writeJsonSafe,
  notifyLanguageServer,
  getLastInternalConfigWriteMs,
  isInternalConfigWriteSettled
} from "./ls-bridge.mjs";

function scanAntigravityProjects(instanceCtx = null) {
  const projectList = [];
  if (!fs.existsSync(PROJECTS_DIR)) return projectList;

  const ctx = instanceCtx || resolveSwitcherInstanceContext(0);
  // 1. 读取侧边栏拖拽顺序（优先读取当前实例，若为空则回退主实例）
  let appStorage = readJsonSafe(ctx.appStorageFile || APP_STORAGE_FILE, {});
  if (!appStorage.projectsOrder && ctx.appStorageFile !== APP_STORAGE_FILE) {
    appStorage = readJsonSafe(APP_STORAGE_FILE, {});
  }

  let orderArray = [];
  try {
    orderArray = JSON.parse(appStorage.projectsOrder || "[]");
  } catch (e) {}

  // 2. 读取 projects 目录下全部项目配置（自动过滤并清理伴生 Sidecar 空壳伪项目）
  const rawConfigForSidecars = readJsonSafe(CONFIG_FILE, {}) || {};
  const sidecarProjIds = new Set();
  if (rawConfigForSidecars && rawConfigForSidecars.sidecars && typeof rawConfigForSidecars.sidecars === "object") {
    for (const sc of Object.values(rawConfigForSidecars.sidecars)) {
      if (sc && sc.projectId) sidecarProjIds.add(sc.projectId);
    }
  }

  try {
    const files = fs.readdirSync(PROJECTS_DIR);
    for (const f of files) {
      if (!f.endsWith(".json") || f === "outside-of-project.json") continue;
      const fullPath = path.join(PROJECTS_DIR, f);
      const data = readJsonSafe(fullPath, null);
      if (!data || !data.id) continue;

      if (data.archived === true || data.isArchived === true) continue;

      const id = data.id;
      const name = data.name || id;
      const isGhost = sidecarProjIds.has(id) || (typeof name === "string" && (name.startsWith("plugin-") || name.includes("/sidecars/") || name.includes("/panel") || name.includes("/")));
      if (isGhost) {
        try { fs.unlinkSync(fullPath); } catch (e) {}
        continue;
      }
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

  const orderMap = new Map();
  orderArray.forEach((id, index) => {
    orderMap.set(id, index);
  });
  const lastCreatedId = appStorage.lastCreatedProjectId || "";

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

const SIDECAR_BOOT_ID = String(Date.now());
const instancePollTracker = new Map();
const lastIdeContextByInstance = new Map();

function resolveCurrentActiveProjectId(params = {}, projects = [], profilesMeta = null, instanceCtx = null) {
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

  const ctx = instanceCtx || resolveSwitcherInstanceContext(params?.localPort || 0);
  const instKey = ctx.instanceId || "main";
  const meta = profilesMeta || (readJsonSafe(PROFILES_FILE, {}).__meta__) || {};
  const instMeta = meta?.instances?.[instKey] || {};
  const lastIdeContext = lastIdeContextByInstance.get(instKey) || {
    activeProjectId: "",
    effectiveConvId: "",
    workspaceUri: "",
    updatedAt: 0
  };

  // 第一权威源：当前实例 Antigravity Electron 窗口实时路由 (/c/<convId>?section=<projectId> 或 /c/<convId>)
  const windowRoute = getFocusedWindowRoute(ctx);
  const isRouteFresh = Boolean(windowRoute && (Date.now() - windowRoute.updatedAt < 10000));
  const isWindowOnWelcome = Boolean(isRouteFresh && windowRoute.rawUrl && !windowRoute.convId && !windowRoute.projectId);
  if (isRouteFresh && (windowRoute.projectId || windowRoute.convId)) {
    const resolvedRouteProjId =
      windowRoute.projectId ||
      (windowRoute.convId && meta.convProjectMap && meta.convProjectMap[windowRoute.convId]) ||
      (windowRoute.convId ? resolveProjectIdFromDb(windowRoute.convId) : "");
    const matchedProj = resolvedRouteProjId ? projects.find((p) => p.id === resolvedRouteProjId) : null;
    if (matchedProj) {
      const effectiveConvId = windowRoute.convId || convId || "";
      const activeWorkspace = (matchedProj.primaryPath || clientWorkspaceUri || "").replace(/\\/g, "/");
      const isNewConvoContext = Boolean(!windowRoute.convId);
      lastIdeContextByInstance.set(instKey, {
        activeProjectId: matchedProj.id,
        effectiveConvId,
        workspaceUri: activeWorkspace,
        updatedAt: Date.now()
      });
      return {
        activeProjectId: matchedProj.id,
        effectiveConvId,
        activeWorkspace,
        isNewConvoContext,
        source: "electron-window-route"
      };
    }
  }

  // 优先级 2：显式传入的合法 clientProjectId
  if (clientProjectId && /^[0-9a-f-]{36}$/i.test(clientProjectId) && projects && projects.length) {
    const found = projects.find((p) => p.id === clientProjectId);
    if (found) {
      const activeWorkspace = (found.primaryPath || clientWorkspaceUri || "").replace(/\\/g, "/");
      return {
        activeProjectId: clientProjectId,
        effectiveConvId: isWindowOnWelcome ? "" : (convId || lastIdeContext.effectiveConvId),
        activeWorkspace,
        isNewConvoContext: isWindowOnWelcome || !convId,
        source: "explicit-project-id"
      };
    }
  }

  // 优先级 3：欢迎页准备态或 CDP 端口不可达时的按实例协同兜底
  const appStorage = readJsonSafe(ctx.appStorageFile || APP_STORAGE_FILE, {});
  let tokenNewConvoProjId = "";
  if (token) {
    const tokenRes = resolveConvIdFromToken(token, appStorage);
    if (!convId && tokenRes.convId && !isWindowOnWelcome) {
      convId = tokenRes.convId;
    }
    if (tokenRes.newConvoProjId) {
      tokenNewConvoProjId = tokenRes.newConvoProjId;
    }
  }
  if (isWindowOnWelcome) {
    convId = "";
  }

  let activeProjectId = "";
  if (convId) {
    const dbId = resolveProjectIdFromDb(convId) || (meta.convProjectMap && meta.convProjectMap[convId]) || "";
    if (dbId && projects.some((p) => p.id === dbId)) {
      activeProjectId = dbId;
    }
  }
  if (!activeProjectId && clientWorkspaceUri) {
    activeProjectId = findProjectIdByWorkspaceUris(clientWorkspaceUri, projects);
  }
  if (!activeProjectId && tokenNewConvoProjId && projects.some((p) => p.id === tokenNewConvoProjId)) {
    activeProjectId = tokenNewConvoProjId;
  }
  if (!activeProjectId) {
    if (lastIdeContext.activeProjectId && projects.some((p) => p.id === lastIdeContext.activeProjectId)) {
      activeProjectId = lastIdeContext.activeProjectId;
    } else if (instMeta.lastSidecarProjectId && projects.some((p) => p.id === instMeta.lastSidecarProjectId)) {
      activeProjectId = instMeta.lastSidecarProjectId;
    } else if (instMeta.lastActiveProjectId && projects.some((p) => p.id === instMeta.lastActiveProjectId)) {
      activeProjectId = instMeta.lastActiveProjectId;
    } else {
      const rawNewConvoProjId = typeof appStorage["new-convo-last-selected-project"] === "string"
        ? appStorage["new-convo-last-selected-project"].trim().replace(/^"|"$/g, "")
        : "";
      if (rawNewConvoProjId && projects.some((p) => p.id === rawNewConvoProjId)) {
        activeProjectId = rawNewConvoProjId;
      } else if (!ctx.isIsolatedInstance && meta.lastActiveProjectId && projects.some((p) => p.id === meta.lastActiveProjectId)) {
        activeProjectId = meta.lastActiveProjectId;
      }
    }
  }

  const matchedProj = projects.find((p) => p.id === activeProjectId);
  const effectiveConvId = isWindowOnWelcome ? "" : (convId || lastIdeContext.effectiveConvId || "");
  const activeWorkspace = ((matchedProj && matchedProj.primaryPath) || clientWorkspaceUri || lastIdeContext.workspaceUri || "").replace(/\\/g, "/");
  return {
    activeProjectId,
    effectiveConvId,
    activeWorkspace,
    isNewConvoContext: !effectiveConvId,
    source: "fallback"
  };
}

function getSystemState(query = {}) {
  let convId = "";
  let clientProjectId = "";
  let clientWorkspaceUri = "";
  let token = "";
  let sidecarProjectId = "";
  let cid = "";
  let isPassive = false;
  let hasActiveFlag = false;
  let isInit = false;
  let localPort = 0;

  if (typeof query === "string") {
    convId = query;
  } else if (query && typeof query === "object") {
    convId = query.convId || query.conversationId || "";
    clientProjectId = query.clientProjectId || query.projectId || "";
    clientWorkspaceUri = query.clientWorkspaceUri || query.workspaceUri || "";
    token = query.token || "";
    sidecarProjectId = query.sidecarProjectId || "";
    cid = query.cid || "";
    isPassive = query.isPassive === true;
    hasActiveFlag = query.hasActiveFlag === true;
    isInit = query.isInit === true;
    localPort = Number(query.localPort || 0);
  }
  const instanceCtx = query?.instanceCtx || resolveSwitcherInstanceContext(localPort);
  const instKey = instanceCtx.instanceId || "main";
  const config = readJsonSafe(CONFIG_FILE, { plugins: {} });
  const profilesFileExistedOnDisk = fs.existsSync(PROFILES_FILE) || fs.existsSync(`${PROFILES_FILE}.bak`);
  const rawProfiles = readJsonSafe(PROFILES_FILE, {});
  const hadValidDefaultOnRead = Boolean(
    rawProfiles &&
    rawProfiles[DEFAULT_KEY] &&
    rawProfiles[DEFAULT_KEY].plugins &&
    Object.keys(rawProfiles[DEFAULT_KEY].plugins).length > 0
  );
  // 若磁盘上原本已存在配置文件但本次读取未能拿到合法的 DEFAULT_KEY（极端并发异常），严禁将本次用 config.json 临时兜底的对象写回磁盘覆盖用户配置！
  const allowProfilesDiskWrite = !profilesFileExistedOnDisk || hadValidDefaultOnRead;

  // 1. 初始化纯净基准默认配置（仅在真正首次安装、磁盘尚无任何配置文件时才从当前已安装插件初始化）
  if (!hadValidDefaultOnRead || rawProfiles[DEFAULT_KEY].name !== "默认配置") {
    const initialDefaultPlugins = {};
    if (fs.existsSync(PLUGINS_DIR)) {
      for (const entry of fs.readdirSync(PLUGINS_DIR, { withFileTypes: true })) {
        if (entry.isDirectory() && isValidPluginDirectory(entry.name)) {
          initialDefaultPlugins[entry.name] = (config.plugins?.[entry.name]?.enabled !== false);
        }
      }
    }
    rawProfiles[DEFAULT_KEY] = {
      id: DEFAULT_KEY,
      name: "默认配置",
      paths: [],
      plugins: hadValidDefaultOnRead ? rawProfiles[DEFAULT_KEY].plugins : initialDefaultPlugins
    };
  }

  const projects = scanAntigravityProjects(instanceCtx);
  const validProjectIds = new Set(projects.map(p => p.id));

  // 2. 清洗 profiles：剔除所有基于磁盘物理路径的冗余顶层 Key 与伪插件 Sidecar 残留项，仅保留真实项目 UUID 和特殊 Key
  const profiles = {};
  let profilesModified = false;
  for (const [k, v] of Object.entries(rawProfiles)) {
    if (k === DEFAULT_KEY || k === "__meta__") {
      profiles[k] = v;
    } else if (/^[0-9a-f-]{36}$/i.test(k)) {
      const isBogusSidecarEntry = (!Array.isArray(v?.paths) || v.paths.length === 0) && typeof v?.name === "string" && v.name.includes("/") && !validProjectIds.has(k);
      if (!isBogusSidecarEntry) {
        profiles[k] = v;
      } else {
        profilesModified = true;
      }
    } else {
      // 检测到存量路径冗余 Key，标记需要覆写落盘净化
      profilesModified = true;
    }
  }
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

  // 自动清理 .git 隐藏目录残留键
  if (config.plugins && config.plugins[".git"]) {
    delete config.plugins[".git"];
    writeJsonSafe(CONFIG_FILE, config);
  }
  for (const prof of Object.values(profiles)) {
    if (prof && prof.plugins && prof.plugins[".git"] !== undefined) {
      delete prof.plugins[".git"];
      profilesModified = true;
    }
  }

  const installedPlugins = [];
  if (fs.existsSync(PLUGINS_DIR)) {
    const entries = fs.readdirSync(PLUGINS_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && isValidPluginDirectory(entry.name)) {
        const dir = entry.name;
        let manifest = {};
        const candidateManifests = [
          path.join(PLUGINS_DIR, dir, "plugin.json"),
          path.join(PLUGINS_DIR, dir, ".antigravity-plugin", "plugin.json"),
          path.join(PLUGINS_DIR, dir, ".gemini-plugin", "plugin.json"),
          path.join(PLUGINS_DIR, dir, ".claude-plugin", "plugin.json")
        ];
        for (const mPath of candidateManifests) {
          if (fs.existsSync(mPath)) {
            manifest = readJsonSafe(mPath, {});
            break;
          }
        }
        const configEntry = (config.plugins && config.plugins[dir]) || {};
        const isEnabled = configEntry.enabled !== false;

        installedPlugins.push({
          dir,
          name: manifest.name || dir,
          displayName: manifest.displayName || manifest.name || dir,
          description: manifest.description || "本地安装的 Antigravity 插件",
          enabled: isEnabled,
          protected: PROTECTED_PLUGINS.has(dir),
          logoUrl: resolvePluginLogoUrl(dir, manifest)
        });
      }
    }
  }

  // 4. 精准探测当前实例活跃项目（按实例各自的 DevToolsActivePort 路由独立识别）
  if (!profiles.__meta__) {
    profiles.__meta__ = {};
  }
  if (!profiles.__meta__.convProjectMap || typeof profiles.__meta__.convProjectMap !== "object") {
    profiles.__meta__.convProjectMap = {};
  }
  if (!profiles.__meta__.instances || typeof profiles.__meta__.instances !== "object") {
    profiles.__meta__.instances = {};
  }
  if (!profiles.__meta__.instances[instKey] || typeof profiles.__meta__.instances[instKey] !== "object") {
    profiles.__meta__.instances[instKey] = {};
  }
  const instMeta = profiles.__meta__.instances[instKey];

  const now = Date.now();
  const curTarget = resolveLsRpcTarget(profiles, instanceCtx);
  if (curTarget && curTarget.port && curTarget.csrf) {
    if (!instMeta.lsRpcTarget || instMeta.lsRpcTarget.port !== curTarget.port || instMeta.lsRpcTarget.csrf !== curTarget.csrf) {
      instMeta.lsRpcTarget = {
        hostname: curTarget.hostname,
        port: curTarget.port,
        csrf: curTarget.csrf,
        updatedAt: now
      };
      if (!instanceCtx.isIsolatedInstance) {
        profiles.__meta__.lsRpcTarget = instMeta.lsRpcTarget;
      }
      profilesModified = true;
    }
  }

  const { activeProjectId, effectiveConvId, activeWorkspace, isNewConvoContext, source } = resolveCurrentActiveProjectId(
    { convId, clientProjectId, clientWorkspaceUri, token, sidecarProjectId, localPort },
    projects,
    profiles.__meta__,
    instanceCtx
  );

  // 当该实例窗口实时路由在线时（source === "electron-window-route"），当前实例焦点即为唯一权威
  const windowRoute = getFocusedWindowRoute(instanceCtx);
  const isBackgroundTabPassive = Boolean(
    source !== "electron-window-route" &&
    windowRoute &&
    windowRoute.projectId &&
    windowRoute.convId &&
    convId &&
    convId !== windowRoute.convId
  );

  if (!isBackgroundTabPassive && activeProjectId && activeProjectId !== DEFAULT_KEY) {
    if (effectiveConvId && profiles.__meta__.convProjectMap[effectiveConvId] !== activeProjectId) {
      profiles.__meta__.convProjectMap[effectiveConvId] = activeProjectId;
      const mapKeys = Object.keys(profiles.__meta__.convProjectMap);
      if (mapKeys.length > 120) {
        for (let i = 0; i < mapKeys.length - 100; i++) {
          delete profiles.__meta__.convProjectMap[mapKeys[i]];
        }
      }
      profilesModified = true;
    }
    instMeta.lastSidecarPollAt = now;
    if (!instanceCtx.isIsolatedInstance) {
      profiles.__meta__.lastSidecarPollAt = now;
    }
    if (!isPassive) {
      instMeta.lastSidecarActiveAt = now;
      profiles.__meta__.lastSidecarActiveAt = now;
    }
    instMeta.lastSidecarIsNewConvo = Boolean(isNewConvoContext);
    if (
      instMeta.lastSidecarProjectId !== activeProjectId ||
      instMeta.lastSidecarConvId !== effectiveConvId ||
      instMeta.lastSidecarWorkspace !== activeWorkspace
    ) {
      instMeta.lastSidecarProjectId = activeProjectId;
      instMeta.lastSidecarConvId = effectiveConvId;
      instMeta.lastSidecarWorkspace = activeWorkspace;
      if (!instanceCtx.isIsolatedInstance) {
        profiles.__meta__.lastSidecarProjectId = activeProjectId;
        profiles.__meta__.lastSidecarConvId = effectiveConvId;
        profiles.__meta__.lastSidecarWorkspace = activeWorkspace;
      }
      profilesModified = true;
    }
    lastIdeContextByInstance.set(instKey, {
      activeProjectId,
      effectiveConvId,
      workspaceUri: activeWorkspace,
      updatedAt: now
    });
  }

  // 5. 核心状态机：分清「本实例跨项目切换 / 主动聚焦同步」与「同项目内同步」，杜绝双实例后台静默轮询互相抢写
  const lastInstanceActiveId = instMeta.lastActiveProjectId || "";
  const instanceNeedsApply = Boolean(
    activeProjectId &&
    activeProjectId !== DEFAULT_KEY &&
    (lastInstanceActiveId !== activeProjectId || instMeta.lastAppliedProjectId !== activeProjectId || (hasActiveFlag && profiles.__meta__.lastAppliedProjectId !== activeProjectId))
  );

  if (activeProjectId && activeProjectId !== DEFAULT_KEY && profiles[activeProjectId]) {
    const activeProfile = profiles[activeProjectId];

    if (instanceNeedsApply) {
      if (isBackgroundTabPassive) {
        for (const p of installedPlugins) {
          if (!p.protected && activeProfile.plugins[p.dir] !== undefined) {
            p.enabled = Boolean(activeProfile.plugins[p.dir]);
          }
        }
      } else {
        // 分支 A：当前实例发生项目跃变或首次绑定该项目（如多开实例处于「聊天」项目），正向将该项目的配置同步至当前实例 LS 与 config.json
        if (!config.plugins) config.plugins = {};
        const rpcUpdates = {};
        let configChanged = false;

        for (const [pluginDir, shouldEnable] of Object.entries(activeProfile.plugins || {})) {
          if (PROTECTED_PLUGINS.has(pluginDir)) continue;
          if (!config.plugins[pluginDir]) config.plugins[pluginDir] = {};
          const cur = config.plugins[pluginDir].enabled !== false;
          const target = Boolean(shouldEnable);
          rpcUpdates[pluginDir] = { enabled: target };
          if (cur !== target) {
            config.plugins[pluginDir].enabled = target;
            configChanged = true;
          }
        }

        instMeta.lastActiveProjectId = activeProjectId;
        instMeta.lastProjectSwitchAt = Date.now();
        profiles.__meta__.lastActiveProjectId = activeProjectId;
        profiles.__meta__.lastProjectSwitchAt = Date.now();
        recordConfigWriteMeta(profiles, config, activeProjectId, true, instanceCtx);
        profilesModified = true;
        if (allowProfilesDiskWrite) {
          writeJsonSafe(PROFILES_FILE, profiles);
          profilesModified = false;
        }

        if (configChanged) {
          writeJsonSafe(CONFIG_FILE, config);
        }
        if (Object.keys(rpcUpdates).length > 0) {
          notifyLanguageServer(rpcUpdates, profiles, instanceCtx);
        }

        for (const p of installedPlugins) {
          if (!p.protected && activeProfile.plugins[p.dir] !== undefined) {
            p.enabled = Boolean(activeProfile.plugins[p.dir]);
          }
        }
      }
    } else {
      // 分支 B：当前实例停留在同一项目内
      const nowMs = Date.now();
      const lastBgHookAt = Number(profiles.__meta__.lastBgHookAt || 0);
      const lastProfileWriteAt = Number(profiles.__meta__.lastInternalConfigWriteAt || 0);
      const lastSwitchAt = Number(profiles.__meta__.lastProjectSwitchAt || 0);
      const snapshotOwnerMatches = Boolean(
        profiles.__meta__.lastAppliedProjectId === activeProjectId &&
        instMeta.lastAppliedProjectId === activeProjectId
      );
      const canSyncNativeToggle =
        snapshotOwnerMatches &&
        isInternalConfigWriteSettled(600) &&
        (nowMs - lastProfileWriteAt > 800) &&
        (nowMs - lastSwitchAt > 1500) &&
        (nowMs - lastBgHookAt > 1500);
      const canRepairBgResidual =
        snapshotOwnerMatches &&
        isInternalConfigWriteSettled(600) &&
        (nowMs - lastProfileWriteAt > 800) &&
        (nowMs - lastBgHookAt > 1500);

      if (canSyncNativeToggle) {
        const snap = profiles.__meta__.lastAppliedConfigSnapshot || null;
        let profileChanged = false;
        let configRepairNeeded = false;
        const repairRpcUpdates = {};

        for (const p of installedPlugins) {
          if (p.protected) continue;
          const profileVal = activeProfile.plugins[p.dir] !== undefined ? Boolean(activeProfile.plugins[p.dir]) : p.enabled;
          if (profileVal !== p.enabled) {
            const divergedFromSnapshot = !snap || snap[p.dir] === undefined || Boolean(snap[p.dir]) !== p.enabled;
            if (divergedFromSnapshot) {
              activeProfile.plugins[p.dir] = p.enabled;
              profileChanged = true;
            } else if (canRepairBgResidual) {
              p.enabled = profileVal;
              if (!config.plugins) config.plugins = {};
              if (!config.plugins[p.dir]) config.plugins[p.dir] = {};
              config.plugins[p.dir].enabled = profileVal;
              repairRpcUpdates[p.dir] = { enabled: profileVal };
              configRepairNeeded = true;
            } else {
              p.enabled = profileVal;
            }
          }
        }

        if (configRepairNeeded) {
          writeJsonSafe(CONFIG_FILE, config);
          notifyLanguageServer(repairRpcUpdates, profiles, instanceCtx);
          recordConfigWriteMeta(profiles, config, activeProjectId, true, instanceCtx);
          profilesModified = true;
        } else if (profileChanged) {
          recordConfigWriteMeta(profiles, config, activeProjectId, false, instanceCtx);
          profilesModified = true;
        }
      } else {
        // 当共享 config.json 刚被另一实例的项目写入时，当前实例面板展示与 LS 内存态依然保持当前实例 activeProfile 的真实状态
        for (const p of installedPlugins) {
          if (!p.protected && activeProfile.plugins[p.dir] !== undefined) {
            p.enabled = Boolean(activeProfile.plugins[p.dir]);
          }
        }
      }
    }
  }

  if (profilesModified && allowProfilesDiskWrite) {
    writeJsonSafe(PROFILES_FILE, profiles);
  }

  const userSettings = config.userSettings || {};

  return {
    bootId: SIDECAR_BOOT_ID,
    instanceId: instKey,
    standalonePort: instanceCtx.standalonePort || 8088,
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

export {
  scanAntigravityProjects,
  normalizePath,
  findProjectIdByWorkspaceUris,
  resolveConvIdFromToken,
  resolveCurrentActiveProjectId,
  getSystemState
};
