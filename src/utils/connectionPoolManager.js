const { SocksProxyAgent } = require('socks-proxy-agent')
const { HttpsProxyAgent } = require('https-proxy-agent')
const crypto = require('crypto')
const EventEmitter = require('events')
const logger = require('./logger')
const config = require('../../config/config')

/**
 * 专用连接池管理器
 * 为每个账户+代理配置组合维护独立的连接池
 * 支持双连接架构和自动故障转移
 */
class ConnectionPoolManager extends EventEmitter {
  constructor() {
    super()
    
    // 连接池缓存: Map<poolKey, ConnectionPool>
    this.pools = new Map()
    
    // 连接池使用统计
    this.poolStats = new Map()
    
    // 清理定时器
    this.cleanupInterval = null
    
    // 初始化
    this._initializeCleanup()
    
    logger.info('🏊 ConnectionPoolManager initialized')
  }

  /**
   * 获取或创建连接池
   * @param {string} accountId - 账户ID
   * @param {object|string} proxyConfig - 代理配置
   * @param {object} options - 额外选项
   * @returns {ConnectionPool} 连接池实例
   */
  getPool(accountId, proxyConfig, options = {}) {
    const poolKey = this._generatePoolKey(accountId, proxyConfig)
    
    // 从缓存获取现有连接池
    if (this.pools.has(poolKey)) {
      const pool = this.pools.get(poolKey)
      this._updatePoolStats(poolKey, 'hit')
      return pool
    }
    
    // 创建新连接池
    const pool = new ConnectionPool(accountId, proxyConfig, options)
    this.pools.set(poolKey, pool)
    this._updatePoolStats(poolKey, 'create')
    
    // 监听连接池事件
    this._setupPoolEventListeners(poolKey, pool)
    
    logger.info(`🏊 Created new connection pool for account ${accountId}: ${this._getProxyDescription(proxyConfig)}`)
    return pool
  }

  /**
   * 获取连接池Agent（主要接口）
   * @param {string} accountId - 账户ID
   * @param {object|string} proxyConfig - 代理配置
   * @param {object} options - 额外选项
   * @returns {Agent|null} 代理Agent
   */
  getAgent(accountId, proxyConfig, options = {}) {
    if (!proxyConfig) {
      return null
    }
    
    try {
      const pool = this.getPool(accountId, proxyConfig, options)
      return pool.getAgent()
    } catch (error) {
      logger.error('❌ Failed to get agent from connection pool:', error.message)
      return null
    }
  }

  /**
   * 获取连接池状态统计
   * @returns {object} 统计信息
   */
  getStats() {
    const stats = {
      totalPools: this.pools.size,
      poolDetails: [],
      globalStats: {
        totalHits: 0,
        totalCreates: 0,
        totalErrors: 0
      }
    }
    
    for (const [poolKey, poolStat] of this.poolStats.entries()) {
      const pool = this.pools.get(poolKey)
      stats.poolDetails.push({
        poolKey,
        ...poolStat,
        poolStatus: pool ? pool.getStatus() : 'destroyed'
      })
      
      stats.globalStats.totalHits += poolStat.hits || 0
      stats.globalStats.totalCreates += poolStat.creates || 0
      stats.globalStats.totalErrors += poolStat.errors || 0
    }
    
    return stats
  }

  /**
   * 清理未使用的连接池
   */
  cleanup() {
    const now = Date.now()
    const maxIdleTime = 30 * 60 * 1000 // 30分钟
    const toDelete = []
    
    for (const [poolKey, pool] of this.pools.entries()) {
      if (pool.getIdleTime() > maxIdleTime) {
        toDelete.push(poolKey)
      }
    }
    
    for (const poolKey of toDelete) {
      const pool = this.pools.get(poolKey)
      pool.destroy()
      this.pools.delete(poolKey)
      this.poolStats.delete(poolKey)
      logger.info(`🧹 Cleaned up idle connection pool: ${poolKey}`)
    }
    
    if (toDelete.length > 0) {
      logger.info(`🧹 Connection pool cleanup completed: removed ${toDelete.length} idle pools`)
    }
  }

