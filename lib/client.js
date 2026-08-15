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
  var PASTE_MIN_CHARS = 4e3;
  function pasteMinChars() {
    try {
      const raw = Number(localStorage.getItem("dsh.files.pasteMinChars"));
      if (Number.isFinite(raw) && raw >= 1) return raw;
    } catch {
    }
    return PASTE_MIN_CHARS;
  }
  var uploadMeta = /* @__PURE__ */ new Map();
  var uploadError = null;
  var errorSeq = 0;
  var errorListeners = /* @__PURE__ */ new Set();
  var pendingPastes = /* @__PURE__ */ new Map();
  var pendingSeq = 0;
  var pendingListeners = /* @__PURE__ */ new Set();
  var pendingSnapshot = [];
  function publishPending() {
    pendingSnapshot = [...pendingPastes.values()];
    for (const listener of pendingListeners) listener();
  }
  function subscribePending(listener) {
    pendingListeners.add(listener);
    return () => {
      pendingListeners.delete(listener);
    };
  }
  function getPendingSnapshot() {
    return pendingSnapshot;
  }
  function setPending(paste) {
    pendingPastes.set(paste.seq, paste);
    publishPending();
  }
  function clearPending(seq) {
    pendingPastes.delete(seq);
    publishPending();
  }
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
  function badgeStyle(name) {
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
.dsh-files-paste{box-sizing:border-box;width:100%;max-width:var(--dsh-composer-card-max-width);border:1px solid var(--dsw-alias-border-l2-darkmode-thin,rgba(127,127,127,.22));background:var(--dsw-specific-input-major,var(--dsw-alias-surface-2,rgba(127,127,127,.08)));border-radius:12px;padding:10px 12px;color:var(--dsw-alias-label-primary,inherit)}
.dsh-files-paste-head{display:flex;align-items:center;gap:8px;margin-bottom:6px}
.dsh-files-paste-title{font-size:13px;font-weight:600;flex:none}
.dsh-files-paste-char{font-size:12px;color:var(--dsw-alias-label-tertiary,inherit);flex:none}
.dsh-files-paste-preview{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,inherit);max-height:84px;overflow:hidden;white-space:pre-wrap;word-break:break-word;margin-bottom:8px;border-left:3px solid var(--dsw-alias-border-l2-darkmode-thin,rgba(127,127,127,.22));padding-left:8px}
.dsh-files-paste-row{display:flex;align-items:center;gap:8px}
.dsh-files-paste-save{border:none;background:var(--dsw-alias-interactive-bg-primary,#2f6feb);color:#fff;cursor:pointer;border-radius:8px;padding:5px 12px;font-size:13px;font-weight:600;flex:none}
.dsh-files-paste-save:hover{filter:brightness(1.08)}
.dsh-files-paste-keep{border:1px solid var(--dsw-alias-border-l2-darkmode-thin,rgba(127,127,127,.22));background:transparent;color:var(--dsw-alias-label-primary,inherit);cursor:pointer;border-radius:8px;padding:4px 12px;font-size:13px;flex:none}
.dsh-files-paste-keep:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.dsh-files-paste-remove{border:none;background:transparent;color:var(--dsw-alias-label-tertiary,inherit);cursor:pointer;padding:2px;border-radius:4px;display:inline-flex;line-height:0;flex:none;margin-left:auto}
.dsh-files-paste-remove:hover{color:var(--dsw-alias-label-primary,inherit);background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.uV2eYG_chip:has(> .uV2eYG_chipLabel:empty){visibility:hidden}
`;
    document.head.appendChild(tag);
  }
  function httpErrorText(status) {
    if (status === 413) return "\u6587\u4EF6\u8D85\u8FC7\u5927\u5C0F\u9650\u5236";
    if (status === 415) return "\u6587\u4EF6\u7C7B\u578B\u4E0D\u88AB\u5141\u8BB8";
    if (status === 403) return "\u4F1A\u8BDD\u6821\u9A8C\u5931\u8D25\uFF0C\u8BF7\u5237\u65B0\u9875\u9762\u91CD\u8BD5";
    if (status === 429) return "\u4E0A\u4F20\u592A\u9891\u7E41\uFF0C\u8BF7\u7A0D\u540E\u518D\u8BD5";
    return `HTTP ${status}`;
  }
  async function attachFile(actx, file, sessionId) {
    const conversation = actx.get("conversation");
    if (conversation === void 0) throw new Error("conversation service unavailable");
    const input = conversation.input.for(actx);
    const res = await fetch("/api/upload", {
      method: "POST",
      headers: {
        "x-file-name": encodeURIComponent(file.name),
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
    uploadMeta.set(payload.path, { name, bytes: payload.bytes ?? file.size });
    clearUploadError();
    const state = input.state.getSnapshot();
    actx.emit("slash/input-insert-reference", {
      reference: {
        source: SOURCE_NAME,
        ref: payload.path,
        label: "",
        clipboardText: payload.path
      },
      span: {
        start: state.draft.length,
        end: state.draft.length,
        draftRev: state.draftRev
      }
    });
    const after = input.state.getSnapshot();
    const inserted = after.occurrences.some((o) => o.source === SOURCE_NAME && o.ref === payload.path);
    if (!inserted) {
      setUploadError(`\u6587\u4EF6\u5DF2\u4E0A\u4F20\u4F46\u672A\u80FD\u52A0\u5165\u8F93\u5165\u6846: ${payload.path}`);
    }
  }
  async function savePastedText(actx, text, sessionId) {
    const res = await fetch("/api/paste-text", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-session-id": sessionId
      },
      body: JSON.stringify({ text })
    });
    if (!res.ok) {
      let detail = httpErrorText(res.status);
      try {
        const payload2 = await res.json();
        if (typeof payload2.error === "string") detail = payload2.error;
      } catch {
      }
      throw new Error(detail);
    }
    const payload = await res.json();
    if (typeof payload.path !== "string") throw new Error("missing path in response");
    uploadMeta.set(payload.path, { name: payload.name ?? nameFromPath(payload.path), bytes: payload.bytes ?? 0 });
    return payload.path;
  }
  function insertPasteReference(actx, path, caret, setDraft) {
    const conversation = actx.get("conversation");
    if (conversation === void 0) return false;
    const input = conversation.input.for(actx);
    const state = input.state.getSnapshot();
    actx.emit("slash/input-insert-reference", {
      reference: {
        source: SOURCE_NAME,
        ref: path,
        label: "",
        clipboardText: path
      },
      span: {
        start: caret,
        end: caret,
        draftRev: state.draftRev
      }
    });
    const after = input.state.getSnapshot();
    const occ = after.occurrences.find((o) => o.source === SOURCE_NAME && o.ref === path);
    if (occ === void 0) {
      setUploadError(`\u6587\u672C\u5DF2\u4FDD\u5B58\u4F46\u672A\u80FD\u52A0\u5165\u8F93\u5165\u6846: ${path}`);
      return false;
    }
    const pointer = `[\u5DF2\u7C98\u8D34\u957F\u6587\u672C\uFF0C\u5DF2\u4FDD\u5B58\u4E3A\u6587\u4EF6: ${path}]
`;
    const draftWithChip = after.draft;
    const next = draftWithChip.slice(0, occ.offset) + pointer + draftWithChip.slice(occ.offset);
    setDraft(next);
    return true;
  }
  function UploadButton({ attach }) {
    const [busy, setBusy] = (0, import_react.useState)(false);
    const inputRef = (0, import_react.useRef)(null);
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
          for (const file of files) {
            try {
              await attach(file);
            } catch {
            }
          }
          setBusy(false);
        })();
      };
      input.click();
    };
    return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Tooltip, { label: busy ? "\u4E0A\u4F20\u4E2D\u2026" : "\u4E0A\u4F20\u6587\u4EF6", side: "top", children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "dsh-files-btn", "aria-label": "\u4E0A\u4F20\u6587\u4EF6", disabled: busy, onClick: pick, children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.IconPaperclipOutline16, { size: 14 }) }) });
  }
  function isComposerPasteTarget(target) {
    const el = target;
    if (el === null || typeof el.closest !== "function") return false;
    return el.closest("[data-composer-card] textarea") !== null;
  }
  function pastePreview(text) {
    const compact = text.replace(/\s+/g, " ").trim();
    return compact.length > 200 ? `${compact.slice(0, 200)}\u2026` : compact;
  }
  function UploadDock({ useInput, inputActions, savePaste, actx }) {
    const state = useInput?.((s) => s) ?? null;
    const error = (0, import_react.useSyncExternalStore)(subscribeErrors, () => uploadError);
    const pending = (0, import_react.useSyncExternalStore)(subscribePending, getPendingSnapshot);
    const ours = (state?.occurrences ?? []).filter((o) => o.source === SOURCE_NAME);
    const refs = ours.map((o) => o.ref).join("\n");
    (0, import_react.useEffect)(() => {
      const live = new Set(ours.map((o) => o.ref));
      for (const key of [...uploadMeta.keys()]) {
        if (!live.has(key)) uploadMeta.delete(key);
      }
    }, [refs, ours]);
    (0, import_react.useEffect)(() => {
      const onPaste = (e) => {
        if (!isComposerPasteTarget(e.target)) return;
        const text = e.clipboardData?.getData("text/plain") ?? "";
        if (text.length < pasteMinChars()) return;
        e.preventDefault();
        e.stopPropagation();
        const caret = e.target.selectionStart ?? 0;
        setPending({ text, caret, seq: ++pendingSeq });
      };
      document.addEventListener("paste", onPaste, true);
      return () => document.removeEventListener("paste", onPaste, true);
    }, []);
    const applyPending = async (paste) => {
      if (actx === void 0) {
        setUploadError("\u65E0\u6CD5\u4FDD\u5B58\u6587\u672C\uFF1A\u4F1A\u8BDD\u670D\u52A1\u4E0D\u53EF\u7528");
        return;
      }
      try {
        const path = await savePaste(paste.text);
        insertPasteReference(actx, path, paste.caret, inputActions?.setDraft ?? (() => void 0));
        clearPending(paste.seq);
      } catch (err) {
        setUploadError(`\u957F\u6587\u672C\u4FDD\u5B58\u5931\u8D25: ${err?.message ?? String(err)}`);
      }
    };
    const keepText = (paste) => {
      const draft = state?.draft ?? "";
      const next = draft.slice(0, paste.caret) + paste.text + draft.slice(paste.caret);
      inputActions?.setDraft(next);
      clearPending(paste.seq);
    };
    const hasContent = pending.length > 0 || ours.length > 0 || error !== null;
    if (!hasContent) return null;
    const removeCard = (_occurrenceId, ref, offset) => {
      const draft = state?.draft ?? "";
      const next = draft.slice(0, offset) + draft.slice(offset + 1);
      inputActions?.setDraft(next);
      uploadMeta.delete(ref);
      void fetch(`/api/upload?path=${encodeURIComponent(ref)}`, { method: "DELETE" }).catch(() => {
      });
    };
    return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-files-dock", children: [
      pending.map((paste) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-files-paste", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-files-paste-head", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dsh-files-paste-title", children: "\u68C0\u6D4B\u5230\u957F\u6587\u672C\u7C98\u8D34" }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "dsh-files-paste-char", children: [
            paste.text.length,
            " \u5B57 \xB7 \u5EFA\u8BAE\u4FDD\u5B58\u4E3A\u6587\u4EF6\u540E\u6309\u9700\u8BFB\u53D6"
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
            "button",
            {
              type: "button",
              className: "dsh-files-paste-remove",
              "aria-label": "\u5FFD\u7565",
              onClick: () => clearPending(paste.seq),
              children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.IconCloseOutline16, { size: 12 })
            }
          )
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "dsh-files-paste-preview", children: pastePreview(paste.text) }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-files-paste-row", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "dsh-files-paste-save", onClick: () => void applyPending(paste), children: "\u4FDD\u5B58\u4E3A\u6587\u4EF6" }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "dsh-files-paste-keep", onClick: () => keepText(paste), children: "\u4ECD\u4F5C\u4E3A\u6587\u672C\u7C98\u8D34" })
        ] })
      ] }, paste.seq)),
      error !== null && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-files-error", role: "alert", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dsh-files-error-text", title: error.text, children: error.text }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "dsh-files-remove", "aria-label": "\u5173\u95ED\u9519\u8BEF\u63D0\u793A", onClick: clearUploadError, children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.IconCloseOutline16, { size: 12 }) })
      ] }),
      ours.map((occ) => {
        const meta = uploadMeta.get(occ.ref);
        const name = meta?.name ?? nameFromPath(occ.ref);
        const { bg, ext } = badgeStyle(name);
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
              onClick: () => removeCard(occ.occurrenceId, occ.ref, occ.offset),
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
        candidates: async () => [],
        onPick: () => void 0,
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
          inject: (sessionId) => ({
            attach: (file) => attachFile(ctx.sessions.scope(sessionId), file, sessionId)
          })
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
          order: 5,
          inject: (sessionId) => {
            const actx = ctx.sessions.scope(sessionId);
            return {
              actx,
              savePaste: (text) => savePastedText(actx, text, sessionId)
            };
          }
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
