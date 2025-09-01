const winston = require('winston')
const DailyRotateFile = require('winston-daily-rotate-file')
const path = require('path')
const fs = require('fs')
const chokidar = require('chokidar')
const { maskToken } = require('./tokenMask')

// 确保日志目录存在
const logDir = path.join(process.cwd(), 'logs')
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true })
}

// 📂 文件监控和自动恢复系统 (复用主日志系统的逻辑)
const tokenFileWatcher = (() => {
  const watchers = new Map()
  const transportsMap = new Map()

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
                console.log(`🔄 Token刷新日志文件被删除已自动重创建: ${filePath}`)
              } catch (error) {
                console.error(`❌ 重创建Token日志传输器失败: ${error.message}`, error.stack)
              } finally {
                // 清除处理标记
                watcher._delayedActions.delete(delayKey)
              }
            }, 1000) // 增加延迟时间
          }
        })
        .on('error', (error) => {
          console.error(`📂 Token日志文件监控错误: ${error.message}`, error.stack)
        })

      watchers.set(fullPath, watcher)
    } catch (error) {
      console.warn(`📂 无法监控Token日志文件: ${fullPath}`, error.message)
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
        console.warn(`Token文件系统操作警告: ${fsError.message}`)
      }

      // 强制触发日志写入以验证文件可写性
      setTimeout(() => {
        try {
          if (transport.write && typeof transport.write === 'function') {
            transport.write({ level: 'info', message: 'Token transport recreated successfully' })
          }
        } catch (writeError) {
          console.warn(`Token测试写入警告: ${writeError.message}`)
        }
      }, 100)

      console.log(`✅ Token传输器重创建成功: ${filePath}`)
    } catch (error) {
      console.error(`❌ Token传输器重创建失败: ${error.message}`, error.stack)
      throw error
    }
  }

  // 清理所有监控器
  const cleanup = () => {
    watchers.forEach((watcher) => {
      try {
        watcher.close()
      } catch (error) {
        console.warn('关闭Token日志监控器时出错:', error.message)
      }
    })
    watchers.clear()
    transportsMap.clear()
  }

  return {
    watchLogFile,
    cleanup,
    getWatchers: () => Array.from(watchers.keys()),
    getTransports: () => Array.from(transportsMap.keys())
  }
})()

// 🔄 创建轮转文件传输器
const createRotateTransport = (filename, level = null) => {
  const transport = new DailyRotateFile({
    filename: path.join(logDir, filename),
    datePattern: 'YYYY-MM-DD',
    zippedArchive: true,
    maxSize: '10m',
    maxFiles: '30d',
    auditFile: path.join(logDir, `.${filename.replace('%DATE%', 'audit')}.json`),
    format: winston.format.combine(
      winston.format.timestamp({
        format: 'YYYY-MM-DD HH:mm:ss.SSS'
      }),
      winston.format.json(),
      winston.format.printf((info) => JSON.stringify(info, null, 2))
    )
  })

  if (level) {
    transport.level = level
  }

  // 监听轮转事件
  if (process.env.NODE_ENV !== 'test') {
    transport.on('rotate', (oldFilename, newFilename) => {
      console.log(`📦 Token刷新日志轮转: ${oldFilename} -> ${newFilename}`)
    })

    transport.on('new', (newFilename) => {
      console.log(`📄 新Token刷新日志文件: ${newFilename}`)
    })

    transport.on('archive', (zipFilename) => {
      console.log(`🗜️ Token刷新日志归档: ${zipFilename}`)
    })

    // 🔄 为每个传输器启动文件监控
    try {
      const fullFilename = path.join(logDir, filename)
      tokenFileWatcher.watchLogFile(transport, fullFilename)
      console.log(`📂 已启动Token日志文件监控: ${fullFilename}`)
    } catch (error) {
      console.warn(`📂 启动Token日志文件监控失败: ${error.message}`)
    }
  }

  return transport
}

// 创建专用的 token 刷新日志记录器
const tokenRefreshLogger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp({
      format: 'YYYY-MM-DD HH:mm:ss.SSS'
    }),
    winston.format.json(),
    winston.format.printf((info) => JSON.stringify(info, null, 2))
  ),
  transports: [
    // 文件传输 - 每日轮转
    createRotateTransport('token-refresh-%DATE%.log'),
    // 错误单独记录
    createRotateTransport('token-refresh-error-%DATE%.log', 'error')
  ],
  // 错误处理
  exitOnError: false
})

