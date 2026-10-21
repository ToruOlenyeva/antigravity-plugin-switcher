[English](ARCHITECTURE.en.md) | [简体中文](ARCHITECTURE.md)

# Antigravity Plugin Switcher 架构设计文档

本文档深入阐述 Antigravity Plugin Switcher 的核心架构、四级裁决算法、双态同步流与 HTTP API 接口规范。

## 1. 核心架构与运行模型

本扩展运行于 <b>Google Antigravity 2.0</b> 桌面客户端环境（基于左侧项目与会话树 <code>projects</code>、中央对话画布以及右侧 <code>SIDECAR_UI_ENTRYPOINT_AUX_PANE</code> 辅助面板容器，区别于早期基于 VS Code 分支的传统 <code>Antigravity IDE</code>）。

Plugin Switcher 由两大协同组件构成：
- <b>Hook 路由拦截器（auto-switch.cjs）</b>：作为 Antigravity 宿主预处理 Hook，在会话生命周期事件触发时运行，拦截并分发项目环境变量。
- <b>Sidecar 常驻微服务与模块化前端（sidecars/panel/）</b>：采用原生免构建前后端物理解耦架构，通过 8088 端口与辅助栏（Auxiliary Pane）提供实时操控能力。包含后端服务（<code>main.mjs</code> 路由入口、<code>ls-bridge.mjs</code> 宿主通信、<code>scanner.mjs</code> 状态打分扫描）与前端静态套件（<code>index.html</code> 骨架、<code>styles.css</code> 主题样式、<code>i18n.js</code> 双语词典、<code>app.js</code> 交互引擎）。

### 1.1 模块化工程目录树

```
plugin-switcher/
├── assets/
│   └── logo.svg                 # 矢量品牌图标
├── docs/
│   ├── ARCHITECTURE.en.md       # 英文架构设计文档
│   └── ARCHITECTURE.md          # 中文架构设计文档
├── sidecars/
│   └── panel/                   # 原生免构建前后端物理分离 Sidecar 面板
│       ├── app.js               # 前端核心交互引擎与状态同步
│       ├── i18n.js              # 前端多语言字典与国际化引擎
│       ├── index.html           # 前端纯骨架页面
│       ├── ls-bridge.mjs        # 后端宿主 RPC 通信与状态原子化落盘
│       ├── main.mjs             # 后端 HTTP 路由入口与静态文件托管
│       ├── scanner.mjs          # 后端项目扫描与四级裁决打分引擎
│       ├── sidecar.json         # Antigravity Sidecar 容器元数据契约
│       └── styles.css           # 前端现代自适应主题样式表
├── auto-switch.cjs              # 宿主生命周期 Hook 拦截器
├── hooks.json                   # Antigravity Hook 配置文件
├── open-panel.bat               # 独立小窗快速启动脚本
├── plugin.json                  # Antigravity 插件公开元数据契约
├── project-plugin-profiles.example.json # 示例配置档案
├── README.en.md                 # 英文说明文档
└── README.md                    # 中文说明文档
```

```
+-----------------------------------------------------------+
|                   Google Antigravity 宿主                  |
|  +--------------------+        +-----------------------+  |
|  |   Native Settings  |        |    Auxiliary Pane     |  |
|  +---------+----------+        +-----------+-----------+  |
|            |                               |              |
+------------|-------------------------------|--------------+
             | 文件变更监听 (fs.watchFile)      | HTTP / Token
             v                               v
+-----------------------------------------------------------+
|               Plugin Switcher Sidecar (Port 8088)         |
|  +-----------------------------------------------------+  |
|  |                 四级项目裁决优先级算法               |  |
|  +-----------------------------------------------------+  |
|  |               双态同步引擎与 5 秒防抖锁              |  |
|  +-----------------------------------------------------+  |
|  |               SQLite 高性能直查与打分器              |  |
|  +-----------------------------------------------------+  |
+-----------------------------------------------------------+
             |                               |
             v                               v
   ~/.gemini/config/config.json    project-plugin-profiles.json
```

## 2. 四级项目裁决优先级算法

为了在复杂的宿主环境（多工作区、纯聊天会话、GCP 远程桌面、快速切标签页）中准确定位当前项目，系统实现了严密的四级裁决算法：

