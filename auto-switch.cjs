// Antigravity 跨项目插件自动感知与切换引擎
const fs = require("fs");
const path = require("path");
const http = require("http");
const os = require("os");

const homeDir = os.homedir();
const appDataDir = process.env.APPDATA || (process.platform === "darwin" ? path.join(homeDir, "Library", "Application Support") : path.join(homeDir, ".config"));
const APP_STORAGE_FILE = path.join(appDataDir, "Antigravity", "app_storage.json");
const CONV_DB_PATH = path.join(homeDir, ".gemini", "antigravity", "conversation_summaries.db");
const profilesPath = path.join(homeDir, ".gemini", "config", "project-plugin-profiles.json");
const profilesBakPath = `${profilesPath}.bak`;
const configPath = path.join(homeDir, ".gemini", "config", "config.json");
const projectsDir = path.join(homeDir, ".gemini", "config", "projects");

const PROTECTED_PLUGINS = new Set(["plugin-switcher"]);
const DEFAULT_KEY = "__default__";

function isWellFormedProfiles(obj) {
  return Boolean(
    obj &&
    typeof obj === "object" &&
    obj[DEFAULT_KEY] &&
    obj[DEFAULT_KEY].plugins &&
    typeof obj[DEFAULT_KEY].plugins === "object" &&
    Object.keys(obj[DEFAULT_KEY].plugins).length > 0
  );
}

function readJsonRobust(filePath, fallback = null, bakPath = "") {
  for (let i = 0; i < 3; i++) {
    try {
      if (fs.existsSync(filePath)) {
        const raw = fs.readFileSync(filePath, "utf-8");
        if (raw && raw.trim()) {
          const parsed = JSON.parse(raw);
          if (!bakPath || isWellFormedProfiles(parsed)) {
            return parsed;
          }
        }
      }
    } catch (e) {}
    const waitUntil = Date.now() + 2;
    while (Date.now() < waitUntil) {}
  }
  if (bakPath && fs.existsSync(bakPath)) {
    try {
      const bakParsed = JSON.parse(fs.readFileSync(bakPath, "utf-8"));
      if (isWellFormedProfiles(bakParsed)) return bakParsed;
    } catch (e) {}
  }
  return fallback;
}

function writeJsonAtomic(filePath, data, bakPath = "") {
  try {
    if (bakPath && !isWellFormedProfiles(data)) return false;
    const content = JSON.stringify(data, null, 2);
    const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.writeFileSync(tmpPath, content, "utf-8");
      fs.renameSync(tmpPath, filePath);
    } catch (err) {
      try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (e) {}
      fs.writeFileSync(filePath, content, "utf-8");
    }
    if (bakPath) {
      try {
        const bakTmp = `${bakPath}.${process.pid}.tmp`;
        fs.writeFileSync(bakTmp, content, "utf-8");
        fs.renameSync(bakTmp, bakPath);
      } catch (e) {}
    }
    return true;
  } catch (e) {
    return false;
  }
}

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => { data += chunk; });
    process.stdin.on("end", () => { resolve(data); });
  });
}

