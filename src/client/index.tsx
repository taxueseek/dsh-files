// dsh-files 0.6.0 client face — one button, no pipeline.
//
// A single folder-picker button injected into `conversation.input.left`, i.e.
// right next to the host's native paperclip. Files flattened from the picked
// directory enter the host's native attachment pipeline:
//   conversation.createDrafts(sessionId, files)  → mint drafts (images become
//     image drafts; everything else starts the official background upload)
//   inputActions.addAttachments(ids)             → official draft rail
// Display, byte progress, cancel/retry, session-switch persistence and the
// model-facing handle line are all owned by the host — 0.6.0 ships none of
// them. The button is the only UI this plugin renders.

import { useEffect, useRef, useState } from 'react'
import { Tooltip, IconFolderOpenOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'

interface DraftDescriptor {
  id: string
}

/** Duck-typed slice of the host conversation client service (0.1.3+). */
interface ConversationService {
  createDrafts(sessionId: string, files: readonly File[]): readonly DraftDescriptor[]
}

type FolderDraftResult = { ids: readonly string[] } | { error: string }

const STYLE_TAG = 'dsh-files/style.css'

function injectCss(): void {
  if (typeof document === 'undefined') return
  if (document.querySelector(`style[data-plugin-css=${JSON.stringify(STYLE_TAG)}]`) !== null) return
  const tag = document.createElement('style')
  tag.dataset.plugin = 'dsh-files'
  tag.dataset.pluginCss = STYLE_TAG
  tag.textContent = `
.dsh-files-btn{width:28px;height:28px;padding:1px 6px;border:none;border-radius:999px;background:rgb(245,246,247);display:grid;place-items:center;color:rgb(15,17,21);cursor:pointer;line-height:0}
.dsh-files-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-solid)}
.dsh-files-btn:disabled{opacity:.5;cursor:default}
.dsh-files-dragging:after{content:'松开以上传文件夹';position:fixed;inset:0;display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:600;color:#fff;background:rgba(0,0,0,.45);z-index:9999;pointer-events:none;text-shadow:0 1px 4px rgba(0,0,0,.5)}
/* 位置插位：把按钮排进官方回形针右侧、权限选择之前。绑定宿主 0.1.3 的
   InputBar css-modules 哈希（JNhZqW_）；宿主升级哈希变了会整体失效并退回
   默认位置（权限选择之后），功能不受影响。 */
.JNhZqW_tools>.JNhZqW_add:nth-of-type(1){order:-3}
.JNhZqW_tools>.JNhZqW_add:nth-of-type(2){order:-2}
.JNhZqW_tools>input{order:-1}
.JNhZqW_tools>.JNhZqW_modes{order:1}`
  document.head.appendChild(tag)
}

/**
 * The host's drop pipeline has no webkitGetAsEntry anywhere: a dragged
 * directory reaches it as one unreadable File and fails. These helpers keep
 * directory drag-and-drop working. They only engage when the drag actually
 * contains a directory — plain file drags are left entirely to the host.
 */
function dragContainsDirectory(dt: DataTransfer | null): boolean {
  if (dt === null) return false
  for (const item of Array.from(dt.items)) {
    if (item.kind !== 'file') continue
    const entry = item.webkitGetAsEntry?.()
    if (entry !== null && entry !== undefined && entry.isDirectory) return true
  }
  return false
}

/** Flatten a DataTransfer into concrete files; directories recurse. */
async function collectFiles(dt: DataTransfer | null): Promise<File[]> {
  const files: File[] = []
  if (dt === null) return files
  const got = new Set<string>()
  const visit = async (item: DataTransferItem | FileSystemEntry): Promise<void> => {
    // DataTransferItem (the drag list) and FileSystemEntry (directory
    // recursion) are two shapes: the former uses webkitGetAsEntry/getAsFile,
    // the latter isFile/isDirectory/createReader directly.
    if ('webkitGetAsEntry' in item) {
      const entry = item.webkitGetAsEntry?.()
      if (entry === undefined || entry === null) {
        const file = item.getAsFile()
        if (file !== null) files.push(file)
        return
      }
      await visit(entry)
      return
    }
    if (item.isFile) {
      const file = await new Promise<File | null>((resolve) => item.file(resolve))
      if (file !== null) {
        // Dedup key prefers webkitRelativePath (directory prefix included):
        // same-named files in different directories must all survive.
        const key = file.webkitRelativePath !== '' ? file.webkitRelativePath : file.name
        if (!got.has(key)) {
          got.add(key)
          files.push(file)
        }
      }
    } else if (item.isDirectory) {
      const reader = item.createReader()
      // readEntries caps at ~100 entries per call; loop until empty.
      while (true) {
        const batch = await new Promise<FileSystemEntry[] | null>((resolve) => reader.readEntries(resolve))
        if (batch === null || batch.length === 0) break
        for (const child of batch) await visit(child)
      }
    }
  }
  for (const item of Array.from(dt.items ?? [])) {
    if (item.kind === 'file') await visit(item)
  }
  return files
}

interface FolderButtonProps {
  addFolderDrafts(files: readonly File[]): FolderDraftResult
  inputActions: { addAttachments(ids: readonly string[]): boolean } | undefined
}

function FolderButton({ addFolderDrafts, inputActions }: FolderButtonProps) {
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const flash = (text: string) => {
    setNote(text)
    if (resetTimer.current !== null) clearTimeout(resetTimer.current)
    resetTimer.current = setTimeout(() => setNote(''), 2500)
  }
  const handlersRef = useRef({ addFolderDrafts, inputActions })
  handlersRef.current = { addFolderDrafts, inputActions }
  const busyRef = useRef(false)

  // Directory drag-and-drop, window capture phase — the earliest point, so
  // intercepting here (only when a directory is present) keeps plain file
  // drags entirely with the host's own pipeline.
  useEffect(() => {
    let dragDepth = 0
    const settle = () => {
      dragDepth = 0
      document.body.classList.remove('dsh-files-dragging')
    }
    const onDragOver = (e: DragEvent) => {
      if (!dragContainsDirectory(e.dataTransfer ?? null)) return
      e.preventDefault()
      e.stopPropagation()
      dragDepth += 1
      document.body.classList.add('dsh-files-dragging')
    }
    const onDragLeave = (e: DragEvent) => {
      if (!document.body.classList.contains('dsh-files-dragging')) return
      // Only a leave that truly exits the document may clear the overlay;
      // element-internal leaves (relatedTarget still on page) must not.
      if (e.relatedTarget !== null) return
      dragDepth = Math.max(0, dragDepth - 1)
      if (dragDepth === 0) settle()
    }
    const onDrop = (e: DragEvent) => {
      if (!dragContainsDirectory(e.dataTransfer ?? null)) return
      e.preventDefault()
      e.stopPropagation()
      settle()
      if (busyRef.current) return
      setBusy(true)
      void (async () => {
        try {
          const files = await collectFiles(e.dataTransfer ?? null)
          if (files.length === 0) return
          const result = handlersRef.current.addFolderDrafts(files)
          if ('error' in result) {
            console.warn('dsh-files: folder drafts rejected:', result.error)
            flash('添加失败')
          } else if (handlersRef.current.inputActions !== undefined) {
            const added = handlersRef.current.inputActions.addAttachments([...result.ids])
            if (!added) flash('输入区忙，稍后重试')
          } else {
            flash('输入区不可用')
          }
        } catch (err) {
          flash(err instanceof Error ? err.message : String(err))
        } finally {
          setBusy(false)
        }
      })()
    }
    const onDragEnd = () => settle()
    window.addEventListener('dragover', onDragOver, true)
    window.addEventListener('dragleave', onDragLeave, true)
    window.addEventListener('drop', onDrop, true)
    window.addEventListener('dragend', onDragEnd, true)
    return () => {
      settle()
      window.removeEventListener('dragover', onDragOver, true)
      window.removeEventListener('dragleave', onDragLeave, true)
      window.removeEventListener('drop', onDrop, true)
      window.removeEventListener('dragend', onDragEnd, true)
    }
  }, [])

  // webkitdirectory picker: input.files already carries the recursive
  // flattening with webkitRelativePath preserved per entry. The cancel branch
  // must clean up — change never fires on cancel, and a hidden input left in
  // the DOM would accumulate across cancellations.
  const pick = () => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = true
    ;(input as HTMLInputElement & { webkitdirectory?: boolean }).webkitdirectory = true
    input.style.display = 'none'
    document.body.appendChild(input)
    const finish = () => {
      input.remove()
    }
    input.addEventListener('cancel', finish)
    input.onchange = () => {
      const files = Array.from(input.files ?? [])
      finish()
      if (files.length === 0) return
      setBusy(true)
      try {
        const result = addFolderDrafts(files)
        if ('error' in result) {
          console.warn('dsh-files: folder drafts rejected:', result.error)
          flash('添加失败')
        } else if (inputActions !== undefined) {
          const added = inputActions.addAttachments([...result.ids])
          if (!added) flash('输入区忙，稍后重试')
        } else {
          flash('输入区不可用')
        }
      } finally {
        setBusy(false)
      }
    }
    input.click()
  }

  return (
    <Tooltip label={busy ? '添加中…' : note !== '' ? note : '上传文件夹'} side="top">
      <button
        type="button"
        className="dsh-files-btn"
        aria-label="上传文件夹"
        disabled={busy}
        onClick={pick}
      >
        <IconFolderOpenOutline16 size={14} />
      </button>
    </Tooltip>
  )
}

