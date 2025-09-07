const { performance } = require('perf_hooks')
const { v4: uuidv4 } = require('uuid')
const EventEmitter = require('events')
const ProxyHelper = require('../utils/proxyHelper')
const logger = require('../utils/logger')
const performanceOptimizer = require('../utils/performanceOptimizer')

/**
 * 智能连接池 - 为单个账户管理代理连接
 * 特性：
 * - 事件驱动的自动重连
 * - Socket断开监听
 * - 指数退避重试机制
 * - 严格的账户隔离
 */
class SmartConnectionPool extends EventEmitter {
  constructor(accountId, proxyConfig) {
    super()
    this.accountId = accountId
    this.proxyConfig = proxyConfig
    this.connections = []
    this.targetSize = 3 // 目标连接数
    this.isInitialized = false
    this.stats = {
      totalConnections: 0,
      reconnectCount: 0,
      lastReconnectAt: null,
      errorCount: 0
    }

    logger.info(`🎯 创建智能连接池: 账户 ${accountId}`)
  }

  /**
   * 初始化连接池 - 预热所有连接
   */
  async initialize() {
    if (this.isInitialized) {
      return
    }

    logger.info(`🚀 开始预热连接池: 账户 ${this.accountId}`)

    try {
      // 创建目标数量的连接
      for (let i = 0; i < this.targetSize; i++) {
        const connection = await this.createMonitoredConnection()
        this.connections.push(connection)
        logger.debug(`✅ 连接 ${i + 1}/${this.targetSize} 创建成功: 账户 ${this.accountId}`)
      }

      this.isInitialized = true
      logger.success(
        `🎉 连接池预热完成: 账户 ${this.accountId} (${this.connections.length} 个连接)`
      )

      // 发射连接池状态变化事件
      this.emit('pool:status:changed', {
        oldStatus: 'initializing',
        status: 'ready',
        healthyConnections: this.connections.filter((conn) => conn.isHealthy).length,
        totalConnections: this.connections.length
      })
    } catch (error) {
      logger.error(`❌ 连接池初始化失败: 账户 ${this.accountId}`, error.message)
      throw error
    }
  }

  /**
   * 创建带监控的连接
   */
  async createMonitoredConnection() {
    const startTime = performance.now()

    try {
      // 创建代理Agent
      const agent = ProxyHelper.createProxyAgent(this.proxyConfig)
      if (!agent) {
        throw new Error('Failed to create proxy agent')
      }

      const connection = {
        id: performanceOptimizer.getPooledUUID(),
        accountId: this.accountId,
        agent,
        createdAt: Date.now(),
        isHealthy: true,
        usageCount: 0,
        lastUsedAt: null
      }

      // 附加事件监听器
      this.attachEventListeners(connection)

      this.stats.totalConnections++

      const createTime = performance.now() - startTime
      logger.debug(`🔗 监控连接已创建: 账户 ${this.accountId}, 耗时: ${createTime.toFixed(2)}ms`)

      // 发射连接成功事件
      this.emit('connection:connected', {
        connectionId: connection.id,
        latency: createTime
      })

      return connection
    } catch (error) {
      this.stats.errorCount++
      logger.error(`❌ 创建监控连接失败: 账户 ${this.accountId}`, error.message)
      throw error
    }
  }

  /**
   * 为连接附加事件监听器 - 优化内存管理
   */
  attachEventListeners(connection) {
    if (!connection.agent || typeof connection.agent.createSocket !== 'function') {
      logger.warn(`⚠️ 代理Agent不支持socket监听: 账户 ${this.accountId}`)
      return
    }

    try {
      // Hook createSocket方法以监听socket事件
      const originalCreateSocket = connection.agent.createSocket.bind(connection.agent)
      
      // 存储原始方法的引用以便清理
      connection._originalCreateSocket = originalCreateSocket

      connection.agent.createSocket = (options, callback) => {
        const socket = originalCreateSocket(options, callback)

        // 使用WeakRef和FinalizationRegistry来优化内存管理
        const connectionRef = new WeakRef(connection)
        const poolRef = new WeakRef(this)

        // 创建优化的事件处理器，避免强引用
        const createHandler = (handlerType) => {
          return (...args) => {
            const conn = connectionRef.deref()
            const pool = poolRef.deref()
            
            if (!conn || !pool) {
              // 连接或池已被回收，移除监听器
              socket.removeAllListeners()
              return
            }

            switch (handlerType) {
              case 'close':
                pool.handleConnectionClose(conn, args[0])
                break
              case 'error':
                pool.handleConnectionError(conn, args[0])
                break
              case 'timeout':
                pool.handleConnectionTimeout(conn)
                break
              case 'end':
                pool.handleConnectionEnd(conn)
                break
            }
          }
        }

        // 存储事件处理器引用以便清理
        const handlers = {
          close: createHandler('close'),
          error: createHandler('error'),
          timeout: createHandler('timeout'),
          end: createHandler('end')
        }

        // 附加事件监听器
        socket.on('close', handlers.close)
        socket.on('error', handlers.error)
        socket.on('timeout', handlers.timeout)
        socket.on('end', handlers.end)

        // 存储处理器引用和socket引用用于清理
        if (!connection._sockets) {
          connection._sockets = new Set()
        }
        if (!connection._handlers) {
          connection._handlers = new Map()
        }

        connection._sockets.add(socket)
        connection._handlers.set(socket, handlers)

        // 自动清理断开的socket
        socket.once('close', () => {
          connection._sockets?.delete(socket)
          connection._handlers?.delete(socket)
        })

        return socket
      }

      logger.debug(`👂 优化事件监听已附加: 账户 ${this.accountId}, 连接 ${connection.id}`)
    } catch (error) {
      logger.error(`❌ 附加事件监听失败: 账户 ${this.accountId}`, error.message)
    }
  }

