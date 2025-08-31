/**
 * ApiKeyService 验证流程单元测试
 * 测试完整的API Key验证流程，包括缓存集成
 */

const { ApiKeyService } = require('../../../src/services/apiKeyService')
const redis = require('../../../src/models/redis')
const logger = require('../../../src/utils/logger')

// Mock 外部依赖
jest.mock('../../../src/models/redis')
jest.mock('../../../src/utils/logger')
jest.mock('../../../src/utils/cacheMonitor')

describe('ApiKeyService 验证流程测试', () => {
  let apiKeyService
  let mockRedis

  // 测试数据
  const testApiKey = 'cr_1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef'
  const testKeyId = 'test-key-id-123'
  
  const mockValidKeyData = {
    id: testKeyId,
    name: 'Test Key',
    description: 'Test API Key',
    isActive: 'true',
    expiresAt: '',
    claudeAccountId: 'claude-123',
    claudeConsoleAccountId: '',
    geminiAccountId: 'gemini-456',
    openaiAccountId: '',
    azureOpenaiAccountId: '',
    bedrockAccountId: '',
    permissions: 'all',
    tokenLimit: '1000000',
    concurrencyLimit: '5',
    rateLimitWindow: '60',
    rateLimitRequests: '100',
    enableModelRestriction: 'true',
    restrictedModels: '["claude-3-opus", "claude-3-sonnet"]',
    enableClientRestriction: 'true',
    allowedClients: '["claude_code", "gemini_cli"]',
    dailyCostLimit: '10.50',
    tags: '["production", "priority"]',
    createdAt: '2024-01-01T00:00:00.000Z',
    lastUsedAt: '2024-01-01T12:00:00.000Z'
  }

  const mockUsageStats = {
    totalRequests: 1000,
    totalTokens: 50000,
    totalInputTokens: 30000,
    totalOutputTokens: 20000,
    todayRequests: 10,
    todayTokens: 500
  }

  const mockDailyCost = 5.25

  beforeEach(() => {
    jest.clearAllMocks()
    
    // 创建新的 ApiKeyService 实例
    apiKeyService = new ApiKeyService()
    
    // 设置 mock 方法
    mockRedis = {
      findApiKeyByHash: jest.fn(),
      getUsageStats: jest.fn(),
      getDailyCost: jest.fn()
    }
    
    redis.findApiKeyByHash = mockRedis.findApiKeyByHash
    redis.getUsageStats = mockRedis.getUsageStats
    redis.getDailyCost = mockRedis.getDailyCost
    
    // 设置默认 mock 返回值
    mockRedis.getUsageStats.mockResolvedValue(mockUsageStats)
    mockRedis.getDailyCost.mockResolvedValue(mockDailyCost)
    
    // Mock 环境变量
    process.env.API_KEY_PREFIX = 'cr_'
    process.env.ENCRYPTION_KEY = 'test-encryption-key-1234567890123456'
    
    // Mock logger
    logger.debug = jest.fn()
    logger.error = jest.fn()
  })

  afterAll(async () => {
    // 清理缓存和异步操作
    if (apiKeyService && apiKeyService._validationCache) {
      apiKeyService._validationCache.clear()
    }
    // 等待一个tick让所有异步操作完成
    await new Promise(resolve => setTimeout(resolve, 10))
  })

  describe('完整验证流程测试', () => {
    beforeEach(() => {
      mockRedis.findApiKeyByHash.mockResolvedValue(mockValidKeyData)
    })

    test('应该正确验证有效的API Key', async () => {
      const result = await apiKeyService.validateApiKey(testApiKey)
      
      expect(result).toEqual({
        valid: true,
        keyData: {
          id: testKeyId,
          name: 'Test Key',
          description: 'Test API Key',
          createdAt: '2024-01-01T00:00:00.000Z',
          expiresAt: '',
          claudeAccountId: 'claude-123',
          claudeConsoleAccountId: '',
          geminiAccountId: 'gemini-456',
          openaiAccountId: '',
          azureOpenaiAccountId: '',
          bedrockAccountId: '',
          permissions: 'all',
          tokenLimit: 1000000,
          concurrencyLimit: 5,
          rateLimitWindow: 60,
          rateLimitRequests: 100,
          enableModelRestriction: true,
          restrictedModels: ['claude-3-opus', 'claude-3-sonnet'],
          enableClientRestriction: true,
          allowedClients: ['claude_code', 'gemini_cli'],
          dailyCostLimit: 10.50,
          dailyCost: 5.25,
          tags: ['production', 'priority'],
          usage: mockUsageStats
        }
      })
      
      expect(mockRedis.findApiKeyByHash).toHaveBeenCalledTimes(1)
      expect(mockRedis.getUsageStats).toHaveBeenCalledWith(testKeyId)
      expect(mockRedis.getDailyCost).toHaveBeenCalledWith(testKeyId)
    })

    test('应该正确处理无效格式的API Key', async () => {
      const invalidKeys = [
        'invalid-key',
        'sk_1234567890', // 错误前缀
        'cr_short',      // 太短
        '',              // 空字符串
        null,            // null
        undefined        // undefined
      ]

      for (const key of invalidKeys) {
        const result = await apiKeyService.validateApiKey(key)
        
        expect(result).toEqual({
          valid: false,
          error: 'Invalid API key format'
        })
      }
      
      // 验证没有调用 Redis
      expect(mockRedis.findApiKeyByHash).not.toHaveBeenCalled()
    })

    test('应该正确处理不存在的API Key', async () => {
      mockRedis.findApiKeyByHash.mockResolvedValue(null)
      
      const result = await apiKeyService.validateApiKey(testApiKey)
      
      expect(result).toEqual({
        valid: false,
        error: 'API key not found'
      })
    })

    test('应该正确处理禁用的API Key', async () => {
      const disabledKeyData = { ...mockValidKeyData, isActive: 'false' }
      mockRedis.findApiKeyByHash.mockResolvedValue(disabledKeyData)
      
      const result = await apiKeyService.validateApiKey(testApiKey)
      
      expect(result).toEqual({
        valid: false,
        error: 'API key is disabled'
      })
    })

    test('应该正确处理过期的API Key', async () => {
      const expiredKeyData = {
        ...mockValidKeyData,
        expiresAt: new Date(Date.now() - 1000).toISOString() // 1秒前过期
      }
      mockRedis.findApiKeyByHash.mockResolvedValue(expiredKeyData)
      
      const result = await apiKeyService.validateApiKey(testApiKey)
      
      expect(result).toEqual({
        valid: false,
        error: 'API key has expired'
      })
    })
  })

  describe('数据解析和格式化测试', () => {
    test('应该正确解析JSON字段', async () => {
      const keyDataWithJson = {
        ...mockValidKeyData,
        restrictedModels: '["model-1", "model-2", "model-3"]',
        allowedClients: '["client-1", "client-2"]',
        tags: '["tag-1", "tag-2", "tag-3"]'
      }
      mockRedis.findApiKeyByHash.mockResolvedValue(keyDataWithJson)
      
      const result = await apiKeyService.validateApiKey(testApiKey)
      
      expect(result.valid).toBe(true)
      expect(result.keyData.restrictedModels).toEqual(['model-1', 'model-2', 'model-3'])
      expect(result.keyData.allowedClients).toEqual(['client-1', 'client-2'])
      expect(result.keyData.tags).toEqual(['tag-1', 'tag-2', 'tag-3'])
    })

    test('应该处理无效的JSON字段', async () => {
      const keyDataWithInvalidJson = {
        ...mockValidKeyData,
        restrictedModels: 'invalid-json',
        allowedClients: 'also-invalid',
        tags: 'not-json-either'
      }
      mockRedis.findApiKeyByHash.mockResolvedValue(keyDataWithInvalidJson)
      
      const result = await apiKeyService.validateApiKey(testApiKey)
      
      expect(result.valid).toBe(true)
      expect(result.keyData.restrictedModels).toEqual([])
      expect(result.keyData.allowedClients).toEqual([])
      expect(result.keyData.tags).toEqual([])
    })

    test('应该正确转换数字字段', async () => {
      const keyDataWithNumbers = {
        ...mockValidKeyData,
        tokenLimit: '5000000',
        concurrencyLimit: '10',
        rateLimitWindow: '30',
        rateLimitRequests: '200',
        dailyCostLimit: '25.75'
      }
      mockRedis.findApiKeyByHash.mockResolvedValue(keyDataWithNumbers)
      
      const result = await apiKeyService.validateApiKey(testApiKey)
      
      expect(result.valid).toBe(true)
      expect(result.keyData.tokenLimit).toBe(5000000)
      expect(result.keyData.concurrencyLimit).toBe(10)
      expect(result.keyData.rateLimitWindow).toBe(30)
      expect(result.keyData.rateLimitRequests).toBe(200)
      expect(result.keyData.dailyCostLimit).toBe(25.75)
    })

    test('应该正确转换布尔字段', async () => {
      const testCases = [
        { field: 'enableModelRestriction', value: 'true', expected: true },
        { field: 'enableModelRestriction', value: 'false', expected: false },
        { field: 'enableClientRestriction', value: 'true', expected: true },
        { field: 'enableClientRestriction', value: 'false', expected: false }
      ]

      for (const testCase of testCases) {
        // 清理缓存确保每个测试用例都是独立的
        apiKeyService._validationCache.clear()
        
        const keyData = { ...mockValidKeyData }
        keyData[testCase.field] = testCase.value
        mockRedis.findApiKeyByHash.mockResolvedValue(keyData)
        
        const result = await apiKeyService.validateApiKey(testApiKey)
        
        expect(result.valid).toBe(true)
        expect(result.keyData[testCase.field]).toBe(testCase.expected)
      }
    })
  })

  describe('外部服务集成测试', () => {
    beforeEach(() => {
      mockRedis.findApiKeyByHash.mockResolvedValue(mockValidKeyData)
    })

    test('应该正确处理Redis查询异常', async () => {
      mockRedis.findApiKeyByHash.mockRejectedValue(new Error('Redis connection failed'))
      
      const result = await apiKeyService.validateApiKey(testApiKey)
      
      expect(result).toEqual({
        valid: false,
        error: 'Internal validation error'
      })
      expect(logger.error).toHaveBeenCalledWith(
        '❌ API key validation error:',
        expect.any(Error)
      )
    })

    test('应该正确处理使用统计查询异常', async () => {
      mockRedis.getUsageStats.mockRejectedValue(new Error('Usage stats failed'))
      
      const result = await apiKeyService.validateApiKey(testApiKey)
      
      expect(result).toEqual({
        valid: false,
        error: 'Internal validation error'
      })
    })

    test('应该正确处理费用统计查询异常', async () => {
      mockRedis.getDailyCost.mockRejectedValue(new Error('Cost stats failed'))
      
      const result = await apiKeyService.validateApiKey(testApiKey)
      
      expect(result).toEqual({
        valid: false,
        error: 'Internal validation error'
      })
    })

    test('应该处理缺失的使用统计数据', async () => {
      mockRedis.getUsageStats.mockResolvedValue(null)
      mockRedis.getDailyCost.mockResolvedValue(null)
      
      const result = await apiKeyService.validateApiKey(testApiKey)
      
      expect(result.valid).toBe(true)
      expect(result.keyData.usage).toBeNull()
      expect(result.keyData.dailyCost).toBe(0)
    })
  })

  describe('默认值和兼容性测试', () => {
    test('应该为缺失的字段设置默认值', async () => {
      const minimalKeyData = {
        id: testKeyId,
        name: 'Minimal Key',
        isActive: 'true',
        apiKey: 'test-hash'
      }
      mockRedis.findApiKeyByHash.mockResolvedValue(minimalKeyData)
      
      const result = await apiKeyService.validateApiKey(testApiKey)
      
      expect(result.valid).toBe(true)
      expect(result.keyData.description).toBe('')
      expect(result.keyData.permissions).toBe('all')
      expect(result.keyData.tokenLimit).toBe(0)
      expect(result.keyData.concurrencyLimit).toBe(0)
      expect(result.keyData.rateLimitWindow).toBe(0)
      expect(result.keyData.rateLimitRequests).toBe(0)
      expect(result.keyData.enableModelRestriction).toBe(false)
      expect(result.keyData.enableClientRestriction).toBe(false)
      expect(result.keyData.restrictedModels).toEqual([])
      expect(result.keyData.allowedClients).toEqual([])
      expect(result.keyData.tags).toEqual([])
      expect(result.keyData.dailyCostLimit).toBe(0)
    })

    test('应该处理未来过期时间', async () => {
      const futureExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() // 24小时后
      const keyDataWithFutureExpiry = {
        ...mockValidKeyData,
        expiresAt: futureExpiry
      }
      mockRedis.findApiKeyByHash.mockResolvedValue(keyDataWithFutureExpiry)
      
      const result = await apiKeyService.validateApiKey(testApiKey)
      
      expect(result.valid).toBe(true)
      expect(result.keyData.expiresAt).toBe(futureExpiry)
    })

    test('应该处理边界过期时间', async () => {
      const almostExpired = new Date(Date.now() + 1000).toISOString() // 1秒后过期
      const keyDataAlmostExpired = {
        ...mockValidKeyData,
        expiresAt: almostExpired
      }
      mockRedis.findApiKeyByHash.mockResolvedValue(keyDataAlmostExpired)
      
      const result = await apiKeyService.validateApiKey(testApiKey)
      
      expect(result.valid).toBe(true) // 还没过期
    })
  })

  describe('性能和缓存集成测试', () => {
    beforeEach(() => {
      mockRedis.findApiKeyByHash.mockResolvedValue(mockValidKeyData)
    })

    test('缓存命中应该跳过Redis查询', async () => {
      // 第一次验证 - 缓存未命中
      const result1 = await apiKeyService.validateApiKey(testApiKey)
      expect(result1.valid).toBe(true)
      expect(mockRedis.findApiKeyByHash).toHaveBeenCalledTimes(1)
      
      // 第二次验证 - 缓存命中
      const result2 = await apiKeyService.validateApiKey(testApiKey)
      expect(result2.valid).toBe(true)
      expect(mockRedis.findApiKeyByHash).toHaveBeenCalledTimes(1) // 仍然是1次
      
      // 验证缓存统计
      expect(apiKeyService._cacheStats.hits).toBe(1)
      expect(apiKeyService._cacheStats.misses).toBe(1)
    })

    test('验证时间应该被正确记录', async () => {
      const startTime = Date.now()
      await apiKeyService.validateApiKey(testApiKey)
      const endTime = Date.now()
      
      // 验证日志中记录了耗时
      expect(logger.debug).toHaveBeenCalledWith(
        expect.stringContaining('API key validated successfully')
      )
      
      // 验证整个过程在合理时间内完成
      expect(endTime - startTime).toBeLessThan(1000) // 1秒内
    })

    test('并发验证相同API Key应该正确处理', async () => {
      // 清除之前测试的影响
      apiKeyService._validationCache.clear()
      mockRedis.findApiKeyByHash.mockClear()
      
      // 创建多个并发验证请求
      const promises = Array(10).fill().map(() => 
        apiKeyService.validateApiKey(testApiKey)
      )
      
      const results = await Promise.all(promises)
      
      // 所有结果都应该是有效的
      results.forEach(result => {
        expect(result.valid).toBe(true)
      })
      
      // 并发情况下，缓存可能没有完全生效，但所有请求都应该返回相同的结果
      const callCount = mockRedis.findApiKeyByHash.mock.calls.length
      expect(callCount).toBeGreaterThan(0)
      expect(callCount).toBeLessThanOrEqual(10) // 最多10次调用
      
      // 验证所有结果一致
      const firstResult = results[0]
      results.forEach(result => {
        expect(result).toEqual(firstResult)
      })
    })

    test('验证不同API Key应该独立缓存', async () => {
      // 清理缓存和mock
      apiKeyService._validationCache.clear()
      mockRedis.findApiKeyByHash.mockClear()
      
      const apiKey1 = 'cr_1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcde1'
      const apiKey2 = 'cr_1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcde2'
      
      // 验证两个不同的API Key
      await apiKeyService.validateApiKey(apiKey1)
      await apiKeyService.validateApiKey(apiKey2)
      
      expect(mockRedis.findApiKeyByHash).toHaveBeenCalledTimes(2)
    })
  })
})