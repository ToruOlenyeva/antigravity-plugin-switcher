import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PLUGINS_DIR,
  CONFIG_FILE,
  PROFILES_FILE,
  APP_STORAGE_FILE,
  PROTECTED_PLUGINS,
  DEFAULT_KEY,
  PRELOAD_SDK_PATH,
  listAllSwitcherInstances,
  resolveSwitcherInstanceContext,
  isValidPluginDirectory,
  resolveProjectIdFromDb,
  getFocusedWindowRoute,
  refreshFocusedWindowRoute,
  readJsonSafe,
  getPluginManifest,
  resolvePluginLogoFile,
  recordConfigWriteMeta,
  writeJsonSafe,
  notifyLanguageServer,
  notifyMatchingInstancesLanguageServers,
  getLastInternalConfigWriteMs,
  isInternalConfigWriteSettled
} from "./ls-bridge.mjs";
import {
  scanAntigravityProjects,
  resolveCurrentActiveProjectId,
  getSystemState
} from "./scanner.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.ANTIGRAVITY_SIDECAR_WEB_PORT || process.env.PORT || 8088);

// 维护内置 Sidecar 最新状态快照与 SSE 实时双输出客户端集合（支持双实例克隆端口同源广播，仅当前项目识别按端口所属实例独立区分）
const sseClients = new Set();
const latestStateByInstance = new Map();
const lastBroadcastSigByInstance = new Map();

function computeProfilesSignature(stateData) {
  if (!stateData || !stateData.profiles) return "";
  const parts = [];
  for (const [k, prof] of Object.entries(stateData.profiles)) {
    if (k === "__meta__" || !prof || !prof.plugins) continue;
    const pStr = Object.entries(prof.plugins)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([dir, val]) => `${dir}:${val ? 1 : 0}`)
      .join(",");
    parts.push(`${k}=[${pStr}]`);
  }
  return parts.sort().join(";");
}

function broadcastStateToAllFrontends(stateData, force = false) {
  if (!stateData) return;
  const instKey = stateData.instanceId || "main";
  latestStateByInstance.set(instKey, stateData);

  const pluginSig = (stateData.plugins || []).map((p) => `${p.dir}:${p.enabled ? 1 : 0}`).join(",");
  const profSig = computeProfilesSignature(stateData);
  const sig = `${instKey}|${stateData.activeProjectId || ""}|${stateData.activeConversationId || ""}|${pluginSig}|${profSig}`;
  if (!force && sig === lastBroadcastSigByInstance.get(instKey)) return;
  lastBroadcastSigByInstance.set(instKey, sig);

  for (const clientRes of sseClients) {
    try {
      const clientPort = clientRes.__localPort || PORT;
      const clientCtx = resolveSwitcherInstanceContext(clientPort);
      const clientInstKey = clientCtx.instanceId || "main";
      let payloadState = stateData;
      if (clientInstKey !== instKey) {
        payloadState = getSystemState({ localPort: clientPort, instanceCtx: clientCtx, isPassive: true });
        latestStateByInstance.set(clientInstKey, payloadState);
      }
      clientRes.write(`data: ${JSON.stringify(payloadState)}\n\n`);
    } catch (e) {
      sseClients.delete(clientRes);
    }
  }
}

process.on("uncaughtException", (err) => {
  console.error("[PluginSwitcher Sidecar] Uncaught exception:", err?.stack || err?.message || err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[PluginSwitcher Sidecar] Unhandled rejection:", reason);
});

function readReqJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      try { resolve(JSON.parse(body || "{}")); } catch (err) { reject(err); }
    });
    req.on("error", reject);
  });
}