  /**
   * 处理连接断开事件
   */
  async handleConnectionClose(connection, hadError) {
    logger.info(`🔄 开始处理连接断开: 账户 ${this.accountId}, 连接 ${connection.id}`)

    // 标记连接为不健康
    connection.isHealthy = false

    // 发射连接断开事件
    this.emit('connection:disconnected', {
      connectionId: connection.id,
      reason: hadError ? 'error' : 'normal_close'
    })

    // 从连接池中移除
    this.removeConnection(connection)

    // 立即创建新连接替换
    await this.autoReconnect(connection, '连接断开')
  }

  /**
   * 处理连接错误事件
   */
  async handleConnectionError(connection, error) {
    this.stats.errorCount++

    // 发射连接错误事件
    this.emit('connection:error', {
      connectionId: connection.id,
      error: error.message
    })

    // 判断是否为致命错误
    if (this.isFatalError(error)) {
      logger.warn(
        `💀 致命错误，触发重连: 账户 ${this.accountId}, 连接 ${connection.id}, 错误: ${error.message}`
      )
      await this.handleConnectionClose(connection, true)
    } else {
      logger.debug(
        `🩹 非致命错误，继续使用: 账户 ${this.accountId}, 连接 ${connection.id}, 错误: ${error.message}`
      )
    }
  }

  /**
   * 处理连接超时事件
   */
  async handleConnectionTimeout(connection) {
    logger.info(`⏰ 连接超时，触发重连: 账户 ${this.accountId}, 连接 ${connection.id}`)
    await this.handleConnectionClose(connection, true)
  }

  /**
   * 处理连接结束事件
   */
  handleConnectionEnd(connection) {
    logger.debug(`🏁 连接正常结束: 账户 ${this.accountId}, 连接 ${connection.id}`)
    // 连接正常结束通常不需要立即重连，等待下次使用时检查
  }

  /**
   * 自动重连机制
   */
  async autoReconnect(brokenConnection, reason, attempt = 1) {
    const maxAttempts = 5
    const baseDelay = 1000 // 1秒
    const delay = Math.min(baseDelay * Math.pow(2, attempt - 1), 30000) // 最大30秒

    logger.info(
      `🔄 自动重连: 账户 ${this.accountId}, 原因: ${reason}, 尝试 ${attempt}/${maxAttempts}`
    )

    try {
      // 创建新连接
      const newConnection = await this.createMonitoredConnection()
      this.connections.push(newConnection)

      this.stats.reconnectCount++
      this.stats.lastReconnectAt = Date.now()

      logger.success(
        `✅ 自动重连成功: 账户 ${this.accountId}, 连接 ${newConnection.id}, 尝试次数: ${attempt}`
      )

      // 发射重连成功事件
      this.emit('connection:reconnected', {
        connectionId: newConnection.id,
        downtime: Date.now() - (brokenConnection.lastUsedAt || brokenConnection.createdAt)
      })

      // 发射连接池状态变化事件
      this.emit('pool:status:changed', {
        oldStatus: 'degraded',
        status: 'ready',
        healthyConnections: this.connections.filter((conn) => conn.isHealthy).length,
        totalConnections: this.connections.length
      })
    } catch (error) {
      logger.error(
        `❌ 自动重连失败: 账户 ${this.accountId}, 尝试 ${attempt}/${maxAttempts}, 错误: ${error.message}`
      )

      if (attempt < maxAttempts) {
        logger.info(`⏳ ${delay}ms后重试重连: 账户 ${this.accountId}`)
        setTimeout(() => {
          this.autoReconnect(brokenConnection, reason, attempt + 1)
        }, delay)
      } else {
        logger.error(`💀 重连彻底失败: 账户 ${this.accountId}, 已达最大尝试次数`)
        // 记录严重错误但不抛出异常，保持服务运行
      }
    }
  }

