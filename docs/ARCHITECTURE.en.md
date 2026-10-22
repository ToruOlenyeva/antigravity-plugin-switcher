[English](ARCHITECTURE.en.md) | [简体中文](ARCHITECTURE.md)

# Antigravity Plugin Switcher Architecture Design

This document details the core architecture, four-tier project resolution algorithm, dual-way synchronization pipeline, and HTTP API specifications for Antigravity Plugin Switcher.

## 1. System Architecture and Runtime Model

This extension operates within the <b>Google Antigravity 2.0</b> desktop client environment (featuring the left-hand project and conversation tree <code>projects</code>, central conversation canvas, and the right-hand <code>SIDECAR_UI_ENTRYPOINT_AUX_PANE</code> container, distinguished from legacy VS Code-forked <code>Antigravity IDE</code>).

Antigravity Plugin Switcher consists of two core components working in tandem:
- <b>Hook Interceptor (auto-switch.cjs)</b>: Operates as an Antigravity lifecycle hook, intercepting workspace environment variables and session events.
- <b>Sidecar Daemon & Modular UI (sidecars/panel/)</b>: Implements a build-free native frontend/backend decoupled architecture, providing real-time management on port 8088 and within the Auxiliary Pane. Features backend modules (<code>main.mjs</code> HTTP routing, <code>ls-bridge.mjs</code> host RPC bridge, <code>scanner.mjs</code> status scoring scanner) and frontend assets (<code>index.html</code> skeleton, <code>styles.css</code> themes, <code>i18n.js</code> dictionary, <code>app.js</code> interaction engine).

### 1.1 Modular Project Structure

```
plugin-switcher/
├── assets/
│   └── logo.svg                 # Vector brand logo
├── docs/
│   ├── ARCHITECTURE.en.md       # English architecture design doc
│   └── ARCHITECTURE.md          # Chinese architecture design doc
├── sidecars/
│   └── panel/                   # Native build-free decoupled Sidecar panel
│       ├── app.js               # Frontend interaction and state sync engine
│       ├── i18n.js              # Frontend internationalization dictionary
│       ├── index.html           # Frontend HTML skeleton structure
│       ├── ls-bridge.mjs        # Backend host RPC bridge and disk persistence
│       ├── main.mjs             # Backend HTTP routing and static file server
│       ├── scanner.mjs          # Backend workspace scanner and 4-tier engine
│       ├── sidecar.json         # Antigravity Sidecar container manifest
│       └── styles.css           # Frontend responsive adaptive stylesheets
├── auto-switch.cjs              # Host lifecycle Hook interceptor
├── hooks.json                   # Antigravity Hook configuration
├── open-panel.bat               # Standalone window quick launcher script
├── plugin.json                  # Antigravity plugin manifest
├── project-plugin-profiles.example.json # Example profile configuration
├── README.en.md                 # English documentation
└── README.md                    # Chinese documentation
```

```
+-----------------------------------------------------------+
|                   Google Antigravity Host                 |
|  +--------------------+        +-----------------------+  |
|  |   Native Settings  |        |    Auxiliary Pane     |  |
|  +---------+----------+        +-----------+-----------+  |
|            |                               |              |
+------------|-------------------------------|--------------+
             | File Watcher (fs.watchFile)   | HTTP / Token
             v                               v
+-----------------------------------------------------------+
|               Plugin Switcher Sidecar (Port 8088)         |
|  +-----------------------------------------------------+  |
|  |           Four-Tier Resolution Algorithm            |  |
|  +-----------------------------------------------------+  |
|  |          Dual-Way Sync Engine & 5s Debounce         |  |
|  +-----------------------------------------------------+  |
|  |            SQLite Direct Query & Scoring            |  |
|  +-----------------------------------------------------+  |
+-----------------------------------------------------------+
             |                               |
             v                               v
   ~/.gemini/config/config.json    project-plugin-profiles.json
```

## 2. Four-Tier Project Resolution Algorithm

To reliably determine the active project in complex host environments (multi-root workspaces, chat sessions, cloud desktops, rapid tab switching, and concurrent background Sidecar `iframe` instances), the system implements a four-tier arbitration hierarchy anchored by the host main window's live route:

### Tier 1: Electron Main Window Live Route Direct Read (`DevToolsActivePort` Authoritative Source)
The Sidecar prioritizes reading the currently focused main window route via the standard Chromium DevTools endpoint exposed by the Antigravity host:
- <b>Dynamic Port Discovery (Zero Hardcoded Ports)</b>: `discoverElectronCdpPort()` in `ls-bridge.mjs` reads the first line of `<AppData>/Antigravity/DevToolsActivePort` (automatically updated by the host whenever a new random port is assigned on startup, with regex extraction of `ws://127.0.0.1:<port>/devtools/browser/` from the tail of `language_server.log` as a secondary fallback).
- <b>Real-Time Main Window Route Extraction (`< 3ms`)</b>: `refreshFocusedWindowRoute()` queries `http://127.0.0.1:<port>/json`, locates the main window `page` target URL (`https://127.0.0.1:8985/c/<convId>?section=<projectId>`), extracts both the focused `convId` and `sectionProjId`, and seeds the in-memory `convIdProjectCache`.
- <b>Complete Immunity to Background `iframe` Hijacking and Stale Cache</b>: Because the host main window has exactly one active route at any moment, the backend treats `getFocusedWindowRoute()` as the primary source of truth (`source: "electron-window-route"`), ignores stale `conversationId` polls from non-focused background Sidecar `iframe` tabs, and automatically purges legacy `convProjectMap` entries from `project-plugin-profiles.json`.

### Tier 2: Explicit Parameters, Native SQLite Query, and Multi-Root Path Scoring
When the main window is in a transitional view without an active conversation route or when triggered independently by lifecycle hooks:
- <b>Native SQLite Query (Zero Child-Process Blocking)</b>: Leverages the persistent read-only `node:sqlite` handle to query `conversation_summaries.db` directly for `project_id` and caches the result in `convIdProjectCache` (eliminating child-process spawn stalls from Python or `agentapi` CLI).
- <b>Longest Common Path Scoring</b>: For new conversations (without a `conversationId`) where the client reports `workspaceUris`, the algorithm evaluates each candidate project path.
  - An exact match yields the highest score (10000 points plus path string length).
  - A prefix match yields a score proportional to prefix string length.
  - The project with the highest cumulative score wins, cleanly resolving nested multi-root directories.

### Tier 3: Directory-Free Chat Session Isolation
When the client detects a session without any physical workspace paths (<code>clientEmptyPaths: true</code>):
- The session is identified as a general conversational chat.
- Heavy development plugins are automatically disabled to prevent token and context window consumption.

### Tier 4: Global Default Profile Fallback
- If all previous tiers fail to resolve a matching project, the system safely falls back to the global baseline configuration (<code>__default__</code>), ensuring uninterrupted operations.

## 3. Dual-Way Sync Engine, Concurrency Isolation, and Dual-Output Mirroring