function serveStaticFile(res, filePath, contentType, cacheControl = "no-store, no-cache, must-revalidate") {
  if (fs.existsSync(filePath)) {
    res.writeHead(200, { "Content-Type": contentType, "Cache-Control": cacheControl });
    res.end(fs.readFileSync(filePath));
  } else {
    res.writeHead(404);
    res.end(`${path.basename(filePath)} not found`);
  }
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
    const onlyStandalone = url.searchParams.get("onlyStandalone") === "1";
    if (onlyStandalone && process.env.ANTIGRAVITY_SIDECAR_WEB_PORT) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, ignored: true, reason: "already_host_sidecar" }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: true, message: "Sidecar restarting..." }));
    setTimeout(() => process.exit(0), 200);
    return;
  }

  // 0.1 动态切换中英文元数据及外层 Tab 标题
  if (req.method === "POST" && pathname === "/api/set-language") {
    try {
      const { lang } = await readReqJson(req);
      const isEn = lang === "en";
      const pluginJsonPath = path.join(PLUGINS_DIR, "plugin-switcher", "plugin.json");
      const localSidecarPath = path.join(__dirname, "sidecar.json");
      const targetDisplayName = isEn ? "Project Plugin Switcher" : "项目插件独立开关管理器";
      const targetDesc = isEn
        ? "Configure and switch Antigravity plugins independently per project with an interactive Auxiliary Pane web console."
        : "按项目独立配置与切换 Antigravity 插件启用状态，提供辅助侧边栏可视化 Web 交互面板。";
      const targetSidecarDisplayName = isEn ? "Project Plugin Switcher" : "项目插件独立开关";
      const targetViewTitle = isEn ? "Plugin Switcher" : "项目插件开关";

      const pluginJson = readJsonSafe(pluginJsonPath, null);
      if (pluginJson) {
        pluginJson.displayName = targetDisplayName;
        pluginJson.description = targetDesc;
        writeJsonSafe(pluginJsonPath, pluginJson);
      }

      const scJson = readJsonSafe(localSidecarPath, null);
      if (scJson) {
        scJson.display_name = targetSidecarDisplayName;
        if (scJson.ui_config?.views?.[0]) scJson.ui_config.views[0].title = targetViewTitle;
        writeJsonSafe(localSidecarPath, scJson);
      }

      const appStorage = readJsonSafe(APP_STORAGE_FILE, null);
      if (appStorage) {
        let storageChanged = false;
        for (const sessionKey of ["aux-pane-v2-session", "aux-pane-session"]) {
          if (!appStorage[sessionKey]) continue;
          const isStr = typeof appStorage[sessionKey] === "string";
          let session = appStorage[sessionKey];
          if (isStr) {
            try { session = JSON.parse(session); } catch (e) { continue; }
          }
          let sessionChanged = false;
          for (const paneGroup of [session.conversationPanes, session.newConversationPanes, session.panes]) {
            if (!paneGroup || typeof paneGroup !== "object") continue;
            for (const pane of Object.values(paneGroup)) {
              for (const tab of pane?.tabs || []) {
                const id = tab.id || "";
                const tabUrl = tab.content?.sidecarView?.url || "";
                const sidecarId = tab.content?.sidecarView?.sidecarId || "";
                if (id.includes("plugin-switcher") || tabUrl.includes("plugin-switcher") || sidecarId.includes("plugin-switcher")) {
                  if (tab.content?.sidecarView && tab.content.sidecarView.title !== targetViewTitle) {
                    tab.content.sidecarView.title = targetViewTitle;
                    sessionChanged = true;
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
        if (storageChanged) writeJsonSafe(APP_STORAGE_FILE, appStorage);
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, lang: isEn ? "en" : "zh" }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
    return;
  }

  // 1. 静态资源与 preload.js
  if (req.method === "GET" && pathname === "/") {
    return serveStaticFile(res, path.join(__dirname, "index.html"), "text/html; charset=utf-8");
  }
  if (req.method === "GET" && pathname === "/styles.css") {
    return serveStaticFile(res, path.join(__dirname, "styles.css"), "text/css; charset=utf-8");
  }
  if (req.method === "GET" && pathname === "/i18n.js") {
    return serveStaticFile(res, path.join(__dirname, "i18n.js"), "application/javascript; charset=utf-8");
  }
  if (req.method === "GET" && pathname === "/app.js") {
    return serveStaticFile(res, path.join(__dirname, "app.js"), "application/javascript; charset=utf-8");
  }
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

  // 2.5 SSE 实时双输出流（将同源 stateData 0ms 实时推送给各实例端口活跃面板）
  if (req.method === "GET" && pathname === "/api/events") {
    const localPort = Number(req.socket?.localPort || PORT);
    const reqCtx = resolveSwitcherInstanceContext(localPort);
    res.__localPort = localPort;
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-cache, must-revalidate",
      "Connection": "keep-alive"
    });
    res.write(": connected\n\n");
    const cachedState = latestStateByInstance.get(reqCtx.instanceId || "main");
    if (cachedState) {
      try {
        res.write(`data: ${JSON.stringify(cachedState)}\n\n`);
      } catch (e) {}
    }
    sseClients.add(res);
    req.on("close", () => {
      sseClients.delete(res);
    });
    return;
  }

  // 3. 状态接口（按请求进入的实例端口独立识别当前项目，共享其余全量配置）
  if (req.method === "GET" && pathname === "/api/status") {
    try {
      const startMs = Date.now();
      const localPort = Number(req.socket?.localPort || PORT);
      const reqCtx = resolveSwitcherInstanceContext(localPort);
      await refreshFocusedWindowRoute(false, reqCtx);

      const hostHdr = req.headers.host || "";
      const refHdr = req.headers.referer || "";
      const isStandalonePort = Boolean(
        localPort === 8088 || localPort === 8098 ||
        hostHdr.endsWith(":8088") || hostHdr.endsWith(":8098") ||
        refHdr.includes(":8088/") || refHdr.includes(":8098/")
      );
      const convId = isStandalonePort ? "" : (url.searchParams.get("conversationId") || "");
      const clientProjectId = url.searchParams.get("projectId") || "";
      const clientWorkspaceUri = isStandalonePort ? "" : (url.searchParams.get("workspaceUri") || "");
      const token = isStandalonePort ? "" : (url.searchParams.get("token") || "");
      const sidecarProjectId = isStandalonePort ? "" : (url.searchParams.get("sidecarProjectId") || "");
      const cid = isStandalonePort ? `browser_${localPort}` : (url.searchParams.get("cid") || "");
      const hasActiveFlag = isStandalonePort ? false : (url.searchParams.get("active") === "1");
      const hasPassiveFlag = isStandalonePort ? true : (url.searchParams.get("passive") === "1");
      const isPassive = hasActiveFlag ? false : hasPassiveFlag;
      const isInit = !isStandalonePort && url.searchParams.get("init") === "1";

      const stateData = getSystemState({
        convId, clientProjectId, clientWorkspaceUri, token, sidecarProjectId,
        cid, isPassive, hasActiveFlag, isInit, localPort, instanceCtx: reqCtx
      });
      broadcastStateToAllFrontends(stateData);

      const routeInfo = getFocusedWindowRoute(reqCtx);
      if (!globalThis.__switcherDebugTrace) globalThis.__switcherDebugTrace = [];
      globalThis.__switcherDebugTrace.push({
        at: new Date().toISOString(),
        elapsedMs: Date.now() - startMs,
        instanceId: reqCtx.instanceId,
        localPort,
        cid,
        convId: convId ? convId.slice(0, 8) : "",
        routePort: routeInfo.port,
        routeConvId: routeInfo.convId ? routeInfo.convId.slice(0, 8) : "",
        routeProjId: routeInfo.projectId ? routeInfo.projectId.slice(0, 8) : "",
        resolvedActiveProjectId: stateData.activeProjectId,
        resolvedConvId: stateData.activeConversationId
      });
      if (globalThis.__switcherDebugTrace.length > 60) globalThis.__switcherDebugTrace.shift();

      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store, no-cache, must-revalidate" });
      res.end(JSON.stringify(stateData));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (req.method === "GET" && pathname === "/api/debug-trace") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(globalThis.__switcherDebugTrace || [], null, 2));
    return;
  }

  // 插件图标本地静态资源服务
  if (req.method === "GET" && pathname === "/api/plugin-logo") {
    const dir = url.searchParams.get("dir") || "";
    if (!dir || !isValidPluginDirectory(dir) || dir.includes("..") || dir.includes("/") || dir.includes("\\")) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid plugin directory" }));
      return;
    }
    const logoFilePath = resolvePluginLogoFile(dir, getPluginManifest(dir));
    if (logoFilePath && fs.existsSync(logoFilePath)) {
      const ext = path.extname(logoFilePath).toLowerCase();
      const mimeMap = { ".svg": "image/svg+xml; charset=utf-8", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };
      res.writeHead(200, { "Content-Type": mimeMap[ext] || "application/octet-stream", "Cache-Control": "public, max-age=300" });
      res.end(fs.readFileSync(logoFilePath));
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Plugin logo not found" }));
    return;
  }

  // 4. 补齐官方 SDK preload 内部反查接口契约
  if (req.method === "POST" && pathname === "/_sidecar/get-conversation-metadata") {
    try {
      const { conversationId } = await readReqJson(req);
      const projectId = resolveProjectIdFromDb(conversationId);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ response: { conversationMetadata: { conversationId, metadata: { projectId } } } }));
    } catch (err) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ response: {} }));
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/toggle-plugin") {
    try {
      const { dir, enabled } = await readReqJson(req);
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
    return;
  }

  if (req.method === "POST" && pathname === "/api/set-plugin-state") {
    try {
      const { projectId, pluginDir, enabled, hostActiveId, conversationId } = await readReqJson(req);
      if (!projectId || !pluginDir) {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ success: false, error: "缺少 projectId 或 pluginDir" }));
      }
      if (PROTECTED_PLUGINS.has(pluginDir)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ success: false, error: "受保护插件不可关闭" }));
      }

      const localPort = Number(req.socket?.localPort || PORT);
      const reqCtx = resolveSwitcherInstanceContext(localPort);
      const profiles = readJsonSafe(PROFILES_FILE, {});
      const projects = scanAntigravityProjects(reqCtx);

      if (projectId === DEFAULT_KEY) {
        if (!profiles[DEFAULT_KEY]) profiles[DEFAULT_KEY] = { id: DEFAULT_KEY, name: "默认配置", paths: [], plugins: {} };
        if (!profiles[DEFAULT_KEY].plugins) profiles[DEFAULT_KEY].plugins = {};
        profiles[DEFAULT_KEY].plugins[pluginDir] = Boolean(enabled);
      } else {
        let targetProfile = profiles[projectId];
        if (!targetProfile) {
          const proj = projects.find(p => p.id === projectId);
          const defaultPlugins = (profiles[DEFAULT_KEY] && profiles[DEFAULT_KEY].plugins) || {};
          targetProfile = { id: projectId, name: proj ? proj.name : projectId, paths: proj ? proj.paths : [], plugins: JSON.parse(JSON.stringify(defaultPlugins)) };
          profiles[projectId] = targetProfile;
        }
        if (!targetProfile.plugins) targetProfile.plugins = {};
        targetProfile.plugins[pluginDir] = Boolean(enabled);
      }
      writeJsonSafe(PROFILES_FILE, profiles);

      const currentHostActiveId = hostActiveId || resolveCurrentActiveProjectId({ convId: conversationId, localPort }, projects, profiles.__meta__, reqCtx).activeProjectId || "";
      const anyInstanceUsingProject = Boolean(
        (currentHostActiveId && projectId === currentHostActiveId) ||
        Object.values(profiles?.__meta__?.instances || {}).some((inst) => inst && inst.lastActiveProjectId === projectId)
      );

      let runtimeSynced = false;
      if (anyInstanceUsingProject) {
        runtimeSynced = true;
        const config = readJsonSafe(CONFIG_FILE, { plugins: {} });
        if (!config.plugins) config.plugins = {};
        if (!config.plugins[pluginDir]) config.plugins[pluginDir] = {};
        config.plugins[pluginDir].enabled = Boolean(enabled);
        writeJsonSafe(CONFIG_FILE, config);
        recordConfigWriteMeta(profiles, config, projectId, true, reqCtx);
        notifyMatchingInstancesLanguageServers(projectId, { [pluginDir]: { enabled: Boolean(enabled) } }, profiles, reqCtx, currentHostActiveId);
      }

      if (!profiles.__meta__) profiles.__meta__ = {};
      profiles.__meta__.lastPanelActionAt = Date.now();
      if (currentHostActiveId && currentHostActiveId !== DEFAULT_KEY) {
        profiles.__meta__.lastSidecarProjectId = currentHostActiveId;
        profiles.__meta__.lastSidecarActiveAt = Date.now();
        if (conversationId) profiles.__meta__.lastSidecarConvId = conversationId;
      }
      if (currentHostActiveId && projectId === currentHostActiveId) profiles.__meta__.lastActiveProjectId = currentHostActiveId;
      writeJsonSafe(PROFILES_FILE, profiles);

      broadcastStateToAllFrontends(getSystemState({ localPort, instanceCtx: reqCtx, isPassive: true }), true);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, projectId, pluginDir, enabled: Boolean(enabled), runtimeSynced, profiles }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
    return;
  }

  // 恢复默认接口：深拷贝默认配置至该项目，永不改变默认配置本身
  if (req.method === "POST" && (pathname === "/api/reset-profile" || pathname === "/api/delete-profile")) {
    try {
      const { projectId, hostActiveId, conversationId } = await readReqJson(req);
      if (!projectId || projectId === DEFAULT_KEY) {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ success: false, error: "默认配置不可重置" }));
      }

      const localPort = Number(req.socket?.localPort || PORT);
      const reqCtx = resolveSwitcherInstanceContext(localPort);
      const profiles = readJsonSafe(PROFILES_FILE, {});
      const defaultPlugins = (profiles[DEFAULT_KEY] && profiles[DEFAULT_KEY].plugins) || {};

      if (!profiles[projectId]) {
        const projects = scanAntigravityProjects(reqCtx);
        const proj = projects.find(p => p.id === projectId);
        profiles[projectId] = { id: projectId, name: proj ? proj.name : projectId, paths: proj ? proj.paths : [], plugins: {} };
      }
      profiles[projectId].plugins = JSON.parse(JSON.stringify(defaultPlugins));

      const currentHostActiveId = hostActiveId || resolveCurrentActiveProjectId({ convId: conversationId, localPort }, [], profiles.__meta__, reqCtx).activeProjectId || "";
      const anyInstanceUsingProject = Boolean(
        currentHostActiveId === projectId ||
        Object.values(profiles?.__meta__?.instances || {}).some((inst) => inst && inst.lastActiveProjectId === projectId)
      );

      if (anyInstanceUsingProject) {
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
        recordConfigWriteMeta(profiles, config, projectId, true, reqCtx);
        notifyMatchingInstancesLanguageServers(projectId, rpcUpdates, profiles, reqCtx, currentHostActiveId);
      }

      if (!profiles.__meta__) profiles.__meta__ = {};
      profiles.__meta__.lastPanelActionAt = Date.now();
      if (currentHostActiveId && currentHostActiveId !== DEFAULT_KEY) {
        profiles.__meta__.lastSidecarProjectId = currentHostActiveId;
        profiles.__meta__.lastSidecarActiveAt = Date.now();
        if (conversationId) profiles.__meta__.lastSidecarConvId = conversationId;
      }
      if (currentHostActiveId && projectId === currentHostActiveId) profiles.__meta__.lastActiveProjectId = currentHostActiveId;
      writeJsonSafe(PROFILES_FILE, profiles);

      broadcastStateToAllFrontends(getSystemState({ localPort, instanceCtx: reqCtx, isPassive: true }), true);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, profiles, resetPlugins: profiles[projectId].plugins }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
    return;
  }

  // 批量修改或批量恢复默认插件状态接口
  if (req.method === "POST" && (pathname === "/api/batch-set-plugin-state" || pathname === "/api/batch-reset-profiles")) {
    try {
      const isResetMode = pathname === "/api/batch-reset-profiles";
      const { projectIds, pluginDir, enabled, hostActiveId, conversationId } = await readReqJson(req);
      if (!Array.isArray(projectIds) || (!isResetMode && !pluginDir)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ success: false, error: "缺少 projectIds 或 pluginDir" }));
      }
      if (!isResetMode && PROTECTED_PLUGINS.has(pluginDir)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ success: false, error: "受保护插件不可关闭" }));
      }
      const validProjectIds = projectIds.filter(id => id && id !== DEFAULT_KEY && id !== "__batch__");
      if (validProjectIds.length === 0) {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ success: false, error: "请至少指定一个有效的项目 ID" }));
      }

      const localPort = Number(req.socket?.localPort || PORT);
      const reqCtx = resolveSwitcherInstanceContext(localPort);
      const profiles = readJsonSafe(PROFILES_FILE, {});
      const projects = scanAntigravityProjects(reqCtx);
      const defaultPlugins = (profiles[DEFAULT_KEY] && profiles[DEFAULT_KEY].plugins) || {};

      for (const pid of validProjectIds) {
        let target = profiles[pid];
        if (!target) {
          const proj = projects.find(p => p.id === pid);
          target = { id: pid, name: proj ? proj.name : pid, paths: proj ? proj.paths : [], plugins: JSON.parse(JSON.stringify(defaultPlugins)) };
          profiles[pid] = target;
        }
        if (isResetMode) {
          target.plugins = JSON.parse(JSON.stringify(defaultPlugins));
        } else {
          if (!target.plugins) target.plugins = {};
          target.plugins[pluginDir] = Boolean(enabled);
        }
      }

      if (!profiles.__meta__) profiles.__meta__ = {};
      profiles.__meta__.lastPanelActionAt = Date.now();
      const currentHostActiveId = hostActiveId || resolveCurrentActiveProjectId({ convId: conversationId, localPort }, projects, profiles.__meta__, reqCtx).activeProjectId || "";
      const anyInstanceUsingBatch = Boolean(
        (currentHostActiveId && validProjectIds.includes(currentHostActiveId)) ||
        Object.values(profiles?.__meta__?.instances || {}).some((inst) => inst && validProjectIds.includes(inst.lastActiveProjectId))
      );

      let runtimeSynced = false;
      if (anyInstanceUsingBatch) {
        runtimeSynced = true;
        if (currentHostActiveId && validProjectIds.includes(currentHostActiveId)) profiles.__meta__.lastActiveProjectId = currentHostActiveId;
        const config = readJsonSafe(CONFIG_FILE, { plugins: {} });
        if (!config.plugins) config.plugins = {};
        const rpcUpdates = {};
        if (isResetMode) {
          for (const [pDir, shouldEnable] of Object.entries(defaultPlugins)) {
            if (PROTECTED_PLUGINS.has(pDir)) continue;
            if (!config.plugins[pDir]) config.plugins[pDir] = {};
            config.plugins[pDir].enabled = Boolean(shouldEnable);
            rpcUpdates[pDir] = { enabled: Boolean(shouldEnable) };
          }
        } else {
          if (!config.plugins[pluginDir]) config.plugins[pluginDir] = {};
          config.plugins[pluginDir].enabled = Boolean(enabled);
          rpcUpdates[pluginDir] = { enabled: Boolean(enabled) };
        }
        writeJsonSafe(CONFIG_FILE, config);
        recordConfigWriteMeta(profiles, config, currentHostActiveId || validProjectIds[0], true, reqCtx);
        notifyMatchingInstancesLanguageServers(validProjectIds, rpcUpdates, profiles, reqCtx, currentHostActiveId);
      }

      writeJsonSafe(PROFILES_FILE, profiles);
      broadcastStateToAllFrontends(getSystemState({ localPort, instanceCtx: reqCtx, isPassive: true }), true);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, updatedCount: validProjectIds.length, runtimeSynced, profiles, ...(isResetMode ? { resetPlugins: defaultPlugins } : {}) }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/apply-profile") {
    try {
      const localPort = Number(req.socket?.localPort || PORT);
      const reqCtx = resolveSwitcherInstanceContext(localPort);
      const { projectId } = await readReqJson(req);
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
      recordConfigWriteMeta(profiles, config, key, true, reqCtx);
      writeJsonSafe(PROFILES_FILE, profiles);
      notifyLanguageServer(rpcUpdates, profiles, reqCtx);

      const freshState = getSystemState({ localPort, instanceCtx: reqCtx, isPassive: true });
      broadcastStateToAllFrontends(freshState, true);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, projectId: key, applied: rpcUpdates }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
    return;
  }

  res.writeHead(404);
  res.end("Not Found");
}