### 级别 1：显式参数与直达探测
Sidecar 优先提取客户端请求中携带的显式参数：
- 显式 <code>conversationId</code> 或 <code>projectId</code>。
- 携带 <code>token</code> 时，扫描 <code>app_storage.json</code> 中 <code>aux-pane-v2-session</code> 对应的会话 Tab。
- 若参数为有效的 36 位 UUID 且存在于已知项目列表中，直接完成裁决。

### 级别 2：SQLite 直查与多工作区路径打分
若显式参数缺失：
- <b>原生 SQLite 毫秒级直查</b>：利用 <code>node:sqlite</code> 直连 <code>conversation_summaries.db</code>，按最后活跃时间检索当前会话的项目映射。
- <b>最长公共路径打分协同</b>：当客户端上报 <code>workspaceUris</code> 时，遍历所有已知项目的物理路径。
  - 完全一致路径赋予最高权重（10000 分加路径字符长度）。
  - 前缀匹配子路径赋予前缀长度权重。
  - 得分最高者胜出，完美支持多目录工作区与单项目嵌套。

### 级别 3：无目录纯聊天会话智能隔离
当客户端探测到会话不包含任何工作区路径（<code>clientEmptyPaths: true</code>）：
- 系统自动判定为通用纯问答会话。
- 隔离所有代码研发类重型插件，防止不相关工具占用系统提示词上下文。

### 级别 4：全局默认配置兜底
- 若上述各级均未命中，系统自动回退至全局默认配置档案（<code>__default__</code>），确保系统永不崩溃。

## 3. 双态同步引擎、并发隔离与双输出镜像

### 3.1 后台运行项目 A 与前台切换项目 B 的「真独立」三重物理隔离机制
由于 Antigravity 宿主底层共享同一份全局 <code>~/.gemini/config/config.json</code> 与 Language Server 内存态，为了实现「<b>项目 A 在后台执行长耗时任务时，即便用户在前台切换至项目 B，后台项目 A 依然严格使用项目 A 自身的插件配置（绝不误用项目 B 的配置），同时绝不将项目 B 的预设档案污染为项目 A 的状态</b>」，系统构建了三道硬隔离防线：
1. <b>防线 1：后台任务执行瞬间的精准身份自证与秒级纠偏（<code>auto-switch.cjs</code>）</b>
   - 每当后台运行的项目 A 触发新一轮模型推理（<code>BeforeAgent</code> / <code>PreInvocation</code>）或即将调用任何工具（<code>PreToolUse</code>）时，钩子 <code>auto-switch.cjs</code> 立即拦截请求。
   - <b>严禁读取前台窗口焦点</b>：在 <code>pre-tool</code> 模式下，钩子<b>绝对禁止</b>读取 <code>app_storage.json</code> 中的前台窗口焦点（<code>projectsConversationOrder[0]</code>），而是直接从当前执行任务的 Hook Payload 中提取该任务自身的会话标识（<code>conversationId</code> / <code>transcriptPath</code> UUID）与工具目标路径（<code>TargetFile</code> / <code>cwd</code>），结合 <code>convProjectMap</code> 与 <code>conversation_summaries.db</code> 精准锁定「当前正在执行的后台任务属于项目 A」。
   - <b>执行前毫秒级刷回项目 A 配置</b>：若检测到全局 <code>config.json</code> 因用户在前台切换至项目 B 而被改写，<code>auto-switch.cjs</code> 会在项目 A 执行动作前的毫秒级瞬间，将 <code>profiles[A].plugins</code> 重新写入 <code>config.json</code> 并通过 RPC 热同步至对应 Language Server，确保后台项目 A 全程只加载自身配置。
2. <b>防线 2：单向覆盖铁律（严禁将全局配置反向抄回预设库）</b>
   - <code>auto-switch.cjs</code> 严格执行 <code>profiles[projectId] -> config.json</code> 的<b>单向应用</b>，绝对不会将 <code>config.json</code> 的内容反向写回 <code>project-plugin-profiles.json</code>，从根源阻断跨项目切换瞬间旧项目残留开关污染新项目档案。