### 3.1 Three-Tier Physical Isolation for Concurrent Background Project A and Foreground Project B
Because the Antigravity host shares a single global <code>~/.gemini/config/config.json</code> and Language Server state, the system enforces three physical isolation barriers so that <b>when Project A is running a background task while the user switches to Project B in the foreground, Project A strictly uses its own plugin configuration (never adopting Project B's plugins) and never pollutes Project B's profile</b>:
1. <b>Barrier 1: Per-Turn Identity Self-Verification and Instant Correction (<code>auto-switch.cjs</code>)</b>
   - Whenever background Project A starts an agent turn (<code>BeforeAgent</code> / <code>PreInvocation</code>) or invokes any tool (<code>PreToolUse</code>), <code>auto-switch.cjs</code> intercepts the lifecycle payload.
   - <b>Foreground Focus Ban in PreToolUse</b>: In <code>pre-tool</code> mode, the hook is <b>strictly forbidden</b> from reading the foreground window focus (<code>projectsConversationOrder[0]</code> in <code>app_storage.json</code>). Instead, it extracts the task's own <code>conversationId</code> / <code>transcriptPath</code> UUID and tool target paths (<code>TargetFile</code> / <code>cwd</code>) directly from the hook payload, cross-referencing <code>convProjectMap</code> and <code>conversation_summaries.db</code> to verify that the executing task belongs to Project A.
   - <b>Sub-Millisecond Pre-Execution Restore</b>: If global <code>config.json</code> was switched to Project B by foreground browsing, <code>auto-switch.cjs</code> atomically restores <code>profiles[A].plugins</code> into <code>config.json</code> and dispatches Language Server RPC updates right before Project A's step executes.
2. <b>Barrier 2: One-Way Authority Invariant (Profile to Config Only)</b>
   - <code>auto-switch.cjs</code> strictly performs one-way application (<code>profiles[projectId] -> config.json</code>) and never copies <code>config.json</code> back into <code>project-plugin-profiles.json</code>, preventing stale plugin states from contaminating another project's saved profile during rapid switching.
3. <b>Barrier 3: Config Snapshot Diffing and Background Hook Cooldown Lock (<code>lastAppliedConfigSnapshot</code> + <code>lastBgHookAt</code>)</b>
   - When background Project A's hook updates <code>config.json</code>, it records the exact state snapshot in <code>__meta__.lastAppliedConfigSnapshot</code> along with <code>__meta__.lastBgHookAt</code> inside <code>project-plugin-profiles.json</code>.
   - The foreground Sidecar panel viewing Project B compares <code>config.json</code> against <code>lastAppliedConfigSnapshot</code>. Finding an exact match (<code>divergedFromSnapshot === false</code>), it recognizes that <code>config.json</code> was modified by a background project hook rather than a manual toggle in Antigravity's native Settings UI. Consequently, Project B <b>refuses to overwrite its own profile with Project A's state</b> and automatically self-heals <code>config.json</code> back to Project B when appropriate.
   - Conversely, only when a user manually toggles a plugin inside Antigravity's native Settings UI (causing <code>divergedFromSnapshot === true</code> after the <code>2.5s</code> cooldown window) will <code>scanner.mjs</code> and <code>main.mjs</code>'s <code>fs.watchFile(CONFIG_FILE)</code> persist that manual change into the active project's profile.

### 3.2 Decoupling Host Active Project (<code>●</code>) from Dropdown Viewed/Edited Profile
- <b>Separation of Active Indicator and Dropdown Selection</b>:
  - The green dot <code>●</code> permanently marks the <b>host's currently active project</b> (<code>state.activeProjectId</code>);
  - The dropdown selection (<code>currentSelectedId</code>) represents the <b>target project currently viewed or pre-edited in the panel</b>.
- <b>Uninterrupted Cross-Project Pre-Editing</b>: When the host is in Project B but the user selects Project C in the dropdown to configure switches:
  - Toggling switches in Project C saves silently to <code>profiles[C]</code> ("Saved to project profile (will take effect when switching to it)") <b>without altering <code>config.json</code> used by active Project B</b>;
  - Toggling switches on the active Project B (marked with <code>●</code>) or <code>__default__</code> immediately updates <code>config.json</code> and triggers Language Server RPC live reload via <code>ls-bridge.mjs</code>;
  - The background <code>2.5s</code> heartbeat (<code>syncActiveProjectSilently</code>) <b>only auto-switches the dropdown when the host active project genuinely transitions (<code>nextHostActiveId !== lastHostActiveId</code>)</b>, ensuring users are never yanked back while editing another project's preset.

### 3.3 Single-Process Dual-Port Hosting and <code>http://localhost:8088</code> Zero-Latency SSE Dual-Output Mirroring
- <b>Cross-Account Homologous Home Resolution and Single-Process Dual-Port Binding (<code>ls-bridge.mjs</code> + <code>main.mjs</code>)</b>:
  - To prevent <code>os.homedir()</code> mismatches when the Windows desktop session runs under a standard user account while the Antigravity host runs under an Administrator account, <code>resolveHostHomeDir()</code> derives the host user home directory directly from the physical plugin installation path, ensuring 100% homologous configuration access;
  - When spawned by the host, a single Node.js Sidecar process simultaneously binds both the host-assigned dynamic port (<code>ANTIGRAVITY_SIDECAR_WEB_PORT</code>) and standalone port <code>8088</code> (automatically evicting any stale standalone process on port <code>8088</code> via <code>POST /api/restart-sidecar</code>), eliminating split-brain processes.
- <b>Compute-Once, Zero-Latency Dual-Output via <code>latestDualOutputState</code> and SSE (<code>GET /api/events</code>)</b>:
  - Whenever the built-in Sidecar requests <code>GET /api/status</code> and computes the latest <code>stateData</code>, the backend caches it in <code>latestDualOutputState</code> and broadcasts it in <code>0ms</code> via <code>broadcastStateToAllFrontends(stateData)</code> over <code>GET /api/events</code> (Server-Sent Events) to <code>http://localhost:8088</code>;
  - External browsers on <code>http://localhost:8088</code> subscribe via <code>new EventSource("/api/events")</code> to render the exact same payload in real time, while standard <code>GET /api/status</code> polls on port <code>8088</code> directly reuse <code>latestDualOutputState.activeProjectId</code> (only falling back to the top conversation in <code>app_storage.json</code> when the built-in Sidecar has been closed or inactive for <code>&gt; 8s</code>).
- <b>Frontend Dual-Observer Visibility Tracking (<code>ResizeObserver</code> + <code>IntersectionObserver</code>)</b>:
  - <code>isPanelActuallyVisible()</code> combines <code>ResizeObserver</code> with <code>IntersectionObserver({ trackVisibility: true, delay: 100 })</code> to detect true viewport visibility and occlusion: hidden conversation iframes immediately pause their <code>2.5s</code> polling timer, and immediately fire an active sync (<code>isPassive = false</code>) the moment they become visible again, driving instant simultaneous updates across both the built-in Sidecar and port <code>8088</code>.

## 4. HTTP API Specifications

All endpoints are served identically from both the host-assigned internal port and <code>http://127.0.0.1:8088</code> within the same process.

### 4.1 Get Status and Configurations
- <b>Route</b>: <code>GET /api/status</code>
- <b>Query Parameters</b>:
  - <code>conversationId</code> (optional): Unique conversation identifier.
  - <code>projectId</code> (optional): Project identifier.
  - <code>workspaceUri</code> (optional): Workspace path string or array.
- <b>Response</b>:
```json
{
  "activeProjectId": "sample-project-id",
  "plugins": [
    {
      "dir": "plugin-switcher",
      "name": "plugin-switcher",
      "displayName": "Project Plugin Switcher",
      "description": "Configure and switch Antigravity plugins independently per project",
      "enabled": true,
      "isCore": true
    }
  ],
  "profiles": {
    "__default__": { "plugins": {} }
  },
  "projects": []
}
```

### 4.1.1 Real-Time Dual-Output Event Stream (SSE)
- <b>Route</b>: <code>GET /api/events</code>
- <b>Content-Type</b>: <code>text/event-stream; charset=utf-8</code>
- <b>Description</b>: Immediately pushes the cached <code>latestDualOutputState</code> upon connection and broadcasts the exact same <code>stateData</code> JSON frame (<code>data: {...}\n\n</code>) in <code>0ms</code> whenever the built-in Sidecar updates its state, enabling zero-latency mirroring on <code>http://localhost:8088</code>.

### 4.2 Toggle Single Plugin State
- <b>Route</b>: <code>POST /api/set-plugin-state</code>
- <b>Payload</b>:
```json
{
  "projectId": "sample-project-id",
  "pluginDir": "chrome-devtools-plugin",
  "enabled": true,
  "hostActiveId": "sample-project-id"
}
```
- <b>Response</b>: <code>{ "success": true, "profiles": {}, "runtimeSynced": true }</code>

### 4.3 Reset Workspace Profile to Default
- <b>Route</b>: <code>POST /api/reset-profile</code>
- <b>Payload</b>: <code>{ "projectId": "sample-project-id" }</code>
- <b>Response</b>: <code>{ "success": true, "profiles": {} }</code>

### 4.4 Batch Update Plugin States
- <b>Route</b>: <code>POST /api/batch-set-plugin-state</code>
- <b>Payload</b>:
```json
{
  "projectIds": ["proj-1", "proj-2"],
  "pluginDir": "chrome-devtools-plugin",
  "enabled": false
}
```
- <b>Response</b>: <code>{ "success": true, "updatedCount": 2, "profiles": {} }</code>

### 4.5 Batch Reset Profiles to Default
- <b>Route</b>: <code>POST /api/batch-reset-profiles</code>
- <b>Payload</b>: <code>{ "projectIds": ["proj-1", "proj-2"] }</code>
- <b>Response</b>: <code>{ "success": true, "resetCount": 2, "profiles": {} }</code>

### 4.6 Set Localization and Persist Metadata
- <b>Route</b>: <code>POST /api/set-language</code>
- <b>Payload</b>: <code>{ "lang": "en" }</code> or <code>{ "lang": "zh" }</code>
- <b>Behavior</b>:
  - Updates <code>displayName</code> and <code>description</code> in <code>plugin.json</code>.
  - Updates <code>display_name</code> and view title in the plugin-embedded <code>sidecar.json</code>.
  - Rewrites tab title values in <code>app_storage.json</code>.
- <b>Response</b>: <code>{ "success": true, "lang": "en" }</code>

### 4.7 Restart Sidecar Container
- <b>Route</b>: <code>POST /api/restart-sidecar</code>
- <b>Description</b>: Exits the process smoothly, triggering instant reactivation by host <code>restart_policy: always</code>.
- <b>Response</b>: <code>{ "success": true, "message": "Sidecar restarting..." }</code>
