<div align="center">

[English](README.md) | [简体中文](README.zh.md)

</div>

<p align="center">
  <img src="assets/readme/hero.svg" width="100%" alt="dsh-files：让 AI 读懂你上传的文档，也让附件库进得去、出得来。">
</p>

# dsh-files

## 一句话

让 AI 能读懂你上传的文档，也让你的文件不再进得去、出不来。

## 它解决什么麻烦

你有没有遇到过这两种情况：

- 把一份**合同 PDF** 或**表格 Excel** 丢给 AI，它说“这个文件我读不了”——文件本身没坏，是内置的读取工具**只认纯文本**，碰到二进制内容就直接拒绝。
- 想让 AI 看看**前几天上传过的那个附件**，可附件库只进不出：翻不到、也拿不回本机。

dsh-files 就是补这两个洞的。**读**：AI 能读懂 PDF / Word / Excel 的正文；**取**：你和 AI 都能看到附件库里有什么，也能把文件拿回来。

## 这个版本更新了什么

- **SDK 与宿主对齐到 0.2.0-rc.2**：修掉了「桌面端 App 里插件按钮不出现、原生上传也不可用」的问题——此前插件按旧版 SDK 构建，与宿主内嵌的新版组件在客户端模块图里撞版本
- **报错时说人话**：以前失败只给一个冷冰冰的错误码，现在会直接告诉你**下一步该改哪里**。比如从局域网访问时附件功能报 403，它会把你要写的那行 `trustedHosts` **原样印出来**，复制粘贴即可
- **局域网 / 域名部署有文档了**：之前这段是空白，只能自己猜
- **写清了与官方功能的分工**：哪些事官方已经做了（上传、图片、文档预览），哪些是这个插件仍然独有的——避免重复造轮子

---

下面把一个文件在会话里的**四段生命周期**拆开看，每段补一块官方留白：

- **进**：**回形针旁的文件夹按钮**（+ 菜单里另有同名命令入口）——浏览器递归展平（过滤 Office 锁文件、`.DS_Store`、`.env` 等系统/隐藏文件），逐文件进入官方原生附件管线
- **读**：**`read_document` 工具**——读内置 read 工具拒绝的二进制文档（PDF / DOC / DOCX / XLSX）与增强文本读取（编码回退、分页、sheet 级访问）
- **管**：**`attachment_list` / `export_attachment` 工具**——附件库对模型可见（文件名/大小/sha），一键拷贝进工作区供 read/edit/bash 再加工
- **取**：**附件库面板**（输入卡下方官方坞位，收起为一枚官方胶囊）+ 下载/导出路由 + `@` 附件源——附件库对用户可见可下载（远程/LAN 把文件拉回本机），`@` 菜单插入官方 handle 行（与上传时模型所见一致）

