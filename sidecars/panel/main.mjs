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
  getLastInternalConfigWriteMs,
  isInternalConfigWriteSettled,
  syncNativeSettingsFromLsMemory
} from "./ls-bridge.mjs";
import {
  scanAntigravityProjects,
  resolveCurrentActiveProjectId,
  getSystemState
} from "./scanner.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.ANTIGRAVITY_SIDECAR_WEB_PORT || process.env.PORT || 8088);

// 维护内置 Sidecar 最新状态快照与 SSE 实时双输出客户端集合（确保内置界面与 8088 端口 0ms 共享同一份 JSON 输出）
const sseClients = new Set();
let latestDualOutputState = null;
let lastBroadcastSignature = "";

function broadcastStateToAllFrontends(stateData, force = false) {
  if (!stateData || !stateData.activeProjectId) return;
  latestDualOutputState = stateData;
  const pluginSig = (stateData.plugins || []).map((p) => `${p.dir}:${p.enabled ? 1 : 0}`).join(",");
  const sig = `${stateData.activeProjectId}|${stateData.activeConversationId || ""}|${pluginSig}`;
  if (!force && sig === lastBroadcastSignature) return;
  lastBroadcastSignature = sig;
  const payload = `data: ${JSON.stringify(stateData)}\n\n`;
  for (const clientRes of sseClients) {
    try {
      clientRes.write(payload);
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

        // 2. 更新插件内嵌 sidecar.json
        const scJson = readJsonSafe(localSidecarPath, null);
        if (scJson) {
          scJson.display_name = targetSidecarDisplayName;
          if (scJson.ui_config?.views?.[0]) {
            scJson.ui_config.views[0].title = targetViewTitle;
          }
          writeJsonSafe(localSidecarPath, scJson);
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
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store, no-cache, must-revalidate"
      });
      res.end(fs.readFileSync(htmlPath, "utf-8"));
    } else {
      res.writeHead(404);
      res.end("index.html not found");
    }
    return;
  }

  // 1.1 静态样式与前端脚本
  if (req.method === "GET" && pathname === "/styles.css") {
    const cssPath = path.join(__dirname, "styles.css");
    if (fs.existsSync(cssPath)) {
      res.writeHead(200, {
        "Content-Type": "text/css; charset=utf-8",
        "Cache-Control": "no-store, no-cache, must-revalidate"
      });
      res.end(fs.readFileSync(cssPath, "utf-8"));
    } else {
      res.writeHead(404);
      res.end("styles.css not found");
    }
    return;
  }

  if (req.method === "GET" && pathname === "/i18n.js") {
    const i18nPath = path.join(__dirname, "i18n.js");
    if (fs.existsSync(i18nPath)) {
      res.writeHead(200, {
        "Content-Type": "application/javascript; charset=utf-8",
        "Cache-Control": "no-store, no-cache, must-revalidate"
      });
      res.end(fs.readFileSync(i18nPath, "utf-8"));
    } else {
      res.writeHead(404);
      res.end("i18n.js not found");
    }
    return;
  }

  if (req.method === "GET" && pathname === "/app.js") {
    const appPath = path.join(__dirname, "app.js");
    if (fs.existsSync(appPath)) {
      res.writeHead(200, {
        "Content-Type": "application/javascript; charset=utf-8",
        "Cache-Control": "no-store, no-cache, must-revalidate"
      });
      res.end(fs.readFileSync(appPath, "utf-8"));
    } else {
      res.writeHead(404);
      res.end("app.js not found");
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

  // 2.5 SSE 实时双输出流（将内置 Sidecar 算出的同一份 stateData 0ms 实时推送给 8088 与所有活跃面板）
  if (req.method === "GET" && pathname === "/api/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-cache, must-revalidate",
      "Connection": "keep-alive"
    });
    res.write(": connected\n\n");
    if (latestDualOutputState) {
      try {
        res.write(`data: ${JSON.stringify(latestDualOutputState)}\n\n`);
      } catch (e) {}
    }
    sseClients.add(res);
    req.on("close", () => {
      sseClients.delete(res);
    });
    return;
  }

  // 3. 状态接口（由 Electron 主窗口实时路由作为唯一真实源，内置 Sidecar 与 8088 端口 100% 同源输出）
  if (req.method === "GET" && pathname === "/api/status") {
    try {
      const startMs = Date.now();
      await refreshFocusedWindowRoute(false);

      const isStandalone8088 = Boolean(
        req.socket?.localPort === 8088 ||
        (req.headers.host || "").endsWith(":8088") ||
        (req.headers.referer || "").includes(":8088/")
      );
      const convId = isStandalone8088 ? "" : (url.searchParams.get("conversationId") || "");
      const clientProjectId = url.searchParams.get("projectId") || "";
      const clientWorkspaceUri = isStandalone8088 ? "" : (url.searchParams.get("workspaceUri") || "");
      const token = isStandalone8088 ? "" : (url.searchParams.get("token") || "");
      const sidecarProjectId = isStandalone8088 ? "" : (url.searchParams.get("sidecarProjectId") || "");
      const cid = isStandalone8088 ? "browser_8088" : (url.searchParams.get("cid") || "");
      const hasActiveFlag = isStandalone8088 ? false : (url.searchParams.get("active") === "1");
      const hasPassiveFlag = isStandalone8088 ? true : (url.searchParams.get("passive") === "1");
      const isPassive = hasActiveFlag ? false : hasPassiveFlag;
      const isInit = !isStandalone8088 && url.searchParams.get("init") === "1";

      const stateData = getSystemState({ convId, clientProjectId, clientWorkspaceUri, token, sidecarProjectId, cid, isPassive, hasActiveFlag, isInit });
      broadcastStateToAllFrontends(stateData);

      const routeInfo = getFocusedWindowRoute();
      const elapsedMs = Date.now() - startMs;
      if (!globalThis.__switcherDebugTrace) globalThis.__switcherDebugTrace = [];
      globalThis.__switcherDebugTrace.push({
        at: new Date().toISOString(),
        elapsedMs,
        cid,
        convId: convId ? convId.slice(0, 8) : "",
        routePort: routeInfo.port,
        routeConvId: routeInfo.convId ? routeInfo.convId.slice(0, 8) : "",
        routeProjId: routeInfo.projectId ? routeInfo.projectId.slice(0, 8) : "",
        resolvedActiveProjectId: stateData.activeProjectId,
        resolvedConvId: stateData.activeConversationId
      });
      if (globalThis.__switcherDebugTrace.length > 60) {
        globalThis.__switcherDebugTrace.shift();
      }
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store, no-cache, must-revalidate"
      });
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

    const manifest = getPluginManifest(dir);
    const logoFilePath = resolvePluginLogoFile(dir, manifest);

    if (logoFilePath && fs.existsSync(logoFilePath)) {
      const ext = path.extname(logoFilePath).toLowerCase();
      let contentType = "application/octet-stream";
      if (ext === ".svg") {
        contentType = "image/svg+xml; charset=utf-8";
      } else if (ext === ".png") {
        contentType = "image/png";
      } else if (ext === ".jpg" || ext === ".jpeg") {
        contentType = "image/jpeg";
      } else if (ext === ".webp") {
        contentType = "image/webp";
      }

      res.writeHead(200, {
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=300"
      });
      res.end(fs.readFileSync(logoFilePath));
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Plugin logo not found" }));
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
          recordConfigWriteMeta(profiles, config);

          notifyLanguageServer({ [pluginDir]: { enabled: Boolean(enabled) } });
        }

        if (!profiles.__meta__) profiles.__meta__ = {};
        profiles.__meta__.lastPanelActionAt = Date.now();
        if (currentHostActiveId && currentHostActiveId !== DEFAULT_KEY) {
          profiles.__meta__.lastSidecarProjectId = currentHostActiveId;
          profiles.__meta__.lastSidecarActiveAt = Date.now();
          if (conversationId) profiles.__meta__.lastSidecarConvId = conversationId;
        }
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
          recordConfigWriteMeta(profiles, config);
          notifyLanguageServer(rpcUpdates);
        }

        if (!profiles.__meta__) profiles.__meta__ = {};
        profiles.__meta__.lastPanelActionAt = Date.now();
        if (currentHostActiveId && currentHostActiveId !== DEFAULT_KEY) {
          profiles.__meta__.lastSidecarProjectId = currentHostActiveId;
          profiles.__meta__.lastSidecarActiveAt = Date.now();
          if (conversationId) profiles.__meta__.lastSidecarConvId = conversationId;
        }
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
          recordConfigWriteMeta(profiles, config);

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
          recordConfigWriteMeta(profiles, config);
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
        recordConfigWriteMeta(profiles, config);
        writeJsonSafe(PROFILES_FILE, profiles);
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