const selfInstanceCtx = resolveSwitcherInstanceContext(PORT);

try {
  scanAntigravityProjects(selfInstanceCtx);
} catch (e) {}

const server = http.createServer(requestHandler);
server.on("error", (err) => {
  console.log(`[PluginSwitcher Sidecar] Primary port ${PORT} listener notice: ${err.message}`);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[PluginSwitcher Sidecar] Listening on http://127.0.0.1:${PORT} (Instance: ${selfInstanceCtx.instanceId}, Antigravity Port: ${process.env.ANTIGRAVITY_SIDECAR_WEB_PORT || "custom"})`);
});

// 绑定双实例克隆端口（8088 对应主实例，8098 对应多开实例；同一后端共享全部项目配置，仅当前项目识别按端口所属实例独立）
const boundPorts = new Set([PORT]);

function tryBindClonePort(clonePort) {
  if (PORT === clonePort || boundPorts.has(clonePort)) return;
  let retryCount = 0;
  const cloneServer = http.createServer(requestHandler);

  const attemptListen = () => {
    try {
      cloneServer.listen(clonePort, "127.0.0.1", () => {
        boundPorts.add(clonePort);
        console.log(`[PluginSwitcher Sidecar] Clone port listening enabled on http://127.0.0.1:${clonePort}`);
      });
    } catch (e) {}
  };

  cloneServer.on("error", (err) => {
    if (err && err.code === "EADDRINUSE") {
      retryCount++;
      if (retryCount === 1) {
        try {
          const evictReq = http.request({
            hostname: "127.0.0.1",
            port: clonePort,
            path: "/api/restart-sidecar?onlyStandalone=1",
            method: "POST",
            timeout: 500
          }, () => {});
          evictReq.on("error", () => {});
          evictReq.end();
        } catch (e) {}
        setTimeout(attemptListen, 350);
      } else {
        try { cloneServer.close(); } catch (e) {}
      }
    }
  });

  attemptListen();
}