> 上传、图片、`@` 工作区引用自 0.5.0 起移除——harness 0.1.3 起原生提供（任意文件上传、图片视觉管线、`@file`/`@session` 统一引用），且更强。本插件是[踏雪寻仙插件矩阵](https://github.com/taxueseek#deepseek-harness-%E6%8F%92%E4%BB%B6)的一员，主打 [argo](https://github.com/taxueseek/argo)。

## 为什么需要它

harness 0.1.3 的原生上传把文件存为字节对象，模型拿到一行 handle（文件名、大小、摘要、只读路径）后用**文件工具**读取——而内置 read 对二进制内容直接报 `FS_NOT_TEXT`。PDF / DOC / DOCX / XLSX 的结构化文本提取、附件库的清单与导出（官方 GC 在 roadmap、模型侧完全不可见）都是官方留白，这个插件补上它们。

<p align="center">
  <img src="assets/composer.png" alt="输入区与附件库：上传文件夹在官方 + 菜单中（截图为 0.5.3 之前界面，待重摄）" width="820">
</p>

## 能力

- **内容嗅探**：PDF 头 / OLE Compound File（Word 97-2003）/ ZIP 中央目录成员 / UTF-8（fatal）/ UTF-16 BOM / GB18030，全部从字节判定，扩展名伪装（exe 改 .pdf）一律拒绝；格式 hint 仅作字节完全未知时的兜底
- **.doc 老格式**：macOS 走系统 `textutil`（金标对照中正文与日期段最完整），其他平台回退纯 JS `word-extractor`
- **编码链**：UTF-16 BOM → UTF-8（fatal，拒 NUL）→ GB18030（fatal）→ UTF-16 无 BOM（高置信度守卫），中文 GBK 与无 BOM UTF-16 均可读
- **分页读取**：行号 + offset/limit 翻页；窗口字符预算按格式差异化（text 满额、xlsx 3/4、pdf/doc/docx 1/2），超限显式标记剩余行数
- **行号策略**：text（代码/配置）带行号供精确定位；PDF/DOC/DOCX/XLSX 段落流不带行号（省 token）
- **XLSX sheet 级读取**：`list_sheets` 先列名，`sheet` 参数读全量单表（不受行截断限制），越界报错附带可用 sheet 列表

<p align="center">
  <img src="assets/upload-folder-images.png" alt="文件夹批量上传后，文件以官方原生卡片进入预览区" width="680">
</p>
- **扫描件明示**：无文本层的 PDF 返回显式提示而非空串
- **协作取消**：解析期间监听执行信号，用户取消/会话关闭立即中止
- **输出呈现**：text 结果投影为官方 `card: 'read'` 读文件卡片；解析走 `ctx.fs`，继承会话沙箱与 fs 观察策略
- **附件库窗口**：`attachment_list` 列出附件库（原名/sha 前缀/大小/时间）；`export_attachment` 按 sha 前缀或原名导出，`COPYFILE_EXCL` 防覆盖，dest 走 `ctx.fs` 沙箱校验
- **附件库（0.5.3）**：输入卡**下方**官方坞位（`conversation.composer.dock`——官方自身在此放会话统计胶囊）里的一枚**官方 Pill 胶囊**「附件库 N 个 · X MB」，点开才展开卡片：附件列表（名/大小/时间，时间为短格式）、**重新插入**（把库内文件作为新附件挂回当前输入区——老会话的上传直接 ride 到新会话，不用回磁盘找）、**下载**（浏览器拉回本机，远程/LAN 场景的正路）、**导出到工作区**（`attachments/` 下自动命名防覆盖）、文件名搜索（客户端过滤，不打服务端往返；收起再展开超 30 秒才重拉清单）。跟随输入卡列宽。纯 UI 数据，零 prompt token
- **`@` 附件源（0.5.2）**：`@` 菜单新增附件组（与官方工作区候选共存），选中插入官方 handle 行——模型看到与上传时一致的文件行，直接 read 即可
- **下载/导出路由（0.5.2）**：走官方 `AttachmentStore.readFileStream`（完整性校验），双重护栏——Host 回环/`trustedHosts` 信任栅栏 + `sha256:` 引用白名单，超限 413

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

## 版本支持

| dsh-files | Harness | 说明 |
| --- | --- | --- |
| 0.5.6 | **0.2.0-rc.2（当前版，已实测）** | SDK 对齐与 0.5.5 相同；`package.json` 新增机器可读元数据：`repository`、`engines`（Node ≥ 20）、`dsh.compatibility`（`dshReleases` / `dshOperations`）。 |
| 0.5.5 | 0.2.0-rc.2（已实测） | SDK 全线对齐宿主 `0.2.0-rc.2`（`dsh-fs` / `dsh-tools` / `dsh-client-ui-primitives` 三者与宿主同版本），客户端组件解析不再有版本歧义。 |
| 0.5.3–0.5.4 | 0.1.7-alpha.1 | SDK 锁定 `0.1.7-alpha.1`；在 `0.2.0-rc.2` 宿主上客户端图标可能解析失败（见下）。 |
| 0.5.x | ≥ 0.1.3-alpha.1 | 旧 SDK pin（`0.1.0-rc.x`）；附件面板与 `@` 源早于宿主 `conversation.composer.dock` 槽位。 |
| 0.6.x | — | 从未发布（已并入 0.5.2/0.5.3），请勿使用。 |

运行环境要求 Node.js ≥ 20（插件开发与实测的下限；harness CLI 本身跑在用户自己的 Node 上）。

`package.json` 里的机器可读兼容记录（`dsh.compatibility`）将 `0.2.0-rc.2` 声明为 compatible，其中 `install` / `start` 两项操作在真实宿主 profile 上验证为 passed（2026-09-29，宿主 `0.2.0-rc.2`）；`uninstall` / `rollback` 如实声明为 unknown（本版本未演练过）。

0.2.0-rc.2 上的实测范围与结论（2026-09-29，本机 `web` profile）：

- 路由与站内接缝仍成立：`conversation.input.left` / `conversation.composer.dock` / `@` 源、`commandUi` 菜单贡献、`dsh-client-ui-primitives` 图标在官方浏览器名册中均可解析
- 附件库磁盘布局未变（`files/<sha2>/<sha>/<原名>`），对真实库实测清单可读；`AttachmentStore.readFileStream` 与 `llm.fileRequestText` 接缝未变
- 宿主插件契约的改动是**加法**：`dsh-tools` 0.2.0 只新增可选成员（如 `ToolDefinition.projectContent?`、`PreToolDecision.ask.displayReason?`），无破坏性变更
- 单一反例值得记下：`@deepseek-ai/dsh-client-runtime` 是**独立行**（不是种子模块），插件 `dsh.client.inject` 里声明它要求宿主名册存在该行——官方 0.2.0 名册已移除该行，声明它的客户端插件会整树加载失败。dsh-files 不声明它，故不受影响

本插件跟随维护者本地运行的 `alpha` 线（`0.1.7-alpha.1`）；npm `latest`（撰写时为 `0.1.5-rc.3`）反而更旧，请用上面的 git 方式安装，勿用仓库版本。

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
    # attachmentsDir: /path/to/attachments/v1  # 附件库根；留空按 DSH_HOME / ~/.dsh 自动探测
    attachmentsEnabled: true      # 附件闭环（面板/下载/导出/@ 源）总开关
    maxDownloadBytes: 209715200   # 单次附件下载/导出字节上限（超限 413）
    trustedHosts: []              # 非回环 host[:port] 授权；LAN/域名部署必配（语义同官方 --trusted-host）
```

## 远程 / LAN 部署

附件库路由有 Host 信任栅栏（语义同官方 `--trusted-host`）：**回环部署免配置**，用浏览器打开 `http://127.0.0.1:3080` 就能用。一旦你通过 LAN IP、内网域名或反向代理访问，Host 不再是回环地址，所有附件路由会返回 403——**这是设计行为，不是故障**。

让它工作的唯一一步，是把浏览器地址栏里的 authority 原样写进 `trustedHosts`：

```yaml
- id: files-toolkit
  name: 'dsh-files'
  config:
    trustedHosts:
      - '192.168.1.20:3080'   # 带端口 = 精确匹配该端口
      - 'dsh.example.com'     # 裸主机名 = 该主机的任意端口
```

不用猜：**403 响应体会把被拒的 authority 原样写进 `hint`，照抄即可**。响应形状：

```json
{
  "error": "host-not-trusted",
  "hint": "Browser host \"dsh.example.com:8443\" is not loopback and not in trustedHosts. … trustedHosts: [\"dsh.example.com:8443\"].",
  "docs": "https://github.com/taxueseek/dsh-files#configuration",
  "detail": { "host": "dsh.example.com:8443", "trustedHosts": ["dsh.example.com:3080"] }
}
```

`detail.trustedHosts` 是当前白名单，用来一眼看出「服务换端口了」这类失效——最常见的 403 就是这么来的（`dsh.example.com:3080` → `:8443`，裸主机名条目能覆盖，精确 `host:port` 条目不能）。

面板与 `@` 附件源也会显示同一句 `hint`（`@` 源还会在控制台留下带 HTTP 状态码的一行），所以从界面上就能知道该改什么，不必去翻日志。

### 失败响应契约

所有 `/plugins/dsh-files/attachments*` 路由的失败响应都是同一形状：机器可读的 `error` 码 + 可执行的 `hint` + `docs` 锚点 +（有现场数值时）`detail`。

| `error` | HTTP | 含义与下一步 |
| --- | --- | --- |
| `host-not-trusted` | 403 | Host 不在回环也不在 `trustedHosts`；`hint` 给出待放行的 authority |
| `invalid-ref` | 400 | `ref` 必须是 `sha256:<64 位 hex>`，取自清单接口的 `ref` 字段 |
| `missing-parameters` | 400 | 导出需要同时给 `session` 与 `ref` |
| `method-not-allowed` | 405 | 导出是 POST 路由；带 `Allow: POST` 头一并返回 |
| `session-without-workspace` | 400 | 该会话没有工作区目录，无处可导出 |
| `attachment-not-found` | 404 | 库内无此内容引用；先列清单 |
| `attachment-object-missing` | 404 | 索引有条目但对象已不在，需重新上传 |
| `attachment-corrupt` | 409 | 字节未通过完整性校验，重传源文件而非重试传输 |
| `attachment-too-large` | 413 | 给出实际大小、上限与 `maxDownloadBytes`；也可换另一条传输路径 |
| `list-failed` / `export-failed` / `attachment-read-failed` | 500 | 附上底层原因与可检查项 |

## 安全

### 权限声明

按自动化审查扫描的能力词汇逐项声明：

- **文件**：有。文档解析只读；附件库扫描由宿主进程对 DSH 附件存储只读遍历；导出落盘只走 `ctx.fs`，继承会话沙箱。无删除，不触碰存储与会话工作区之外的路径。
- **网络**：仅同源。客户端半区只调用宿主进程提供的本插件路由 `/plugins/dsh-files/*`。无第三方端点，无遥测。
- **命令**：一条，仅 macOS——旧版 `.doc` 用 `textutil` 经 `execFile` 转换，二进制固定、参数形状固定、输出走 stdout。无 shell 拼接，不执行用户提供的程序。
- **凭据**：无。唯一读取的环境变量是 `DSH_HOME`（用于定位附件存储的目录路径，与官方 home 路径解析同语义）——不读任何密钥、令牌、钥匙串。
- **外部服务**：无。全部逻辑运行在宿主进程及其浏览器视图内。
- **原生/可执行产物**：包内没有。git 树里的 `install.sh` 是普通 POSIX sh 便利脚本（文档用法即 `curl | sh` 一行）；npm 发布面（`files`）只含 JS 与文档。

### 细节

- 解析依赖均为只读维护中库：`pdfjs-dist`（Mozilla 官方）、`mammoth`、`read-excel-file`、`word-extractor`（.doc 兜底）
- ZIP 中央目录探测不展开任何成员，恶意归档安全拒绝
- 文件读取与导出落盘走 `ctx.fs`，继承会话沙箱，与内置 read 工具同权；附件库扫描由宿主进程只读执行，路径全部内部拼接
- 附件下载/导出除经官方 `AttachmentStore.readFileStream`（内容完整性校验、不暴露绝对路径），外再叠 Host 信任栅栏 + `sha256:` 引用白名单 + 尺寸上限；无任何删除路由（内容寻址对象可能被历史消息引用，删除留给官方未来 retention）
- 面板与 `@` 源均为 UI 层数据：不注入 systemPrompt、不注册模型工具，零 token

## 开发

```sh
pnpm install
pnpm test
pnpm build
npx tsc --noEmit
```

## 许可

MIT