// 在开发环境添加控制台输出
if (process.env.NODE_ENV !== 'production') {
  tokenRefreshLogger.add(
    new winston.transports.Console({
      format: winston.format.combine(winston.format.colorize(), winston.format.simple())
    })
  )
}

/**
 * 记录 token 刷新开始
 */
function logRefreshStart(accountId, accountName, platform = 'claude', reason = '') {
  tokenRefreshLogger.info({
    event: 'token_refresh_start',
    accountId,
    accountName,
    platform,
    reason,
    timestamp: new Date().toISOString()
  })
}

/**
 * 记录 token 刷新成功
 */
function logRefreshSuccess(accountId, accountName, platform = 'claude', tokenData = {}) {
  const maskedTokenData = {
    accessToken: tokenData.accessToken ? maskToken(tokenData.accessToken) : '[NOT_PROVIDED]',
    refreshToken: tokenData.refreshToken ? maskToken(tokenData.refreshToken) : '[NOT_PROVIDED]',
    expiresAt: tokenData.expiresAt || tokenData.expiry_date || '[NOT_PROVIDED]',
    scopes: tokenData.scopes || tokenData.scope || '[NOT_PROVIDED]'
  }

  tokenRefreshLogger.info({
    event: 'token_refresh_success',
    accountId,
    accountName,
    platform,
    tokenData: maskedTokenData,
    timestamp: new Date().toISOString()
  })
}

/**
 * 记录 token 刷新失败
 */
function logRefreshError(accountId, accountName, platform = 'claude', error, attemptNumber = 1) {
  const errorInfo = {
    message: error.message || error.toString(),
    code: error.code || 'UNKNOWN',
    statusCode: error.response?.status || 'N/A',
    responseData: error.response?.data || 'N/A'
  }

  tokenRefreshLogger.error({
    event: 'token_refresh_error',
    accountId,
    accountName,
    platform,
    error: errorInfo,
    attemptNumber,
    timestamp: new Date().toISOString()
  })
}

/**
 * 记录 token 刷新跳过（由于并发锁）
 */
function logRefreshSkipped(accountId, accountName, platform = 'claude', reason = 'locked') {
  tokenRefreshLogger.info({
    event: 'token_refresh_skipped',
    accountId,
    accountName,
    platform,
    reason,
    timestamp: new Date().toISOString()
  })
}

/**
 * 记录 token 使用情况
 */
function logTokenUsage(accountId, accountName, platform = 'claude', expiresAt, isExpired) {
  tokenRefreshLogger.debug({
    event: 'token_usage_check',
    accountId,
    accountName,
    platform,
    expiresAt,
    isExpired,
    remainingMinutes: expiresAt ? Math.floor((new Date(expiresAt) - Date.now()) / 60000) : 'N/A',
    timestamp: new Date().toISOString()
  })
}

/**
 * 记录批量刷新任务
 */
function logBatchRefreshStart(totalAccounts, platform = 'all') {
  tokenRefreshLogger.info({
    event: 'batch_refresh_start',
    totalAccounts,
    platform,
    timestamp: new Date().toISOString()
  })
}

/**
 * 记录批量刷新结果
 */
function logBatchRefreshComplete(results) {
  tokenRefreshLogger.info({
    event: 'batch_refresh_complete',
    results: {
      total: results.total || 0,
      success: results.success || 0,
      failed: results.failed || 0,
      skipped: results.skipped || 0
    },
    timestamp: new Date().toISOString()
  })
}

// 📂 Token文件监控功能已整合到前面的定义中

// 文件监控功能已集成到原有的 createRotateTransport 函数中

// 🧹 添加清理方法到logger
tokenRefreshLogger.cleanup = () => {
  tokenFileWatcher.cleanup()
  console.log('🧹 Token日志系统资源已清理')
}

module.exports = {
  logger: tokenRefreshLogger,
  logRefreshStart,
  logRefreshSuccess,
  logRefreshError,
  logRefreshSkipped,
  logTokenUsage,
  logBatchRefreshStart,
  logBatchRefreshComplete
}
