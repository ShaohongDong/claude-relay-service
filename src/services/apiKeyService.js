const crypto = require('crypto')
const { v4: uuidv4 } = require('uuid')
const config = require('../../config/config')
const redis = require('../models/redis')
const logger = require('../utils/logger')
const LRUCache = require('../utils/lruCache')
const cacheMonitor = require('../utils/cacheMonitor')

class ApiKeyService {
  constructor() {
    this.prefix = config.security.apiKeyPrefix

    // 🔄 验证结果缓存（100个条目，5分钟TTL）
    this._validationCache = new LRUCache(100)

    // 📊 缓存统计信息
    this._cacheStats = {
      hits: 0,
      misses: 0,
      errors: 0,
      invalidations: 0
    }

    // 📝 注册到缓存监控器进行统一管理
    cacheMonitor.registerCache('api-key-validation', this._validationCache)

    logger.info('🔄 ApiKeyService validation cache initialized (100 entries, 5min TTL)')
  }

  // 🔑 生成新的API Key
  async generateApiKey(options = {}) {
    const {
      name = 'Unnamed Key',
      description = '',
      tokenLimit = 0, // 默认为0，不再使用token限制
      expiresAt = null,
      claudeAccountId = null,
      claudeConsoleAccountId = null,
      geminiAccountId = null,
      permissions = 'all', // 'claude', 'gemini', 'all'
      isActive = true,
      concurrencyLimit = 0,
      rateLimitWindow = null,
      rateLimitRequests = null,
      rateLimitCost = null, // 新增：速率限制费用字段
      enableModelRestriction = false,
      restrictedModels = [],
      enableClientRestriction = false,
      allowedClients = [],
      dailyCostLimit = 0,
      weeklyOpusCostLimit = 0,
      tags = []
    } = options

    // 生成简单的API Key (64字符十六进制)
    const apiKey = `${this.prefix}${this._generateSecretKey()}`
    const keyId = uuidv4()
    const hashedKey = this._hashApiKey(apiKey)

    const keyData = {
      id: keyId,
      name,
      description,
      apiKey: hashedKey,
      tokenLimit: String(tokenLimit ?? 0),
      concurrencyLimit: String(concurrencyLimit ?? 0),
      rateLimitWindow: String(rateLimitWindow ?? 0),
      rateLimitRequests: String(rateLimitRequests ?? 0),
      rateLimitCost: String(rateLimitCost ?? 0), // 新增：速率限制费用字段
      isActive: String(isActive),
      claudeAccountId: claudeAccountId || '',
      claudeConsoleAccountId: claudeConsoleAccountId || '',
      geminiAccountId: geminiAccountId || '',
      permissions: permissions || 'all',
      enableModelRestriction: String(enableModelRestriction),
      restrictedModels: JSON.stringify(restrictedModels || []),
      enableClientRestriction: String(enableClientRestriction || false),
      allowedClients: JSON.stringify(allowedClients || []),
      dailyCostLimit: String(dailyCostLimit || 0),
      weeklyOpusCostLimit: String(weeklyOpusCostLimit || 0),
      tags: JSON.stringify(tags || []),
      createdAt: new Date().toISOString(),
      lastUsedAt: '',
      expiresAt: expiresAt || '',
      createdBy: 'admin' // 可以根据需要扩展用户系统
    }

    // 保存API Key数据并建立哈希映射
    await redis.setApiKey(keyId, keyData, hashedKey)

    logger.success(`🔑 Generated new API key: ${name} (${keyId})`)

    return {
      id: keyId,
      apiKey, // 只在创建时返回完整的key
      name: keyData.name,
      description: keyData.description,
      tokenLimit: parseInt(keyData.tokenLimit),
      concurrencyLimit: parseInt(keyData.concurrencyLimit),
      rateLimitWindow: parseInt(keyData.rateLimitWindow || 0),
      rateLimitRequests: parseInt(keyData.rateLimitRequests || 0),
      rateLimitCost: parseFloat(keyData.rateLimitCost || 0), // 新增：速率限制费用字段
      isActive: keyData.isActive === 'true',
      claudeAccountId: keyData.claudeAccountId,
      claudeConsoleAccountId: keyData.claudeConsoleAccountId,
      geminiAccountId: keyData.geminiAccountId,
      permissions: keyData.permissions,
      enableModelRestriction: keyData.enableModelRestriction === 'true',
      restrictedModels: JSON.parse(keyData.restrictedModels),
      enableClientRestriction: keyData.enableClientRestriction === 'true',
      allowedClients: JSON.parse(keyData.allowedClients || '[]'),
      dailyCostLimit: parseFloat(keyData.dailyCostLimit || 0),
      weeklyOpusCostLimit: parseFloat(keyData.weeklyOpusCostLimit || 0),
      tags: JSON.parse(keyData.tags || '[]'),
      createdAt: keyData.createdAt,
      expiresAt: keyData.expiresAt,
      createdBy: keyData.createdBy
    }
  }

