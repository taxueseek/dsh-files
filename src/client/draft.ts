// Draft-token editing helpers shared by the client face. Kept JSX-free in a
// dedicated module so node --test can import them directly (Node's type
// stripping does not transform .tsx).

/**
 * chip 插入自带一个分隔尾空格；删除 token 后若删除点两侧都是空格，会留下
 * 「前一分隔空格 + 自身分隔空格」的连续双空格——吃掉一个。at 在草稿两端时
 * 不动（行首/行尾没有配对空格可言）。
 */
function collapseSpacer(draft: string, at: number): string {
  if (at > 0 && at < draft.length && draft[at - 1] === ' ' && draft[at] === ' ') {
    return draft.slice(0, at) + draft.slice(at + 1)
  }
  return draft
}

/**
 * Remove the reference token at `offset` from the draft. Occurrences carry an
 * offset but no token length: when the draft still holds the exact ref at
 * that offset, delete exactly it — file paths may contain spaces, so blind
 * whitespace scanning would cut mid-path and leave residue. The whitespace
 * scan stays as the fallback for drafts edited beyond recognition.
 */
export function removeTokenFromDraft(draft: string, ref: string, offset: number): string {
  if (ref !== '' && draft.startsWith(ref, offset)) {
    return collapseSpacer(draft.slice(0, offset) + draft.slice(offset + ref.length), offset)
  }
  let end = offset
  while (end < draft.length && !/\s/.test(draft[end])) end += 1
  return collapseSpacer(draft.slice(0, offset) + draft.slice(end), offset)
}