export function apply(ctx: {
  slots: {
    inject(name: string, factory: () => unknown): unknown
    register(spec: Record<string, unknown>, component: unknown): unknown
  }
  sessions: {
    scope(sessionId: string): { get(name: string): unknown }
  }
}): void {
  injectCss()
  ctx.slots.inject('conversation.input.left', () =>
    ctx.slots.register(
      {
        name: 'conversation.input.left',
        id: 'dsh-files-folder',
        order: 0,
        inject: (sessionId: string | undefined) => ({
          addFolderDrafts: (files: readonly File[]): FolderDraftResult => {
            if (sessionId === undefined) return { error: 'no active session' }
            const conversation = ctx.sessions.scope(sessionId).get('conversation') as
              | ConversationService
              | undefined
            if (conversation === undefined || typeof conversation.createDrafts !== 'function') {
              return { error: 'native attachment pipeline unavailable (harness >= 0.1.3 required)' }
            }
            try {
              const drafts = conversation.createDrafts(sessionId, files)
              return { ids: drafts.map((draft) => draft.id) }
            } catch (error: unknown) {
              return { error: error instanceof Error ? error.message : String(error) }
            }
          }
        })
      },
      FolderButton
    )
  )
}

// Client bundles load through the ModuleLoader factory; esbuild's iife format
// does not write entry exports into module.exports, so assign explicitly.
declare const module: { exports: unknown } | undefined
if (typeof module !== 'undefined' && module !== null) {
  module.exports = {
    apply,
    inject: ['slots', 'sessions']
  }
}
