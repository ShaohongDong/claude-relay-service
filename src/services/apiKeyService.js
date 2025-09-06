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

  // 🔑 生成新的API Key（精简版）
  async generateApiKey(options = {}) {
    const {
      name = 'Unnamed Key',
      description = '',
      expiresAt = null,
      claudeAccountId = null,
      claudeConsoleAccountId = null,
      geminiAccountId = null,
      isActive = true
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
      isActive: String(isActive),
      claudeAccountId: claudeAccountId || '',
      claudeConsoleAccountId: claudeConsoleAccountId || '',
      geminiAccountId: geminiAccountId || '',
      createdAt: new Date().toISOString(),
      lastUsedAt: '',
      expiresAt: expiresAt || '',
      createdBy: 'admin'
    }

    // 保存API Key数据并建立哈希映射
    await redis.setApiKey(keyId, keyData, hashedKey)

    logger.success(`🔑 Generated new API key: ${name} (${keyId})`)

    return {
      id: keyId,
      apiKey, // 只在创建时返回完整的key
      name: keyData.name,
      description: keyData.description,
      isActive: keyData.isActive === 'true',
      claudeAccountId: keyData.claudeAccountId,
      claudeConsoleAccountId: keyData.claudeConsoleAccountId,
      geminiAccountId: keyData.geminiAccountId,
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

  // 🔍 执行完整的API Key验证（精简版）
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

    const validationTime = Date.now() - startTime
    logger.debug(`🔓 API key validated successfully: ${keyData.id} (${validationTime}ms)`)

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
        isActive: keyData.isActive === 'true'
      }
    }
  }

  // 📋 获取所有API Keys（精简版）
  async getAllApiKeys() {
    try {
      const apiKeys = await redis.getAllApiKeys()

      // 精简处理每个key的数据
      for (const key of apiKeys) {
        key.isActive = key.isActive === 'true'
        delete key.apiKey // 不返回哈希后的key
      }

      return apiKeys
    } catch (error) {
      logger.error('❌ Failed to get API keys:', error)
      throw error
    }
  }

  // 📝 更新API Key（精简版）
  async updateApiKey(keyId, updates) {
    try {
      const keyData = await redis.getApiKey(keyId)
      if (!keyData || Object.keys(keyData).length === 0) {
        throw new Error('API key not found')
      }

      // 允许更新的字段（只保留基础字段）
      const allowedUpdates = [
        'name',
        'description',
        'isActive',
        'claudeAccountId',
        'claudeConsoleAccountId',
        'geminiAccountId',
        'expiresAt'
      ]
      const updatedData = { ...keyData }

      for (const [field, value] of Object.entries(updates)) {
        if (allowedUpdates.includes(field)) {
          updatedData[field] = (value !== null && value !== undefined ? value : '').toString()
        }
      }

      updatedData.updatedAt = new Date().toISOString()

      // 更新时不需要重新建立哈希映射，因为API Key本身没有变化
      await redis.setApiKey(keyId, updatedData)

      // 🔄 清除相关的验证缓存
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

  // 📝 更新最后使用时间（精简版）
  async updateLastUsedTime(keyId) {
    try {
      const keyData = await redis.getApiKey(keyId)
      if (keyData && Object.keys(keyData).length > 0) {
        keyData.lastUsedAt = new Date().toISOString()
        await redis.setApiKey(keyId, keyData)
      }
    } catch (error) {
      logger.error('❌ Failed to update last used time:', error)
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

// 导出实例（精简版）
const apiKeyService = new ApiKeyService()

// 导出实例（默认导出）和类（用于测试）
module.exports = apiKeyService
module.exports.ApiKeyService = ApiKeyService
