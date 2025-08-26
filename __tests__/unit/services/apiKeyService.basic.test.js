// 基础API Key服务测试
const crypto = require('crypto')

// Mock所有依赖
jest.mock('../../../src/models/redis', () => ({
  __setMockRedis: jest.fn(),
  setApiKey: jest.fn(),
  getApiKey: jest.fn(),
  findApiKeyByHash: jest.fn(),
  getUsageStats: jest.fn(),
  getDailyCost: jest.fn()
}))

jest.mock('../../../src/utils/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
  security: jest.fn(),
  success: jest.fn(),
  api: jest.fn() // 添加api方法
}))

jest.mock('../../../config/config', () => ({
  security: {
    apiKeyPrefix: 'cr_',
    encryptionKey: '12345678901234567890123456789012',
    apiKeySalt: 'test-salt-for-api-key-hashing-only'
  },
  limits: {
    defaultTokenLimit: 1000
  }
}))

describe('ApiKeyService - 基础功能测试', () => {
  let apiKeyService

  beforeEach(() => {
    // 清理模块缓存
    jest.resetModules()
    
    // 重新引入服务
    apiKeyService = require('../../../src/services/apiKeyService')
    
    // 清理所有mock
    jest.clearAllMocks()
  })

  describe('基础功能检查', () => {
    it('应该成功加载ApiKeyService', () => {
      expect(apiKeyService).toBeDefined()
      expect(typeof apiKeyService).toBe('object')
    })

    it('应该包含必要的方法', () => {
      expect(typeof apiKeyService.generateApiKey).toBe('function')
      expect(typeof apiKeyService.validateApiKey).toBe('function')
      expect(typeof apiKeyService._hashApiKey).toBe('function')
      expect(typeof apiKeyService._generateSecretKey).toBe('function')
    })

    it('_hashApiKey应该为相同输入产生相同结果', () => {
      const testInput = 'cr_test_key_12345'
      const hash1 = apiKeyService._hashApiKey(testInput)
      const hash2 = apiKeyService._hashApiKey(testInput)
      
      expect(hash1).toBe(hash2)
      expect(typeof hash1).toBe('string')
      expect(hash1.length).toBeGreaterThan(10)
    })

    it('_hashApiKey应该为不同输入产生不同结果', () => {
      const input1 = 'cr_test_key_12345'
      const input2 = 'cr_test_key_67890'
      const hash1 = apiKeyService._hashApiKey(input1)
      const hash2 = apiKeyService._hashApiKey(input2)
      
      expect(hash1).not.toBe(hash2)
    })

    it('_generateSecretKey应该生成有效的密钥', () => {
      const key1 = apiKeyService._generateSecretKey()
      const key2 = apiKeyService._generateSecretKey()
      
      expect(typeof key1).toBe('string')
      expect(typeof key2).toBe('string')
      expect(key1).not.toBe(key2)
      expect(key1.length).toBeGreaterThan(20)
      expect(key2.length).toBeGreaterThan(20)
      
      // 检查是否只包含十六进制字符
      expect(key1).toMatch(/^[a-f0-9]+$/)
      expect(key2).toMatch(/^[a-f0-9]+$/)
    })
  })

  describe('generateApiKey方法', () => {
    it('应该调用generateApiKey而不抛出错误', async () => {
      const mockRedis = require('../../../src/models/redis')
      mockRedis.setApiKey.mockResolvedValue('OK')

      const options = {
        name: 'Test Key',
        tokenLimit: 5000
      }

      // 这个测试主要是验证方法能被调用并返回结构正确的结果
      const result = await apiKeyService.generateApiKey(options)
      
      expect(result).toBeDefined()
      expect(result).toHaveProperty('apiKey')
      expect(result).toHaveProperty('id')
      expect(result.apiKey).toMatch(/^cr_[a-f0-9]+$/)
      expect(typeof result.id).toBe('string')
      expect(result.id.length).toBeGreaterThan(10)
    })
  })

  describe('validateApiKey方法', () => {
    it('应该处理基本的验证流程', async () => {
      const mockRedis = require('../../../src/models/redis')
      
      // 模拟找不到API Key的情况
      mockRedis.findApiKeyByHash.mockResolvedValue(null)
      
      const result = await apiKeyService.validateApiKey('cr_invalid_key')
      
      expect(result).toBeDefined()
      expect(result).toHaveProperty('valid')
      expect(result.valid).toBe(false)
      expect(result).toHaveProperty('error')
    })

    it('应该处理有效的API Key', async () => {
      const mockRedis = require('../../../src/models/redis')
      
      // 模拟找到有效API Key的情况
      const mockKeyData = {
        id: 'test-key-id',
        name: 'Test Key',
        isActive: 'true',
        tokenLimit: '1000',
        totalTokensUsed: '100',
        concurrencyLimit: '5',
        rateLimitWindow: '3600',
        rateLimitRequests: '100',
        permissions: 'all',
        enableModelRestriction: 'false',
        restrictedModels: '[]',
        enableClientRestriction: 'false',
        allowedClients: '[]',
        dailyCostLimit: '0',
        tags: '[]',
        createdAt: new Date().toISOString(),
        expiresAt: null,
        createdBy: 'test-user'
      }
      
      mockRedis.findApiKeyByHash.mockResolvedValue(mockKeyData)
      mockRedis.getUsageStats.mockResolvedValue({
        totalTokens: 100,
        inputTokens: 50,
        outputTokens: 50
      })
      mockRedis.getDailyCost.mockResolvedValue(5.25)
      
      const result = await apiKeyService.validateApiKey('cr_valid_key_12345')
      
      expect(result).toBeDefined()
      expect(result).toHaveProperty('valid')
      expect(result.valid).toBe(true)
      expect(result).toHaveProperty('keyData')
      expect(result.keyData.name).toBe('Test Key')
      expect(result.keyData.id).toBe('test-key-id')
      expect(result.keyData.tokenLimit).toBe(1000)
      expect(result.keyData.usage).toEqual({ totalTokens: 100, inputTokens: 50, outputTokens: 50 })
      expect(result.keyData.dailyCost).toBe(5.25)
    })
  })

  describe('错误处理', () => {
    it('应该处理Redis操作错误', async () => {
      const mockRedis = require('../../../src/models/redis')
      mockRedis.findApiKeyByHash.mockRejectedValue(new Error('Redis connection failed'))
      
      const result = await apiKeyService.validateApiKey('cr_test_key')
      
      expect(result).toBeDefined()
      expect(result.valid).toBe(false)
      expect(result.error).toContain('Internal validation error')
    })

    it('应该处理generateApiKey过程中的错误', async () => {
      const mockRedis = require('../../../src/models/redis')
      mockRedis.setApiKey.mockRejectedValue(new Error('Database write failed'))
      
      await expect(apiKeyService.generateApiKey({ name: 'Error Test' }))
        .rejects.toThrow('Database write failed')
    })
  })

  describe('边界情况', () => {
    it('应该正确处理空选项对象', async () => {
      const mockRedis = require('../../../src/models/redis')
      mockRedis.setApiKey.mockResolvedValue('OK')

      const result = await apiKeyService.generateApiKey()
      
      expect(result).toBeDefined()
      expect(result.apiKey).toMatch(/^cr_[a-f0-9]+$/)
    })

    it('应该处理特殊字符的API Key哈希', () => {
      const specialKeys = [
        'cr_key_with_special_chars_!@#$%',
        'cr_unicode_测试_key',
        'cr_numbers_12345_67890'
      ]

      specialKeys.forEach(key => {
        const hash = apiKeyService._hashApiKey(key)
        expect(typeof hash).toBe('string')
        expect(hash.length).toBeGreaterThan(0)
      })
    })
  })
})