    let savedLang = null;
    try { savedLang = localStorage.getItem("plugin_switcher_lang"); } catch (e) {}
    const defaultBrowserLang = (typeof navigator !== "undefined" && typeof navigator.language === "string" && /^zh\b/i.test(navigator.language)) ? "zh" : "en";
    let currentLang = (savedLang === "en" || savedLang === "zh") ? savedLang : defaultBrowserLang;
    let state = {
      plugins: [],
      profiles: {},
      projects: []
    };
    let currentSelectedId = DEFAULT_KEY;
    let isBatchMode = false;
    let lastHostActiveId = "";
    let currentActiveWorkspaceUris = [];
    let batchSelectedProjectIds = new Set();
    let localEditedPlugins = {};
    let resetConfirmTimer = null;
    let isViewportIntersecting = true;

    function isPanelActuallyVisible() {
      if (document.hidden) return false;
      if (!isViewportIntersecting) return false;
      if (window.innerWidth <= 10 || window.innerHeight <= 10) return false;
      if (!document.body || document.body.offsetWidth <= 10 || document.body.offsetHeight <= 10) return false;
      return true;
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

    function findProjectIdByWorkspaceUris(uris, projects = []) {
      if (!uris || !projects || !projects.length) return "";
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
        for (const proj of projects) {
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

    async function handleWorkspaceSwitch(uris) {
      const uriList = (Array.isArray(uris) ? uris : [uris]).filter(Boolean);
      currentActiveWorkspaceUris = uriList;
      await syncActiveProjectSilently("", currentActiveWorkspaceUris.join("|"), false);
    }

    if (window.sidecar && typeof window.sidecar.onWorkspaceChange === "function") {
      window.sidecar.onWorkspaceChange(handleWorkspaceSwitch);
    }
    window.addEventListener("message", (event) => {
      if (event.data && event.data.type === "workspace-change") {
        const uris = event.data?.payload?.workspaceUris;
        if (Array.isArray(uris)) {
          handleWorkspaceSwitch(uris);
        }
      }
    });

    function applyI18n() {
      const t = I18N[currentLang];
      document.getElementById("uiAppTitle").textContent = t.appTitle;
      document.getElementById("uiBadge").textContent = t.badge;
      document.getElementById("refreshBtn").textContent = t.refresh;
      document.getElementById("langToggleBtn").textContent = t.langBtn;

      const batchBtn = document.getElementById("batchModeBtn");
      if (batchBtn) {
        batchBtn.textContent = isBatchMode ? t.batchModeExitBtn : t.batchModeBtn;
      }

      const resetBtn = document.getElementById("uiResetProfileBtn");
      if (resetBtn) {
        if (!resetBtn.classList.contains("confirming")) {
          resetBtn.textContent = t.resetProfileBtn;
        } else {
          resetBtn.textContent = t.confirmResetBtn;
        }
      }

      const defaultOpt = document.querySelector(`#projectSelect option[value="${DEFAULT_KEY}"]`);
      if (defaultOpt) {
        defaultOpt.textContent = t.defaultProfile;
      }

      renderCustomDropdownMenu();
      updateStatusNote();
      if (state.plugins && state.plugins.length > 0) {
        renderPluginCards();
      }
    }

    function toggleLanguage() {
      currentLang = currentLang === "zh" ? "en" : "zh";
      try {
        localStorage.setItem("plugin_switcher_lang", currentLang);
      } catch (e) {}
      applyI18n();
      fetch("/api/set-language", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lang: currentLang })
      }).catch(() => {});
      showToast(I18N[currentLang].toastLangSwitched);
    }

    function showToast(msg) {
      const el = document.getElementById("toast");
      el.textContent = msg;
      el.style.display = "block";
      setTimeout(() => { el.style.display = "none"; }, 2500);
    }

    // 智能项目配置解析器：按 uuid、物理路径及项目名三重检索
    function getProfileForProject(projId) {
      if (projId === DEFAULT_KEY) return state.profiles[DEFAULT_KEY] || null;
      if (!state.profiles) return null;

      if (state.profiles[projId]) return state.profiles[projId];

      const proj = (state.projects || []).find(p => p.id === projId);
      if (proj) {
        for (const p of (proj.paths || [])) {
          if (state.profiles[p]) return state.profiles[p];
        }
        for (const [k, v] of Object.entries(state.profiles)) {
          if (v && v.name && v.name.toLowerCase() === proj.name.toLowerCase()) {
            return v;
          }
        }
      }
      return null;
    }

    // 项目元数据解析器：100% 依据 Antigravity 原生 Project ID 穿透反查
    async function resolveActiveProjectId() {
      const convId = (window.sidecar && window.sidecar.conversationId) || (new URLSearchParams(window.location.search)).get("conversationId");
      if (convId && window.sidecar && window.sidecar.fetch) {
        try {
          const res = await window.sidecar.fetch("/_sidecar/get-conversation-metadata", {
            method: "POST",
            body: JSON.stringify({ conversationId: convId })
          });
          if (res.ok) {
            const data = await res.json();
            const meta = data?.response?.conversationMetadata?.metadata || data?.response?.conversation_metadata?.metadata;
            const pId = meta?.projectId || meta?.project_id;
            if (pId && (state.projects || []).some(p => p.id === pId)) {
              return pId;
            }
          }
        } catch (e) {}
      }
      return "";
    }

    async function safeFocusActiveProject() {
      try {
        const timeoutPromise = new Promise(resolve => setTimeout(() => resolve(""), 300));
        const activeId = await Promise.race([
          resolveActiveProjectId(),
          timeoutPromise
        ]);

        if (activeId && activeId !== currentSelectedId) {
          const select = document.getElementById("projectSelect");
          if (select && select.querySelector(`option[value="${activeId}"]`)) {
            select.value = activeId;
            currentSelectedId = activeId;
            onSelectProject();
          }
        }
      } catch (e) {}
    }

    function renderTheme(themeSettings) {
      let isDark = true;
      if (themeSettings) {
        const mode = themeSettings.themeMode || "THEME_MODE_INHERIT";
        if (mode === "THEME_MODE_DARK") {
          isDark = true;
        } else if (mode === "THEME_MODE_LIGHT") {
          isDark = false;
        } else {
          try {
            const saved = localStorage.getItem("antigravity_theme_mode");
            if (saved === "light") isDark = false;
            else if (saved === "dark") isDark = true;
            else if (window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches) isDark = false;
            else isDark = true;
          } catch (e) {
            isDark = true;
          }
        }
      }

      document.documentElement.setAttribute("data-theme", isDark ? "dark" : "light");
      try {
        localStorage.setItem("antigravity_theme_mode", isDark ? "dark" : "light");
      } catch (e) {}

      if (themeSettings) {
        const seeds = isDark ? themeSettings.customThemeSeedsDark : themeSettings.customThemeSeedsLight;
        if (seeds) {
          if (seeds.primary) document.documentElement.style.setProperty("--primary", seeds.primary);
          if (seeds.background) document.documentElement.style.setProperty("--bg-base", seeds.background);
        }
      }
    }

    // 实时监听 Antigravity 宿主推送的 theme-change 广播
    window.addEventListener("message", (event) => {
      if (event.data && event.data.type === "theme-change") {
        const payload = event.data.payload || {};
        const vars = payload.cssVariables || {};
        let isDark = true;
        let bg = vars["--background"] || vars["--bg-base"] || vars["--vscode-editor-background"] || "";
        if (bg) {
          bg = bg.trim().toLowerCase();
          if (bg.startsWith("#f") || bg.startsWith("#e") || bg.startsWith("#d") || bg === "white" || bg.startsWith("rgb(25") || bg.startsWith("rgb(24")) {
            isDark = false;
          } else {
            isDark = true;
          }
        }
        document.documentElement.setAttribute("data-theme", isDark ? "dark" : "light");
        try {
          localStorage.setItem("antigravity_theme_mode", isDark ? "dark" : "light");
        } catch (e) {}
      }
    });

    function toggleCustomDropdown(e) {
      if (e) e.stopPropagation();
      const dd = document.getElementById("customProjectDropdown");
      if (!dd) return;
      const isOpen = dd.classList.contains("open");
      if (isOpen) {
        dd.classList.remove("open");
      } else {
        renderCustomDropdownMenu();
        dd.classList.add("open");
      }
    }

    function closeCustomDropdown() {
      const dd = document.getElementById("customProjectDropdown");
      if (dd) dd.classList.remove("open");
    }

    document.addEventListener("click", (e) => {
      const dd = document.getElementById("customProjectDropdown");
      const batchBtn = document.getElementById("batchModeBtn");
      if (dd && !dd.contains(e.target) && (!batchBtn || !batchBtn.contains(e.target))) {
        dd.classList.remove("open");
      }
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeCustomDropdown();
    });

    function createDropdownOptionEl(val, labelText, isHostActive) {
      const opt = document.createElement("div");
      const isSelected = currentSelectedId === val;
      opt.className = "dropdown-option" + (isSelected ? " selected" : "");
      opt.onclick = (e) => {
        e.stopPropagation();
        closeCustomDropdown();
        const select = document.getElementById("projectSelect");
        if (select) select.value = val;
        currentSelectedId = val;
        onSelectProject();
      };

      const left = document.createElement("div");
      left.className = "dropdown-option-left";

      const checkSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      checkSvg.setAttribute("class", "dropdown-check-icon");
      checkSvg.setAttribute("viewBox", "0 0 20 20");
      checkSvg.setAttribute("fill", "none");
      checkSvg.setAttribute("stroke", "currentColor");
      checkSvg.setAttribute("stroke-width", "2.4");
      checkSvg.setAttribute("stroke-linecap", "round");
      checkSvg.setAttribute("stroke-linejoin", "round");
      const poly = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
      poly.setAttribute("points", "4 10 8 14 16 6");
      checkSvg.appendChild(poly);

      const span = document.createElement("span");
      span.className = "dropdown-option-label";
      span.textContent = labelText;

      left.appendChild(checkSvg);
      left.appendChild(span);
      opt.appendChild(left);

      if (isHostActive) {
        const dot = document.createElement("span");
        dot.className = "dropdown-active-dot";
        dot.title = currentLang === "zh" ? "当前活跃项目" : "Current Active Project";
        opt.appendChild(dot);
      }

      return opt;
    }

    function createBatchSelectAllOptionEl(validProjects) {
      const t = I18N[currentLang];
      const count = batchSelectedProjectIds.size;
      const isAllSelected = validProjects.length > 0 && count === validProjects.length;
      const isIndeterminate = count > 0 && count < validProjects.length;

      const opt = document.createElement("div");
      opt.className = "dropdown-option batch-select-all" + (isAllSelected ? " selected" : "");
      opt.onclick = (e) => {
        e.stopPropagation();
        if (isAllSelected) {
          batchSelectedProjectIds.clear();
        } else {
          for (const p of validProjects) batchSelectedProjectIds.add(p.id);
        }
        renderCustomDropdownMenu();
      };

      const left = document.createElement("div");
      left.className = "dropdown-option-left";

      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.className = "dropdown-checkbox";
      cb.checked = isAllSelected;
      cb.indeterminate = isIndeterminate;

      const span = document.createElement("span");
      span.className = "dropdown-option-label";
      span.textContent = t.batchSelectAll;

      left.appendChild(cb);
      left.appendChild(span);
      opt.appendChild(left);

      const badge = document.createElement("span");
      badge.className = "dropdown-batch-badge";
      badge.textContent = t.batchSelectedCount.replace("{count}", count);
      opt.appendChild(badge);

      return opt;
    }

    function createBatchProjectOptionEl(proj, isHostActive) {
      const isChecked = batchSelectedProjectIds.has(proj.id);
      const opt = document.createElement("div");
      opt.className = "dropdown-option" + (isChecked ? " selected" : "");
      opt.onclick = (e) => {
        e.stopPropagation();
        if (batchSelectedProjectIds.has(proj.id)) {
          batchSelectedProjectIds.delete(proj.id);
        } else {
          batchSelectedProjectIds.add(proj.id);
        }
        renderCustomDropdownMenu();
      };

      const left = document.createElement("div");
      left.className = "dropdown-option-left";

      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.className = "dropdown-checkbox";
      cb.checked = isChecked;

      const span = document.createElement("span");
      span.className = "dropdown-option-label";
      span.textContent = proj.name;

      left.appendChild(cb);
      left.appendChild(span);
      opt.appendChild(left);

      if (isHostActive) {
        const dot = document.createElement("span");
        dot.className = "dropdown-active-dot";
        dot.title = currentLang === "zh" ? "当前活跃项目" : "Current Active Project";
        opt.appendChild(dot);
      }

      return opt;
    }

    function renderCustomDropdownMenu() {
      const menu = document.getElementById("customDropdownMenu");
      const labelEl = document.getElementById("dropdownSelectedLabel");
      if (!menu || !labelEl) return;

      const t = I18N[currentLang];
      const projects = state.projects || [];
      const validProjects = projects.filter(p => p && p.id && p.id !== DEFAULT_KEY);

      if (isBatchMode) {
        // 批量模式：触发器显示已选数量摘要，下拉首行显示“全选”，分割线下方每个项目带复选框
        const count = batchSelectedProjectIds.size;
        labelEl.innerHTML = "";
        const textNode = document.createElement("span");
        textNode.style.overflow = "hidden";
        textNode.style.textOverflow = "ellipsis";
        textNode.style.whiteSpace = "nowrap";
        textNode.style.color = "var(--primary)";
        textNode.style.fontWeight = "600";
        textNode.textContent = t.batchSelectedCount.replace("{count}", count);
        labelEl.appendChild(textNode);

        menu.innerHTML = "";
        menu.appendChild(createBatchSelectAllOptionEl(validProjects));

        if (validProjects.length > 0) {
          const divider = document.createElement("div");
          divider.className = "dropdown-divider";
          menu.appendChild(divider);

          for (const proj of validProjects) {
            menu.appendChild(createBatchProjectOptionEl(proj, proj.id === state.activeProjectId));
          }
        }
        return;
      }

      // 常规单选模式：更新触发按钮显示文本
      let currentLabel = t.defaultProfile;
      let isCurrentActive = false;
      if (currentSelectedId !== DEFAULT_KEY) {
        const found = projects.find(p => p.id === currentSelectedId);
        if (found) {
          currentLabel = found.name;
          isCurrentActive = (found.id === state.activeProjectId);
        }
      }
      labelEl.innerHTML = "";
      const textNode = document.createElement("span");
      textNode.style.overflow = "hidden";
      textNode.style.textOverflow = "ellipsis";
      textNode.style.whiteSpace = "nowrap";
      textNode.textContent = currentLabel;
      labelEl.appendChild(textNode);
      if (isCurrentActive) {
        const dot = document.createElement("span");
        dot.className = "dropdown-active-dot";
        labelEl.appendChild(dot);
      }

      // 构建常规单选下拉菜单项
      menu.innerHTML = "";
      menu.appendChild(createDropdownOptionEl(DEFAULT_KEY, t.defaultProfile, false));

      if (projects.length > 0) {
        const divider = document.createElement("div");
        divider.className = "dropdown-divider";
        menu.appendChild(divider);

        for (const proj of projects) {
          menu.appendChild(createDropdownOptionEl(proj.id, proj.name, proj.id === state.activeProjectId));
        }
      }
    }

    function populateProjectDropdown() {
      const select = document.getElementById("projectSelect");
      select.innerHTML = "";

      // 1. 默认配置（首位）
      const defaultOpt = document.createElement("option");
      defaultOpt.value = DEFAULT_KEY;
      defaultOpt.textContent = I18N[currentLang].defaultProfile;
      select.appendChild(defaultOpt);

      // 2. 严格按侧边栏拖拽顺序呈现全部有效项目
      const projects = state.projects || [];
      for (const proj of projects) {
        const opt = document.createElement("option");
        opt.value = proj.id;
        opt.textContent = proj.name;
        select.appendChild(opt);
      }

      renderCustomDropdownMenu();
    }

    function updateBatchModeUI() {
      const batchBtn = document.getElementById("batchModeBtn");
      const t = I18N[currentLang];

      if (batchBtn) {
        if (isBatchMode) {
          batchBtn.classList.add("active-batch");
          batchBtn.textContent = t.batchModeExitBtn;
        } else {
          batchBtn.classList.remove("active-batch");
          batchBtn.textContent = t.batchModeBtn;
        }
      }

      if (isBatchMode) {
        const validProjects = (state.projects || []).filter(p => p && p.id && p.id !== DEFAULT_KEY);
        if (batchSelectedProjectIds.size === 0) {
          if (currentSelectedId && currentSelectedId !== DEFAULT_KEY && validProjects.some(p => p.id === currentSelectedId)) {
            batchSelectedProjectIds.add(currentSelectedId);
          } else if (lastHostActiveId && validProjects.some(p => p.id === lastHostActiveId)) {
            batchSelectedProjectIds.add(lastHostActiveId);
          } else {
            for (const p of validProjects) batchSelectedProjectIds.add(p.id);
          }
        }
      }

      renderCustomDropdownMenu();
      updateResetBtnVisibility();
      updateStatusNote();
    }

    function toggleBatchMode(e) {
      if (e) e.stopPropagation();
      clearResetConfirm();
      isBatchMode = !isBatchMode;
      updateBatchModeUI();
      const dd = document.getElementById("customProjectDropdown");
      if (isBatchMode) {
        if (dd) dd.classList.add("open");
      } else {
        if (dd) dd.classList.remove("open");
        onSelectProject();
      }
    }

    function checkIsSameAsDefault(plugins) {
      if (!state.profiles || !state.profiles[DEFAULT_KEY]) return true;
      const defaultPlugins = state.profiles[DEFAULT_KEY].plugins || {};
      for (const p of (state.plugins || [])) {
        if (p.protected) continue;
        const defVal = defaultPlugins[p.dir] !== undefined ? Boolean(defaultPlugins[p.dir]) : Boolean(p.enabled);
        const curVal = plugins[p.dir] !== undefined ? Boolean(plugins[p.dir]) : Boolean(p.enabled);
        if (defVal !== curVal) {
          return false;
        }
      }
      return true;
    }

    function updateResetBtnVisibility() {
      const resetBtn = document.getElementById("uiResetProfileBtn");
      if (!resetBtn) return;
      if (isBatchMode) {
        resetBtn.style.display = "inline-flex";
        return;
      }
      if (currentSelectedId === DEFAULT_KEY) {
        resetBtn.style.display = "none";
        return;
      }
      const isSame = checkIsSameAsDefault(localEditedPlugins);
      resetBtn.style.display = isSame ? "none" : "inline-flex";
    }

    function updateStatusNote() {
      const noteEl = document.getElementById("projectStatusNote");
      const t = I18N[currentLang];

      if (isBatchMode) {
        noteEl.textContent = t.batchHint;
      } else if (currentSelectedId === DEFAULT_KEY) {
        noteEl.textContent = t.noteDefault;
      } else {
        const isSame = checkIsSameAsDefault(localEditedPlugins);
        if (isSame) {
          noteEl.textContent = t.noteInherited;
        } else {
          noteEl.textContent = t.noteCustomized;
        }
      }
    }

    function onSelectProject() {
      clearResetConfirm();
      const select = document.getElementById("projectSelect");
      currentSelectedId = select.value || DEFAULT_KEY;

      // 当用户在下拉框主动选择某个项目或默认配置时，自动退出批量模式，恢复常规单项目视图
      if (isBatchMode) {
        isBatchMode = false;
        updateBatchModeUI();
      }

      renderCustomDropdownMenu();

      const customProfile = getProfileForProject(currentSelectedId);
      let sourcePlugins = {};
      if (currentSelectedId === DEFAULT_KEY) {
        sourcePlugins = (state.profiles[DEFAULT_KEY] && state.profiles[DEFAULT_KEY].plugins) || {};
      } else if (customProfile && customProfile.plugins) {
        sourcePlugins = customProfile.plugins;
      } else if (currentSelectedId === state.activeProjectId) {
        sourcePlugins = {};
        for (const p of (state.plugins || [])) {
          sourcePlugins[p.dir] = p.enabled;
        }
      } else {
        sourcePlugins = (state.profiles[DEFAULT_KEY] && state.profiles[DEFAULT_KEY].plugins) || {};
      }

      localEditedPlugins = {};
      for (const p of state.plugins) {
        if (sourcePlugins[p.dir] !== undefined) {
          localEditedPlugins[p.dir] = Boolean(sourcePlugins[p.dir]);
        } else {
          localEditedPlugins[p.dir] = p.enabled;
        }
      }

      updateResetBtnVisibility();
      updateStatusNote();
      renderPluginCards();
    }

    function createPluginIconEl(p, displayTitle) {
      const wrap = document.createElement("div");
      wrap.className = "plugin-icon-wrap";

      const fallbackColors = [
        "#5c6bc0", "#26a69a", "#42a5f5", "#ab47bc",
        "#ec407a", "#ffa726", "#66bb6a", "#78909c"
      ];
      let hash = 0;
      const str = p.dir || "";
      for (let i = 0; i < str.length; i++) {
        hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
      }
      const bg = fallbackColors[hash % fallbackColors.length];

      const fallback = document.createElement("div");
      fallback.className = "plugin-icon-fallback";
      fallback.style.background = bg;
      const firstChar = (displayTitle || p.displayName || p.name || p.dir || "?").trim().charAt(0);
      fallback.textContent = firstChar;

      if (p.logoUrl) {
        const img = document.createElement("img");
        img.className = "plugin-icon-img";
        img.src = p.logoUrl;
        img.alt = p.displayName || p.name || p.dir;
        img.loading = "lazy";
        img.onerror = () => {
          img.remove();
          wrap.appendChild(fallback);
        };
        wrap.appendChild(img);
      } else {
        wrap.appendChild(fallback);
      }

      return wrap;
    }

    function renderPluginCards() {
      const container = document.getElementById("pluginList");
      container.innerHTML = "";
      const t = I18N[currentLang];

      for (const p of state.plugins) {
        const card = document.createElement("div");
        card.className = "plugin-card" + (localEditedPlugins[p.dir] ? "" : " disabled");

        const info = document.createElement("div");
        info.className = "plugin-info";

        const titleRow = document.createElement("div");
        titleRow.className = "plugin-title-row";

        const title = document.createElement("span");
        title.className = "plugin-title";
        if (p.dir === "plugin-switcher") {
          title.textContent = t.selfPluginTitle;
        } else {
          title.textContent = p.displayName || p.name;
        }
        titleRow.appendChild(title);

        const dirTag = document.createElement("span");
        dirTag.className = "plugin-dir";
        dirTag.textContent = p.dir;
        titleRow.appendChild(dirTag);

        if (p.protected) {
          const coreTag = document.createElement("span");
          coreTag.className = "badge";
          coreTag.textContent = t.coreBadge;
          titleRow.appendChild(coreTag);
        }

        info.appendChild(titleRow);

        const desc = document.createElement("div");
        desc.className = "plugin-desc";
        if (p.dir === "plugin-switcher") {
          desc.textContent = t.selfPluginDesc;
        } else {
          desc.textContent = p.description;
        }
        info.appendChild(desc);

        const iconEl = createPluginIconEl(p, title.textContent);
        card.appendChild(iconEl);
        card.appendChild(info);

        const switchLabel = document.createElement("label");
        switchLabel.className = "switch";

        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.checked = Boolean(localEditedPlugins[p.dir]);
        checkbox.disabled = p.protected;

        checkbox.onchange = async () => {
          const nextVal = checkbox.checked;
          const urlParams = new URLSearchParams(window.location.search);
          const convId = (window.sidecar && window.sidecar.conversationId) || urlParams.get("conversationId") || "";

          // 批量模式分支
          if (isBatchMode) {
            if (batchSelectedProjectIds.size === 0) {
              showToast(I18N[currentLang].toastSelectBatchFirst);
              checkbox.checked = !nextVal;
              return;
            }

            localEditedPlugins[p.dir] = nextVal;
            if (nextVal) card.classList.remove("disabled");
            else card.classList.add("disabled");

            try {
              const res = await fetch("/api/batch-set-plugin-state", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  projectIds: Array.from(batchSelectedProjectIds),
                  pluginDir: p.dir,
                  enabled: nextVal,
                  hostActiveId: lastHostActiveId,
                  conversationId: convId
                })
              });

              if (!res.ok) {
                const textErr = await res.text();
                throw new Error(`${I18N[currentLang].serverError || "Server error"} (${res.status}): ${textErr}`);
              }

              const data = await res.json();
              if (data.success) {
                state.profiles = data.profiles;
                updateResetBtnVisibility();
                updateStatusNote();

                const count = data.updatedCount || batchSelectedProjectIds.size;
                if (data.runtimeSynced) {
                  showToast(I18N[currentLang].toastBatchSynced.replace("{count}", count));
                } else {
                  showToast(I18N[currentLang].toastBatchSaved.replace("{count}", count));
                }
              } else {
                showToast(I18N[currentLang].errorModify + (data.error || I18N[currentLang].unknownError || "Unknown error"));
                checkbox.checked = !nextVal;
                localEditedPlugins[p.dir] = !nextVal;
                if (!nextVal) card.classList.remove("disabled");
                else card.classList.add("disabled");
                updateResetBtnVisibility();
                updateStatusNote();
              }
            } catch (err) {
              showToast(I18N[currentLang].errorRequest + err.message);
              checkbox.checked = !nextVal;
              localEditedPlugins[p.dir] = !nextVal;
              if (!nextVal) card.classList.remove("disabled");
              else card.classList.add("disabled");
              updateResetBtnVisibility();
              updateStatusNote();
            }
            return;
          }

          // 单项目模式
          localEditedPlugins[p.dir] = nextVal;
          if (nextVal) {
            card.classList.remove("disabled");
          } else {
            card.classList.add("disabled");
          }

          // 核心：拨动开关后秒级刷新「恢复默认」按钮显隐与状态说明
          updateResetBtnVisibility();
          updateStatusNote();

          try {
            const res = await fetch("/api/set-plugin-state", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                projectId: currentSelectedId,
                pluginDir: p.dir,
                enabled: nextVal,
                hostActiveId: lastHostActiveId,
                conversationId: convId
              })
            });

            if (!res.ok) {
              const textErr = await res.text();
              throw new Error(`${I18N[currentLang].serverError || "Server error"} (${res.status}): ${textErr}`);
            }

            const data = await res.json();
            if (data.success) {
              state.profiles = data.profiles;
              updateResetBtnVisibility();
              updateStatusNote();

              if (data.runtimeSynced) {
                showToast(I18N[currentLang].toastRuntimeSynced);
              } else {
                showToast(I18N[currentLang].toastProfileSaved);
              }
            } else {
              showToast((I18N[currentLang].errorModify || "修改失败: ") + (data.error || I18N[currentLang].unknownError || "Unknown error"));
              checkbox.checked = !nextVal;
              localEditedPlugins[p.dir] = !nextVal;
              if (!nextVal) card.classList.remove("disabled");
              else card.classList.add("disabled");
              updateResetBtnVisibility();
              updateStatusNote();
            }
          } catch (err) {
            showToast((I18N[currentLang].errorRequest || "请求失败: ") + err.message);
            checkbox.checked = !nextVal;
            localEditedPlugins[p.dir] = !nextVal;
            if (!nextVal) card.classList.remove("disabled");
            else card.classList.add("disabled");
            updateResetBtnVisibility();
            updateStatusNote();
          }
        };

        const slider = document.createElement("span");
        slider.className = "slider";

        switchLabel.appendChild(checkbox);
        switchLabel.appendChild(slider);
        card.appendChild(switchLabel);

        container.appendChild(card);
      }
    }

    function clearResetConfirm() {
      if (resetConfirmTimer) {
        clearTimeout(resetConfirmTimer);
        resetConfirmTimer = null;
      }
      const resetBtn = document.getElementById("uiResetProfileBtn");
      if (resetBtn) {
        resetBtn.classList.remove("confirming");
        resetBtn.textContent = I18N[currentLang].resetProfileBtn;
      }
    }

    async function resetCurrentProfile() {
      if (!isBatchMode && currentSelectedId === DEFAULT_KEY) return;
      const resetBtn = document.getElementById("uiResetProfileBtn");

      if (!resetBtn.classList.contains("confirming")) {
        resetBtn.classList.add("confirming");
        resetBtn.textContent = I18N[currentLang].confirmResetBtn;

        resetConfirmTimer = setTimeout(() => {
          clearResetConfirm();
        }, 4000);
        return;
      }

      clearResetConfirm();
      const urlParams = new URLSearchParams(window.location.search);
      const convId = (window.sidecar && window.sidecar.conversationId) || urlParams.get("conversationId") || "";

      // 批量重置分支
      if (isBatchMode) {
        if (batchSelectedProjectIds.size === 0) {
          showToast(I18N[currentLang].toastSelectBatchFirst);
          return;
        }

        try {
          const res = await fetch("/api/batch-reset-profiles", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              projectIds: Array.from(batchSelectedProjectIds),
              hostActiveId: lastHostActiveId,
              conversationId: convId
            })
          });

          if (!res.ok) {
            const textErr = await res.text();
            throw new Error(`${I18N[currentLang].serverError || "Server error"} (${res.status}): ${textErr}`);
          }

          const data = await res.json();
          if (data.success) {
            state.profiles = data.profiles;
            const defaultPlugins = (state.profiles[DEFAULT_KEY] && state.profiles[DEFAULT_KEY].plugins) || {};
            for (const p of state.plugins) {
              localEditedPlugins[p.dir] = defaultPlugins[p.dir] !== undefined ? Boolean(defaultPlugins[p.dir]) : p.enabled;
            }
            const count = data.resetCount || batchSelectedProjectIds.size;
            showToast(I18N[currentLang].toastBatchReset.replace("{count}", count));
            updateResetBtnVisibility();
            updateStatusNote();
            renderPluginCards();
          } else {
            showToast((I18N[currentLang].errorReset || "重置失败: ") + (data.error || I18N[currentLang].unknownError || "Unknown error"));
          }
        } catch (err) {
          showToast((I18N[currentLang].errorRequest || "请求失败: ") + err.message);
        }
        return;
      }

      try {
        const res = await fetch("/api/reset-profile", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            projectId: currentSelectedId,
            hostActiveId: lastHostActiveId,
            conversationId: convId
          })
        });

        if (!res.ok) {
          const textErr = await res.text();
          throw new Error(`${I18N[currentLang].serverError || "Server error"} (${res.status}): ${textErr}`);
        }

        const data = await res.json();
        if (data.success) {
          state.profiles = data.profiles;
          // 重新照抄默认配置赋予当前项目本地状态
          const defaultPlugins = (state.profiles[DEFAULT_KEY] && state.profiles[DEFAULT_KEY].plugins) || {};
          for (const p of state.plugins) {
            localEditedPlugins[p.dir] = defaultPlugins[p.dir] !== undefined ? Boolean(defaultPlugins[p.dir]) : p.enabled;
          }
          showToast(I18N[currentLang].toastReset);
          updateResetBtnVisibility();
          updateStatusNote();
          renderPluginCards();
        }
      } catch (err) {
        showToast((I18N[currentLang].errorReset || "重置失败: ") + err.message);
      }
    }

    let isSyncing = false;
    async function syncActiveProjectSilently(explicitProjectId = "", explicitWorkspaceUri = "", isPassive = false) {
      const hasExplicitPush = Boolean(explicitProjectId || explicitWorkspaceUri);
      if (!hasExplicitPush && !isPanelActuallyVisible()) return;
      if (isSyncing) return;
      isSyncing = true;
      try {
        const urlParams = new URLSearchParams(window.location.search);
        const convId = (window.sidecar && window.sidecar.conversationId) || urlParams.get("conversationId") || "";
        const token = urlParams.get("token") || (window.sidecar && window.sidecar.token) || "";
        const pId = typeof explicitProjectId === "string" ? explicitProjectId : "";
        const wsUri = typeof explicitWorkspaceUri === "string" && explicitWorkspaceUri ? explicitWorkspaceUri : currentActiveWorkspaceUris.join("|");

        let statusUrl = "/api/status";
        const queryParts = [];
        if (convId) queryParts.push(`conversationId=${encodeURIComponent(convId)}`);
        if (pId) queryParts.push(`projectId=${encodeURIComponent(pId)}`);
        if (wsUri) queryParts.push(`workspaceUri=${encodeURIComponent(wsUri)}`);
        if (token) queryParts.push(`token=${encodeURIComponent(token)}`);
        if (isPassive) queryParts.push("passive=1");
        if (queryParts.length > 0) statusUrl += `?${queryParts.join("&")}`;

        const res = await fetch(statusUrl);
        if (!res.ok) return;
        const latestState = await res.json();

        state.projects = latestState.projects || state.projects;
        state.profiles = latestState.profiles || state.profiles;
        state.plugins = latestState.plugins || state.plugins;
        state.activeProjectId = latestState.activeProjectId || state.activeProjectId;

        const nextHostActiveId = latestState.activeProjectId;
        // 核心门禁：仅当宿主真实发生跨项目切换（hostActiveId 物理跃变）时，才触发自动聚焦与自动热加载！
        if (nextHostActiveId && nextHostActiveId !== lastHostActiveId) {
          lastHostActiveId = nextHostActiveId;
          const select = document.getElementById("projectSelect");
          if (select && select.querySelector(`option[value="${nextHostActiveId}"]`)) {
            select.value = nextHostActiveId;
            currentSelectedId = nextHostActiveId;
            onSelectProject();
            showToast(I18N[currentLang].toastAutoApplied);
          }
        } else if (!isBatchMode && currentSelectedId === latestState.activeProjectId) {
          // 核心双向感知：当宿主未切换项目，但用户在软件原生设置中拨动了开关时，实时同步更新面板开关！
          let hasDiff = false;
          for (const p of (latestState.plugins || [])) {
            if (localEditedPlugins[p.dir] !== p.enabled) {
              hasDiff = true;
              localEditedPlugins[p.dir] = p.enabled;
            }
          }
          if (hasDiff) {
            updateResetBtnVisibility();
            updateStatusNote();
            renderPluginCards();
          }
        }
      } catch (e) {
      } finally {
        isSyncing = false;
      }
    }

    function handleVisibilityChange() {
      if (!document.hidden && isPanelActuallyVisible()) {
        syncActiveProjectSilently("", "", false);
      }
    }

    async function handleManualRefresh() {
      const refreshBtn = document.getElementById("refreshBtn");
      if (refreshBtn) {
        refreshBtn.style.opacity = "0.5";
        refreshBtn.style.pointerEvents = "none";
      }
      try {
        await initApp(true);
        showToast(I18N[currentLang].refreshSuccess);
      } finally {
        if (refreshBtn) {
          refreshBtn.style.opacity = "1";
          refreshBtn.style.pointerEvents = "auto";
        }
      }
    }

    async function initApp(isManualRefresh = false) {
      applyI18n();
      try {
        if (window.sidecar && typeof window.sidecar.getWorkspaceUris === "function") {
          try {
            const uris = await window.sidecar.getWorkspaceUris();
            if (Array.isArray(uris) && uris.length > 0) {
              currentActiveWorkspaceUris = uris.filter(Boolean);
            } else {
              currentActiveWorkspaceUris = [];
            }
          } catch (e) {}
        }

        const urlParams = new URLSearchParams(window.location.search);
        const convId = (window.sidecar && window.sidecar.conversationId) || urlParams.get("conversationId") || "";
        const token = urlParams.get("token") || (window.sidecar && window.sidecar.token) || "";
        let statusUrl = "/api/status";
        const queryParts = [];
        if (convId) queryParts.push(`conversationId=${encodeURIComponent(convId)}`);
        if (currentActiveWorkspaceUris.length > 0) queryParts.push(`workspaceUri=${encodeURIComponent(currentActiveWorkspaceUris.join("|"))}`);
        if (token) queryParts.push(`token=${encodeURIComponent(token)}`);
        if (queryParts.length > 0) statusUrl += `?${queryParts.join("&")}`;

        const res = await fetch(statusUrl);
        state = await res.json();
        renderTheme(state.themeSettings);
        populateProjectDropdown();

        // 记录宿主当前所处的真实项目
        if (state.activeProjectId) {
          lastHostActiveId = state.activeProjectId;
        }

        // 仅在首次初始化或手动点击刷新时，聚焦并锁定当前宿主项目
        if (state.activeProjectId && (state.projects || []).some(p => p.id === state.activeProjectId)) {
          const select = document.getElementById("projectSelect");
          if (select) select.value = state.activeProjectId;
          currentSelectedId = state.activeProjectId;
        }

        // 即时渲染卡片
        onSelectProject();

        // 挂载事件监听器与轻量安全心跳（跃变门禁守门：真切项目瞬间联动，编辑其他项目绝对不打断）
        if (!window.__listenersBound) {
          window.__listenersBound = true;
          window.addEventListener("focus", () => syncActiveProjectSilently("", "", false));
          document.addEventListener("visibilitychange", handleVisibilityChange);
          document.addEventListener("pointerenter", () => syncActiveProjectSilently("", "", false));

          let wasPanelVisible = isPanelActuallyVisible();
          const checkVisibilityTransition = () => {
            const isNowVisible = isPanelActuallyVisible();
            if (isNowVisible && !wasPanelVisible) {
              wasPanelVisible = true;
              lastHostActiveId = ""; // 强制对齐当前可见面板所属的项目
              syncActiveProjectSilently("", currentActiveWorkspaceUris.join("|"), false);
            } else {
              wasPanelVisible = isNowVisible;
            }
          };

          if (window.ResizeObserver) {
            const ro = new ResizeObserver(checkVisibilityTransition);
            ro.observe(document.documentElement);
          }

          if (window.IntersectionObserver) {
            let io;
            try {
              io = new IntersectionObserver((entries) => {
                for (const entry of entries) {
                  const visible = entry.isIntersecting && entry.intersectionRatio > 0 && (entry.isVisible !== false);
                  isViewportIntersecting = visible;
                }
                checkVisibilityTransition();
              }, { threshold: [0, 0.01, 0.1], trackVisibility: true, delay: 100 });
            } catch (e) {
              io = new IntersectionObserver((entries) => {
                for (const entry of entries) {
                  isViewportIntersecting = entry.isIntersecting && entry.intersectionRatio > 0;
                }
                checkVisibilityTransition();
              }, { threshold: [0, 0.01, 0.1] });
            }
            if (document.body) io.observe(document.body);
            else io.observe(document.documentElement);
          }
        }

        if (!window.__syncTimer) {
          window.__syncTimer = setInterval(() => syncActiveProjectSilently("", "", true), 2500);
        }
      } catch (err) {
        document.getElementById("uiLoadingText").textContent = (I18N[currentLang].loadFailed || I18N[currentLang].errorLoad || "Failed to load: ") + err.message;
      }
    }

    window.addEventListener("DOMContentLoaded", initApp);
