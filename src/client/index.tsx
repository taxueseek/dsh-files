// dsh-files client face: composer paperclip button + floating file cards.
// Uploads carry the session id so the host stores files inside that session's
// workspace (.dsh-filess/<sessionId>), where the agent's fs backend can
// always resolve them.

import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Tooltip, IconPaperclipOutline16, IconCloseOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'

const SOURCE_NAME = 'dsh-files'
const STYLE_TAG = 'dsh-files/style.css'

/** Pasting at or above this many characters triggers the save-to-file flow. */
const PASTE_MIN_CHARS = 4000

/** Overridable via localStorage `dsh.files.pasteMinChars`. */
function pasteMinChars(): number {
  try {
    const raw = Number(localStorage.getItem('dsh.files.pasteMinChars'))
    if (Number.isFinite(raw) && raw >= 1) return raw
  } catch {
    // storage unavailable
  }
  return PASTE_MIN_CHARS
}

interface UploadMeta {
  name: string
  bytes: number
}

interface PendingPaste {
  text: string
  caret: number
  seq: number
}

const uploadMeta = new Map<string, UploadMeta>()
let uploadError: { seq: number; text: string } | null = null
let errorSeq = 0
const errorListeners = new Set<() => void>()

const pendingPastes = new Map<number, PendingPaste>()
let pendingSeq = 0
const pendingListeners = new Set<() => void>()
// useSyncExternalStore requires a cached snapshot reference: emit a new array
// only when the set changes, otherwise React re-renders forever.
let pendingSnapshot: PendingPaste[] = []

function publishPending(): void {
  pendingSnapshot = [...pendingPastes.values()]
  for (const listener of pendingListeners) listener()
}

function subscribePending(listener: () => void): () => void {
  pendingListeners.add(listener)
  return () => {
    pendingListeners.delete(listener)
  }
}

function getPendingSnapshot(): PendingPaste[] {
  return pendingSnapshot
}

function setPending(paste: PendingPaste): void {
  pendingPastes.set(paste.seq, paste)
  publishPending()
}

function clearPending(seq: number): void {
  pendingPastes.delete(seq)
  publishPending()
}

function subscribeErrors(listener: () => void): () => void {
  errorListeners.add(listener)
  return () => {
    errorListeners.delete(listener)
  }
}

function setUploadError(text: string): void {
  uploadError = { seq: ++errorSeq, text }
  for (const listener of errorListeners) listener()
}

function clearUploadError(): void {
  uploadError = null
  for (const listener of errorListeners) listener()
}

