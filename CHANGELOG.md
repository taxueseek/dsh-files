# Changelog

## 0.4.3

### 修复（client）

- **多文件引用只落第一个（#12）**：插入 span 此前用剪贴板文本长度当坐标，而宿主把 span 应用在 detect 投影上——草稿里每多一个 chip 两个坐标系就分叉一截，第二个起全部静默 no-op（多选/文件夹/拖拽批量与同草稿逐个添加都命中，确定性复现）。现改用 `caretSpan()` 的 detect 坐标（老宿主无此方法时回退旧逻辑），插入经单链串行化、8 次重试、每帧以 `occurrences` 计数增量确认；重试耗尽打 `console.warn` 可观测（PR #13）。
- **移除一张卡片会压平其余 chip**：`setDraft` 按纯文本重建文档，幸存引用全变裸路径。现在移除后逐个把幸存 ref 的路径文本用 span 替换回 chip（压平态 clipboard 与 detect 坐标一致；detect 偏移按已替换累计长度修正），替换被拒时留纯路径不丢内容。
- **会话切换后卡片信息退化**：`uploadMeta` 随草稿剪枝，切回会话后卡片名/徽标/大小退化为从存储路径反推的猜测。回退 `uploadedPool`（按插入序淘汰、不随会话剪枝）。
- **移除卡片残留双空格**：chip 自带分隔尾空格，删除点两侧都是空格时吃掉一个；行首/行尾不动。
- **文件选择器取消后隐藏 input 残留 DOM**：`change` 不触发时无清理，多次取消持续堆积。合并文件/文件夹两条 picker 路径，监听 `cancel` 事件并在重开前移除上一个。
- **同 ref 已有 chip 时插入误报成功**：成功判定从「已存在」改为 `occurrences` 计数增量。
- **文本族徽标一律 TXT**：`.md`/`.html`/`.csv` 等按真实扩展名显示（1-4 位纯字母），无短扩展名才回退 TXT。
- **换会话后移除卡片 403**：DELETE 带上传时记录的归属会话头（`x-session-id`），文件真正删除而非滞留等 TTL。

### 修复（server）

- **超长伪扩展名绕过 120 字节截断**：扩展名只认最后一点后 1-8 位 ASCII 字母数字，否则不按扩展名保留——`extBytes` 可被撑爆 120 字节预算导致 ENAMETOOLONG 回归；裸扩展名输入（`.pdf`）保持无损。
- **DELETE 路径二次解码挂起连接**：`searchParams.get` 已做一次百分号解码，文件名含 `%`（如 `50%off.pdf`）时再 `decodeURIComponent` 会抛未捕获 URIError，keep-alive 连接就此挂起。
- **UTF-16 BOM 后奇数字节抛 TypeError**：`decodeText` 契约是「解不出返回 null」，奇数截尾改为返回 null。
- **`sweepIntervalMs=0` 恢复为合法配置**：文档承诺 0 = 禁用周期清扫，但校验进了正整数断言变成启动即抛错的死路径；改为非负整数校验。
- **解析缓存键改用 fs version token**：键 = targetKey + `FsVersion`（dsh-fs 写守卫押注的同一 freshness token）替代全内容 sha256——翻页读大文档的命中路径不再付 24 MiB ≈ 40ms 的哈希账；失效强度对照 fs 层编辑守卫核实（mtime 纳秒 + ctime 内核维护，`cp -p`/`touch -r` 伪造攻不进来）。

### 测试

- 新增客户端与回归测试，全量 108 通过，tsc 零错。

## 0.4.2

### 修复

