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

function scanAntigravityProjects() {
  const projectList = [];
  if (!fs.existsSync(PROJECTS_DIR)) return projectList;

  // 1. 读取侧边栏拖拽顺序
  const appStorage = readJsonSafe(APP_STORAGE_FILE, {});

  let orderArray = [];
  try {
    orderArray = JSON.parse(appStorage.projectsOrder || "[]");
  } catch (e) {}

  // 2. 读取 projects 目录下全部项目配置
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

let lastIdeContext = {
  activeProjectId: "",
  effectiveConvId: "",
  workspaceUri: "",
  updatedAt: 0
};

function resolveCurrentActiveProjectId(params = {}, projects = [], profilesMeta = null) {
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

  const meta = profilesMeta || (readJsonSafe(PROFILES_FILE, {}).__meta__) || {};

  // 第一权威源：Antigravity Electron 主窗口实时路由 (/c/<convId>?section=<projectId> 或 /c/<convId>)
  // 无论内置 Sidecar 是否打开、是否存在多个并发后台 iframe 轮询，主窗口 page 路由永远 100% 反映用户当前真实焦点！
  const windowRoute = getFocusedWindowRoute();
  if (windowRoute && (windowRoute.projectId || windowRoute.convId) && (Date.now() - windowRoute.updatedAt < 10000)) {
    const resolvedRouteProjId =
      windowRoute.projectId ||
      (windowRoute.convId && meta.convProjectMap && meta.convProjectMap[windowRoute.convId]) ||
      (windowRoute.convId ? resolveProjectIdFromDb(windowRoute.convId) : "");
    const matchedProj = resolvedRouteProjId ? projects.find((p) => p.id === resolvedRouteProjId) : null;
    if (matchedProj) {
      const effectiveConvId = windowRoute.convId || convId || "";
      const activeWorkspace = (matchedProj.primaryPath || clientWorkspaceUri || "").replace(/\\/g, "/");
      const isNewConvoContext = Boolean(!windowRoute.convId);
      lastIdeContext = {
        activeProjectId: matchedProj.id,
        effectiveConvId,
        workspaceUri: activeWorkspace,
        updatedAt: Date.now()
      };
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
        effectiveConvId: convId || lastIdeContext.effectiveConvId,
        activeWorkspace,
        isNewConvoContext: !convId,
        source: "explicit-project-id"
      };
    }
  }

  // 优先级 3：CDP 端口不可达时的轻量兜底（SQLite 精确查表 -> workspaceUri 路径匹配 -> 最近活跃项目）
  const appStorage = readJsonSafe(APP_STORAGE_FILE, {});
  if (!convId && token) {
    const tokenRes = resolveConvIdFromToken(token, appStorage);
    if (tokenRes.convId) convId = tokenRes.convId;
  }

  let activeProjectId = "";
  if (convId) {
    const dbId = resolveProjectIdFromDb(convId);
    if (dbId && projects.some((p) => p.id === dbId)) {
      activeProjectId = dbId;
    }
  }
  if (!activeProjectId && clientWorkspaceUri) {
    activeProjectId = findProjectIdByWorkspaceUris(clientWorkspaceUri, projects);
  }
  if (!activeProjectId) {
    const rawNewConvoProjId = typeof appStorage["new-convo-last-selected-project"] === "string"
      ? appStorage["new-convo-last-selected-project"].trim().replace(/^"|"$/g, "")
      : "";
    if (rawNewConvoProjId && projects.some((p) => p.id === rawNewConvoProjId)) {
      activeProjectId = rawNewConvoProjId;
    } else if (lastIdeContext.activeProjectId && projects.some((p) => p.id === lastIdeContext.activeProjectId)) {
      activeProjectId = lastIdeContext.activeProjectId;
    } else if (meta.lastActiveProjectId && projects.some((p) => p.id === meta.lastActiveProjectId)) {
      activeProjectId = meta.lastActiveProjectId;
    }
  }

  const matchedProj = projects.find((p) => p.id === activeProjectId);
  const effectiveConvId = convId || lastIdeContext.effectiveConvId || "";
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
  }
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

  const projects = scanAntigravityProjects();
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

  // 4. 精准探测当前活跃项目（以 Electron 主窗口实时路由 /c/<convId>?section=<projectId> + node:sqlite 为唯一权威源）
  if (!profiles.__meta__) {
    profiles.__meta__ = {};
  }
  if (!profiles.__meta__.convProjectMap || typeof profiles.__meta__.convProjectMap !== "object") {
    profiles.__meta__.convProjectMap = {};
  }

  const now = Date.now();
  const { activeProjectId, effectiveConvId, activeWorkspace, isNewConvoContext, source } = resolveCurrentActiveProjectId(
    { convId, clientProjectId, clientWorkspaceUri, token, sidecarProjectId },
    projects,
    profiles.__meta__
  );

  // 当主窗口实时路由在线时（source === "electron-window-route"），主窗口当前焦点即为唯一权威，后台非焦点 iframe 绝不劫持
  const windowRoute = getFocusedWindowRoute();
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
    profiles.__meta__.lastSidecarPollAt = now;
    if (!isPassive) {
      profiles.__meta__.lastSidecarActiveAt = now;
    }
    profiles.__meta__.lastSidecarIsNewConvo = Boolean(isNewConvoContext);
    if (
      profiles.__meta__.lastSidecarProjectId !== activeProjectId ||
      profiles.__meta__.lastSidecarConvId !== effectiveConvId ||
      profiles.__meta__.lastSidecarWorkspace !== activeWorkspace
    ) {
      profiles.__meta__.lastSidecarProjectId = activeProjectId;
      profiles.__meta__.lastSidecarConvId = effectiveConvId;
      profiles.__meta__.lastSidecarWorkspace = activeWorkspace;
      profilesModified = true;
    }
    lastIdeContext = {
      activeProjectId,
      effectiveConvId,
      workspaceUri: activeWorkspace,
      updatedAt: now
    };
  }

  // 5. 核心状态机：分清「跨项目切换（配置 -> 软件）」与「同项目内同步（软件 -> 配置）」
  const lastActiveId = profiles.__meta__.lastActiveProjectId || "";

  if (activeProjectId && activeProjectId !== DEFAULT_KEY && profiles[activeProjectId]) {
    const activeProfile = profiles[activeProjectId];

    if (lastActiveId !== activeProjectId) {
      if (isBackgroundTabPassive) {
        // 后台隐藏标签页轮询：跳过写盘，仅对齐返回的内存态，绝不覆写 config.json 干扰前台项目或后台运行任务
        for (const p of installedPlugins) {
          if (!p.protected && activeProfile.plugins[p.dir] !== undefined) {
            p.enabled = Boolean(activeProfile.plugins[p.dir]);
          }
        }
      } else {
        // 分支 A：跨项目切换跃变！正向将该项目的独立配置写入 config.json，并强制同步 LS 内存态
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

        // 先更新并落盘 profiles 元数据（含 lastProjectSwitchAt、lastInternalConfigWriteAt、lastAppliedProjectId），防止 config.json 触发 fs.watch 时读到旧快照
        profiles.__meta__.lastActiveProjectId = activeProjectId;
        profiles.__meta__.lastProjectSwitchAt = Date.now();
        recordConfigWriteMeta(profiles, config, activeProjectId);
        profilesModified = true;
        if (allowProfilesDiskWrite) {
          writeJsonSafe(PROFILES_FILE, profiles);
          profilesModified = false;
        }

        if (configChanged) {
          writeJsonSafe(CONFIG_FILE, config);
        }
        if (Object.keys(rpcUpdates).length > 0) {
          notifyLanguageServer(rpcUpdates);
        }

        // 无论 config.json 是否有差异，均强制同步更新 installedPlugins 内存显示与快照
        for (const p of installedPlugins) {
          if (!p.protected && activeProfile.plugins[p.dir] !== undefined) {
            p.enabled = Boolean(activeProfile.plugins[p.dir]);
          }
        }
      }
    } else {
      // 分支 B：停留在同一项目内！通过比对 lastAppliedConfigSnapshot 区分「用户在软件原生设置中手动改开关」与「跨项目残留状态」
      const nowMs = Date.now();
      const lastBgHookAt = Number(profiles.__meta__.lastBgHookAt || 0);
      const lastProfileWriteAt = Number(profiles.__meta__.lastInternalConfigWriteAt || 0);
      const lastSwitchAt = Number(profiles.__meta__.lastProjectSwitchAt || 0);
      const snapshotOwnerMatches = !profiles.__meta__.lastAppliedProjectId || profiles.__meta__.lastAppliedProjectId === activeProjectId;
      // 1) 原生 Settings 手动拨动（divergedFromSnapshot === true）：需内部写盘静默 600ms 且距上次跨项目切换 > 1500ms 且距后台 Hook > 1500ms
      const canSyncNativeToggle =
        snapshotOwnerMatches &&
        isInternalConfigWriteSettled(600) &&
        (nowMs - lastProfileWriteAt > 800) &&
        (nowMs - lastSwitchAt > 1500) &&
        (nowMs - lastBgHookAt > 1500);
      // 2) 后台其他项目 Hook 瞬态下发残留或 LS 滞后残留：主动自愈回写前台项目配置
      const canRepairBgResidual =
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
            // 仅当存在基准快照且当前 config.json 与基准快照不一致时，才证明用户在 Antigravity 原生 Settings 中手动拨动了该开关
            const divergedFromSnapshot = !snap || snap[p.dir] === undefined || Boolean(snap[p.dir]) !== p.enabled;
            if (divergedFromSnapshot) {
              activeProfile.plugins[p.dir] = p.enabled;
              profileChanged = true;
            } else if (canRepairBgResidual) {
              // config.json 与上次本插件下发的快照相同（说明是后台其他项目的 Hook 下发残留），绝不反向污染当前项目 Profile，并主动自愈修复！
              p.enabled = profileVal;
              if (!config.plugins) config.plugins = {};
              if (!config.plugins[p.dir]) config.plugins[p.dir] = {};
              config.plugins[p.dir].enabled = profileVal;
              repairRpcUpdates[p.dir] = { enabled: profileVal };
              configRepairNeeded = true;
            } else {
              // 后台 Hook 保护期内，面板内存展示始终锁定为当前前台项目的真实 Profile 状态
              p.enabled = profileVal;
            }
          }
        }

        if (configRepairNeeded) {
          writeJsonSafe(CONFIG_FILE, config);
          notifyLanguageServer(repairRpcUpdates);
          recordConfigWriteMeta(profiles, config);
          profilesModified = true;
        } else if (profileChanged) {
          recordConfigWriteMeta(profiles, config);
          profilesModified = true;
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
