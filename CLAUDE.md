# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

这个文件为 Claude Code (claude.ai/code) 提供在此代码库中工作的指导。

## 项目概述

Claude Relay Service 是一个功能完整的 AI API 中转服务，支持 Claude 和 Gemini 双平台。提供多账户管理、API Key 认证、代理配置和现代化 Web 管理界面。该服务作为客户端（如 SillyTavern、Claude Code、Gemini CLI）与 AI API 之间的中间件，提供认证、限流、监控等功能。

### 技术栈

**后端核心技术**:
- **Node.js**: 主要运行环境 (v18+)
- **Express.js**: Web框架，提供路由和中间件支持
- **Redis**: 主要数据存储，用于会话、缓存和统计数据
- **Winston**: 日志系统，支持多级别和文件轮转
- **ioredis**: Redis客户端，支持管道操作和集群
- **http-proxy-middleware**: 请求代理中间件
- **jsonwebtoken**: JWT token处理
- **crypto**: 内置加密模块，用于数据加密和哈希

**前端技术栈**:
- **Vue 3**: 前端框架 (Composition API)
- **Vite**: 构建工具和开发服务器
- **Tailwind CSS**: 原子化CSS框架
- **Pinia**: 状态管理 (Vue生态系统官方推荐)
- **Axios**: HTTP客户端
- **Chart.js**: 数据可视化

**开发工具链**:
- **ESLint**: 代码质量检查
- **Prettier**: 代码格式化
- **Jest + SuperTest**: 测试框架
- **Nodemon**: 开发时热重载
- **chokidar**: 文件系统监控

**部署和运维**:
- **Docker + Docker Compose**: 容器化部署
- **PM2**: 进程管理 (生产环境)
- **nginx**: 反向代理 (可选)
- **Prometheus + Grafana**: 监控系统 (可选)

## 核心架构

### 关键架构概念

- **代理认证流**: 客户端用自建API Key → 验证 → 获取Claude账户OAuth token → 转发到Anthropic
- **Token管理**: 自动监控OAuth token过期并刷新，支持10秒提前刷新策略
- **代理支持**: 每个Claude账户支持独立代理配置，OAuth token交换也通过代理进行
- **数据加密**: 敏感数据（refreshToken, accessToken）使用AES加密存储在Redis

### 主要服务组件

**核心服务层** (`src/services/`):
- **claudeRelayService.js**: 核心代理服务，处理请求转发和流式响应
- **claudeAccountService.js**: Claude账户管理，OAuth token刷新和账户选择
- **geminiAccountService.js**: Gemini账户管理，Google OAuth token刷新和账户选择
- **apiKeyService.js**: API Key管理，验证、限流和使用统计
- **oauthHelper.js**: OAuth工具，PKCE流程实现和代理支持
- **systemService.js**: 系统状态监控和健康检查
- **usageService.js**: 使用统计的收集、存储和分析

**代理连接池系统** (`src/services/`):
- **globalConnectionPoolManager.js**: 全局连接池管理器，统一管理所有账户的连接池
- **hybridConnectionManager.js**: 混合连接管理器，事件驱动监控和定期健康检查
- **smartConnectionPool.js**: 智能连接池，为单个账户管理预热代理连接
- **connectionLifecycleManager.js**: 连接生命周期管理器，连接老化和自动轮换

**中间件层** (`src/middleware/`):
- **authenticate.js**: API Key认证和会话验证
- **rateLimiter.js**: 基于Redis的智能限流
- **errorHandler.js**: 统一错误处理和响应格式化
- **requestLogger.js**: 请求日志记录和性能监控
- **cors.js**: 跨域资源共享配置

