const winston = require('winston')
const DailyRotateFile = require('winston-daily-rotate-file')
const config = require('../../config/config')
const path = require('path')
const fs = require('fs')
const os = require('os')
const chokidar = require('chokidar')

// 安全的 JSON 序列化函数，处理循环引用和特殊字符
const safeStringify = (obj, maxDepth = 3, fullDepth = false) => {
  const seen = new WeakSet()
  // 如果是fullDepth模式，增加深度限制
  const actualMaxDepth = fullDepth ? 10 : maxDepth

  const replacer = (key, value, depth = 0) => {
    if (depth > actualMaxDepth) {
      return '[Max Depth Reached]'
    }

    // 处理字符串值，清理可能导致JSON解析错误的特殊字符
    if (typeof value === 'string') {
      try {
        // 移除或转义可能导致JSON解析错误的字符
        let cleanValue = value
          // eslint-disable-next-line no-control-regex
          .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '') // 移除控制字符
          .replace(/[\uD800-\uDFFF]/g, '') // 移除孤立的代理对字符
          // eslint-disable-next-line no-control-regex
          .replace(/\u0000/g, '') // 移除NUL字节

        // 如果字符串过长，截断并添加省略号
        if (cleanValue.length > 1000) {
          cleanValue = `${cleanValue.substring(0, 997)}...`
        }

        return cleanValue
      } catch (error) {
        return '[Invalid String Data]'
      }
    }

    if (value !== null && typeof value === 'object') {
      if (seen.has(value)) {
        return '[Circular Reference]'
      }
      seen.add(value)

      // 过滤掉常见的循环引用对象
      if (value.constructor) {
        const constructorName = value.constructor.name
        if (
          ['Socket', 'TLSSocket', 'HTTPParser', 'IncomingMessage', 'ServerResponse'].includes(
            constructorName
          )
        ) {
          return `[${constructorName} Object]`
        }
      }

      // 递归处理对象属性
      if (Array.isArray(value)) {
        return value.map((item, index) => replacer(index, item, depth + 1))
      } else {
        const result = {}
        for (const [k, v] of Object.entries(value)) {
          // 确保键名也是安全的
          // eslint-disable-next-line no-control-regex
          const safeKey = typeof k === 'string' ? k.replace(/[\u0000-\u001F\u007F]/g, '') : k
          result[safeKey] = replacer(safeKey, v, depth + 1)
        }
        return result
      }
    }

    return value
  }

  try {
    const processed = replacer('', obj)
    return JSON.stringify(processed)
  } catch (error) {
    // 如果JSON.stringify仍然失败，使用更保守的方法
    try {
      return JSON.stringify({
        error: 'Failed to serialize object',
        message: error.message,
        type: typeof obj,
        keys: obj && typeof obj === 'object' ? Object.keys(obj) : undefined
      })
    } catch (finalError) {
      return '{"error":"Critical serialization failure","message":"Unable to serialize any data"}'
    }
  }
}

// 📝 增强的日志格式
const createLogFormat = (colorize = false) => {
  const formats = [
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true })
    // 移除 winston.format.metadata() 来避免自动包装
  ]

  if (colorize) {
    formats.push(winston.format.colorize())
  }

  formats.push(
    winston.format.printf(({ level, message, timestamp, stack, ...rest }) => {
      const emoji = {
        error: '❌',
        warn: '⚠️ ',
        info: 'ℹ️ ',
        debug: '🐛',
        verbose: '📝'
      }

      let logMessage = `${emoji[level] || '📝'} [${timestamp}] ${level.toUpperCase()}: ${message}`

      // 直接处理额外数据，不需要metadata包装
      const additionalData = { ...rest }
      delete additionalData.level
      delete additionalData.message
      delete additionalData.timestamp
      delete additionalData.stack

      if (Object.keys(additionalData).length > 0) {
        logMessage += ` | ${safeStringify(additionalData)}`
      }

      return stack ? `${logMessage}\n${stack}` : logMessage
    })
  )

  return winston.format.combine(...formats)
}

const logFormat = createLogFormat(false)
const consoleFormat = createLogFormat(true)

// 📁 确保日志目录存在并设置权限
if (!fs.existsSync(config.logging.dirname)) {
  fs.mkdirSync(config.logging.dirname, { recursive: true, mode: 0o755 })
}