if (selfInstanceCtx.isIsolatedInstance) {
  tryBindClonePort(8098);
} else {
  if (process.env.PLUGIN_SWITCHER_DISABLE_8088 !== "1") {
    tryBindClonePort(8088);
  }
  tryBindClonePort(8098);
}

function bindAdditionalSidecarPorts() {
  try {
    const curCtx = resolveSwitcherInstanceContext(PORT);
    const candidatePorts = new Set();
    // 严格仅扫描当前实例自身的 app_storage.json，绝不跨实例抢绑另一实例正在使用的 Sidecar 端口
    const appStorage = readJsonSafe(curCtx.appStorageFile || APP_STORAGE_FILE, {});
    const rawText = JSON.stringify(appStorage || {});
    const regex = /plugin-switcher--panel-(\d+)/g;
    let match;
    while ((match = regex.exec(rawText)) !== null) {
      const num = Number(match[1]);
      if (num > 1024 && num < 65535) candidatePorts.add(num);
    }

    // 排除其他活跃实例在 language_server.log 中正在使用的端口
    const otherInstancePorts = new Set();
    for (const cand of listAllSwitcherInstances()) {
      if (cand.instanceId === curCtx.instanceId) continue;
      try {
        if (cand.lsLogFile && fs.existsSync(cand.lsLogFile)) {
          const logTxt = fs.readFileSync(cand.lsLogFile, "utf-8");
          for (const m of logTxt.matchAll(/proxying to loopback port\s+(\d+)/gi)) {
            otherInstancePorts.add(Number(m[1]));
          }
        }
      } catch (e) {}
    }

    for (const p of candidatePorts) {
      if (boundPorts.has(p) || otherInstancePorts.has(p)) continue;
      boundPorts.add(p);
      try {
        const legacyServer = http.createServer(requestHandler);
        legacyServer.on("error", () => {
          boundPorts.delete(p);
        });
        legacyServer.listen(p, "127.0.0.1", () => {
          console.log(`[PluginSwitcher Sidecar] Legacy session port bridged on http://127.0.0.1:${p} (${curCtx.instanceId})`);
        });
      } catch (e) {
        boundPorts.delete(p);
      }
    }
  } catch (e) {}
}

