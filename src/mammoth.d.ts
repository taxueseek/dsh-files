// mammoth 官方 d.ts 遗漏了 convertToMarkdown 导出；补充声明以支持类型检查。
declare module 'mammoth' {
  interface Result {
    value: string
    messages: Array<{ type: string; message: string }>
  }
  interface Options {
    styleMap?: string | Array<string>
    includeEmbeddedStyleMap?: boolean
    includeDefaultStyleMap?: boolean
    ignoreEmptyParagraphs?: boolean
  }
  interface Mammoth {
    convertToHtml(input: { buffer: Buffer } | { path: string }, options?: Options): Promise<Result>
    convertToMarkdown(input: { buffer: Buffer } | { path: string }, options?: Options): Promise<Result>
    extractRawText(input: { buffer: Buffer } | { path: string }): Promise<Result>
  }
  const mammoth: Mammoth
  export default mammoth
}