  // 🔐 生成缓存键
  _generateValidationCacheKey(apiKey) {
    // 使用API Key的哈希值作为缓存键（安全且唯一）
    return this._hashApiKey(apiKey)
  }

  // 🗑️ 清除特定API Key的验证缓存
  _invalidateValidationCache(apiKey) {
    try {
      const cacheKey = this._generateValidationCacheKey(apiKey)

      // 尝试从缓存中删除
      if (this._validationCache.cache && this._validationCache.cache.has(cacheKey)) {
        this._validationCache.cache.delete(cacheKey)
        this._cacheStats.invalidations++
        logger.debug(`🗑️ Invalidated validation cache for API key: ${cacheKey.substring(0, 8)}...`)
        return true
      }

      return false
    } catch (error) {
      logger.warn('⚠️ Error invalidating validation cache:', error)
      return false
    }
  }

  // 🧹 清除所有验证缓存
  _clearAllValidationCache() {
    try {
      const beforeSize = this._validationCache.cache ? this._validationCache.cache.size : 0
      this._validationCache.clear()
      this._cacheStats.invalidations += beforeSize
      logger.info(`🧹 Cleared all validation cache (${beforeSize} entries)`)
    } catch (error) {
      logger.warn('⚠️ Error clearing validation cache:', error)
    }
  }

  // 📊 获取缓存统计
  getValidationCacheStats() {
    const lruStats = this._validationCache.getStats()
    return {
      ...this._cacheStats,
      size: lruStats.size,
      maxSize: lruStats.maxSize,
      hitRate: lruStats.hitRate
    }
  }

  // 🔍 验证API Key（带缓存优化）
  async validateApiKey(apiKey) {
    const startTime = Date.now()

    try {
      // 基本格式检查
      if (
        !apiKey ||
        typeof apiKey !== 'string' ||
        !apiKey.startsWith(this.prefix) ||
        apiKey.length < 67
      ) {
        return { valid: false, error: 'Invalid API key format' }
      }

      // 🔄 尝试从缓存获取验证结果
      const cacheKey = this._generateValidationCacheKey(apiKey)
      let cached = null
      try {
        cached = this._validationCache.get(cacheKey)
      } catch (cacheError) {
        logger.warn('⚠️ Cache get operation failed, falling back to normal validation:', cacheError)
        // 继续执行正常验证，不抛出异常
      }

      if (cached) {
        this._cacheStats.hits++
        const cacheTime = Date.now() - startTime
        logger.debug(`🎯 Cache hit for API key validation (${cacheTime}ms)`)
        return cached
      }

      // 🔄 缓存未命中，执行完整验证
      this._cacheStats.misses++
      const result = await this._performFullValidation(apiKey, startTime)

      // 🔄 只缓存有效的验证结果
      if (result.valid) {
        try {
          this._validationCache.set(cacheKey, result, 5 * 60 * 1000) // 5分钟TTL
        } catch (cacheError) {
          logger.warn('⚠️ Cache set operation failed:', cacheError)
          // 继续执行，不影响验证结果
        }
      }

      return result
    } catch (error) {
      this._cacheStats.errors++
      logger.error('❌ API key validation error:', error)
      return { valid: false, error: 'Internal validation error' }
    }
  }

