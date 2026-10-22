<h1 align="center">「观」</h1>
<p align="center"><strong>Server Observer</strong></p>
<p align="center">把分散的服务，放进同一个安静的窗口。</p>
<p align="center">macOS · Electron · Docker · SSH · ASCII</p>

---

观是一款 macOS 个人服务监测 App。连接本机 Docker 或通过 SSH 访问的 Docker，把容器运行情况、自然语言业务状态和日志放在一起。

它适合常开的小主机，也适合想随时看一眼自己的服务有没有正常工作的你。

## 一眼看清，按需展开

- **四个可替换槽位**：四列、四宫格、一大三小，在系统「视图」菜单切换。
- **服务可以跨容器、跨设备**：标题交代设备与成员，资源指标简洁呈现，详细信息按需展开。
- **业务先于日志**：宽卡可以并排；窄卡以「业务／日志」切换，避免长句挤在细栏里。
- **当前与历史分开**：独立显示最近采集时间，保留事件原有日期；读取失败会明确提示上次结果。
- **ASCII 动态背景**：双手接近、触碰、消散，支持亮度调整、静态与减少动态效果。

目前有论文回执、RAGFlow、Quant PostgreSQL、Tailscale、证书和 OpenResty 等专用读取器，也支持已登记的 HTTP 状态源。**容器可被发现，不代表业务进度会自动出现**：业务状态需要匹配服务自己的数据来源与读取合同。

## 快速启动

需要 macOS、Node.js **24.22.0** 和 npm **11.6–11.x**。Docker 与 SSH 仅在添加相应设备时需要。

```bash
git clone https://github.com/XingjianTian/View.git
cd View
npm ci
npm run dev
```

首次使用，在「观 → 设置」登记放在仓库外的连接资料，再添加设备、服务和容器成员，选入面板。刷新使用 `⌘R`，设置使用 `⌘,`，布局使用 `⌘1` / `⌘2` / `⌘3`。

```bash
npm run typecheck
npm test
npm run build
npm run package -- --platform=darwin --arch=arm64
npm run verify:package
```

打包结果位于 `out/`。项目暂未提供签名、公证、自动更新或安装包发布流程。

## 配置留在本地

默认数据目录为 `~/Library/Application Support/ServiceObservatory`。真实 SSH profile、认证资料、状态源登记与设备配置保存在本机，不随源码分发。

`.env.example` 只说明现有环境变量。**普通 `npm run dev` 不自动加载 `.env`**；若需要独立的数据目录，可复制模板并显式加载：

```bash
cp .env.example .env
# 编辑为一个绝对路径，再执行：
node --env-file=.env scripts/dev.mjs
```

连接资料示例与登记步骤见 [配置说明](docs/configuration.md)。业务来源仍需按实际部署核对；这里没有可直接连接个人服务器的预设。

## 提交前检查

```bash
brew install gitleaks
npm run hooks:install
npm run privacy:check
```

本地钩子检查暂存内容及待推送提交，CI 补充类型、单测与秘密扫描。真实 `.env`、私有 profile、数据库、日志、内部操作记录和备份默认不允许入库。可用本机的 `.privacy.local.json` 登记额外的私有文件用于精确比对，该文件也不会提交。详见 [隐私检查](docs/privacy.md)。

## 当前边界

观负责读取与展示，不提供启动任务、续期证书、重载代理或修改生产服务的控制入口。来源可能缺少历史、心跳或失败详情；此时保留未知、部分覆盖或读取错误，不把容器健康写成任务成功。

完整入库进展与部分超时诊断仍在完善。代理 TLS 可达不等于全部应用上游健康，证书有效也不等于刚刚续期成功。

依赖及素材说明见 [第三方声明](THIRD_PARTY_NOTICES.md)。当前未指定项目级开源许可证。
