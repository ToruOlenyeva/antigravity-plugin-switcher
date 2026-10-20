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
const configPath = path.join(homeDir, ".gemini", "config", "config.json");
const projectsDir = path.join(homeDir, ".gemini", "config", "projects");

const PROTECTED_PLUGINS = new Set(["plugin-switcher"]);
const DEFAULT_KEY = "__default__";

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

    let profiles = {};
    try {
      profiles = JSON.parse(fs.readFileSync(profilesPath, "utf-8"));
    } catch (e) {
      return reply(defaultReply);
    }

    // 1. 构建包含 ~/.gemini/config/projects 与 profiles 的完整项目列表（自动清除伴生容器空壳项目）
    let rawConfigForSidecars = {};
    try { rawConfigForSidecars = JSON.parse(fs.readFileSync(configPath, "utf-8")); } catch (e) {}
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
      const cachedProjId = profiles.__meta__.convProjectMap[payloadConvId] || "";
      if (cachedProjId && (profiles[cachedProjId] || seenProjIds.has(cachedProjId))) {
        convProjId = cachedProjId;
      } else {
        convProjId = resolveProjectIdByConvId(payloadConvId, CONV_DB_PATH);
        if (convProjId && !profiles[convProjId] && !seenProjIds.has(convProjId)) {
          convProjId = "";
        }
      }
    }

    // 3. 收集工作区候选 URI（含 PreToolUse 工具参数路径反推，解决新会话与子智能体溯源）
    const candidateUris = [];
    if (Array.isArray(payload.workspaceUris)) candidateUris.push(...payload.workspaceUris);
    else if (typeof payload.workspaceUris === "string") candidateUris.push(payload.workspaceUris);

    if (Array.isArray(payload.workspaceFolders)) {
      for (const f of payload.workspaceFolders) {
        if (typeof f === "string") candidateUris.push(f);
        else if (f && (f.uri || f.path)) candidateUris.push(f.uri || f.path);
      }
    } else if (typeof payload.workspaceFolders === "string") {
      candidateUris.push(payload.workspaceFolders);
    }
    if (payload.workspaceUri) candidateUris.push(payload.workspaceUri);
    if (payload.workspaceFolder) candidateUris.push(payload.workspaceFolder);
    if (payload.cwd) candidateUris.push(payload.cwd);

    if (payload.toolCall && payload.toolCall.args && typeof payload.toolCall.args === "object") {
      const tArgs = payload.toolCall.args;
      const toolPaths = [tArgs.Cwd, tArgs.AbsolutePath, tArgs.TargetFile, tArgs.Path, tArgs.path, tArgs.file_path, tArgs.SearchPath, tArgs.DirectoryPath];
      for (const tp of toolPaths) {
        if (typeof tp === "string" && tp.trim()) {
          const normTp = tp.replace(/\\/g, "/").toLowerCase();
          if (!normTp.includes(".gemini/antigravity/brain")) {
            candidateUris.push(tp);
          }
        }
      }
    }

    let wsProjId = "";
    if (candidateUris.length > 0) {
      wsProjId = findProjectIdByWorkspaceUris(candidateUris, projList);
    }

    // 4. 智能协同裁决（优先级与 main.mjs 100% 保持一致）
    let activeProjectId = "";
    const explicitId = payload.projectId || payload.project_id || "";
    if (explicitId && /^[0-9a-f-]{36}$/i.test(explicitId) && (profiles[explicitId] || seenProjIds.has(explicitId))) {
      activeProjectId = explicitId;
    }

    if (!activeProjectId) {
      if (convProjId && wsProjId) {
        if (convProjId === wsProjId) {
          activeProjectId = convProjId;
        } else {
          const convProj = projList.find(p => p.id === convProjId) || profiles[convProjId];
          const wsProj = projList.find(p => p.id === wsProjId) || profiles[wsProjId];

          let isConvSubOfWs = false;
          if (convProj && wsProj) {
            for (const cp of (convProj.paths || [])) {
              const normCp = normalizePath(cp);
              for (const wp of (wsProj.paths || [])) {
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
            activeProjectId = convProjId;
          } else if (!convProj || !convProj.paths || convProj.paths.length === 0) {
            // 纯对话项目（聊天），无工作区路径，属于当前对话自身
            activeProjectId = convProjId;
          } else {
            activeProjectId = wsProjId;
          }
        }
      } else if (convProjId) {
        activeProjectId = convProjId;
      } else if (wsProjId) {
        activeProjectId = wsProjId;
      }
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
      profiles.__meta__.lastActiveProjectId = activeProjectId;
      profiles.__meta__.lastBgHookAt = Date.now();
      profiles.__meta__.lastInternalConfigWriteAt = Date.now();
      const snap = {};
      for (const [k, v] of Object.entries(configObj.plugins || {})) {
        if (k.startsWith(".") || PROTECTED_PLUGINS.has(k)) continue;
        snap[k] = Boolean(!v || v.enabled !== false);
      }
      profiles.__meta__.lastAppliedConfigSnapshot = snap;
      metaChanged = true;
    }

    if (hasDiff) {
      fs.writeFileSync(configPath, JSON.stringify(configObj, null, 2), "utf-8");
    }

    if (metaChanged) {
      try { fs.writeFileSync(profilesPath, JSON.stringify(profiles, null, 2), "utf-8"); } catch (e) {}
    }

    if (hasDiff) {

      const lsAddr = process.env.ANTIGRAVITY_LS_ADDRESS || "localhost:5387";
      const csrf = process.env.ANTIGRAVITY_CSRF_TOKEN || "";

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