  // 🔍 执行完整的API Key验证（内部方法）
  async _performFullValidation(apiKey, startTime) {
    // 计算API Key的哈希值
    const hashedKey = this._hashApiKey(apiKey)

    // 通过哈希值直接查找API Key（性能优化）
    const keyData = await redis.findApiKeyByHash(hashedKey)

    if (!keyData) {
      return { valid: false, error: 'API key not found' }
    }

    // 检查是否激活
    if (keyData.isActive !== 'true') {
      return { valid: false, error: 'API key is disabled' }
    }

    // 检查是否过期
    if (keyData.expiresAt && new Date() > new Date(keyData.expiresAt)) {
      return { valid: false, error: 'API key has expired' }
    }

    // 获取使用统计（供返回数据使用）
    const usage = await redis.getUsageStats(keyData.id)

    // 获取当日费用统计
    const dailyCost = await redis.getDailyCost(keyData.id)

    // 更新最后使用时间（优化：只在实际API调用时更新，而不是验证时）
    // 注意：lastUsedAt的更新已移至recordUsage方法中

    const validationTime = Date.now() - startTime
    logger.debug(`🔓 API key validated successfully: ${keyData.id} (${validationTime}ms)`)

    // 解析限制模型数据
    let restrictedModels = []
    try {
      restrictedModels = keyData.restrictedModels ? JSON.parse(keyData.restrictedModels) : []
    } catch (e) {
      restrictedModels = []
    }

    // 解析允许的客户端
    let allowedClients = []
    try {
      allowedClients = keyData.allowedClients ? JSON.parse(keyData.allowedClients) : []
    } catch (e) {
      allowedClients = []
    }

    // 解析标签
    let tags = []
    try {
      tags = keyData.tags ? JSON.parse(keyData.tags) : []
    } catch (e) {
      tags = []
    }

    return {
      valid: true,
      keyData: {
        id: keyData.id,
        name: keyData.name || '',
        description: keyData.description || '',
        createdAt: keyData.createdAt || '',
        expiresAt: keyData.expiresAt || '',
        claudeAccountId: keyData.claudeAccountId || '',
        claudeConsoleAccountId: keyData.claudeConsoleAccountId || '',
        geminiAccountId: keyData.geminiAccountId || '',
        permissions: keyData.permissions || 'all',
        tokenLimit: parseInt(keyData.tokenLimit || 0),
        concurrencyLimit: parseInt(keyData.concurrencyLimit || 0),
        rateLimitWindow: parseInt(keyData.rateLimitWindow || 0),
        rateLimitRequests: parseInt(keyData.rateLimitRequests || 0),
        rateLimitCost: parseFloat(keyData.rateLimitCost || 0), // 新增：速率限制费用字段
        enableModelRestriction: keyData.enableModelRestriction === 'true',
        restrictedModels,
        enableClientRestriction: keyData.enableClientRestriction === 'true',
        allowedClients,
        dailyCostLimit: parseFloat(keyData.dailyCostLimit || 0),
        weeklyOpusCostLimit: parseFloat(keyData.weeklyOpusCostLimit || 0),
        dailyCost: dailyCost || 0,
        weeklyOpusCost: (await redis.getWeeklyOpusCost(keyData.id)) || 0,
        tags,
        usage
      }
    }
  }

