# dsh-files

DeepSeek Harness 双面插件（dual-face plugin）：一个包、一行 cordis 配置，为 Web UI 提供「文件上传」「长文本粘贴转文件」与「文档读取」三项能力。

- **上传**：输入框工具栏回形针按钮，文件以浮动彩色卡片呈现，发送时自动把路径附入消息；按会话隔离存储到 `<会话工作区>/.dsh-filess/<sessionId>/`，TTL 定期清扫，sha256 内容去重
- **长文本粘贴转文件**：在输入框粘贴超过阈值的长文本时自动拦截，一键保存为会话内文件并把路径作为引用随消息发出，模型按需用 `read_document` 读取，避免长文本膨胀上下文
- **文档读取**：`read_document` 工具读取文本 / PDF / DOCX / XLSX，内容嗅探判定真实格式（不信任扩展名），大小预检，LRU 解析缓存

## 功能

### 上传

- 会话隔离存储：文件落在发起会话自己的工作区 `.dsh-filess/<sessionId>/` 下，agent 的 fs 后端一定能读到；会话之间互不可见
- 浮动彩色卡片：按扩展名着色（PDF 红 / DOC 蓝 / XLS 绿 / TXT 灰 / ZIP 紫），显示文件名、大小、移除按钮，支持多文件横排
- 发送联动：卡片挂载后文件路径自动注入输入框，随消息发出
- 安全护栏：loopback host + same-origin + sec-fetch-site 三重校验；文件名消毒（控制字符、路径分隔、点段、前导点全部剥离）；未知会话 403；并发限流（默认 4）超限 429
- 生命周期管理：TTL 清扫（默认 7 天），空会话目录自动回收

### 长文本粘贴转文件

- 拦截条件：在 composer 内粘贴的纯文本达到 `pasteMinChars`（默认 4000 字符）即弹出「保存为文件 / 仍作为文本粘贴」确认卡
- 保存落盘：文本经 `POST /api/paste-text` 写入发起会话的工作区 `.dsh-filess/<sessionId>/`，内容寻址（sha256）去重，字节上限 `pasteMaxBytes`（默认 8 MB）
- 引用联动：保存后输入框插入文件路径引用，随消息发出；模型用 `read_document` 按需读取，长文本不再整体进入上下文
- 安全同上传：loopback host + same-origin + sec-fetch-site 校验，未知会话 403，文件名消毒
- 阈值可调：浏览器 `localStorage.setItem('dsh.files.pasteMinChars', '8000')` 可覆盖默认触发阈值

### 文档读取

- 内容嗅探：PDF 头 / ZIP 中央目录成员 / UTF-8 / UTF-16 BOM / GB18030，全部从字节判定，扩展名伪装（可执行文件、图片改成 .pdf）一律拒绝
- 编码链：UTF-16 BOM → UTF-8（fatal）→ GB18030（fatal），中文 GBK 文件可直接读取
- 分页读取：行号 + offset/limit 分页，长文档按需翻页
- 解析缓存：LRU 双约束（条目数 + 字节预算），键为 `(targetKey, fileVersion, format)`，文件改动自动失效
- XLSX 多 sheet：合并读取（默认前 5 个 sheet），截断显式标记，模型不会把部分表格误当全量
- 大小预检：`stat` 先查，超限直接报 `FS_TOO_LARGE`，不读字节

## 安全

- 解析依赖全部为无已知漏洞的维护中库：`pdfjs-dist`（Mozilla 官方）、`mammoth`、`read-excel-file`（纯只读）
- ZIP 中央目录探测不展开任何成员，成员数与成员名长度均有上限，恶意归档安全拒绝
- 文件读取走 `ctx.fs`，继承会话沙箱与 fs 观察策略，与内置 read 工具同权
- 上传内容不做格式白名单强制（默认全允许），由会话沙箱兜底

## 安装

```sh
dsh plugin --profile web add dsh-files
# 重启 dsh web
```

## 配置

```yaml
- id: upload-toolkit
  name: 'dsh-files'
  config:
    maxFileBytes: 25165824        # 单次文档读取字节上限
    readLimit: 2000               # 单次返回行数上限
    sheetRowLimit: 200            # 每个 sheet 保留行数
    maxSheets: 5                  # 每个工作簿读取的 sheet 数
    cacheEntries: 16              # 解析缓存条目数
    cacheMaxBytes: 67108864       # 解析缓存字节预算
    uploadMaxBytes: 25165824      # 单次上传字节上限
    allowedExtensions: []         # 上传扩展名白名单（空 = 全部允许）
    uploadTtlMs: 604800000        # 上传文件保留时长（7 天）
    sweepIntervalMs: 3600000      # 清扫间隔
    maxConcurrentUploads: 4       # 并发上传数
    uploadDir: /abs/path          # 无 sessions 服务时的回退上传根目录
    pasteMaxBytes: 8388608        # 单次粘贴文本 UTF-8 字节上限
    pasteMinChars: 4000           # 触发「保存为文件」的粘贴字符阈值
```

## 开发

```sh
pnpm install
pnpm test          # node --test 单元测试（45 项）
pnpm build         # esbuild 打包客户端 bundle
npx tsc --noEmit   # 类型检查
```

## 许可

MIT
