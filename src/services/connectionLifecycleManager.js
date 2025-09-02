const EventEmitter = require('events')
const logger = require('../utils/logger')

/**
 * 连接生命周期管理器
 * 负责管理代理连接的完整生命周期和兜底健康检查
 * 特性：
 * - 连接创建、维护、销毁的完整生命周期管理
 * - 兜底健康检查机制，确保连接状态准确性
 * - 连接老化和自动轮换机制
 * - 资源泄漏防护和内存管理
 * - 连接性能分析和优化建议
 */
class ConnectionLifecycleManager extends EventEmitter {
  constructor() {
    super()

    // 生命周期配置
    this.config = {
      maxConnectionAge: 60 * 60 * 1000, // 60分钟最大连接寿命
      healthCheckInterval: 5 * 60 * 1000, // 5分钟兜底健康检查
      connectionRotationInterval: 30 * 60 * 1000, // 30分钟连接轮换检查
      inactiveConnectionThreshold: 20 * 60 * 1000, // 20分钟非活跃连接阈值
      memoryCleanupInterval: 10 * 60 * 1000, // 10分钟内存清理检查
      performanceAnalysisInterval: 2 * 60 * 1000, // 2分钟性能分析
      maxConnectionsPerAccount: 3, // 每个账户最大连接数限制
      connectionTimeoutMs: 30 * 1000 // 30秒连接超时
    }

    // 连接注册表
    this.connections = new Map() // connectionId -> connectionInfo
    this.accountConnections = new Map() // accountId -> Set<connectionId>

    // 生命周期统计
    this.stats = {
      totalCreated: 0,
      totalDestroyed: 0,
      totalRotated: 0,
      totalTimeouts: 0,
      totalErrors: 0,
      activeConnections: 0,
      memoryCleanups: 0
    }

    // 定时器引用
    this.timers = {
      healthCheck: null,
      rotation: null,
      memoryCleanup: null,
      performanceAnalysis: null
    }

    this.isRunning = false

    logger.info('♻️ 连接生命周期管理器已创建')
  }

  /**
   * 启动生命周期管理
   */
  start() {
    if (this.isRunning) {
      logger.warn('⚠️ 连接生命周期管理器已运行，跳过重复启动')
      return
    }

    this.isRunning = true
    logger.info('🚀 启动连接生命周期管理器...')

    // 启动兜底健康检查
    this.startFallbackHealthCheck()

    // 启动连接轮换检查
    this.startConnectionRotation()

    // 启动内存清理
    this.startMemoryCleanup()

    // 启动性能分析
    this.startPerformanceAnalysis()

    logger.success('✅ 连接生命周期管理器启动成功')
    this.emit('lifecycle:started')
  }

  /**
   * 停止生命周期管理
   */
  stop() {
    if (!this.isRunning) {
      return
    }

    logger.info('🛑 停止连接生命周期管理器...')

    // 清除所有定时器
    Object.values(this.timers).forEach((timer) => {
      if (timer) {
        clearInterval(timer)
      }
    })

    // 清理所有定时器引用
    Object.keys(this.timers).forEach((key) => {
      this.timers[key] = null
    })

    // 销毁所有活跃连接
    this.destroyAllConnections()

    this.isRunning = false
    logger.success('✅ 连接生命周期管理器已停止')
    this.emit('lifecycle:stopped')
  }

  /**
   * 注册新连接
   */
  registerConnection(accountId, connectionId, connectionData) {
    const connectionInfo = {
      accountId,
      connectionId,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      lastHealthCheckAt: null,
      usageCount: 0,
      errorCount: 0,
      status: 'active',
      agent: connectionData.agent,
      proxyInfo: connectionData.proxyInfo || 'unknown',
      ...connectionData
    }

    // 注册到连接表
    this.connections.set(connectionId, connectionInfo)

    // 注册到账户连接映射
    if (!this.accountConnections.has(accountId)) {
      this.accountConnections.set(accountId, new Set())
    }
    this.accountConnections.get(accountId).add(connectionId)

    // 更新统计
    this.stats.totalCreated++
    this.stats.activeConnections++

    logger.debug(`♻️ Connection registered: ${connectionId} (account: ${accountId})`)

    // 检查账户连接数限制
    this.checkConnectionLimit(accountId)

    this.emit('connection:registered', {
      accountId,
      connectionId,
      timestamp: Date.now()
    })
  }