  /**
   * 判断是否为致命错误
   */
  isFatalError(error) {
    const fatalCodes = ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH']
    return fatalCodes.includes(error.code) || error.message.includes('socket hang up')
  }

  /**
   * 从连接池中移除连接
   */
  removeConnection(connection) {
    const index = this.connections.findIndex((conn) => conn.id === connection.id)
    if (index !== -1) {
      // 先销毁连接资源，再从数组移除
      this.destroyConnection(connection)

      this.connections.splice(index, 1)
      logger.debug(`🗑️ 连接已移除和销毁: 账户 ${this.accountId}, 连接 ${connection.id}`)
    }
  }

  /**
   * 销毁单个连接的资源 - 优化内存管理
   */
  destroyConnection(connection) {
    try {
      // 标记为不健康
      connection.isHealthy = false

      // 清理socket监听器和引用
      this._cleanupConnectionListeners(connection)

      // 恢复原始的createSocket方法
      if (connection.agent && connection._originalCreateSocket) {
        connection.agent.createSocket = connection._originalCreateSocket
        connection._originalCreateSocket = null
      }

      // 释放代理Agent资源
      if (connection.agent && typeof connection.agent.destroy === 'function') {
        connection.agent.destroy()
        logger.debug(`🔌 代理连接已关闭: 连接 ${connection.id}`)
      }

      // 回收UUID到对象池
      if (connection.id) {
        performanceOptimizer.recycleUUID(connection.id)
      }

      // 清理所有引用
      connection.agent = null
      connection.id = null
      connection._sockets = null
      connection._handlers = null
    } catch (error) {
      logger.warn(`⚠️ 销毁连接资源失败: ${connection.id}, 错误: ${error.message}`)
    }
  }

  /**
   * 清理连接的监听器和Socket引用
   * @param {object} connection - 连接对象
   * @private
   */
  _cleanupConnectionListeners(connection) {
    try {
      // 清理所有socket的监听器
      if (connection._sockets && connection._handlers) {
        for (const socket of connection._sockets) {
          const handlers = connection._handlers.get(socket)
          if (handlers) {
            // 移除特定的事件监听器
            socket.removeListener('close', handlers.close)
            socket.removeListener('error', handlers.error)
            socket.removeListener('timeout', handlers.timeout)
            socket.removeListener('end', handlers.end)
          }
          
          // 如果socket仍然活跃，优雅关闭
          if (!socket.destroyed) {
            socket.destroy()
          }
        }
        
        connection._sockets.clear()
        connection._handlers.clear()
      }
    } catch (error) {
      logger.debug(`⚠️ 清理连接监听器时出错: ${error.message}`)
    }
  }

  /**
   * 获取可用连接 - 简单轮询策略
   */
  getConnection() {
    if (!this.isInitialized) {
      throw new Error(`Connection pool not initialized for account ${this.accountId}`)
    }

    // 过滤健康连接
    const healthyConnections = this.connections.filter((conn) => conn.isHealthy)

    if (healthyConnections.length === 0) {
      throw new Error(`No healthy connections available for account ${this.accountId}`)
    }

    // 简单轮询：取第一个，然后移到末尾
    const connection = healthyConnections.shift()
    const connectionIndex = this.connections.findIndex((conn) => conn.id === connection.id)
    if (connectionIndex !== -1) {
      this.connections.splice(connectionIndex, 1)
      this.connections.push(connection)
    }

    // 更新使用统计
    connection.usageCount++
    connection.lastUsedAt = Date.now()

    logger.debug(
      `🔗 获取连接: 账户 ${this.accountId}, 连接 ${connection.id}, 使用次数: ${connection.usageCount}`
    )

    return {
      connectionId: connection.id,
      accountId: this.accountId,
      httpsAgent: connection.agent,
      proxyInfo: ProxyHelper.maskProxyInfo(this.proxyConfig),
      usedAt: Date.now()
    }
  }

  /**
   * 获取连接池状态
   */
  getStatus() {
    const healthyCount = this.connections.filter((conn) => conn.isHealthy).length
    const totalUsage = this.connections.reduce((sum, conn) => sum + conn.usageCount, 0)

    return {
      accountId: this.accountId,
      isInitialized: this.isInitialized,
      totalConnections: this.connections.length,
      healthyConnections: healthyCount,
      targetSize: this.targetSize,
      totalUsage,
      stats: { ...this.stats },
      proxyInfo: ProxyHelper.maskProxyInfo(this.proxyConfig)
    }
  }

