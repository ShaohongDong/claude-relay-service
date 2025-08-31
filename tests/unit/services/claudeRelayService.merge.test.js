/**
 * ClaudeRelayService Merge功能单元测试
 * 测试merge冲突解决后的功能：错误消息优化
 */

const claudeRelayService = require('../../../src/services/claudeRelayService')
const claudeAccountService = require('../../../src/services/claudeAccountService')
const unifiedClaudeScheduler = require('../../../src/services/unifiedClaudeScheduler')
const sessionHelper = require('../../../src/utils/sessionHelper')
const redis = require('../../../src/models/redis')
const logger = require('../../../src/utils/logger')

// Mock所有外部依赖
jest.mock('../../../src/services/claudeAccountService')
jest.mock('../../../src/services/unifiedClaudeScheduler')
jest.mock('../../../src/utils/sessionHelper')
jest.mock('../../../src/models/redis')
jest.mock('../../../src/utils/logger')
jest.mock('../../../src/services/claudeCodeHeadersService')

describe('ClaudeRelayService Merge功能测试', () => {
  let mockClaudeAccountService
  let mockUnifiedClaudeScheduler
  let mockSessionHelper
  let mockRedis

  const testAccountId = 'test-account-123'
  const testApiKeyData = {
    id: 'test-key-id',
    name: 'Test API Key',
    enableModelRestriction: false,
    restrictedModels: []
  }

  const testRequestBody = {
    model: 'claude-3-sonnet',
    messages: [{ role: 'user', content: 'Hello' }],
    max_tokens: 1000
  }

  const testSessionHash = 'test-session-hash-123'

  beforeEach(() => {
    jest.clearAllMocks()

    // Mock claude account service
    mockClaudeAccountService = {
      getValidAccessToken: jest.fn().mockResolvedValue('mock-access-token'),
      recordServerError: jest.fn().mockResolvedValue(),
      getServerErrorCount: jest.fn().mockResolvedValue(0),
      markAccountTempError: jest.fn().mockResolvedValue(),
      clearInternalErrors: jest.fn().mockResolvedValue(),
      updateSessionWindowStatus: jest.fn().mockResolvedValue()
    }
    Object.assign(claudeAccountService, mockClaudeAccountService)

    // Mock unified scheduler
    mockUnifiedClaudeScheduler = {
      selectAccountForApiKey: jest.fn().mockResolvedValue({
        accountId: testAccountId,
        accountType: 'claude'
      }),
      markAccountUnauthorized: jest.fn().mockResolvedValue(),
      markAccountRateLimited: jest.fn().mockResolvedValue(),
      removeAccountRateLimit: jest.fn().mockResolvedValue(),
      isAccountRateLimited: jest.fn().mockResolvedValue(false)
    }
    Object.assign(unifiedClaudeScheduler, mockUnifiedClaudeScheduler)

    // Mock session helper
    mockSessionHelper = {
      generateSessionHash: jest.fn().mockReturnValue(testSessionHash)
    }
    Object.assign(sessionHelper, mockSessionHelper)

    // Mock Redis client
    mockRedis = {
      client: {
        incr: jest.fn().mockResolvedValue(1),
        expire: jest.fn().mockResolvedValue(true),
        get: jest.fn().mockResolvedValue('1'),
        del: jest.fn().mockResolvedValue(1)
      }
    }
    Object.assign(redis, mockRedis)

    // Mock the _getProxyAgent method
    claudeRelayService._getProxyAgent = jest.fn().mockResolvedValue(null)

    // Mock the _makeClaudeRequest method
    claudeRelayService._makeClaudeRequest = jest.fn()
  })

  describe('relayRequest - 401错误处理和错误消息优化测试', () => {
    test('应该使用优化后的401错误消息', async () => {
      // Mock 401响应
      const mock401Response = {
        statusCode: 401,
        headers: {},
        body: JSON.stringify({ error: 'Unauthorized' })
      }

      claudeRelayService._makeClaudeRequest.mockResolvedValue(mock401Response)

      // Mock错误计数为1，触发标记为未授权
      mockRedis.client.get.mockResolvedValue('1')

      // Mock账户切换重试失败
      claudeRelayService._retryWithAccountSwitch = jest.fn().mockRejectedValue(
        new Error('All retries failed')
      )

      try {
        await claudeRelayService.relayRequest(
          testRequestBody,
          testApiKeyData,
          null, // clientRequest
          null, // clientResponse
          { 'user-agent': 'test-client' }
        )
      } catch (error) {
        // 预期会抛出错误，因为重试失败
      }

      // 验证使用了正确的错误消息
      expect(logger.error).toHaveBeenCalledWith(
        `❌ Account ${testAccountId} encountered 401 error (1 errors), marking as unauthorized and attempting account switch`
      )

      // 验证账户被标记为未授权
      expect(mockUnifiedClaudeScheduler.markAccountUnauthorized).toHaveBeenCalledWith(
        testAccountId,
        'claude',
        testSessionHash
      )

      // 验证尝试了账户切换重试
      expect(claudeRelayService._retryWithAccountSwitch).toHaveBeenCalled()
    })

    test('应该记录401错误并递增计数', async () => {
      const mock401Response = {
        statusCode: 401,
        headers: {},
        body: JSON.stringify({ error: 'Unauthorized' })
      }

      claudeRelayService._makeClaudeRequest.mockResolvedValue(mock401Response)

      // Mock错误计数递增
      mockRedis.client.incr.mockResolvedValue(1)
      mockRedis.client.get.mockResolvedValue('1')

      // Mock账户切换重试成功
      claudeRelayService._retryWithAccountSwitch = jest.fn().mockResolvedValue({
        statusCode: 200,
        body: JSON.stringify({ content: [{ text: 'Success' }] })
      })

      const result = await claudeRelayService.relayRequest(
        testRequestBody,
        testApiKeyData,
        null,
        null,
        { 'user-agent': 'test-client' }
      )

      // 验证401错误被正确记录
      expect(mockRedis.client.incr).toHaveBeenCalledWith(`claude_account:${testAccountId}:401_errors`)
      expect(mockRedis.client.expire).toHaveBeenCalledWith(`claude_account:${testAccountId}:401_errors`, 300)

      // 验证错误消息格式
      expect(logger.error).toHaveBeenCalledWith(
        `❌ Account ${testAccountId} encountered 401 error (1 errors), marking as unauthorized and attempting account switch`
      )

      // 验证成功重试后的消息
      expect(logger.info).toHaveBeenCalledWith(
        `✅ Account switch retry successful for 401 error - API Key: ${testApiKeyData.name}`
      )
    })

    test('错误消息应该包含正确的错误计数', async () => {
      const mock401Response = {
        statusCode: 401,
        headers: {},
        body: JSON.stringify({ error: 'Unauthorized' })
      }

      claudeRelayService._makeClaudeRequest.mockResolvedValue(mock401Response)

      // 设置不同的错误计数
      mockRedis.client.get.mockResolvedValue('3')

      // Mock重试失败
      claudeRelayService._retryWithAccountSwitch = jest.fn().mockRejectedValue(
        new Error('Retry failed')
      )

      try {
        await claudeRelayService.relayRequest(
          testRequestBody,
          testApiKeyData,
          null,
          null,
          { 'user-agent': 'test-client' }
        )
      } catch (error) {
        // 预期错误
      }

      // 验证错误消息包含正确的计数
      expect(logger.error).toHaveBeenCalledWith(
        `❌ Account ${testAccountId} encountered 401 error (3 errors), marking as unauthorized and attempting account switch`
      )
    })

    test('应该在错误阈值达到时记录信息日志', async () => {
      const mock401Response = {
        statusCode: 401,
        headers: {},
        body: JSON.stringify({ error: 'Unauthorized' })
      }

      claudeRelayService._makeClaudeRequest.mockResolvedValue(mock401Response)
      mockRedis.client.get.mockResolvedValue('2')

      // Mock重试成功
      claudeRelayService._retryWithAccountSwitch = jest.fn().mockResolvedValue({
        statusCode: 200,
        body: JSON.stringify({ content: [{ text: 'Success' }] })
      })

      await claudeRelayService.relayRequest(
        testRequestBody,
        testApiKeyData,
        null,
        null,
        { 'user-agent': 'test-client' }
      )

      // 验证信息日志包含正确的错误计数
      expect(logger.info).toHaveBeenCalledWith(
        `🔐 Account ${testAccountId} has 2 consecutive 401 errors in the last 5 minutes`
      )
    })
  })

  describe('recordUnauthorizedError - 错误记录功能测试', () => {
    test('应该正确记录401错误', async () => {
      await claudeRelayService.recordUnauthorizedError(testAccountId)

      expect(mockRedis.client.incr).toHaveBeenCalledWith(`claude_account:${testAccountId}:401_errors`)
      expect(mockRedis.client.expire).toHaveBeenCalledWith(`claude_account:${testAccountId}:401_errors`, 300)
      expect(logger.info).toHaveBeenCalledWith(`📝 Recorded 401 error for account ${testAccountId}`)
    })

    test('应该处理Redis错误', async () => {
      const redisError = new Error('Redis connection failed')
      mockRedis.client.incr.mockRejectedValue(redisError)

      await claudeRelayService.recordUnauthorizedError(testAccountId)

      expect(logger.error).toHaveBeenCalledWith(
        `❌ Failed to record 401 error for account ${testAccountId}:`,
        redisError
      )
    })
  })

  describe('getUnauthorizedErrorCount - 错误计数获取测试', () => {
    test('应该返回正确的错误计数', async () => {
      mockRedis.client.get.mockResolvedValue('5')

      const count = await claudeRelayService.getUnauthorizedErrorCount(testAccountId)

      expect(count).toBe(5)
      expect(mockRedis.client.get).toHaveBeenCalledWith(`claude_account:${testAccountId}:401_errors`)
    })

    test('应该为null值返回0', async () => {
      mockRedis.client.get.mockResolvedValue(null)

      const count = await claudeRelayService.getUnauthorizedErrorCount(testAccountId)

      expect(count).toBe(0)
    })

    test('应该处理Redis错误', async () => {
      const redisError = new Error('Redis get failed')
      mockRedis.client.get.mockRejectedValue(redisError)

      const count = await claudeRelayService.getUnauthorizedErrorCount(testAccountId)

      expect(count).toBe(0)
      expect(logger.error).toHaveBeenCalledWith(
        `❌ Failed to get 401 error count for account ${testAccountId}:`,
        redisError
      )
    })
  })

  describe('clearUnauthorizedErrors - 错误清理测试', () => {
    test('应该正确清除401错误计数', async () => {
      await claudeRelayService.clearUnauthorizedErrors(testAccountId)

      expect(mockRedis.client.del).toHaveBeenCalledWith(`claude_account:${testAccountId}:401_errors`)
      expect(logger.info).toHaveBeenCalledWith(`✅ Cleared 401 error count for account ${testAccountId}`)
    })

    test('应该处理清除错误', async () => {
      const deleteError = new Error('Redis delete failed')
      mockRedis.client.del.mockRejectedValue(deleteError)

      await claudeRelayService.clearUnauthorizedErrors(testAccountId)

      expect(logger.error).toHaveBeenCalledWith(
        `❌ Failed to clear 401 errors for account ${testAccountId}:`,
        deleteError
      )
    })
  })

  describe('错误消息格式验证', () => {
    test('错误消息应该包含所有必要信息', async () => {
      // 测试错误消息的完整性
      const expectedMessagePattern = /^❌ Account .+ encountered 401 error \(\d+ errors\), marking as unauthorized and attempting account switch$/
      
      const mock401Response = {
        statusCode: 401,
        headers: {},
        body: JSON.stringify({ error: 'Unauthorized' })
      }

      claudeRelayService._makeClaudeRequest.mockResolvedValue(mock401Response)
      mockRedis.client.get.mockResolvedValue('1')
      
      claudeRelayService._retryWithAccountSwitch = jest.fn().mockRejectedValue(
        new Error('Retry failed')
      )

      try {
        await claudeRelayService.relayRequest(
          testRequestBody,
          testApiKeyData,
          null,
          null,
          { 'user-agent': 'test-client' }
        )
      } catch (error) {
        // 预期错误
      }

      // 验证错误消息格式
      const errorCall = logger.error.mock.calls.find(call => 
        call[0].includes('encountered 401 error')
      )
      
      expect(errorCall).toBeTruthy()
      expect(errorCall[0]).toMatch(expectedMessagePattern)
    })
  })
})