// 📂 文件监控和自动恢复系统
const fileWatcher = (() => {
  const watchers = new Map()
  const transportsMap = new Map() // 存储传输器引用

  // 监控日志文件，检测删除事件并自动重创建传输器
  const watchLogFile = (transport, filename) => {
    if (!filename || typeof filename !== 'string') {
      return
    }

    const fullPath = path.resolve(
      filename.replace('%DATE%', new Date().toISOString().split('T')[0])
    )
    const directory = path.dirname(fullPath)

    // 存储传输器引用
    transportsMap.set(fullPath, transport)

    try {
      // 监控日志目录
      const watcher = chokidar.watch(directory, {
        ignored: /(^|[/\\])\../, // 忽略隐藏文件
        persistent: true,
        ignoreInitial: true,
        awaitWriteFinish: {
          stabilityThreshold: 1000,
          pollInterval: 100
        }
      })

      watcher
        .on('unlink', (filePath) => {
          // 当文件被删除时
          if (transportsMap.has(filePath)) {
            const affectedTransport = transportsMap.get(filePath)

            // 防止重复处理同一个文件删除事件
            const delayKey = `recreate_${filePath}`
            if (watcher._delayedActions && watcher._delayedActions.has(delayKey)) {
              return // 已经在处理中，跳过
            }

            // 标记正在处理
            if (!watcher._delayedActions) {
              watcher._delayedActions = new Set()
            }
            watcher._delayedActions.add(delayKey)

            // 等待一小段时间，确保文件完全删除
            setTimeout(() => {
              try {
                // 重新创建文件和传输器
                recreateTransport(affectedTransport, filePath)
                console.log(`🔄 日志文件被删除已自动重创建: ${filePath}`)
              } catch (error) {
                console.error(`❌ 重创建日志传输器失败: ${error.message}`, error.stack)
              } finally {
                // 清除处理标记
                watcher._delayedActions.delete(delayKey)
              }
            }, 1000) // 增加延迟时间
          }
        })
        .on('error', (error) => {
          console.error(`📂 文件监控错误: ${error.message}`, error.stack)
        })

      watchers.set(fullPath, watcher)
    } catch (error) {
      console.warn(`📂 无法监控日志文件: ${fullPath}`, error.message)
    }
  }

  // 重新创建传输器
  const recreateTransport = (transport, filePath) => {
    try {
      // 对于 winston-daily-rotate-file，使用更直接的方法
      if (transport.getLogFilePath && typeof transport.getLogFilePath === 'function') {
        // 强制刷新内部状态
        if (transport._endStream && typeof transport._endStream === 'function') {
          transport._endStream(() => {
            // 重新初始化流
            if (transport._createLogDir && typeof transport._createLogDir === 'function') {
              transport._createLogDir()
            }
            if (transport._getFile && typeof transport._getFile === 'function') {
              transport._getFile(true) // 强制创建新文件
            }
          })
        }
      }

      // 备用方法：直接创建文件
      try {
        // 确保目录存在
        const dir = path.dirname(filePath)
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true })
        }

        // 如果文件不存在，创建一个空文件
        if (!fs.existsSync(filePath)) {
          fs.writeFileSync(filePath, '', { flag: 'a' }) // 使用追加模式确保文件存在
        }
      } catch (fsError) {
        console.warn(`文件系统操作警告: ${fsError.message}`)
      }

      // 强制触发日志写入以验证文件可写性
      setTimeout(() => {
        try {
          if (transport.write && typeof transport.write === 'function') {
            transport.write({ level: 'info', message: 'Transport recreated successfully' })
          }
        } catch (writeError) {
          console.warn(`测试写入警告: ${writeError.message}`)
        }
      }, 100)

      console.log(`✅ 传输器重创建成功: ${filePath}`)
    } catch (error) {
      console.error(`❌ 传输器重创建失败: ${error.message}`, error.stack)
      throw error
    }
  }

  // 清理所有监控器
  const cleanup = () => {
    watchers.forEach((watcher) => {
      try {
        watcher.close()
      } catch (error) {
        console.warn('关闭文件监控器时出错:', error.message)
      }
    })
    watchers.clear()
    transportsMap.clear()
  }

  // 监听进程退出事件，清理资源
  process.on('exit', cleanup)
  process.on('SIGINT', cleanup)
  process.on('SIGTERM', cleanup)

  return {
    watchLogFile,
    cleanup,
    getWatchers: () => Array.from(watchers.keys()),
    getTransports: () => Array.from(transportsMap.keys())
  }
})()