**路由层** (`src/routes/`):
- **api.js**: 主要API端点 (/api/v1/*)
- **admin.js**: 管理界面API (/admin/*)
- **auth.js**: 认证相关端点
- **claude.js**: Claude特定的管理端点
- **gemini.js**: Gemini特定的管理端点

**工具层** (`src/utils/`):
- **logger.js**: Winston日志系统，支持文件监控
- **encryption.js**: AES加密/解密工具
- **validation.js**: 数据验证和格式化
- **httpUtils.js**: HTTP请求工具，支持代理
- **cacheManager.js**: LRU缓存管理
- **retryUtils.js**: 指数退避重试机制

### 认证和代理流程

1. 客户端使用自建API Key（cr\_前缀格式）发送请求
2. authenticateApiKey中间件验证API Key有效性和速率限制
3. claudeAccountService自动选择可用Claude账户
4. 检查OAuth access token有效性，过期则自动刷新（使用代理）
5. 移除客户端API Key，使用OAuth Bearer token转发请求
6. 通过账户配置的代理发送到Anthropic API
7. 流式或非流式返回响应，记录使用统计

### OAuth集成

- **PKCE流程**: 完整的OAuth 2.0 PKCE实现，支持代理
- **自动刷新**: 智能token过期检测和自动刷新机制
- **代理支持**: OAuth授权和token交换全程支持代理配置
- **安全存储**: claudeAiOauth数据加密存储，包含accessToken、refreshToken、scopes

### 代理连接池系统

**系统架构**:
- **四层架构设计**: 全局管理器 → 混合监控器 → 智能连接池 → 生命周期管理器
- **事件驱动机制**: 基于EventEmitter实现连接状态变化的实时响应
- **预热连接策略**: 每个Claude账户预热3个代理连接，显著降低请求延迟
- **自动故障恢复**: 连接断开时1-3秒内完成重连，保持服务连续性

**核心特性**:
- **智能连接池** (SmartConnectionPool): 为单个账户管理预热的SOCKS5/HTTP代理连接
- **全局池管理器** (GlobalConnectionPoolManager): 统一初始化和管理所有账户的连接池
- **混合连接管理器** (HybridConnectionManager): 结合事件驱动和定期检查的混合监控
- **连接生命周期管理** (ConnectionLifecycleManager): 连接老化检测和自动轮换机制

**性能优化**:
- **延迟降低**: 从冷连接的1.7秒降低到预热连接的50-200ms
- **并发支持**: 每个账户支持3个并发连接，支持高并发API请求
- **负载均衡**: 连接池内连接轮转使用，分散代理服务器负载
- **资源管理**: 智能连接复用和自动清理，防止资源泄漏

**监控和健康检查**:
- **实时监控**: 连接状态、错误率、平均延迟的实时跟踪
- **健康检查**: 5分钟定期健康检查 + 30秒性能监控
- **状态端点**: `/connection-pools` 提供详细的连接池状态信息
- **事件通知**: 连接建立、断开、错误、重连的完整事件链

## 常用命令

### 基本开发命令

````bash
# 安装依赖和初始化
npm install
npm run setup                  # 生成配置和管理员凭据
npm run install:web           # 安装Web界面依赖

# 开发和运行
npm run dev                   # 开发模式（热重载）
npm start                     # 生产模式
npm test                      # 运行测试
npm run lint                  # 代码检查

# Docker部署
docker-compose up -d          # 推荐方式
docker-compose --profile monitoring up -d  # 包含监控

# 服务管理
npm run service:start:daemon  # 后台启动（推荐）
npm run service:status        # 查看服务状态
npm run service:logs          # 查看日志
npm run service:stop          # 停止服务

### 开发环境配置

**必须配置的环境变量**:
- `JWT_SECRET`: JWT密钥（32字符以上随机字符串）
- `ENCRYPTION_KEY`: 数据加密密钥（32字符固定长度）
- `API_KEY_SALT`: API Key哈希盐值（独立于数据加密）
- `REDIS_HOST`: Redis主机地址（默认localhost）
- `REDIS_PORT`: Redis端口（默认6379）
- `REDIS_PASSWORD`: Redis密码（可选）
- `REDIS_DB`: Redis数据库编号（默认0）

**可选配置环境变量**:
- `PORT`: 服务端口（默认3000）
- `NODE_ENV`: 运行环境（development/production）
- `LOG_LEVEL`: 日志级别（debug/info/warn/error）
- `ENABLE_REQUEST_LOGGING`: 是否启用请求日志（true/false）
- `CACHE_TTL`: 缓存过期时间（秒，默认3600）
- `MAX_RETRIES`: 最大重试次数（默认3）
- `PROXY_TIMEOUT`: 代理请求超时（毫秒，默认30000）

**配置文件结构**:
```
config/
├── config.js              # 主配置文件
├── config.example.js      # 配置模板
├── database.js           # Redis配置
├── security.js           # 安全相关配置
└── development.js        # 开发环境特定配置
```

**初始化命令**:
```bash
# 复制配置文件
cp config/config.example.js config/config.js
cp .env.example .env

# 安装依赖
npm install

# 自动生成密钥并创建管理员账户
npm run setup

# 安装前端依赖（可选）
npm run install:web
````

## Web界面功能

### OAuth账户添加流程

1. **基本信息和代理设置**: 配置账户名称、描述和代理参数
2. **OAuth授权**:
   - 生成授权URL → 用户打开链接并登录Claude Code账号
   - 授权后会显示Authorization Code → 复制并粘贴到输入框
   - 系统自动交换token并创建账户

### 核心管理功能

- **实时仪表板**: 系统统计、账户状态、使用量监控
- **API Key管理**: 创建、配额设置、使用统计查看
- **Claude账户管理**: OAuth账户添加、代理配置、状态监控
- **系统日志**: 实时日志查看，多级别过滤
- **主题系统**: 支持明亮/暗黑模式切换，自动保存用户偏好设置

## 重要端点

### API转发端点

- `POST /api/v1/messages` - 主要消息处理端点（支持流式）
- `GET /api/v1/models` - 模型列表（兼容性）
- `GET /api/v1/usage` - 使用统计查询
- `GET /api/v1/key-info` - API Key信息

### OAuth管理端点

- `POST /admin/claude-accounts/generate-auth-url` - 生成OAuth授权URL（含代理）
- `POST /admin/claude-accounts/exchange-code` - 交换authorization code
- `POST /admin/claude-accounts` - 创建OAuth账户

### 系统端点

- `GET /health` - 健康检查（包含连接池状态）
- `GET /web` - Web管理界面
- `GET /admin/dashboard` - 系统概览数据

### 连接池监控端点

- `GET /connection-pools` - 连接池详细状态监控
  - 全局连接池管理器状态
  - 混合连接管理器监控报告
  - 连接生命周期管理器统计
  - 所有账户连接池的健康状态
- `GET /health` - 健康检查中的connectionPools组件
  - 连接池系统总体健康状态
  - 总连接数和健康连接数
  - 混合管理器运行状态

## 故障排除

### OAuth相关问题

1. **代理配置错误**: 检查代理设置是否正确，OAuth token交换也需要代理
2. **授权码无效**: 确保复制了完整的Authorization Code，没有遗漏字符
3. **Token刷新失败**: 检查refreshToken有效性和代理配置

### Gemini Token刷新问题

1. **刷新失败**: 确保 refresh_token 有效且未过期
2. **错误日志**: 查看 `logs/token-refresh-error.log` 获取详细错误信息
3. **测试脚本**: 运行 `node scripts/test-gemini-refresh.js` 测试 token 刷新

### 常见开发问题

**Redis相关问题**:
1. **连接失败**: 确认Redis服务运行，检查`REDIS_HOST`和`REDIS_PORT`配置
2. **认证失败**: 检查`REDIS_PASSWORD`设置，确保与Redis配置匹配
3. **数据丢失**: 检查Redis持久化配置，确保RDB/AOF启用
4. **性能问题**: 监控Redis内存使用，考虑配置`maxmemory-policy`

**认证和授权问题**:
1. **管理员登录失败**: 运行`npm run setup`重新初始化管理员账户
2. **JWT token过期**: 检查`JWT_SECRET`配置，确保服务重启后一致
3. **API Key无效**: 确保使用`cr_`前缀格式，检查哈希计算
4. **OAuth授权失败**: 验证授权码完整性，检查代理配置

**网络和代理问题**:
1. **代理连接超时**: 验证SOCKS5/HTTP代理地址和端口
2. **代理认证失败**: 检查代理用户名和密码配置
3. **请求被拒绝**: 检查目标服务的访问限制和IP白名单
4. **SSL/TLS错误**: 验证证书有效性，考虑禁用严格SSL检查（仅开发环境）

**服务启动问题**:
1. **端口占用**: 使用`lsof -i :3000`检查端口占用，修改PORT配置
2. **依赖缺失**: 运行`npm install`重新安装依赖
3. **权限问题**: 检查日志目录和文件的写入权限
4. **内存不足**: 监控系统资源使用，调整Node.js内存限制

**连接池系统问题**:
1. **混合连接管理器启动失败**: 检查SmartConnectionPool是否正确继承EventEmitter
2. **"pool.on is not a function"错误**: 确保连接池类实现了事件接口
3. **连接池未初始化**: 验证Claude账户配置和代理设置完整性
4. **连接创建失败**: 检查代理配置有效性和网络连通性
5. **连接池状态检查**: 访问`/connection-pools`端点查看详细状态
6. **健康检查**: 使用`curl http://localhost:3000/health`检查连接池组件状态
7. **性能监控**: 监控连接池延迟和错误率，优化代理配置
8. **连接池重建**: 连接池出现问题时可通过重启服务自动重建

**数据加密问题**:
1. **密钥长度错误**: 确保`ENCRYPTION_KEY`为32字符长度
2. **解密失败**: 检查密钥是否与加密时一致
3. **数据损坏**: 运行数据完整性检查脚本
4. **盐值问题**: 确保`API_KEY_SALT`独立配置

**性能问题诊断**:
```bash
# 检查系统资源
top -p $(pgrep node)

# 检查Redis性能
redis-cli --latency
redis-cli info memory

# 检查日志文件大小
du -h logs/

# 检查网络延迟
ping claude.ai
curl -w "@curl-format.txt" -o /dev/null -s https://api.anthropic.com/
```

### 调试工具

- **日志系统**: Winston结构化日志，支持不同级别
- **CLI工具**: 命令行状态查看和管理
- **Web界面**: 实时日志查看和系统监控
- **健康检查**: /health端点提供系统状态

## 开发最佳实践

### 代码格式化要求

- **必须使用 Prettier 格式化所有代码**
- 后端代码（src/）：运行 `npx prettier --write <file>` 格式化
- 前端代码（web/admin-spa/）：已安装 `prettier-plugin-tailwindcss`，运行 `npx prettier --write <file>` 格式化
- 提交前检查格式：`npx prettier --check <file>`
- 格式化所有文件：`npm run format`（如果配置了此脚本）

### 前端开发特殊要求

- **响应式设计**: 必须兼容不同设备尺寸（手机、平板、桌面），使用 Tailwind CSS 响应式前缀（sm:、md:、lg:、xl:）
- **暗黑模式兼容**: 项目已集成完整的暗黑模式支持，所有新增/修改的UI组件都必须同时兼容明亮模式和暗黑模式
  - 使用 Tailwind CSS 的 `dark:` 前缀为暗黑模式提供样式
  - 文本颜色：`text-gray-700 dark:text-gray-200`
  - 背景颜色：`bg-white dark:bg-gray-800`
  - 边框颜色：`border-gray-200 dark:border-gray-700`
  - 状态颜色保持一致：`text-blue-500`、`text-green-600`、`text-red-500` 等
- **主题切换**: 使用 `stores/theme.js` 中的 `useThemeStore()` 来实现主题切换功能
- **玻璃态效果**: 保持现有的玻璃态设计风格，在暗黑模式下调整透明度和背景色
- **图标和交互**: 确保所有图标、按钮、交互元素在两种模式下都清晰可见且易于操作

### 代码修改原则

- 对现有文件进行修改时，首先检查代码库的现有模式和风格
- 尽可能重用现有的服务和工具函数，避免重复代码
- 遵循项目现有的错误处理和日志记录模式
- 敏感数据必须使用加密存储（参考 claudeAccountService.js 中的加密实现）

### 测试和质量保证

**代码质量检查**:
```bash
# ESLint代码检查 - 检查语法和代码规范
npm run lint                    # 检查所有文件
npx eslint src/**/*.js         # 检查特定目录
npx eslint --fix src/          # 自动修复可修复的问题

# Prettier代码格式化 - 统一代码格式
npx prettier --check .         # 检查格式
npx prettier --write .         # 格式化所有文件
npx prettier --write src/      # 格式化特定目录
```

**测试框架配置** (Jest + SuperTest):
```bash
# 运行所有测试
npm test                       # 完整测试套件
npm run test:unit             # 单元测试
npm run test:integration      # 集成测试
npm run test:coverage         # 测试覆盖率报告
npm run test:watch            # 监听模式
```

**测试文件结构**:
```
tests/
├── unit/                     # 单元测试
│   ├── services/             # 服务层测试
│   ├── middleware/           # 中间件测试
│   └── utils/               # 工具函数测试
├── integration/             # 集成测试
│   ├── api/                 # API端点测试
│   └── auth/                # 认证流程测试
├── fixtures/                # 测试数据
└── helpers/                 # 测试工具
```

**功能验证**:
```bash
# CLI工具功能测试
npm run cli status            # 系统状态检查
npm run cli health            # 健康检查
npm run cli accounts list     # 账户列表检查

# 数据完整性检查
node scripts/data-integrity-check.js

# 服务连接测试
curl http://localhost:3000/health
curl http://localhost:3000/api/v1/models
```

**日志和监控检查**:
- 检查日志文件：`logs/claude-relay-*.log`、`logs/error.log`
- 监控Redis连接状态和数据完整性
- 验证OAuth token刷新机制
- 检查内存使用和性能指标

**CI/CD集成建议**:
- 预提交钩子：格式化 → Lint → 单元测试
- 构建流水线：依赖安装 → 测试 → 构建 → 部署
- 代码覆盖率：目标80%以上测试覆盖率
- 自动化部署：通过健康检查后自动部署

### 开发工作流

**1. 开发环境启动**:
```bash
# 启动Redis（如果未运行）
redis-server

# 启动开发服务器（热重载）
npm run dev

# 启动前端开发服务器（可选）
cd web/admin-spa && npm run dev
```

**2. 功能开发流程**:
- **需求分析**: 理解功能需求，确定影响范围
- **代码审查**: 熟悉相关现有代码，理解设计模式
- **架构设计**: 选择合适的服务层和中间件
- **编码实现**: 遵循现有代码风格和命名约定
- **单元测试**: 编写对应的测试用例
- **集成测试**: 验证与其他组件的交互

**3. 调试和验证**:
```bash
# 日志监控（实时）
tail -f logs/claude-relay-combined.log
tail -f logs/error.log

# Web界面调试
# 访问 http://localhost:3000/web 查看实时日志

# CLI状态检查
npm run cli status
npm run cli health

# API测试
curl -X POST http://localhost:3000/api/v1/messages \
  -H "Authorization: Bearer cr_xxx" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Hello"}]}'
```

**4. 代码审查清单**:
- ✅ **安全性**: 敏感数据加密存储，输入验证，SQL注入防护
- ✅ **性能**: 异步处理，缓存策略，数据库优化
- ✅ **错误处理**: 统一错误格式，日志记录，用户友好提示
- ✅ **代码质量**: ESLint通过，Prettier格式化，注释完整
- ✅ **测试覆盖**: 单元测试，集成测试，边界情况测试
- ✅ **文档更新**: API文档，配置说明，CLAUDE.md更新

**5. 部署前检查清单**:
```bash
# 1. 代码质量检查
npm run lint                   # 必须通过
npx prettier --check .         # 格式化检查

# 2. 测试验证
npm test                       # 所有测试通过
npm run cli status             # CLI工具正常

# 3. 功能验证
curl http://localhost:3000/health  # 健康检查通过
node scripts/data-integrity-check.js  # 数据完整性检查

# 4. 构建测试
docker-compose build           # Docker构建成功
docker-compose up -d           # 容器启动正常

# 5. 日志检查
tail logs/claude-relay-combined.log  # 无严重错误
```

**6. 发布流程**:
- 创建功能分支：`git checkout -b feature/xxx`
- 完成开发并通过所有检查
- 提交代码：`git commit -m "feat: 简洁的提交信息"`
- 推送分支：`git push origin feature/xxx`
- 创建Pull Request并等待审查
- 合并到主分支并部署

### 常见文件位置

- 核心服务逻辑：`src/services/` 目录
- 路由处理：`src/routes/` 目录
- 中间件：`src/middleware/` 目录
- 配置管理：`config/config.js`
- Redis 模型：`src/models/redis.js`
- 工具函数：`src/utils/` 目录
- 前端主题管理：`web/admin-spa/src/stores/theme.js`
- 前端组件：`web/admin-spa/src/components/` 目录
- 前端页面：`web/admin-spa/src/views/` 目录

### 重要架构决策

- 所有敏感数据（OAuth token、refreshToken）都使用 AES-256-CBC 加密存储在 Redis
- 每个 Claude 账户支持独立的代理配置，包括 SOCKS5 和 HTTP 代理
- **API Key 哈希已优化**：使用独立的 API_KEY_SALT，与数据加密解耦
- 请求流程：API Key 验证 → 账户选择 → Token 刷新（如需）→ 连接池获取预热连接 → 请求转发
- 支持流式和非流式响应，客户端断开时自动清理资源
- **数据完整性保障**：智能密钥验证、会话窗口数据持久化、完整性检查工具
- **代理连接池架构**：四层架构设计，事件驱动的连接管理和自动故障恢复
- **预热连接策略**：每个账户预创建3个代理连接，显著降低API请求延迟

### 核心数据流和性能优化

- **哈希映射优化**: API Key 验证从 O(n) 优化到 O(1) 查找
- **智能 Usage 捕获**: 从 SSE 流中解析真实的 token 使用数据
- **多维度统计**: 支持按时间、模型、用户的实时使用统计
- **异步处理**: 非阻塞的统计记录和日志写入
- **原子操作**: Redis 管道操作确保数据一致性
- **连接池性能优化**: 预热连接将首次请求延迟从1.7秒降至50-200ms
- **智能连接复用**: 连接池内轮转算法实现负载均衡和连接复用
- **事件驱动监控**: 实时响应连接状态变化，1-3秒完成故障恢复

### 安全和容错机制

- **多层加密**: API Key 哈希 + OAuth Token AES 加密 + 独立盐值管理
- **零信任验证**: 每个请求都需要完整的认证链
- **数据持久化保障**: 会话窗口信息自动保存，防止服务重启数据丢失
- **完整性检查工具**: `scripts/data-integrity-check.js` 验证系统数据完整性
- **优雅降级**: Redis 连接失败时的回退机制
- **自动重试**: 指数退避重试策略和错误隔离
- **资源清理**: 客户端断开时的自动清理机制
- **日志系统自愈**: 文件监控和自动重创建机制，防止手动清理日志文件导致的写入失败

## 项目特定注意事项

### Redis 数据结构

- **API Keys**: `api_key:{id}` (详细信息) + `api_key_hash:{hash}` (快速查找)
- **Claude 账户**: `claude_account:{id}` (加密的 OAuth 数据)
- **管理员**: `admin:{id}` + `admin_username:{username}` (用户名映射)
- **会话**: `session:{token}` (JWT 会话管理)
- **使用统计**: `usage:daily:{date}:{key}:{model}` (多维度统计)
- **系统信息**: `system_info` (系统状态缓存)

### 流式响应处理

- 支持 SSE (Server-Sent Events) 流式传输
- 自动从流中解析 usage 数据并记录
- 客户端断开时通过 AbortController 清理资源
- 错误时发送适当的 SSE 错误事件

### 日志系统增强

- **主日志系统** (`src/utils/logger.js`): 支持自动文件监控和重创建
- **Token刷新日志** (`src/utils/tokenRefreshLogger.js`): 升级到 `winston-daily-rotate-file` 并支持文件监控
- **文件监控机制**: 使用 `chokidar` 监控日志文件删除事件
- **自动重创建**: 检测到文件被手动删除后，自动重新创建传输器和文件
- **防重复处理**: 内置延迟和去重逻辑，避免重复触发重创建
- **健康检查**: 增强的健康检查包含文件监控器状态信息
- **资源清理**: 进程退出时自动清理文件监控器资源

**使用场景**: 解决服务运行过程中手动清理日志文件导致后续日志无法写入的问题

### 连接池系统实现

**核心架构**:
- **SmartConnectionPool**: 继承EventEmitter，为单个账户管理预热连接
- **GlobalConnectionPoolManager**: 单例模式管理所有账户的连接池
- **HybridConnectionManager**: 混合监控机制，结合事件驱动和定期检查
- **ConnectionLifecycleManager**: 连接生命周期管理和资源优化

**技术实现细节**:
- **事件系统**: 连接池发射connection:connected、connection:disconnected、connection:error等事件
- **连接预热**: 每个账户在服务启动时创建3个预热的代理连接
- **自动重连**: 使用指数退避策略（1s、2s、4s、8s、16s）进行故障恢复
- **连接监控**: Hook代理Agent的createSocket方法实现Socket级别监控
- **负载均衡**: 连接池内使用轮转算法分配连接使用

**性能特性**:
- **延迟优化**: 预热连接将首次请求延迟从1.7秒降至50-200ms
- **并发能力**: 支持每个账户同时处理3个并发请求
- **故障隔离**: 单个连接失败不影响其他连接和账户
- **资源管理**: 连接老化检测、自动轮换和内存泄漏防护

**集成方式**:
- **透明集成**: ProxyHelper自动从连接池获取预热连接
- **向后兼容**: 连接池失败时自动降级到传统代理创建方式
- **监控集成**: 健康检查端点包含连接池状态信息

### CLI 工具使用示例

```bash
# 创建新的 API Key
npm run cli keys create -- --name "MyApp" --limit 1000

# 查看系统状态
npm run cli status

# 管理 Claude 账户
npm run cli accounts list
npm run cli accounts refresh <accountId>

# 管理员操作
npm run cli admin create -- --username admin2
npm run cli admin reset-password -- --username admin

# 数据完整性检查
node scripts/data-integrity-check.js     # 检查系统数据完整性和安全配置

# 连接池系统管理
curl http://localhost:3000/connection-pools | jq '.'  # 查看连接池详细状态
curl http://localhost:3000/health | jq '.components.connectionPools'  # 连接池健康检查
```

# important-instruction-reminders

Do what has been asked; nothing more, nothing less.
NEVER create files unless they're absolutely necessary for achieving your goal.
ALWAYS prefer editing an existing file to creating a new one.
NEVER proactively create documentation files (\*.md) or README files. Only create documentation files if explicitly requested by the User.
