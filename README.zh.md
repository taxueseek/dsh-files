<p align="center">
  <img src="assets/readme/hero.svg" width="100%" alt="dsh-files：一个包。Web UI 回形针上传，模型读文档。">
</p>

# dsh-files

一个包，一行 cordis 配置。Web UI 多一个回形针，模型多一个读文档的工具。

<p align="center">
  <img src="assets/composer.png" alt="DeepSeek Harness 输入框里的回形针上传按钮与彩色文件卡片" width="900">
</p>

DeepSeek Harness 双面插件。两项能力：

- **上传**：回形针按钮 + 浮动彩色卡片，发送时自动附入文件路径；按会话隔离存储，TTL 清扫，sha256 去重
- **文档读取**：`read_document` 工具读取文本 / PDF / DOCX / XLSX，内容嗅探不信任扩展名，LRU 缓存

## 功能

- 会话隔离：文件存到 `<会话工作区>/.dsh-filess/<sessionId>/`，agent 一定能读到，会话间不可见
- 两种入口：回形针按钮选择，或拖拽到页面任意位置上传（悬停有遮罩提示）
- 卡片 UI：按字节嗅探的真实格式着色角标（伪装文件不按扩展名显示）、文件名、大小、移除按钮
- 内容嗅探：PDF 头 / ZIP 中央目录 / UTF-8 / UTF-16 / GB18030 从字节判定，伪装扩展名拒绝
- 分页读取：行号 + offset/limit，长文档按需翻页；窗口总字符预算超限时截断并显式标记；PDF/DOCX/XLSX 段落流不带行号（省 token）
- XLSX sheet 级读取：`sheet` 参数返回指定工作表全量，其余 sheet 合并 + 截断显式标记；`list_sheets` 先列全部 sheet 名，越界报错附可用列表
- 扫描件明示：无文本层 PDF 返回提示而非空串
- LRU 缓存：条目数 + 字节预算双约束，文件改动自动失效
- 大小预检：超限不读字节
- 会话存储配额：可选，超限 507
- 协作取消：解析期间监听执行信号，取消即中止

## 安全

- 解析库均为维护中无已知漏洞：`pdfjs-dist` / `mammoth` / `read-excel-file`
- ZIP 探测不展开成员，成员数与名称长度有上限
- 文件读取走 `ctx.fs`，继承沙箱与观察策略
- 上传栅栏：loopback 或 `trustedHosts` 白名单 host + same-origin + sec-fetch-site；Origin 只比较 host 部分，兼容上游终结 TLS 的反向代理/隧道部署（配置见 `README.md`）

## 安装

```sh
dsh plugin --profile web add dsh-files
# 重启 dsh web
```

## 开发

```sh
pnpm install
pnpm test          # 57 项单元测试
pnpm build         # 构建客户端 bundle
npx tsc --noEmit   # 类型检查
```

完整配置项见 `README.md`。MIT 许可。