// 🔄 增强的日志轮转配置
const createRotateTransport = (filename, level = null) => {
  const transport = new DailyRotateFile({
    filename: path.join(config.logging.dirname, filename),
    datePattern: 'YYYY-MM-DD',
    zippedArchive: true,
    maxSize: config.logging.maxSize,
    maxFiles: config.logging.maxFiles,
    auditFile: path.join(config.logging.dirname, `.${filename.replace('%DATE%', 'audit')}.json`),
    format: logFormat
  })

  if (level) {
    transport.level = level
  }

  // 监听轮转事件 - 在测试环境中禁用console输出
  if (process.env.NODE_ENV !== 'test') {
    transport.on('rotate', (oldFilename, newFilename) => {
      console.log(`📦 Log rotated: ${oldFilename} -> ${newFilename}`)
    })

    transport.on('new', (newFilename) => {
      console.log(`📄 New log file created: ${newFilename}`)
    })

    transport.on('archive', (zipFilename) => {
      console.log(`🗜️ Log archived: ${zipFilename}`)
    })

    // 🔄 为每个传输器启动文件监控
    try {
      const fullFilename = path.join(config.logging.dirname, filename)
      fileWatcher.watchLogFile(transport, fullFilename)
      console.log(`📂 已启动日志文件监控: ${fullFilename}`)
    } catch (error) {
      console.warn(`📂 启动日志文件监控失败: ${error.message}`)
    }
  }

  return transport
}

const dailyRotateFileTransport = createRotateTransport('claude-relay-%DATE%.log')
const errorFileTransport = createRotateTransport('claude-relay-error-%DATE%.log', 'error')

// 🔒 创建专门的安全日志记录器
const securityLogger = winston.createLogger({
  level: 'warn',
  format: logFormat,
  transports: [createRotateTransport('claude-relay-security-%DATE%.log', 'warn')],
  silent: false
})

// 🔐 创建专门的认证详细日志记录器（记录完整的认证响应）
const authDetailLogger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.printf(({ level, message, timestamp, data }) => {
      // 使用更深的深度和格式化的JSON输出
      const jsonData = data ? JSON.stringify(data, null, 2) : '{}'
      return `[${timestamp}] ${level.toUpperCase()}: ${message}\n${jsonData}\n${'='.repeat(80)}`
    })
  ),
  transports: [createRotateTransport('claude-relay-auth-detail-%DATE%.log', 'info')],
  silent: false
})

// 🌟 增强的 Winston logger
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || config.logging.level,
  format: logFormat,
  transports: [
    // 📄 文件输出
    dailyRotateFileTransport,
    errorFileTransport,

    // 🖥️ 控制台输出
    new winston.transports.Console({
      format: consoleFormat,
      handleExceptions: false,
      handleRejections: false
    })
  ],

  // 🚨 异常处理
  exceptionHandlers: [
    new winston.transports.File({
      filename: path.join(config.logging.dirname, 'exceptions.log'),
      format: logFormat,
      maxsize: 10485760, // 10MB
      maxFiles: 5
    }),
    new winston.transports.Console({
      format: consoleFormat
    })
  ],

  // 🔄 未捕获异常处理
  rejectionHandlers: [
    new winston.transports.File({
      filename: path.join(config.logging.dirname, 'rejections.log'),
      format: logFormat,
      maxsize: 10485760, // 10MB
      maxFiles: 5
    }),
    new winston.transports.Console({
      format: consoleFormat
    })
  ],

  // 防止进程退出
  exitOnError: false
})

// 🎯 增强的自定义方法
logger.success = (message, metadata = {}) => {
  logger.info(`✅ ${message}`, { type: 'success', ...metadata })
}

logger.start = (message, metadata = {}) => {
  logger.info(`🚀 ${message}`, { type: 'startup', ...metadata })
}

logger.request = (method, url, status, duration, metadata = {}) => {
  const emoji = status >= 400 ? '🔴' : status >= 300 ? '🟡' : '🟢'
  const level = status >= 400 ? 'error' : status >= 300 ? 'warn' : 'info'

  logger[level](`${emoji} ${method} ${url} - ${status} (${duration}ms)`, {
    type: 'request',
    method,
    url,
    status,
    duration,
    ...metadata
  })
}

logger.api = (message, metadata = {}) => {
  logger.info(`🔗 ${message}`, { type: 'api', ...metadata })
}

