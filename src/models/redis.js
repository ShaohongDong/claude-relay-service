const Redis = require('ioredis')
const config = require('../../config/config')
const logger = require('../utils/logger')

// 时区辅助函数
// 注意：这个函数的目的是获取某个时间点在目标时区的"本地"表示
// 例如：UTC时间 2025-07-30 01:00:00 在 UTC+8 时区表示为 2025-07-30 09:00:00
function getDateInTimezone(date = new Date()) {
  const offset = config.system.timezoneOffset || 8 // 默认UTC+8

  // 方法：创建一个偏移后的Date对象，使其getUTCXXX方法返回目标时区的值
  // 这样我们可以用getUTCFullYear()等方法获取目标时区的年月日时分秒
  const offsetMs = offset * 3600000 // 时区偏移的毫秒数
  const adjustedTime = new Date(date.getTime() + offsetMs)

  return adjustedTime
}

// 获取配置时区的日期字符串 (YYYY-MM-DD)
function getDateStringInTimezone(date = new Date()) {
  const tzDate = getDateInTimezone(date)
  // 使用UTC方法获取偏移后的日期部分
  return `${tzDate.getUTCFullYear()}-${String(tzDate.getUTCMonth() + 1).padStart(2, '0')}-${String(tzDate.getUTCDate()).padStart(2, '0')}`
}

// 获取配置时区的小时 (0-23)
function getHourInTimezone(date = new Date()) {
  const tzDate = getDateInTimezone(date)
  return tzDate.getUTCHours()
}

// 获取配置时区的 ISO 周（YYYY-Wxx 格式，周一到周日）
function getWeekStringInTimezone(date = new Date()) {
  const tzDate = getDateInTimezone(date)

  // 获取年份
  const year = tzDate.getUTCFullYear()

  // 计算 ISO 周数（周一为第一天）
  const dateObj = new Date(tzDate)
  const dayOfWeek = dateObj.getUTCDay() || 7 // 将周日(0)转换为7
  const firstThursday = new Date(dateObj)
  firstThursday.setUTCDate(dateObj.getUTCDate() + 4 - dayOfWeek) // 找到这周的周四

  const yearStart = new Date(firstThursday.getUTCFullYear(), 0, 1)
  const weekNumber = Math.ceil(((firstThursday - yearStart) / 86400000 + 1) / 7)

  return `${year}-W${String(weekNumber).padStart(2, '0')}`
}

class RedisClient {
  constructor() {
    this.client = null
    this.isConnected = false
  }

  async connect() {
    try {
      this.client = new Redis({
        host: config.redis.host,
        port: config.redis.port,
        password: config.redis.password,
        db: config.redis.db,
        retryDelayOnFailover: config.redis.retryDelayOnFailover,
        maxRetriesPerRequest: config.redis.maxRetriesPerRequest,
        lazyConnect: config.redis.lazyConnect,
        tls: config.redis.enableTLS ? {} : false
      })

      this.client.on('connect', () => {
        this.isConnected = true
        logger.info('🔗 Redis connected successfully')
      })

      this.client.on('error', (err) => {
        this.isConnected = false
        logger.error('❌ Redis connection error:', err)
      })

      this.client.on('close', () => {
        this.isConnected = false
        logger.warn('⚠️  Redis connection closed')
      })

      await this.client.connect()
      return this.client
    } catch (error) {
      logger.error('💥 Failed to connect to Redis:', error)
      throw error
    }
  }

  async disconnect() {
    if (this.client) {
      await this.client.quit()
      this.isConnected = false
      logger.info('👋 Redis disconnected')
    }
  }

  getClient() {
    if (!this.client || !this.isConnected) {
      logger.warn('⚠️ Redis client is not connected')
      return null
    }
    return this.client
  }

  // 安全获取客户端（用于关键操作）
  getClientSafe() {
    if (!this.client || !this.isConnected) {
      throw new Error('Redis client is not connected')
    }
    return this.client
  }

  // 🔑 API Key 相关操作
  async setApiKey(keyId, keyData, hashedKey = null) {
    const key = `apikey:${keyId}`
    const client = this.getClientSafe()

    // 维护哈希映射表（用于快速查找）
    // hashedKey参数是实际的哈希值，用于建立映射
    if (hashedKey) {
      await client.hset('apikey:hash_map', hashedKey, keyId)
    }

    await client.hset(key, keyData)
    await client.expire(key, 86400 * 365) // 1年过期
  }