bindAdditionalSidecarPorts();
setTimeout(bindAdditionalSidecarPorts, 4000);

// 仅当存在活跃前端面板连接（sseClients.size > 0）时低频（3500ms）检测各实例窗口路由跃变
const lastObservedRouteSigByInst = new Map();
setInterval(async () => {
  if (sseClients.size === 0) return;
  try {
    const activePorts = new Set([PORT]);
    for (const c of sseClients) {
      if (c.__localPort) activePorts.add(c.__localPort);
    }
    for (const lp of activePorts) {
      const ctx = resolveSwitcherInstanceContext(lp);
      const instKey = ctx.instanceId || "main";
      const route = await refreshFocusedWindowRoute(true, ctx);
      if (!route || !route.projectId) continue;
      const sig = `${route.projectId}|${route.convId || ""}`;
      if (sig !== lastObservedRouteSigByInst.get(instKey)) {
        lastObservedRouteSigByInst.set(instKey, sig);
        const stateData = getSystemState({ localPort: lp, instanceCtx: ctx, isPassive: false });
        broadcastStateToAllFrontends(stateData, false);
      }
    }
  } catch (e) {}
}, 3500);

// 事件驱动 1：监听 project-plugin-profiles.json 物理变更
// 当在任意实例面板修改并保存项目配置时，另一实例后端毫秒级捕获，立即同步其面板 SSE 与运行态 LS
async function handleExternalProfilesFileChange() {
  try {
    const curCtx = resolveSwitcherInstanceContext(PORT);
    const instKey = curCtx.instanceId || "main";
    const route = await refreshFocusedWindowRoute(false, curCtx);
    const profiles = readJsonSafe(PROFILES_FILE, {});
    const instMeta = profiles?.__meta__?.instances?.[instKey] || {};
    const activeId = (route && route.projectId) || instMeta.lastActiveProjectId || "";

    if (activeId && activeId !== DEFAULT_KEY && profiles[activeId] && profiles[activeId].plugins) {
      const targetPlugins = profiles[activeId].plugins;
      const lastSnap = instMeta.lastAppliedConfigSnapshot || null;
      const rpcUpdates = {};
      let hasDiff = false;
      for (const [pluginDir, shouldEnable] of Object.entries(targetPlugins)) {
        if (PROTECTED_PLUGINS.has(pluginDir)) continue;
        const targetVal = Boolean(shouldEnable);
        if (!lastSnap || lastSnap[pluginDir] === undefined || Boolean(lastSnap[pluginDir]) !== targetVal) {
          rpcUpdates[pluginDir] = { enabled: targetVal };
          hasDiff = true;
        }
      }
      if (hasDiff) {
        if (instMeta && typeof instMeta === "object") {
          instMeta.lastAppliedConfigSnapshot = { ...(lastSnap || {}), ...Object.fromEntries(Object.entries(targetPlugins).map(([k, v]) => [k, Boolean(v)])) };
        }
        notifyLanguageServer(rpcUpdates, profiles, curCtx);
      }
    }

    if (sseClients.size > 0) {
      const stateData = getSystemState({ localPort: PORT, instanceCtx: curCtx, isPassive: true });
      broadcastStateToAllFrontends(stateData, true);
    }
  } catch (e) {}
}

