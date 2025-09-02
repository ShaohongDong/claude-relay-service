const EventEmitter = require('events')
const logger = require('../utils/logger')
const timerManager = require('../utils/timerManager')

/**
 * Hybrid Connection Manager
 * Provides hybrid monitoring mechanism with event-driven monitoring and periodic health checks
 * Features:
 * - Combines real-time response of event-driven with fallback guarantee of periodic checks
 * - Connection status change event dispatching
 * - Intelligent health check scheduling
 * - Connection pool coordination management
 * - Performance monitoring and statistics
 */
class HybridConnectionManager extends EventEmitter {
  constructor(globalConnectionPoolManager) {
    super()
    this.poolManager = globalConnectionPoolManager
    this.isRunning = false

    // Monitoring configuration
    this.config = {
      healthCheckInterval: 5 * 60 * 1000, // 5-minute periodic health check
      performanceCheckInterval: 30 * 1000, // 30-second performance monitoring
      connectionTimeoutThreshold: 10000, // 10-second connection timeout threshold
      errorRateThreshold: 0.1, // 10% error rate threshold
      reconnectionCooldown: 3 * 1000 // 3-second reconnection cooldown time
    }

    // Monitoring state
    this.state = {
      lastHealthCheck: null,
      lastPerformanceCheck: null,
      healthCheckCount: 0,
      performanceCheckCount: 0,
      totalErrors: 0,
      totalConnections: 0,
      averageLatency: 0
    }

    // Timer references
    this.timers = {
      healthCheck: null,
      healthCheckId: null,
      performanceCheck: null,
      performanceCheckId: null
    }

    // Connection state cache
    this.connectionStates = new Map() // accountId -> connectionState

    logger.info('🔄 Hybrid connection manager created')
  }

  /**
   * Start hybrid monitoring mechanism
   */
  async start() {
    if (this.isRunning) {
      logger.warn('⚠️ Hybrid connection manager already running, skipping duplicate start')
      return
    }

    this.isRunning = true
    logger.info('🚀 启动混合连接管理器...')

    try {
      // 注册全局连接池管理器事件监听
      this.setupPoolManagerEvents()

      // 启动定期健康检查
      this.startHealthCheckScheduler()

      // 启动性能监控
      this.startPerformanceMonitoring()

      // 初始化连接状态缓存
      await this.initializeConnectionStates()

      logger.success('✅ 混合连接管理器启动成功')
      this.emit('manager:started')
    } catch (error) {
      logger.error('❌ 混合连接管理器启动失败:', error.message)
      this.isRunning = false
      throw error
    }
  }

  /**
   * 停止混合监控机制
   */
  stop() {
    if (!this.isRunning) {
      return
    }

    logger.info('🛑 停止混合连接管理器...')

    // 清除定时器（使用timerManager安全清理）
    if (this.timers.healthCheckId) {
      timerManager.safeCleanTimer(this.timers.healthCheckId)
      this.timers.healthCheck = null
      this.timers.healthCheckId = null
    }

    if (this.timers.performanceCheckId) {
      timerManager.safeCleanTimer(this.timers.performanceCheckId)
      this.timers.performanceCheck = null
      this.timers.performanceCheckId = null
    }

    // 移除事件监听器
    this.removeAllListeners()

    this.isRunning = false
    logger.success('✅ 混合连接管理器已停止')
  }

  /**
   * 设置连接池管理器事件监听
   */
  setupPoolManagerEvents() {
    // 监听单个连接池的事件
    this.poolManager.pools?.forEach((pool, accountId) => {
      this.setupPoolEvents(pool, accountId)
    })

    logger.debug('🎧 已设置连接池事件监听')
  }

  /**
   * 设置单个连接池事件监听
   */
  setupPoolEvents(pool, accountId) {
    // 连接成功事件
    pool.on('connection:connected', (connectionData) => {
      this.handleConnectionConnected(accountId, connectionData)
    })

    // 连接断开事件
    pool.on('connection:disconnected', (connectionData) => {
      this.handleConnectionDisconnected(accountId, connectionData)
    })

    // 连接错误事件
    pool.on('connection:error', (connectionData) => {
      this.handleConnectionError(accountId, connectionData)
    })

    // 重连成功事件
    pool.on('connection:reconnected', (connectionData) => {
      this.handleConnectionReconnected(accountId, connectionData)
    })

    // 连接池状态变化事件
    pool.on('pool:status:changed', (statusData) => {
      this.handlePoolStatusChanged(accountId, statusData)
    })

    logger.debug(`🎧 已设置账户连接池事件监听: ${accountId}`)
  }

  /**
   * 启动定期健康检查调度器
   */
  startHealthCheckScheduler() {
    const result = timerManager.setInterval(
      async () => {
        try {
          await this.performPeriodicHealthCheck()
        } catch (error) {
          logger.error('❌ 定期健康检查执行失败:', error.message)
        }
      },
      this.config.healthCheckInterval,
      {
        name: 'hybrid-manager-health-check',
        service: 'hybridConnectionManager',
        description: 'Periodic health check for connection pools'
      }
    )

    this.timers.healthCheck = result.intervalId
    this.timers.healthCheckId = result.timerId

    logger.info(`⏰ 健康检查调度器已启动: ${this.config.healthCheckInterval}ms间隔`)
  }