  /**
   * 销毁连接池（带超时控制）
   */
  destroy(timeout = 5000) {
    // 5秒超时
    return new Promise((resolve) => {
      logger.info(`🗑️ 销毁连接池: 账户 ${this.accountId}`)
      const startTime = Date.now()

      let destroyedCount = 0
      let errorCount = 0
      const totalConnections = this.connections.length

      if (totalConnections === 0) {
        logger.info(`ℹ️ 连接池无连接需要销毁: 账户 ${this.accountId}`)
        this.connections = []
        this.isInitialized = false
        logger.success(`✅ 连接池已销毁: 账户 ${this.accountId} (无连接)`)
        return resolve({ destroyed: 0, errors: 0, timeout: false })
      }

      // 设置超时处理
      const timeoutHandle = setTimeout(() => {
        const elapsedTime = Date.now() - startTime
        logger.warn(`⚠️ 连接池销毁超时: 账户 ${this.accountId} (${elapsedTime}ms)`)
        logger.warn(`📊 销毁状态: 完成 ${destroyedCount}/${totalConnections}, 错误 ${errorCount}`)

        // 强制清理状态
        this.connections = []
        this.isInitialized = false

        resolve({
          destroyed: destroyedCount,
          errors: errorCount,
          timeout: true,
          elapsedTime
        })
      }, timeout)

      // 统一处理连接销毁完成
      const handleConnectionDestroyed = (connectionId, isError = false) => {
        if (isError) {
          errorCount++
        } else {
          destroyedCount++
        }

        const finished = destroyedCount + errorCount
        if (finished >= totalConnections) {
          clearTimeout(timeoutHandle)
          const elapsedTime = Date.now() - startTime

          // 清空连接数组
          this.connections = []
          this.isInitialized = false

          logger.success(
            `✅ 连接池已销毁: 账户 ${this.accountId} (${elapsedTime}ms): 成功关闭 ${destroyedCount}, 错误 ${errorCount}`
          )
          resolve({
            destroyed: destroyedCount,
            errors: errorCount,
            timeout: false,
            elapsedTime
          })
        }
      }

      // 异步销毁每个连接
      this.connections.forEach((connection) => {
        // 立即标记连接为不健康
        connection.isHealthy = false

        // 为每个连接设置独立的销毁超时
        const connectionTimeout = Math.min(timeout / totalConnections, 2000) // 每个连接最多2秒

        Promise.race([
          // 连接销毁Promise
          new Promise((connResolve) => {
            try {
              let destroyed = false

              // 尝试优雅关闭代理Agent
              if (connection.agent && typeof connection.agent.destroy === 'function') {
                try {
                  connection.agent.destroy()
                  destroyed = true
                  logger.debug(`🔌 代理连接已关闭: 连接 ${connection.id}`)
                } catch (destroyError) {
                  logger.warn(`⚠️ 代理Agent destroy失败: ${destroyError.message}`)
                }
              }

              // 备用方法：手动关闭sockets
              if (!destroyed && connection.agent && connection.agent.sockets) {
                try {
                  for (const hostPort in connection.agent.sockets) {
                    const sockets = connection.agent.sockets[hostPort]
                    if (Array.isArray(sockets)) {
                      sockets.forEach((socket) => {
                        try {
                          socket.destroy()
                        } catch (socketError) {
                          logger.warn(`⚠️ 关闭socket失败: ${socketError.message}`)
                        }
                      })
                    }
                  }
                  destroyed = true
                  logger.debug(`🔌 代理socket已关闭: 连接 ${connection.id}`)
                } catch (socketsError) {
                  logger.warn(`⚠️ 关闭sockets失败: ${socketsError.message}`)
                }
              }

              if (!destroyed) {
                logger.warn(
                  `⚠️ 连接 ${connection.id} 的代理Agent无法关闭 (agent类型: ${typeof connection.agent})`
                )
                connResolve(false) // 标记为处理失败但不是严重错误
              } else {
                connResolve(true)
              }
            } catch (error) {
              logger.error(`❌ 销毁连接失败: 连接 ${connection.id}, 错误: ${error.message}`)
              connResolve(false)
            }
          }),
          // 单个连接的超时Promise
          new Promise((connResolve) => {
            setTimeout(() => {
              logger.warn(`⚠️ 连接销毁超时: ${connection.id} (${connectionTimeout}ms)`)
              connResolve(false)
            }, connectionTimeout)
          })
        ]).then((success) => {
          handleConnectionDestroyed(connection.id, !success)
        })
      })
    })
  }

  /**
   * 获取所有现有连接 (用于同步到生命周期管理器)
   */
  getAllConnections() {
    return this.connections.map((conn) => ({
      connectionId: conn.id,
      accountId: this.accountId,
      isHealthy: conn.isHealthy,
      createdAt: conn.createdAt || Date.now(),
      latency: conn.latency,
      agent: conn.agent,
      proxyInfo: this.proxyConfig ? `${this.proxyConfig.host}:${this.proxyConfig.port}` : 'direct'
    }))
  }
}

module.exports = SmartConnectionPool
