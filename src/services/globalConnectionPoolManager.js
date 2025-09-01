const SmartConnectionPool = require('./smartConnectionPool')
const redis = require('../models/redis')
const logger = require('../utils/logger')

/**
 * 全局连接池管理器
 * 负责管理所有账户的智能连接池
 * 特性：
 * - 统一初始化所有账户连接池
 * - 提供统一的连接获取接口
 * - 连接池状态监控和统计
 * - 账户连接池的生命周期管理
 */
class GlobalConnectionPoolManager {
  constructor() {
    this.pools = new Map() // accountId -> SmartConnectionPool
    this.isInitialized = false
    this.stats = {
      totalPools: 0,
      totalConnections: 0,
      totalErrors: 0,
      initializeStartedAt: null,
      initializeCompletedAt: null,
      lastHealthCheckAt: null
    }

    logger.info('🌐 全局连接池管理器已创建')
  }

  /**
   * 初始化所有账户的连接池
   */
  async initializeAllPools() {
    if (this.isInitialized) {
      logger.info('⚠️ 连接池管理器已初始化，跳过重复初始化')
      return
    }

    this.stats.initializeStartedAt = Date.now()
    logger.info('🚀 开始初始化所有账户连接池...')

    try {
      // 获取所有Claude账户
      const accounts = await this.getAllClaudeAccounts()
      logger.info(`📊 发现 ${accounts.length} 个Claude账户`)

      let successCount = 0
      let failureCount = 0

      // 为每个账户创建连接池
      for (const account of accounts) {
        try {
          await this.initializeAccountPool(account.id, account.name, account.proxy)
          successCount++
          logger.success(`✅ 账户连接池初始化成功: ${account.name} (${account.id})`)
        } catch (error) {
          failureCount++
          logger.error(
            `❌ 账户连接池初始化失败: ${account.name} (${account.id}) - ${error.message}`
          )
          // 继续处理其他账户，不中断整体初始化
        }
      }

      this.stats.totalPools = this.pools.size
      this.stats.initializeCompletedAt = Date.now()
      this.isInitialized = true

      const totalTime = this.stats.initializeCompletedAt - this.stats.initializeStartedAt

      logger.success(
        `🎉 连接池管理器初始化完成! 成功: ${successCount}, 失败: ${failureCount}, 耗时: ${totalTime}ms`
      )

      // 计算总连接数
      this.updateConnectionStats()

      logger.info(`📈 连接池统计: ${this.stats.totalPools} 个池, ${this.stats.totalConnections} 个连接`)
    } catch (error) {
      logger.error('❌ 连接池管理器初始化失败:', error.message)
      throw error
    }
  }

  /**
   * 初始化单个账户的连接池
   */
  async initializeAccountPool(accountId, accountName, proxyConfig) {
    if (this.pools.has(accountId)) {
      logger.warn(`⚠️ 账户连接池已存在: ${accountName} (${accountId})`)
      return
    }

    if (!proxyConfig) {
      throw new Error(`Account ${accountId} has no proxy configuration`)
    }

    logger.info(`🔧 初始化账户连接池: ${accountName} (${accountId})`)

    // 创建智能连接池
    const pool = new SmartConnectionPool(accountId, proxyConfig)

    // 初始化连接池（预热连接）
    await pool.initialize()

    // 存储到管理器中
    this.pools.set(accountId, pool)

    logger.debug(`💾 连接池已存储: 账户 ${accountName} (${accountId})`)
  }

  /**
   * 获取所有Claude账户信息
   */
  async getAllClaudeAccounts() {
    try {
      // 获取所有Claude账户
      const accountKeys = await redis.client.keys('claude:account:*')
      const accounts = []

      for (const key of accountKeys) {
        try {
          const accountData = await redis.client.hgetall(key)
          if (accountData && accountData.id) {
            // 解析代理配置
            let proxyConfig = null
            if (accountData.proxy) {
              try {
                proxyConfig = JSON.parse(accountData.proxy)
              } catch (parseError) {
                logger.warn(`⚠️ 账户 ${accountData.id} 代理配置解析失败: ${parseError.message}`)
                continue
              }
            }

            accounts.push({
              id: accountData.id,
              name: accountData.name || `账户-${accountData.id.slice(0, 8)}`,
              proxy: proxyConfig,
              isActive: accountData.isActive === 'true',
              status: accountData.status
            })
          }
        } catch (error) {
          logger.warn(`⚠️ 读取账户数据失败 ${key}: ${error.message}`)
          continue
        }
      }

      // 过滤活跃账户和有代理配置的账户
      const activeAccounts = accounts.filter((account) => {
        if (!account.isActive) {
          logger.debug(`⏸️ 跳过非活跃账户: ${account.name} (${account.id})`)
          return false
        }
        if (!account.proxy) {
          logger.debug(`⏸️ 跳过无代理配置账户: ${account.name} (${account.id})`)
          return false
        }
        return true
      })

      logger.info(`📋 有效账户筛选: ${accounts.length} -> ${activeAccounts.length}`)
      return activeAccounts
    } catch (error) {
      logger.error('❌ 获取Claude账户列表失败:', error.message)
      throw error
    }
  }