  /**
   * 启动性能监控
   */
  startPerformanceMonitoring() {
    const result = timerManager.setInterval(
      async () => {
        try {
          await this.performPerformanceCheck()
        } catch (error) {
          logger.error('❌ 性能监控执行失败:', error.message)
        }
      },
      this.config.performanceCheckInterval,
      {
        name: 'hybrid-manager-performance-monitor',
        service: 'hybridConnectionManager',
        description: 'Performance monitoring for connection pools'
      }
    )

    this.timers.performanceCheck = result.intervalId
    this.timers.performanceCheckId = result.timerId

    logger.info(`📊 性能监控已启动: ${this.config.performanceCheckInterval}ms间隔`)
  }

  /**
   * 初始化连接状态缓存
   */
  async initializeConnectionStates() {
    try {
      const allStatus = this.poolManager.getAllPoolStatus()

      if (allStatus.pools) {
        allStatus.pools.forEach((poolStatus) => {
          this.connectionStates.set(poolStatus.accountId, {
            status: poolStatus.status,
            healthyConnections: poolStatus.healthyConnections,
            totalConnections: poolStatus.totalConnections,
            lastCheck: Date.now(),
            errorRate: 0,
            averageLatency: poolStatus.stats?.averageLatency || 0
          })
        })
      }

      logger.info(`📋 连接状态缓存已初始化: ${this.connectionStates.size}个账户`)
    } catch (error) {
      logger.error('❌ 初始化连接状态缓存失败:', error.message)
    }
  }

  /**
   * 处理连接成功事件
   */
  handleConnectionConnected(accountId, connectionData) {
    logger.debug(
      `🔗 Connection established: account ${accountId}, connection ${connectionData.connectionId}`
    )

    // 更新连接状态
    this.updateConnectionState(accountId, {
      lastConnected: Date.now(),
      consecutiveErrors: 0
    })

    // 发出连接成功事件
    this.emit('connection:established', {
      accountId,
      connectionId: connectionData.connectionId,
      latency: connectionData.latency,
      timestamp: Date.now()
    })
  }

  /**
   * 处理连接断开事件
   */
  handleConnectionDisconnected(accountId, connectionData) {
    logger.debug(
      `📤 Connection lost: account ${accountId}, connection ${connectionData.connectionId}`
    )

    // 更新连接状态
    this.updateConnectionState(accountId, {
      lastDisconnected: Date.now()
    })

    // 发出连接断开事件
    this.emit('connection:lost', {
      accountId,
      connectionId: connectionData.connectionId,
      reason: connectionData.reason,
      timestamp: Date.now()
    })
  }

  /**
   * 处理连接错误事件
   */
  handleConnectionError(accountId, connectionData) {
    logger.warn(`❌ 连接错误: 账户 ${accountId}, 错误: ${connectionData.error}`)

    // 更新连接状态和错误统计
    this.updateConnectionState(accountId, {
      lastError: Date.now(),
      consecutiveErrors: (this.getConnectionState(accountId).consecutiveErrors || 0) + 1
    })

    this.state.totalErrors++

    // 发出连接错误事件
    this.emit('connection:error', {
      accountId,
      connectionId: connectionData.connectionId,
      error: connectionData.error,
      consecutiveErrors: this.getConnectionState(accountId).consecutiveErrors,
      timestamp: Date.now()
    })

    // 检查是否需要主动干预
    this.checkErrorThreshold(accountId)
  }

  /**
   * 处理重连成功事件
   */
  handleConnectionReconnected(accountId, connectionData) {
    logger.success(`🔄 重连成功: 账户 ${accountId}, 连接 ${connectionData.connectionId}`)

    // 重置错误计数
    this.updateConnectionState(accountId, {
      lastReconnected: Date.now(),
      consecutiveErrors: 0
    })

    // 发出重连成功事件
    this.emit('connection:recovered', {
      accountId,
      connectionId: connectionData.connectionId,
      downtime: connectionData.downtime,
      timestamp: Date.now()
    })
  }

  /**
   * 处理连接池状态变化事件
   */
  handlePoolStatusChanged(accountId, statusData) {
    logger.debug(`📊 连接池状态变化: 账户 ${accountId}`)

    // 更新连接状态缓存
    this.updateConnectionState(accountId, {
      status: statusData.status,
      healthyConnections: statusData.healthyConnections,
      totalConnections: statusData.totalConnections,
      lastStatusChange: Date.now()
    })

    // 发出池状态变化事件
    this.emit('pool:status:changed', {
      accountId,
      oldStatus: statusData.oldStatus,
      newStatus: statusData.status,
      healthyConnections: statusData.healthyConnections,
      timestamp: Date.now()
    })
  }

