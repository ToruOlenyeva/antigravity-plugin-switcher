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

To reliably determine the active project in complex host environments (multi-root workspaces, chat sessions, cloud desktops, rapid tab switching), the system implements a strict four-tier arbitration hierarchy:

### Tier 1: Explicit Parameters and Direct Probing
The Sidecar first inspects explicit parameters supplied by the client:
- Explicit <code>conversationId</code> or <code>projectId</code>.
- When <code>token</code> is provided, it scans tabs recorded under <code>aux-pane-v2-session</code> inside <code>app_storage.json</code>.
- If the identified parameter is a valid 36-character UUID belonging to registered projects, the resolution terminates immediately.

### Tier 2: SQLite Query and Multi-Root Path Scoring
If explicit parameters are missing:
- <b>Native SQLite Query</b>: Leverages <code>node:sqlite</code> to query <code>conversation_summaries.db</code> directly, resolving project bindings by the latest active timestamp.
- <b>Longest Common Path Scoring</b>: When the client reports <code>workspaceUris</code>, the algorithm evaluates each candidate project path.
  - An exact match yields the highest score (10000 points plus path string length).
  - A prefix match yields a score proportional to prefix string length.
  - The project with the highest cumulative score wins, cleanly resolving nested multi-root directories.

### Tier 3: Directory-Free Chat Session Isolation
When the client detects a session without any physical workspace paths (<code>clientEmptyPaths: true</code>):
- The session is identified as a general conversational chat.
- Heavy development plugins are automatically disabled to prevent token and context window consumption.

### Tier 4: Global Default Profile Fallback
- If all previous tiers fail to resolve a matching project, the system safely falls back to the global baseline configuration (<code>__default__</code>), ensuring uninterrupted operations.

## 3. Dual-Way Synchronization Engine and Concurrency

### 3.1 Five-Second UI Debounce Lock
To prevent background polling from rolling back optimistic state while the user is interacting with toggles:
- Any user toggle triggers an immediate optimistic update and sets a 5-second debounce lock.
- While the lock is active, background synchronization checks are suppressed until disk persistence stabilizes.

### 3.2 Dual-Way Synchronization
- <b>Branch A: Workspace Switch Overwrite</b>
  When switching projects via the dashboard or host window, the Sidecar reads target configurations, writes to <code>config.json</code>, and dispatches JSON-RPC reload signals to the host Language Server.
- <b>Branch B: Native Settings Reverse Sync</b>
  Using <code>fs.watchFile(CONFIG_FILE)</code>, the Sidecar observes configuration edits made inside the native Settings UI. Using write timestamps to prevent recursive self-updates, modifications are stored back into the active workspace profile.

### 3.3 Hidden Iframe Observer Optimization
When switching tabs in the Auxiliary Pane or collapsing the panel, the iframe container width and height drop to zero.
An internal <code>ResizeObserver</code> monitors the dashboard viewport:
- When dimensions drop to zero, background polling is paused.
- When re-expanded, an instant alignment request runs, significantly reducing idle CPU and disk activity.

## 4. HTTP API Specifications

All endpoints are hosted locally at <code>http://127.0.0.1:8088</code>.

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