  async getApiKey(keyId) {
    const key = `apikey:${keyId}`
    return await this.client.hgetall(key)
  }

  async deleteApiKey(keyId) {
    const key = `apikey:${keyId}`

    // 获取要删除的API Key哈希值，以便从映射表中移除
    const keyData = await this.client.hgetall(key)
    if (keyData && keyData.apiKey) {
      // keyData.apiKey现在存储的是哈希值，直接从映射表删除
      await this.client.hdel('apikey:hash_map', keyData.apiKey)
    }

    return await this.client.del(key)
  }

  async getAllApiKeys() {
    const keys = await this.client.keys('apikey:*')
    const apiKeys = []
    for (const key of keys) {
      // 过滤掉hash_map，它不是真正的API Key
      if (key === 'apikey:hash_map') {
        continue
      }

      const keyData = await this.client.hgetall(key)
      if (keyData && Object.keys(keyData).length > 0) {
        apiKeys.push({ id: key.replace('apikey:', ''), ...keyData })
      }
    }
    return apiKeys
  }

  // 🔍 通过哈希值查找API Key（性能优化）
  async findApiKeyByHash(hashedKey) {
    // 使用反向映射表：hash -> keyId
    const keyId = await this.client.hget('apikey:hash_map', hashedKey)
    if (!keyId) {
      return null
    }

    const keyData = await this.client.hgetall(`apikey:${keyId}`)
    if (keyData && Object.keys(keyData).length > 0) {
      return { id: keyId, ...keyData }
    }

    // 如果数据不存在，清理映射表
    await this.client.hdel('apikey:hash_map', hashedKey)
    return null
  }

  // 📊 使用统计相关操作（支持缓存token统计和模型信息）
  // 标准化模型名称，用于统计聚合
  _normalizeModelName(model) {
    if (!model || model === 'unknown') {
      return model
    }

    // 对于其他模型，去掉常见的版本后缀
    return model.replace(/-v\d+:\d+$|:latest$/, '')
  }

  // Token使用统计方法（已精简，空操作）
  async incrementTokenUsage(
    _keyId,
    _tokens,
    _inputTokens = 0,
    _outputTokens = 0,
    _cacheCreateTokens = 0,
    _cacheReadTokens = 0,
    _model = 'unknown',
    _ephemeral5mTokens = 0,
    _ephemeral1hTokens = 0,
    _isLongContextRequest = false
  ) {
    // 精简版：不再进行使用统计，直接返回
    return
  }

  // 📊 记录账户级别的使用统计（精简版）
  async incrementAccountUsage(
    _accountId,
    _totalTokens,
    _inputTokens = 0,
    _outputTokens = 0,
    _cacheCreateTokens = 0,
    _cacheReadTokens = 0,
    _model = 'unknown',
    _isLongContextRequest = false
  ) {
    // 精简版：不再进行使用统计，直接返回
    return
  }

  async getUsageStats(_keyId) {
    // 精简版：返回默认的使用统计数据
    const defaultUsage = {
      tokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheCreateTokens: 0,
      cacheReadTokens: 0,
      allTokens: 0,
      requests: 0
    }

    return {
      total: defaultUsage,
      daily: defaultUsage,
      monthly: defaultUsage,
      averages: {
        rpm: 0,
        tpm: 0,
        dailyRequests: 0,
        dailyTokens: 0
      }
    }
  }

  // 💰 获取当日费用（精简版）
  async getDailyCost(_keyId) {
    // 精简版：不再进行费用统计，直接返回0
    return 0
  }

  // 💰 增加当日费用（精简版）
  async incrementDailyCost(_keyId, _amount) {
    // 精简版：不再进行费用统计，直接返回
    return
  }

  // 💰 获取费用统计（精简版）
  async getCostStats(_keyId) {
    // 精简版：不再进行费用统计，返回默认值
    return {
      daily: 0,
      monthly: 0,
      hourly: 0,
      total: 0
    }
  }

  // 💰 获取本周 Opus 费用（精简版）
  async getWeeklyOpusCost(_keyId) {
    // 精简版：不再进行费用统计，直接返回0
    return 0
  }

