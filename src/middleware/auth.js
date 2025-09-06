const apiKeyService = require('../services/apiKeyService')
const logger = require('../utils/logger')
const redis = require('../models/redis')
// const { RateLimiterRedis } = require('rate-limiter-flexible') // 暂时未使用

// 🔑 API Key验证中间件（精简版）
const authenticateApiKey = async (req, res, next) => {
  const startTime = Date.now()

  try {
    // 安全提取API Key，支持多种格式（包括Gemini CLI支持）
    const apiKey =
      req.headers['x-api-key'] ||
      req.headers['x-goog-api-key'] ||
      req.headers['authorization']?.replace(/^Bearer\s+/i, '') ||
      req.headers['api-key'] ||
      req.query.key

    if (!apiKey) {
      logger.security(`🔒 Missing API key attempt from ${req.ip || 'unknown'}`)
      return res.status(401).json({
        error: 'Missing API key',
        message: 'Please provide an API key in the x-api-key header or Authorization header'
      })
    }

    // 基本API Key格式验证
    if (typeof apiKey !== 'string' || apiKey.length < 10 || apiKey.length > 512) {
      logger.security(`🔒 Invalid API key format from ${req.ip || 'unknown'}`)
      return res.status(401).json({
        error: 'Invalid API key format',
        message: 'API key format is invalid'
      })
    }

    // 验证API Key（带缓存优化）
    const validation = await apiKeyService.validateApiKey(apiKey)

    if (!validation.valid) {
      const clientIP = req.ip || req.connection?.remoteAddress || 'unknown'
      logger.security(`🔒 Invalid API key attempt: ${validation.error} from ${clientIP}`)
      return res.status(401).json({
        error: 'Invalid API key',
        message: validation.error
      })
    }

    // 将验证信息添加到请求对象（只包含核心信息）
    req.apiKey = {
      id: validation.keyData.id,
      name: validation.keyData.name,
      claudeAccountId: validation.keyData.claudeAccountId,
      claudeConsoleAccountId: validation.keyData.claudeConsoleAccountId,
      isActive: validation.keyData.isActive
    }

    const authDuration = Date.now() - startTime
    const userAgent = req.headers['user-agent'] || 'No User-Agent'
    logger.api(
      `🔓 Authenticated request from key: ${validation.keyData.name} (${validation.keyData.id}) in ${authDuration}ms`
    )
    logger.api(`   User-Agent: "${userAgent}"`)

    return next()
  } catch (error) {
    const authDuration = Date.now() - startTime
    logger.error(`❌ Authentication middleware error (${authDuration}ms):`, {
      error: error.message,
      stack: error.stack,
      ip: req.ip,
      userAgent: req.get('User-Agent'),
      url: req.originalUrl
    })

    return res.status(500).json({
      error: 'Authentication error',
      message: 'Internal server error during authentication'
    })
  }
}