  // 📋 获取所有API Keys
  async getAllApiKeys() {
    try {
      const apiKeys = await redis.getAllApiKeys()
      const client = redis.getClientSafe()

      // 为每个key添加使用统计和当前并发数
      for (const key of apiKeys) {
        key.usage = await redis.getUsageStats(key.id)
        key.tokenLimit = parseInt(key.tokenLimit)
        key.concurrencyLimit = parseInt(key.concurrencyLimit || 0)
        key.rateLimitWindow = parseInt(key.rateLimitWindow || 0)
        key.rateLimitRequests = parseInt(key.rateLimitRequests || 0)
        key.rateLimitCost = parseFloat(key.rateLimitCost || 0) // 新增：速率限制费用字段
        key.currentConcurrency = await redis.getConcurrency(key.id)
        key.isActive = key.isActive === 'true'
        key.enableModelRestriction = key.enableModelRestriction === 'true'
        key.enableClientRestriction = key.enableClientRestriction === 'true'
        key.permissions = key.permissions || 'all' // 兼容旧数据
        key.dailyCostLimit = parseFloat(key.dailyCostLimit || 0)
        key.weeklyOpusCostLimit = parseFloat(key.weeklyOpusCostLimit || 0)
        key.dailyCost = (await redis.getDailyCost(key.id)) || 0
        key.weeklyOpusCost = (await redis.getWeeklyOpusCost(key.id)) || 0

        // 获取当前时间窗口的请求次数、Token使用量和费用
        if (key.rateLimitWindow > 0) {
          const requestCountKey = `rate_limit:requests:${key.id}`
          const tokenCountKey = `rate_limit:tokens:${key.id}`
          const costCountKey = `rate_limit:cost:${key.id}` // 新增：费用计数器
          const windowStartKey = `rate_limit:window_start:${key.id}`

          key.currentWindowRequests = parseInt((await client.get(requestCountKey)) || '0')
          key.currentWindowTokens = parseInt((await client.get(tokenCountKey)) || '0')
          key.currentWindowCost = parseFloat((await client.get(costCountKey)) || '0') // 新增：当前窗口费用

          // 获取窗口开始时间和计算剩余时间
          const windowStart = await client.get(windowStartKey)
          if (windowStart) {
            const now = Date.now()
            const windowStartTime = parseInt(windowStart)
            const windowDuration = key.rateLimitWindow * 60 * 1000 // 转换为毫秒
            const windowEndTime = windowStartTime + windowDuration

            // 如果窗口还有效
            if (now < windowEndTime) {
              key.windowStartTime = windowStartTime
              key.windowEndTime = windowEndTime
              key.windowRemainingSeconds = Math.max(0, Math.floor((windowEndTime - now) / 1000))
            } else {
              // 窗口已过期，下次请求会重置
              key.windowStartTime = null
              key.windowEndTime = null
              key.windowRemainingSeconds = 0
              // 重置计数为0，因为窗口已过期
              key.currentWindowRequests = 0
              key.currentWindowTokens = 0
              key.currentWindowCost = 0 // 新增：重置费用
            }
          } else {
            // 窗口还未开始（没有任何请求）
            key.windowStartTime = null
            key.windowEndTime = null
            key.windowRemainingSeconds = null
          }
        } else {
          key.currentWindowRequests = 0
          key.currentWindowTokens = 0
          key.currentWindowCost = 0 // 新增：重置费用
          key.windowStartTime = null
          key.windowEndTime = null
          key.windowRemainingSeconds = null
        }

        try {
          key.restrictedModels = key.restrictedModels ? JSON.parse(key.restrictedModels) : []
        } catch (e) {
          key.restrictedModels = []
        }
        try {
          key.allowedClients = key.allowedClients ? JSON.parse(key.allowedClients) : []
        } catch (e) {
          key.allowedClients = []
        }
        try {
          key.tags = key.tags ? JSON.parse(key.tags) : []
        } catch (e) {
          key.tags = []
        }
        delete key.apiKey // 不返回哈希后的key
      }

      return apiKeys
    } catch (error) {
      logger.error('❌ Failed to get API keys:', error)
      throw error
    }
  }

  // 📝 更新API Key
  async updateApiKey(keyId, updates) {
    try {
      const keyData = await redis.getApiKey(keyId)
      if (!keyData || Object.keys(keyData).length === 0) {
        throw new Error('API key not found')
      }

      // 允许更新的字段
      const allowedUpdates = [
        'name',
        'description',
        'tokenLimit',
        'concurrencyLimit',
        'rateLimitWindow',
        'rateLimitRequests',
        'rateLimitCost', // 新增：速率限制费用字段
        'isActive',
        'claudeAccountId',
        'claudeConsoleAccountId',
        'geminiAccountId',
        'permissions',
        'expiresAt',
        'enableModelRestriction',
        'restrictedModels',
        'enableClientRestriction',
        'allowedClients',
        'dailyCostLimit',
        'weeklyOpusCostLimit',
        'tags'
      ]
      const updatedData = { ...keyData }

      for (const [field, value] of Object.entries(updates)) {
        if (allowedUpdates.includes(field)) {
          if (field === 'restrictedModels' || field === 'allowedClients' || field === 'tags') {
            // 特殊处理数组字段
            updatedData[field] = JSON.stringify(value || [])
          } else if (field === 'enableModelRestriction' || field === 'enableClientRestriction') {
            // 布尔值转字符串
            updatedData[field] = String(value)
          } else {
            updatedData[field] = (value !== null && value !== undefined ? value : '').toString()
          }
        }
      }

      updatedData.updatedAt = new Date().toISOString()

      // 更新时不需要重新建立哈希映射，因为API Key本身没有变化
      await redis.setApiKey(keyId, updatedData)

      // 🔄 清除相关的验证缓存
      // 注意：由于我们没有原始API Key，我们清除所有缓存以确保一致性
      // 在真实环境中可以考虑存储keyId到apiKey的映射以实现精确清除
      this._clearAllValidationCache()

      logger.success(`📝 Updated API key: ${keyId}`)

      return { success: true }
    } catch (error) {
      logger.error('❌ Failed to update API key:', error)
      throw error
    }
  }