  // 💰 增加本周 Opus 费用（精简版）
  async incrementWeeklyOpusCost(_keyId, _amount) {
    // 精简版：不再进行费用统计，直接返回
    return
  }

  // 📊 获取账户使用统计（精简版）
  async getAccountUsageStats(accountId) {
    // 精简版：返回默认的账户统计数据
    const defaultUsage = {
      tokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheCreateTokens: 0,
      cacheReadTokens: 0,
      allTokens: 0,
      requests: 0
    }

    return {
      accountId,
      total: defaultUsage,
      daily: defaultUsage,
      monthly: defaultUsage,
      averages: {
        rpm: 0,
        tpm: 0,
        dailyRequests: 0,
        dailyTokens: 0
      }
    }
  }

  // 📈 获取所有账户的使用统计（精简版）
  async getAllAccountsUsageStats() {
    // 精简版：不再进行复杂的统计查询，直接返回空数组
    return []
  }

  // 🧹 清空所有API Key的使用统计数据（精简版）
  async resetAllUsageStats() {
    // 精简版：不再执行复杂的清理操作，返回默认统计
    return {
      deletedKeys: 0,
      deletedDailyKeys: 0,
      deletedMonthlyKeys: 0,
      resetApiKeys: 0
    }
  }

  // 🏢 Claude 账户管理
  async setClaudeAccount(accountId, accountData) {
    const key = `claude:account:${accountId}`
    await this.client.hset(key, accountData)
  }

  async getClaudeAccount(accountId) {
    const key = `claude:account:${accountId}`
    return await this.client.hgetall(key)
  }

  async getAllClaudeAccounts() {
    const keys = await this.client.keys('claude:account:*')
    const accounts = []
    for (const key of keys) {
      const accountData = await this.client.hgetall(key)
      if (accountData && Object.keys(accountData).length > 0) {
        accounts.push({ id: key.replace('claude:account:', ''), ...accountData })
      }
    }
    return accounts
  }

  async deleteClaudeAccount(accountId) {
    const key = `claude:account:${accountId}`
    return await this.client.del(key)
  }

  // 🔐 会话管理（用于管理员登录等）
  async setSession(sessionId, sessionData, ttl = 86400) {
    const key = `session:${sessionId}`
    await this.client.hset(key, sessionData)
    await this.client.expire(key, ttl)
  }

  async getSession(sessionId) {
    const key = `session:${sessionId}`
    return await this.client.hgetall(key)
  }

  async deleteSession(sessionId) {
    const key = `session:${sessionId}`
    return await this.client.del(key)
  }

  // 🗝️ API Key哈希索引管理
  async setApiKeyHash(hashedKey, keyData, ttl = 0) {
    const key = `apikey_hash:${hashedKey}`
    await this.client.hset(key, keyData)
    if (ttl > 0) {
      await this.client.expire(key, ttl)
    }
  }

  async getApiKeyHash(hashedKey) {
    const key = `apikey_hash:${hashedKey}`
    return await this.client.hgetall(key)
  }

  async deleteApiKeyHash(hashedKey) {
    const key = `apikey_hash:${hashedKey}`
    return await this.client.del(key)
  }

  // 🔗 OAuth会话管理
  async setOAuthSession(sessionId, sessionData, ttl = 600) {
    // 10分钟过期
    const key = `oauth:${sessionId}`

    // 序列化复杂对象，特别是 proxy 配置
    const serializedData = {}
    for (const [dataKey, value] of Object.entries(sessionData)) {
      if (typeof value === 'object' && value !== null) {
        serializedData[dataKey] = JSON.stringify(value)
      } else {
        serializedData[dataKey] = value
      }
    }

    await this.client.hset(key, serializedData)
    await this.client.expire(key, ttl)
  }

  async getOAuthSession(sessionId) {
    const key = `oauth:${sessionId}`
    const data = await this.client.hgetall(key)

    // 反序列化 proxy 字段
    if (data.proxy) {
      try {
        data.proxy = JSON.parse(data.proxy)
      } catch (error) {
        // 如果解析失败，设置为 null
        data.proxy = null
      }
    }

    return data
  }