function reply(obj) {
  process.stdout.write(JSON.stringify(obj || {}));
  process.exit(0);
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

function findProjectIdByWorkspaceUris(uris, projectList = []) {
  if (!uris || !projectList || !projectList.length) return "";
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
    for (const proj of projectList) {
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

function resolveProjectIdByConvId(convId, convDbPath) {
  if (!convId || !fs.existsSync(convDbPath)) return "";
  try {
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(convDbPath, { readOnly: true, open: true });
    const stmt = db.prepare("SELECT project_id FROM conversation_summaries WHERE conversation_id = ?");
    const row = stmt.get(convId);
    db.close();
    if (row && row.project_id) return row.project_id;
  } catch (e) {}
  try {
    const { execFileSync } = require("child_process");
    const pyScript = "import sqlite3, sys; conn = sqlite3.connect(sys.argv[1]); c = conn.cursor(); c.execute('SELECT project_id FROM conversation_summaries WHERE conversation_id = ?', (sys.argv[2],)); r = c.fetchone(); print(r[0] if r else '')";
    const out = execFileSync("python", ["-c", pyScript, convDbPath, convId], {
      encoding: "utf-8",
      timeout: 1000,
      windowsHide: true
    });
    const pId = out.trim();
    if (pId) return pId;
  } catch (e) {}
  return "";
}

function ensureSidecarServerRunning() {
  try {
    const req = http.request({
      hostname: "127.0.0.1",
      port: 8088,
      path: "/api/status?passive=1",
      method: "GET",
      timeout: 300
    }, () => {});
    req.on("error", () => {
      try {
        const { spawn } = require("child_process");
        const mainScript = path.join(__dirname, "sidecars", "panel", "main.mjs");
        if (fs.existsSync(mainScript)) {
          const child = spawn(process.execPath, [mainScript], {
            detached: true,
            stdio: "ignore",
            windowsHide: true
          });
          child.unref();
        }
      } catch (e) {}
    });
    req.on("timeout", () => {
      req.destroy();
    });
    req.end();
  } catch (e) {}
}

async function main() {
  const hookMode = process.argv[2] || "pre-invocation";
  const defaultReply = hookMode === "pre-tool" ? { decision: "allow" } : {};

  try {
    if (hookMode !== "pre-tool") {
      ensureSidecarServerRunning();
    }
    const raw = await readStdin();
    let payload = {};
    if (raw.trim()) {
      try { payload = JSON.parse(raw); } catch (e) {}
    }

    if (!fs.existsSync(configPath) || !fs.existsSync(profilesPath)) {
      return reply(defaultReply);
    }

    const profiles = readJsonRobust(profilesPath, null, profilesBakPath);
    if (!profiles) {
      return reply(defaultReply);
    }

    // 1. 构建包含 ~/.gemini/config/projects 与 profiles 的完整项目列表（自动清除伴生容器空壳项目）
    const rawConfigForSidecars = readJsonRobust(configPath, {}) || {};
    const sidecarProjIds = new Set();
    if (rawConfigForSidecars && rawConfigForSidecars.sidecars && typeof rawConfigForSidecars.sidecars === "object") {
      for (const sc of Object.values(rawConfigForSidecars.sidecars)) {
        if (sc && sc.projectId) sidecarProjIds.add(sc.projectId);
      }
    }

    const projList = [];
    const seenProjIds = new Set();
    try {
      if (fs.existsSync(projectsDir)) {
        for (const f of fs.readdirSync(projectsDir)) {
          if (!f.endsWith(".json") || f === "outside-of-project.json") continue;
          const fullProjPath = path.join(projectsDir, f);
          const pData = JSON.parse(fs.readFileSync(fullProjPath, "utf-8"));
          const pid = pData.id || f.replace(/\.json$/, "");
          const isGhost = sidecarProjIds.has(pid) || (pData.name && (pData.name.startsWith("plugin-") || pData.name.includes("/sidecars/") || pData.name.includes("/panel") || pData.name.includes("/")));
          if (isGhost) {
            try { fs.unlinkSync(fullProjPath); } catch (e) {}
            continue;
          }
          if (pid && !seenProjIds.has(pid)) {
            seenProjIds.add(pid);
            const paths = [];
            const resources = (pData.projectResources && pData.projectResources.resources) || [];
            for (const res of resources) {
              const uri = res.folderUri || (res.gitFolder && res.gitFolder.folderUri) || "";
              if (uri && uri.startsWith("file:///")) {
                let p = decodeURIComponent(uri.replace(/^file:\/\/\//, ""));
                p = p.replace(/\\/g, "/").replace(/^([a-zA-Z])%3A/i, "$1:").replace(/^([a-zA-Z])%3a/i, "$1:");
                while (p.endsWith("/")) p = p.slice(0, -1);
                if (p) paths.push(p);
              }
            }
            if (Array.isArray(pData.paths)) {
              for (const p of pData.paths) {
                if (p && !paths.includes(p)) paths.push(p);
              }
            }
            projList.push({ id: pid, name: pData.name || pid, paths, isPureChat: paths.length === 0 });
          }
        }
      }
    } catch (e) {}
    for (const [k, p] of Object.entries(profiles)) {
      if (k === "__meta__" || k === DEFAULT_KEY || !p || typeof p !== "object") continue;
      const pid = p.id || k;
      if (!seenProjIds.has(pid)) {
        seenProjIds.add(pid);
        const paths = Array.isArray(p.paths) ? p.paths : [];
        projList.push({ id: pid, name: p.name || pid, paths, isPureChat: paths.length === 0 });
      }
    }

    if (!profiles.__meta__) profiles.__meta__ = {};
    if (!profiles.__meta__.convProjectMap || typeof profiles.__meta__.convProjectMap !== "object") {
      profiles.__meta__.convProjectMap = {};
    }

    // 2. 提取 payloadConvId（支持 direct/cascade/trajectory 以及从 transcriptPath 或 JSON 正则提取）
    let payloadConvId = payload.conversationId || payload.conversation_id || payload.cascadeId || payload.trajectoryId || "";
    if (!payloadConvId) {
      const payloadStr = (payload.transcriptPath ? String(payload.transcriptPath) : "") + " " + raw;
      const match = payloadStr.match(/brain[\\/]([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
      if (match && match[1]) {
        payloadConvId = match[1];
      }
    }

    let convProjId = "";
    if (payloadConvId) {
      // 1. 优先查 SQLite conversation_summaries.db 唯一事实源（<0.5ms），防止旧缓存或跨目录读文件污染项目归属
      const dbProjId = resolveProjectIdByConvId(payloadConvId, CONV_DB_PATH);
      if (dbProjId && (profiles[dbProjId] || seenProjIds.has(dbProjId))) {
        convProjId = dbProjId;
      } else {
        const cachedProjId = profiles.__meta__.convProjectMap[payloadConvId] || "";
        if (cachedProjId && (profiles[cachedProjId] || seenProjIds.has(cachedProjId))) {
          convProjId = cachedProjId;
        }
      }
    }

    // 3. 收集工作区候选 URI（优先显式 workspaceUris，且排除跨项目读取 .gemini/config/plugins 技能文件时的误匹配）
    const explicitWorkspaceUris = [];
    if (Array.isArray(payload.workspaceUris)) explicitWorkspaceUris.push(...payload.workspaceUris);
    else if (typeof payload.workspaceUris === "string") explicitWorkspaceUris.push(payload.workspaceUris);
    if (Array.isArray(payload.workspace_uris)) explicitWorkspaceUris.push(...payload.workspace_uris);

    if (Array.isArray(payload.workspaceFolders)) {
      for (const f of payload.workspaceFolders) {
        if (typeof f === "string") explicitWorkspaceUris.push(f);
        else if (f && (f.uri || f.path)) explicitWorkspaceUris.push(f.uri || f.path);
      }
    } else if (typeof payload.workspaceFolders === "string") {
      explicitWorkspaceUris.push(payload.workspaceFolders);
    }
    if (payload.workspaceUri) explicitWorkspaceUris.push(payload.workspaceUri);
    if (payload.workspaceFolder) explicitWorkspaceUris.push(payload.workspaceFolder);

    let wsProjId = "";
    if (explicitWorkspaceUris.filter(Boolean).length > 0) {
      wsProjId = findProjectIdByWorkspaceUris(explicitWorkspaceUris, projList);
    }
    if (!wsProjId && payload.cwd) {
      wsProjId = findProjectIdByWorkspaceUris([payload.cwd], projList);
    }
    if (!wsProjId && payload.toolCall && payload.toolCall.args && typeof payload.toolCall.args === "object") {
      const tArgs = payload.toolCall.args;
      const toolPaths = [tArgs.Cwd, tArgs.AbsolutePath, tArgs.TargetFile, tArgs.Path, tArgs.path, tArgs.file_path, tArgs.SearchPath, tArgs.DirectoryPath];
      const filteredToolPaths = [];
      for (const tp of toolPaths) {
        if (typeof tp === "string" && tp.trim()) {
          const normTp = tp.replace(/\\/g, "/").toLowerCase();
          if (!normTp.includes(".gemini/antigravity/brain") && !normTp.includes(".gemini/config/plugins")) {
            filteredToolPaths.push(tp);
          }
        }
      }
      if (filteredToolPaths.length > 0) {
        wsProjId = findProjectIdByWorkspaceUris(filteredToolPaths, projList);
      }
    }

    // 4. 智能协同裁决：一旦 SQLite / convProjectMap 明确认定了当前会话所属的 convProjId（含「聊天」项目），绝不允许被窗口残留 cwd 或工具读文件路径覆盖！
    let activeProjectId = "";
    const explicitId = payload.projectId || payload.project_id || "";
    if (explicitId && /^[0-9a-f-]{36}$/i.test(explicitId) && (profiles[explicitId] || seenProjIds.has(explicitId))) {
      activeProjectId = explicitId;
    } else if (convProjId) {
      activeProjectId = convProjId;
    } else if (wsProjId) {
      activeProjectId = wsProjId;
    }

    // 5. 兜底：仅在非 pre-tool 模式下才允许读取 app_storage.json 的 projectsConversationOrder[0]
    // （避免后台对话执行工具时误将前台窗口焦点当成后台对话所属项目）
    if (!activeProjectId && hookMode !== "pre-tool" && fs.existsSync(APP_STORAGE_FILE)) {
      try {
        const appStorage = JSON.parse(fs.readFileSync(APP_STORAGE_FILE, "utf-8"));
        const convOrder = JSON.parse(appStorage.projectsConversationOrder || "[]");
        const activeConvId = Array.isArray(convOrder) ? convOrder[0] : "";
        if (activeConvId) {
          const queryProjId = resolveProjectIdByConvId(activeConvId, CONV_DB_PATH);
          if (queryProjId && (profiles[queryProjId] || seenProjIds.has(queryProjId))) {
            activeProjectId = queryProjId;
          }
        }
      } catch (e) {}
    }

    // 严禁使用 process.env.WORKSPACE_ROOT 兜底！直接放行，避免误伤
    if (!activeProjectId || !profiles[activeProjectId]) {
      return reply(defaultReply);
    }

    const matchedProfile = profiles[activeProjectId];
    if (!matchedProfile.plugins) {
      matchedProfile.plugins = {};
    }

    let configObj = {};
    try {
      configObj = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    } catch (e) {
      return reply(defaultReply);
    }
    if (!configObj.plugins) configObj.plugins = {};

    const lastActiveId = profiles.__meta__.lastActiveProjectId || "";
    let metaChanged = false;

    if (payloadConvId && profiles.__meta__.convProjectMap[payloadConvId] !== activeProjectId) {
      profiles.__meta__.convProjectMap[payloadConvId] = activeProjectId;
      const keys = Object.keys(profiles.__meta__.convProjectMap);
      if (keys.length > 120) {
        for (let i = 0; i < keys.length - 100; i++) {
          delete profiles.__meta__.convProjectMap[keys[i]];
        }
      }
      metaChanged = true;
    }

    // 检测当前触发 Hook 的会话是否为「后台运行对话」（前台已切换到其他项目）
    let storageHeadConvId = "";
    try {
      const storage = readJsonRobust(APP_STORAGE_FILE, null);
      if (storage && storage.projectsConversationOrder) {
        const order = typeof storage.projectsConversationOrder === "string"
          ? JSON.parse(storage.projectsConversationOrder)
          : storage.projectsConversationOrder;
        if (Array.isArray(order) && order.length > 0 && typeof order[0] === "string") {
          storageHeadConvId = order[0];
        }
      }
    } catch (e) {}

    const foregroundSidecarProjId = profiles.__meta__.lastSidecarProjectId || "";
    const lastSidecarPollAt = Number(profiles.__meta__.lastSidecarPollAt || 0);
    const isSidecarActivelyTrackingOtherProject = Boolean(
      foregroundSidecarProjId &&
      foregroundSidecarProjId !== activeProjectId &&
      (Date.now() - lastSidecarPollAt < 8000)
    );
    const isBackgroundConv = Boolean(
      isSidecarActivelyTrackingOtherProject ||
      (payloadConvId && storageHeadConvId && payloadConvId !== storageHeadConvId) ||
      (foregroundSidecarProjId && foregroundSidecarProjId !== activeProjectId && payloadConvId && payloadConvId !== profiles.__meta__.lastSidecarConvId)
    );

    // 若为后台对话调用（无论 pre-tool 还是 pre-invocation），当宿主主窗口正聚焦在其他项目时，绝对不篡改前台活跃项目 ID 与全局 config.json，防止把前台项目插件偷偷关掉
    if (isBackgroundConv) {
      if (metaChanged) {
        writeJsonAtomic(profilesPath, profiles, profilesBakPath);
      }
      return reply(defaultReply);
    }

    // 无论 lastActiveId 是否等于 activeProjectId，Hook 一律以 matchedProfile.plugins 为唯一权威真源正向校验 config.json
    // 绝不在 Hook 中用 config.json 反向覆盖 matchedProfile.plugins，彻底杜绝前后台切换时相互污染 Profile！
    let hasDiff = false;
    const rpcUpdates = {};

    for (const [pluginDir, shouldEnable] of Object.entries(matchedProfile.plugins)) {
      if (pluginDir.startsWith(".")) continue;
      if (PROTECTED_PLUGINS.has(pluginDir)) continue;

      if (!configObj.plugins[pluginDir]) configObj.plugins[pluginDir] = {};
      const currentStatus = configObj.plugins[pluginDir].enabled !== false;
      const targetStatus = Boolean(shouldEnable);

      if (currentStatus !== targetStatus) {
        configObj.plugins[pluginDir].enabled = targetStatus;
        rpcUpdates[pluginDir] = { enabled: targetStatus };
        hasDiff = true;
      }
    }

    if (lastActiveId !== activeProjectId || hasDiff) {
      const nowMs = Date.now();
      if (activeProjectId && activeProjectId !== DEFAULT_KEY) {
        if (lastActiveId !== activeProjectId) {
          profiles.__meta__.lastProjectSwitchAt = nowMs;
        }
        profiles.__meta__.lastActiveProjectId = activeProjectId;
        profiles.__meta__.lastAppliedProjectId = activeProjectId;
      }
      profiles.__meta__.lastBgHookAt = nowMs;
      profiles.__meta__.lastInternalConfigWriteAt = nowMs;
      const snap = {};
      for (const [k, v] of Object.entries(configObj.plugins || {})) {
        if (k.startsWith(".") || PROTECTED_PLUGINS.has(k)) continue;
        snap[k] = Boolean(!v || v.enabled !== false);
      }
      profiles.__meta__.lastAppliedConfigSnapshot = snap;
      metaChanged = true;
    }

    // 必须先写 profiles.json（锁定时间戳与新快照），再写 config.json，防止 Sidecar 的 fs.watch 读到旧快照产生反向误判！
    if (metaChanged) {
      writeJsonAtomic(profilesPath, profiles, profilesBakPath);
    }

    if (hasDiff) {
      writeJsonAtomic(configPath, configObj);

      const savedTarget = profiles.__meta__.lsRpcTarget || {};
      const lsAddr = process.env.ANTIGRAVITY_LS_ADDRESS || (savedTarget.port ? `${savedTarget.hostname || "127.0.0.1"}:${savedTarget.port}` : "localhost:5387");
      const csrf = process.env.ANTIGRAVITY_CSRF_TOKEN || savedTarget.csrf || "";

      if (csrf && Object.keys(rpcUpdates).length > 0) {
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
          req.write(JSON.stringify({ userConfig: { plugins: rpcUpdates } }));
          req.end();
        } catch (e) {}
      }
    }

    return reply(defaultReply);
  } catch (err) {
    return reply(defaultReply);
  }
}

main();