function badgeStyle(name: string): { bg: string; ext: string } {
  const ext = name.slice(name.lastIndexOf('.') + 1).toUpperCase().slice(0, 4)
  const lower = ext.toLowerCase()
  if (lower === 'pdf') return { bg: '#C93B2E', ext: 'PDF' }
  if (lower === 'docx' || lower === 'doc') return { bg: '#2B579A', ext: 'DOC' }
  if (lower === 'xlsx' || lower === 'xls' || lower === 'csv') return { bg: '#217346', ext: 'XLS' }
  if (lower === 'txt' || lower === 'md') return { bg: '#757575', ext: 'TXT' }
  if (lower === 'zip') return { bg: '#7A5BB0', ext: 'ZIP' }
  return { bg: '#5B7DB1', ext: ext === '' ? 'FILE' : ext }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

function nameFromPath(path: string): string {
  const base = path.slice(Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/')) + 1)
  return base === '' ? path : base
}

function injectCss(): void {
  if (typeof document === 'undefined') return
  if (document.querySelector(`style[data-plugin-css=${JSON.stringify(STYLE_TAG)}]`) !== null) return
  const tag = document.createElement('style')
  tag.dataset.plugin = 'dsh-files'
  tag.dataset.pluginCss = STYLE_TAG
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
`
  document.head.appendChild(tag)
}

interface InputSnapshot {
  draft: string
  draftRev: number
  occurrences: Array<{ source: string; ref: string; occurrenceId: string; offset: number }>
}

interface InputService {
  for(actx: unknown): {
    state: { getSnapshot(): InputSnapshot }
  }
}

interface ConversationService {
  input: InputService
}

interface ActionContext {
  get(name: string): ConversationService | undefined
  emit(event: string, payload: Record<string, unknown>): void
}

function httpErrorText(status: number): string {
  if (status === 413) return '文件超过大小限制'
  if (status === 415) return '文件类型不被允许'
  if (status === 403) return '会话校验失败，请刷新页面重试'
  if (status === 429) return '上传太频繁，请稍后再试'
  return `HTTP ${status}`
}

async function attachFile(actx: ActionContext, file: File, sessionId: string): Promise<void> {
  const conversation = actx.get('conversation')
  if (conversation === undefined) throw new Error('conversation service unavailable')
  const input = conversation.input.for(actx)
  const res = await fetch('/api/upload', {
    method: 'POST',
    headers: {
      'x-file-name': encodeURIComponent(file.name),
      'x-session-id': sessionId
    },
    body: file
  })
  if (!res.ok) {
    let detail = httpErrorText(res.status)
    try {
      const payload = (await res.json()) as { error?: string }
      if (typeof payload.error === 'string') detail = payload.error
    } catch {
      // keep the status-based message
    }
    throw new Error(`${file.name}: ${detail}`)
  }
  const payload = (await res.json()) as { path: string; name?: string; bytes?: number }
  if (typeof payload.path !== 'string') throw new Error('missing path in response')
  const name = payload.name ?? file.name
  uploadMeta.set(payload.path, { name, bytes: payload.bytes ?? file.size })
  clearUploadError()
  const state = input.state.getSnapshot()
  actx.emit('slash/input-insert-reference', {
    reference: {
      source: SOURCE_NAME,
      ref: payload.path,
      label: '',
      clipboardText: payload.path
    },
    span: {
      start: state.draft.length,
      end: state.draft.length,
      draftRev: state.draftRev
    }
  })
  const after = input.state.getSnapshot()
  const inserted = after.occurrences.some((o) => o.source === SOURCE_NAME && o.ref === payload.path)
  if (!inserted) {
    setUploadError(`文件已上传但未能加入输入框: ${payload.path}`)
  }
}

/** POST pasted text to the host, which persists it into the session workspace. */
async function savePastedText(actx: ActionContext, text: string, sessionId: string): Promise<string> {
  const res = await fetch('/api/paste-text', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-session-id': sessionId
    },
    body: JSON.stringify({ text })
  })
  if (!res.ok) {
    let detail = httpErrorText(res.status)
    try {
      const payload = (await res.json()) as { error?: string }
      if (typeof payload.error === 'string') detail = payload.error
    } catch {
      // keep the status-based message
    }
    throw new Error(detail)
  }
  const payload = (await res.json()) as { path: string; name?: string; bytes?: number }
  if (typeof payload.path !== 'string') throw new Error('missing path in response')
  uploadMeta.set(payload.path, { name: payload.name ?? nameFromPath(payload.path), bytes: payload.bytes ?? 0 })
  return payload.path
}

/**
 * Mint the pasted-text occurrence chip at the caret and prefix a pointer line
 * into the draft so the model knows the long text lives in a file it can read
 * with read_document. Returns true when the occurrence was inserted.
 */
function insertPasteReference(
  actx: ActionContext,
  path: string,
  caret: number,
  setDraft: (text: string) => void
): boolean {
  const conversation = actx.get('conversation')
  if (conversation === undefined) return false
  const input = conversation.input.for(actx)
  const state = input.state.getSnapshot()
  actx.emit('slash/input-insert-reference', {
    reference: {
      source: SOURCE_NAME,
      ref: path,
      label: '',
      clipboardText: path
    },
    span: {
      start: caret,
      end: caret,
      draftRev: state.draftRev
    }
  })
  const after = input.state.getSnapshot()
  const occ = after.occurrences.find((o) => o.source === SOURCE_NAME && o.ref === path)
  if (occ === undefined) {
    setUploadError(`文本已保存但未能加入输入框: ${path}`)
    return false
  }
  const pointer = `[已粘贴长文本，已保存为文件: ${path}]\n`
  const draftWithChip = after.draft
  const next = draftWithChip.slice(0, occ.offset) + pointer + draftWithChip.slice(occ.offset)
  setDraft(next)
  return true
}

interface UploadButtonProps {
  attach: (file: File) => Promise<void>
}

function UploadButton({ attach }: UploadButtonProps) {
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const pick = () => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = true
    input.style.display = 'none'
    document.body.appendChild(input)
    inputRef.current = input
    input.onchange = () => {
      const files = Array.from(input.files ?? [])
      input.remove()
      inputRef.current = null
      if (files.length === 0) return
      setBusy(true)
      void (async () => {
        for (const file of files) {
          try {
            await attach(file)
          } catch {
            // per-file error surfaced via the dock banner
          }
        }
        setBusy(false)
      })()
    }
    input.click()
  }
  return (
    <Tooltip label={busy ? '上传中…' : '上传文件'} side="top">
      <button type="button" className="dsh-files-btn" aria-label="上传文件" disabled={busy} onClick={pick}>
        <IconPaperclipOutline16 size={14} />
      </button>
    </Tooltip>
  )
}

interface DockProps {
  useInput?: (selector: (s: InputSnapshot) => InputSnapshot) => InputSnapshot | null
  inputActions?: { setDraft(text: string): void }
  savePaste?: (text: string) => Promise<string>
  actx?: ActionContext
}

/** The composer textarea is the only plain-text paste sink we intercept. */
function isComposerPasteTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (el === null || typeof el.closest !== 'function') return false
  return el.closest('[data-composer-card] textarea') !== null
}

function pastePreview(text: string): string {
  const compact = text.replace(/\s+/g, ' ').trim()
  return compact.length > 200 ? `${compact.slice(0, 200)}…` : compact
}

function UploadDock({ useInput, inputActions, savePaste, actx }: DockProps) {
  const state = useInput?.((s) => s) ?? null
  const error = useSyncExternalStore(subscribeErrors, () => uploadError)
  const pending = useSyncExternalStore(subscribePending, getPendingSnapshot)
  const ours = (state?.occurrences ?? []).filter((o) => o.source === SOURCE_NAME)
  const refs = ours.map((o) => o.ref).join('\n')

  useEffect(() => {
    const live = new Set(ours.map((o) => o.ref))
    for (const key of [...uploadMeta.keys()]) {
      if (!live.has(key)) uploadMeta.delete(key)
    }
  }, [refs, ours])

  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (!isComposerPasteTarget(e.target)) return
      const text = e.clipboardData?.getData('text/plain') ?? ''
      if (text.length < pasteMinChars()) return
      e.preventDefault()
      e.stopPropagation()
      const caret = (e.target as HTMLTextAreaElement).selectionStart ?? 0
      setPending({ text, caret, seq: ++pendingSeq })
    }
    document.addEventListener('paste', onPaste, true)
    return () => document.removeEventListener('paste', onPaste, true)
  }, [])

  const applyPending = async (paste: PendingPaste) => {
    if (actx === undefined) {
      setUploadError('无法保存文本：会话服务不可用')
      return
    }
    try {
      const path = await savePaste!(paste.text)
      insertPasteReference(actx, path, paste.caret, inputActions?.setDraft ?? (() => undefined))
      clearPending(paste.seq)
    } catch (err) {
      setUploadError(`长文本保存失败: ${(err as Error)?.message ?? String(err)}`)
    }
  }

  const keepText = (paste: PendingPaste) => {
    const draft = state?.draft ?? ''
    const next = draft.slice(0, paste.caret) + paste.text + draft.slice(paste.caret)
    inputActions?.setDraft(next)
    clearPending(paste.seq)
  }

  const hasContent = pending.length > 0 || ours.length > 0 || error !== null
  if (!hasContent) return null

  const removeCard = (_occurrenceId: string, ref: string, offset: number) => {
    const draft = state?.draft ?? ''
    const next = draft.slice(0, offset) + draft.slice(offset + 1)
    inputActions?.setDraft(next)
    uploadMeta.delete(ref)
    void fetch(`/api/upload?path=${encodeURIComponent(ref)}`, { method: 'DELETE' }).catch(() => {})
  }

  return (
    <div className="dsh-files-dock">
      {pending.map((paste) => (
        <div className="dsh-files-paste" key={paste.seq}>
          <div className="dsh-files-paste-head">
            <span className="dsh-files-paste-title">检测到长文本粘贴</span>
            <span className="dsh-files-paste-char">
              {paste.text.length} 字 · 建议保存为文件后按需读取
            </span>
            <button
              type="button"
              className="dsh-files-paste-remove"
              aria-label="忽略"
              onClick={() => clearPending(paste.seq)}
            >
              <IconCloseOutline16 size={12} />
            </button>
          </div>
          <div className="dsh-files-paste-preview">{pastePreview(paste.text)}</div>
          <div className="dsh-files-paste-row">
            <button type="button" className="dsh-files-paste-save" onClick={() => void applyPending(paste)}>
              保存为文件
            </button>
            <button type="button" className="dsh-files-paste-keep" onClick={() => keepText(paste)}>
              仍作为文本粘贴
            </button>
          </div>
        </div>
      ))}
      {error !== null && (
        <div className="dsh-files-error" role="alert">
          <span className="dsh-files-error-text" title={error.text}>
            {error.text}
          </span>
          <button type="button" className="dsh-files-remove" aria-label="关闭错误提示" onClick={clearUploadError}>
            <IconCloseOutline16 size={12} />
          </button>
        </div>
      )}
      {ours.map((occ) => {
        const meta = uploadMeta.get(occ.ref)
        const name = meta?.name ?? nameFromPath(occ.ref)
        const { bg, ext } = badgeStyle(name)
        return (
          <div className="dsh-files-card" key={occ.occurrenceId}>
            <span className="dsh-files-badge" style={{ background: bg }}>
              {ext}
            </span>
            <span className="dsh-files-name" title={occ.ref}>
              {name}
            </span>
            {meta !== undefined && meta.bytes > 0 && (
              <span className="dsh-files-size">{formatBytes(meta.bytes)}</span>
            )}
            <Tooltip label="移除" side="top">
              <button
                type="button"
                className="dsh-files-remove"
                aria-label="移除"
                onClick={() => removeCard(occ.occurrenceId, occ.ref, occ.offset)}
              >
                <IconCloseOutline16 size={12} />
              </button>
            </Tooltip>
          </div>
        )
      })}
    </div>
  )
}

export function apply(ctx: {
  effect(fn: () => unknown): void
  inputTriggers: {
    registerSource(source: Record<string, unknown>): void
  }
  slots: {
    inject(name: string, fn: () => unknown): void
    register(spec: Record<string, unknown>, component: unknown): unknown
  }
  sessions: {
    scope(sessionId: string): ActionContext
  }
}): void {
  injectCss()
  ctx.effect(() =>
    ctx.inputTriggers.registerSource({
      trigger: '@',
      name: SOURCE_NAME,
      candidates: async () => [],
      onPick: () => undefined,
      codec: {
        clipboardText: (ref: string) => ref,
        serialize: async (ref: string) => ref
      }
    })
  )
  ctx.slots.inject('conversation.input.left', () =>
    ctx.slots.register(
      {
        name: 'conversation.input.left',
        id: 'dsh-files-button',
        order: 0,
        inject: (sessionId: string) => ({
          attach: (file: File) => attachFile(ctx.sessions.scope(sessionId), file, sessionId)
        })
      },
      UploadButton
    )
  )
  ctx.slots.inject('conversation.input.dock', () =>
    ctx.slots.register(
      {
        name: 'conversation.input.dock',
        id: 'dsh-files-dock',
        order: 5,
        inject: (sessionId: string) => {
          const actx = ctx.sessions.scope(sessionId)
          return {
            actx,
            savePaste: (text: string) => savePastedText(actx, text, sessionId)
          }
        }
      },
      UploadDock
    )
  )
}

// 修复：client bundle 必须导出插件对象，否则 cordis 报
// "invalid plugin, expect function or object with an apply method"。
// esbuild iife 格式不会自动把 entry 导出写入 module.exports，
// 这里显式赋值（banner 已定义 module 变量，运行时存在）。
// 参考官方双面插件：exports.apply = apply; exports.inject = inject;
declare const module: { exports: unknown } | undefined
if (typeof module !== 'undefined' && module !== null) {
  module.exports = {
    apply,
    inject: ['slots', 'inputTriggers', 'sessions']
  }
}
