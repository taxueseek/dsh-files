# dsh-files

DeepSeek Harness 双面插件：一个包、一行 cordis 配置，提供「文件上传」「长文本粘贴转文件」与「文档读取」三项能力。

- **上传**：回形针按钮 + 浮动彩色卡片，发送时自动附入文件路径；按会话隔离存储，TTL 清扫，sha256 去重
- **长文本粘贴转文件**：粘贴长文本自动拦截，一键保存为会话内文件并以引用随消息发出，模型按需 `read_document` 读取
- **文档读取**：`read_document` 工具读取文本 / PDF / DOCX / XLSX，内容嗅探不信任扩展名，LRU 缓存

## 功能

- 会话隔离：文件存到 `<会话工作区>/.dsh-filess/<sessionId>/`，agent 一定能读到，会话间不可见
- 卡片 UI：按扩展名着色角标（PDF 红 / DOC 蓝 / XLS 绿 / TXT 灰 / ZIP 紫）、文件名、大小、移除按钮
- 粘贴转文件：composer 粘贴 ≥ `pasteMinChars`（默认 4000）字符弹确认卡，保存到会话工作区并插入路径引用
- 内容嗅探：PDF 头 / ZIP 中央目录 / UTF-8 / UTF-16 / GB18030 从字节判定，伪装扩展名拒绝
- 分页读取：行号 + offset/limit，长文档按需翻页
- LRU 缓存：条目数 + 字节预算双约束，文件改动自动失效
- XLSX 多 sheet 合并，截断显式标记
- 大小预检：超限不读字节

## 安全

- 解析库均为维护中无已知漏洞：`pdfjs-dist` / `mammoth` / `read-excel-file`
- ZIP 探测不展开成员，成员数与名称长度有上限
- 文件读取走 `ctx.fs`，继承沙箱与观察策略

## 安装

```sh
dsh plugin --profile web add dsh-files
# 重启 dsh web
```

## 开发

```sh
pnpm install
pnpm test          # 45 项单元测试
pnpm build         # 构建客户端 bundle
npx tsc --noEmit   # 类型检查
```

完整配置项见 `README.md`。MIT 许可。