// 🛡️ 管理员验证中间件（优化版）
const authenticateAdmin = async (req, res, next) => {
  const startTime = Date.now()

  try {
    // 安全提取token，支持多种方式
    const token =
      req.headers['authorization']?.replace(/^Bearer\s+/i, '') ||
      req.cookies?.adminToken ||
      req.headers['x-admin-token']

    if (!token) {
      logger.security(`🔒 Missing admin token attempt from ${req.ip || 'unknown'}`)
      return res.status(401).json({
        error: 'Missing admin token',
        message: 'Please provide an admin token'
      })
    }

    // 基本token格式验证
    if (typeof token !== 'string' || token.length < 32 || token.length > 512) {
      logger.security(`🔒 Invalid admin token format from ${req.ip || 'unknown'}`)
      return res.status(401).json({
        error: 'Invalid admin token format',
        message: 'Admin token format is invalid'
      })
    }

    // 获取管理员会话（带超时处理）
    const adminSession = await Promise.race([
      redis.getSession(token),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Session lookup timeout')), 5000)
      )
    ])

    if (!adminSession || Object.keys(adminSession).length === 0) {
      logger.security(`🔒 Invalid admin token attempt from ${req.ip || 'unknown'}`)
      return res.status(401).json({
        error: 'Invalid admin token',
        message: 'Invalid or expired admin session'
      })
    }

    // 检查会话活跃性（可选：检查最后活动时间）
    const now = new Date()
    const lastActivity = new Date(adminSession.lastActivity || adminSession.loginTime)
    const inactiveDuration = now - lastActivity
    const maxInactivity = 24 * 60 * 60 * 1000 // 24小时

    if (inactiveDuration > maxInactivity) {
      logger.security(
        `🔒 Expired admin session for ${adminSession.username} from ${req.ip || 'unknown'}`
      )
      await redis.deleteSession(token) // 清理过期会话
      return res.status(401).json({
        error: 'Session expired',
        message: 'Admin session has expired due to inactivity'
      })
    }

    // 更新最后活动时间（异步，不阻塞请求）
    redis
      .setSession(
        token,
        {
          ...adminSession,
          lastActivity: now.toISOString()
        },
        86400
      )
      .catch((error) => {
        logger.error('Failed to update admin session activity:', error)
      })

    // 设置管理员信息（只包含必要信息）
    req.admin = {
      id: adminSession.adminId || 'admin',
      username: adminSession.username,
      sessionId: token,
      loginTime: adminSession.loginTime
    }

    const authDuration = Date.now() - startTime
    logger.security(`🔐 Admin authenticated: ${adminSession.username} in ${authDuration}ms`)

    return next()
  } catch (error) {
    const authDuration = Date.now() - startTime
    logger.error(`❌ Admin authentication error (${authDuration}ms):`, {
      error: error.message,
      ip: req.ip,
      userAgent: req.get('User-Agent'),
      url: req.originalUrl
    })

    return res.status(500).json({
      error: 'Authentication error',
      message: 'Internal server error during admin authentication'
    })
  }
}

// 注意：使用统计现在直接在/api/v1/messages路由中处理，
// 以便从Claude API响应中提取真实的usage数据

// 🚦 CORS中间件（优化版）
const corsMiddleware = (req, res, next) => {
  const { origin } = req.headers

  // 允许的源（可以从配置文件读取）
  const allowedOrigins = [
    'http://localhost:3000',
    'https://localhost:3000',
    'http://127.0.0.1:3000',
    'https://127.0.0.1:3000'
  ]

  // 设置CORS头
  if (allowedOrigins.includes(origin) || !origin) {
    res.header('Access-Control-Allow-Origin', origin || '*')
  }

  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
  res.header(
    'Access-Control-Allow-Headers',
    [
      'Origin',
      'X-Requested-With',
      'Content-Type',
      'Accept',
      'Authorization',
      'x-api-key',
      'api-key',
      'x-admin-token'
    ].join(', ')
  )

  res.header('Access-Control-Expose-Headers', ['X-Request-ID', 'Content-Type'].join(', '))

  res.header('Access-Control-Max-Age', '86400') // 24小时预检缓存
  res.header('Access-Control-Allow-Credentials', 'true')

  if (req.method === 'OPTIONS') {
    res.status(204).end()
  } else {
    next()
  }
}

// 📝 请求日志中间件（优化版）
const requestLogger = (req, res, next) => {
  const start = Date.now()
  const requestId = Math.random().toString(36).substring(2, 15)

  // 添加请求ID到请求对象
  req.requestId = requestId
  res.setHeader('X-Request-ID', requestId)

  // 获取客户端信息
  const clientIP = req.ip || req.connection?.remoteAddress || req.socket?.remoteAddress || 'unknown'
  const userAgent = req.get('User-Agent') || 'unknown'
  const referer = req.get('Referer') || 'none'

  // 记录请求开始
  if (req.originalUrl !== '/health') {
    // 避免健康检查日志过多
    logger.info(`▶️ [${requestId}] ${req.method} ${req.originalUrl} | IP: ${clientIP}`)
  }

  res.on('finish', () => {
    const duration = Date.now() - start
    const contentLength = res.get('Content-Length') || '0'

    // 构建日志元数据
    const logMetadata = {
      requestId,
      method: req.method,
      url: req.originalUrl,
      status: res.statusCode,
      duration,
      contentLength,
      ip: clientIP,
      userAgent,
      referer
    }

    // 根据状态码选择日志级别
    if (res.statusCode >= 500) {
      logger.error(
        `◀️ [${requestId}] ${req.method} ${req.originalUrl} | ${res.statusCode} | ${duration}ms | ${contentLength}B`,
        logMetadata
      )
    } else if (res.statusCode >= 400) {
      logger.warn(
        `◀️ [${requestId}] ${req.method} ${req.originalUrl} | ${res.statusCode} | ${duration}ms | ${contentLength}B`,
        logMetadata
      )
    } else if (req.originalUrl !== '/health') {
      logger.request(req.method, req.originalUrl, res.statusCode, duration, logMetadata)
    }

    // API Key相关日志
    if (req.apiKey) {
      logger.api(
        `📱 [${requestId}] Request from ${req.apiKey.name} (${req.apiKey.id}) | ${duration}ms`
      )
    }

    // 慢请求警告
    if (duration > 5000) {
      logger.warn(
        `🐌 [${requestId}] Slow request detected: ${duration}ms for ${req.method} ${req.originalUrl}`
      )
    }
  })

  res.on('error', (error) => {
    const duration = Date.now() - start
    logger.error(`💥 [${requestId}] Response error after ${duration}ms:`, error)
  })

  next()
}

