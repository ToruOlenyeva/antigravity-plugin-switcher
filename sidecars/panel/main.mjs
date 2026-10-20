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
  readJsonSafe,
  getPluginManifest,
  resolvePluginLogoFile,
  recordConfigWriteMeta,
  writeJsonSafe,
  notifyLanguageServer,
  getLastInternalConfigWriteMs
} from "./ls-bridge.mjs";
import {
  scanAntigravityProjects,
  resolveCurrentActiveProjectId,
  getSystemState
} from "./scanner.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.ANTIGRAVITY_SIDECAR_WEB_PORT || process.env.PORT || 8088);

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
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
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
      res.writeHead(200, { "Content-Type": "text/css; charset=utf-8" });
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
      res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8" });
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
      res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8" });
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

  // 3. 状态接口（支持通过 conversationId、projectId、workspaceUri、token、passive 毫秒级直达当前 project_id）
  if (req.method === "GET" && pathname === "/api/status") {
    try {
      const convId = url.searchParams.get("conversationId") || "";
      const clientProjectId = url.searchParams.get("projectId") || "";
      const clientWorkspaceUri = url.searchParams.get("workspaceUri") || "";
      const token = url.searchParams.get("token") || "";
      const isPassive = url.searchParams.get("passive") === "1";
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(getSystemState({ convId, clientProjectId, clientWorkspaceUri, token, isPassive })));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: err.message }));
    }
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

// 后台监听 config.json 物理变更：仅当 config.json 相比本插件最后一次下发的快照（lastAppliedConfigSnapshot）发生真实偏离时，才认定为用户在原生 Settings 中手动拨动了开关
try {
  fs.watchFile(CONFIG_FILE, { interval: 1000 }, (curr, prev) => {
    if (curr.mtimeMs === prev.mtimeMs) return;
    if (Date.now() - getLastInternalConfigWriteMs() < 2500) return;
    try {
      const profiles = readJsonSafe(PROFILES_FILE, {});
      const lastActiveId = profiles?.__meta__?.lastActiveProjectId || "";
      if (!lastActiveId || !profiles[lastActiveId] || !profiles[lastActiveId].plugins) return;

      const lastWriteAt = Math.max(
        getLastInternalConfigWriteMs(),
        Number(profiles?.__meta__?.lastInternalConfigWriteAt || 0),
        Number(profiles?.__meta__?.lastBgHookAt || 0)
      );
      if (Date.now() - lastWriteAt < 2500) return;

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
        recordConfigWriteMeta(profiles, config);
        writeJsonSafe(PROFILES_FILE, profiles);
        console.log(`[PluginSwitcher Sidecar] Headless sync: native Settings changes saved to project ${lastActiveId}`);
      }
    } catch (e) {}
  });
} catch (e) {}


