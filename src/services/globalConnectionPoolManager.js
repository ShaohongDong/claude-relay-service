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

    logger.info('🌐 Global connection pool manager created')
  }

  /**
   * 初始化所有账户的连接池
   */
  async initializeAllPools() {
    if (this.isInitialized) {
      logger.info('⚠️ Connection pool manager already initialized, skipping duplicate initialization')
      return
    }

    this.stats.initializeStartedAt = Date.now()
    logger.info('🚀 Starting initialization of all account connection pools...')

    try {
      // Get all Claude accounts
      const accounts = await this.getAllClaudeAccounts()
      logger.info(`📊 Found ${accounts.length} Claude accounts`)

      let successCount = 0
      let failureCount = 0

      // Create connection pool for each account
      for (const account of accounts) {
        try {
          await this.initializeAccountPool(account.id, account.name, account.proxy)
          successCount++
          logger.success(`✅ Account connection pool initialized successfully: ${account.name} (${account.id})`)
        } catch (error) {
          failureCount++
          logger.error(
            `❌ Account connection pool initialization failed: ${account.name} (${account.id}) - ${error.message}`
          )
          // Continue processing other accounts, do not interrupt overall initialization
        }
      }

      this.stats.totalPools = this.pools.size
      this.stats.initializeCompletedAt = Date.now()
      this.isInitialized = true

      const totalTime = this.stats.initializeCompletedAt - this.stats.initializeStartedAt

      logger.success(
        `🎉 Connection pool manager initialization completed! Success: ${successCount}, Failed: ${failureCount}, Duration: ${totalTime}ms`
      )

      // Calculate total connections
      this.updateConnectionStats()

      logger.info(
        `📈 Connection pool statistics: ${this.stats.totalPools} pools, ${this.stats.totalConnections} connections`
      )
    } catch (error) {
      logger.error('❌ Connection pool manager initialization failed:', error.message)
      throw error
    }
  }

  /**
   * Initialize connection pool for a single account
   */
  async initializeAccountPool(accountId, accountName, proxyConfig) {
    if (this.pools.has(accountId)) {
      logger.warn(`⚠️ Account connection pool already exists: ${accountName} (${accountId})`)
      return
    }

    if (!proxyConfig) {
      throw new Error(`Account ${accountId} has no proxy configuration`)
    }

    logger.info(`🔧 Initializing account connection pool: ${accountName} (${accountId})`)

    // Create smart connection pool
    const pool = new SmartConnectionPool(accountId, proxyConfig)

    // Initialize connection pool (preheat connections)
    await pool.initialize()

    // Store in manager
    this.pools.set(accountId, pool)

    logger.debug(`💾 Connection pool stored: Account ${accountName} (${accountId})`)
  }

  /**
   * Get all Claude account information
   */
  async getAllClaudeAccounts() {
    try {
      // Get all Claude accounts
      const accountKeys = await redis.client.keys('claude:account:*')
      const accounts = []

      for (const key of accountKeys) {
        try {
          const accountData = await redis.client.hgetall(key)
          if (accountData && accountData.id) {
            // Parse proxy configuration
            let proxyConfig = null
            if (accountData.proxy) {
              try {
                proxyConfig = JSON.parse(accountData.proxy)
              } catch (parseError) {
                logger.warn(`⚠️ Account ${accountData.id} proxy configuration parsing failed: ${parseError.message}`)
                continue
              }
            }

            accounts.push({
              id: accountData.id,
              name: accountData.name || `Account-${accountData.id.slice(0, 8)}`,
              proxy: proxyConfig,
              isActive: accountData.isActive === 'true',
              status: accountData.status
            })
          }
        } catch (error) {
          logger.warn(`⚠️ Failed to read account data ${key}: ${error.message}`)
          continue
        }
      }

      // Filter active accounts and accounts with proxy configuration
      const activeAccounts = accounts.filter((account) => {
        if (!account.isActive) {
          logger.debug(`⏸️ Skipping inactive account: ${account.name} (${account.id})`)
          return false
        }
        if (!account.proxy) {
          logger.debug(`⏸️ Skipping account without proxy configuration: ${account.name} (${account.id})`)
          return false
        }
        return true
      })

      logger.info(`📋 Valid account filtering: ${accounts.length} -> ${activeAccounts.length}`)
      return activeAccounts
    } catch (error) {
      logger.error('❌ Failed to get Claude account list:', error.message)
      throw error
    }
  }

  /**
   * Get connection for specified account
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
      logger.debug(`🔗 Get connection: Account ${accountId}, Connection ${connection.connectionId}`)
      return connection
    } catch (error) {
      logger.error(`❌ Failed to get connection: Account ${accountId} - ${error.message}`)
      throw error
    }
  }

  /**
   * Get connection pool status
   */
  getPoolStatus(accountId) {
    const pool = this.pools.get(accountId)
    if (!pool) {
      return null
    }

    return pool.getStatus()
  }

  /**
   * Get all connection pool statuses
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
   * Update connection statistics
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
   * Health check - Check all connection pool statuses
   */
  async performHealthCheck() {
    if (!this.isInitialized) {
      logger.warn('⚠️ Connection pool manager not initialized, skipping health check')
      return
    }

    logger.debug('🏥 Starting connection pool health check...')

    let healthyPools = 0
    let unhealthyPools = 0

    for (const [accountId, pool] of this.pools) {
      const status = pool.getStatus()
      if (status.healthyConnections > 0) {
        healthyPools++
      } else {
        unhealthyPools++
        logger.warn(`⚠️ Connection pool has no available connections: Account ${accountId}`)
      }
    }

    this.updateConnectionStats()

    logger.info(
      `🏥 Health check completed: Healthy ${healthyPools}, Unhealthy ${unhealthyPools}, Total connections ${this.stats.totalConnections}`
    )

    return {
      healthyPools,
      unhealthyPools,
      totalPools: this.pools.size,
      totalConnections: this.stats.totalConnections
    }
  }

  /**
   * Add connection pool for new account
   */
  async addAccountPool(accountId, accountName, proxyConfig) {
    try {
      await this.initializeAccountPool(accountId, accountName, proxyConfig)
      this.stats.totalPools = this.pools.size
      this.updateConnectionStats()
      logger.success(`✅ New account connection pool added: ${accountName} (${accountId})`)
      return true
    } catch (error) {
      logger.error(`❌ Failed to add account connection pool: ${accountName} (${accountId}) - ${error.message}`)
      return false
    }
  }

  /**
   * Remove account connection pool
   */
  removeAccountPool(accountId) {
    const pool = this.pools.get(accountId)
    if (!pool) {
      logger.warn(`⚠️ Account connection pool does not exist: ${accountId}`)
      return false
    }

    // Destroy connection pool
    pool.destroy()

    // Remove from manager
    this.pools.delete(accountId)

    this.stats.totalPools = this.pools.size
    this.updateConnectionStats()

    logger.success(`✅ Account connection pool removed: ${accountId}`)
    return true
  }

  /**
   * Destroy all connection pools (with timeout control)
   */
  destroy(timeout = 20000) {
    // 20 second timeout
    return new Promise((resolve) => {
      logger.info('🗑️ Starting to destroy all connection pools...')
      const startTime = Date.now()

      let completedPools = 0
      let errorPools = 0
      const totalPools = this.pools.size

      if (totalPools === 0) {
        logger.info('ℹ️ No connection pools to destroy')
        this.pools.clear()
        this.isInitialized = false
        this.stats.totalPools = 0
        this.stats.totalConnections = 0
        logger.success('✅ Connection pool destruction completed (no action needed)')
        return resolve({ completed: 0, errors: 0, timeout: false })
      }

      // Set timeout handling
      const timeoutHandle = setTimeout(() => {
        const elapsedTime = Date.now() - startTime
        logger.warn(`⚠️ Connection pool destruction timeout (${elapsedTime}ms), forcing cleanup completion`)
        logger.warn(`📊 Destruction status: Completed ${completedPools}/${totalPools}, Errors ${errorPools}`)

        // Force cleanup remaining state
        this.pools.clear()
        this.isInitialized = false
        this.stats.totalPools = 0
        this.stats.totalConnections = 0

        resolve({
          completed: completedPools,
          errors: errorPools,
          timeout: true,
          elapsedTime
        })
      }, timeout)

      // Phased cleanup: graceful shutdown -> forced shutdown
      const gracefulTimeout = Math.min(timeout * 0.75, 15000) // 75% time for graceful shutdown, max 15 seconds

      logger.info(`🕒 Phase 1: Graceful connection pool shutdown (${gracefulTimeout}ms)`)

      // Unified handling of single pool destruction completion
      const handlePoolDestroyed = (accountId, isError = false) => {
        if (isError) {
          errorPools++
        } else {
          completedPools++
        }

        const finished = completedPools + errorPools
        if (finished >= totalPools) {
          clearTimeout(timeoutHandle)
          const elapsedTime = Date.now() - startTime

          this.pools.clear()
          this.isInitialized = false
          this.stats.totalPools = 0
          this.stats.totalConnections = 0

          logger.success(
            `✅ All connection pools destroyed (${elapsedTime}ms): Success ${completedPools}, Errors ${errorPools}`
          )
          resolve({
            completed: completedPools,
            errors: errorPools,
            timeout: false,
            elapsedTime
          })
        }
      }

      // Asynchronously destroy each connection pool
      for (const [accountId, pool] of this.pools) {
        // Set independent destruction timeout for each connection pool
        const poolTimeout = Math.min(gracefulTimeout / totalPools, 5000) // max 5 seconds per pool

        Promise.race([
          // Pool destruction Promise
          new Promise((poolResolve) => {
            try {
              // If pool has async destroy method, handle with Promise
              const destroyResult = pool.destroy()
              if (destroyResult && typeof destroyResult.then === 'function') {
                destroyResult.then(() => poolResolve(true)).catch(() => poolResolve(false))
              } else {
                // Synchronous destroy method
                poolResolve(true)
              }
            } catch (error) {
              logger.error(`❌ Failed to destroy connection pool: Account ${accountId} - ${error.message}`)
              poolResolve(false)
            }
          }),
          // Single pool timeout Promise
          new Promise((poolResolve) => {
            setTimeout(() => {
              logger.warn(`⚠️ Connection pool destruction timeout: Account ${accountId} (${poolTimeout}ms)`)
              poolResolve(false)
            }, poolTimeout)
          })
        ]).then((success) => {
          if (success) {
            logger.debug(`🗑️ Connection pool destroyed: Account ${accountId}`)
            handlePoolDestroyed(accountId, false)
          } else {
            handlePoolDestroyed(accountId, true)
          }
        })
      }
    })
  }

  /**
   * Get manager instance summary information
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

// Create global singleton instance
const globalConnectionPoolManager = new GlobalConnectionPoolManager()

module.exports = globalConnectionPoolManager
