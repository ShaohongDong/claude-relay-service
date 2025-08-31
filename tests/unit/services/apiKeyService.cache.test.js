/**
 * ApiKeyService 缓存功能单元测试
 * 测试验证结果缓存的所有功能和边界情况
 */

const crypto = require('crypto')
const { ApiKeyService } = require('../../../src/services/apiKeyService')
const redis = require('../../../src/models/redis')
const LRUCache = require('../../../src/utils/lruCache')
const cacheMonitor = require('../../../src/utils/cacheMonitor')
const logger = require('../../../src/utils/logger')

// Mock所有外部依赖
jest.mock('../../../src/models/redis')
jest.mock('../../../src/utils/logger')
jest.mock('../../../src/utils/cacheMonitor')

describe('ApiKeyService 缓存功能测试', () => {
  let apiKeyService
  let mockRedis
  
  // 测试数据
  const testApiKey = 'cr_1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef'
  const testKeyId = 'test-key-id-123'
  const testHashedKey = crypto.createHash('sha256').update(testApiKey + 'test-encryption-key-1234567890123456').digest('hex')
  
  const mockKeyData = {
    id: testKeyId,
    name: 'Test Key',
    description: 'Test API Key',
    isActive: 'true',
    expiresAt: '',
    claudeAccountId: '',
    claudeConsoleAccountId: '',
    geminiAccountId: '',
    openaiAccountId: '',
    azureOpenaiAccountId: '',
    bedrockAccountId: '',
    permissions: 'all',
    tokenLimit: '1000000',
    concurrencyLimit: '0',
    rateLimitWindow: '0',
    rateLimitRequests: '0',
    enableModelRestriction: 'false',
    restrictedModels: '[]',
    enableClientRestriction: 'false',
    allowedClients: '[]',
    dailyCostLimit: '0',
    tags: '[]',
    createdAt: new Date().toISOString(),
    lastUsedAt: ''
  }

  beforeEach(() => {
    // 重置所有 mock
    jest.clearAllMocks()
    
    // Mock config before creating service
    process.env.API_KEY_PREFIX = 'cr_'
    process.env.ENCRYPTION_KEY = 'test-encryption-key-1234567890123456'
    
    // Mock cacheMonitor.registerCache before creating service
    cacheMonitor.registerCache = jest.fn()
    
    // Mock logger methods before creating service
    logger.info = jest.fn()
    logger.debug = jest.fn()
    logger.warn = jest.fn()
    logger.error = jest.fn()
    
    // 创建新的 ApiKeyService 实例（在mock设置后）
    apiKeyService = new ApiKeyService()
    
    // 模拟 redis 方法
    mockRedis = {
      findApiKeyByHash: jest.fn(),
      getUsageStats: jest.fn(),
      getDailyCost: jest.fn()
    }
    
    // 设置默认 mock 返回值
    redis.findApiKeyByHash = mockRedis.findApiKeyByHash
    redis.getUsageStats = mockRedis.getUsageStats.mockResolvedValue({})
    redis.getDailyCost = mockRedis.getDailyCost.mockResolvedValue(0)
  })

  describe('缓存初始化', () => {
    test('应该正确初始化验证缓存', () => {
      expect(apiKeyService._validationCache).toBeDefined()
      expect(apiKeyService._validationCache).toBeInstanceOf(LRUCache)
      expect(apiKeyService._cacheStats).toEqual({
        hits: 0,
        misses: 0,
        errors: 0,
        invalidations: 0
      })
    })

    test('应该注册缓存到监控器', () => {
      expect(cacheMonitor.registerCache).toHaveBeenCalledWith(
        'api-key-validation',
        apiKeyService._validationCache
      )
    })
  })

  describe('缓存键生成', () => {
    test('应该生成正确的缓存键', () => {
      const cacheKey = apiKeyService._generateValidationCacheKey(testApiKey)
      expect(cacheKey).toBe(testHashedKey)
    })

    test('不同的API Key应该生成不同的缓存键', () => {
      const apiKey1 = 'cr_key1'
      const apiKey2 = 'cr_key2'
      
      const cacheKey1 = apiKeyService._generateValidationCacheKey(apiKey1)
      const cacheKey2 = apiKeyService._generateValidationCacheKey(apiKey2)
      
      expect(cacheKey1).not.toBe(cacheKey2)
    })

    test('相同的API Key应该生成相同的缓存键', () => {
      const cacheKey1 = apiKeyService._generateValidationCacheKey(testApiKey)
      const cacheKey2 = apiKeyService._generateValidationCacheKey(testApiKey)
      
      expect(cacheKey1).toBe(cacheKey2)
    })
  })


  describe('缓存失效操作', () => {
    test('应该能清除特定API Key的缓存', () => {
      // 先设置缓存
      const cacheKey = testHashedKey
      const cacheData = { valid: true, keyData: mockKeyData }
      apiKeyService._validationCache.set(cacheKey, cacheData)
      
      // 验证缓存存在
      expect(apiKeyService._validationCache.get(cacheKey)).toBeTruthy()
      
      // 清除缓存
      const result = apiKeyService._invalidateValidationCache(testApiKey)
      
      expect(result).toBe(true)
      expect(apiKeyService._cacheStats.invalidations).toBe(1)
      expect(apiKeyService._validationCache.get(cacheKey)).toBeUndefined()
    })

    test('清除不存在的缓存应该返回false', () => {
      const result = apiKeyService._invalidateValidationCache('nonexistent-key')
      expect(result).toBe(false)
    })

    test('应该能清除所有验证缓存', () => {
      // 设置多个缓存项
      apiKeyService._validationCache.set('key1', { data: 'test1' })
      apiKeyService._validationCache.set('key2', { data: 'test2' })
      
      expect(apiKeyService._validationCache.cache.size).toBe(2)
      
      // 清除所有缓存
      apiKeyService._clearAllValidationCache()
      
      expect(apiKeyService._validationCache.cache.size).toBe(0)
      expect(apiKeyService._cacheStats.invalidations).toBe(2)
    })
  })

  describe('缓存统计', () => {
    test('应该返回正确的缓存统计信息', () => {
      // 修改统计数据
      apiKeyService._cacheStats.hits = 10
      apiKeyService._cacheStats.misses = 5
      apiKeyService._cacheStats.errors = 1
      apiKeyService._cacheStats.invalidations = 2
      
      const stats = apiKeyService.getValidationCacheStats()
      
      expect(stats).toEqual({
        hits: 10,
        misses: 5,
        errors: 1,
        invalidations: 2,
        size: 0,
        maxSize: 100,
        hitRate: expect.any(String)
      })
    })
  })

  describe('validateApiKey 缓存行为', () => {
    beforeEach(() => {
      // 设置 redis mock 返回有效数据
      mockRedis.findApiKeyByHash.mockResolvedValue(mockKeyData)
    })

    test('首次验证应该缓存未命中并存储结果', async () => {
      const result = await apiKeyService.validateApiKey(testApiKey)
      
      expect(result.valid).toBe(true)
      expect(apiKeyService._cacheStats.misses).toBe(1)
      expect(apiKeyService._cacheStats.hits).toBe(0)
      expect(mockRedis.findApiKeyByHash).toHaveBeenCalledTimes(1)
      
      // 验证结果已被缓存
      const cacheKey = apiKeyService._generateValidationCacheKey(testApiKey)
      const cachedData = apiKeyService._validationCache.get(cacheKey)
      expect(cachedData).toBeTruthy()
      expect(cachedData.valid).toBe(true)
    })

    test('第二次验证相同API Key应该缓存命中', async () => {
      // 第一次验证
      await apiKeyService.validateApiKey(testApiKey)
      
      // 第二次验证
      const result = await apiKeyService.validateApiKey(testApiKey)
      
      expect(result.valid).toBe(true)
      expect(apiKeyService._cacheStats.hits).toBe(1)
      expect(apiKeyService._cacheStats.misses).toBe(1)
      expect(mockRedis.findApiKeyByHash).toHaveBeenCalledTimes(1) // 只调用一次
    })

    test('无效的API Key不应该被缓存', async () => {
      // 设置 redis 返回不存在
      mockRedis.findApiKeyByHash.mockResolvedValue(null)
      
      const result = await apiKeyService.validateApiKey(testApiKey)
      
      expect(result.valid).toBe(false)
      expect(result.error).toBe('API key not found')
      
      // 验证没有缓存无效结果
      const cacheKey = apiKeyService._generateValidationCacheKey(testApiKey)
      const cachedData = apiKeyService._validationCache.get(cacheKey)
      expect(cachedData).toBeUndefined()
    })

    test('禁用的API Key不应该被缓存', async () => {
      // 设置 API Key 为禁用状态
      const disabledKeyData = { ...mockKeyData, isActive: 'false' }
      mockRedis.findApiKeyByHash.mockResolvedValue(disabledKeyData)
      
      const result = await apiKeyService.validateApiKey(testApiKey)
      
      expect(result.valid).toBe(false)
      expect(result.error).toBe('API key is disabled')
      
      // 验证没有缓存无效结果
      const cacheKey = apiKeyService._generateValidationCacheKey(testApiKey)
      const cachedData = apiKeyService._validationCache.get(cacheKey)
      expect(cachedData).toBeUndefined()
    })

    test('过期的API Key不应该被缓存', async () => {
      // 设置 API Key 为过期状态
      const expiredKeyData = {
        ...mockKeyData,
        expiresAt: new Date(Date.now() - 1000).toISOString() // 1秒前过期
      }
      mockRedis.findApiKeyByHash.mockResolvedValue(expiredKeyData)
      
      const result = await apiKeyService.validateApiKey(testApiKey)
      
      expect(result.valid).toBe(false)
      expect(result.error).toBe('API key has expired')
      
      // 验证没有缓存无效结果
      const cacheKey = apiKeyService._generateValidationCacheKey(testApiKey)
      const cachedData = apiKeyService._validationCache.get(cacheKey)
      expect(cachedData).toBeUndefined()
    })

    test('缓存过期后应该重新验证', async () => {
      // 第一次验证
      await apiKeyService.validateApiKey(testApiKey)
      expect(apiKeyService._cacheStats.misses).toBe(1)
      
      // 清除缓存模拟过期
      const cacheKey = apiKeyService._generateValidationCacheKey(testApiKey)
      apiKeyService._validationCache.cache.delete(cacheKey)
      
      // 再次验证
      const result = await apiKeyService.validateApiKey(testApiKey)
      
      expect(result.valid).toBe(true)
      expect(apiKeyService._cacheStats.misses).toBe(2) // 又一次miss
      expect(mockRedis.findApiKeyByHash).toHaveBeenCalledTimes(2) // 调用了两次
    })

    test('验证异常应该增加错误计数', async () => {
      // 设置 redis 抛出异常
      mockRedis.findApiKeyByHash.mockRejectedValue(new Error('Redis error'))
      
      const result = await apiKeyService.validateApiKey(testApiKey)
      
      expect(result.valid).toBe(false)
      expect(result.error).toBe('Internal validation error')
      expect(apiKeyService._cacheStats.errors).toBe(1)
    })

    test('格式错误的API Key应该直接返回错误不查询缓存', async () => {
      const result = await apiKeyService.validateApiKey('invalid-format')
      
      expect(result.valid).toBe(false)
      expect(result.error).toBe('Invalid API key format')
      expect(mockRedis.findApiKeyByHash).not.toHaveBeenCalled()
      expect(apiKeyService._cacheStats.misses).toBe(0)
      expect(apiKeyService._cacheStats.hits).toBe(0)
    })
  })


  describe('缓存容量管理', () => {
    test('缓存应该有正确的最大容量', () => {
      expect(apiKeyService._validationCache.maxSize).toBe(100)
    })

    test('超过容量时应该使用LRU策略淘汰', async () => {
      mockRedis.findApiKeyByHash.mockResolvedValue(mockKeyData)
      
      // 创建101个不同的API Key进行验证（超过100的容量）
      const promises = []
      for (let i = 0; i < 101; i++) {
        const apiKey = `cr_${'0'.repeat(60)}${i.toString().padStart(4, '0')}`
        promises.push(apiKeyService.validateApiKey(apiKey))
      }
      
      await Promise.all(promises)
      
      // 验证缓存大小不超过最大值
      expect(apiKeyService._validationCache.cache.size).toBeLessThanOrEqual(100)
    })
  })

  describe('边界情况和错误处理', () => {
    test('缓存操作异常应该被正确处理', async () => {
      // 模拟缓存操作异常
      const originalGet = apiKeyService._validationCache.get
      apiKeyService._validationCache.get = jest.fn().mockImplementation(() => {
        throw new Error('Cache error')
      })
      mockRedis.findApiKeyByHash.mockResolvedValue(mockKeyData)
      
      // 验证仍然应该成功（回退到正常验证）
      const result = await apiKeyService.validateApiKey(testApiKey)
      expect(result.valid).toBe(true)
      
      // 恢复原方法
      apiKeyService._validationCache.get = originalGet
    })

    test('空的API Key应该被正确处理', async () => {
      const result1 = await apiKeyService.validateApiKey('')
      const result2 = await apiKeyService.validateApiKey(null)
      const result3 = await apiKeyService.validateApiKey(undefined)
      
      expect(result1.valid).toBe(false)
      expect(result2.valid).toBe(false)
      expect(result3.valid).toBe(false)
    })
  })
})