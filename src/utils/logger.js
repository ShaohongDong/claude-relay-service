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

// 📂 优化的文件监控和自动恢复系统
const fileWatcher = (() => {
  const directoryWatchers = new Map() // 目录级别的监控器，避免重复
  const fileTransportsMap = new Map() // 文件路径 -> 传输器信息的映射
  const pendingRecreations = new Set() // 防止重复重创建
  const loggerInstance = {} // 存储logger实例引用

  // 创建或获取目录级别的监控器（避免重复监控同一目录）
  const getOrCreateDirectoryWatcher = (directory) => {
    if (directoryWatchers.has(directory)) {
      return directoryWatchers.get(directory)
    }

    try {
      const watcher = chokidar.watch(directory, {
        ignored: /(^|[/\\])\./, // 忽略隐藏文件
        persistent: true,
        ignoreInitial: true,
        awaitWriteFinish: {
          stabilityThreshold: 300, // 减少等待时间
          pollInterval: 100
        }
      })

      watcher
        .on('unlink', handleFileDeleted)
        .on('error', (error) => {
          console.error(`📂 目录监控错误 ${directory}:`, error.message)
        })

      directoryWatchers.set(directory, watcher)
      console.log(`📁 创建目录监控器: ${path.basename(directory)}`)
      return watcher
    } catch (error) {
      console.warn(`📂 创建目录监控器失败 ${directory}:`, error.message)
      return null
    }
  }

  // 集中处理文件删除事件（避免重复触发）
  const handleFileDeleted = (filePath) => {
    const normalizedPath = path.normalize(filePath)
    
    // 检查是否有传输器关联到这个文件
    if (!fileTransportsMap.has(normalizedPath)) {
      return // 没有关联的传输器，忽略
    }

    // 防止重复处理同一个文件（使用全局去重）
    if (pendingRecreations.has(normalizedPath)) {
      return
    }

    pendingRecreations.add(normalizedPath)
    console.log(`🗑️ 检测到文件删除: ${path.basename(normalizedPath)}`)

    // 使用更短的延迟，提高响应速度
    setTimeout(() => {
      try {
        const transportInfo = fileTransportsMap.get(normalizedPath)
        if (transportInfo) {
          recreateTransport(transportInfo.transport, normalizedPath, transportInfo.filename, transportInfo.config)
          console.log(`🔄 传输器重创建完成: ${path.basename(normalizedPath)}`)
        }
      } catch (error) {
        console.error(`❌ 处理文件删除失败 ${normalizedPath}:`, error.message)
      } finally {
        pendingRecreations.delete(normalizedPath)
      }
    }, 300) // 减少延迟时间，提高响应速度
  }

  // 注册文件监控（优化版）
  const watchLogFile = (transport, filename, transportConfig = null) => {
    if (!filename || typeof filename !== 'string') {
      return
    }

    // 解析实际的文件路径
    let fullPath
    if (path.isAbsolute(filename)) {
      fullPath = filename.replace('%DATE%', new Date().toISOString().split('T')[0])
    } else {
      fullPath = path.resolve(filename.replace('%DATE%', new Date().toISOString().split('T')[0]))
    }
    
    const directory = path.dirname(fullPath)
    const normalizedPath = path.normalize(fullPath)

    // 避免重复注册同一个文件
    if (fileTransportsMap.has(normalizedPath)) {
      console.log(`⚠️ 文件已在监控中: ${path.basename(normalizedPath)}`)
      return
    }

    // 存储传输器信息
    fileTransportsMap.set(normalizedPath, {
      transport,
      filename,
      config: transportConfig
    })

    // 获取或创建目录监控器（一个目录只需要一个监控器）
    getOrCreateDirectoryWatcher(directory)
    
    console.log(`📂 注册文件监控: ${path.basename(normalizedPath)}`)
  }

  // 🔄 优化的传输器重创建方法
  const recreateTransport = (oldTransport, filePath, originalFilename, config) => {
    try {
      const fileName = path.basename(filePath)
      
      // 1. 安全关闭旧传输器
      closeTransportSafely(oldTransport)

      // 2. 确保目录存在
      ensureDirectoryExists(path.dirname(filePath))

      // 3. 创建新传输器
      const newTransport = createTransportFromConfig(config, originalFilename, oldTransport)

      // 4. 在logger中替换传输器
      replaceTransportInLogger(oldTransport, newTransport, filePath, originalFilename, config)

      // 5. 验证新传输器工作正常
      validateTransport(newTransport)

    } catch (error) {
      console.error(`❌ 传输器重创建失败 ${path.basename(filePath)}:`, error.message)
      throw error
    }
  }

  // 安全关闭传输器的辅助方法
  const closeTransportSafely = (transport) => {
    try {
      // 关闭文件流
      if (transport._stream) {
        transport._stream.end()
        transport._stream.destroy()
        transport._stream = null
      }
      
      // 调用传输器的关闭方法
      if (transport.close && typeof transport.close === 'function') {
        transport.close()
      }
    } catch (error) {
      console.warn('关闭传输器时出错:', error.message)
    }
  }

  // 确保目录存在的辅助方法
  const ensureDirectoryExists = (directory) => {
    try {
      if (!fs.existsSync(directory)) {
        fs.mkdirSync(directory, { recursive: true })
      }
    } catch (error) {
      console.warn(`创建目录失败 ${directory}:`, error.message)
    }
  }

  // 从配置创建传输器的辅助方法
  const createTransportFromConfig = (config, originalFilename, oldTransport) => {
    if (config) {
      return new DailyRotateFile(config)
    }

    // 根据旧传输器配置重新创建
    const appConfig = require('../../config/config')
    const transportConfig = {
      filename: path.join(appConfig.logging.dirname, originalFilename),
      datePattern: 'YYYY-MM-DD',
      zippedArchive: true,
      maxSize: oldTransport.maxSize || appConfig.logging.maxSize,
      maxFiles: oldTransport.maxFiles || appConfig.logging.maxFiles,
      auditFile: path.join(
        appConfig.logging.dirname, 
        `.${originalFilename.replace('%DATE%', 'audit')}.json`
      ),
      format: oldTransport.format || logFormat,
      level: oldTransport.level
    }
    return new DailyRotateFile(transportConfig)
  }

  // 在logger中替换传输器的辅助方法
  const replaceTransportInLogger = (oldTransport, newTransport, filePath, originalFilename, config) => {
    if (!loggerInstance.logger) {
      throw new Error('Logger实例未设置')
    }

    const logger = loggerInstance.logger
    
    // 移除旧传输器
    try {
      logger.remove(oldTransport)
    } catch (error) {
      // 备用方法：直接过滤数组
      logger.transports = logger.transports.filter(t => t !== oldTransport)
    }
    
    // 添加新传输器
    logger.add(newTransport)
    
    // 更新映射表
    fileTransportsMap.set(path.normalize(filePath), {
      transport: newTransport,
      filename: originalFilename,
      config
    })
  }

  // 验证传输器是否正常工作
  const validateTransport = (transport) => {
    setTimeout(() => {
      try {
        if (transport && loggerInstance.logger) {
          loggerInstance.logger.debug('🔄 传输器重创建验证')
        }
      } catch (error) {
        console.warn('传输器验证警告:', error.message)
      }
    }, 50)
  }

  // 设置logger实例引用
  const setLoggerInstance = (logger) => {
    loggerInstance.logger = logger
  }

  // 🧹 优化的资源清理方法
  const cleanup = () => {
    console.log('🧹 开始清理日志监控资源...')
    
    // 清理目录监控器
    let cleanedWatchers = 0
    directoryWatchers.forEach((watcher, directory) => {
      try {
        watcher.close()
        cleanedWatchers++
      } catch (error) {
        console.warn(`关闭目录监控器失败 ${directory}:`, error.message)
      }
    })
    
    // 清理数据结构
    directoryWatchers.clear()
    fileTransportsMap.clear()
    pendingRecreations.clear()
    
    console.log(`✅ 已清理 ${cleanedWatchers} 个监控器和相关资源`)
  }

  // 获取监控状态信息
  const getMonitoringStatus = () => {
    return {
      directoryWatchers: directoryWatchers.size,
      monitoredFiles: fileTransportsMap.size,
      pendingRecreations: pendingRecreations.size,
      watchedDirectories: Array.from(directoryWatchers.keys()).map(dir => path.basename(dir)),
      monitoredFilesList: Array.from(fileTransportsMap.keys()).map(file => path.basename(file))
    }
  }

  // 监听进程退出事件，确保资源清理
  const setupProcessExitHandlers = () => {
    const exitHandler = (eventType) => {
      console.log(`📤 接收到 ${eventType} 事件，清理日志监控资源`)
      cleanup()
    }

    process.on('exit', () => exitHandler('exit'))
    process.on('SIGINT', () => exitHandler('SIGINT'))
    process.on('SIGTERM', () => exitHandler('SIGTERM'))
    process.on('SIGHUP', () => exitHandler('SIGHUP'))
  }

  // 初始化退出处理器
  setupProcessExitHandlers()

  return {
    watchLogFile,
    setLoggerInstance,
    cleanup,
    getMonitoringStatus,
    // 向后兼容的方法
    getWatchers: () => Array.from(directoryWatchers.keys()),
    getTransports: () => Array.from(fileTransportsMap.keys())
  }
})()