  /**
   * 销毁所有连接池
   */
  destroy() {
    // 清理定时器
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval)
      this.cleanupInterval = null
    }
    
    // 销毁所有连接池
    for (const [poolKey, pool] of this.pools.entries()) {
      pool.destroy()
    }
    
    this.pools.clear()
    this.poolStats.clear()
    
    logger.info('🏊 ConnectionPoolManager destroyed')
  }

  /**
   * 生成连接池键
   * @private
   */
  _generatePoolKey(accountId, proxyConfig) {
    const proxyStr = typeof proxyConfig === 'string' ? proxyConfig : JSON.stringify(proxyConfig)
    const hash = crypto.createHash('md5').update(proxyStr).digest('hex').substring(0, 8)
    return `${accountId}:${hash}`
  }

  /**
   * 更新连接池统计
   * @private
   */
  _updatePoolStats(poolKey, action) {
    if (!this.poolStats.has(poolKey)) {
      this.poolStats.set(poolKey, {
        hits: 0,
        creates: 0,
        errors: 0,
        lastAccess: Date.now()
      })
    }
    
    const stats = this.poolStats.get(poolKey)
    stats.lastAccess = Date.now()
    
    switch (action) {
      case 'hit':
        stats.hits++
        break
      case 'create':
        stats.creates++
        break
      case 'error':
        stats.errors++
        break
    }
  }

  /**
   * 设置连接池事件监听
   * @private
   */
  _setupPoolEventListeners(poolKey, pool) {
    pool.on('error', (error) => {
      this._updatePoolStats(poolKey, 'error')
      logger.warn(`🏊 Connection pool error for ${poolKey}:`, error.message)
    })
    
    pool.on('connection_failed', (error) => {
      logger.warn(`🔌 Connection failed in pool ${poolKey}:`, error.message)
    })
    
    pool.on('failover', (from, to) => {
      logger.info(`🔄 Connection pool ${poolKey} failover: ${from} -> ${to}`)
    })
  }

  /**
   * 获取代理描述
   * @private
   */
  _getProxyDescription(proxyConfig) {
    if (!proxyConfig) {
      return 'No proxy'
    }
    
    try {
      const proxy = typeof proxyConfig === 'string' ? JSON.parse(proxyConfig) : proxyConfig
      return `${proxy.type}://${proxy.host}:${proxy.port}`
    } catch (error) {
      return 'Invalid proxy config'
    }
  }

  /**
   * 初始化清理机制
   * @private
   */
  _initializeCleanup() {
    // 每10分钟清理一次未使用的连接池
    this.cleanupInterval = setInterval(() => {
      this.cleanup()
    }, 10 * 60 * 1000)
  }
}

/**
 * 单个连接池类
 * 管理特定代理配置的连接
 */
class ConnectionPool extends EventEmitter {
  constructor(accountId, proxyConfig, options = {}) {
    super()
    
    this.accountId = accountId
    this.proxyConfig = typeof proxyConfig === 'string' ? JSON.parse(proxyConfig) : proxyConfig
    this.options = options
    
    // 连接Agent（主备）
    this.primaryAgent = null
    this.secondaryAgent = null
    this.currentAgent = 'primary' // 'primary' | 'secondary'
    
    // 连接状态
    this.connectionState = {
      primary: { healthy: true, lastError: null, errorCount: 0 },
      secondary: { healthy: true, lastError: null, errorCount: 0 }
    }
    
    // 统计信息
    this.stats = {
      created: Date.now(),
      lastUsed: Date.now(),
      requestCount: 0,
      errorCount: 0,
      failoverCount: 0
    }
    
    // 创建连接Agent
    this._createAgents()
    
    logger.debug(`🏊 ConnectionPool created for account ${accountId}`)
  }

  /**
   * 获取可用的Agent
   * @returns {Agent} 代理Agent
   */
  getAgent() {
    this.stats.lastUsed = Date.now()
    this.stats.requestCount++
    
    // 选择健康的连接
    const agent = this._selectHealthyAgent()
    if (!agent) {
      throw new Error('No healthy connections available in pool')
    }
    
    return agent
  }

  /**
   * 获取连接池状态
   * @returns {object} 状态信息
   */
  getStatus() {
    return {
      accountId: this.accountId,
      currentAgent: this.currentAgent,
      connectionState: { ...this.connectionState },
      stats: { ...this.stats },
      idleTime: this.getIdleTime()
    }
  }

  /**
   * 获取空闲时间（毫秒）
   * @returns {number} 空闲时间
   */
  getIdleTime() {
    return Date.now() - this.stats.lastUsed
  }

  /**
   * 销毁连接池
   */
  destroy() {
    if (this.primaryAgent && this.primaryAgent.destroy) {
      this.primaryAgent.destroy()
    }
    if (this.secondaryAgent && this.secondaryAgent.destroy) {
      this.secondaryAgent.destroy()
    }
    
    this.primaryAgent = null
    this.secondaryAgent = null
    
    logger.debug(`🏊 ConnectionPool destroyed for account ${this.accountId}`)
  }