logger.security = (message, metadata = {}) => {
  const securityData = {
    type: 'security',
    timestamp: new Date().toISOString(),
    pid: process.pid,
    hostname: os.hostname(),
    ...metadata
  }

  // 记录到主日志
  logger.info(`🔒 ${message}`, securityData)

  // 记录到专门的安全日志文件
  try {
    securityLogger.info(`🔒 ${message}`, securityData)
  } catch (error) {
    // 如果安全日志文件不可用，只记录到主日志
    if (process.env.NODE_ENV !== 'test') {
      console.warn('Security logger not available:', error.message)
    }
  }
}

logger.database = (message, metadata = {}) => {
  logger.debug(`💾 ${message}`, { type: 'database', ...metadata })
}

logger.performance = (message, metadata = {}) => {
  logger.info(`⚡ ${message}`, { type: 'performance', ...metadata })
}

logger.audit = (message, metadata = {}) => {
  logger.info(`📋 ${message}`, {
    type: 'audit',
    timestamp: new Date().toISOString(),
    pid: process.pid,
    ...metadata
  })
}

// 🔧 性能监控方法
logger.timer = (label) => {
  const start = Date.now()
  return {
    end: (message = '', metadata = {}) => {
      const duration = Date.now() - start
      logger.performance(`${label} ${message}`, { duration, ...metadata })
      return duration
    }
  }
}

// 📊 日志统计
logger.stats = {
  requests: 0,
  errors: 0,
  warnings: 0
}

// 重写原始方法以统计
const originalError = logger.error
const originalWarn = logger.warn
const originalInfo = logger.info

logger.error = function (message, ...args) {
  logger.stats.errors++
  return originalError.call(this, message, ...args)
}

logger.warn = function (message, ...args) {
  logger.stats.warnings++
  return originalWarn.call(this, message, ...args)
}

logger.info = function (message, ...args) {
  // 检查是否是请求类型的日志
  if (args.length > 0 && typeof args[0] === 'object' && args[0].type === 'request') {
    logger.stats.requests++
  }
  return originalInfo.call(this, message, ...args)
}

// 📈 获取日志统计
logger.getStats = () => ({ ...logger.stats })

// 🧹 清理统计
logger.resetStats = () => {
  logger.stats.requests = 0
  logger.stats.errors = 0
  logger.stats.warnings = 0
}

// 📡 健康检查
logger.healthCheck = () => {
  try {
    const testMessage = 'Logger health check'
    logger.debug(testMessage)
    return { healthy: true, timestamp: new Date().toISOString() }
  } catch (error) {
    return { healthy: false, error: error.message, timestamp: new Date().toISOString() }
  }
}

// 🔐 记录认证详细信息的方法
logger.authDetail = (message, data = {}) => {
  try {
    // 记录到主日志（简化版）
    logger.info(`🔐 ${message}`, {
      type: 'auth-detail',
      summary: {
        hasAccessToken: !!data.access_token,
        hasRefreshToken: !!data.refresh_token,
        scopes: data.scope || data.scopes,
        organization: data.organization?.name,
        account: data.account?.email_address
      }
    })

    // 记录到专门的认证详细日志文件（完整数据）
    authDetailLogger.info(message, { data })
  } catch (error) {
    logger.error('Failed to log auth detail:', error)
  }
}

// 🎬 启动日志记录系统
logger.start('Logger initialized', {
  level: process.env.LOG_LEVEL || config.logging.level,
  directory: config.logging.dirname,
  maxSize: config.logging.maxSize,
  maxFiles: config.logging.maxFiles,
  envOverride: process.env.LOG_LEVEL ? true : false
})

// 📂 文件监控功能已整合到前面的定义中

// 文件监控功能已集成到原有的 createRotateTransport 函数中

// 🔍 增强健康检查，包含文件监控状态
const originalHealthCheck = logger.healthCheck
logger.healthCheck = () => {
  const baseHealth = originalHealthCheck()

  return {
    ...baseHealth,
    fileWatcher: {
      watchersCount: fileWatcher.getWatchers().length,
      transportsCount: fileWatcher.getTransports().length,
      watching: fileWatcher.getWatchers()
    }
  }
}

// 🧹 添加清理方法
logger.cleanup = () => {
  fileWatcher.cleanup()
  logger.info('🧹 日志系统资源已清理')
}

module.exports = logger