try {
  scanAntigravityProjects();
} catch (e) {}

const server = http.createServer(requestHandler);
server.on("error", (err) => {
  console.log(`[PluginSwitcher Sidecar] Primary port ${PORT} listener notice: ${err.message}`);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[PluginSwitcher Sidecar] Listening on http://127.0.0.1:${PORT} (Antigravity Port: ${process.env.ANTIGRAVITY_SIDECAR_WEB_PORT || "custom"})`);
});

if (PORT !== 8088) {
  let retryCount = 0;
  const standaloneServer = http.createServer(requestHandler);

  const tryBind8088 = () => {
    try {
      standaloneServer.listen(8088, "127.0.0.1", () => {
        console.log(`[PluginSwitcher Sidecar] Dual listening enabled on http://127.0.0.1:8088`);
      });
    } catch (e) {
      console.log(`[PluginSwitcher Sidecar] Standalone port 8088 listen error: ${e.message}`);
    }
  };

  standaloneServer.on("error", (err) => {
    if (err && err.code === "EADDRINUSE") {
      retryCount++;
      if (retryCount === 1) {
        try {
          const evictReq = http.request({
            hostname: "127.0.0.1",
            port: 8088,
            path: "/api/restart-sidecar?onlyStandalone=1",
            method: "POST",
            timeout: 500
          }, () => {});
          evictReq.on("error", () => {});
          evictReq.end();
        } catch (e) {}
        setTimeout(tryBind8088, 350);
      } else {
        setTimeout(tryBind8088, 3000);
      }
    } else {
      console.log(`[PluginSwitcher Sidecar] Standalone port 8088 listener notice: ${err.message}`);
    }
  });

  tryBind8088();
}