// 🛡️ 安全中间件（增强版）
const securityMiddleware = (req, res, next) => {
  // 设置基础安全头
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('X-XSS-Protection', '1; mode=block')
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin')

  // 添加更多安全头
  res.setHeader('X-DNS-Prefetch-Control', 'off')
  res.setHeader('X-Download-Options', 'noopen')
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none')

  // Cross-Origin-Opener-Policy (仅对可信来源设置)
  const host = req.get('host') || ''
  const isLocalhost =
    host.includes('localhost') || host.includes('127.0.0.1') || host.includes('0.0.0.0')
  const isHttps = req.secure || req.headers['x-forwarded-proto'] === 'https'

  if (isLocalhost || isHttps) {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
    res.setHeader('Origin-Agent-Cluster', '?1')
  }

  // Content Security Policy (适用于web界面)
  if (req.path.startsWith('/web') || req.path === '/') {
    res.setHeader(
      'Content-Security-Policy',
      [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://unpkg.com https://cdn.tailwindcss.com https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://cdn.bootcdn.net",
        "style-src 'self' 'unsafe-inline' https://cdn.tailwindcss.com https://cdnjs.cloudflare.com https://cdn.bootcdn.net",
        "font-src 'self' https://cdnjs.cloudflare.com https://cdn.bootcdn.net",
        "img-src 'self' data:",
        "connect-src 'self'",
        "frame-ancestors 'none'",
        "base-uri 'self'",
        "form-action 'self'"
      ].join('; ')
    )
  }

  // Strict Transport Security (HTTPS)
  if (req.secure || req.headers['x-forwarded-proto'] === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains')
  }

  // 移除泄露服务器信息的头
  res.removeHeader('X-Powered-By')
  res.removeHeader('Server')

  // 防止信息泄露
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate')
  res.setHeader('Pragma', 'no-cache')
  res.setHeader('Expires', '0')

  next()
}

