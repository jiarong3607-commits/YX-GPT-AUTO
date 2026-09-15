# GPT 车队图片生成网页结课作业

这是一个轻量级课程作业原型：用户先选择“车队”，再进入 GPT 图片生成工作台，支持单张聊天式生成和本地第一版批量素材图片自动生成。

> 说明：项目不实现真实 GPT 账号/密码共享，避免泄露账号或违反平台规则。这里的“车队”是前端展示和路由概念，后端统一使用你自己的 OpenAI API Key。

## 功能

- 内部访问验证：使用服务端 `INTERNAL_ACCESS_CODE` 放行内部人员
- 车队选择首页：展示多个车队、状态、余量和特色
- 单张聊天式图片生成：输入提示词、选择尺寸/质量/风格
- 批量素材生成：选择素材图文件夹、底板图文件夹、提示词 txt，按顺序生成并保存结果
- 后端通过服务端 OpenAI provider router 调用 Images API，避免在浏览器暴露 API Key
- 最小运行状态记录：保存请求时间、车队、图片参数、素材名、底板名、输出路径、提示词长度、成功/失败、错误类型和非敏感 provider ID
- 仅记录非敏感状态，不保存完整提示词、图片内容、账号密码、Cookie、Token、API Key 或 Secret
- 无外部数据库依赖，默认用 `data/runtime-events.jsonl` 做本地 JSONL 记录，适合结课演示和二次扩展

## 运行

1. 安装 Node.js 18 或更高版本
2. 复制环境变量文件：

```bash
cp .env.example .env
```

3. 编辑 `.env`，至少填入内部访问码：

```env
INTERNAL_ACCESS_CODE=替换为内部访问码
```

4. 如需真实生成图片，继续填入自己的 `OPENAI_API_KEY`；多项目配置见下一节
5. 启动服务：

```bash
npm run dev
```

6. 打开浏览器访问：

```text
http://localhost:3000
```

## 没有 API Key 时演示

如果只是课堂展示前后端流程，可以在 `.env` 中设置：

```env
DEMO_IMAGE_MODE=true
```

开启后，后端会返回本地占位图片，不会调用外部接口，也不需要真实 API Key。正式演示真实生成能力时，请关闭演示模式并配置 `OPENAI_API_KEY`。

## OpenAI 多项目服务端路由

默认保持单键兼容：未设置 `OPENAI_PROVIDER_ORDER` 时，服务只读取 `OPENAI_API_KEY`，行为与原版本一致。

如需使用多个已获授权的 OpenAI API 项目，在**仅存在于服务端**的 `.env` 或部署平台 Secret 中配置：

```env
OPENAI_PROVIDER_ORDER=primary,secondary
OPENAI_PROVIDER_PRIMARY_API_KEY=服务端密钥
OPENAI_PROVIDER_PRIMARY_ENABLED=true
OPENAI_PROVIDER_PRIMARY_MAX_REQUESTS=100
OPENAI_PROVIDER_PRIMARY_COOLDOWN_MS=60000
OPENAI_PROVIDER_SECONDARY_API_KEY=服务端密钥
OPENAI_PROVIDER_SECONDARY_ENABLED=true
OPENAI_PROVIDER_SECONDARY_MAX_REQUESTS=100
OPENAI_PROVIDER_SECONDARY_COOLDOWN_MS=60000
```

- `OPENAI_PROVIDER_ORDER` 决定优先顺序；provider ID 只能使用小写字母、数字和下划线。
- 设置该变量后进入多项目模式，**仅**使用其中列出的、已启用且已配置密钥的 provider，不会回退到 `OPENAI_API_KEY`；名称不合法或未配置可用 provider 时会安全失败。
- 只有明确的上游 HTTP `429` 或 `5xx` 会使当前 provider 在冷却期内熔断，并依次尝试下一个可用 provider。
- 网络超时、连接中断或其他未取得 HTTP 响应的结果不透明失败绝不自动切换，避免一次请求被重复出图收费。
- `MAX_REQUESTS` 是单次 Node 进程内的请求上限，`0` 表示不限；计数器和熔断状态重启后清零。它不是跨实例的限流、配额或成本控制替代方案。
- provider 状态和运行记录只包含 provider ID、HTTP 状态和故障切换次数；不会记录、返回或打印 API Key。