  /**
   * 更新连接使用记录
   */
  updateConnectionUsage(connectionId, usageData = {}) {
    const connection = this.connections.get(connectionId)
    if (!connection) {
      logger.warn(`⚠️ 尝试更新不存在的连接使用记录: ${connectionId}`)
      return
    }

    connection.lastUsedAt = Date.now()
    connection.usageCount++

    if (usageData.error) {
      connection.errorCount++
      this.stats.totalErrors++
    }

    if (usageData.latency) {
      connection.lastLatency = usageData.latency
      connection.averageLatency = connection.averageLatency
        ? (connection.averageLatency + usageData.latency) / 2
        : usageData.latency
    }

    logger.debug(`♻️ 连接使用记录已更新: ${connectionId}`)
  }

  /**
   * 注销连接
   */
  unregisterConnection(connectionId, reason = 'manual') {
    const connection = this.connections.get(connectionId)
    if (!connection) {
      logger.warn(`⚠️ 尝试注销不存在的连接: ${connectionId}`)
      return
    }

    const { accountId } = connection

    // 从连接表移除
    this.connections.delete(connectionId)

    // 从账户连接映射移除
    const accountConns = this.accountConnections.get(accountId)
    if (accountConns) {
      accountConns.delete(connectionId)
      if (accountConns.size === 0) {
        this.accountConnections.delete(accountId)
      }
    }

    // 更新统计
    this.stats.totalDestroyed++
    this.stats.activeConnections = Math.max(0, this.stats.activeConnections - 1)

    const lifetime = Date.now() - connection.createdAt

    logger.info(
      `♻️ 连接已注销: ${connectionId} (账户: ${accountId}, 原因: ${reason}, 寿命: ${lifetime}ms)`
    )

    this.emit('connection:unregistered', {
      accountId,
      connectionId,
      reason,
      lifetime,
      usageCount: connection.usageCount,
      errorCount: connection.errorCount,
      timestamp: Date.now()
    })
  }

  /**
   * 检查账户连接数限制
   */
  checkConnectionLimit(accountId) {
    const accountConns = this.accountConnections.get(accountId)
    if (!accountConns) {
      return
    }

    const connectionCount = accountConns.size
    if (connectionCount > this.config.maxConnectionsPerAccount) {
      logger.warn(
        `⚠️ 账户连接数超限: ${accountId} (${connectionCount}/${this.config.maxConnectionsPerAccount})`
      )

      // 找到最老的连接进行清理
      const oldestConnection = this.findOldestConnectionForAccount(accountId)
      if (oldestConnection) {
        this.forceDestroyConnection(oldestConnection.connectionId, 'connection_limit_exceeded')
      }
    }
  }

  /**
   * 启动兜底健康检查
   */
  startFallbackHealthCheck() {
    this.timers.healthCheck = setInterval(() => {
      this.performFallbackHealthCheck()
    }, this.config.healthCheckInterval)

    logger.info(`🏥 兜底健康检查已启动: ${this.config.healthCheckInterval}ms间隔`)
  }

  /**
   * 执行兜底健康检查
   */
  async performFallbackHealthCheck() {
    logger.debug('🏥 开始兜底健康检查...')

    let checkedCount = 0
    let healthyCount = 0
    let unhealthyCount = 0

    for (const [connectionId, connection] of this.connections) {
      try {
        const isHealthy = await this.checkConnectionHealth(connection)
        checkedCount++

        if (isHealthy) {
          healthyCount++
          connection.lastHealthCheckAt = Date.now()
          connection.status = 'healthy'
        } else {
          unhealthyCount++
          connection.status = 'unhealthy'
          logger.warn(`🏥 发现不健康连接: ${connectionId} (账户: ${connection.accountId})`)

          // 触发连接重建
          this.scheduleConnectionRecreation(connection)
        }
      } catch (error) {
        logger.error(`🏥 健康检查失败: ${connectionId} - ${error.message}`)
        unhealthyCount++
        connection.status = 'error'
      }
    }

    logger.info(
      `🏥 兜底健康检查完成: ${healthyCount}健康/${checkedCount}总计 (${unhealthyCount}不健康)`
    )

    this.emit('health:check:completed', {
      checked: checkedCount,
      healthy: healthyCount,
      unhealthy: unhealthyCount,
      timestamp: Date.now()
    })
  }