let profilesWatchDebounceTimer = null;
function triggerProfilesWatchDebounced() {
  if (profilesWatchDebounceTimer) clearTimeout(profilesWatchDebounceTimer);
  profilesWatchDebounceTimer = setTimeout(() => {
    profilesWatchDebounceTimer = null;
    handleExternalProfilesFileChange();
  }, 60);
}

// 事件驱动 2：监听 config.json 物理变更（捕获用户在原生 Settings 中手动拨动开关）
async function handleExternalConfigFileChange() {
  if (!isInternalConfigWriteSettled(600)) return;
  try {
    const curCtx = resolveSwitcherInstanceContext(PORT);
    const instKey = curCtx.instanceId || "main";
    const route = await refreshFocusedWindowRoute(true, curCtx);
    const profiles = readJsonSafe(PROFILES_FILE, {});
    const instMeta = profiles?.__meta__?.instances?.[instKey] || {};
    const routeProjectId = (route && route.projectId && profiles[route.projectId]) ? route.projectId : "";
    const lastActiveId = routeProjectId || instMeta.lastActiveProjectId || (!curCtx.isIsolatedInstance ? profiles?.__meta__?.lastActiveProjectId : "") || "";
    if (!lastActiveId || !profiles[lastActiveId] || !profiles[lastActiveId].plugins) return;

    const nowMs = Date.now();
    const lastProfileWriteAt = Number(profiles?.__meta__?.lastInternalConfigWriteAt || 0);
    const lastSwitchAt = Number(profiles?.__meta__?.lastProjectSwitchAt || 0);
    const lastBgHookAt = Number(profiles?.__meta__?.lastBgHookAt || 0);
    if (nowMs - lastProfileWriteAt <= 800 || nowMs - lastSwitchAt <= 1500 || nowMs - lastBgHookAt <= 1500) return;

    if (profiles?.__meta__?.lastAppliedProjectId && profiles.__meta__.lastAppliedProjectId !== lastActiveId) return;
    if (instMeta.lastAppliedProjectId && instMeta.lastAppliedProjectId !== lastActiveId) return;

    const config = readJsonSafe(CONFIG_FILE, { plugins: {} });
    const activeProfile = profiles[lastActiveId];
    const snap = profiles?.__meta__?.lastAppliedConfigSnapshot || null;
    let changed = false;

    for (const [pluginDir, pluginCfg] of Object.entries(config.plugins || {})) {
      if (PROTECTED_PLUGINS.has(pluginDir)) continue;
      const enabledInConfig = Boolean(pluginCfg && pluginCfg.enabled !== false);
      const divergedFromSnapshot = !snap || snap[pluginDir] === undefined || Boolean(snap[pluginDir]) !== enabledInConfig;
      if (divergedFromSnapshot && activeProfile.plugins[pluginDir] !== enabledInConfig) {
        activeProfile.plugins[pluginDir] = enabledInConfig;
        changed = true;
      }
    }

    if (changed) {
      recordConfigWriteMeta(profiles, config, lastActiveId, false, curCtx);
      writeJsonSafe(PROFILES_FILE, profiles);
      console.log(`[PluginSwitcher Sidecar] Instant native Settings sync -> project ${lastActiveId} (${instKey})`);
      const stateData = getSystemState({ localPort: PORT, instanceCtx: curCtx, isPassive: false });
      broadcastStateToAllFrontends(stateData, true);
    }
  } catch (e) {}
}

let configWatchDebounceTimer = null;
function triggerConfigWatchDebounced() {
  if (configWatchDebounceTimer) clearTimeout(configWatchDebounceTimer);
  configWatchDebounceTimer = setTimeout(() => {
    configWatchDebounceTimer = null;
    handleExternalConfigFileChange();
  }, 80);
}

try {
  const configDir = path.dirname(CONFIG_FILE);
  if (fs.existsSync(configDir)) {
    fs.watch(configDir, { persistent: false }, (_e, filename) => {
      if (!filename || filename === "config.json") triggerConfigWatchDebounced();
      if (!filename || filename === "project-plugin-profiles.json") triggerProfilesWatchDebounced();
    });
  }
  fs.watchFile(CONFIG_FILE, { interval: 1000, persistent: false }, (c, p) => { if (c.mtimeMs !== p.mtimeMs) triggerConfigWatchDebounced(); });
  fs.watchFile(PROFILES_FILE, { interval: 600, persistent: false }, (c, p) => { if (c.mtimeMs !== p.mtimeMs) triggerProfilesWatchDebounced(); });
} catch (e) {}


