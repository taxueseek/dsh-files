<div align="center">

[English](README.md) | [简体中文](README.zh.md)

</div>

<p align="center">
  <img src="assets/readme/hero.svg" width="100%" alt="dsh-files：一个工具，读内置 read 读不了的 PDF / DOCX / XLSX。">
</p>

# dsh-files

一个 DeepSeek Harness 插件，只做一件事：**`read_document` 工具**——读内置 read 工具拒绝的二进制文档（PDF / DOCX / XLSX），文本族增强读取（编码回退、分页、sheet 级访问）。

> 上传、图片、`@` 引用自 0.5.0 起移除——harness 0.1.3 起原生提供（任意文件上传、图片视觉管线、`@file`/`@session` 统一引用），且更强。本插件是[踏雪寻仙插件矩阵](https://github.com/taxueseek#deepseek-harness-%E6%8F%92%E4%BB%B6)的一员，主打 [argo](https://github.com/taxueseek/argo)。

## 为什么需要它

harness 0.1.3 的原生上传把文件存为字节对象，模型拿到一行 handle（文件名、大小、摘要、只读路径）后用**文件工具**读取——而内置 read 对二进制内容直接报 `FS_NOT_TEXT`。PDF / DOCX / XLSX 的结构化文本提取是官方留白，这个插件补上它。

## 能力

- **内容嗅探**：PDF 头 / ZIP 中央目录成员 / UTF-8（fatal）/ UTF-16 BOM / GB18030，全部从字节判定，扩展名伪装（exe 改 .pdf）一律拒绝；格式 hint 仅作字节完全未知时的兜底
- **编码链**：UTF-16 BOM → UTF-8（fatal，拒 NUL）→ GB18030（fatal）→ UTF-16 无 BOM（高置信度守卫），中文 GBK 与无 BOM UTF-16 均可读
- **分页读取**：行号 + offset/limit 翻页；窗口字符预算按格式差异化（text 满额、xlsx 3/4、pdf/docx 1/2），超限显式标记剩余行数
- **行号策略**：text（代码/配置）带行号供精确定位；PDF/DOCX/XLSX 段落流不带行号（省 token）
- **XLSX sheet 级读取**：`list_sheets` 先列名，`sheet` 参数读全量单表（不受行截断限制），越界报错附带可用 sheet 列表
- **扫描件明示**：无文本层的 PDF 返回显式提示而非空串
- **协作取消**：解析期间监听执行信号，用户取消/会话关闭立即中止
- **输出呈现**：text 结果投影为官方 `card: 'read'` 读文件卡片；解析走 `ctx.fs`，继承会话沙箱与 fs 观察策略
- **阅读克制**：systemPrompt 引导「先探结构、再精准读、读够就停」

## 安装

要求 harness ≥ 0.1.3-alpha.1。

```sh
curl -fsSL https://raw.githubusercontent.com/taxueseek/dsh-files/main/install.sh | sh
# 重启 dsh web
```

手动等价命令：

```sh
dsh plugin --profile web add git+https://github.com/taxueseek/dsh-files.git
# 重启 dsh web
```

> npm 上名为 `dsh-files` 的包是无关第三方占位包，请勿用裸 npm 包名安装。

## 配置

```yaml
- id: files-toolkit
  name: 'dsh-files'
  config:
    maxFileBytes: 25165824        # 单次文档读取字节上限
    readLimit: 2000               # 单次返回行数上限（翻页成本低）
    sheetRowLimit: 200            # 每个 sheet 保留行数
    maxSheets: 5                  # 每个工作簿读取的 sheet 数
    maxOutputChars: 24000         # 单次输出窗口字符预算（超限截断并标记）
    readTimeoutMs: 120000         # 单次执行超时（大 PDF 解析可加大）
```

## 安全

- 解析依赖均为只读维护中库：`pdfjs-dist`（Mozilla 官方）、`mammoth`、`read-excel-file`
- ZIP 中央目录探测不展开任何成员，恶意归档安全拒绝
- 文件读取走 `ctx.fs`，继承会话沙箱，与内置 read 工具同权

## 开发

```sh
pnpm install
pnpm test
pnpm build
npx tsc --noEmit
```

## 许可

MIT
