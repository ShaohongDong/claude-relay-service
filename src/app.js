const express = require('express')
const cors = require('cors')
const helmet = require('helmet')
const compression = require('compression')
const path = require('path')
const fs = require('fs')
const bcrypt = require('bcryptjs')

const config = require('../config/config')
const logger = require('./utils/logger')
const redis = require('./models/redis')
const pricingService = require('./services/pricingService')
const cacheMonitor = require('./utils/cacheMonitor')

// Import routes
const apiRoutes = require('./routes/api')
const adminRoutes = require('./routes/admin')
const webRoutes = require('./routes/web')
const apiStatsRoutes = require('./routes/apiStats')
const geminiRoutes = require('./routes/geminiRoutes')
const openaiGeminiRoutes = require('./routes/openaiGeminiRoutes')
const openaiClaudeRoutes = require('./routes/openaiClaudeRoutes')
const openaiRoutes = require('./routes/openaiRoutes')
const azureOpenaiRoutes = require('./routes/azureOpenaiRoutes')
const webhookRoutes = require('./routes/webhook')

// Import middleware
const {
  corsMiddleware,
  requestLogger,
  securityMiddleware,
  errorHandler,
  globalRateLimit,
  requestSizeLimit
} = require('./middleware/auth')

class Application {
  constructor() {
    this.app = express()
    this.server = null
    this.cleanupInterval = null // 保存清理任务定时器
    
    // 连接池系统组件
    this.globalConnectionPoolManager = null
    this.hybridConnectionManager = null
    this.connectionLifecycleManager = null
  }