  // 🗑️ 删除API Key
  async deleteApiKey(keyId) {
    try {
      const result = await redis.deleteApiKey(keyId)

      if (result === 0) {
        throw new Error('API key not found')
      }

      // 🔄 清除相关的验证缓存
      // 注意：由于我们没有原始API Key，我们清除所有缓存以确保一致性
      this._clearAllValidationCache()

      logger.success(`🗑️ Deleted API key: ${keyId}`)

      return { success: true }
    } catch (error) {
      logger.error('❌ Failed to delete API key:', error)
      throw error
    }
  }

  // 📊 记录使用情况（支持缓存token和账户级别统计）
  async recordUsage(
    keyId,
    inputTokens = 0,
    outputTokens = 0,
    cacheCreateTokens = 0,
    cacheReadTokens = 0,
    model = 'unknown',
    accountId = null
  ) {
    try {
      const totalTokens = inputTokens + outputTokens + cacheCreateTokens + cacheReadTokens

      // 计算费用
      const CostCalculator = require('../utils/costCalculator')
      const costInfo = CostCalculator.calculateCost(
        {
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          cache_creation_input_tokens: cacheCreateTokens,
          cache_read_input_tokens: cacheReadTokens
        },
        model
      )

      // 检查是否为 1M 上下文请求
      let isLongContextRequest = false
      if (model && model.includes('[1m]')) {
        const totalInputTokens = inputTokens + cacheCreateTokens + cacheReadTokens
        isLongContextRequest = totalInputTokens > 200000
      }

      // 记录API Key级别的使用统计
      await redis.incrementTokenUsage(
        keyId,
        totalTokens,
        inputTokens,
        outputTokens,
        cacheCreateTokens,
        cacheReadTokens,
        model,
        0, // ephemeral5mTokens - 暂时为0，后续处理
        0, // ephemeral1hTokens - 暂时为0，后续处理
        isLongContextRequest
      )

      // 记录费用统计
      if (costInfo.costs.total > 0) {
        await redis.incrementDailyCost(keyId, costInfo.costs.total)
        logger.database(
          `💰 Recorded cost for ${keyId}: $${costInfo.costs.total.toFixed(6)}, model: ${model}`
        )
      } else {
        logger.debug(`💰 No cost recorded for ${keyId} - zero cost for model: ${model}`)
      }

      // 获取API Key数据以确定关联的账户
      const keyData = await redis.getApiKey(keyId)
      if (keyData && Object.keys(keyData).length > 0) {
        // 更新最后使用时间
        keyData.lastUsedAt = new Date().toISOString()
        await redis.setApiKey(keyId, keyData)

        // 记录账户级别的使用统计（只统计实际处理请求的账户）
        if (accountId) {
          await redis.incrementAccountUsage(
            accountId,
            totalTokens,
            inputTokens,
            outputTokens,
            cacheCreateTokens,
            cacheReadTokens,
            model,
            isLongContextRequest
          )
          logger.database(
            `📊 Recorded account usage: ${accountId} - ${totalTokens} tokens (API Key: ${keyId})`
          )
        } else {
          logger.debug(
            '⚠️ No accountId provided for usage recording, skipping account-level statistics'
          )
        }
      }

      const logParts = [`Model: ${model}`, `Input: ${inputTokens}`, `Output: ${outputTokens}`]
      if (cacheCreateTokens > 0) {
        logParts.push(`Cache Create: ${cacheCreateTokens}`)
      }
      if (cacheReadTokens > 0) {
        logParts.push(`Cache Read: ${cacheReadTokens}`)
      }
      logParts.push(`Total: ${totalTokens} tokens`)

      logger.database(`📊 Recorded usage: ${keyId} - ${logParts.join(', ')}`)
    } catch (error) {
      logger.error('❌ Failed to record usage:', error)
    }
  }