- **TTL 清扫扫不到真实上传文件**：有 sessions 服务时上传文件落在 `<会话工作区>/.dsh-filess/`，而清扫器只挂在 `uploadDir`（无服务时的兜底布局）——正常部署下 TTL 回收从未生效。现在清扫根 = `uploadDir` ∪ live 会话 cwd（`sessions.list()`）∪ 上传时记录的会话 cwd 注册表（兜住上传后已关闭的会话），每次 tick 动态求值。
- **清扫不递归子目录**：文件夹上传产生的嵌套文件此前永不回收、空目录永不 reap。清扫改为后序递归：过期文件删除后自底向上 reap 清空的目录；符号链接整体跳过，清扫绝不越出上传根。
- **会话配额漏算子目录**：`maxUploadBytesPerSession` 此前只统计平铺文件，文件夹上传可绕过配额。统计改为递归整棵树。
- **上传卡片移除在路径含空格时残留**：occurrence 只给 offset 不给长度，原实现盲扫到空白会把含空格路径切一半。新增 `removeTokenFromDraft`（`src/client/draft.ts`）：优先按 ref 全文精确匹配删除，对不上再回退空白扫描。
- **`@` 候选池无上限增长**：加 200 条上限，超限按插入序淘汰最旧条目（不影响草稿里已插入的引用与卡片显示）。

### 测试

- 新增 10 个回归测试：递归清扫（嵌套回收/空目录 reap/新鲜文件保留）、符号链接跳过、多根 sweeper（roots 函数逐 tick 求值）、嵌套配额（超限 507 + 阈值内 200）、draft token 移除 6 例。全量 97 测试通过，tsc 零错。

## 0.4.1

### 新增

- **脚本安装**：仓库根新增 `install.sh`——检查 `dsh` / `pnpm` 环境后通过 git 通道执行 `dsh plugin add git+https://github.com/taxueseek/dsh-files.git`，支持 `--profile` 参数（默认 `web`）。`curl -fsSL https://raw.githubusercontent.com/taxueseek/dsh-files/main/install.sh | sh` 一行完成安装，Windows 在 Git Bash 中运行。

### 修复

- **README 中英版安装指引改为 git 通道**：原指引 `dsh plugin add dsh-files` 走 npm 通道，而 npm 上名为 `dsh-files` 的包（0.0.1，dushaobindoudou 于 2026-08-19 占位，"name reserved"，无任何 `dsh` 字段）是无关第三方包——照旧指引安装会把这个占位包装进 profile。现改为脚本安装 + 手动 git 命令，并加显式警告；双语一致性哈希已同步。

## 0.4.0

### 新增

- **图片原生支持**：上传的 JPEG / PNG / WebP / GIF 不再落成本地路径让 `read_document` 读不了，而是走 harness 核心附件管线（`createDraftImages` → `addImages` → 发送时转 base64 `image_url`）。因为线格式是供应商中立的 base64，任何声明 `inputModalities: [text, image]` 的模型（DeepSeek 视觉版、Dots3、龙猫、OpenRouter 视觉模型等）都能直接看图；UI 由官方 `conversation.input.attachments` rail 渲染（缩略图、点开大图、原生移除），呈现为原生图片而非灰色 badge 卡片。
- **`@` 双源候选**：输入 `@` 同时列出本会话已上传文件（绝对路径）与会话工作区文件（相对路径，agent 按其 cwd 解析），无需重新上传即可引用已有工作区文件。
- **工作区索引端点**：`GET /api/workspace-files?session=<id>` 只读返回会话 cwd 下的相对路径列表；BFS 遍历带忽略目录/文件/扩展名过滤、深度（默认 12）与数量（默认 500）上限、跳过符号链接（防环与索引逃逸），与上传端点同款网络护栏。

### 修复

- **解析缓存 in-flight 去重**：`getOrCompute` 让并发同 key 的调用共享一次解析 promise，多个 agent 同时分页同一大 PDF 时只解析一次，不再重复解析。
- **`read_document` output schema 补 `sheet` 字段**：XLSX sheet 读取返回的合法输出此前会被 `additionalProperties:false` 打成 `INVALID_TOOL_OUTPUT`，现 schema 声明该字段。
- **文件夹上传保留子目录层级**：`x-file-relative-path` 的目录前缀在会话上传目录内重建（如 `sub/dir/file.pdf`），相对路径净化（拒绝 `../` 与绝对路径），sha256 去重竞态有回退写入保护。