  /**
   * 执行定期健康检查
   */
  async performPeriodicHealthCheck() {
    logger.debug('🏥 开始定期健康检查...')

    const startTime = Date.now()

    try {
      const healthResult = await this.poolManager.performHealthCheck()

      this.state.lastHealthCheck = Date.now()
      this.state.healthCheckCount++

      const checkDuration = Date.now() - startTime

      logger.info(
        `🏥 定期健康检查完成: 健康 ${healthResult.healthyPools}/${healthResult.totalPools}, 耗时 ${checkDuration}ms`
      )

      // 发出健康检查完成事件
      this.emit('health:check:completed', {
        result: healthResult,
        duration: checkDuration,
        timestamp: Date.now()
      })

      // 检查是否有需要特别关注的问题
      this.analyzeHealthCheckResults(healthResult)
    } catch (error) {
      logger.error('❌ 定期健康检查失败:', error.message)
      this.emit('health:check:failed', {
        error: error.message,
        timestamp: Date.now()
      })
    }
  }

  /**
   * 执行性能监控检查
   */
  async performPerformanceCheck() {
    logger.debug('📊 开始性能监控检查...')

    try {
      const poolStatus = this.poolManager.getAllPoolStatus()

      // 计算整体性能指标
      let totalLatency = 0
      let latencyCount = 0
      let totalConnections = 0
      let healthyConnections = 0

      if (poolStatus.pools) {
        poolStatus.pools.forEach((pool) => {
          if (pool.stats && pool.stats.averageLatency > 0) {
            totalLatency += pool.stats.averageLatency
            latencyCount++
          }
          totalConnections += pool.totalConnections
          healthyConnections += pool.healthyConnections
        })
      }

      // 更新状态统计
      this.state.lastPerformanceCheck = Date.now()
      this.state.performanceCheckCount++
      this.state.totalConnections = totalConnections
      this.state.averageLatency = latencyCount > 0 ? totalLatency / latencyCount : 0

      const performanceData = {
        totalConnections,
        healthyConnections,
        averageLatency: this.state.averageLatency,
        errorRate:
          this.state.totalConnections > 0
            ? this.state.totalErrors / this.state.totalConnections
            : 0,
        timestamp: Date.now()
      }

      logger.debug(
        `📊 性能指标: 连接 ${healthyConnections}/${totalConnections}, 平均延迟 ${this.state.averageLatency.toFixed(2)}ms`
      )

      // 发出性能监控事件
      this.emit('performance:metrics', performanceData)
    } catch (error) {
      logger.error('❌ 性能监控检查失败:', error.message)
    }
  }

  /**
   * 分析健康检查结果
   */
  analyzeHealthCheckResults(healthResult) {
    const unhealthyRate =
      healthResult.totalPools > 0 ? healthResult.unhealthyPools / healthResult.totalPools : 0

    if (unhealthyRate > 0.2) {
      // 20%以上连接池不健康
      logger.warn(
        `⚠️ 连接池健康度较低: ${healthResult.unhealthyPools}/${healthResult.totalPools} 不健康`
      )
      this.emit('health:degraded', {
        unhealthyRate,
        unhealthyPools: healthResult.unhealthyPools,
        totalPools: healthResult.totalPools,
        timestamp: Date.now()
      })
    }
  }

  /**
   * 检查错误率阈值
   */
  checkErrorThreshold(accountId) {
    const state = this.getConnectionState(accountId)

    if (state.consecutiveErrors >= 5) {
      // 连续5次错误
      logger.warn(`⚠️ 账户连续错误过多: ${accountId}, 连续错误 ${state.consecutiveErrors}次`)
      this.emit('connection:critical', {
        accountId,
        consecutiveErrors: state.consecutiveErrors,
        timestamp: Date.now()
      })
    }
  }

  /**
   * 获取连接状态
   */
  getConnectionState(accountId) {
    return this.connectionStates.get(accountId) || {}
  }

  /**
   * 更新连接状态
   */
  updateConnectionState(accountId, updates) {
    const currentState = this.getConnectionState(accountId)
    const newState = { ...currentState, ...updates }
    this.connectionStates.set(accountId, newState)
  }

  /**
   * 获取管理器状态摘要
   */
  getManagerStatus() {
    return {
      isRunning: this.isRunning,
      config: this.config,
      state: { ...this.state },
      connectionStates: this.connectionStates.size,
      uptime: this.isRunning ? Date.now() - (this.state.lastHealthCheck || Date.now()) : 0
    }
  }

  /**
   * 获取详细的监控报告
   */
  getMonitoringReport() {
    const poolStatus = this.poolManager.getAllPoolStatus()

    return {
      manager: this.getManagerStatus(),
      pools: poolStatus,
      connectionStates: Array.from(this.connectionStates.entries()).map(([accountId, state]) => ({
        accountId,
        ...state
      })),
      timestamp: Date.now()
    }
  }
}

module.exports = HybridConnectionManager
