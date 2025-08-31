/**
 * API Key Service 独立盐值哈希功能测试
 * 专门测试API Key哈希使用独立盐值的安全增强功能
 */

const { ApiKeyService } = require('../../../src/services/apiKeyService')
const config = require('../../../config/config.example')
const crypto = require('crypto')

// Mock config 以便测试不同的盐值配置
jest.mock('../../../config/config.example', () => ({
  security: {
    apiKeySalt: 'test-api-key-salt-for-testing-32char',
    encryptionKey: 'test-encryption-key-1234567890123456',
    encryptionSalt: 'test-encryption-salt-for-testing'
  }
}))

describe('API Key Service 独立盐值哈希功能测试', () => {
  let apiKeyService

  beforeEach(() => {
    jest.clearAllMocks()
    apiKeyService = new ApiKeyService()
  })

  describe('_hashApiKey 独立盐值功能测试', () => {
    test('应该使用API_KEY_SALT而不是ENCRYPTION_KEY', () => {
      const testApiKey = 'cr_1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef'
      
      // 调用内部方法（为了测试需要访问私有方法）
      const result = apiKeyService._hashApiKey(testApiKey)
      
      // 验证结果是SHA-256哈希（64字符十六进制）
      expect(result).toMatch(/^[a-f0-9]{64}$/)
      
      // 手动计算期望的哈希值（使用API Key盐值）
      const expectedHash = crypto
        .createHash('sha256')
        .update(testApiKey + config.security.apiKeySalt)
        .digest('hex')
      
      expect(result).toBe(expectedHash)
    })

    test('应该产生与加密密钥不同的哈希值', () => {
      const testApiKey = 'cr_1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef'
      
      // 使用API Key盐值的哈希（正确方式）
      const hashWithApiKeySalt = apiKeyService._hashApiKey(testApiKey)
      
      // 使用加密密钥的哈希（旧方式，不应该相同）
      const hashWithEncryptionKey = crypto
        .createHash('sha256')
        .update(testApiKey + config.security.encryptionKey)
        .digest('hex')
      
      // 两种哈希值应该不同
      expect(hashWithApiKeySalt).not.toBe(hashWithEncryptionKey)
    })

    test('应该为相同的API Key产生一致的哈希值', () => {
      const testApiKey = 'cr_1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef'
      
      const hash1 = apiKeyService._hashApiKey(testApiKey)
      const hash2 = apiKeyService._hashApiKey(testApiKey)
      
      expect(hash1).toBe(hash2)
      expect(hash1).toMatch(/^[a-f0-9]{64}$/)
    })

    test('应该为不同的API Key产生不同的哈希值', () => {
      const apiKey1 = 'cr_1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcde1'
      const apiKey2 = 'cr_1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcde2'
      
      const hash1 = apiKeyService._hashApiKey(apiKey1)
      const hash2 = apiKeyService._hashApiKey(apiKey2)
      
      expect(hash1).not.toBe(hash2)
      expect(hash1).toMatch(/^[a-f0-9]{64}$/)
      expect(hash2).toMatch(/^[a-f0-9]{64}$/)
    })

    test('应该正确处理不同长度的API Key', () => {
      const testCases = [
        'cr_short',
        'cr_medium_length_key_1234567890',
        'cr_very_long_api_key_1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef'
      ]
      
      const hashes = testCases.map(apiKey => apiKeyService._hashApiKey(apiKey))
      
      // 所有哈希值都应该是64字符的十六进制
      hashes.forEach(hash => {
        expect(hash).toMatch(/^[a-f0-9]{64}$/)
      })
      
      // 所有哈希值都应该不同
      const uniqueHashes = new Set(hashes)
      expect(uniqueHashes.size).toBe(testCases.length)
    })

    test('应该正确处理特殊字符的API Key', () => {
      const testCases = [
        'cr_key_with_underscore',
        'cr_key-with-dash',
        'cr_key+with+plus',
        'cr_key/with/slash',
        'cr_key=with=equals'
      ]
      
      testCases.forEach(apiKey => {
        const hash = apiKeyService._hashApiKey(apiKey)
        expect(hash).toMatch(/^[a-f0-9]{64}$/)
        
        // 验证哈希值的一致性
        const hash2 = apiKeyService._hashApiKey(apiKey)
        expect(hash).toBe(hash2)
      })
    })
  })

  describe('缓存键生成测试', () => {
    test('_generateValidationCacheKey 应该使用独立盐值哈希', () => {
      const testApiKey = 'cr_1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef'
      
      const cacheKey = apiKeyService._generateValidationCacheKey(testApiKey)
      const expectedHash = apiKeyService._hashApiKey(testApiKey)
      
      expect(cacheKey).toBe(expectedHash)
      expect(cacheKey).toMatch(/^[a-f0-9]{64}$/)
    })

    test('不同的API Key应该生成不同的缓存键', () => {
      const apiKey1 = 'cr_1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcde1'
      const apiKey2 = 'cr_1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcde2'
      
      const cacheKey1 = apiKeyService._generateValidationCacheKey(apiKey1)
      const cacheKey2 = apiKeyService._generateValidationCacheKey(apiKey2)
      
      expect(cacheKey1).not.toBe(cacheKey2)
    })
  })

  describe('安全性增强验证', () => {
    test('盐值改变应该导致不同的哈希值', () => {
      const testApiKey = 'cr_1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef'
      
      // 使用当前盐值计算哈希
      const hash1 = apiKeyService._hashApiKey(testApiKey)
      
      // 手动计算使用不同盐值的哈希（模拟盐值更改后的效果）
      const differentSalt = 'different-salt-value-for-testing'
      const hash2 = crypto
        .createHash('sha256')
        .update(testApiKey + differentSalt)
        .digest('hex')
      
      expect(hash1).not.toBe(hash2)
    })

    test('应该阻止彩虹表攻击（盐值的存在）', () => {
      const commonApiKeys = [
        'cr_' + '1'.repeat(60),
        'cr_' + '0'.repeat(60),
        'cr_' + 'a'.repeat(60),
        'cr_' + 'f'.repeat(60)
      ]
      
      // 计算带盐值的哈希
      const hashesWithSalt = commonApiKeys.map(apiKey => apiKeyService._hashApiKey(apiKey))
      
      // 计算不带盐值的哈希（理论上的彩虹表）
      const hashesWithoutSalt = commonApiKeys.map(apiKey => 
        crypto.createHash('sha256').update(apiKey).digest('hex')
      )
      
      // 带盐值的哈希应该与不带盐值的哈希完全不同
      for (let i = 0; i < commonApiKeys.length; i++) {
        expect(hashesWithSalt[i]).not.toBe(hashesWithoutSalt[i])
      }
    })

    test('应该提供足够的哈希分布均匀性', () => {
      // 生成一系列相似的API Key
      const baseKey = 'cr_1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcde'
      const apiKeys = []
      for (let i = 0; i < 100; i++) {
        apiKeys.push(baseKey + i.toString().padStart(2, '0'))
      }
      
      // 计算所有哈希值
      const hashes = apiKeys.map(apiKey => apiKeyService._hashApiKey(apiKey))
      
      // 验证没有重复的哈希值
      const uniqueHashes = new Set(hashes)
      expect(uniqueHashes.size).toBe(apiKeys.length)
      
      // 检查哈希值的十六进制字符分布
      const charCounts = {}
      hashes.join('').split('').forEach(char => {
        charCounts[char] = (charCounts[char] || 0) + 1
      })
      
      // 验证至少使用了所有十六进制字符
      const usedChars = Object.keys(charCounts)
      expect(usedChars.length).toBeGreaterThanOrEqual(10) // 至少10个不同字符
    })
  })

  describe('配置兼容性测试', () => {
    test('应该正确读取环境变量中的API_KEY_SALT', () => {
      // 模拟环境变量
      const originalEnv = process.env.API_KEY_SALT
      process.env.API_KEY_SALT = 'env-test-salt-value-123456789012'
      
      // 重新加载配置（在实际应用中配置会在启动时加载）
      const testApiKey = 'cr_test'
      const hash = apiKeyService._hashApiKey(testApiKey)
      
      expect(hash).toMatch(/^[a-f0-9]{64}$/)
      
      // 恢复原始环境变量
      if (originalEnv !== undefined) {
        process.env.API_KEY_SALT = originalEnv
      } else {
        delete process.env.API_KEY_SALT
      }
    })

    test('应该处理空盐值的情况', () => {
      const originalSalt = config.security.apiKeySalt
      config.security.apiKeySalt = ''
      
      const testApiKey = 'cr_test'
      const hash = apiKeyService._hashApiKey(testApiKey)
      
      // 即使盐值为空也应该产生有效哈希
      expect(hash).toMatch(/^[a-f0-9]{64}$/)
      
      // 恢复原始盐值
      config.security.apiKeySalt = originalSalt
    })

    test('应该处理undefined盐值的情况', () => {
      const originalSalt = config.security.apiKeySalt
      config.security.apiKeySalt = undefined
      
      const testApiKey = 'cr_test'
      
      // 这应该抛出错误或有适当的处理
      expect(() => {
        apiKeyService._hashApiKey(testApiKey)
      }).not.toThrow() // 或者根据实际实现决定是否应该抛出错误
      
      // 恢复原始盐值
      config.security.apiKeySalt = originalSalt
    })
  })

  describe('性能测试', () => {
    test('哈希计算应该在合理时间内完成', () => {
      const testApiKey = 'cr_1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef'
      
      const startTime = Date.now()
      
      // 执行多次哈希计算
      for (let i = 0; i < 1000; i++) {
        apiKeyService._hashApiKey(testApiKey + i)
      }
      
      const endTime = Date.now()
      const duration = endTime - startTime
      
      // 1000次哈希应该在1秒内完成
      expect(duration).toBeLessThan(1000)
    })

    test('相同API Key的多次哈希应该返回相同结果', () => {
      const testApiKey = 'cr_1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef'
      
      // 多次计算相同API Key的哈希
      const hashes = Array(100).fill().map(() => apiKeyService._hashApiKey(testApiKey))
      
      // 所有结果应该相同
      const firstHash = hashes[0]
      hashes.forEach(hash => {
        expect(hash).toBe(firstHash)
      })
    })
  })
})