  // 📊 记录 Opus 模型费用（仅限 claude 和 claude-console 账户）
  async recordOpusCost(keyId, cost, model, accountType) {
    try {
      // 判断是否为 Opus 模型
      if (!model || !model.toLowerCase().includes('claude-opus')) {
        return // 不是 Opus 模型，直接返回
      }

      // 判断是否为 claude 或 claude-console 账户
      if (!accountType || (accountType !== 'claude' && accountType !== 'claude-console')) {
        logger.debug(`⚠️ Skipping Opus cost recording for non-Claude account type: ${accountType}`)
        return // 不是 claude 账户，直接返回
      }

      // 记录 Opus 周费用
      await redis.incrementWeeklyOpusCost(keyId, cost)
      logger.database(
        `💰 Recorded Opus weekly cost for ${keyId}: $${cost.toFixed(6)}, model: ${model}, account type: ${accountType}`
      )
    } catch (error) {
      logger.error('❌ Failed to record Opus cost:', error)
    }
  }

  // 📊 记录使用情况（新版本，支持详细的缓存类型）
  async recordUsageWithDetails(
    keyId,
    usageObject,
    model = 'unknown',
    accountId = null,
    accountType = null
  ) {
    try {
      // 提取 token 数量
      const inputTokens = usageObject.input_tokens || 0
      const outputTokens = usageObject.output_tokens || 0
      const cacheCreateTokens = usageObject.cache_creation_input_tokens || 0
      const cacheReadTokens = usageObject.cache_read_input_tokens || 0

      const totalTokens = inputTokens + outputTokens + cacheCreateTokens + cacheReadTokens

      // 计算费用（支持详细的缓存类型）- 添加错误处理
      let costInfo = { totalCost: 0, ephemeral5mCost: 0, ephemeral1hCost: 0 }
      try {
        const pricingService = require('./pricingService')
        // 确保 pricingService 已初始化
        if (!pricingService.pricingData) {
          logger.warn('⚠️ PricingService not initialized, initializing now...')
          await pricingService.initialize()
        }
        costInfo = pricingService.calculateCost(usageObject, model)
      } catch (pricingError) {
        logger.error('❌ Failed to calculate cost:', pricingError)
        // 继续执行，不要因为费用计算失败而跳过统计记录
      }

      // 提取详细的缓存创建数据
      let ephemeral5mTokens = 0
      let ephemeral1hTokens = 0

      if (usageObject.cache_creation && typeof usageObject.cache_creation === 'object') {
        ephemeral5mTokens = usageObject.cache_creation.ephemeral_5m_input_tokens || 0
        ephemeral1hTokens = usageObject.cache_creation.ephemeral_1h_input_tokens || 0
      }

      // 记录API Key级别的使用统计 - 这个必须执行
      await redis.incrementTokenUsage(
        keyId,
        totalTokens,
        inputTokens,
        outputTokens,
        cacheCreateTokens,
        cacheReadTokens,
        model,
        ephemeral5mTokens, // 传递5分钟缓存 tokens
        ephemeral1hTokens, // 传递1小时缓存 tokens
        costInfo.isLongContextRequest || false // 传递 1M 上下文请求标记
      )

      // 记录费用统计
      if (costInfo.totalCost > 0) {
        await redis.incrementDailyCost(keyId, costInfo.totalCost)
        logger.database(
          `💰 Recorded cost for ${keyId}: $${costInfo.totalCost.toFixed(6)}, model: ${model}`
        )

        // 记录 Opus 周费用（如果适用）
        await this.recordOpusCost(keyId, costInfo.totalCost, model, accountType)

        // 记录详细的缓存费用（如果有）
        if (costInfo.ephemeral5mCost > 0 || costInfo.ephemeral1hCost > 0) {
          logger.database(
            `💰 Cache costs - 5m: $${costInfo.ephemeral5mCost.toFixed(6)}, 1h: $${costInfo.ephemeral1hCost.toFixed(6)}`
          )
        }
      } else {
        logger.debug(`💰 No cost recorded for ${keyId} - zero cost for model: ${model}`)
      }

      // 获取API Key数据以确定关联的账户
      const keyData = await redis.getApiKey(keyId)
      if (keyData && Object.keys(keyData).length > 0) {
        // 更新最后使用时间
        keyData.lastUsedAt = new Date().toISOString()
        await redis.setApiKey(keyId, keyData)

        // 记录账户级别的使用统计（只统计实际处理请求的账户）
        if (accountId) {
          await redis.incrementAccountUsage(
            accountId,
            totalTokens,
            inputTokens,
            outputTokens,
            cacheCreateTokens,
            cacheReadTokens,
            model,
            costInfo.isLongContextRequest || false
          )
          logger.database(
            `📊 Recorded account usage: ${accountId} - ${totalTokens} tokens (API Key: ${keyId})`
          )
        } else {
          logger.debug(
            '⚠️ No accountId provided for usage recording, skipping account-level statistics'
          )
        }
      }

      const logParts = [`Model: ${model}`, `Input: ${inputTokens}`, `Output: ${outputTokens}`]
      if (cacheCreateTokens > 0) {
        logParts.push(`Cache Create: ${cacheCreateTokens}`)

        // 如果有详细的缓存创建数据，也记录它们
        if (usageObject.cache_creation) {
          const { ephemeral_5m_input_tokens, ephemeral_1h_input_tokens } =
            usageObject.cache_creation
          if (ephemeral_5m_input_tokens > 0) {
            logParts.push(`5m: ${ephemeral_5m_input_tokens}`)
          }
          if (ephemeral_1h_input_tokens > 0) {
            logParts.push(`1h: ${ephemeral_1h_input_tokens}`)
          }
        }
      }
      if (cacheReadTokens > 0) {
        logParts.push(`Cache Read: ${cacheReadTokens}`)
      }
      logParts.push(`Total: ${totalTokens} tokens`)

      logger.database(`📊 Recorded usage: ${keyId} - ${logParts.join(', ')}`)
    } catch (error) {
      logger.error('❌ Failed to record usage:', error)
    }
  }