## 批量素材图片自动生成

第一版批量流程：

1. 登录内部访问页
2. 选择车队并进入图片生成工作台
3. 切换到“批量素材生成”
4. 选择素材图文件夹，按文件名顺序处理，默认最多 10 张
5. 选择底板图文件夹，第一版只使用 1 张底板图；如果文件夹里有多张，页面下拉框选择本次使用的一张
6. 选择提示词 txt 文件
7. 可填写结果目录标识，例如 `course-demo`
8. 点击“读取并预估”查看数量，再点击“开始批量生成”并确认
9. 页面实时显示总数、当前进度、成功/失败和输出目录

### 生成数量规则

- 程序会从提示词 txt 中尝试解析数量，例如：`每张生成 2 张`、`生成数量：2`、`count=2`
- 如果无法可靠解析数量，安全默认每张素材生成 1 张，并在页面提示
- 默认安全上限：每张素材最多 4 张、总输出最多 30 张、素材最多 10 张
- 失败时记录错误并跳过，继续下一张素材或下一次生成

### 输出保存规则

浏览器不能稳定授权网页任意写入本地文件夹，所以第一版使用后端保存目录：

```text
outputs/日期时间-标识-批次ID/
```

结果文件名规则：

```text
素材名_底板名_序号.png
```

如遇同名文件，会自动追加 `-2`、`-3`，避免覆盖已有结果。`outputs/` 已被 `.gitignore` 忽略，避免误提交生成图片。

## Secret 和访问控制方案

- 真实 `OPENAI_API_KEY`、`OPENAI_PROVIDER_<ID>_API_KEY` 和 `INTERNAL_ACCESS_CODE` 只能放在本地 `.env`、部署平台环境变量或公司批准的 Secret 管理位置
- `.env` 已被 `.gitignore` 忽略，不应提交到仓库
- 前端不会读取或展示 API Key、访问码、Cookie 或 Session Token
- 后端只使用 HttpOnly Cookie 保存临时会话标识，内存中保存会话状态，重启服务后会话失效
- 日志和本地运行记录只保存非敏感字段，不保存完整提示词、图片内容或任何明文凭证

## 最小运行状态记录

默认写入：

```text
data/runtime-events.jsonl
```

每条记录只包含：

- 请求时间
- 单张/批量事件类型
- 选择的车队，或批量任务 ID
- 素材名、底板名和输出路径
- 图片参数：尺寸、质量、风格
- 提示词长度
- 成功/失败
- 错误类型
- 模式：demo 或 openai
- provider ID、上游 HTTP 状态和故障切换次数（均不含密钥）

## 项目结构

```text
.
├── server.mjs          # Node 后端，提供静态文件、内部访问验证、单张和批量图片生成 API
├── openai-provider-router.mjs # OpenAI 多项目服务端路由与内存保护状态
├── public/
│   ├── index.html      # 页面结构
│   ├── styles.css      # 页面样式
│   └── app.js          # 前端交互逻辑
├── data/               # 本地非敏感运行状态记录，已被 git 忽略
├── outputs/            # 批量生成结果，已被 git 忽略
├── .env.example
├── .gitignore
└── package.json
```

## 结课展示建议

- 先输入内部访问码进入车队池
- 首页演示“车队池”入口设计
- 单张模式输入中文提示词，例如：
  - `一辆赛博朋克风格的蓝色超级跑车，夜晚城市街道，电影光效`
  - `可爱的熊猫宇航员站在月球上，背景是地球，3D 插画风格`
- 批量模式准备素材图文件夹、底板图文件夹和提示词 txt，例如：`每张生成 1 张，保持素材主体，融合到底板场景中`
- 讲解安全设计：API Key 只放后端，前端不保存账号密码
- 展示侧边栏“运行状态”：当前车队、生成状态、最近动作、错误提示和输出路径
- 展示 `data/runtime-events.jsonl` 只记录非敏感运行结果，不记录完整提示词、图片内容或凭证
