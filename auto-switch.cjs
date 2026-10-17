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
      path: "/api/status",
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
  try {
    ensureSidecarServerRunning();
    const raw = await readStdin();
    let payload = {};
    if (raw.trim()) {
      try { payload = JSON.parse(raw); } catch (e) {}
    }

    if (!fs.existsSync(configPath) || !fs.existsSync(profilesPath)) {
      return reply({});
    }

    let profiles = {};
    try {
      profiles = JSON.parse(fs.readFileSync(profilesPath, "utf-8"));
    } catch (e) {
      return reply({});
    }

    // 1. 构建包含 ~/.gemini/config/projects 与 profiles 的完整项目列表（含权威 paths 与 isPureChat）
    const projList = [];
    const seenProjIds = new Set();
    try {
      if (fs.existsSync(projectsDir)) {
        for (const f of fs.readdirSync(projectsDir)) {
          if (!f.endsWith(".json") || f === "outside-of-project.json") continue;
          const pData = JSON.parse(fs.readFileSync(path.join(projectsDir, f), "utf-8"));
          const pid = pData.id || f.replace(/\.json$/, "");
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
      convProjId = resolveProjectIdByConvId(payloadConvId, CONV_DB_PATH);
      if (convProjId && !profiles[convProjId] && !seenProjIds.has(convProjId)) {
        convProjId = "";
      }
    }

    // 3. 收集工作区候选 URI
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

    // 5. 兜底：若仍无 activeProjectId，读取 app_storage.json 的 projectsConversationOrder[0]
    if (!activeProjectId && fs.existsSync(APP_STORAGE_FILE)) {
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
      return reply({});
    }

    const matchedProfile = profiles[activeProjectId];
    if (!matchedProfile.plugins) {
      matchedProfile.plugins = {};
    }

    let configObj = {};
    try {
      configObj = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    } catch (e) {
      return reply({});
    }
    if (!configObj.plugins) configObj.plugins = {};

    if (!profiles.__meta__) profiles.__meta__ = {};
    const lastActiveId = profiles.__meta__.lastActiveProjectId || "";
    const lastPanelActionAt = Number(profiles.__meta__.lastPanelActionAt || 0);

    // 分支 B：仍处于同一项目内
    if (lastActiveId === activeProjectId) {
      // 尊重面板最近操作锁：若 5 秒内用户在面板操作过，禁止反向覆盖！
      if (Date.now() - lastPanelActionAt < 5000) {
        return reply({});
      }
      let profileChanged = false;
      for (const [pluginDir, pluginCfg] of Object.entries(configObj.plugins)) {
        if (PROTECTED_PLUGINS.has(pluginDir)) continue;
        const enabledInConfig = Boolean(pluginCfg && pluginCfg.enabled !== false);
        if (matchedProfile.plugins[pluginDir] !== enabledInConfig) {
          matchedProfile.plugins[pluginDir] = enabledInConfig;
          profileChanged = true;
        }
      }
      if (profileChanged) {
        try { fs.writeFileSync(profilesPath, JSON.stringify(profiles, null, 2), "utf-8"); } catch (e) {}
      }
      return reply({});
    }

    // 分支 A：跨项目切换
    profiles.__meta__.lastActiveProjectId = activeProjectId;
    try { fs.writeFileSync(profilesPath, JSON.stringify(profiles, null, 2), "utf-8"); } catch (e) {}

    let hasDiff = false;
    const rpcUpdates = {};

    for (const [pluginDir, shouldEnable] of Object.entries(matchedProfile.plugins)) {
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

    if (hasDiff) {
      fs.writeFileSync(configPath, JSON.stringify(configObj, null, 2), "utf-8");

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

    return reply({});
  } catch (err) {
    return reply({});
  }
}

main();