  async initialize() {
    try {
      // 🔗 连接Redis
      logger.info('🔄 Connecting to Redis...')
      await redis.connect()
      logger.success('✅ Redis connected successfully')

      // 💰 初始化价格服务
      logger.info('🔄 Initializing pricing service...')
      await pricingService.initialize()

      // 📊 初始化缓存监控
      await this.initializeCacheMonitoring()

      // 🔧 初始化管理员凭据
      logger.info('🔄 Initializing admin credentials...')
      await this.initializeAdmin()

      // 💰 初始化费用数据
      logger.info('💰 Checking cost data initialization...')
      const costInitService = require('./services/costInitService')
      const needsInit = await costInitService.needsInitialization()
      if (needsInit) {
        logger.info('💰 Initializing cost data for all API Keys...')
        const result = await costInitService.initializeAllCosts()
        logger.info(
          `💰 Cost initialization completed: ${result.processed} processed, ${result.errors} errors`
        )
      }

      // 🕐 初始化Claude账户会话窗口
      logger.info('🕐 Initializing Claude account session windows...')
      const claudeAccountService = require('./services/claudeAccountService')
      await claudeAccountService.initializeSessionWindows()

      // 🔗 初始化连接池系统
      await this.initializeConnectionPoolSystem()

      // 超早期拦截 /admin-next/ 请求 - 在所有中间件之前
      this.app.use((req, res, next) => {
        if (req.path === '/admin-next/' && req.method === 'GET') {
          logger.warn('🚨 INTERCEPTING /admin-next/ request at the very beginning!')
          const adminSpaPath = path.join(__dirname, '..', 'web', 'admin-spa', 'dist')
          const indexPath = path.join(adminSpaPath, 'index.html')

          if (fs.existsSync(indexPath)) {
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate')
            return res.sendFile(indexPath)
          } else {
            logger.error('❌ index.html not found at:', indexPath)
            return res.status(404).send('index.html not found')
          }
        }
        next()
      })

      // 🛡️ 安全中间件
      this.app.use(
        helmet({
          contentSecurityPolicy: false, // 允许内联样式和脚本
          crossOriginEmbedderPolicy: false
        })
      )

      // 🌐 CORS
      if (config.web.enableCors) {
        this.app.use(cors())
      } else {
        this.app.use(corsMiddleware)
      }

      // 📦 压缩 - 排除流式响应（SSE）
      this.app.use(
        compression({
          filter: (req, res) => {
            // 不压缩 Server-Sent Events
            if (res.getHeader('Content-Type') === 'text/event-stream') {
              return false
            }
            // 使用默认的压缩判断
            return compression.filter(req, res)
          }
        })
      )

      // 🚦 全局速率限制（仅在生产环境启用）
      if (process.env.NODE_ENV === 'production') {
        this.app.use(globalRateLimit)
      }

      // 📏 请求大小限制
      this.app.use(requestSizeLimit)

      // 📝 请求日志（使用自定义logger而不是morgan）
      this.app.use(requestLogger)

      // 🔧 基础中间件
      this.app.use(
        express.json({
          limit: '10mb',
          verify: (req, res, buf, encoding) => {
            // 验证JSON格式
            if (buf && buf.length && !buf.toString(encoding || 'utf8').trim()) {
              throw new Error('Invalid JSON: empty body')
            }
          }
        })
      )
      this.app.use(express.urlencoded({ extended: true, limit: '10mb' }))
      this.app.use(securityMiddleware)

      // 🎯 信任代理
      if (config.server.trustProxy) {
        this.app.set('trust proxy', 1)
      }

      // 调试中间件 - 拦截所有 /admin-next 请求
      this.app.use((req, res, next) => {
        if (req.path.startsWith('/admin-next')) {
          logger.info(
            `🔍 DEBUG: Incoming request - method: ${req.method}, path: ${req.path}, originalUrl: ${req.originalUrl}`
          )
        }
        next()
      })

      // 🎨 新版管理界面静态文件服务（必须在其他路由之前）
      const adminSpaPath = path.join(__dirname, '..', 'web', 'admin-spa', 'dist')
      if (fs.existsSync(adminSpaPath)) {
        // 处理不带斜杠的路径，重定向到带斜杠的路径
        this.app.get('/admin-next', (req, res) => {
          res.redirect(301, '/admin-next/')
        })

        // 使用 all 方法确保捕获所有 HTTP 方法
        this.app.all('/admin-next/', (req, res) => {
          logger.info('🎯 HIT: /admin-next/ route handler triggered!')
          logger.info(`Method: ${req.method}, Path: ${req.path}, URL: ${req.url}`)

          if (req.method !== 'GET' && req.method !== 'HEAD') {
            return res.status(405).send('Method Not Allowed')
          }

          res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate')
          res.sendFile(path.join(adminSpaPath, 'index.html'))
        })

        // 处理所有其他 /admin-next/* 路径（但排除根路径）
        this.app.get('/admin-next/*', (req, res) => {
          // 如果是根路径，跳过（应该由上面的路由处理）
          if (req.path === '/admin-next/') {
            logger.error('❌ ERROR: /admin-next/ should not reach here!')
            return res.status(500).send('Route configuration error')
          }

          const requestPath = req.path.replace('/admin-next/', '')

          // 安全检查
          if (
            requestPath.includes('..') ||
            requestPath.includes('//') ||
            requestPath.includes('\\')
          ) {
            return res.status(400).json({ error: 'Invalid path' })
          }

          // 检查是否为静态资源
          const filePath = path.join(adminSpaPath, requestPath)

          // 如果文件存在且是静态资源
          if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
            // 设置缓存头
            if (filePath.endsWith('.js') || filePath.endsWith('.css')) {
              res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
            } else if (filePath.endsWith('.html')) {
              res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate')
            }
            return res.sendFile(filePath)
          }

          // 如果是静态资源但文件不存在
          if (requestPath.match(/\.(js|css|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf)$/i)) {
            return res.status(404).send('Not found')
          }

          // 其他所有路径返回 index.html（SPA 路由）
          res.sendFile(path.join(adminSpaPath, 'index.html'))
        })

        logger.info('✅ Admin SPA (next) static files mounted at /admin-next/')
      } else {
        logger.warn('⚠️ Admin SPA dist directory not found, skipping /admin-next route')
      }

      // 🛣️ 路由
      this.app.use('/api', apiRoutes)
      this.app.use('/claude', apiRoutes) // /claude 路由别名，与 /api 功能相同
      this.app.use('/admin', adminRoutes)
      // 使用 web 路由（包含 auth 和页面重定向）
      this.app.use('/web', webRoutes)
      this.app.use('/apiStats', apiStatsRoutes)
      this.app.use('/gemini', geminiRoutes)
      this.app.use('/openai/gemini', openaiGeminiRoutes)
      this.app.use('/openai/claude', openaiClaudeRoutes)
      this.app.use('/openai', openaiRoutes)
      this.app.use('/azure', azureOpenaiRoutes)
      this.app.use('/admin/webhook', webhookRoutes)

      // 🏠 根路径重定向到新版管理界面
      this.app.get('/', (req, res) => {
        res.redirect('/admin-next/api-stats')
      })

      // 🏥 增强的健康检查端点
      this.app.get('/health', async (req, res) => {
        try {
          const timer = logger.timer('health-check')

          // 检查各个组件健康状态
          const [redisHealth, loggerHealth, connectionPoolHealth] = await Promise.all([
            this.checkRedisHealth(),
            this.checkLoggerHealth(),
            this.checkConnectionPoolHealth()
          ])

          const memory = process.memoryUsage()

          // 获取版本号：优先使用环境变量，其次VERSION文件，再次package.json，最后使用默认值
          let version = process.env.APP_VERSION || process.env.VERSION
          if (!version) {
            try {
              const versionFile = path.join(__dirname, '..', 'VERSION')
              if (fs.existsSync(versionFile)) {
                version = fs.readFileSync(versionFile, 'utf8').trim()
              }
            } catch (error) {
              // 忽略错误，继续尝试其他方式
            }
          }
          if (!version) {
            try {
              const { version: pkgVersion } = require('../package.json')
              version = pkgVersion
            } catch (error) {
              version = '1.0.0'
            }
          }

          const health = {
            status: 'healthy',
            service: 'claude-relay-service',
            version,
            timestamp: new Date().toISOString(),
            uptime: process.uptime(),
            memory: {
              used: `${Math.round(memory.heapUsed / 1024 / 1024)}MB`,
              total: `${Math.round(memory.heapTotal / 1024 / 1024)}MB`,
              external: `${Math.round(memory.external / 1024 / 1024)}MB`
            },
            components: {
              redis: redisHealth,
              logger: loggerHealth,
              connectionPools: connectionPoolHealth
            },
            stats: logger.getStats()
          }

          timer.end('completed')
          res.json(health)
        } catch (error) {
          logger.error('❌ Health check failed:', { error: error.message, stack: error.stack })
          res.status(503).json({
            status: 'unhealthy',
            error: error.message,
            timestamp: new Date().toISOString()
          })
        }
      })

      // 📊 指标端点
      this.app.get('/metrics', async (req, res) => {
        try {
          const stats = await redis.getSystemStats()
          const metrics = {
            ...stats,
            uptime: process.uptime(),
            memory: process.memoryUsage(),
            timestamp: new Date().toISOString()
          }

          res.json(metrics)
        } catch (error) {
          logger.error('❌ Metrics collection failed:', error)
          res.status(500).json({ error: 'Failed to collect metrics' })
        }
      })

      // 🔗 连接池状态端点
      this.app.get('/connection-pools', async (req, res) => {
        try {
          if (!this.globalConnectionPoolManager) {
            return res.json({
              status: 'not_initialized',
              message: 'Connection pool system not initialized',
              timestamp: new Date().toISOString()
            })
          }

          const poolStatus = this.globalConnectionPoolManager.getAllPoolStatus()
          const hybridStatus = this.hybridConnectionManager?.getMonitoringReport() || null
          const lifecycleStatus = this.connectionLifecycleManager?.getStatusReport() || null

          res.json({
            status: 'active',
            poolManager: poolStatus,
            hybridManager: hybridStatus,
            lifecycleManager: lifecycleStatus,
            timestamp: new Date().toISOString()
          })
        } catch (error) {
          logger.error('❌ Connection pool status collection failed:', error)
          res.status(500).json({ 
            status: 'error',
            error: error.message,
            timestamp: new Date().toISOString()
          })
        }
      })

      // 🚫 404 处理
      this.app.use('*', (req, res) => {
        res.status(404).json({
          error: 'Not Found',
          message: `Route ${req.originalUrl} not found`,
          timestamp: new Date().toISOString()
        })
      })

      // 🚨 错误处理
      this.app.use(errorHandler)

      logger.success('✅ Application initialized successfully')
    } catch (error) {
      logger.error('💥 Application initialization failed:', error)
      throw error
    }
  }

  // 🔧 初始化管理员凭据（总是从 init.json 加载，确保数据一致性）
  async initializeAdmin() {
    try {
      const initFilePath = path.join(__dirname, '..', 'data', 'init.json')

      if (!fs.existsSync(initFilePath)) {
        logger.warn('⚠️ No admin credentials found. Please run npm run setup first.')
        return
      }

      // 从 init.json 读取管理员凭据（作为唯一真实数据源）
      const initData = JSON.parse(fs.readFileSync(initFilePath, 'utf8'))

      // 将明文密码哈希化
      const saltRounds = 10
      const passwordHash = await bcrypt.hash(initData.adminPassword, saltRounds)

      // 存储到Redis（每次启动都覆盖，确保与 init.json 同步）
      const adminCredentials = {
        username: initData.adminUsername,
        passwordHash,
        createdAt: initData.initializedAt || new Date().toISOString(),
        lastLogin: null,
        updatedAt: initData.updatedAt || null
      }

      await redis.setSession('admin_credentials', adminCredentials)

      logger.success('✅ Admin credentials loaded from init.json (single source of truth)')
      logger.info(`📋 Admin username: ${adminCredentials.username}`)
    } catch (error) {
      logger.error('❌ Failed to initialize admin credentials:', {
        error: error.message,
        stack: error.stack
      })
      throw error
    }
  }

  // 🔗 初始化连接池系统
  async initializeConnectionPoolSystem() {
    try {
      logger.info('🔄 Initializing connection pool system...')

      // 初始化全局连接池管理器
      const globalConnectionPoolManager = require('./services/globalConnectionPoolManager')
      this.globalConnectionPoolManager = globalConnectionPoolManager
      
      logger.info('🔗 Starting global connection pool manager...')
      await this.globalConnectionPoolManager.initializeAllPools()

      // 初始化混合连接管理器
      const HybridConnectionManager = require('./services/hybridConnectionManager')
      this.hybridConnectionManager = new HybridConnectionManager(this.globalConnectionPoolManager)
      
      logger.info('🔄 Starting hybrid connection manager...')
      await this.hybridConnectionManager.start()

      // 初始化连接生命周期管理器
      const ConnectionLifecycleManager = require('./services/connectionLifecycleManager')
      this.connectionLifecycleManager = new ConnectionLifecycleManager()
      
      logger.info('♻️ Starting connection lifecycle manager...')
      this.connectionLifecycleManager.start()

      // 设置组件间的事件连接
      this.setupConnectionPoolEvents()

      logger.success('✅ Connection pool system initialized successfully')
      
      // 打印系统状态摘要
      const summary = this.globalConnectionPoolManager.getSummary()
      logger.info(`📊 Connection Pool Summary: ${summary.totalPools} pools, ${summary.totalConnections} connections`)
      
    } catch (error) {
      logger.error('❌ Failed to initialize connection pool system:', error.message)
      
      // 连接池系统初始化失败不应阻止应用启动，但需要记录错误
      logger.warn('⚠️ Application will continue without connection pool optimization')
      
      // 清理已初始化的组件
      await this.cleanupConnectionPoolSystem()
    }
  }

  // 🎧 设置连接池系统事件连接
  setupConnectionPoolEvents() {
    if (!this.hybridConnectionManager || !this.connectionLifecycleManager) {
      return
    }

    // 混合管理器 -> 生命周期管理器
    this.hybridConnectionManager.on('connection:established', (data) => {
      this.connectionLifecycleManager.registerConnection(
        data.accountId, 
        data.connectionId, 
        { latency: data.latency }
      )
    })

    this.hybridConnectionManager.on('connection:lost', (data) => {
      this.connectionLifecycleManager.unregisterConnection(data.connectionId, data.reason)
    })

    this.hybridConnectionManager.on('connection:error', (data) => {
      this.connectionLifecycleManager.updateConnectionUsage(data.connectionId, { error: true })
    })

    // 生命周期管理器 -> 全局池管理器
    this.connectionLifecycleManager.on('connection:recreation:requested', async (data) => {
      try {
        // 通知全局池管理器重建连接
        const pool = this.globalConnectionPoolManager.pools?.get(data.accountId)
        if (pool && typeof pool.recreateConnection === 'function') {
          await pool.recreateConnection(data.connectionId)
          logger.info(`🔄 Connection recreated: ${data.connectionId} (${data.reason})`)
        }
      } catch (error) {
        logger.error(`❌ Failed to recreate connection ${data.connectionId}: ${error.message}`)
      }
    })

    logger.debug('🎧 Connection pool system events connected')
  }

  // 🧹 清理连接池系统
  async cleanupConnectionPoolSystem() {
    logger.info('🧹 Cleaning up connection pool system...')

    // 获取清理前的状态统计
    let preCleanupStats = {
      pools: 0,
      connections: 0,
      managers: 0
    }

    try {
      if (this.globalConnectionPoolManager) {
        const summary = this.globalConnectionPoolManager.getSummary()
        preCleanupStats.pools = summary.totalPools || 0
        preCleanupStats.connections = summary.totalConnections || 0
        logger.info(`📊 Pre-cleanup: ${preCleanupStats.pools} pools, ${preCleanupStats.connections} connections`)
      }
    } catch (error) {
      logger.warn('⚠️ Could not get pre-cleanup stats:', error.message)
    }

    let cleanupResults = {
      lifecycleManager: false,
      hybridManager: false,
      globalPoolManager: false
    }

    // 清理连接生命周期管理器
    if (this.connectionLifecycleManager) {
      preCleanupStats.managers++
      try {
        logger.info('♻️ Stopping connection lifecycle manager...')
        this.connectionLifecycleManager.stop()
        cleanupResults.lifecycleManager = true
        logger.info('♻️ Connection lifecycle manager stopped successfully')
      } catch (error) {
        logger.error('❌ Error stopping connection lifecycle manager:', error.message)
      }
    } else {
      logger.debug('♻️ Connection lifecycle manager was not initialized')
    }

    // 清理混合连接管理器
    if (this.hybridConnectionManager) {
      preCleanupStats.managers++
      try {
        logger.info('🔄 Stopping hybrid connection manager...')
        this.hybridConnectionManager.stop()
        cleanupResults.hybridManager = true
        logger.info('🔄 Hybrid connection manager stopped successfully')
      } catch (error) {
        logger.error('❌ Error stopping hybrid connection manager:', error.message)
      }
    } else {
      logger.debug('🔄 Hybrid connection manager was not initialized')
    }

    // 清理全局连接池管理器
    if (this.globalConnectionPoolManager) {
      preCleanupStats.managers++
      try {
        logger.info('🔗 Destroying global connection pool manager...')
        this.globalConnectionPoolManager.destroy()
        cleanupResults.globalPoolManager = true
        logger.info('🔗 Global connection pool manager destroyed successfully')
      } catch (error) {
        logger.error('❌ Error destroying global connection pool manager:', error.message)
      }
    } else {
      logger.debug('🔗 Global connection pool manager was not initialized')
    }

    // 重置引用
    this.globalConnectionPoolManager = null
    this.hybridConnectionManager = null
    this.connectionLifecycleManager = null

    // 生成清理报告
    const successfulCleanups = Object.values(cleanupResults).filter(Boolean).length
    const totalComponents = Object.keys(cleanupResults).length

    logger.info(`📋 Connection pool cleanup summary:`)
    logger.info(`   - Managers initialized: ${preCleanupStats.managers}`)
    logger.info(`   - Connection pools: ${preCleanupStats.pools}`)
    logger.info(`   - Active connections: ${preCleanupStats.connections}`)
    logger.info(`   - Components cleaned successfully: ${successfulCleanups}/${totalComponents}`)

    if (successfulCleanups === totalComponents) {
      logger.success('✅ Connection pool system cleanup completed successfully')
    } else {
      logger.warn(`⚠️ Connection pool system cleanup completed with ${totalComponents - successfulCleanups} failures`)
    }
  }

  // 🔍 端口可用性检查
  async checkPortAvailability(port, host = '0.0.0.0') {
    return new Promise((resolve) => {
      const net = require('net')
      const server = net.createServer()

      server.listen(port, host, () => {
        server.once('close', () => resolve(true))
        server.close()
      })

      server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          resolve(false)
        } else {
          resolve(false)
        }
      })
    })
  }

  // 🔍 Redis健康检查
  async checkRedisHealth() {
    try {
      const start = Date.now()
      await redis.getClient().ping()
      const latency = Date.now() - start

      return {
        status: 'healthy',
        connected: redis.isConnected,
        latency: `${latency}ms`
      }
    } catch (error) {
      return {
        status: 'unhealthy',
        connected: false,
        error: error.message
      }
    }
  }

  // 📝 Logger健康检查
  async checkLoggerHealth() {
    try {
      const health = logger.healthCheck()
      return {
        status: health.healthy ? 'healthy' : 'unhealthy',
        ...health
      }
    } catch (error) {
      return {
        status: 'unhealthy',
        error: error.message
      }
    }
  }

  // 🔗 连接池健康检查
  async checkConnectionPoolHealth() {
    try {
      if (!this.globalConnectionPoolManager) {
        return {
          status: 'not_initialized',
          message: 'Connection pool system not initialized'
        }
      }

      const healthResult = await this.globalConnectionPoolManager.performHealthCheck()
      const summary = this.globalConnectionPoolManager.getSummary()
      
      let status = 'healthy'
      if (healthResult.unhealthyPools > 0) {
        if (healthResult.unhealthyPools >= healthResult.totalPools) {
          status = 'critical' // 所有池都不健康
        } else if (healthResult.unhealthyPools / healthResult.totalPools > 0.5) {
          status = 'degraded' // 50%以上池不健康
        } else {
          status = 'warning' // 部分池不健康
        }
      }

      return {
        status,
        totalPools: healthResult.totalPools,
        healthyPools: healthResult.healthyPools,
        unhealthyPools: healthResult.unhealthyPools,
        totalConnections: healthResult.totalConnections,
        isInitialized: summary.isInitialized,
        hybridManager: this.hybridConnectionManager ? 
          this.hybridConnectionManager.getManagerStatus() : null,
        lifecycleManager: this.connectionLifecycleManager ?
          this.connectionLifecycleManager.getLifecycleStats() : null
      }
    } catch (error) {
      return {
        status: 'error',
        error: error.message
      }
    }
  }

  async start() {
    try {
      await this.initialize()

      // 🔍 检查端口可用性
      const isPortAvailable = await this.checkPortAvailability(config.server.port, config.server.host)
      if (!isPortAvailable) {
        logger.error(`❌ Port ${config.server.port} is already in use on ${config.server.host}`)
        logger.error('💡 Try stopping the existing service: npm run service stop')
        logger.error('💡 Or check running processes: lsof -i :' + config.server.port)
        process.exit(1)
      }

      // 🚀 启动服务器
      this.server = this.app.listen(config.server.port, config.server.host, () => {
        logger.start(
          `🚀 Claude Relay Service started on ${config.server.host}:${config.server.port}`
        )
        logger.info(
          `🌐 Web interface: http://${config.server.host}:${config.server.port}/admin-next/api-stats`
        )
        logger.info(
          `🔗 API endpoint: http://${config.server.host}:${config.server.port}/api/v1/messages`
        )
        logger.info(`⚙️  Admin API: http://${config.server.host}:${config.server.port}/admin`)
        logger.info(`🏥 Health check: http://${config.server.host}:${config.server.port}/health`)
        logger.info(`📊 Metrics: http://${config.server.host}:${config.server.port}/metrics`)
        logger.info(`🔗 Connection pools: http://${config.server.host}:${config.server.port}/connection-pools`)
      })

      // 🚨 处理服务器错误
      this.server.on('error', (error) => {
        if (error.code === 'EADDRINUSE') {
          logger.error(`❌ Port ${config.server.port} is already in use on ${config.server.host}`)
          logger.error('💡 Another instance may already be running. Check with: npm run service status')
          logger.error('💡 Or stop existing service with: npm run service stop')
        } else if (error.code === 'EACCES') {
          logger.error(`❌ Permission denied to bind to ${config.server.host}:${config.server.port}`)
          logger.error('💡 You may need elevated privileges to use this port')
        } else {
          logger.error('❌ Server startup failed:', error)
        }
        process.exit(1)
      })

      const serverTimeout = 30000 // 30秒超时，支持快速优雅关闭
      this.server.timeout = serverTimeout
      this.server.keepAliveTimeout = serverTimeout + 5000 // keepAlive 稍长一点
      this.server.headersTimeout = serverTimeout + 10000 // 请求头超时稍长
      logger.info(`⏱️  Server timeout set to ${serverTimeout}ms (${serverTimeout / 1000}s) - optimized for graceful shutdown`)

      // 🔄 定期清理任务
      this.startCleanupTasks()

      // 🛑 优雅关闭
      this.setupGracefulShutdown()
    } catch (error) {
      logger.error('💥 Failed to start server:', error)
      process.exit(1)
    }
  }

  // 📊 初始化缓存监控
  async initializeCacheMonitoring() {
    try {
      logger.info('🔄 Initializing cache monitoring...')

      // 注册各个服务的缓存实例
      const services = [
        { name: 'claudeAccount', service: require('./services/claudeAccountService') },
        { name: 'claudeConsole', service: require('./services/claudeConsoleAccountService') },
        { name: 'bedrockAccount', service: require('./services/bedrockAccountService') }
      ]

      // 注册已加载的服务缓存
      for (const { name, service } of services) {
        if (service && (service._decryptCache || service.decryptCache)) {
          const cache = service._decryptCache || service.decryptCache
          cacheMonitor.registerCache(`${name}_decrypt`, cache)
          logger.info(`✅ Registered ${name} decrypt cache for monitoring`)
        }
      }

      // 初始化时打印一次统计
      setTimeout(() => {
        const stats = cacheMonitor.getGlobalStats()
        logger.info(`📊 Cache System - Registered: ${stats.cacheCount} caches`)
      }, 5000)

      logger.success('✅ Cache monitoring initialized')
    } catch (error) {
      logger.error('❌ Failed to initialize cache monitoring:', error)
      // 不阻止应用启动
    }
  }

  startCleanupTasks() {
    // 🧹 每小时清理一次过期数据
    this.cleanupInterval = setInterval(async () => {
      try {
        logger.info('🧹 Starting scheduled cleanup...')

        const apiKeyService = require('./services/apiKeyService')
        const claudeAccountService = require('./services/claudeAccountService')

        const [expiredKeys, errorAccounts] = await Promise.all([
          apiKeyService.cleanupExpiredKeys(),
          claudeAccountService.cleanupErrorAccounts(),
          claudeAccountService.cleanupTempErrorAccounts() // 新增：清理临时错误账户
        ])

        await redis.cleanup()

        logger.success(
          `🧹 Cleanup completed: ${expiredKeys} expired keys, ${errorAccounts} error accounts reset`
        )
      } catch (error) {
        logger.error('❌ Cleanup task failed:', error)
      }
    }, config.system.cleanupInterval)

    logger.info(
      `🔄 Cleanup tasks scheduled every ${config.system.cleanupInterval / 1000 / 60} minutes`
    )
  }

  setupGracefulShutdown() {
    const shutdown = async (signal) => {
      const shutdownStart = Date.now()
      logger.info(`🛑 Received ${signal}, starting graceful shutdown...`)

      // 清理定时器（防止阻塞进程退出）
      if (this.cleanupInterval) {
        clearInterval(this.cleanupInterval)
        logger.info('🧹 Cleanup interval cleared')
      }

      if (this.server) {
        logger.info('🚪 Closing HTTP server...')
        this.server.close(async () => {
          const serverCloseTime = Date.now() - shutdownStart
          logger.info(`🚪 HTTP server closed (${serverCloseTime}ms)`)

          // 清理连接池系统
          logger.info('🔗 Cleaning up connection pool system...')
          const poolCleanupStart = Date.now()
          try {
            await this.cleanupConnectionPoolSystem()
            const poolCleanupTime = Date.now() - poolCleanupStart
            logger.info(`🔗 Connection pool system cleaned up (${poolCleanupTime}ms)`)
          } catch (error) {
            const poolCleanupTime = Date.now() - poolCleanupStart
            logger.error(`❌ Error cleaning up connection pool system (${poolCleanupTime}ms):`, error)
          }

          // 清理 pricing service 的文件监听器
          logger.info('💰 Cleaning up pricing service...')
          const pricingCleanupStart = Date.now()
          try {
            pricingService.cleanup()
            const pricingCleanupTime = Date.now() - pricingCleanupStart
            logger.info(`💰 Pricing service cleaned up (${pricingCleanupTime}ms)`)
          } catch (error) {
            const pricingCleanupTime = Date.now() - pricingCleanupStart
            logger.error(`❌ Error cleaning up pricing service (${pricingCleanupTime}ms):`, error)
          }

          // 断开Redis连接
          logger.info('📦 Disconnecting from Redis...')
          const redisDisconnectStart = Date.now()
          try {
            await redis.disconnect()
            const redisDisconnectTime = Date.now() - redisDisconnectStart
            logger.info(`👋 Redis disconnected (${redisDisconnectTime}ms)`)
          } catch (error) {
            const redisDisconnectTime = Date.now() - redisDisconnectStart
            logger.error(`❌ Error disconnecting Redis (${redisDisconnectTime}ms):`, error)
          }

          // 清理缓存监控器的定时器
          logger.info('📊 Cleaning up cache monitor...')
          const cacheMonitorCleanupStart = Date.now()
          try {
            const cacheMonitor = require('./utils/cacheMonitor')
            if (cacheMonitor && typeof cacheMonitor.cleanup === 'function') {
              cacheMonitor.cleanup()
              const cacheMonitorCleanupTime = Date.now() - cacheMonitorCleanupStart
              logger.info(`📊 Cache monitor cleaned up (${cacheMonitorCleanupTime}ms)`)
            } else {
              logger.debug('📊 Cache monitor cleanup not available')
            }
          } catch (error) {
            const cacheMonitorCleanupTime = Date.now() - cacheMonitorCleanupStart
            logger.error(`❌ Error cleaning up cache monitor (${cacheMonitorCleanupTime}ms):`, error)
          }

          // 清理所有账户服务的定时器
          logger.info('🎯 Cleaning up account services...')
          const accountServicesCleanupStart = Date.now()
          let cleanedServices = 0
          let failedServices = 0

          const accountServices = [
            { name: 'Claude Account Service', module: './services/claudeAccountService' },
            { name: 'OpenAI Account Service', module: './services/openaiAccountService' },
            { name: 'Azure OpenAI Account Service', module: './services/azureOpenaiAccountService' },
            { name: 'Gemini Account Service', module: './services/geminiAccountService' },
            { name: 'Bedrock Account Service', module: './services/bedrockAccountService' },
            { name: 'Claude Console Account Service', module: './services/claudeConsoleAccountService' }
          ]

          for (const service of accountServices) {
            try {
              const serviceModule = require(service.module)
              if (serviceModule && typeof serviceModule.cleanup === 'function') {
                serviceModule.cleanup()
                cleanedServices++
                logger.debug(`✅ ${service.name} cleaned up`)
              } else {
                logger.debug(`⚠️ ${service.name} cleanup not available`)
              }
            } catch (error) {
              failedServices++
              logger.error(`❌ Error cleaning up ${service.name}:`, error.message)
            }
          }

          const accountServicesCleanupTime = Date.now() - accountServicesCleanupStart
          logger.info(`🎯 Account services cleanup completed (${accountServicesCleanupTime}ms): ${cleanedServices} succeeded, ${failedServices} failed`)

          // 清理日志系统的文件监控器
          logger.info('📝 Cleaning up logger file watchers...')
          const loggerCleanupStart = Date.now()
          try {
            logger.cleanup()
            const loggerCleanupTime = Date.now() - loggerCleanupStart
            logger.info(`📝 Logger file watchers cleaned up (${loggerCleanupTime}ms)`)
          } catch (error) {
            const loggerCleanupTime = Date.now() - loggerCleanupStart
            logger.error(`❌ Error cleaning up logger (${loggerCleanupTime}ms):`, error)
          }

          // 清理全局HTTP Agent（防止连接泄露）
          logger.info('🌐 Cleaning up global HTTP agents...')
          const httpCleanupStart = Date.now()
          try {
            const https = require('https')
            const http = require('http')
            
            // 销毁全局HTTP Agent
            if (https.globalAgent) {
              https.globalAgent.destroy()
            }
            if (http.globalAgent) {
              http.globalAgent.destroy()  
            }
            
            const httpCleanupTime = Date.now() - httpCleanupStart
            logger.info(`🌐 Global HTTP agents cleaned up (${httpCleanupTime}ms)`)
          } catch (error) {
            const httpCleanupTime = Date.now() - httpCleanupStart
            logger.error(`❌ Error cleaning up HTTP agents (${httpCleanupTime}ms):`, error)
          }

          // 清理process事件监听器（关键修复）
          logger.info('🎧 Cleaning up process event listeners...')
          const processCleanupStart = Date.now()
          try {
            process.removeAllListeners('SIGTERM')
            process.removeAllListeners('SIGINT')
            process.removeAllListeners('uncaughtException')
            process.removeAllListeners('unhandledRejection')
            const processCleanupTime = Date.now() - processCleanupStart
            logger.info(`🎧 Process event listeners cleaned up (${processCleanupTime}ms)`)
          } catch (error) {
            const processCleanupTime = Date.now() - processCleanupStart
            logger.error(`❌ Error cleaning up process listeners (${processCleanupTime}ms):`, error)
          }

          const totalShutdownTime = Date.now() - shutdownStart
          console.log(`✅ Graceful shutdown completed in ${totalShutdownTime}ms`) // 使用console.log避免logger问题
          process.exit(0)
        })

        // 增加强制关闭超时时间并添加进度提醒
        const shutdownTimeout = 35000 // 35秒超时
        const timeoutHandle = setTimeout(() => {
          const elapsedTime = Date.now() - shutdownStart
          logger.warn(`⚠️ Forced shutdown due to timeout after ${elapsedTime}ms (limit: ${shutdownTimeout}ms)`)
          logger.warn('💡 Some resources may not have been cleaned up properly')
          process.exit(1)
        }, shutdownTimeout)

        // 添加中期进度提醒
        setTimeout(() => {
          const elapsedTime = Date.now() - shutdownStart
          logger.info(`🕒 Shutdown in progress... ${elapsedTime}ms elapsed (timeout in ${shutdownTimeout - elapsedTime}ms)`)
        }, 15000) // 15秒提醒

        // 记录超时配置
        logger.info(`⏱️ Shutdown timeout set to ${shutdownTimeout}ms`)
      } else {
        process.exit(0)
      }
    }

    process.on('SIGTERM', () => shutdown('SIGTERM'))
    process.on('SIGINT', () => shutdown('SIGINT'))

    // 处理未捕获异常
    process.on('uncaughtException', (error) => {
      logger.error('💥 Uncaught exception:', error)
      shutdown('uncaughtException')
    })

    process.on('unhandledRejection', (reason, promise) => {
      logger.error('💥 Unhandled rejection at:', promise, 'reason:', reason)
      shutdown('unhandledRejection')
    })
  }
}

// 启动应用
if (require.main === module) {
  const app = new Application()
  app.start().catch((error) => {
    logger.error('💥 Application startup failed:', error)
    process.exit(1)
  })
}

module.exports = Application