  /**
   * 检查单个连接健康状态
   */
  async checkConnectionHealth(connection) {
    // 预热连接特殊处理 (usageCount === 0)
    if (connection.usageCount === 0) {
      // 只检查基本连接状态，放宽其他条件
      const age = Date.now() - connection.createdAt
      if (age > this.config.maxConnectionAge * 1.5) {
        // 预热连接延长50%寿命
        logger.debug(
          `♻️ 预热连接超龄: ${connection.connectionId} (${age}ms > ${this.config.maxConnectionAge * 1.5}ms)`
        )
        return false
      }
      return true // 预热连接默认健康
    }

    // 检查连接年龄
    const age = Date.now() - connection.createdAt
    if (age > this.config.maxConnectionAge) {
      logger.debug(
        `♻️ 连接超龄: ${connection.connectionId} (${age}ms > ${this.config.maxConnectionAge}ms)`
      )
      return false
    }

    // 检查最后使用时间
    const inactiveTime = Date.now() - connection.lastUsedAt
    if (inactiveTime > this.config.inactiveConnectionThreshold) {
      logger.debug(`♻️ 连接非活跃: ${connection.connectionId} (非活跃时间: ${inactiveTime}ms)`)
      return false
    }

    // 检查错误率
    if (connection.usageCount > 0) {
      const errorRate = connection.errorCount / connection.usageCount
      if (errorRate > 0.2) {
        // 20%错误率阈值
        logger.debug(
          `♻️ 连接错误率高: ${connection.connectionId} (${(errorRate * 100).toFixed(2)}%)`
        )
        return false
      }
    }

    // 检查Socket状态（如果可访问）
    // 对于预热连接（usageCount=0），跳过Socket状态检查，因为SOCKS5代理连接在未使用时sockets为空是正常的
    if (connection.agent && connection.agent.sockets && connection.usageCount > 0) {
      const socketState = this.checkSocketState(connection.agent)
      if (!socketState.healthy) {
        logger.debug(`♻️ Socket状态不健康: ${connection.connectionId}`)
        return false
      }
    }

    return true
  }

  /**
   * 检查Socket状态
   */
  checkSocketState(agent) {
    try {
      // 检查sockets的状态
      const sockets = agent.sockets || {}
      const freeSockets = agent.freeSockets || {}

      let totalSockets = 0
      let activeSockets = 0

      // 计算活跃socket数量
      for (const hostSockets of Object.values(sockets)) {
        if (Array.isArray(hostSockets)) {
          totalSockets += hostSockets.length
          activeSockets += hostSockets.filter(
            (socket) => socket.readyState === 'open' || socket.readyState === 'opening'
          ).length
        }
      }

      // 计算空闲socket数量
      let freeSokcetCount = 0
      for (const hostSockets of Object.values(freeSockets)) {
        if (Array.isArray(hostSockets)) {
          freeSokcetCount += hostSockets.length
        }
      }

      return {
        healthy: activeSockets > 0 || freeSokcetCount > 0,
        totalSockets,
        activeSockets,
        freeSockets: freeSokcetCount
      }
    } catch (error) {
      logger.debug(`Socket状态检查失败: ${error.message}`)
      return { healthy: false }
    }
  }

  /**
   * 启动连接轮换
   */
  startConnectionRotation() {
    this.timers.rotation = setInterval(() => {
      this.performConnectionRotation()
    }, this.config.connectionRotationInterval)

    logger.info(`🔄 连接轮换检查已启动: ${this.config.connectionRotationInterval}ms间隔`)
  }

  /**
   * 执行连接轮换
   */
  performConnectionRotation() {
    logger.debug('🔄 开始连接轮换检查...')

    let rotatedCount = 0

    for (const [connectionId, connection] of this.connections) {
      const age = Date.now() - connection.createdAt

      // 检查是否需要轮换
      if (age > this.config.maxConnectionAge || this.shouldRotateConnection(connection)) {
        logger.info(`🔄 轮换连接: ${connectionId} (账户: ${connection.accountId}, 寿命: ${age}ms)`)
        this.scheduleConnectionRecreation(connection)
        rotatedCount++
        this.stats.totalRotated++
      }
    }

    if (rotatedCount > 0) {
      logger.info(`🔄 连接轮换完成: 轮换 ${rotatedCount} 个连接`)
    }
  }

  /**
   * 判断是否应该轮换连接
   */
  shouldRotateConnection(connection) {
    // 高错误率的连接
    if (connection.usageCount > 10 && connection.errorCount / connection.usageCount > 0.15) {
      return true
    }

    // 性能低的连接
    if (connection.averageLatency && connection.averageLatency > 5000) {
      return true
    }

    // 长时间未使用的连接
    const inactiveTime = Date.now() - connection.lastUsedAt
    if (inactiveTime > this.config.inactiveConnectionThreshold) {
      return true
    }

    return false
  }

