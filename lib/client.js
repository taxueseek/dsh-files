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
  var STYLE_TAG = "dsh-files/style.css";
  function injectCss() {
    if (typeof document === "undefined") return;
    if (document.querySelector(`style[data-plugin-css=${JSON.stringify(STYLE_TAG)}]`) !== null) return;
    const tag = document.createElement("style");
    tag.dataset.plugin = "dsh-files";
    tag.dataset.pluginCss = STYLE_TAG;
    tag.textContent = `
.dsh-files-btn{width:28px;height:28px;padding:1px 6px;border:none;border-radius:999px;background:rgb(245,246,247);display:grid;place-items:center;color:rgb(15,17,21);cursor:pointer;line-height:0}
.dsh-files-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-solid)}
.dsh-files-btn:disabled{opacity:.5;cursor:default}
.dsh-files-dragging:after{content:'\u677E\u5F00\u4EE5\u4E0A\u4F20\u6587\u4EF6\u5939';position:fixed;inset:0;display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:600;color:#fff;background:rgba(0,0,0,.45);z-index:9999;pointer-events:none;text-shadow:0 1px 4px rgba(0,0,0,.5)}
/* \u4F4D\u7F6E\u63D2\u4F4D\uFF1A\u628A\u6309\u94AE\u6392\u8FDB\u5B98\u65B9\u56DE\u5F62\u9488\u53F3\u4FA7\u3001\u6743\u9650\u9009\u62E9\u4E4B\u524D\u3002\u7ED1\u5B9A\u5BBF\u4E3B 0.1.3 \u7684
   InputBar css-modules \u54C8\u5E0C\uFF08JNhZqW_\uFF09\uFF1B\u5BBF\u4E3B\u5347\u7EA7\u54C8\u5E0C\u53D8\u4E86\u4F1A\u6574\u4F53\u5931\u6548\u5E76\u9000\u56DE
   \u9ED8\u8BA4\u4F4D\u7F6E\uFF08\u6743\u9650\u9009\u62E9\u4E4B\u540E\uFF09\uFF0C\u529F\u80FD\u4E0D\u53D7\u5F71\u54CD\u3002 */
.JNhZqW_tools>.JNhZqW_add:nth-of-type(1){order:-3}
.JNhZqW_tools>.JNhZqW_add:nth-of-type(2){order:-2}
.JNhZqW_tools>input{order:-1}
.JNhZqW_tools>.JNhZqW_modes{order:1}`;
    document.head.appendChild(tag);
  }
  function dragContainsDirectory(dt) {
    if (dt === null) return false;
    for (const item of Array.from(dt.items)) {
      if (item.kind !== "file") continue;
      const entry = item.webkitGetAsEntry?.();
      if (entry !== null && entry !== void 0 && entry.isDirectory) return true;
    }
    return false;
  }
  async function collectFiles(dt) {
    const files = [];
    if (dt === null) return files;
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
    for (const item of Array.from(dt.items ?? [])) {
      if (item.kind === "file") await visit(item);
    }
    return files;
  }
  function FolderButton({ addFolderDrafts, inputActions }) {
    const [busy, setBusy] = (0, import_react.useState)(false);
    const [note, setNote] = (0, import_react.useState)("");
    const resetTimer = (0, import_react.useRef)(null);
    const flash = (text) => {
      setNote(text);
      if (resetTimer.current !== null) clearTimeout(resetTimer.current);
      resetTimer.current = setTimeout(() => setNote(""), 2500);
    };
    const handlersRef = (0, import_react.useRef)({ addFolderDrafts, inputActions });
    handlersRef.current = { addFolderDrafts, inputActions };
    const busyRef = (0, import_react.useRef)(false);
    (0, import_react.useEffect)(() => {
      let dragDepth = 0;
      const settle = () => {
        dragDepth = 0;
        document.body.classList.remove("dsh-files-dragging");
      };
      const onDragOver = (e) => {
        if (!dragContainsDirectory(e.dataTransfer ?? null)) return;
        e.preventDefault();
        e.stopPropagation();
        dragDepth += 1;
        document.body.classList.add("dsh-files-dragging");
      };
      const onDragLeave = (e) => {
        if (!document.body.classList.contains("dsh-files-dragging")) return;
        if (e.relatedTarget !== null) return;
        dragDepth = Math.max(0, dragDepth - 1);
        if (dragDepth === 0) settle();
      };
      const onDrop = (e) => {
        if (!dragContainsDirectory(e.dataTransfer ?? null)) return;
        e.preventDefault();
        e.stopPropagation();
        settle();
        if (busyRef.current) return;
        setBusy(true);
        void (async () => {
          try {
            const files = await collectFiles(e.dataTransfer ?? null);
            if (files.length === 0) return;
            const result = handlersRef.current.addFolderDrafts(files);
            if ("error" in result) {
              console.warn("dsh-files: folder drafts rejected:", result.error);
              flash("\u6DFB\u52A0\u5931\u8D25");
            } else if (handlersRef.current.inputActions !== void 0) {
              const added = handlersRef.current.inputActions.addAttachments([...result.ids]);
              if (!added) flash("\u8F93\u5165\u533A\u5FD9\uFF0C\u7A0D\u540E\u91CD\u8BD5");
            } else {
              flash("\u8F93\u5165\u533A\u4E0D\u53EF\u7528");
            }
          } catch (err) {
            flash(err instanceof Error ? err.message : String(err));
          } finally {
            setBusy(false);
          }
        })();
      };
      const onDragEnd = () => settle();
      window.addEventListener("dragover", onDragOver, true);
      window.addEventListener("dragleave", onDragLeave, true);
      window.addEventListener("drop", onDrop, true);
      window.addEventListener("dragend", onDragEnd, true);
      return () => {
        settle();
        window.removeEventListener("dragover", onDragOver, true);
        window.removeEventListener("dragleave", onDragLeave, true);
        window.removeEventListener("drop", onDrop, true);
        window.removeEventListener("dragend", onDragEnd, true);
      };
    }, []);
    const pick = () => {
      const input = document.createElement("input");
      input.type = "file";
      input.multiple = true;
      input.webkitdirectory = true;
      input.style.display = "none";
      document.body.appendChild(input);
      const finish = () => {
        input.remove();
      };
      input.addEventListener("cancel", finish);
      input.onchange = () => {
        const files = Array.from(input.files ?? []);
        finish();
        if (files.length === 0) return;
        setBusy(true);
        try {
          const result = addFolderDrafts(files);
          if ("error" in result) {
            console.warn("dsh-files: folder drafts rejected:", result.error);
            flash("\u6DFB\u52A0\u5931\u8D25");
          } else if (inputActions !== void 0) {
            const added = inputActions.addAttachments([...result.ids]);
            if (!added) flash("\u8F93\u5165\u533A\u5FD9\uFF0C\u7A0D\u540E\u91CD\u8BD5");
          } else {
            flash("\u8F93\u5165\u533A\u4E0D\u53EF\u7528");
          }
        } finally {
          setBusy(false);
        }
      };
      input.click();
    };
    return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Tooltip, { label: busy ? "\u6DFB\u52A0\u4E2D\u2026" : note !== "" ? note : "\u4E0A\u4F20\u6587\u4EF6\u5939", side: "top", children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
      "button",
      {
        type: "button",
        className: "dsh-files-btn",
        "aria-label": "\u4E0A\u4F20\u6587\u4EF6\u5939",
        disabled: busy,
        onClick: pick,
        children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.IconFolderOpenOutline16, { size: 14 })
      }
    ) });
  }
  function apply(ctx) {
    injectCss();
    ctx.slots.inject(
      "conversation.input.left",
      () => ctx.slots.register(
        {
          name: "conversation.input.left",
          id: "dsh-files-folder",
          order: 0,
          inject: (sessionId) => ({
            addFolderDrafts: (files) => {
              if (sessionId === void 0) return { error: "no active session" };
              const conversation = ctx.sessions.scope(sessionId).get("conversation");
              if (conversation === void 0 || typeof conversation.createDrafts !== "function") {
                return { error: "native attachment pipeline unavailable (harness >= 0.1.3 required)" };
              }
              try {
                const drafts = conversation.createDrafts(sessionId, files);
                return { ids: drafts.map((draft) => draft.id) };
              } catch (error) {
                return { error: error instanceof Error ? error.message : String(error) };
              }
            }
          })
        },
        FolderButton
      )
    );
  }
  if (typeof module !== "undefined" && module !== null) {
    module.exports = {
      apply,
      inject: ["slots", "sessions"]
    };
  }
})();
return module.exports; } });
//# sourceMappingURL=client.js.map