3. <b>防线 3：配置快照比对与后台 Hook 冷却锁（<code>lastAppliedConfigSnapshot</code> + <code>lastBgHookAt</code>）</b>
   - 当后台项目 A 的钩子临时改写 <code>config.json</code> 时，会在 <code>project-plugin-profiles.json</code> 的 <code>__meta__</code> 中同步记录配置快照 <code>lastAppliedConfigSnapshot</code> 与时间戳 <code>lastBgHookAt</code>。
   - 此时前台展示项目 B 的 Sidecar 面板通过比对发现当前 <code>config.json</code> 等于 <code>lastAppliedConfigSnapshot</code>（<code>divergedFromSnapshot === false</code>），即可精准判定该变更是由后台项目 A 的钩子触发（而非用户在 Antigravity 原生设置界面手动点击），因此<b>绝不会将项目 A 的开关状态反向覆盖进项目 B 的预设档案</b>，并在前台自愈周期内将 <code>config.json</code> 恢复为项目 B 的配置。
   - 反之，仅当用户在 Antigravity 原生 Settings 界面真实手动拨动了插件开关（导致 <code>config.json</code> 与 <code>lastAppliedConfigSnapshot</code> 发生偏离 <code>divergedFromSnapshot === true</code>，且已渡过 <code>2.5s</code> 后台冷却窗），<code>scanner.mjs</code> 与 <code>main.mjs</code> 的 <code>fs.watchFile(CONFIG_FILE)</code> 才会将该次手动修改沉淀入当前活跃项目的专属档案。

### 3.2 面板「当前活跃项目 (<code>●</code>)」与「下拉框预览/编辑项目」解耦机制
- <b>绿点与下拉框物理分离</b>：
  - 绿色圆点 <code>●</code> 永远标记<b>当前 IDE 宿主所处的活跃项目</b>（<code>state.activeProjectId</code>）；
  - 下拉框选中项（<code>currentSelectedId</code>）代表<b>用户当前在面板中查看或预编辑的目标项目</b>。
- <b>跨项目预编辑不打断</b>：当宿主身处项目 B，但用户在面板下拉框中手动切换至项目 C 修改开关时：
  - 修改项目 C 的开关仅静默持久化至 <code>profiles[C]</code>（提示「已保存至该项目预设（切入该项目时自动生效）」），<b>绝不改动当前活跃项目 B 正在使用的 <code>config.json</code></b>；
  - 修改当前带绿点 <code>●</code> 的活跃项目 B（或默认配置 <code>__default__</code>）的开关时，立即写入 <code>config.json</code> 并通过 <code>ls-bridge.mjs</code> 派发 Language Server RPC 实时热重载指令（提示「已实时同步至当前活跃项目」）；
  - 后台 <code>2.5s</code> 静默心跳（<code>syncActiveProjectSilently</code>）<b>仅在宿主活跃项目发生真实物理跃变（<code>nextHostActiveId !== lastHostActiveId</code>）时</b>才自动将下拉框跟随切换至新活跃项目；宿主未切换项目时，绝不打断用户正在跨项目预览编辑的界面。

### 3.3 内置 Sidecar 与外部浏览器 <code>http://localhost:8088</code> 实时双输出镜像及后台隐藏对话防抢占
- <b>前端双观察者可见性感知（<code>ResizeObserver</code> + <code>IntersectionObserver</code>）</b>：
  - 在 Antigravity 宿主中切换已打开过的历史对话时，后台隐藏对话标签页的 Sidecar iframe 容器尺寸可能依然大于 10px 且 <code>document.hidden === false</code>。
  - 前端在 <code>isPanelActuallyVisible()</code> 中联合使用 <code>ResizeObserver</code> 与 <code>IntersectionObserver({ trackVisibility: true, delay: 100 })</code> 实时检测视口遮挡与真实可见性：当旧对话 Sidecar iframe 退入后台被遮挡或折叠时，立即冻结其 <code>2.5s</code> 定时轮询；当用户切回该对话使面板重新可见时，立即触发一次主动同步（<code>isPassive = false</code>）。
