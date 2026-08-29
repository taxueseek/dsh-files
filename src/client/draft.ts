// Draft-token editing helpers shared by the client face. Kept JSX-free in a
// dedicated module so node --test can import them directly (Node's type
// stripping does not transform .tsx).

/**
 * Remove the reference token at `offset` from the draft. Occurrences carry an
 * offset but no token length: when the draft still holds the exact ref at
 * that offset, delete exactly it — file paths may contain spaces, so blind
 * whitespace scanning would cut mid-path and leave residue. The whitespace
 * scan stays as the fallback for drafts edited beyond recognition.
 */
export function removeTokenFromDraft(draft: string, ref: string, offset: number): string {
  if (ref !== '' && draft.startsWith(ref, offset)) {
    return draft.slice(0, offset) + draft.slice(offset + ref.length)
  }
  let end = offset
  while (end < draft.length && !/\s/.test(draft[end])) end += 1
  return draft.slice(0, offset) + draft.slice(end)
}