const boundPorts = new Set([PORT, 8088]);

function bindAdditionalSidecarPorts() {
  try {
    const candidatePorts = new Set();
    const profiles = readJsonSafe(PROFILES_FILE, {});
    if (profiles?.__meta__) {
      const recent = Array.isArray(profiles.__meta__.recentSidecarPorts) ? profiles.__meta__.recentSidecarPorts : [];
      if (PORT !== 8088 && !recent.includes(PORT)) {
        recent.unshift(PORT);
        profiles.__meta__.recentSidecarPorts = recent.slice(0, 12);
        writeJsonSafe(PROFILES_FILE, profiles);
      }
      for (const p of (profiles.__meta__.recentSidecarPorts || [])) {
        const num = Number(p);
        if (num > 1024 && num < 65535) candidatePorts.add(num);
      }
    }
    const appStorage = readJsonSafe(APP_STORAGE_FILE, {});
    const rawText = JSON.stringify(appStorage || {});
    const regex = /plugin-switcher--panel-(\d+)/g;
    let match;
    while ((match = regex.exec(rawText)) !== null) {
      const num = Number(match[1]);
      if (num > 1024 && num < 65535) candidatePorts.add(num);
    }
    for (const p of candidatePorts) {
      if (boundPorts.has(p)) continue;
      boundPorts.add(p);
      try {
        const legacyServer = http.createServer(requestHandler);
        legacyServer.on("error", () => {
          boundPorts.delete(p);
        });
        legacyServer.listen(p, "127.0.0.1", () => {
          console.log(`[PluginSwitcher Sidecar] Legacy session port bridged on http://127.0.0.1:${p}`);
        });
      } catch (e) {
        boundPorts.delete(p);
      }
    }
  } catch (e) {}
}