- <b>后端跨进程磁盘镜像与后台标签页拦截（<code>isBackgroundTabPassive</code>）</b>：
  - 前台可见的内置 Sidecar 每次同步时，后端 <code>scanner.mjs</code> 将解析结果实时持久化至磁盘 <code>project-plugin-profiles.json</code> 的 <code>__meta__.lastSidecarProjectId</code> 与 <code>__meta__.lastSidecarToken</code>；
  - 若后台尚未销毁的非焦点对话 iframe 发出携带旧 <code>token</code> 的被动轮询（<code>passive=1</code>），后端通过比对 <code>lastSidecarToken</code> 与 <code>app_storage.json</code> 焦点会话将其识别为 <code>isBackgroundTabPassive = true</code>，严禁其篡改 <code>lastSidecarProjectId</code>、<code>lastActiveProjectId</code> 或 <code>config.json</code>；
  - 外部浏览器访问 <code>http://localhost:8088</code>（无 <code>token</code> 参数）时，优先从磁盘读取最新的 <code>__meta__.lastSidecarProjectId</code> 进行 1:1 实时镜像展示，且其被动轮询仅做只读对齐，绝不覆写 <code>config.json</code>，确保外部浏览器打开期间后台运行中的项目 A 同样 100% 保持独立。

## 4. HTTP API 接口规范

所有接口默认由本地 <code>http://127.0.0.1:8088</code> 提供。

### 4.1 获取运行状态与项目配置
- <b>路径</b>：<code>GET /api/status</code>
- <b>查询参数</b>：
  - <code>conversationId</code>（可选）：会话唯一标识。
  - <code>projectId</code>（可选）：项目标识。
  - <code>workspaceUri</code>（可选）：工作区路径字符串或列表。
- <b>返回格式</b>：
```json
{
  "activeProjectId": "sample-project-id",
  "plugins": [
    {
      "dir": "plugin-switcher",
      "name": "plugin-switcher",
      "displayName": "项目插件独立开关管理器",
      "description": "按项目独立配置与切换 Antigravity 插件启用状态",
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

### 4.2 切换单个插件状态
- <b>路径</b>：<code>POST /api/set-plugin-state</code>
- <b>请求体</b>：
```json
{
  "projectId": "sample-project-id",
  "pluginDir": "chrome-devtools-plugin",
  "enabled": true,
  "hostActiveId": "sample-project-id"
}
```
- <b>返回格式</b>：<code>{ "success": true, "profiles": {}, "runtimeSynced": true }</code>

### 4.3 重置项目为默认配置
- <b>路径</b>：<code>POST /api/reset-profile</code>
- <b>请求体</b>：<code>{ "projectId": "sample-project-id" }</code>
- <b>返回格式</b>：<code>{ "success": true, "profiles": {} }</code>

### 4.4 批量修改多个项目插件状态
- <b>路径</b>：<code>POST /api/batch-set-plugin-state</code>
- <b>请求体</b>：
```json
{
  "projectIds": ["proj-1", "proj-2"],
  "pluginDir": "chrome-devtools-plugin",
  "enabled": false
}
```
- <b>返回格式</b>：<code>{ "success": true, "updatedCount": 2, "profiles": {} }</code>

### 4.5 批量重置项目为默认配置
- <b>路径</b>：<code>POST /api/batch-reset-profiles</code>
- <b>请求体</b>：<code>{ "projectIds": ["proj-1", "proj-2"] }</code>
- <b>返回格式</b>：<code>{ "success": true, "resetCount": 2, "profiles": {} }</code>

### 4.6 动态语言切换与外层持久化
- <b>路径</b>：<code>POST /api/set-language</code>
- <b>请求体</b>：<code>{ "lang": "en" }</code> 或 <code>{ "lang": "zh" }</code>
- <b>处理行为</b>：
  - 更新 <code>plugin.json</code> 中的 <code>displayName</code> 与 <code>description</code>。
  - 更新插件内嵌 <code>sidecar.json</code> 中的 <code>display_name</code> 与 <code>title</code>。
  - 动态重写 <code>app_storage.json</code> 中所有对应 Tab 的标题。
- <b>返回格式</b>：<code>{ "success": true, "lang": "en" }</code>

### 4.7 重启 Sidecar 容器
- <b>路径</b>：<code>POST /api/restart-sidecar</code>
- <b>说明</b>：触发微服务平滑终止，由宿主 <code>restart_policy: always</code> 毫秒级重拉。
- <b>返回格式</b>：<code>{ "success": true, "message": "Sidecar restarting..." }</code>