### 其他

- 上传端点与工作区索引端点共用 `trustedHosts` 语义，公网域名 / 反向隧道部署不再静默 403。
- 新增 workspace 回归测试（索引、忽略规则、symlink 跳过、maxDepth/maxFiles 上限）与图片原生路径的 client 侧分流测试；tsc 零错。

## 0.3.0

### 修复

- **read_document 不再拒绝 >64 KiB 文件**（#5）：此前用 64 KiB 上限做头部嗅探预读，而底层 `readBytes` 的 `maxBytes` 是整文件上限（超限直接抛 `FS_TOO_LARGE`），任何大文件都会在嗅探阶段被误拒。现改为一次读满 `maxFileBytes`，格式从缓冲前 64 KiB 截取判定。模型读取大 PDF/DOCX/XLSX 恢复正常。
- **公网域名 / 反向隧道部署下上传不再静默 403**（#6）：上传栅栏此前硬编码 loopback-only 且 Origin 比较完整 URL（含 scheme），`dsh web --trusted-host` 部署的 GUI 上传全部被拒且界面无提示。现支持 `trustedHosts` 配置（裸 host 匹配任意端口、`host:port` 精确匹配，与官方 `--trusted-host` 栅栏同语义，启动时校验条目），Origin 只比较 host 部分兼容上游终结 TLS；客户端 403 错误改为明确提示，不再被空 catch 吞掉。

### 新增

- **文件夹上传**（#1）：输入框工具栏新增文件夹按钮（`webkitdirectory` 目录选择），页面任意位置拖拽也支持文件夹（目录项递归展平，保留子目录文件）。
- **有界并发上传**：批量上传固定 4 路并发（与服务端 `maxConcurrentUploads` 默认值对齐），文件夹 / 多文件上传不再串行排队，也不触发 429；逐文件失败只记入错误提示，不阻塞其余文件。
- 回形针按钮保持文件多选能力不变（与文件夹按钮分离）。

### 其他

- 新增 guard 回归测试 12 项、read_document 64 KiB 回归测试 2 项，测试总数 78 项全过，tsc 零错。

## 0.2.0

- **@ 文件候选**：输入框输入 `@` 列出本会话已上传文件，选中插入路径引用，模型据此 `read_document`。
- **差异化输出预算**：单次输出窗口按格式分级（text 满额、xlsx 3/4、pdf/docx 1/2），超限截断并显式标记，降低上下文 token 占用。
- **解析缓存键改内容 sha256**：文件内容变化必然失效（不再仅依赖文件版本）。
- **readTimeoutMs 可配置**：`read_document` 单次执行超时（默认 120s），大 PDF 解析不再依赖硬编码。
- **UTF-16 无 BOM 识别**：编码链（UTF-16 BOM → UTF-8 → GB18030 → UTF-16 无 BOM）补全，中文 GBK 与无 BOM UTF-16 文件均可读。
- **上传增强**：readHint 体量提示（cost / estimatedChars）、emoji 文件名按码点截断（不切出孤立代理）、sha256 内容去重竞态修复、413 提前拒绝并排空请求体（keep-alive 不挂起）。
- **网络栅栏与配额**：loopback + same-origin + sec-fetch-site 三重校验；会话存储配额（超限 507）；未知会话 403；并发限流（默认 4）超限 429。
- **XLSX sheet 级读取**：`sheet` 参数返回指定工作表全量，`list_sheets` 先列全部 sheet 名，越界报错附可用列表。
- **整页拖拽上传**：页面任意位置拖拽文件上传，悬停遮罩提示。
- **文件名净化**：按 UTF-8 字节截断并保留扩展名，长中文名不触发 ENAMETOOLONG。

## 0.1.0

- 首版：Web UI 回形针上传 + 模型读文档（text / PDF / DOCX / XLSX）。
- 内容嗅探 + LRU 缓存。