bindAdditionalSidecarPorts();
setInterval(bindAdditionalSidecarPorts, 5000);

// 常驻 800ms 监听 Antigravity Electron 主窗口路由跃变与 LS 内存态原生设置变更：哪怕内置 Sidecar 面板完全关闭，切项目或改原生设置也会在亚秒级自动同步并通过 SSE 推送给 8088 与所有活跃面板
let lastObservedRouteSig = "";
setInterval(async () => {
  try {
    const route = await refreshFocusedWindowRoute(true);
    if (!route || !route.projectId) {
      const lsSynced = await syncNativeSettingsFromLsMemory("");
      if (lsSynced) {
        const stateData = getSystemState({ isPassive: false });
        broadcastStateToAllFrontends(stateData, true);
      }
      return;
    }
    const sig = `${route.projectId}|${route.convId || ""}`;
    if (sig !== lastObservedRouteSig) {
      lastObservedRouteSig = sig;
      const stateData = getSystemState({ isPassive: false });
      broadcastStateToAllFrontends(stateData, false);
      return;
    }
    const lsSynced = await syncNativeSettingsFromLsMemory(route.projectId);
    if (lsSynced) {
      const stateData = getSystemState({ isPassive: false });
      broadcastStateToAllFrontends(stateData, true);
    }
  } catch (e) {}
}, 800);

// 事件驱动监听 config.json 物理变更（fs.watch 毫秒级内核事件 + fs.watchFile 兜底）：
// 当用户在 Antigravity 原生 Settings 中拨动开关时，无需等待 2.5s 轮询，在 <150ms 内立即捕获并经由 SSE 0ms 广播至内置 Sidecar 与 8088 面板
function handleExternalConfigFileChange() {
  if (!isInternalConfigWriteSettled(600)) return;
  try {
    const profiles = readJsonSafe(PROFILES_FILE, {});
    const lastActiveId = profiles?.__meta__?.lastActiveProjectId || "";
    if (!lastActiveId || !profiles[lastActiveId] || !profiles[lastActiveId].plugins) return;

    const nowMs = Date.now();
    const lastProfileWriteAt = Number(profiles?.__meta__?.lastInternalConfigWriteAt || 0);
    const lastSwitchAt = Number(profiles?.__meta__?.lastProjectSwitchAt || 0);
    const lastBgHookAt = Number(profiles?.__meta__?.lastBgHookAt || 0);
    if (nowMs - lastProfileWriteAt <= 800 || nowMs - lastSwitchAt <= 1500 || nowMs - lastBgHookAt <= 1500) return;

    const route = getFocusedWindowRoute();
    if (route && route.projectId && route.projectId !== lastActiveId) return;
    if (profiles?.__meta__?.lastAppliedProjectId && profiles.__meta__.lastAppliedProjectId !== lastActiveId) return;

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
      recordConfigWriteMeta(profiles, config, lastActiveId);
      writeJsonSafe(PROFILES_FILE, profiles);
      console.log(`[PluginSwitcher Sidecar] Instant native Settings sync -> project ${lastActiveId}`);
      const stateData = getSystemState({ isPassive: false });
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
    fs.watch(configDir, { persistent: false }, (eventType, filename) => {
      if (!filename || filename === "config.json") {
        triggerConfigWatchDebounced();
      }
    });
  }
} catch (e) {}

try {
  fs.watchFile(CONFIG_FILE, { interval: 1000 }, (curr, prev) => {
    if (curr.mtimeMs === prev.mtimeMs) return;
    triggerConfigWatchDebounced();
  });
} catch (e) {}