  /**
   * 获取指定账户的连接
   */
  getConnectionForAccount(accountId) {
    if (!this.isInitialized) {
      throw new Error('Connection pool manager not initialized')
    }

    const pool = this.pools.get(accountId)
    if (!pool) {
      throw new Error(`No connection pool found for account ${accountId}`)
    }

    try {
      const connection = pool.getConnection()
      logger.debug(`🔗 获取连接: 账户 ${accountId}, 连接 ${connection.connectionId}`)
      return connection
    } catch (error) {
      logger.error(`❌ 获取连接失败: 账户 ${accountId} - ${error.message}`)
      throw error
    }
  }

  /**
   * 获取连接池状态
   */
  getPoolStatus(accountId) {
    const pool = this.pools.get(accountId)
    if (!pool) {
      return null
    }

    return pool.getStatus()
  }

  /**
   * 获取所有连接池状态
   */
  getAllPoolStatus() {
    const status = {
      manager: {
        isInitialized: this.isInitialized,
        totalPools: this.pools.size,
        stats: { ...this.stats }
      },
      pools: []
    }

    for (const [accountId, pool] of this.pools) {
      status.pools.push(pool.getStatus())
    }

    return status
  }

  /**
   * 更新连接统计信息
   */
  updateConnectionStats() {
    let totalConnections = 0
    let totalErrors = 0

    for (const pool of this.pools.values()) {
      const status = pool.getStatus()
      totalConnections += status.totalConnections
      totalErrors += status.stats.errorCount
    }

    this.stats.totalConnections = totalConnections
    this.stats.totalErrors = totalErrors
    this.stats.lastHealthCheckAt = Date.now()
  }

  /**
   * 健康检查 - 检查所有连接池状态
   */
  async performHealthCheck() {
    if (!this.isInitialized) {
      logger.warn('⚠️ 连接池管理器未初始化，跳过健康检查')
      return
    }

    logger.debug('🏥 开始连接池健康检查...')

    let healthyPools = 0
    let unhealthyPools = 0

    for (const [accountId, pool] of this.pools) {
      const status = pool.getStatus()
      if (status.healthyConnections > 0) {
        healthyPools++
      } else {
        unhealthyPools++
        logger.warn(`⚠️ 连接池无可用连接: 账户 ${accountId}`)
      }
    }

    this.updateConnectionStats()

    logger.info(
      `🏥 健康检查完成: 健康 ${healthyPools}, 不健康 ${unhealthyPools}, 总连接 ${this.stats.totalConnections}`
    )

    return {
      healthyPools,
      unhealthyPools,
      totalPools: this.pools.size,
      totalConnections: this.stats.totalConnections
    }
  }

  /**
   * 添加新账户的连接池
   */
  async addAccountPool(accountId, accountName, proxyConfig) {
    try {
      await this.initializeAccountPool(accountId, accountName, proxyConfig)
      this.stats.totalPools = this.pools.size
      this.updateConnectionStats()
      logger.success(`✅ 新账户连接池已添加: ${accountName} (${accountId})`)
      return true
    } catch (error) {
      logger.error(`❌ 添加账户连接池失败: ${accountName} (${accountId}) - ${error.message}`)
      return false
    }
  }

  /**
   * 移除账户的连接池
   */
  removeAccountPool(accountId) {
    const pool = this.pools.get(accountId)
    if (!pool) {
      logger.warn(`⚠️ 账户连接池不存在: ${accountId}`)
      return false
    }

    // 销毁连接池
    pool.destroy()

    // 从管理器中移除
    this.pools.delete(accountId)

    this.stats.totalPools = this.pools.size
    this.updateConnectionStats()

    logger.success(`✅ 账户连接池已移除: ${accountId}`)
    return true
  }

  /**
   * 销毁所有连接池
   */
  destroy() {
    logger.info('🗑️ 开始销毁所有连接池...')

    for (const [accountId, pool] of this.pools) {
      try {
        pool.destroy()
        logger.debug(`🗑️ 连接池已销毁: 账户 ${accountId}`)
      } catch (error) {
        logger.error(`❌ 销毁连接池失败: 账户 ${accountId} - ${error.message}`)
      }
    }

    this.pools.clear()
    this.isInitialized = false
    this.stats.totalPools = 0
    this.stats.totalConnections = 0

    logger.success('✅ 所有连接池已销毁')
  }

  /**
   * 获取管理器实例的摘要信息
   */
  getSummary() {
    return {
      isInitialized: this.isInitialized,
      totalPools: this.pools.size,
      totalConnections: this.stats.totalConnections,
      totalErrors: this.stats.totalErrors,
      uptime: this.stats.initializeCompletedAt
        ? Date.now() - this.stats.initializeCompletedAt
        : null
    }
  }
}

// 创建全局单例实例
const globalConnectionPoolManager = new GlobalConnectionPoolManager()

module.exports = globalConnectionPoolManager