// 🔄 增强的日志轮转配置
const createRotateTransport = (filename, level = null) => {
  const transportConfig = {
    filename: path.join(config.logging.dirname, filename),
    datePattern: 'YYYY-MM-DD',
    zippedArchive: true,
    maxSize: config.logging.maxSize,
    maxFiles: config.logging.maxFiles,
    auditFile: path.join(config.logging.dirname, `.${filename.replace('%DATE%', 'audit')}.json`),
    format: logFormat
  }

  if (level) {
    transportConfig.level = level
  }

  const transport = new DailyRotateFile(transportConfig)

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

    // 🔄 为每个传输器启动文件监控，传递完整配置
    try {
      const fullFilename = path.join(config.logging.dirname, filename)
      // 传递完整路径而不是仅文件名
      fileWatcher.watchLogFile(transport, fullFilename, transportConfig)
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

// 设置logger实例引用，以便文件监控系统可以替换传输器
fileWatcher.setLoggerInstance(logger)

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

// 🔍 增强健康检查，包含优化后的文件监控状态
const originalHealthCheck = logger.healthCheck
logger.healthCheck = () => {
  const baseHealth = originalHealthCheck()
  const monitoringStatus = fileWatcher.getMonitoringStatus()

  return {
    ...baseHealth,
    fileWatcher: {
      ...monitoringStatus,
      status: monitoringStatus.directoryWatchers > 0 ? 'active' : 'inactive',
      efficiency: monitoringStatus.directoryWatchers > 0 ? 
        Math.round(monitoringStatus.monitoredFiles / monitoringStatus.directoryWatchers * 100) / 100 : 0
    }
  }
}

// 🧹 添加清理方法
logger.cleanup = () => {
  fileWatcher.cleanup()
  logger.info('🧹 日志系统资源已清理')
}

module.exports = logger
