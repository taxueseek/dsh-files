window.__ModuleLoader__.load({ id: "dsh-files", factory: (require) => { var module = { exports: {} }; var exports = module.exports;
"use strict";
(() => {
  var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
    get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
  }) : x)(function(x) {
    if (typeof require !== "undefined") return require.apply(this, arguments);
    throw Error('Dynamic require of "' + x + '" is not supported');
  });

  // src/client/index.tsx
  var import_react = __require("react");
  var import_dsh_client_ui_primitives = __require("@deepseek-ai/dsh-client-ui-primitives");
  var import_jsx_runtime = __require("react/jsx-runtime");
  var SOURCE_NAME = "dsh-files";
  var STYLE_TAG = "dsh-files/style.css";
  var UPLOAD_CONCURRENCY = 4;
  var uploadMeta = /* @__PURE__ */ new Map();
  var uploadedPool = /* @__PURE__ */ new Map();
  var currentSessionId = "";
  var WORKSPACE_CACHE_MS = 3e4;
  var workspaceCache = null;
  async function fetchWorkspaceFiles() {
    if (currentSessionId === "") return [];
    const now = Date.now();
    if (workspaceCache !== null && workspaceCache.sessionId === currentSessionId && now - workspaceCache.at < WORKSPACE_CACHE_MS) {
      return workspaceCache.files;
    }
    try {
      const res = await fetch(`/api/workspace-files?session=${encodeURIComponent(currentSessionId)}`, {
        headers: { accept: "application/json" }
      });
      if (!res.ok) return [];
      const payload = await res.json();
      const files = Array.isArray(payload.files) ? payload.files.map((rel) => ({ rel, name: nameFromPath(rel) })) : [];
      workspaceCache = { sessionId: currentSessionId, files, at: now };
      return files;
    } catch {
      return [];
    }
  }
  var uploadError = null;
  var errorSeq = 0;
  var errorListeners = /* @__PURE__ */ new Set();
  function subscribeErrors(listener) {
    errorListeners.add(listener);
    return () => {
      errorListeners.delete(listener);
    };
  }
  function setUploadError(text) {
    uploadError = { seq: ++errorSeq, text };
    for (const listener of errorListeners) listener();
  }
  function clearUploadError() {
    uploadError = null;
    for (const listener of errorListeners) listener();
  }
  function badgeStyle(name, sniffed) {
    if (sniffed === "pdf") return { bg: "#C93B2E", ext: "PDF" };
    if (sniffed === "docx") return { bg: "#2B579A", ext: "DOC" };
    if (sniffed === "xlsx") return { bg: "#217346", ext: "XLS" };
    if (sniffed === "text") return { bg: "#757575", ext: "TXT" };
    if (sniffed === null) return { bg: "#5B7DB1", ext: "FILE" };
    const ext = name.slice(name.lastIndexOf(".") + 1).toUpperCase().slice(0, 4);
    const lower = ext.toLowerCase();
    if (lower === "pdf") return { bg: "#C93B2E", ext: "PDF" };
    if (lower === "docx" || lower === "doc") return { bg: "#2B579A", ext: "DOC" };
    if (lower === "xlsx" || lower === "xls" || lower === "csv") return { bg: "#217346", ext: "XLS" };
    if (lower === "txt" || lower === "md") return { bg: "#757575", ext: "TXT" };
    if (lower === "zip") return { bg: "#7A5BB0", ext: "ZIP" };
    return { bg: "#5B7DB1", ext: ext === "" ? "FILE" : ext };
  }
  function formatBytes(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  }
  function nameFromPath(path) {
    const base = path.slice(Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/")) + 1);
    return base === "" ? path : base;
  }
  function isRasterImage(file) {
    const t = (file.type ?? "").toLowerCase();
    if (t === "image/png" || t === "image/jpeg" || t === "image/webp" || t === "image/gif") return true;
    return /\.(png|jpe?g|webp|gif)$/.test(file.name.toLowerCase());
  }
  function injectCss() {
    if (typeof document === "undefined") return;
    if (document.querySelector(`style[data-plugin-css=${JSON.stringify(STYLE_TAG)}]`) !== null) return;
    const tag = document.createElement("style");
    tag.dataset.plugin = "dsh-files";
    tag.dataset.pluginCss = STYLE_TAG;
    tag.textContent = `
.dsh-files-btn{border:none;background:transparent;color:var(--dsw-alias-label-secondary,currentColor);cursor:pointer;border-radius:6px;padding:4px;display:inline-flex;align-items:center;justify-content:center;line-height:0}
.dsh-files-btn:hover:not(:disabled){color:var(--dsw-alias-label-primary,currentColor)}
.dsh-files-btn:disabled{opacity:.45;cursor:default}
.dsh-files-dock{box-sizing:border-box;width:calc(100% - var(--dsh-composer-side-clearance) - var(--dsh-composer-side-clearance) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset));max-width:calc(var(--dsh-composer-card-max-width) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset));margin:0 auto 6px;padding:0 var(--dsh-composer-dock-inset);display:flex;flex-wrap:wrap;gap:8px;flex:none}
.dsh-files-card{position:relative;flex-direction:column;align-items:center;gap:5px;width:88px;flex:none;border:1px solid var(--dsw-alias-border-l2-darkmode-thin,rgba(127,127,127,.22));background:var(--dsw-specific-input-major,var(--dsw-alias-surface-2,rgba(127,127,127,.08)));border-radius:12px;padding:12px 8px 9px;box-shadow:var(--dsw-shadow-lv1,0 1px 2px rgba(0,0,0,.06));color:var(--dsw-alias-label-primary,inherit)}
.dsh-files-badge{width:44px;height:56px;border-radius:6px;color:#fff;font-size:12px;font-weight:700;font-family:var(--ds-font-family-code,monospace);display:inline-flex;align-items:center;justify-content:center;letter-spacing:.5px;flex:none;box-shadow:inset 0 -10px 14px rgba(0,0,0,.14),inset 0 10px 12px rgba(255,255,255,.16)}
.dsh-files-name{width:100%;font-size:12px;line-height:16px;text-align:center;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;word-break:break-all}
.dsh-files-size{color:var(--dsw-alias-label-tertiary,inherit);font-size:10.5px;flex:none}
.dsh-files-remove{border:none;background:transparent;color:var(--dsw-alias-label-tertiary,inherit);cursor:pointer;padding:2px;border-radius:4px;display:inline-flex;line-height:0;flex:none}
.dsh-files-remove:hover{color:var(--dsw-alias-label-primary,inherit);background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.dsh-files-card>.dsh-files-remove{position:absolute;top:4px;right:4px}
.dsh-files-error{display:inline-flex;align-items:center;gap:8px;max-width:100%;border:1px solid var(--dsw-alias-border-l2-darkmode-thin,rgba(127,127,127,.22));background:var(--dsw-alias-interactive-bg-hover-danger,rgba(216,97,97,.14));color:var(--dsw-alias-state-error-primary,#d86161);border-radius:10px;padding:6px 8px 6px 10px;font-size:13px}
.dsh-files-error-text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:420px}
.uV2eYG_chip:has(> .uV2eYG_chipLabel:empty){visibility:hidden}
body.dsh-files-dragging:after{content:'\u677E\u5F00\u4EE5\u4E0A\u4F20\u6587\u4EF6\u6216\u6587\u4EF6\u5939';position:fixed;inset:0;display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:600;color:#fff;background:rgba(0,0,0,.45);z-index:9999;pointer-events:none;text-shadow:0 1px 4px rgba(0,0,0,.5)}
`;
    document.head.appendChild(tag);
  }
  function httpErrorText(status) {
    if (status === 413) return "\u6587\u4EF6\u8D85\u8FC7\u5927\u5C0F\u9650\u5236";
    if (status === 415) return "\u6587\u4EF6\u7C7B\u578B\u4E0D\u88AB\u5141\u8BB8";
    if (status === 403) return "\u4E0A\u4F20\u88AB\u670D\u52A1\u5668\u62D2\u7EDD\uFF1A\u975E\u672C\u673A/\u53D7\u4FE1\u6765\u6E90";
    if (status === 429) return "\u4E0A\u4F20\u592A\u9891\u7E41\uFF0C\u8BF7\u7A0D\u540E\u518D\u8BD5";
    if (status === 507) return "\u4F1A\u8BDD\u5B58\u50A8\u914D\u989D\u5DF2\u6EE1\uFF0C\u8BF7\u5220\u9664\u4E00\u4E9B\u6587\u4EF6";
    return `HTTP ${status}`;
  }
  var insertChain = Promise.resolve();
  function settleFrame() {
    return new Promise((resolve) => {
      if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => resolve());
      else setTimeout(resolve, 16);
    });
  }
  async function insertOnce(actx, ref, label) {
    const conversation = actx.get("conversation");
    if (conversation === void 0) throw new Error("conversation service unavailable");
    const input = conversation.input.for(actx);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const state = input.state.getSnapshot();
      const caret = typeof input.caretSpan === "function" ? input.caretSpan() : { start: state.draft.length, end: state.draft.length };
      actx.emit("slash/input-insert-reference", {
        reference: {
          source: SOURCE_NAME,
          ref,
          label,
          clipboardText: ref
        },
        span: {
          start: caret.start,
          end: caret.end,
          draftRev: state.draftRev
        }
      });
      await settleFrame();
      const after = input.state.getSnapshot();
      if (after.occurrences.some((o) => o.source === SOURCE_NAME && o.ref === ref)) return true;
    }
    return false;
  }
  async function insertReference(actx, ref, label) {
    const run = insertChain.then(() => insertOnce(actx, ref, label));
    insertChain = run.then(
      () => void 0,
      () => void 0
    );
    return run;
  }
  async function uploadMany(actx, files, sessionId) {
    if (files.length === 0) return;
    let next = 0;
    const worker = async () => {
      while (true) {
        const i = next;
        next += 1;
        if (i >= files.length) return;
        try {
          await attachFile(actx, files[i], sessionId, files[i].webkitRelativePath);
        } catch (err) {
          setUploadError(err instanceof Error ? err.message : String(err));
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(UPLOAD_CONCURRENCY, files.length) }, () => worker())
    );
  }
  async function collectFiles(dt) {
    const files = [];
    if (dt === null) return files;
    const items = dt.items;
    const got = /* @__PURE__ */ new Set();
    const visit = async (item) => {
      if ("webkitGetAsEntry" in item) {
        const entry = item.webkitGetAsEntry?.();
        if (entry === void 0 || entry === null) {
          const file = item.getAsFile();
          if (file !== null) files.push(file);
          return;
        }
        await visit(entry);
        return;
      }
      if (item.isFile) {
        const file = await new Promise((resolve) => item.file(resolve));
        if (file !== null) {
          const key = file.webkitRelativePath !== "" ? file.webkitRelativePath : file.name;
          if (!got.has(key)) {
            got.add(key);
            files.push(file);
          }
        }
      } else if (item.isDirectory) {
        const reader = item.createReader();
        while (true) {
          const batch = await new Promise((resolve) => reader.readEntries(resolve));
          if (batch === null || batch.length === 0) break;
          for (const child of batch) await visit(child);
        }
      }
    };
    for (const item of Array.from(items ?? [])) {
      if (item.kind === "file") await visit(item);
    }
    return files;
  }
  async function attachFile(actx, file, sessionId, relPath) {
    if (isRasterImage(file)) {
      const conversation = actx.get("conversation");
      if (conversation !== void 0 && typeof conversation.createDraftImages === "function") {
        try {
          const drafts = conversation.createDraftImages([file]);
          const input = conversation.input.for(actx);
          if (drafts.length > 0 && typeof input.addImages === "function") {
            const added = input.addImages(drafts.map((d) => d.id));
            if (added) {
              clearUploadError();
              return;
            }
          }
        } catch {
        }
      }
    }
    const res = await fetch("/api/upload", {
      method: "POST",
      headers: {
        "x-file-name": encodeURIComponent(file.name),
        // 文件夹上传时携带相对路径（webkitRelativePath 的目录前缀），
        // 服务端据此在会话目录内保留子目录层级；单文件上传为空。
        ...relPath !== void 0 && relPath !== "" ? { "x-file-relative-path": encodeURIComponent(relPath) } : {},
        "x-session-id": sessionId
      },
      body: file
    });
    if (!res.ok) {
      let detail = httpErrorText(res.status);
      try {
        const payload2 = await res.json();
        if (typeof payload2.error === "string") detail = payload2.error;
      } catch {
      }
      throw new Error(`${file.name}: ${detail}`);
    }
    const payload = await res.json();
    if (typeof payload.path !== "string") throw new Error("missing path in response");
    const name = payload.name ?? file.name;
    const meta = {
      name,
      bytes: payload.bytes ?? file.size,
      sniffed: "sniffedFormat" in payload ? payload.sniffedFormat ?? null : void 0,
      sessionId
    };
    uploadMeta.set(payload.path, meta);
    uploadedPool.set(payload.path, meta);
    clearUploadError();
    const inserted = await insertReference(actx, payload.path, "");
    if (!inserted) {
      setUploadError(`\u6587\u4EF6\u5DF2\u4E0A\u4F20\u4F46\u672A\u80FD\u52A0\u5165\u8F93\u5165\u6846: ${payload.path}`);
    }
  }
  function UploadButton({ attach, scope }) {
    const [busy, setBusy] = (0, import_react.useState)(false);
    const inputRef = (0, import_react.useRef)(null);
    const attachRef = (0, import_react.useRef)(attach);
    attachRef.current = attach;
    const scopeRef = (0, import_react.useRef)(scope);
    scopeRef.current = scope;
    (0, import_react.useEffect)(() => {
      let dragDepth = 0;
      const isFileDrag = (e) => e.dataTransfer?.types.includes("Files") ?? false;
      const onDragOver = (e) => {
        if (!isFileDrag(e)) return;
        e.preventDefault();
        dragDepth += 1;
        document.body.classList.add("dsh-files-dragging");
      };
      const onDragLeave = (e) => {
        if (!isFileDrag(e)) return;
        if (e.relatedTarget !== null) return;
        dragDepth = Math.max(0, dragDepth - 1);
        if (dragDepth === 0) document.body.classList.remove("dsh-files-dragging");
      };
      const onDrop = (e) => {
        e.preventDefault();
        dragDepth = 0;
        document.body.classList.remove("dsh-files-dragging");
        setBusy(true);
        void (async () => {
          try {
            const files = await collectFiles(e.dataTransfer ?? null);
            if (files.length > 0) await scopeRef.current(files);
          } catch (err) {
            setUploadError(err instanceof Error ? err.message : String(err));
          }
          setBusy(false);
        })();
      };
      const onDragEnd = () => {
        dragDepth = 0;
        document.body.classList.remove("dsh-files-dragging");
      };
      document.addEventListener("dragover", onDragOver);
      document.addEventListener("dragleave", onDragLeave);
      document.addEventListener("drop", onDrop);
      document.addEventListener("dragend", onDragEnd);
      return () => {
        document.removeEventListener("dragover", onDragOver);
        document.removeEventListener("dragleave", onDragLeave);
        document.removeEventListener("drop", onDrop);
        document.removeEventListener("dragend", onDragEnd);
        document.body.classList.remove("dsh-files-dragging");
      };
    }, []);
    const pick = () => {
      const input = document.createElement("input");
      input.type = "file";
      input.multiple = true;
      input.style.display = "none";
      document.body.appendChild(input);
      inputRef.current = input;
      input.onchange = () => {
        const files = Array.from(input.files ?? []);
        input.remove();
        inputRef.current = null;
        if (files.length === 0) return;
        setBusy(true);
        void (async () => {
          try {
            await scopeRef.current(files);
          } catch (err) {
            setUploadError(err instanceof Error ? err.message : String(err));
          }
          setBusy(false);
        })();
      };
      input.click();
    };
    const pickDir = () => {
      const input = document.createElement("input");
      input.type = "file";
      input.multiple = true;
      input.webkitdirectory = true;
      input.style.display = "none";
      document.body.appendChild(input);
      inputRef.current = input;
      input.onchange = () => {
        const files = Array.from(input.files ?? []);
        input.remove();
        inputRef.current = null;
        if (files.length === 0) return;
        setBusy(true);
        void (async () => {
          try {
            await scopeRef.current(files);
          } catch (err) {
            setUploadError(err instanceof Error ? err.message : String(err));
          }
          setBusy(false);
        })();
      };
      input.click();
    };
    return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Tooltip, { label: busy ? "\u4E0A\u4F20\u4E2D\u2026" : "\u4E0A\u4F20\u6587\u4EF6", side: "top", children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "dsh-files-btn", "aria-label": "\u4E0A\u4F20\u6587\u4EF6", disabled: busy, onClick: pick, children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.IconPaperclipOutline16, { size: 14 }) }) }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Tooltip, { label: busy ? "\u4E0A\u4F20\u4E2D\u2026" : "\u4E0A\u4F20\u6587\u4EF6\u5939", side: "top", children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "dsh-files-btn", "aria-label": "\u4E0A\u4F20\u6587\u4EF6\u5939", disabled: busy, onClick: pickDir, children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.IconFolderOpenOutline16, { size: 14 }) }) })
    ] });
  }
  function UploadDock({ useInput, inputActions }) {
    const state = useInput?.((s) => s) ?? null;
    const error = (0, import_react.useSyncExternalStore)(subscribeErrors, () => uploadError);
    const ours = (state?.occurrences ?? []).filter((o) => o.source === SOURCE_NAME);
    const refs = ours.map((o) => o.ref).join("\n");
    (0, import_react.useEffect)(() => {
      const live = new Set(refs.split("\n").filter((r) => r !== ""));
      for (const key of [...uploadMeta.keys()]) {
        if (!live.has(key)) uploadMeta.delete(key);
      }
    }, [refs]);
    if (ours.length === 0 && error === null) return null;
    const removeCard = (ref, offset) => {
      const draft = state?.draft ?? "";
      let end = offset;
      while (end < draft.length && !/\s/.test(draft[end])) end += 1;
      const next = draft.slice(0, offset) + draft.slice(end);
      inputActions?.setDraft(next);
      const wasUpload = uploadMeta.has(ref);
      uploadMeta.delete(ref);
      uploadedPool.delete(ref);
      if (wasUpload) {
        void fetch(`/api/upload?path=${encodeURIComponent(ref)}`, { method: "DELETE" }).catch(() => {
        });
      }
    };
    return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-files-dock", children: [
      error !== null && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-files-error", role: "alert", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dsh-files-error-text", title: error.text, children: error.text }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "dsh-files-remove", "aria-label": "\u5173\u95ED\u9519\u8BEF\u63D0\u793A", onClick: clearUploadError, children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.IconCloseOutline16, { size: 12 }) })
      ] }),
      ours.map((occ) => {
        const meta = uploadMeta.get(occ.ref);
        const name = meta?.name ?? nameFromPath(occ.ref);
        const { bg, ext } = badgeStyle(name, meta?.sniffed);
        return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-files-card", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dsh-files-badge", style: { background: bg }, children: ext }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dsh-files-name", title: occ.ref, children: name }),
          meta !== void 0 && meta.bytes > 0 && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dsh-files-size", children: formatBytes(meta.bytes) }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Tooltip, { label: "\u79FB\u9664", side: "top", children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
            "button",
            {
              type: "button",
              className: "dsh-files-remove",
              "aria-label": "\u79FB\u9664",
              onClick: () => removeCard(occ.ref, occ.offset),
              children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.IconCloseOutline16, { size: 12 })
            }
          ) })
        ] }, occ.occurrenceId);
      })
    ] });
  }
  function apply(ctx) {
    injectCss();
    ctx.effect(
      () => ctx.inputTriggers.registerSource({
        trigger: "@",
        name: SOURCE_NAME,
        order: 0,
        showGroupTitle: false,
        // @ 双源：工作区文件（相对路径注入，agent 按 cwd 解析）+ 本会话已上传文件（绝对路径）。
        // 工作区源在前、上传源在后；端点不可用时静默降级为仅上传源。
        candidates: async () => {
          const workspace = await fetchWorkspaceFiles();
          const items = [];
          for (const file of workspace) {
            items.push({
              name: file.name,
              description: `\u5DE5\u4F5C\u533A \xB7 ${file.rel}`,
              value: file.rel
            });
          }
          for (const [ref, meta] of uploadedPool.entries()) {
            if (meta.sessionId !== currentSessionId) continue;
            items.push({
              name: meta.name,
              description: `${formatBytes(meta.bytes)}${meta.sniffed ? " \xB7 " + meta.sniffed.toUpperCase() : ""}`,
              value: ref
            });
          }
          return items;
        },
        onPick: (pick) => {
          const p = pick;
          const ref = p.candidate?.value;
          if (ref === void 0 || ref === "") return void 0;
          return {
            insert: {
              source: SOURCE_NAME,
              ref,
              label: p.candidate?.name ?? nameFromPath(ref),
              appearance: "file",
              clipboardText: ref
            }
          };
        },
        codec: {
          clipboardText: (ref) => ref,
          serialize: async (ref) => ref
        }
      })
    );
    ctx.slots.inject(
      "conversation.input.left",
      () => ctx.slots.register(
        {
          name: "conversation.input.left",
          id: "dsh-files-button",
          order: 0,
          inject: (sessionId) => {
            currentSessionId = sessionId;
            const actx = ctx.sessions.scope(sessionId);
            return {
              attach: (file) => attachFile(actx, file, sessionId),
              // 文件夹/多文件上传复用同一会话作用域（有界并发，见 uploadMany）。
              scope: (files) => uploadMany(actx, files, sessionId)
            };
          }
        },
        UploadButton
      )
    );
    ctx.slots.inject(
      "conversation.input.dock",
      () => ctx.slots.register(
        {
          name: "conversation.input.dock",
          id: "dsh-files-dock",
          order: 5
        },
        UploadDock
      )
    );
  }
  if (typeof module !== "undefined" && module !== null) {
    module.exports = {
      apply,
      inject: ["slots", "inputTriggers", "sessions"]
    };
  }
})();
return module.exports; } });
//# sourceMappingURL=client.js.map