// 🚨 错误处理中间件（增强版）
const errorHandler = (error, req, res, _next) => {
  const requestId = req.requestId || 'unknown'
  const isDevelopment = process.env.NODE_ENV === 'development'

  // 记录详细错误信息
  logger.error(`💥 [${requestId}] Unhandled error:`, {
    error: error.message,
    stack: error.stack,
    url: req.originalUrl,
    method: req.method,
    ip: req.ip || 'unknown',
    userAgent: req.get('User-Agent') || 'unknown',
    apiKey: req.apiKey ? req.apiKey.id : 'none',
    admin: req.admin ? req.admin.username : 'none'
  })

  // 确定HTTP状态码
  let statusCode = 500
  let errorMessage = 'Internal Server Error'
  let userMessage = 'Something went wrong'

  if (error.status && error.status >= 400 && error.status < 600) {
    statusCode = error.status
  }

  // 根据错误类型提供友好的错误消息
  switch (error.name) {
    case 'ValidationError':
      statusCode = 400
      errorMessage = 'Validation Error'
      userMessage = 'Invalid input data'
      break
    case 'CastError':
      statusCode = 400
      errorMessage = 'Cast Error'
      userMessage = 'Invalid data format'
      break
    case 'MongoError':
    case 'RedisError':
      statusCode = 503
      errorMessage = 'Database Error'
      userMessage = 'Database temporarily unavailable'
      break
    case 'TimeoutError':
      statusCode = 408
      errorMessage = 'Request Timeout'
      userMessage = 'Request took too long to process'
      break
    default:
      if (error.message && !isDevelopment) {
        // 在生产环境中，只显示安全的错误消息
        if (error.message.includes('ECONNREFUSED')) {
          userMessage = 'Service temporarily unavailable'
        } else if (error.message.includes('timeout')) {
          userMessage = 'Request timeout'
        }
      }
  }

  // 设置响应头
  res.setHeader('X-Request-ID', requestId)

  // 构建错误响应
  const errorResponse = {
    error: errorMessage,
    message: isDevelopment ? error.message : userMessage,
    requestId,
    timestamp: new Date().toISOString()
  }

  // 在开发环境中包含更多调试信息
  if (isDevelopment) {
    errorResponse.stack = error.stack
    errorResponse.url = req.originalUrl
    errorResponse.method = req.method
  }

  res.status(statusCode).json(errorResponse)
}

// 🌐 全局速率限制中间件（延迟初始化）
// const rateLimiter = null // 暂时未使用

// 暂时注释掉未使用的函数
// const getRateLimiter = () => {
//   if (!rateLimiter) {
//     try {
//       const client = redis.getClient()
//       if (!client) {
//         logger.warn('⚠️ Redis client not available for rate limiter')
//         return null
//       }
//
//       rateLimiter = new RateLimiterRedis({
//         storeClient: client,
//         keyPrefix: 'global_rate_limit',
//         points: 1000, // 请求数量
//         duration: 900, // 15分钟 (900秒)
//         blockDuration: 900 // 阻塞时间15分钟
//       })
//
//       logger.info('✅ Rate limiter initialized successfully')
//     } catch (error) {
//       logger.warn('⚠️ Rate limiter initialization failed, using fallback', { error: error.message })
//       return null
//     }
//   }
//   return rateLimiter
// }

const globalRateLimit = async (req, res, next) =>
  // 已禁用全局IP限流 - 直接跳过所有请求
  next()

// 以下代码已被禁用
/*
  // 跳过健康检查和内部请求
  if (req.path === '/health' || req.path === '/api/health') {
    return next()
  }

  const limiter = getRateLimiter()
  if (!limiter) {
    // 如果Redis不可用，直接跳过速率限制
    return next()
  }

  const clientIP = req.ip || req.connection?.remoteAddress || 'unknown'

  try {
    await limiter.consume(clientIP)
    return next()
  } catch (rejRes) {
    const remainingPoints = rejRes.remainingPoints || 0
    const msBeforeNext = rejRes.msBeforeNext || 900000

    logger.security(`🚦 Global rate limit exceeded for IP: ${clientIP}`)

    res.set({
      'Retry-After': Math.round(msBeforeNext / 1000) || 900,
      'X-RateLimit-Limit': 1000,
      'X-RateLimit-Remaining': remainingPoints,
      'X-RateLimit-Reset': new Date(Date.now() + msBeforeNext).toISOString()
    })

    return res.status(429).json({
      error: 'Too Many Requests',
      message: 'Too many requests from this IP, please try again later.',
      retryAfter: Math.round(msBeforeNext / 1000)
    })
  }
  */

// 📊 请求大小限制中间件
const requestSizeLimit = (req, res, next) => {
  const maxSize = 10 * 1024 * 1024 // 10MB
  const contentLength = parseInt(req.headers['content-length'] || '0')

  if (contentLength > maxSize) {
    logger.security(`🚨 Request too large: ${contentLength} bytes from ${req.ip}`)
    return res.status(413).json({
      error: 'Payload Too Large',
      message: 'Request body size exceeds limit',
      limit: '10MB'
    })
  }

  return next()
}

module.exports = {
  authenticateApiKey,
  authenticateAdmin,
  corsMiddleware,
  requestLogger,
  securityMiddleware,
  errorHandler,
  globalRateLimit,
  requestSizeLimit
}