  async deleteOAuthSession(sessionId) {
    const key = `oauth:${sessionId}`
    return await this.client.del(key)
  }

  // 📈 系统统计
  async getSystemStats() {
    const keys = await Promise.all([
      this.client.keys('apikey:*'),
      this.client.keys('claude:account:*'),
      this.client.keys('usage:*')
    ])

    return {
      totalApiKeys: keys[0].length,
      totalClaudeAccounts: keys[1].length,
      totalUsageRecords: keys[2].length
    }
  }

  // 📊 获取今日系统统计（精简版）
  async getTodayStats() {
    // 精简版：不再进行复杂的今日统计查询，返回默认值
    return {
      requestsToday: 0,
      tokensToday: 0,
      inputTokensToday: 0,
      outputTokensToday: 0,
      cacheCreateTokensToday: 0,
      cacheReadTokensToday: 0,
      apiKeysCreatedToday: 0
    }
  }

  // 📈 获取系统总的平均RPM和TPM（精简版）
  async getSystemAverages() {
    // 精简版：不再进行复杂的系统统计查询，返回默认值
    return {
      systemRPM: 0,
      systemTPM: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalTokens: 0
    }
  }

  // 📊 获取实时系统指标（精简版）
  async getRealtimeSystemMetrics() {
    // 精简版：不再进行复杂的实时指标查询，返回默认值
    return {
      realtimeRPM: 0,
      realtimeTPM: 0,
      windowMinutes: 5,
      totalRequests: 0,
      totalTokens: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheCreateTokens: 0,
      totalCacheReadTokens: 0
    }
  }

  // 🔗 会话sticky映射管理
  async setSessionAccountMapping(sessionHash, accountId, ttl = 3600) {
    const key = `sticky_session:${sessionHash}`
    await this.client.set(key, accountId, 'EX', ttl)
  }

  async getSessionAccountMapping(sessionHash) {
    const key = `sticky_session:${sessionHash}`
    return await this.client.get(key)
  }

  async deleteSessionAccountMapping(sessionHash) {
    const key = `sticky_session:${sessionHash}`
    return await this.client.del(key)
  }

  // 🧹 清理过期数据
  async cleanup() {
    try {
      const patterns = ['usage:daily:*', 'ratelimit:*', 'session:*', 'sticky_session:*', 'oauth:*']

      for (const pattern of patterns) {
        const keys = await this.client.keys(pattern)
        const pipeline = this.client.pipeline()

        for (const key of keys) {
          const ttl = await this.client.ttl(key)
          if (ttl === -1) {
            // 没有设置过期时间的键
            if (key.startsWith('oauth:')) {
              pipeline.expire(key, 600) // OAuth会话设置10分钟过期
            } else {
              pipeline.expire(key, 86400) // 其他设置1天过期
            }
          }
        }

        await pipeline.exec()
      }

      logger.info('🧹 Redis cleanup completed')
    } catch (error) {
      logger.error('❌ Redis cleanup failed:', error)
    }
  }

  // 增加并发计数
  // 并发控制方法（已精简，返回默认值）
  async incrConcurrency(_apiKeyId) {
    // 精简版：不再进行并发控制，直接返回1
    return 1
  }

  // 减少并发计数（精简版）
  async decrConcurrency(_apiKeyId) {
    // 精简版：不再进行并发控制，直接返回0
    return 0
  }

  // 获取当前并发数（精简版）
  async getConcurrency(_apiKeyId) {
    // 精简版：不再进行并发控制，直接返回0
    return 0
  }

  // 📊 获取账户会话窗口内的使用统计（精简版）
  async getAccountSessionWindowUsage(_accountId, _windowStart, _windowEnd) {
    // 精简版：不再进行复杂的会话窗口统计查询，返回默认值
    return {
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheCreateTokens: 0,
      totalCacheReadTokens: 0,
      totalAllTokens: 0,
      totalRequests: 0,
      modelUsage: {}
    }
  }
}

const redisClient = new RedisClient()

// 导出时区辅助函数
redisClient.getDateInTimezone = getDateInTimezone
redisClient.getDateStringInTimezone = getDateStringInTimezone
redisClient.getHourInTimezone = getHourInTimezone
redisClient.getWeekStringInTimezone = getWeekStringInTimezone

module.exports = redisClient