  /**
   * 创建主备Agent
   * @private
   */
  _createAgents() {
    const agentOptions = {
      // 连接池配置
      keepAlive: config.proxy?.keepAlive !== false,
      keepAliveMsecs: 30000,
      maxSockets: 1, // 每个Agent只维护1个连接
      maxFreeSockets: 1,
      
      // 超时配置
      timeout: config.proxy?.connectTimeout || 10000,
      
      // IP协议族
      family: this.options.useIPv4 === false ? 6 : 4
    }
    
    try {
      // 创建主连接
      this.primaryAgent = this._createSingleAgent(agentOptions)
      this._setupAgentEventListeners(this.primaryAgent, 'primary')
      
      // 创建备用连接
      this.secondaryAgent = this._createSingleAgent(agentOptions)
      this._setupAgentEventListeners(this.secondaryAgent, 'secondary')
      
      logger.debug(`🏊 Created primary and secondary agents for account ${this.accountId}`)
    } catch (error) {
      logger.error(`❌ Failed to create agents for account ${this.accountId}:`, error.message)
      throw error
    }
  }

  /**
   * 创建单个Agent
   * @private
   */
  _createSingleAgent(options) {
    const auth = this.proxyConfig.username && this.proxyConfig.password 
      ? `${this.proxyConfig.username}:${this.proxyConfig.password}@` 
      : ''
    
    if (this.proxyConfig.type === 'socks5') {
      const socksUrl = `socks5://${auth}${this.proxyConfig.host}:${this.proxyConfig.port}`
      return new SocksProxyAgent(socksUrl, options)
    } else if (this.proxyConfig.type === 'http' || this.proxyConfig.type === 'https') {
      const proxyUrl = `${this.proxyConfig.type}://${auth}${this.proxyConfig.host}:${this.proxyConfig.port}`
      return new HttpsProxyAgent(proxyUrl, options)
    } else {
      throw new Error(`Unsupported proxy type: ${this.proxyConfig.type}`)
    }
  }

  /**
   * 选择健康的Agent
   * @private
   */
  _selectHealthyAgent() {
    // 优先使用当前Agent（如果健康）
    if (this.currentAgent === 'primary' && this.connectionState.primary.healthy && this.primaryAgent) {
      return this.primaryAgent
    } else if (this.currentAgent === 'secondary' && this.connectionState.secondary.healthy && this.secondaryAgent) {
      return this.secondaryAgent
    }
    
    // 当前Agent不健康，尝试切换
    if (this.currentAgent === 'primary' && this.connectionState.secondary.healthy && this.secondaryAgent) {
      this._failover('primary', 'secondary')
      return this.secondaryAgent
    } else if (this.currentAgent === 'secondary' && this.connectionState.primary.healthy && this.primaryAgent) {
      this._failover('secondary', 'primary')
      return this.primaryAgent
    }
    
    // 都不健康，返回当前Agent让上层处理错误
    return this.currentAgent === 'primary' ? this.primaryAgent : this.secondaryAgent
  }

  /**
   * 执行故障转移
   * @private
   */
  _failover(from, to) {
    this.currentAgent = to
    this.stats.failoverCount++
    this.emit('failover', from, to)
    logger.info(`🔄 Connection pool failover for account ${this.accountId}: ${from} -> ${to}`)
  }

  /**
   * 设置Agent事件监听
   * @private
   */
  _setupAgentEventListeners(agent, agentType) {
    agent.on('error', (error) => {
      this.connectionState[agentType].healthy = false
      this.connectionState[agentType].lastError = error.message
      this.connectionState[agentType].errorCount++
      this.stats.errorCount++
      
      logger.warn(`🔌 Agent error in pool (${agentType}) for account ${this.accountId}:`, error.message)
      this.emit('connection_failed', error)
    })
    
    // 监听socket事件来更新健康状态
    const originalCreateConnection = agent.createConnection
    if (originalCreateConnection) {
      agent.createConnection = (...args) => {
        const socket = originalCreateConnection.apply(agent, args)
        
        socket.on('connect', () => {
          // 连接成功，重置健康状态
          this.connectionState[agentType].healthy = true
          this.connectionState[agentType].errorCount = 0
        })
        
        socket.on('error', (error) => {
          this.connectionState[agentType].healthy = false
          this.connectionState[agentType].lastError = error.message
          this.connectionState[agentType].errorCount++
        })
        
        return socket
      }
    }
  }
}

// 创建全局连接池管理器实例
const connectionPoolManager = new ConnectionPoolManager()

// 优雅关闭处理
process.on('SIGTERM', () => {
  logger.info('🏊 Shutting down ConnectionPoolManager...')
  connectionPoolManager.destroy()
})

process.on('SIGINT', () => {
  logger.info('🏊 Shutting down ConnectionPoolManager...')
  connectionPoolManager.destroy()
})

module.exports = connectionPoolManager