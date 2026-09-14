# gpt-auto AI 项目记忆入口

## 项目是什么

gpt-auto 当前是公司内部 GPT 车队图片生成网页项目，目标网址是 `temu.yunxi.io`，当前已完成本地版本并完成 GitHub 远程备份。

## 当前项目目标

- 做一个内部网页，用于选择车队并生成图片；
- 支持单张聊天式图片生成；
- 支持批量素材图片自动生成；
- 已购买主域名 `yunxi.io`，后续上线网址以二级域名 `temu.yunxi.io` 为准；
- 后续如上线到 `temu.yunxi.io`，必须另行经过负责人批准。

## 已完成功能

- 车队选择；
- 单张聊天式图片生成；
- `DEMO_IMAGE_MODE` 演示模式；
- 内部访问码登录/会话；
- 非敏感运行记录；
- 批量素材图片自动生成本地第一版。

## 当前版本状态

- 批量出图本地第一版已开发完成、审核通过、版本确认完成；
- 已在 `D:\OrcaWorkspace\gpt-auto` 完成本地 Git 初始化；
- 首次提交短哈希：`b401f47`；
- 第二次文档提交短哈希：`7848732`；
- 最新提交：`6e2a4c8 chore: ignore local claude metadata`；
- 当前工作区干净；
- 已绑定远程仓库并完成 push 备份；
- 远程仓库：`https://github.com/jiarong3607-commits/YX-GPT-AUTO.git`；
- 分支：`main`；
- 用户已在本机 PowerShell 完成浏览器认证并成功执行 `git push -u origin main`；
- 远程新建 `main` 分支，`main` 已 set up to track `origin/main`；
- 未创建 PR；
- 未发布，未上线；
- 未写真实密钥或生产配置。

## 安全状态

此前检查未发现真实 `OPENAI_API_KEY`、`INTERNAL_ACCESS_CODE`、Cookie、Token、Secret、账号密码、真实图片内容或完整提示词残留。

`.gitignore` 已覆盖：

- `.claude/`；
- `.env`；
- `data/`；
- `outputs/`；
- `node_modules/`；
- `*.log`。

## 当前待负责人决定

- 是否创建 PR；
- 是否部署 `temu.yunxi.io`；
- 已确认部署平台/服务器使用 Cloudflare；
- DNS 管理位置和配置权限；
- HTTPS/SSL 证书方案；
- 是否接入生产 Secret；
- 后续访问控制规则；
- 批量生成成本上限、限速和失败重试规则；
- 日志和运行数据保存规则；
- 回滚方案和故障处理；
- 是否继续增强批量功能。

上线前详细确认清单见：`产品助理/需求/temu.yunxi.io上线前负责人确认清单.md`。

## 明确不做

- 不做广告；
- 不做支付；
- 不做积分；
- 不做订阅；
- 不做定价 / 套餐；
- 不做营销增长；
- 不做公开用户注册。

## 重要提醒

本页是项目记忆入口，不代表当前 PR、部署、账号可用性、配额或线上运行状态。执行前必须重新核验动态事实。

## 最后更新时间

2026-09-11
