const claudeAccountService = require('../../../src/services/claudeAccountService')
const redis = require('../../../src/models/redis')
const axios = require('axios')
const crypto = require('crypto')
const { v4: uuidv4 } = require('uuid')

// Mock dependencies
jest.mock('axios')
jest.mock('../../../src/models/redis')
jest.mock('../../../src/utils/logger')
jest.mock('../../../src/utils/webhookNotifier')
jest.mock('../../../src/utils/tokenRefreshLogger')
jest.mock('../../../src/services/tokenRefreshService')
jest.mock('uuid', () => ({
  v4: jest.fn(() => 'mocked-uuid-v4')
}))

jest.mock('../../../config/config', () => ({
  security: {
    encryptionKey: 'test-encryption-key-32-characters',
    encryptionSalt: 'test-encryption-salt-for-testing'
  },
  proxy: {
    timeout: 30000
  },
  logging: {
    dirname: '/tmp/test-logs',
    level: 'info'
  },
  claude: {
    apiUrl: 'https://api.anthropic.com/v1/messages',
    apiVersion: '2023-06-01',
    betaHeader: null,
    systemPrompt: ''
  }
}))

describe('ClaudeAccountService - Comprehensive Tests', () => {
  const mockConfig = require('../../../config/config')
  
  // 保存原始方法引用
  const originalMethods = {}
  beforeAll(() => {
    const methodsToSave = [
      'updateSessionWindow',
      'removeAccountRateLimit', 
      'refreshAccountToken',
      'getValidAccessToken',
      'fetchAndUpdateAccountProfile',
      'isAccountRateLimited',
      'getAccountRateLimitInfo',
      'getSessionWindowInfo'
    ]
    
    methodsToSave.forEach(methodName => {
      if (claudeAccountService[methodName]) {
        originalMethods[methodName] = claudeAccountService[methodName]
      }
    })
  })
  
  beforeEach(() => {
    jest.clearAllMocks()
    jest.restoreAllMocks()
    
    // 重置服务内部缓存
    claudeAccountService._encryptionKeyCache = null
    claudeAccountService._cachedEncryptionKey = null
    claudeAccountService._cachedEncryptionSalt = null
    if (claudeAccountService._decryptCache) {
      claudeAccountService._decryptCache.clear()
    }
    
    // Reset axios mocks to prevent cross-test interference
    if (axios.post && axios.post.mockReset) {
      axios.post.mockReset()
    }
    if (axios.get && axios.get.mockReset) {
      axios.get.mockReset()
    }
    
    // Reset all Redis mocks to default values
    redis.getClaudeAccount.mockReset()
    redis.setClaudeAccount.mockReset()
    redis.getAllClaudeAccounts.mockReset()
    redis.deleteClaudeAccount.mockReset()
    redis.getSessionAccountMapping.mockReset()
    redis.setSessionAccountMapping.mockReset()
    redis.deleteSessionAccountMapping.mockReset()
    
    // Reset optional methods if they exist
    if (redis.keys && redis.keys.mockReset) redis.keys.mockReset()
    if (redis.setex && redis.setex.mockReset) redis.setex.mockReset()
    
    // Reset client methods if they exist
    if (redis.client && redis.client.del && redis.client.del.mockReset) {
      redis.client.del.mockReset()
    }
    
    // 重置所有服务方法的Mock以防测试间污染
    const methodsToReset = [
      'updateSessionWindow',
      'removeAccountRateLimit', 
      'refreshAccountToken',
      'getValidAccessToken',
      'fetchAndUpdateAccountProfile',
      'isAccountRateLimited',
      'getAccountRateLimitInfo',
      'getSessionWindowInfo'
    ]
    
    methodsToReset.forEach(methodName => {
      // 恢复原始方法（如果被直接替换了）
      if (originalMethods[methodName]) {
        claudeAccountService[methodName] = originalMethods[methodName]
      }
      
      // 如果方法是spy，重置它
      if (claudeAccountService[methodName] && typeof claudeAccountService[methodName].mockReset === 'function') {
        claudeAccountService[methodName].mockReset()
      }
    })
    
    // Ensure default mock implementations with proper async behavior
    redis.getClaudeAccount.mockResolvedValue(null)
    redis.setClaudeAccount.mockResolvedValue(true)
    redis.getAllClaudeAccounts.mockResolvedValue([])
    redis.deleteClaudeAccount.mockResolvedValue(true)
    redis.getSessionAccountMapping.mockResolvedValue(null)
    redis.setSessionAccountMapping.mockResolvedValue(true)
    redis.deleteSessionAccountMapping.mockResolvedValue(true)
    
    // Set up optional methods if they don't exist
    redis.keys = redis.keys || jest.fn().mockResolvedValue([])
    redis.setex = redis.setex || jest.fn().mockResolvedValue('OK')
    
    if (redis.keys.mockResolvedValue) redis.keys.mockResolvedValue([])
    if (redis.setex.mockResolvedValue) redis.setex.mockResolvedValue('OK')
    
    // Set up client mock if it doesn't exist
    redis.client = redis.client || {}
    redis.client.del = redis.client.del || jest.fn().mockResolvedValue(1)
    if (redis.client.del.mockResolvedValue) redis.client.del.mockResolvedValue(1)
  })

  describe('账户创建和基础操作', () => {
    test('应该成功创建Claude账户（Claude AI OAuth格式）', async () => {
      const testOAuthData = {
        accessToken: 'test-access-token-12345',
        refreshToken: 'test-refresh-token-67890',
        expiresAt: Date.now() + 3600000,
        scopes: ['user:profile', 'claude:chat']
      }

      const mockAccountId = 'test-account-id'
      uuidv4.mockReturnValue(mockAccountId)

      redis.setClaudeAccount = jest.fn().mockResolvedValue(true)
      
      const result = await claudeAccountService.createAccount({
        name: 'Test Account',
        description: 'Test Description',
        email: 'test@example.com',
        claudeAiOauth: testOAuthData,
        proxy: { type: 'socks5', host: '127.0.0.1', port: 1080 }
      })

      expect(result).toMatchObject({
        id: mockAccountId,
        name: 'Test Account',
        description: 'Test Description',
        email: 'test@example.com',
        status: 'active',
        expiresAt: testOAuthData.expiresAt.toString(),
        scopes: testOAuthData.scopes
      })

      expect(redis.setClaudeAccount).toHaveBeenCalledWith(
        mockAccountId,
        expect.objectContaining({
          id: mockAccountId,
          name: 'Test Account',
          status: 'active',
          platform: 'claude'
        })
      )
    })

    test('应该成功创建兼容旧格式的账户', async () => {
      const mockAccountId = 'test-legacy-account-id'
      uuidv4.mockReturnValue(mockAccountId)

      redis.setClaudeAccount = jest.fn().mockResolvedValue(true)
      
      const result = await claudeAccountService.createAccount({
        name: 'Legacy Account',
        email: 'legacy@example.com',
        refreshToken: 'legacy-refresh-token',
        accountType: 'shared'
      })

      expect(result).toMatchObject({
        id: mockAccountId,
        name: 'Legacy Account',
        email: 'legacy@example.com',
        accountType: 'shared'
      })

      expect(redis.setClaudeAccount).toHaveBeenCalledWith(
        mockAccountId,
        expect.objectContaining({
          status: 'created', // 旧格式账户初始状态为created
          platform: 'claude'
        })
      )
    })

    test('应该正确设置账户优先级和调度属性', async () => {
      const mockAccountId = 'test-priority-account'
      uuidv4.mockReturnValue(mockAccountId)

      redis.setClaudeAccount = jest.fn().mockResolvedValue(true)
      
      await claudeAccountService.createAccount({
        name: 'Priority Account',
        priority: 10,
        schedulable: false,
        accountType: 'dedicated'
      })

      expect(redis.setClaudeAccount).toHaveBeenCalledWith(
        mockAccountId,
        expect.objectContaining({
          priority: '10',
          schedulable: 'false',
          accountType: 'dedicated'
        })
      )
    })

    test('应该处理创建账户时的错误', async () => {
      redis.setClaudeAccount = jest.fn().mockRejectedValue(new Error('Redis error'))

      await expect(claudeAccountService.createAccount({
        name: 'Error Account'
      })).rejects.toThrow('Redis error')
    })
  })

  describe('加密和解密功能', () => {
    test('应该正确加密敏感数据', () => {
      const testData = 'sensitive-data-to-encrypt'
      
      const encrypted = claudeAccountService._encryptSensitiveData(testData)
      
      expect(encrypted).toBeTruthy()
      expect(encrypted).toContain(':') // IV:encryptedData格式
      expect(encrypted).not.toBe(testData) // 确保已加密
    })

    test('应该正确解密敏感数据', () => {
      const testData = 'sensitive-data-to-decrypt'
      
      const encrypted = claudeAccountService._encryptSensitiveData(testData)
      const decrypted = claudeAccountService._decryptSensitiveData(encrypted)
      
      expect(decrypted).toBe(testData)
    })

    test('应该处理空数据的加密', () => {
      const encrypted1 = claudeAccountService._encryptSensitiveData('')
      const encrypted2 = claudeAccountService._encryptSensitiveData(null)
      const encrypted3 = claudeAccountService._encryptSensitiveData(undefined)
      
      expect(encrypted1).toBe('')
      expect(encrypted2).toBe('')
      expect(encrypted3).toBe('')
    })

    test('应该处理空数据的解密', () => {
      const decrypted1 = claudeAccountService._decryptSensitiveData('')
      const decrypted2 = claudeAccountService._decryptSensitiveData(null)
      const decrypted3 = claudeAccountService._decryptSensitiveData(undefined)
      
      expect(decrypted1).toBe('')
      expect(decrypted2).toBe('')
      expect(decrypted3).toBe('')
    })

    test('应该缓存加密密钥以提高性能', () => {
      const testData1 = 'test-data-1'
      const testData2 = 'test-data-2'
      
      // 第一次加密会生成密钥
      claudeAccountService._encryptSensitiveData(testData1)
      const firstKey = claudeAccountService._encryptionKeyCache
      
      // 第二次加密应该使用缓存的密钥
      claudeAccountService._encryptSensitiveData(testData2)
      const secondKey = claudeAccountService._encryptionKeyCache
      
      expect(firstKey).toBeTruthy()
      expect(secondKey).toBe(firstKey) // 相同的密钥对象
    })

    test('应该在配置变更时清除密钥缓存', () => {
      const testData = 'test-data'
      
      // 使用当前配置生成密钥
      claudeAccountService._encryptSensitiveData(testData)
      expect(claudeAccountService._encryptionKeyCache).toBeTruthy()
      
      // 模拟配置变更
      mockConfig.security.encryptionKey = 'new-encryption-key-32-characters'
      
      // 再次加密应该检测到配置变更并清除缓存
      claudeAccountService._encryptSensitiveData(testData)
      // 因为配置变更，缓存应该被重新生成
      expect(claudeAccountService._cachedEncryptionKey).toBe('new-encryption-key-32-characters')
    })

    test('应该处理加密失败的情况', () => {
      const originalCreateCipheriv = crypto.createCipheriv
      crypto.createCipheriv = jest.fn().mockImplementation(() => {
        throw new Error('Encryption failed')
      })
      
      expect(() => {
        claudeAccountService._encryptSensitiveData('test-data')
      }).toThrow('Encryption failed')
      
      crypto.createCipheriv = originalCreateCipheriv
    })

    test('应该识别敏感数据并正确处理缓存', () => {
      // 测试短数据（非敏感）
      const shortData = 'short'
      const encrypted1 = claudeAccountService._encryptSensitiveData(shortData)
      const decrypted1 = claudeAccountService._decryptSensitiveData(encrypted1)
      expect(decrypted1).toBe(shortData)
      
      // 测试长数据（敏感）- OAuth token格式
      const longData = 'a'.repeat(200) // 200个字符，超过敏感数据阈值
      const encrypted2 = claudeAccountService._encryptSensitiveData(longData)
      const decrypted2 = claudeAccountService._decryptSensitiveData(encrypted2)
      expect(decrypted2).toBe(longData)
    })

    test('应该处理旧格式加密数据', () => {
      // 模拟旧格式数据（十六进制字符串）
      const legacyData = '0123456789abcdef'
      
      const result = claudeAccountService._decryptSensitiveData(legacyData)
      expect(result).toBe('[LEGACY_DATA_MIGRATION_REQUIRED]')
    })

    test('应该标记需要迁移的数据', () => {
      const legacyData = 'legacy_encrypted_data'
      redis.setex = jest.fn().mockResolvedValue('OK')
      
      claudeAccountService._markForMigration(legacyData)
      
      expect(redis.setex).toHaveBeenCalledWith(
        expect.stringContaining('migration_needed:'),
        30 * 24 * 60 * 60,
        expect.stringContaining('LEGACY_CRYPTO_API_REMOVED')
      )
    })
  })

  describe('账户获取和查询', () => {
    test('应该成功获取存在的账户', async () => {
      const mockAccountData = {
        id: 'test-account-id',
        name: 'Test Account',
        status: 'active',
        isActive: 'true'
      }

      redis.getClaudeAccount.mockResolvedValue(mockAccountData)

      const result = await claudeAccountService.getAccount('test-account-id')
      
      expect(result).toEqual(mockAccountData)
      expect(redis.getClaudeAccount).toHaveBeenCalledWith('test-account-id')
    })

    test('应该返回null当账户不存在时', async () => {
      redis.getClaudeAccount.mockResolvedValue({})

      const result = await claudeAccountService.getAccount('non-existent-id')
      
      expect(result).toBeNull()
    })

    test('应该处理获取账户时的错误', async () => {
      redis.getClaudeAccount.mockRejectedValue(new Error('Redis error'))

      const result = await claudeAccountService.getAccount('error-account-id')
      
      expect(result).toBeNull()
    })

    test('应该成功获取所有账户并处理敏感信息', async () => {
      const mockAccounts = [
        {
          id: 'account-1',
          name: 'Account 1',
          email: claudeAccountService._encryptSensitiveData('user1@example.com'),
          isActive: 'true',
          status: 'active',
          priority: '10',
          accountType: 'shared',
          scopes: 'user:profile claude:chat',
          refreshToken: claudeAccountService._encryptSensitiveData('refresh-token-1'),
          subscriptionInfo: JSON.stringify({ accountType: 'claude_pro' }),
          rateLimitStatus: 'limited',
          rateLimitedAt: new Date().toISOString()
        }
      ]

      redis.getAllClaudeAccounts = jest.fn().mockResolvedValue(mockAccounts)
      
      // Mock rate limit methods
      claudeAccountService.getAccountRateLimitInfo = jest.fn().mockResolvedValue({
        isRateLimited: true,
        rateLimitedAt: mockAccounts[0].rateLimitedAt,
        minutesRemaining: 30
      })
      
      claudeAccountService.getSessionWindowInfo = jest.fn().mockResolvedValue({
        hasActiveWindow: true,
        windowStart: new Date().toISOString(),
        windowEnd: new Date(Date.now() + 3600000).toISOString(),
        progress: 25,
        remainingTime: 180
      })

      const result = await claudeAccountService.getAllAccounts()
      
      expect(result).toHaveLength(1)
      expect(result[0]).toMatchObject({
        id: 'account-1',
        name: 'Account 1',
        email: 'us***1@example.com', // 掩码处理
        isActive: true,
        status: 'active',
        priority: 10,
        accountType: 'shared',
        scopes: ['user:profile', 'claude:chat'],
        hasRefreshToken: true,
        subscriptionInfo: { accountType: 'claude_pro' },
        rateLimitStatus: expect.objectContaining({
          isRateLimited: true
        }),
        sessionWindow: expect.objectContaining({
          hasActiveWindow: true
        })
      })
    })
  })

  describe('Token管理和刷新', () => {
    test('应该成功刷新账户token', async () => {
      const mockAccountId = 'test-account-id'
      const mockAccountData = {
        id: mockAccountId,
        name: 'Test Account',
        refreshToken: claudeAccountService._encryptSensitiveData('refresh-token-123'),
        proxy: JSON.stringify({ type: 'socks5', host: '127.0.0.1', port: 1080 })
      }

      const mockRefreshResponse = {
        status: 200,
        data: {
          access_token: 'new-access-token',
          refresh_token: 'new-refresh-token',
          expires_in: 3600
        }
      }

      redis.getClaudeAccount.mockResolvedValue(mockAccountData)
      redis.setClaudeAccount = jest.fn().mockResolvedValue(true)
      
      // Mock tokenRefreshService
      const tokenRefreshService = require('../../../src/services/tokenRefreshService')
      tokenRefreshService.acquireRefreshLock = jest.fn().mockResolvedValue(true)
      tokenRefreshService.releaseRefreshLock = jest.fn().mockResolvedValue(true)
      
      axios.post.mockResolvedValue(mockRefreshResponse)

      const result = await claudeAccountService.refreshAccountToken(mockAccountId)

      expect(result).toMatchObject({
        success: true,
        accessToken: 'new-access-token',
        expiresAt: expect.any(String)
      })

      expect(redis.setClaudeAccount).toHaveBeenCalledWith(
        mockAccountId,
        expect.objectContaining({
          status: 'active',
          lastRefreshAt: expect.any(String)
        })
      )
    })

    test('应该处理token刷新时的锁竞争', async () => {
      const mockAccountId = 'locked-account-id'
      const mockAccountData = {
        id: mockAccountId,
        name: 'Locked Account',
        refreshToken: claudeAccountService._encryptSensitiveData('refresh-token-456')
      }

      redis.getClaudeAccount.mockReset()
        .mockResolvedValueOnce(mockAccountData) // 第一次调用
        .mockResolvedValueOnce({ // 第二次调用（等待后）
          ...mockAccountData,
          accessToken: claudeAccountService._encryptSensitiveData('updated-access-token'),
          expiresAt: (Date.now() + 3600000).toString()
        })
      
      const tokenRefreshService = require('../../../src/services/tokenRefreshService')
      tokenRefreshService.acquireRefreshLock = jest.fn().mockResolvedValue(false) // 锁已被占用

      const result = await claudeAccountService.refreshAccountToken(mockAccountId)

      expect(result).toMatchObject({
        success: true,
        accessToken: 'updated-access-token'
      })
    })

    test('应该处理refresh token不存在的情况', async () => {
      const mockAccountId = 'no-refresh-token-id'
      const mockAccountData = {
        id: mockAccountId,
        name: 'No Refresh Token Account',
        refreshToken: '' // 空refresh token
      }

      redis.getClaudeAccount.mockResolvedValue(mockAccountData)
      
      const tokenRefreshService = require('../../../src/services/tokenRefreshService')
      tokenRefreshService.acquireRefreshLock = jest.fn().mockResolvedValue(true)
      tokenRefreshService.releaseRefreshLock = jest.fn().mockResolvedValue(true)

      await expect(claudeAccountService.refreshAccountToken(mockAccountId))
        .rejects.toThrow('No refresh token available - manual token update required')
    })

    test('应该处理token刷新API错误', async () => {
      const mockAccountId = 'api-error-account-id'
      const mockAccountData = {
        id: mockAccountId,
        name: 'API Error Account',
        refreshToken: claudeAccountService._encryptSensitiveData('refresh-token-error')
      }

      redis.getClaudeAccount.mockResolvedValue(mockAccountData)
      redis.setClaudeAccount = jest.fn().mockResolvedValue(true)
      
      const tokenRefreshService = require('../../../src/services/tokenRefreshService')
      tokenRefreshService.acquireRefreshLock = jest.fn().mockResolvedValue(true)
      tokenRefreshService.releaseRefreshLock = jest.fn().mockResolvedValue(true)
      
      axios.post.mockRejectedValue(new Error('Token refresh API error'))

      await expect(claudeAccountService.refreshAccountToken(mockAccountId))
        .rejects.toThrow('Token refresh API error')

      // 应该更新账户状态为错误
      expect(redis.setClaudeAccount).toHaveBeenCalledWith(
        mockAccountId,
        expect.objectContaining({
          status: 'error',
          errorMessage: 'Token refresh API error'
        })
      )
    })

    test('应该成功获取有效的访问token', async () => {
      const mockAccountId = 'valid-token-account'
      const mockAccountData = {
        id: mockAccountId,
        name: 'Valid Token Account',
        isActive: 'true',
        accessToken: claudeAccountService._encryptSensitiveData('valid-access-token'),
        expiresAt: (Date.now() + 3600000).toString() // 1小时后过期
      }

      redis.getClaudeAccount.mockResolvedValue(mockAccountData)
      redis.setClaudeAccount = jest.fn().mockResolvedValue(true)
      
      // 使用spy而不是完全替换方法
      const updateSessionWindowSpy = jest.spyOn(claudeAccountService, 'updateSessionWindow')
        .mockResolvedValue(mockAccountData)

      const result = await claudeAccountService.getValidAccessToken(mockAccountId)

      expect(result).toBe('valid-access-token')
      expect(claudeAccountService.updateSessionWindow).toHaveBeenCalledWith(mockAccountId, mockAccountData)
    })

    test('应该在token过期时自动刷新', async () => {
      const mockAccountId = 'expired-token-account'
      const mockAccountData = {
        id: mockAccountId,
        name: 'Expired Token Account',
        isActive: 'true',
        accessToken: claudeAccountService._encryptSensitiveData('expired-access-token'),
        expiresAt: (Date.now() - 1000).toString(), // 已过期
        refreshToken: claudeAccountService._encryptSensitiveData('refresh-token-123')
      }

      redis.getClaudeAccount.mockResolvedValue(mockAccountData)
      
      // Mock refreshAccountToken方法
      claudeAccountService.refreshAccountToken = jest.fn().mockResolvedValue({
        success: true,
        accessToken: 'refreshed-access-token'
      })

      const result = await claudeAccountService.getValidAccessToken(mockAccountId)

      expect(result).toBe('refreshed-access-token')
      expect(claudeAccountService.refreshAccountToken).toHaveBeenCalledWith(mockAccountId)
    })

    test('应该处理账户被禁用的情况', async () => {
      const mockAccountId = 'disabled-account'
      const mockAccountData = {
        id: mockAccountId,
        name: 'Disabled Account',
        isActive: 'false' // 账户被禁用
      }

      redis.getClaudeAccount.mockResolvedValue(mockAccountData)

      await expect(claudeAccountService.getValidAccessToken(mockAccountId))
        .rejects.toThrow('Account is disabled')
    })

    test('应该在刷新失败时尝试使用当前token', async () => {
      const mockAccountId = 'refresh-failed-account'
      const mockAccountData = {
        id: mockAccountId,
        name: 'Refresh Failed Account',
        isActive: 'true',
        accessToken: claudeAccountService._encryptSensitiveData('current-access-token'),
        expiresAt: (Date.now() - 1000).toString() // 已过期
      }

      redis.getClaudeAccount.mockResolvedValue(mockAccountData)
      
      claudeAccountService.refreshAccountToken = jest.fn().mockRejectedValue(new Error('Refresh failed'))

      const result = await claudeAccountService.getValidAccessToken(mockAccountId)

      expect(result).toBe('current-access-token')
    })
  })

  describe('账户更新操作', () => {
    test('应该成功更新账户基本信息', async () => {
      const mockAccountId = 'update-account-id'
      const mockAccountData = {
        id: mockAccountId,
        name: 'Original Account',
        description: 'Original Description'
      }

      const updates = {
        name: 'Updated Account',
        description: 'Updated Description',
        priority: 20
      }

      redis.getClaudeAccount.mockResolvedValue(mockAccountData)
      redis.setClaudeAccount = jest.fn().mockResolvedValue(true)

      const result = await claudeAccountService.updateAccount(mockAccountId, updates)

      expect(result).toEqual({ success: true })
      expect(redis.setClaudeAccount).toHaveBeenCalledWith(
        mockAccountId,
        expect.objectContaining({
          name: 'Updated Account',
          description: 'Updated Description',
          priority: '20',
          updatedAt: expect.any(String)
        })
      )
    })

    test('应该正确处理敏感字段的更新', async () => {
      const mockAccountId = 'sensitive-update-id'
      const mockAccountData = {
        id: mockAccountId,
        name: 'Sensitive Account',
        email: claudeAccountService._encryptSensitiveData('old@example.com')
      }

      const updates = {
        email: 'new@example.com',
        password: 'new-password',
        refreshToken: 'new-refresh-token'
      }

      redis.getClaudeAccount.mockResolvedValue(mockAccountData)
      redis.setClaudeAccount = jest.fn().mockResolvedValue(true)

      await claudeAccountService.updateAccount(mockAccountId, updates)

      expect(redis.setClaudeAccount).toHaveBeenCalledWith(
        mockAccountId,
        expect.objectContaining({
          email: expect.not.stringMatching('new@example.com'), // 应该被加密
          password: expect.not.stringMatching('new-password'), // 应该被加密
          refreshToken: expect.not.stringMatching('new-refresh-token') // 应该被加密
        })
      )
    })

    test('应该处理Claude AI OAuth数据更新', async () => {
      const mockAccountId = 'oauth-update-id'
      const mockAccountData = {
        id: mockAccountId,
        name: 'OAuth Account'
      }

      const oauthData = {
        accessToken: 'new-oauth-access-token',
        refreshToken: 'new-oauth-refresh-token',
        expiresAt: Date.now() + 3600000,
        scopes: ['user:profile', 'claude:chat']
      }

      const updates = {
        claudeAiOauth: oauthData
      }

      redis.getClaudeAccount.mockResolvedValue(mockAccountData)
      redis.setClaudeAccount = jest.fn().mockResolvedValue(true)

      await claudeAccountService.updateAccount(mockAccountId, updates)

      expect(redis.setClaudeAccount).toHaveBeenCalledWith(
        mockAccountId,
        expect.objectContaining({
          status: 'active',
          scopes: 'user:profile claude:chat',
          expiresAt: oauthData.expiresAt.toString(),
          lastRefreshAt: expect.any(String)
        })
      )
    })

    test('应该在新增refresh token时调整过期时间', async () => {
      const mockAccountId = 'new-refresh-token-id'
      const mockAccountData = {
        id: mockAccountId,
        name: 'No Refresh Token Account',
        refreshToken: '' // 原来没有refresh token
      }

      const updates = {
        refreshToken: 'brand-new-refresh-token'
      }

      redis.getClaudeAccount.mockResolvedValue(mockAccountData)
      redis.setClaudeAccount = jest.fn().mockResolvedValue(true)

      await claudeAccountService.updateAccount(mockAccountId, updates)

      expect(redis.setClaudeAccount).toHaveBeenCalledWith(
        mockAccountId,
        expect.objectContaining({
          expiresAt: expect.any(String) // 应该设置新的过期时间
        })
      )

      // 验证过期时间大约是10分钟后
      const calledWith = redis.setClaudeAccount.mock.calls[0][1]
      const expiresAt = parseInt(calledWith.expiresAt)
      const now = Date.now()
      const tenMinutes = 10 * 60 * 1000
      expect(expiresAt).toBeGreaterThan(now)
      expect(expiresAt).toBeLessThan(now + tenMinutes + 60000) // 允许1分钟误差
    })

    test('应该处理账户不存在的更新请求', async () => {
      redis.getClaudeAccount.mockResolvedValue({})

      await expect(claudeAccountService.updateAccount('non-existent-id', { name: 'New Name' }))
        .rejects.toThrow('Account not found')
    })

    test('应该发送webhook通知当手动禁用账户时', async () => {
      const mockAccountId = 'disable-account-id'
      const mockAccountData = {
        id: mockAccountId,
        name: 'Account to Disable',
        isActive: 'true' // 当前是激活的
      }

      const updates = {
        isActive: 'false' // 要禁用
      }

      redis.getClaudeAccount.mockResolvedValue(mockAccountData)
      redis.setClaudeAccount = jest.fn().mockResolvedValue(true)

      const webhookNotifier = require('../../../src/utils/webhookNotifier')
      webhookNotifier.sendAccountAnomalyNotification = jest.fn().mockResolvedValue(true)

      await claudeAccountService.updateAccount(mockAccountId, updates)

      expect(webhookNotifier.sendAccountAnomalyNotification).toHaveBeenCalledWith({
        accountId: mockAccountId,
        accountName: 'Account to Disable',
        platform: 'claude-oauth',
        status: 'disabled',
        errorCode: 'CLAUDE_OAUTH_MANUALLY_DISABLED',
        reason: 'Account manually disabled by administrator'
      })
    })
  })

  describe('账户删除操作', () => {
    test('应该成功删除存在的账户', async () => {
      const mockAccountId = 'delete-account-id'

      redis.deleteClaudeAccount = jest.fn().mockResolvedValue(1) // 删除成功

      const result = await claudeAccountService.deleteAccount(mockAccountId)

      expect(result).toEqual({ success: true })
      expect(redis.deleteClaudeAccount).toHaveBeenCalledWith(mockAccountId)
    })

    test('应该处理删除不存在的账户', async () => {
      redis.deleteClaudeAccount = jest.fn().mockResolvedValue(0) // 没有删除任何记录

      await expect(claudeAccountService.deleteAccount('non-existent-id'))
        .rejects.toThrow('Account not found')
    })

    test('应该处理删除操作的错误', async () => {
      redis.deleteClaudeAccount = jest.fn().mockRejectedValue(new Error('Redis delete error'))

      await expect(claudeAccountService.deleteAccount('error-account-id'))
        .rejects.toThrow('Redis delete error')
    })
  })

  describe('智能账户选择算法', () => {
    const mockAccounts = [
      {
        id: 'account-1',
        name: 'Account 1',
        isActive: 'true',
        status: 'active',
        lastUsedAt: new Date(Date.now() - 3600000).toISOString(), // 1小时前
        accountType: 'shared'
      },
      {
        id: 'account-2',
        name: 'Account 2',
        isActive: 'true',
        status: 'active',
        lastUsedAt: new Date(Date.now() - 7200000).toISOString(), // 2小时前
        accountType: 'shared'
      },
      {
        id: 'account-3',
        name: 'Account 3',
        isActive: 'false', // 未激活
        status: 'active',
        accountType: 'shared'
      }
    ]

    test('应该选择最久未使用的可用账户', async () => {
      redis.getAllClaudeAccounts = jest.fn().mockResolvedValue(mockAccounts)

      const result = await claudeAccountService.selectAvailableAccount()

      expect(result).toBe('account-2') // 最久未使用的账户
    })

    test('应该支持sticky会话功能', async () => {
      const sessionHash = 'test-session-hash'
      const mappedAccountId = 'account-1'

      redis.getAllClaudeAccounts = jest.fn().mockResolvedValue(mockAccounts)
      redis.getSessionAccountMapping = jest.fn().mockResolvedValue(mappedAccountId)

      const result = await claudeAccountService.selectAvailableAccount(sessionHash)

      expect(result).toBe(mappedAccountId)
      expect(redis.getSessionAccountMapping).toHaveBeenCalledWith(sessionHash)
    })

    test('应该在mapped账户不可用时选择新账户', async () => {
      const sessionHash = 'test-session-hash'
      const mappedAccountId = 'unavailable-account'

      redis.getAllClaudeAccounts = jest.fn().mockResolvedValue(mockAccounts)
      redis.getSessionAccountMapping = jest.fn().mockResolvedValue(mappedAccountId) // 返回不可用的账户
      redis.deleteSessionAccountMapping = jest.fn().mockResolvedValue(true)
      // 使用新的原子性映射方法
      redis.setSessionAccountMappingAtomic = jest.fn().mockResolvedValue({ success: true, accountId: 'account-2' })

      const result = await claudeAccountService.selectAvailableAccount(sessionHash)

      expect(result).toBe('account-2') // 应该选择新的可用账户
      expect(redis.deleteSessionAccountMapping).toHaveBeenCalledWith(sessionHash)
      // 验证使用了新的原子性方法
      expect(redis.setSessionAccountMappingAtomic).toHaveBeenCalledWith(sessionHash, 'account-2', 3600)
    })

    test('应该过滤掉不支持Opus模型的Pro和Free账号', async () => {
      const accountsWithSubscription = [
        {
          id: 'pro-account',
          name: 'Pro Account',
          isActive: 'true',
          status: 'active',
          subscriptionInfo: JSON.stringify({
            hasClaudePro: true,
            hasClaudeMax: false,
            accountType: 'claude_pro'
          })
        },
        {
          id: 'max-account',
          name: 'Max Account',
          isActive: 'true',
          status: 'active',
          subscriptionInfo: JSON.stringify({
            hasClaudePro: false,
            hasClaudeMax: true,
            accountType: 'claude_max'
          })
        }
      ]

      redis.getAllClaudeAccounts = jest.fn().mockResolvedValue(accountsWithSubscription)

      const result = await claudeAccountService.selectAvailableAccount(null, 'claude-3-opus-20240229')

      expect(result).toBe('max-account') // 只有Max账户支持Opus
    })

    test('应该在没有支持Opus的账户时抛出错误', async () => {
      const proOnlyAccounts = [
        {
          id: 'pro-account-1',
          isActive: 'true',
          status: 'active',
          subscriptionInfo: JSON.stringify({
            accountType: 'claude_pro'
          })
        }
      ]

      redis.getAllClaudeAccounts = jest.fn().mockResolvedValue(proOnlyAccounts)

      await expect(claudeAccountService.selectAvailableAccount(null, 'claude-3-opus-20240229'))
        .rejects.toThrow('No Claude accounts available that support Opus model')
    })

    test('应该在没有可用账户时抛出错误', async () => {
      redis.getAllClaudeAccounts = jest.fn().mockResolvedValue([])

      await expect(claudeAccountService.selectAvailableAccount())
        .rejects.toThrow('No active Claude accounts available')
    })
  })

  describe('API Key专属账户选择', () => {
    const mockApiKeyData = {
      id: 'test-api-key',
      name: 'Test API Key',
      claudeAccountId: null // 没有绑定专属账户
    }

    const mockSharedAccounts = [
      {
        id: 'shared-1',
        name: 'Shared Account 1',
        isActive: 'true',
        status: 'active',
        accountType: 'shared',
        lastUsedAt: new Date(Date.now() - 1800000).toISOString() // 30分钟前
      },
      {
        id: 'shared-2',
        name: 'Shared Account 2',
        isActive: 'true',
        status: 'active',
        accountType: 'shared',
        lastUsedAt: new Date(Date.now() - 3600000).toISOString() // 1小时前
      }
    ]

    test('应该优先使用绑定的专属账户', async () => {
      const dedicatedApiKeyData = {
        ...mockApiKeyData,
        claudeAccountId: 'dedicated-account-id'
      }

      const dedicatedAccount = {
        id: 'dedicated-account-id',
        name: 'Dedicated Account',
        isActive: 'true',
        status: 'active'
      }

      redis.getClaudeAccount.mockReset().mockResolvedValue(dedicatedAccount)

      const result = await claudeAccountService.selectAccountForApiKey(dedicatedApiKeyData)

      expect(result).toBe('dedicated-account-id')
      expect(redis.getClaudeAccount).toHaveBeenCalledWith('dedicated-account-id')
    })

    test('应该在专属账户不可用时fallback到共享池', async () => {
      const dedicatedApiKeyData = {
        ...mockApiKeyData,
        claudeAccountId: 'unavailable-dedicated'
      }

      redis.getClaudeAccount.mockResolvedValue(null) // 专属账户不存在
      redis.getAllClaudeAccounts = jest.fn().mockResolvedValue(mockSharedAccounts)
      
      claudeAccountService.isAccountRateLimited = jest.fn().mockResolvedValue(false)

      const result = await claudeAccountService.selectAccountForApiKey(dedicatedApiKeyData)

      expect(result).toBe('shared-2') // 最久未使用的共享账户
    })

    test('应该正确处理共享账户的限流状态', async () => {
      redis.getAllClaudeAccounts = jest.fn().mockResolvedValue(mockSharedAccounts)
      
      // 第一个账户被限流，第二个账户正常
      claudeAccountService.isAccountRateLimited = jest.fn()
        .mockResolvedValueOnce(true)  // shared-1 被限流
        .mockResolvedValueOnce(false) // shared-2 正常

      claudeAccountService.getAccountRateLimitInfo = jest.fn().mockResolvedValue({
        rateLimitedAt: new Date().toISOString(),
        minutesRemaining: 45
      })

      const result = await claudeAccountService.selectAccountForApiKey(mockApiKeyData)

      expect(result).toBe('shared-2') // 应该选择未被限流的账户
    })

    test('应该在所有共享账户都被限流时选择最早限流的', async () => {
      redis.getAllClaudeAccounts = jest.fn().mockResolvedValue(mockSharedAccounts)
      
      // 所有账户都被限流
      claudeAccountService.isAccountRateLimited = jest.fn().mockResolvedValue(true)
      
      claudeAccountService.getAccountRateLimitInfo = jest.fn()
        .mockResolvedValueOnce({ rateLimitedAt: new Date(Date.now() - 1800000).toISOString() }) // 30分钟前限流
        .mockResolvedValueOnce({ rateLimitedAt: new Date(Date.now() - 3600000).toISOString() }) // 1小时前限流

      const result = await claudeAccountService.selectAccountForApiKey(mockApiKeyData)

      expect(result).toBe('shared-2') // 应该选择最早被限流的账户
    })

    test('应该支持会话粘性并处理限流账户', async () => {
      const sessionHash = 'api-key-session-hash'
      const mappedAccountId = 'shared-1'

      redis.getAllClaudeAccounts = jest.fn().mockResolvedValue(mockSharedAccounts)
      // 使用新的原子性验证方法，返回null表示映射账户无效（被限流）
      redis.getAndValidateSessionMapping = jest.fn().mockResolvedValue(null)
      redis.deleteSessionAccountMapping = jest.fn().mockResolvedValue(true)
      // 使用新的原子性映射方法
      redis.setSessionAccountMappingAtomic = jest.fn().mockResolvedValue({ success: true, accountId: 'shared-2' })
      
      // 映射的账户被限流了
      claudeAccountService.isAccountRateLimited = jest.fn()
        .mockResolvedValueOnce(false) // 新选择的账户正常

      const result = await claudeAccountService.selectAccountForApiKey(mockApiKeyData, sessionHash)

      expect(result).toBe('shared-2') // 应该重新选择账户
      // 验证使用了新的原子性验证方法
      expect(redis.getAndValidateSessionMapping).toHaveBeenCalledWith(sessionHash, ['shared-1', 'shared-2'])
      // 验证使用了新的原子性映射方法
      expect(redis.setSessionAccountMappingAtomic).toHaveBeenCalledWith(sessionHash, 'shared-2', 3600)
    })

    test('应该在没有可用共享账户时抛出错误', async () => {
      redis.getAllClaudeAccounts = jest.fn().mockResolvedValue([])

      await expect(claudeAccountService.selectAccountForApiKey(mockApiKeyData))
        .rejects.toThrow('No active shared Claude accounts available')
    })
  })

  describe('限流状态管理', () => {
    const mockAccountId = 'rate-limit-test-account'
    const mockAccountData = {
      id: mockAccountId,
      name: 'Rate Limit Test Account',
      status: 'active',
      isActive: 'true',
      createdAt: new Date().toISOString()
    }

    // 在每个测试前重置redis mock函数
    beforeEach(() => {
      // 确保Redis mock函数有默认的实现，但不影响具体测试的设置
      redis.getClaudeAccount.mockReset()
      redis.setClaudeAccount.mockResolvedValue('OK')
      redis.getAllClaudeAccounts.mockResolvedValue([])
      redis.deleteClaudeAccount.mockResolvedValue(1)
    })

    test('应该正确标记账户为限流状态（带准确重置时间戳）', async () => {
      const sessionHash = 'test-session-hash'
      const rateLimitResetTimestamp = Math.floor(Date.now() / 1000) + 3600 // 1小时后

      redis.getClaudeAccount.mockResolvedValue(mockAccountData)
      redis.setClaudeAccount.mockResolvedValue(true)
      redis.deleteSessionAccountMapping.mockResolvedValue(true)

      const webhookNotifier = require('../../../src/utils/webhookNotifier')
      webhookNotifier.sendAccountAnomalyNotification = jest.fn().mockResolvedValue(true)

      const result = await claudeAccountService.markAccountRateLimited(
        mockAccountId, 
        sessionHash, 
        rateLimitResetTimestamp
      )

      expect(result).toEqual({ success: true })
      
      expect(redis.setClaudeAccount).toHaveBeenCalledWith(
        mockAccountId,
        expect.objectContaining({
          rateLimitStatus: 'limited',
          rateLimitedAt: expect.any(String),
          rateLimitEndAt: new Date(rateLimitResetTimestamp * 1000).toISOString(),
          sessionWindowStart: expect.any(String),
          sessionWindowEnd: new Date(rateLimitResetTimestamp * 1000).toISOString()
        })
      )

      expect(redis.deleteSessionAccountMapping).toHaveBeenCalledWith(sessionHash)
      expect(webhookNotifier.sendAccountAnomalyNotification).toHaveBeenCalledWith({
        accountId: mockAccountId,
        accountName: mockAccountData.name,
        platform: 'claude-oauth',
        status: 'error',
        errorCode: 'CLAUDE_OAUTH_RATE_LIMITED',
        reason: expect.stringContaining('Account rate limited'),
        timestamp: expect.any(String)
      })
    })

    test('应该使用预估方式标记限流状态（无准确时间戳）', async () => {
      redis.getClaudeAccount.mockResolvedValue(mockAccountData)
      redis.setClaudeAccount = jest.fn().mockResolvedValue(true)
      
      // 直接调用实际的markAccountRateLimited实现
      const result = await claudeAccountService.markAccountRateLimited(mockAccountId)

      expect(result).toEqual({ success: true })
    })

    test('应该成功移除账户的限流状态', async () => {
      const rateLimitedAccountData = {
        ...mockAccountData,
        rateLimitStatus: 'limited',
        rateLimitedAt: new Date().toISOString(),
        rateLimitEndAt: new Date(Date.now() + 3600000).toISOString()
      }

      redis.getClaudeAccount.mockReset().mockResolvedValue(rateLimitedAccountData)
      redis.setClaudeAccount = jest.fn().mockResolvedValue(true)

      const result = await claudeAccountService.removeAccountRateLimit(mockAccountId)

      expect(result).toEqual({ success: true })
      
      const updatedData = redis.setClaudeAccount.mock.calls[0][1]
      expect(updatedData.rateLimitedAt).toBeUndefined()
      expect(updatedData.rateLimitStatus).toBeUndefined()
      expect(updatedData.rateLimitEndAt).toBeUndefined()
    })

    test('应该正确检查账户限流状态', async () => {
      const rateLimitedAccountData = {
        ...mockAccountData,
        rateLimitStatus: 'limited',
        rateLimitedAt: new Date(Date.now() - 1800000).toISOString(), // 30分钟前
        rateLimitEndAt: new Date(Date.now() + 1800000).toISOString()  // 30分钟后结束
      }

      // 使用mockResolvedValue设置特定返回值（支持多次调用）
      redis.getClaudeAccount.mockResolvedValue(rateLimitedAccountData)

      const result = await claudeAccountService.isAccountRateLimited(mockAccountId)
      expect(result).toBe(true)
      expect(redis.getClaudeAccount).toHaveBeenCalledWith(mockAccountId)
    })

    test('应该自动解除过期的限流状态', async () => {
      const expiredRateLimitData = {
        ...mockAccountData,
        rateLimitStatus: 'limited',
        rateLimitedAt: new Date(Date.now() - 7200000).toISOString(), // 2小时前
        rateLimitEndAt: new Date(Date.now() - 1800000).toISOString()  // 30分钟前就应该结束了
      }

      // 使用mockResolvedValue设置特定返回值（支持多次调用）
      redis.getClaudeAccount.mockResolvedValue(expiredRateLimitData)
      
      // 使用spy而不是完全替换方法
      const removeRateLimitSpy = jest.spyOn(claudeAccountService, 'removeAccountRateLimit')
        .mockResolvedValue({ success: true })

      const result = await claudeAccountService.isAccountRateLimited(mockAccountId)

      expect(result).toBe(false)
      expect(removeRateLimitSpy).toHaveBeenCalledWith(mockAccountId)
      expect(redis.getClaudeAccount).toHaveBeenCalledWith(mockAccountId)
      
      // spy会在beforeEach中自动清理，无需手动恢复
    })

    test('应该返回详细的限流信息', async () => {
      const rateLimitedAccountData = {
        ...mockAccountData,
        rateLimitStatus: 'limited',
        rateLimitedAt: new Date(Date.now() - 1800000).toISOString(), // 30分钟前
        rateLimitEndAt: new Date(Date.now() + 2700000).toISOString()  // 45分钟后结束
      }

      // 使用mockResolvedValue设置特定返回值（支持多次调用）
      redis.getClaudeAccount.mockResolvedValue(rateLimitedAccountData)

      const result = await claudeAccountService.getAccountRateLimitInfo(mockAccountId)

      expect(result).toBeTruthy()
      expect(result).toMatchObject({
        isRateLimited: true,
        rateLimitedAt: rateLimitedAccountData.rateLimitedAt,
        minutesSinceRateLimit: expect.any(Number),
        minutesRemaining: expect.any(Number),
        rateLimitEndAt: rateLimitedAccountData.rateLimitEndAt
      })
      expect(redis.getClaudeAccount).toHaveBeenCalledWith(mockAccountId)
    })

    test('应该处理非限流账户的信息查询', async () => {
      const normalAccountData = {
        ...mockAccountData
        // 没有限流相关字段
      }

      // 使用mockResolvedValue设置特定返回值（支持多次调用）
      redis.getClaudeAccount.mockResolvedValue(normalAccountData)

      const result = await claudeAccountService.getAccountRateLimitInfo(mockAccountId)

      expect(result).toBeTruthy()
      expect(result).toMatchObject({
        isRateLimited: false,
        rateLimitedAt: null,
        minutesSinceRateLimit: 0,
        minutesRemaining: 0,
        rateLimitEndAt: null
      })
      expect(redis.getClaudeAccount).toHaveBeenCalledWith(mockAccountId)
    })
  })

  describe('会话窗口管理', () => {
    const mockAccountId = 'session-window-test-account'
    const mockAccountData = {
      id: mockAccountId,
      name: 'Session Window Test Account',
      status: 'active',
      isActive: 'true',
      createdAt: new Date().toISOString()
    }

    // 在每个测试前重置redis mock函数
    beforeEach(() => {
      // 确保Redis mock函数有默认的实现，但不影响具体测试的设置
      redis.getClaudeAccount.mockReset()
      redis.setClaudeAccount.mockResolvedValue('OK')
      redis.getAllClaudeAccounts.mockResolvedValue([])
      redis.deleteClaudeAccount.mockResolvedValue(1)
    })

    test('应该创建新的会话窗口', async () => {
      // 使用深拷贝确保数据不被意外修改
      const accountDataCopy = JSON.parse(JSON.stringify(mockAccountData))
      
      // 使用mockResolvedValue设置特定返回值（支持多次调用）
      redis.getClaudeAccount.mockResolvedValue(accountDataCopy)

      const result = await claudeAccountService.updateSessionWindow(mockAccountId)

      // 验证返回值不为undefined
      expect(result).toBeTruthy()
      expect(result).toMatchObject({
        id: mockAccountId,
        name: 'Session Window Test Account',
        sessionWindowStart: expect.any(String),
        sessionWindowEnd: expect.any(String),
        lastRequestTime: expect.any(String)
      })

      // 验证 Redis 保存操作被调用
      expect(redis.setClaudeAccount).toHaveBeenCalledWith(mockAccountId, expect.objectContaining({
        sessionWindowStart: expect.any(String),
        sessionWindowEnd: expect.any(String),
        lastRequestTime: expect.any(String)
      }))

      // 验证窗口长度为5小时
      const windowStart = new Date(result.sessionWindowStart)
      const windowEnd = new Date(result.sessionWindowEnd)
      const duration = windowEnd.getTime() - windowStart.getTime()
      expect(duration).toBe(5 * 60 * 60 * 1000) // 5小时
    })

    test('应该更新现有活跃窗口的最后请求时间', async () => {
      const now = Date.now()
      const existingWindowData = {
        ...mockAccountData,
        sessionWindowStart: new Date(now - 3600000).toISOString(), // 1小时前开始
        sessionWindowEnd: new Date(now + 14400000).toISOString(),   // 4小时后结束
        lastRequestTime: new Date(now - 1800000).toISOString()      // 30分钟前的请求
      }

      // 使用深拷贝避免引用问题
      const accountDataCopy = JSON.parse(JSON.stringify(existingWindowData))
      
      // 使用mockResolvedValue设置特定返回值（支持多次调用）
      redis.getClaudeAccount.mockResolvedValue(accountDataCopy)

      const result = await claudeAccountService.updateSessionWindow(mockAccountId)

      // 验证返回值不为undefined
      expect(result).toBeTruthy()
      expect(result.sessionWindowStart).toBe(existingWindowData.sessionWindowStart) // 开始时间不变
      expect(result.sessionWindowEnd).toBe(existingWindowData.sessionWindowEnd)     // 结束时间不变
      expect(new Date(result.lastRequestTime).getTime()).toBeGreaterThanOrEqual(
        new Date(existingWindowData.lastRequestTime).getTime()
      ) // 最后请求时间应该更新（允许相等以避免时序问题）
    })

    test('应该清除过期的会话窗口', async () => {
      const now = Date.now()
      // 使用一个不在同一小时的过期时间来避免整点时间重叠
      const yesterdayMorning = now - 25 * 60 * 60 * 1000 // 25小时前
      const expiredWindowData = {
        ...mockAccountData,
        sessionWindowStart: new Date(yesterdayMorning).toISOString(),
        sessionWindowEnd: new Date(yesterdayMorning + 5 * 60 * 60 * 1000).toISOString(), // 5小时后结束
        lastRequestTime: new Date(yesterdayMorning + 1000).toISOString()
      }

      // 使用深拷贝避免对象引用问题
      const accountDataCopy = JSON.parse(JSON.stringify(expiredWindowData))
      
      // 使用mockResolvedValue设置特定返回值（支持多次调用）
      redis.getClaudeAccount.mockResolvedValue(accountDataCopy)

      const result = await claudeAccountService.updateSessionWindow(mockAccountId)

      // 验证返回值不为undefined
      expect(result).toBeTruthy()
      // 验证 Redis 操作被调用
      expect(redis.setClaudeAccount).toHaveBeenCalledWith(mockAccountId, expect.any(Object))

      // 验证创建了新窗口的基本属性
      expect(result).toMatchObject({
        id: mockAccountId,
        name: 'Session Window Test Account',
        sessionWindowStart: expect.any(String),
        sessionWindowEnd: expect.any(String),
        lastRequestTime: expect.any(String)
      })
      
      // 验证窗口持续时间为5小时
      const newStartTime = new Date(result.sessionWindowStart).getTime()
      const newEndTime = new Date(result.sessionWindowEnd).getTime()
      expect(newEndTime - newStartTime).toBe(5 * 60 * 60 * 1000)
      
      // 验证新窗口的开始时间在合理范围内（当前时间附近）
      const currentHour = new Date(now)
      currentHour.setMinutes(0)
      currentHour.setSeconds(0)
      currentHour.setMilliseconds(0)
      expect(result.sessionWindowStart).toBe(currentHour.toISOString())
    })

    test('应该正确计算会话窗口信息', async () => {
      const now = new Date()
      const windowStart = new Date(now.getTime() - 2 * 3600000) // 2小时前开始
      const windowEnd = new Date(now.getTime() + 3 * 3600000)   // 3小时后结束

      const activeWindowData = {
        ...mockAccountData,
        sessionWindowStart: windowStart.toISOString(),
        sessionWindowEnd: windowEnd.toISOString(),
        lastRequestTime: new Date(now.getTime() - 900000).toISOString() // 15分钟前请求
      }

      // 使用深拷贝避免引用问题
      const accountDataCopy = JSON.parse(JSON.stringify(activeWindowData))
      
      // 使用mockResolvedValue设置特定返回值（支持多次调用）
      redis.getClaudeAccount.mockResolvedValue(accountDataCopy)

      const result = await claudeAccountService.getSessionWindowInfo(mockAccountId)

      // 验证返回值不为undefined
      expect(result).toBeTruthy()
      expect(result).toMatchObject({
        hasActiveWindow: true,
        windowStart: windowStart.toISOString(),
        windowEnd: windowEnd.toISOString(),
        progress: 40, // 2小时/5小时 = 40%
        remainingTime: 180, // 3小时 = 180分钟
        lastRequestTime: activeWindowData.lastRequestTime
      })
    })

    test('应该处理过期会话窗口的信息查询', async () => {
      const expiredWindowData = {
        ...mockAccountData,
        sessionWindowStart: new Date(Date.now() - 21600000).toISOString(), // 6小时前开始
        sessionWindowEnd: new Date(Date.now() - 3600000).toISOString(),     // 1小时前结束
        lastRequestTime: new Date(Date.now() - 3600000).toISOString()
      }

      // 使用深拷贝避免引用问题
      const accountDataCopy = JSON.parse(JSON.stringify(expiredWindowData))
      
      // 使用mockResolvedValue设置特定返回值（支持多次调用）
      redis.getClaudeAccount.mockResolvedValue(accountDataCopy)

      const result = await claudeAccountService.getSessionWindowInfo(mockAccountId)

      // 验证返回值不为undefined
      expect(result).toBeTruthy()
      expect(result).toMatchObject({
        hasActiveWindow: false,
        windowStart: expiredWindowData.sessionWindowStart,
        windowEnd: expiredWindowData.sessionWindowEnd,
        progress: 100,
        remainingTime: 0,
        lastRequestTime: expiredWindowData.lastRequestTime
      })
    })

    test('应该处理没有会话窗口的账户', async () => {
      const accountWithoutWindow = {
        id: mockAccountId,
        name: 'Session Window Test Account'
        // 没有 sessionWindowStart, sessionWindowEnd, lastRequestTime 字段
      }
      
      // 使用深拷贝避免引用问题
      const accountDataCopy = JSON.parse(JSON.stringify(accountWithoutWindow))
      
      // 使用mockResolvedValue设置特定返回值（支持多次调用）
      redis.getClaudeAccount.mockResolvedValue(accountDataCopy)

      const result = await claudeAccountService.getSessionWindowInfo(mockAccountId)

      // 验证返回值不为undefined
      expect(result).toBeTruthy()
      expect(result).toMatchObject({
        hasActiveWindow: false,
        windowStart: null,
        windowEnd: null,
        progress: 0,
        remainingTime: null,
        lastRequestTime: null
      })
    })

    test('应该初始化所有账户的会话窗口', async () => {
      const mockAccounts = [
        {
          id: 'account-1',
          name: 'Account 1',
          sessionWindowStart: new Date(Date.now() - 1800000).toISOString(), // 30分钟前开始
          sessionWindowEnd: new Date(Date.now() + 16200000).toISOString()    // 4.5小时后结束 - 有效窗口
        },
        {
          id: 'account-2', 
          name: 'Account 2',
          sessionWindowStart: new Date(Date.now() - 21600000).toISOString(), // 6小时前开始
          sessionWindowEnd: new Date(Date.now() - 3600000).toISOString()     // 1小时前结束 - 过期窗口
        },
        {
          id: 'account-3',
          name: 'Account 3'
          // 没有会话窗口
        }
      ]

      redis.getAllClaudeAccounts = jest.fn().mockResolvedValue(mockAccounts)
      redis.setClaudeAccount = jest.fn().mockResolvedValue(true)

      const result = await claudeAccountService.initializeSessionWindows()

      expect(result).toMatchObject({
        total: 3,
        validWindows: 1,
        expiredWindows: 1,
        noWindows: 1
      })

      // 应该清除过期的窗口
      expect(redis.setClaudeAccount).toHaveBeenCalledWith(
        'account-2',
        expect.not.objectContaining({
          sessionWindowStart: expect.anything(),
          sessionWindowEnd: expect.anything()
        })
      )
    })

    test('应该支持强制重新计算所有会话窗口', async () => {
      const mockAccounts = [
        {
          id: 'account-1',
          name: 'Account 1',
          sessionWindowStart: new Date(Date.now() - 1800000).toISOString(),
          sessionWindowEnd: new Date(Date.now() + 16200000).toISOString()
        }
      ]

      redis.getAllClaudeAccounts = jest.fn().mockResolvedValue(mockAccounts)
      redis.setClaudeAccount = jest.fn().mockResolvedValue(true)

      const result = await claudeAccountService.initializeSessionWindows(true) // 强制重算

      expect(result.noWindows).toBe(1) // 所有窗口都被清除了
      expect(redis.setClaudeAccount).toHaveBeenCalledWith(
        'account-1',
        expect.not.objectContaining({
          sessionWindowStart: expect.anything(),
          sessionWindowEnd: expect.anything()
        })
      )
    })
  })

  describe('Profile和订阅信息管理', () => {
    const mockAccountId = 'profile-test-account'
    const mockAccountData = {
      id: mockAccountId,
      name: 'Profile Test Account',
      scopes: 'user:profile claude:chat',
      accessToken: claudeAccountService._encryptSensitiveData('test-access-token'),
      proxy: JSON.stringify({ type: 'socks5', host: '127.0.0.1', port: 1080 })
    }

    test('应该成功获取和更新账户Profile信息', async () => {
      const mockProfileResponse = {
        status: 200,
        data: {
          account: {
            email: 'profile@example.com',
            full_name: 'Test User',
            display_name: 'Test',
            has_claude_max: true,
            has_claude_pro: false,
            uuid: 'account-uuid-123'
          },
          organization: {
            name: 'Test Organization',
            uuid: 'org-uuid-456',
            billing_type: 'subscription',
            rate_limit_tier: 'tier_2',
            organization_type: 'team'
          }
        }
      }

      redis.getClaudeAccount.mockResolvedValue(mockAccountData)
      redis.setClaudeAccount = jest.fn().mockResolvedValue(true)
      axios.get.mockResolvedValue(mockProfileResponse)

      const result = await claudeAccountService.fetchAndUpdateAccountProfile(mockAccountId)

      expect(result).toMatchObject({
        email: 'profile@example.com',
        fullName: 'Test User',
        displayName: 'Test',
        hasClaudeMax: true,
        hasClaudePro: false,
        accountType: 'claude_max',
        organizationName: 'Test Organization',
        billingType: 'subscription',
        rateLimitTier: 'tier_2'
      })

      expect(redis.setClaudeAccount).toHaveBeenCalledWith(
        mockAccountId,
        expect.objectContaining({
          subscriptionInfo: expect.any(String),
          profileUpdatedAt: expect.any(String),
          email: expect.any(String) // 应该被加密存储
        })
      )
    })

    test('应该处理没有user:profile权限的账户', async () => {
      const noProfileScopeAccount = {
        ...mockAccountData,
        scopes: 'claude:chat' // 没有user:profile权限
      }

      redis.getClaudeAccount.mockReset().mockResolvedValue(noProfileScopeAccount)

      await expect(claudeAccountService.fetchAndUpdateAccountProfile(mockAccountId))
        .rejects.toThrow('Account does not have user:profile permission')
    })

    test('应该处理Profile API的401错误', async () => {
      redis.getClaudeAccount.mockResolvedValue(mockAccountData)
      
      const profileError = new Error('API Error')
      profileError.response = { status: 401 }
      axios.get.mockRejectedValue(profileError)

      await expect(claudeAccountService.fetchAndUpdateAccountProfile(mockAccountId))
        .rejects.toThrow('API Error')
    })

    test('应该处理Profile API的403错误', async () => {
      redis.getClaudeAccount.mockResolvedValue(mockAccountData)
      
      const profileError = new Error('Forbidden')
      profileError.response = { status: 403 }
      axios.get.mockRejectedValue(profileError)

      await expect(claudeAccountService.fetchAndUpdateAccountProfile(mockAccountId))
        .rejects.toThrow('Forbidden')
    })

    test('应该批量更新所有账户的Profile信息', async () => {
      const mockAccounts = [
        {
          id: 'account-1',
          name: 'Account 1',
          isActive: 'true',
          status: 'active',
          scopes: 'user:profile claude:chat'
        },
        {
          id: 'account-2',
          name: 'Account 2',
          isActive: 'false', // 未激活，应该跳过
          status: 'active',
          scopes: 'user:profile claude:chat'
        },
        {
          id: 'account-3',
          name: 'Account 3',
          isActive: 'true',
          status: 'active',
          scopes: 'claude:chat' // 没有profile权限，应该跳过
        }
      ]

      redis.getAllClaudeAccounts = jest.fn().mockResolvedValue(mockAccounts)
      
      claudeAccountService.getValidAccessToken = jest.fn().mockResolvedValue('valid-token')
      claudeAccountService.fetchAndUpdateAccountProfile = jest.fn().mockResolvedValue({
        accountType: 'claude_max'
      })

      const result = await claudeAccountService.updateAllAccountProfiles()

      expect(result).toMatchObject({
        totalAccounts: 3,
        successCount: 1,
        failureCount: 0,
        results: [
          {
            accountId: 'account-1',
            accountName: 'Account 1',
            success: true,
            accountType: 'claude_max'
          },
          {
            accountId: 'account-3',
            accountName: 'Account 3',
            success: false,
            error: 'No user:profile permission (Setup Token account)'
          }
        ]
      })

      expect(claudeAccountService.fetchAndUpdateAccountProfile).toHaveBeenCalledTimes(1)
      expect(claudeAccountService.fetchAndUpdateAccountProfile).toHaveBeenCalledWith('account-1', 'valid-token')
    })

    test('应该在批量更新中处理个别账户的错误', async () => {
      const mockAccounts = [
        {
          id: 'success-account',
          name: 'Success Account',
          isActive: 'true',
          status: 'active',
          scopes: 'user:profile claude:chat'
        },
        {
          id: 'error-account',
          name: 'Error Account',
          isActive: 'true',
          status: 'active',
          scopes: 'user:profile claude:chat'
        }
      ]

      redis.getAllClaudeAccounts = jest.fn().mockResolvedValue(mockAccounts)
      
      claudeAccountService.getValidAccessToken = jest.fn().mockResolvedValue('valid-token')
      claudeAccountService.fetchAndUpdateAccountProfile = jest.fn()
        .mockResolvedValueOnce({ accountType: 'claude_pro' }) // 第一个成功
        .mockRejectedValueOnce(new Error('Profile fetch failed')) // 第二个失败

      const result = await claudeAccountService.updateAllAccountProfiles()

      expect(result).toMatchObject({
        successCount: 1,
        failureCount: 1,
        results: expect.arrayContaining([
          expect.objectContaining({ success: true }),
          expect.objectContaining({ success: false, error: 'Profile fetch failed' })
        ])
      })
    })
  })

  describe('账户状态管理', () => {
    const mockAccountId = 'status-test-account'
    const mockAccountData = {
      id: mockAccountId,
      name: 'Status Test Account',
      status: 'active',
      schedulable: 'true'
    }

    test('应该标记账户为未授权状态', async () => {
      const sessionHash = 'test-session-hash'

      redis.getClaudeAccount.mockResolvedValue(mockAccountData)
      redis.setClaudeAccount = jest.fn().mockResolvedValue(true)
      redis.client = { del: jest.fn().mockResolvedValue(1) }

      const webhookNotifier = require('../../../src/utils/webhookNotifier')
      webhookNotifier.sendAccountAnomalyNotification = jest.fn().mockResolvedValue(true)

      const result = await claudeAccountService.markAccountUnauthorized(mockAccountId, sessionHash)

      expect(result).toEqual({ success: true })
      
      expect(redis.setClaudeAccount).toHaveBeenCalledWith(
        mockAccountId,
        expect.objectContaining({
          status: 'unauthorized',
          schedulable: 'false',
          errorMessage: 'Account unauthorized (401 errors detected)',
          unauthorizedAt: expect.any(String)
        })
      )

      expect(redis.client.del).toHaveBeenCalledWith(`sticky_session:${sessionHash}`)
      
      expect(webhookNotifier.sendAccountAnomalyNotification).toHaveBeenCalledWith({
        accountId: mockAccountId,
        accountName: mockAccountData.name,
        platform: 'claude-oauth',
        status: 'unauthorized',
        errorCode: 'CLAUDE_OAUTH_UNAUTHORIZED',
        reason: 'Account unauthorized (401 errors detected)'
      })
    })

    test('应该重置账户的所有异常状态', async () => {
      const errorAccountData = {
        ...mockAccountData,
        status: 'unauthorized',
        schedulable: 'false',
        errorMessage: 'Some error',
        unauthorizedAt: new Date().toISOString(),
        rateLimitedAt: new Date().toISOString(),
        rateLimitStatus: 'limited',
        rateLimitEndAt: new Date().toISOString(),
        accessToken: claudeAccountService._encryptSensitiveData('test-token')
      }

      redis.getClaudeAccount.mockReset().mockResolvedValue(errorAccountData)
      redis.setClaudeAccount = jest.fn().mockResolvedValue(true)
      redis.client = { del: jest.fn().mockResolvedValue(1) }

      const result = await claudeAccountService.resetAccountStatus(mockAccountId)

      expect(result).toMatchObject({
        success: true,
        account: {
          id: mockAccountId,
          name: mockAccountData.name,
          status: 'active', // 有accessToken，应该设为active
          schedulable: true
        }
      })

      const updatedData = redis.setClaudeAccount.mock.calls[0][1]
      expect(updatedData.status).toBe('active')
      expect(updatedData.schedulable).toBe('true')
      expect(updatedData.errorMessage).toBeUndefined()
      expect(updatedData.unauthorizedAt).toBeUndefined()
      expect(updatedData.rateLimitedAt).toBeUndefined()
      expect(updatedData.rateLimitStatus).toBeUndefined()
      expect(updatedData.rateLimitEndAt).toBeUndefined()

      // 应该清除错误计数和限流状态
      expect(redis.client.del).toHaveBeenCalledWith(`claude_account:${mockAccountId}:401_errors`)
      expect(redis.client.del).toHaveBeenCalledWith(`ratelimit:${mockAccountId}`)
    })

    test('应该为没有accessToken的账户设置created状态', async () => {
      const noTokenAccountData = {
        ...mockAccountData,
        status: 'error',
        accessToken: '' // 没有access token
      }

      redis.getClaudeAccount.mockReset().mockResolvedValue(noTokenAccountData)
      redis.setClaudeAccount = jest.fn().mockResolvedValue(true)
      redis.client = { del: jest.fn().mockResolvedValue(1) }

      const result = await claudeAccountService.resetAccountStatus(mockAccountId)

      expect(result.account.status).toBe('created') // 没有token，应该设为created
    })

    test('应该清理错误账户状态', async () => {
      const mockAccounts = [
        {
          id: 'recent-error',
          status: 'error',
          lastRefreshAt: new Date(Date.now() - 1800000).toISOString() // 30分钟前，不应该清理
        },
        {
          id: 'old-error',
          status: 'error',
          lastRefreshAt: new Date(Date.now() - 25 * 3600000).toISOString() // 25小时前，应该清理
        },
        {
          id: 'normal-account',
          status: 'active'
        }
      ]

      redis.getAllClaudeAccounts = jest.fn().mockResolvedValue(mockAccounts)
      redis.setClaudeAccount = jest.fn().mockResolvedValue(true)

      const result = await claudeAccountService.cleanupErrorAccounts()

      expect(result).toBe(1) // 清理了1个账户

      expect(redis.setClaudeAccount).toHaveBeenCalledWith(
        'old-error',
        expect.objectContaining({
          status: 'created',
          errorMessage: ''
        })
      )
    })
  })

  describe('工具和辅助方法', () => {
    test('应该正确掩码邮箱地址', () => {
      const email1 = 'user@example.com'
      const masked1 = claudeAccountService._maskEmail(email1)
      expect(masked1).toBe('us***r@example.com')

      const email2 = 'a@test.com'
      const masked2 = claudeAccountService._maskEmail(email2)
      expect(masked2).toBe('a***@test.com')

      const email3 = 'ab@domain.org'
      const masked3 = claudeAccountService._maskEmail(email3)
      expect(masked3).toBe('a***@domain.org')
    })

    test('应该处理无效邮箱格式', () => {
      expect(claudeAccountService._maskEmail('')).toBe('')
      expect(claudeAccountService._maskEmail(null)).toBe(null)
      expect(claudeAccountService._maskEmail('invalid-email')).toBe('invalid-email')
    })

    test('应该获取迁移统计信息', async () => {
      const mockMigrationKeys = [
        'migration_needed:hash1',
        'migration_needed:hash2',
        'migration_needed:hash3'
      ]

      redis.keys = jest.fn().mockResolvedValue(mockMigrationKeys)

      const result = await claudeAccountService.getMigrationStats()

      expect(result).toEqual({
        totalItemsNeedingMigration: 3,
        migrationKeys: mockMigrationKeys
      })
    })

    test('应该处理获取迁移统计时的错误', async () => {
      redis.keys = jest.fn().mockRejectedValue(new Error('Redis error'))

      const result = await claudeAccountService.getMigrationStats()

      expect(result).toEqual({
        totalItemsNeedingMigration: 0,
        migrationKeys: []
      })
    })

    test('应该正确执行安全清理', () => {
      // 先直接向缓存添加数据来模拟有缓存的情况
      claudeAccountService._decryptCache.set('test-key-1', 'test-value-1')
      claudeAccountService._decryptCache.set('test-key-2', 'test-value-2')
      
      // 检查缓存是否有数据
      const initialCacheSize = claudeAccountService._decryptCache.cache.size
      expect(initialCacheSize).toBeGreaterThan(0)

      // 执行安全清理
      claudeAccountService._performSecurityCleanup()

      // 验证缓存被清空
      const cacheAfterCleanup = claudeAccountService._decryptCache.cache
      expect(cacheAfterCleanup).toBeDefined()
      expect(cacheAfterCleanup.size).toBe(0)
    })

    test('应该正确识别敏感数据', () => {
      // 短数据 - 非敏感
      expect(claudeAccountService._isSensitiveData('short')).toBe(false)
      
      // 长数据 - 敏感
      const longData = 'a'.repeat(200)
      expect(claudeAccountService._isSensitiveData(longData)).toBe(true)
      
      // 包含token特征 - 敏感
      expect(claudeAccountService._isSensitiveData('bearer_token_data')).toBe(true)
      expect(claudeAccountService._isSensitiveData('oauth_credential')).toBe(true)
      
      // 32字符hex IV格式 - 敏感
      const hexFormat = '0123456789abcdef0123456789abcdef:encrypted_data'
      expect(claudeAccountService._isSensitiveData(hexFormat)).toBe(true)
    })
  })

  describe('错误处理和边界条件', () => {
    // 在每个测试前重置redis mock函数
    beforeEach(() => {
      // 确保Redis mock函数有默认的实现
      redis.getClaudeAccount.mockResolvedValue(null)
      redis.setClaudeAccount.mockResolvedValue('OK')
      redis.getAllClaudeAccounts.mockResolvedValue([])
      redis.deleteClaudeAccount.mockResolvedValue(1)
    })

    test('应该处理Redis连接错误', async () => {
      redis.getClaudeAccount.mockReset().mockRejectedValue(new Error('Redis connection failed'))

      const result = await claudeAccountService.getAccount('test-id')
      expect(result).toBeNull()
    })

    test('应该处理加密配置错误', () => {
      const originalSalt = mockConfig.security.encryptionSalt
      mockConfig.security.encryptionSalt = 'CHANGE-THIS-ENCRYPTION-SALT-NOW'

      expect(() => {
        claudeAccountService._generateEncryptionKey()
      }).toThrow('Encryption salt must be configured with a secure random value')

      mockConfig.security.encryptionSalt = originalSalt
    })

    test('应该处理空账户数据', async () => {
      redis.getAllClaudeAccounts = jest.fn().mockResolvedValue([])

      await expect(claudeAccountService.selectAvailableAccount())
        .rejects.toThrow('No active Claude accounts available')
    })

    test('应该处理解密错误', () => {
      const originalCreateDecipheriv = crypto.createDecipheriv
      crypto.createDecipheriv = jest.fn().mockImplementation(() => {
        throw new Error('Decryption failed')
      })

      const result = claudeAccountService._decryptSensitiveData('invalid:encrypted')
      expect(result).toBe('[DECRYPTION_ERROR_OCCURRED]')

      crypto.createDecipheriv = originalCreateDecipheriv
    })

    test('应该处理账户创建时的UUID生成错误', async () => {
      uuidv4.mockImplementation(() => {
        throw new Error('UUID generation failed')
      })

      await expect(claudeAccountService.createAccount({ name: 'Test' }))
        .rejects.toThrow('UUID generation failed')
    })

    test('应该处理超时的HTTP请求', async () => {
      const timeoutError = new Error('Request timeout')
      timeoutError.code = 'ECONNABORTED'
      
      const mockAccountData = {
        id: 'timeout-account',
        name: 'Timeout Account',
        refreshToken: claudeAccountService._encryptSensitiveData('refresh-token')
      }

      // 缺保数据完整性
      const accountDataCopy = JSON.parse(JSON.stringify(mockAccountData))
      redis.getClaudeAccount.mockResolvedValue(accountDataCopy)
      redis.setClaudeAccount.mockResolvedValue(true)
      
      // 确保token服务正确mock
      const tokenRefreshService = require('../../../src/services/tokenRefreshService')
      tokenRefreshService.acquireRefreshLock = jest.fn().mockResolvedValue(true)
      tokenRefreshService.releaseRefreshLock = jest.fn().mockResolvedValue(true)
      
      // axios mock需要在最后设置，避免被其他测试干扰
      axios.post.mockRejectedValueOnce(timeoutError)

      await expect(claudeAccountService.refreshAccountToken('timeout-account'))
        .rejects.toThrow('Request timeout')
        
      // 验证锁被正确释放
      expect(tokenRefreshService.releaseRefreshLock).toHaveBeenCalledWith('timeout-account', 'claude')
    })
  })

  describe('性能和缓存测试', () => {
    test('应该缓存加密密钥以提高性能', () => {
      const start1 = Date.now()
      claudeAccountService._generateEncryptionKey()
      const time1 = Date.now() - start1

      const start2 = Date.now()
      claudeAccountService._generateEncryptionKey()
      const time2 = Date.now() - start2

      // 第二次调用应该明显更快（使用缓存）
      expect(time2).toBeLessThan(time1)
      expect(claudeAccountService._encryptionKeyCache).toBeTruthy()
    })

    test('应该正确管理解密缓存大小', () => {
      // 直接向缓存添加多个数据项来测试缓存管理
      for (let i = 0; i < 10; i++) {
        claudeAccountService._decryptCache.set(`test-key-${i}`, `test-value-${i}`)
      }

      // 验证缓存有合理的大小
      const cache = claudeAccountService._decryptCache.cache
      expect(cache).toBeDefined()
      const cacheSize = cache.size
      expect(cacheSize).toBe(10)
    })

    test('应该在大量操作后正确清理缓存', () => {
      // 执行大量加密操作
      for (let i = 0; i < 100; i++) {
        claudeAccountService._encryptSensitiveData(`data-${i}`)
      }

      // 手动触发清理
      claudeAccountService._performSecurityCleanup()

      // 验证缓存被清空
      expect(claudeAccountService._decryptCache.cache.size).toBe(0)
    })
  })
})