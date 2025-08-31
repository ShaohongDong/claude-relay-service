/**
 * ApiKeyService Merge功能单元测试
 * 测试merge冲突解决后的功能：缓存逻辑结合和完整返回对象
 */

const crypto = require('crypto')
const { ApiKeyService } = require('../../../src/services/apiKeyService')
const redis = require('../../../src/models/redis')
const LRUCache = require('../../../src/utils/lruCache')
const logger = require('../../../src/utils/logger')

// Mock所有外部依赖
jest.mock('../../../src/models/redis')
jest.mock('../../../src/utils/logger')
jest.mock('../../../src/utils/cacheMonitor')

describe('ApiKeyService Merge功能测试', () => {
  let apiKeyService
  let mockRedis

  // 测试数据
  const testApiKey = 'cr_1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef'
  const testKeyId = 'test-key-id-123'
  const testHashedKey = crypto.createHash('sha256').update(testApiKey + 'test-api-key-salt-for-testing-32char').digest('hex')

  const mockKeyData = {
    id: testKeyId,
    name: 'Test Key',
    description: 'Test API Key',
    isActive: 'true',
    expiresAt: '',
    claudeAccountId: 'claude-account-1',
    claudeConsoleAccountId: '',
    geminiAccountId: '',
    openaiAccountId: '',
    azureOpenaiAccountId: '',
    bedrockAccountId: 'bedrock-account-1',
    permissions: 'all',
    tokenLimit: '1000000',
    concurrencyLimit: '5',
    rateLimitWindow: '60',
    rateLimitRequests: '100',
    rateLimitCost: '10.50', // 新增字段
    weeklyOpusCostLimit: '500.00', // 新增字段
    enableModelRestriction: 'false',
    restrictedModels: '[]',
    enableClientRestriction: 'false',
    allowedClients: '[]',
    dailyCostLimit: '100.00',
    tags: '[]',
    createdAt: new Date().toISOString(),
    lastUsedAt: ''
  }

  beforeEach(() => {
    // 重置模块和创建新实例
    jest.clearAllMocks()
    jest.resetModules()
    
    // 创建新的服务实例
    apiKeyService = new ApiKeyService()

    // 设置Redis mock
    mockRedis = {
      findApiKeyByHash: jest.fn(),
      getUsageStats: jest.fn(),
      getDailyCost: jest.fn(),
      getWeeklyOpusCost: jest.fn()
    }
    redis.findApiKeyByHash = mockRedis.findApiKeyByHash
    redis.getUsageStats = mockRedis.getUsageStats
    redis.getDailyCost = mockRedis.getDailyCost
    redis.getWeeklyOpusCost = mockRedis.getWeeklyOpusCost

    // 设置基础返回值
    mockRedis.getUsageStats.mockResolvedValue({
      totalTokens: 1000,
      requestCount: 10
    })
    mockRedis.getDailyCost.mockResolvedValue(25.50)
    mockRedis.getWeeklyOpusCost.mockResolvedValue(150.75)
  })

  describe('validateApiKey - 缓存逻辑结合测试', () => {
    beforeEach(() => {
      mockRedis.findApiKeyByHash.mockResolvedValue(mockKeyData)
    })

    test('应该缓存有效的验证结果', async () => {
      // 第一次调用 - 应该执行完整验证并缓存
      const result1 = await apiKeyService.validateApiKey(testApiKey)
      
      expect(result1).toEqual({
        valid: true,
        keyData: expect.objectContaining({
          id: testKeyId,
          name: 'Test Key',
          rateLimitCost: 10.50, // 验证新增字段
          weeklyOpusCostLimit: 500.00, // 验证新增字段
          weeklyOpusCost: 150.75, // 验证新增字段
          bedrockAccountId: 'bedrock-account-1' // 验证Bedrock支持
        })
      })

      // 验证Redis被调用
      expect(mockRedis.findApiKeyByHash).toHaveBeenCalledWith(testHashedKey)
      expect(mockRedis.getWeeklyOpusCost).toHaveBeenCalledWith(testKeyId)

      // 第二次调用 - 应该从缓存获取
      const result2 = await apiKeyService.validateApiKey(testApiKey)
      
      expect(result2).toEqual(result1)
      // Redis应该只被调用一次（第一次），第二次从缓存获取
      expect(mockRedis.findApiKeyByHash).toHaveBeenCalledTimes(1)
    })

    test('应该只缓存有效的验证结果', async () => {
      // 设置无效的API Key
      mockRedis.findApiKeyByHash.mockResolvedValue(null)
      
      const result1 = await apiKeyService.validateApiKey(testApiKey)
      expect(result1).toEqual({
        valid: false,
        error: 'API key not found'
      })

      // 第二次调用 - 无效结果不应该被缓存，应该再次查询
      const result2 = await apiKeyService.validateApiKey(testApiKey)
      
      expect(result2).toEqual({
        valid: false,
        error: 'API key not found'
      })
      // Redis应该被调用两次（无效结果不缓存）
      expect(mockRedis.findApiKeyByHash).toHaveBeenCalledTimes(2)
    })

    test('缓存操作失败时应该继续正常工作', async () => {
      // Mock缓存set操作失败
      const originalSet = apiKeyService._validationCache.set
      apiKeyService._validationCache.set = jest.fn().mockImplementation(() => {
        throw new Error('Cache set failed')
      })

      const result = await apiKeyService.validateApiKey(testApiKey)
      
      expect(result).toEqual({
        valid: true,
        keyData: expect.objectContaining({
          id: testKeyId,
          rateLimitCost: 10.50,
          weeklyOpusCostLimit: 500.00,
          weeklyOpusCost: 150.75
        })
      })

      // 验证警告日志被记录
      expect(logger.warn).toHaveBeenCalledWith(
        '⚠️ Cache set operation failed:', 
        expect.any(Error)
      )

      // 恢复原方法
      apiKeyService._validationCache.set = originalSet
    })
  })

  describe('_performFullValidation - 完整返回对象测试', () => {
    test('应该返回包含所有新增字段的完整对象', async () => {
      mockRedis.findApiKeyByHash.mockResolvedValue(mockKeyData)
      
      const result = await apiKeyService._performFullValidation(testApiKey, Date.now())
      
      expect(result).toEqual({
        valid: true,
        keyData: {
          id: testKeyId,
          name: 'Test Key',
          description: 'Test API Key',
          createdAt: mockKeyData.createdAt,
          expiresAt: '',
          claudeAccountId: 'claude-account-1',
          claudeConsoleAccountId: '',
          geminiAccountId: '',
          openaiAccountId: '',
          azureOpenaiAccountId: '',
          bedrockAccountId: 'bedrock-account-1',
          permissions: 'all',
          tokenLimit: 1000000,
          concurrencyLimit: 5,
          rateLimitWindow: 60,
          rateLimitRequests: 100,
          rateLimitCost: 10.50, // 验证新增字段
          enableModelRestriction: false,
          restrictedModels: [],
          enableClientRestriction: false,
          allowedClients: [],
          dailyCostLimit: 100.00,
          weeklyOpusCostLimit: 500.00, // 验证新增字段
          dailyCost: 25.50,
          weeklyOpusCost: 150.75, // 验证新增字段
          tags: [],
          usage: {
            totalTokens: 1000,
            requestCount: 10
          }
        }
      })

      // 验证新增字段的Redis调用
      expect(mockRedis.getWeeklyOpusCost).toHaveBeenCalledWith(testKeyId)
    })

    test('应该处理缺失的新增字段', async () => {
      // 创建没有新字段的旧格式数据
      const oldFormatKeyData = {
        ...mockKeyData,
        rateLimitCost: undefined,
        weeklyOpusCostLimit: undefined
      }
      delete oldFormatKeyData.rateLimitCost
      delete oldFormatKeyData.weeklyOpusCostLimit

      mockRedis.findApiKeyByHash.mockResolvedValue(oldFormatKeyData)
      mockRedis.getWeeklyOpusCost.mockResolvedValue(null)

      const result = await apiKeyService._performFullValidation(testApiKey, Date.now())
      
      expect(result.keyData).toEqual(expect.objectContaining({
        rateLimitCost: 0, // 应该默认为0
        weeklyOpusCostLimit: 0, // 应该默认为0
        weeklyOpusCost: 0 // 应该默认为0
      }))
    })

    test('应该正确解析JSON字段', async () => {
      const keyDataWithJsonFields = {
        ...mockKeyData,
        restrictedModels: '["claude-3-opus", "claude-3-sonnet"]',
        allowedClients: '["claude-code", "api-client"]',
        tags: '["production", "high-priority"]'
      }

      mockRedis.findApiKeyByHash.mockResolvedValue(keyDataWithJsonFields)

      const result = await apiKeyService._performFullValidation(testApiKey, Date.now())
      
      expect(result.keyData).toEqual(expect.objectContaining({
        restrictedModels: ["claude-3-opus", "claude-3-sonnet"],
        allowedClients: ["claude-code", "api-client"],
        tags: ["production", "high-priority"]
      }))
    })

    test('应该处理JSON解析失败', async () => {
      const keyDataWithBadJson = {
        ...mockKeyData,
        restrictedModels: 'invalid-json{',
        allowedClients: 'also-invalid]',
        tags: 'bad-json['
      }

      mockRedis.findApiKeyByHash.mockResolvedValue(keyDataWithBadJson)

      const result = await apiKeyService._performFullValidation(testApiKey, Date.now())
      
      expect(result.keyData).toEqual(expect.objectContaining({
        restrictedModels: [], // 应该回退到空数组
        allowedClients: [], // 应该回退到空数组
        tags: [] // 应该回退到空数组
      }))
    })
  })

  describe('缓存统计信息', () => {
    test('应该正确跟踪缓存命中和未命中', async () => {
      mockRedis.findApiKeyByHash.mockResolvedValue(mockKeyData)

      // 第一次调用 - 缓存未命中
      await apiKeyService.validateApiKey(testApiKey)
      let stats = apiKeyService.getValidationCacheStats()
      expect(stats.misses).toBe(1)
      expect(stats.hits).toBe(0)

      // 第二次调用 - 缓存命中
      await apiKeyService.validateApiKey(testApiKey)
      stats = apiKeyService.getValidationCacheStats()
      expect(stats.hits).toBe(1)
      expect(stats.misses).toBe(1)
    })
  })
})