  /**
   * 调度连接重建
   */
  scheduleConnectionRecreation(connection) {
    // 发出连接重建请求事件
    this.emit('connection:recreation:requested', {
      accountId: connection.accountId,
      connectionId: connection.connectionId,
      reason: 'lifecycle_management',
      timestamp: Date.now()
    })
  }

  /**
   * 强制销毁连接
   */
  forceDestroyConnection(connectionId, reason = 'forced') {
    const connection = this.connections.get(connectionId)
    if (!connection) {
      return
    }

    // 清理agent资源
    if (connection.agent) {
      try {
        connection.agent.destroy()
      } catch (error) {
        logger.warn(`⚠️ 清理agent资源失败: ${connectionId} - ${error.message}`)
      }
    }

    // 注销连接
    this.unregisterConnection(connectionId, reason)
  }

  /**
   * 启动内存清理
   */
  startMemoryCleanup() {
    this.timers.memoryCleanup = setInterval(() => {
      this.performMemoryCleanup()
    }, this.config.memoryCleanupInterval)

    logger.info(`🧹 内存清理已启动: ${this.config.memoryCleanupInterval}ms间隔`)
  }

  /**
   * 执行内存清理
   */
  performMemoryCleanup() {
    logger.debug('🧹 开始内存清理...')

    let cleanedCount = 0

    // 清理无效连接引用
    for (const [connectionId, connection] of this.connections) {
      if (connection.status === 'destroyed' || connection.status === 'error') {
        this.unregisterConnection(connectionId, 'memory_cleanup')
        cleanedCount++
      }
    }

    // 清理空的账户连接映射
    for (const [accountId, connections] of this.accountConnections) {
      if (connections.size === 0) {
        this.accountConnections.delete(accountId)
        cleanedCount++
      }
    }

    // 触发垃圾回收提示
    if (global.gc && cleanedCount > 0) {
      try {
        global.gc()
        logger.debug('🧹 手动垃圾回收已执行')
      } catch (error) {
        // 忽略垃圾回收错误
      }
    }

    this.stats.memoryCleanups++

    if (cleanedCount > 0) {
      logger.info(`🧹 内存清理完成: 清理 ${cleanedCount} 项`)
    }
  }

  /**
   * 启动性能分析
   */
  startPerformanceAnalysis() {
    this.timers.performanceAnalysis = setInterval(() => {
      this.performPerformanceAnalysis()
    }, this.config.performanceAnalysisInterval)

    logger.info(`📊 性能分析已启动: ${this.config.performanceAnalysisInterval}ms间隔`)
  }

  /**
   * 执行性能分析
   */
  performPerformanceAnalysis() {
    logger.debug('📊 开始性能分析...')

    const analysis = this.generatePerformanceReport()

    // 发出性能分析事件
    this.emit('performance:analysis', analysis)

    // 检查是否有性能问题需要处理
    this.checkPerformanceIssues(analysis)
  }

  /**
   * 生成性能报告
   */
  generatePerformanceReport() {
    const now = Date.now()
    const connections = Array.from(this.connections.values())

    const report = {
      timestamp: now,
      totalConnections: connections.length,
      connectionsByStatus: {},
      connectionsByAccount: {},
      performanceMetrics: {
        averageAge: 0,
        averageLatency: 0,
        totalUsage: 0,
        totalErrors: 0,
        errorRate: 0
      },
      recommendations: []
    }

    // 按状态分组
    connections.forEach((conn) => {
      const status = conn.status || 'unknown'
      report.connectionsByStatus[status] = (report.connectionsByStatus[status] || 0) + 1
    })

    // 按账户分组
    connections.forEach((conn) => {
      const { accountId } = conn
      if (!report.connectionsByAccount[accountId]) {
        report.connectionsByAccount[accountId] = {
          count: 0,
          averageAge: 0,
          averageLatency: 0,
          totalUsage: 0,
          errorRate: 0
        }
      }

      const accountStats = report.connectionsByAccount[accountId]
      accountStats.count++
      accountStats.totalUsage += conn.usageCount || 0

      const age = now - conn.createdAt
      accountStats.averageAge = (accountStats.averageAge + age) / accountStats.count

      if (conn.averageLatency) {
        accountStats.averageLatency = (accountStats.averageLatency + conn.averageLatency) / 2
      }

      if (conn.usageCount > 0) {
        accountStats.errorRate = conn.errorCount / conn.usageCount
      }
    })

    // 计算整体性能指标
    if (connections.length > 0) {
      const totalAge = connections.reduce((sum, conn) => sum + (now - conn.createdAt), 0)
      const totalUsage = connections.reduce((sum, conn) => sum + (conn.usageCount || 0), 0)
      const totalErrors = connections.reduce((sum, conn) => sum + (conn.errorCount || 0), 0)
      const latencies = connections
        .filter((conn) => conn.averageLatency)
        .map((conn) => conn.averageLatency)

      report.performanceMetrics.averageAge = totalAge / connections.length
      report.performanceMetrics.totalUsage = totalUsage
      report.performanceMetrics.totalErrors = totalErrors
      report.performanceMetrics.errorRate = totalUsage > 0 ? totalErrors / totalUsage : 0

      if (latencies.length > 0) {
        report.performanceMetrics.averageLatency =
          latencies.reduce((sum, lat) => sum + lat, 0) / latencies.length
      }
    }

    return report
  }