  // 🔐 生成密钥
  _generateSecretKey() {
    return crypto.randomBytes(32).toString('hex')
  }

  // 🔒 哈希API Key
  _hashApiKey(apiKey) {
    return crypto
      .createHash('sha256')
      .update(apiKey + config.security.apiKeySalt)
      .digest('hex')
  }

  // 📈 获取使用统计
  async getUsageStats(keyId) {
    return await redis.getUsageStats(keyId)
  }

  // 📊 获取账户使用统计
  async getAccountUsageStats(accountId) {
    return await redis.getAccountUsageStats(accountId)
  }

  // 📈 获取所有账户使用统计
  async getAllAccountsUsageStats() {
    return await redis.getAllAccountsUsageStats()
  }

  // 🧹 清理过期的API Keys
  async cleanupExpiredKeys() {
    try {
      const apiKeys = await redis.getAllApiKeys()
      const now = new Date()
      let cleanedCount = 0

      for (const key of apiKeys) {
        // 检查是否已过期且仍处于激活状态
        if (key.expiresAt && new Date(key.expiresAt) < now && key.isActive === 'true') {
          // 将过期的 API Key 标记为禁用状态，而不是直接删除
          await this.updateApiKey(key.id, { isActive: false })
          logger.info(`🔒 API Key ${key.id} (${key.name}) has expired and been disabled`)
          cleanedCount++
        }
      }

      if (cleanedCount > 0) {
        logger.success(`🧹 Disabled ${cleanedCount} expired API keys`)
      }

      return cleanedCount
    } catch (error) {
      logger.error('❌ Failed to cleanup expired keys:', error)
      return 0
    }
  }
}

// 导出实例和单独的方法
const apiKeyService = new ApiKeyService()

// 为了方便其他服务调用，导出 recordUsage 方法
apiKeyService.recordUsageMetrics = apiKeyService.recordUsage.bind(apiKeyService)

// 导出实例（默认导出）和类（用于测试）
module.exports = apiKeyService
module.exports.ApiKeyService = ApiKeyService
