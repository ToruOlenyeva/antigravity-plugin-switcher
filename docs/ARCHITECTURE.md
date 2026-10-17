[English](ARCHITECTURE.en.md) | [简体中文](ARCHITECTURE.md)

# Antigravity Plugin Switcher 架构设计文档

本文档深入阐述 Antigravity Plugin Switcher 的核心架构、四级裁决算法、双态同步流与 HTTP API 接口规范。

## 1. 核心架构与运行模型

本扩展运行于 <b>Google Antigravity 2.0</b> 桌面客户端环境（基于左侧项目与会话树 <code>projects</code>、中央对话画布以及右侧 <code>SIDECAR_UI_ENTRYPOINT_AUX_PANE</code> 辅助面板容器，区别于早期基于 VS Code 分支的传统 <code>Antigravity IDE</code>）。

Plugin Switcher 由两大协同组件构成：
- <b>Hook 路由拦截器（auto-switch.cjs）</b>：作为 Antigravity 宿主预处理 Hook，在会话生命周期事件触发时运行，拦截并分发项目环境变量。
- <b>Sidecar 常驻服务（main.mjs + index.html）</b>：作为独立 Node.js 常驻微服务与可视化前端，通过 8088 端口与辅助栏（Auxiliary Pane）提供实时操控能力。

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

## 3. 双态同步引擎与并发安全

### 3.1 5 秒面板防抖锁
为了杜绝用户在前端面板拨动开关时，后台静默轮询覆盖用户正在编辑的中间态：
- 用户触发任何拨动操作后，前端即刻激活本地乐观更新，并启动 5 秒防抖时钟。
- 防抖期内，所有外部静默同步回调被严格阻断，待状态完全稳态写盘后恢复监听。

### 3.2 双态同步（双向感知）
- <b>分支 A：跨项目切换覆写</b>
  用户在面板切换目标项目或宿主聚焦新项目时，Sidecar 读取目标档案，写入 <code>config.json</code>，并通过内部通道向宿主 Language Server 派发 JSON-RPC 热更新指令。
- <b>分支 B：原生设置反向同步</b>
  通过 <code>fs.watchFile(CONFIG_FILE)</code> 毫秒级监听宿主原生设置界面的手工变更。结合内部写入时间戳比对（防自循环），将变动精准沉淀回当前活跃项目的专属档案中。

### 3.3 后台隐藏 Iframe 观察者防抢占机制
在 Antigravity 辅助栏中，当用户切换至终端、文件树或折叠辅助栏时，Iframe 容器的尺寸将降为 0。
前端内置 <code>ResizeObserver</code> 监听宿主视口：
- 当检测到宽度或高度为 0 时，自动冻结所有非必要的高频轮询。
- 重新展开至可见时，执行一次精准拉取对齐，大幅度节约系统算力与磁盘 I/O。

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
  - 更新本地及全局 <code>sidecar.json</code> 中的 <code>display_name</code> 与 <code>title</code>。
  - 动态重写 <code>app_storage.json</code> 中所有对应 Tab 的标题。
- <b>返回格式</b>：<code>{ "success": true, "lang": "en" }</code>

### 4.7 重启 Sidecar 容器
- <b>路径</b>：<code>POST /api/restart-sidecar</code>
- <b>说明</b>：触发微服务平滑终止，由宿主 <code>restart_policy: always</code> 毫秒级重拉。
- <b>返回格式</b>：<code>{ "success": true, "message": "Sidecar restarting..." }</code>