  /**
   * 检查性能问题
   */
  checkPerformanceIssues(analysis) {
    const { performanceMetrics } = analysis

    // 检查高错误率
    if (performanceMetrics.errorRate > 0.1) {
      logger.warn(`📊 整体错误率较高: ${(performanceMetrics.errorRate * 100).toFixed(2)}%`)
      this.emit('performance:issue', {
        type: 'high_error_rate',
        value: performanceMetrics.errorRate,
        threshold: 0.1,
        timestamp: Date.now()
      })
    }

    // 检查高延迟
    if (performanceMetrics.averageLatency > 3000) {
      logger.warn(`📊 整体延迟较高: ${performanceMetrics.averageLatency.toFixed(2)}ms`)
      this.emit('performance:issue', {
        type: 'high_latency',
        value: performanceMetrics.averageLatency,
        threshold: 3000,
        timestamp: Date.now()
      })
    }

    // 检查连接老化
    if (performanceMetrics.averageAge > this.config.maxConnectionAge * 0.8) {
      logger.warn(
        `📊 连接普遍老化: 平均寿命 ${(performanceMetrics.averageAge / 1000 / 60).toFixed(2)}分钟`
      )
      this.emit('performance:issue', {
        type: 'connection_aging',
        value: performanceMetrics.averageAge,
        threshold: this.config.maxConnectionAge * 0.8,
        timestamp: Date.now()
      })
    }
  }

  /**
   * 销毁所有连接
   */
  destroyAllConnections() {
    logger.info('🗑️ 开始销毁所有连接...')

    const connectionIds = Array.from(this.connections.keys())
    let destroyedCount = 0

    connectionIds.forEach((connectionId) => {
      try {
        this.forceDestroyConnection(connectionId, 'shutdown')
        destroyedCount++
      } catch (error) {
        logger.error(`❌ 销毁连接失败: ${connectionId} - ${error.message}`)
      }
    })

    // 清理所有映射
    this.connections.clear()
    this.accountConnections.clear()

    logger.success(`✅ 所有连接已销毁: ${destroyedCount}个`)
  }

  /**
   * 查找账户最老的连接
   */
  findOldestConnectionForAccount(accountId) {
    const accountConns = this.accountConnections.get(accountId)
    if (!accountConns) {
      return null
    }

    let oldestConnection = null
    let oldestTime = Date.now()

    for (const connectionId of accountConns) {
      const connection = this.connections.get(connectionId)
      if (connection && connection.createdAt < oldestTime) {
        oldestTime = connection.createdAt
        oldestConnection = connection
      }
    }

    return oldestConnection
  }

  /**
   * 获取生命周期统计
   */
  getLifecycleStats() {
    return {
      ...this.stats,
      activeConnections: this.connections.size,
      accountsWithConnections: this.accountConnections.size,
      isRunning: this.isRunning
    }
  }

  /**
   * 获取连接详情
   */
  getConnectionDetails(connectionId) {
    return this.connections.get(connectionId) || null
  }

  /**
   * 获取账户连接列表
   */
  getAccountConnections(accountId) {
    const connectionIds = this.accountConnections.get(accountId) || new Set()
    return Array.from(connectionIds)
      .map((id) => this.connections.get(id))
      .filter(Boolean)
  }

  /**
   * 获取完整状态报告
   */
  getStatusReport() {
    return {
      config: this.config,
      stats: this.getLifecycleStats(),
      performanceReport: this.generatePerformanceReport(),
      timestamp: Date.now()
    }
  }
}

module.exports = ConnectionLifecycleManager
