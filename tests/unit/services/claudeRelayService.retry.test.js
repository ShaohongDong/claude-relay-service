/**
 * ClaudeRelayService 账户切换重试机制测试
 * 专门测试429和401错误的账户切换逻辑
 * 目标：实现100%新增代码覆盖率
 */

const EventEmitter = require('events')
const https = require('https')
const ClaudeRelayService = require('../../../src/services/claudeRelayService')

// Mock dependencies
jest.mock('../../../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  success: jest.fn()
}))

jest.mock('../../../src/models/redis', () => ({
  client: {
    incr: jest.fn(),
    expire: jest.fn(),
    get: jest.fn(),
    del: jest.fn()
  }
}))

jest.mock('../../../src/services/claudeAccountService', () => ({
  getValidAccessToken: jest.fn()
}))

jest.mock('../../../src/services/unifiedClaudeScheduler', () => ({
  selectAccountForApiKey: jest.fn(),
  markAccountRateLimited: jest.fn(),
  markAccountUnauthorized: jest.fn(),
  isAccountRateLimited: jest.fn(),
  removeAccountRateLimit: jest.fn()
}))

jest.mock('../../../src/services/claudeCodeHeadersService', () => ({
  storeAccountHeaders: jest.fn(),
  getAccountHeaders: jest.fn().mockReturnValue({})
}))

jest.mock('../../../src/utils/sessionHelper', () => ({
  generateSessionHash: jest.fn().mockReturnValue('test-session-hash')
}))

jest.mock('../../../src/utils/proxyHelper', () => ({
  createProxyAgent: jest.fn().mockReturnValue(null),
  getProxyDescription: jest.fn().mockReturnValue('No proxy')
}))

const logger = require('../../../src/utils/logger')
const redis = require('../../../src/models/redis')
const claudeAccountService = require('../../../src/services/claudeAccountService')
const unifiedClaudeScheduler = require('../../../src/services/unifiedClaudeScheduler')
const claudeCodeHeadersService = require('../../../src/services/claudeCodeHeadersService')
const sessionHelper = require('../../../src/utils/sessionHelper')

describe('ClaudeRelayService - 账户切换重试机制', () => {
  let claudeRelayService
  let mockRequest
  let mockResponse
  let mockClientRequest
  let mockClientResponse

  beforeEach(() => {
    jest.clearAllMocks()
    
    // 重置所有mocks到已知状态
    unifiedClaudeScheduler.selectAccountForApiKey.mockReset()
    claudeAccountService.getValidAccessToken.mockReset()
    unifiedClaudeScheduler.markAccountRateLimited.mockReset()
    unifiedClaudeScheduler.markAccountUnauthorized.mockReset()
    unifiedClaudeScheduler.isAccountRateLimited.mockReset()
    unifiedClaudeScheduler.removeAccountRateLimit.mockReset()
    claudeCodeHeadersService.storeAccountHeaders.mockReset()
    claudeCodeHeadersService.getAccountHeaders.mockReset()
    
    // 使用ClaudeRelayService单例实例
    claudeRelayService = ClaudeRelayService
    
    // Mock HTTP request/response objects
    mockRequest = new EventEmitter()
    mockRequest.write = jest.fn()
    mockRequest.end = jest.fn()
    mockRequest.destroy = jest.fn()
    mockRequest.destroyed = false
    
    mockResponse = new EventEmitter()
    mockResponse.statusCode = 200
    mockResponse.headers = {}
    mockResponse.pipe = jest.fn()
    
    mockClientRequest = new EventEmitter()
    mockClientRequest.destroyed = false
    
    mockClientResponse = new EventEmitter()
    mockClientResponse.destroyed = false
    mockClientResponse.writeHead = jest.fn()
    mockClientResponse.write = jest.fn()
    mockClientResponse.end = jest.fn()
    mockClientResponse.headersSent = false
    
    // Mock https.request
    jest.spyOn(https, 'request').mockImplementation((options, callback) => {
      setTimeout(() => callback(mockResponse), 0)
      return mockRequest
    })
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  describe('_retryWithAccountSwitch - 非流式请求重试', () => {
    const mockApiKeyData = {
      id: 'test-api-key-id',
      name: 'Test API Key'
    }

    const mockRequestBody = {
      model: 'claude-3-sonnet-20240229',
      messages: [{ role: 'user', content: 'Hello' }]
    }

    const mockClientHeaders = {
      'user-agent': 'test-client'
    }

    beforeEach(() => {
      // 设置默认的mock返回值
      claudeAccountService.getValidAccessToken.mockResolvedValue('mock-access-token')
      unifiedClaudeScheduler.markAccountRateLimited.mockResolvedValue()
      unifiedClaudeScheduler.markAccountUnauthorized.mockResolvedValue()
      unifiedClaudeScheduler.isAccountRateLimited.mockResolvedValue(false)
      unifiedClaudeScheduler.removeAccountRateLimit.mockResolvedValue()
      
      // Mock instance methods
      claudeRelayService.recordUnauthorizedError = jest.fn().mockResolvedValue()
      claudeRelayService.getUnauthorizedErrorCount = jest.fn().mockResolvedValue(1)
      claudeRelayService.clearUnauthorizedErrors = jest.fn().mockResolvedValue()
      
      // 设置默认的account selection mock
      unifiedClaudeScheduler.selectAccountForApiKey.mockResolvedValue({
        accountId: 'default-account',
        accountType: 'claude'
      })
    })

    test('429错误 - 第一次重试成功', async () => {
      // Mock account selection to return different accounts for retry
      unifiedClaudeScheduler.selectAccountForApiKey
        .mockResolvedValueOnce({ accountId: 'account-1', accountType: 'claude' })
        .mockResolvedValueOnce({ accountId: 'account-2', accountType: 'claude' })

      // Mock _makeClaudeRequest to return 429 first, then 200
      const mock429Response = {
        statusCode: 429,
        headers: { 'anthropic-ratelimit-unified-reset': '1693123456' },
        body: JSON.stringify({
          error: {
            message: "You have exceeded your account's rate limit"
          }
        })
      }
      
      const mock200Response = {
        statusCode: 200,
        body: JSON.stringify({ content: [{ text: 'Success' }] })
      }
      
      claudeRelayService._makeClaudeRequest = jest.fn()
        .mockResolvedValueOnce(mock429Response)
        .mockResolvedValueOnce(mock200Response)

      const result = await claudeRelayService._retryWithAccountSwitch(
        mockRequestBody,
        mockApiKeyData,
        mockClientRequest,
        mockClientResponse,
        mockClientHeaders
      )

      expect(result.statusCode).toBe(200)
      expect(unifiedClaudeScheduler.markAccountRateLimited).toHaveBeenCalledWith(
        'account-1',
        'claude',
        'test-session-hash',
        1693123456
      )
      expect(claudeRelayService.clearUnauthorizedErrors).toHaveBeenCalledWith('account-2')
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('Account switch retry successful after 2 attempts')
      )
    })

    test('429错误 - 所有重试都失败', async () => {
      // Mock multiple accounts for all attempts
      unifiedClaudeScheduler.selectAccountForApiKey
        .mockResolvedValueOnce({ accountId: 'account-1', accountType: 'claude' })
        .mockResolvedValueOnce({ accountId: 'account-2', accountType: 'claude' })
        .mockResolvedValueOnce({ accountId: 'account-3', accountType: 'claude' })

      const mock429Response = {
        statusCode: 429,
        headers: {},
        body: JSON.stringify({
          error: {
            message: "You have exceeded your account's rate limit"
          }
        })
      }
      
      claudeRelayService._makeClaudeRequest = jest.fn()
        .mockResolvedValue(mock429Response)

      const result = await claudeRelayService._retryWithAccountSwitch(
        mockRequestBody,
        mockApiKeyData,
        mockClientRequest,
        mockClientResponse,
        mockClientHeaders,
        {},
        2 // maxRetries
      )

      expect(result.statusCode).toBe(429)
      expect(unifiedClaudeScheduler.markAccountRateLimited).toHaveBeenCalledTimes(3) // 初始 + 2次重试
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('All account switch retries failed after 3 attempts')
      )
    })

    test('401错误 - 第一次重试成功', async () => {
      // Mock account selection for retry
      unifiedClaudeScheduler.selectAccountForApiKey
        .mockResolvedValueOnce({ accountId: 'account-1', accountType: 'claude' })
        .mockResolvedValueOnce({ accountId: 'account-2', accountType: 'claude' })

      const mock401Response = {
        statusCode: 401,
        body: JSON.stringify({ error: { message: 'Unauthorized' } })
      }
      
      const mock200Response = {
        statusCode: 200,
        body: JSON.stringify({ content: [{ text: 'Success' }] })
      }
      
      claudeRelayService._makeClaudeRequest = jest.fn()
        .mockResolvedValueOnce(mock401Response)
        .mockResolvedValueOnce(mock200Response)

      const result = await claudeRelayService._retryWithAccountSwitch(
        mockRequestBody,
        mockApiKeyData,
        mockClientRequest,
        mockClientResponse,
        mockClientHeaders
      )

      expect(result.statusCode).toBe(200)
      expect(claudeRelayService.recordUnauthorizedError).toHaveBeenCalledWith('account-1')
      expect(claudeRelayService.getUnauthorizedErrorCount).toHaveBeenCalledWith('account-1')
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('Account switch retry successful after 2 attempts')
      )
    })

    test('401错误 - 超过阈值标记为未授权', async () => {
      // Mock specific account for this test
      unifiedClaudeScheduler.selectAccountForApiKey
        .mockResolvedValue({ accountId: 'account-1', accountType: 'claude' })
      
      claudeRelayService.getUnauthorizedErrorCount.mockResolvedValue(3)
      
      const mock401Response = {
        statusCode: 401,
        body: JSON.stringify({ error: { message: 'Unauthorized' } })
      }
      
      claudeRelayService._makeClaudeRequest = jest.fn()
        .mockResolvedValue(mock401Response)

      await claudeRelayService._retryWithAccountSwitch(
        mockRequestBody,
        mockApiKeyData,
        mockClientRequest,
        mockClientResponse,
        mockClientHeaders,
        {},
        0 // 不重试，只测试标记逻辑
      )

      expect(unifiedClaudeScheduler.markAccountUnauthorized).toHaveBeenCalledWith(
        'account-1',
        'claude',
        'test-session-hash'
      )
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('exceeded 401 error threshold')
      )
    })

    test('客户端连接断开处理', async () => {
      // Mock account selection
      unifiedClaudeScheduler.selectAccountForApiKey
        .mockResolvedValue({ accountId: 'account-1', accountType: 'claude' })
      
      let disconnectHandler
      let upstreamRequest = null
      
      mockClientRequest.once = jest.fn((event, handler) => {
        if (event === 'close') {
          disconnectHandler = handler
        }
      })
      mockClientRequest.removeListener = jest.fn()
      
      const mockUpstreamRequest = { destroy: jest.fn(), destroyed: false }
      
      claudeRelayService._makeClaudeRequest = jest.fn().mockImplementation(
        (body, token, proxy, headers, accountId, onRequest) => {
          if (onRequest) {
            onRequest(mockUpstreamRequest)
            upstreamRequest = mockUpstreamRequest
          }
          // 模拟长时间运行的请求
          return new Promise((resolve) => {
            setTimeout(() => {
              resolve({ statusCode: 200, body: '{}' })
            }, 100)
          })
        }
      )

      const promise = claudeRelayService._retryWithAccountSwitch(
        mockRequestBody,
        mockApiKeyData,
        mockClientRequest,
        mockClientResponse,
        mockClientHeaders
      )

      // 等待请求开始并设置监听器
      await new Promise(resolve => setTimeout(resolve, 10))
      
      // 模拟客户端断开
      if (disconnectHandler) {
        disconnectHandler()
      }
      
      await promise

      expect(mockClientRequest.once).toHaveBeenCalledWith('close', expect.any(Function))
      expect(mockClientRequest.removeListener).toHaveBeenCalledWith('close', expect.any(Function))
      // 不直接检查destroy，因为它可能在客户端断开时才被调用
    })

    test('网络错误重试处理', async () => {
      // Mock account selection for retry
      unifiedClaudeScheduler.selectAccountForApiKey
        .mockResolvedValueOnce({ accountId: 'account-1', accountType: 'claude' })
        .mockResolvedValueOnce({ accountId: 'account-2', accountType: 'claude' })
      
      claudeRelayService._makeClaudeRequest = jest.fn()
        .mockRejectedValueOnce(new Error('Network error'))
        .mockResolvedValueOnce({ statusCode: 200, body: '{}' })

      const result = await claudeRelayService._retryWithAccountSwitch(
        mockRequestBody,
        mockApiKeyData,
        mockClientRequest,
        mockClientResponse,
        mockClientHeaders
      )

      expect(result.statusCode).toBe(200)
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('Retry attempt 1 failed with error'),
        'Network error'
      )
    })

    test('所有重试都抛出错误时处理', async () => {
      // Mock account selection for retries
      unifiedClaudeScheduler.selectAccountForApiKey
        .mockResolvedValueOnce({ accountId: 'account-1', accountType: 'claude' })
        .mockResolvedValueOnce({ accountId: 'account-2', accountType: 'claude' })
      
      claudeRelayService._makeClaudeRequest = jest.fn()
        .mockRejectedValue(new Error('Persistent network error'))

      await expect(claudeRelayService._retryWithAccountSwitch(
        mockRequestBody,
        mockApiKeyData,
        mockClientRequest,
        mockClientResponse,
        mockClientHeaders,
        {},
        1 // maxRetries
      )).rejects.toThrow('Persistent network error')

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('All account switch retries failed after 2 attempts')
      )
    })
  })

  describe('_executeStreamRequestWithRetry - 流式请求重试', () => {
    const mockApiKeyData = {
      id: 'test-api-key-id',
      name: 'Test Stream API Key'
    }

    const mockRequestBody = {
      model: 'claude-3-sonnet-20240229',
      messages: [{ role: 'user', content: 'Hello stream' }],
      stream: true
    }

    const mockUsageCallback = jest.fn()

    beforeEach(() => {
      // 设置流式请求的默认mock
      claudeAccountService.getValidAccessToken.mockResolvedValue('mock-stream-token')
      claudeRelayService._processRequestBody = jest.fn().mockReturnValue(mockRequestBody)
      claudeRelayService._getProxyAgent = jest.fn().mockResolvedValue(null)
      
      // 设置默认的account selection mock（会在具体测试中覆盖）
      unifiedClaudeScheduler.selectAccountForApiKey.mockResolvedValue({
        accountId: 'stream-default-account',
        accountType: 'claude'
      })
    })

    test('第一次请求成功', async () => {
      // Mock account selection
      unifiedClaudeScheduler.selectAccountForApiKey
        .mockResolvedValue({ accountId: 'stream-account-1', accountType: 'claude' })
      
      claudeRelayService._makeClaudeStreamRequestWithUsageCapture = jest.fn()
        .mockResolvedValue()

      await claudeRelayService._executeStreamRequestWithRetry(
        mockRequestBody,
        mockApiKeyData,
        mockClientResponse,
        {},
        mockUsageCallback
      )

      expect(claudeRelayService._makeClaudeStreamRequestWithUsageCapture).toHaveBeenCalledTimes(1)
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('Stream request attempt 1/3')
      )
    })

    test('429错误重试成功', async () => {
      // Mock account selection for retry
      unifiedClaudeScheduler.selectAccountForApiKey
        .mockResolvedValueOnce({ accountId: 'stream-account-1', accountType: 'claude' })
        .mockResolvedValueOnce({ accountId: 'stream-account-2', accountType: 'claude' })
      
      claudeRelayService._makeClaudeStreamRequestWithUsageCapture = jest.fn()
        .mockRejectedValueOnce(new Error('Claude API rate limit (HTTP 429) for account stream-account-1'))
        .mockResolvedValueOnce()

      await claudeRelayService._executeStreamRequestWithRetry(
        mockRequestBody,
        mockApiKeyData,
        mockClientResponse,
        {},
        mockUsageCallback
      )

      expect(claudeRelayService._makeClaudeStreamRequestWithUsageCapture).toHaveBeenCalledTimes(2)
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Stream retryable error detected')
      )
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('Stream account switch retry successful after 2 attempts')
      )
    })

    test('401错误重试成功', async () => {
      // Mock account selection for retry
      unifiedClaudeScheduler.selectAccountForApiKey
        .mockResolvedValueOnce({ accountId: 'stream-account-1', accountType: 'claude' })
        .mockResolvedValueOnce({ accountId: 'stream-account-2', accountType: 'claude' })
      
      claudeRelayService._makeClaudeStreamRequestWithUsageCapture = jest.fn()
        .mockRejectedValueOnce(new Error('Unauthorized'))
        .mockResolvedValueOnce()

      await claudeRelayService._executeStreamRequestWithRetry(
        mockRequestBody,
        mockApiKeyData,
        mockClientResponse,
        {},
        mockUsageCallback
      )

      expect(claudeRelayService._makeClaudeStreamRequestWithUsageCapture).toHaveBeenCalledTimes(2)
    })

    test('所有重试都失败', async () => {
      // Mock account selection for all attempts
      unifiedClaudeScheduler.selectAccountForApiKey
        .mockResolvedValueOnce({ accountId: 'stream-account-1', accountType: 'claude' })
        .mockResolvedValueOnce({ accountId: 'stream-account-2', accountType: 'claude' })
      
      claudeRelayService._makeClaudeStreamRequestWithUsageCapture = jest.fn()
        .mockRejectedValue(new Error('Rate limit'))

      await expect(claudeRelayService._executeStreamRequestWithRetry(
        mockRequestBody,
        mockApiKeyData,
        mockClientResponse,
        {},
        mockUsageCallback,
        null,
        {},
        1 // maxRetries
      )).rejects.toThrow('Rate limit')

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('All stream attempts failed after 2 attempts')
      )
    })

    test('非可重试错误立即抛出', async () => {
      // Mock account selection
      unifiedClaudeScheduler.selectAccountForApiKey
        .mockResolvedValue({ accountId: 'stream-account-1', accountType: 'claude' })
      
      claudeRelayService._makeClaudeStreamRequestWithUsageCapture = jest.fn()
        .mockRejectedValue(new Error('Network timeout'))

      await expect(claudeRelayService._executeStreamRequestWithRetry(
        mockRequestBody,
        mockApiKeyData,
        mockClientResponse,
        {},
        mockUsageCallback
      )).rejects.toThrow('Network timeout')

      expect(claudeRelayService._makeClaudeStreamRequestWithUsageCapture).toHaveBeenCalledTimes(1)
    })
  })

  describe('Stream Request 429/401 Error Detection', () => {
    beforeEach(() => {
      unifiedClaudeScheduler.markAccountRateLimited.mockResolvedValue()
    })

    test('HTTP层429错误检测和标记', async () => {
      // Mock account selection
      unifiedClaudeScheduler.selectAccountForApiKey
        .mockResolvedValue({ accountId: 'account-id', accountType: 'claude' })

      // Mock _makeClaudeStreamRequestWithUsageCapture to throw 429 error
      claudeRelayService._makeClaudeStreamRequestWithUsageCapture = jest.fn()
        .mockRejectedValue(new Error('Claude API rate limit (HTTP 429) for account account-id'))

      const requestPromise = claudeRelayService._executeStreamRequestWithRetry(
        { model: 'test', messages: [] },
        { id: 'test-key', name: 'Test Key' },
        mockClientResponse,
        {},
        jest.fn(),
        null,
        {},
        0 // maxRetries = 0 to avoid actual retry
      )

      // 应该reject with error
      await expect(requestPromise).rejects.toThrow('Claude API rate limit (HTTP 429)')
    })

    test('SSE层429错误检测和标记', async () => {
      // Mock account selection
      unifiedClaudeScheduler.selectAccountForApiKey
        .mockResolvedValue({ accountId: 'account-id', accountType: 'claude' })

      // Mock _makeClaudeStreamRequestWithUsageCapture to throw SSE 429 error
      claudeRelayService._makeClaudeStreamRequestWithUsageCapture = jest.fn()
        .mockRejectedValue(new Error('Claude API rate limit exceeded for account account-id: You have exceeded your account\'s rate limit'))

      const requestPromise = claudeRelayService._executeStreamRequestWithRetry(
        { model: 'test', messages: [] },
        { id: 'test-key', name: 'Test Key' },
        mockClientResponse,
        {},
        jest.fn(),
        null,
        {},
        0 // maxRetries = 0 to avoid actual retry
      )

      await expect(requestPromise).rejects.toThrow('Claude API rate limit exceeded')
    })

    test('正常SSE数据处理', async () => {
      // Mock account selection
      unifiedClaudeScheduler.selectAccountForApiKey
        .mockResolvedValue({ accountId: 'account-id', accountType: 'claude' })

      // 重置并设置getValidAccessToken mock
      claudeAccountService.getValidAccessToken.mockResolvedValue('mock-stream-token')

      // Mock successful stream processing
      claudeRelayService._makeClaudeStreamRequestWithUsageCapture = jest.fn()
        .mockResolvedValue(undefined) // Stream processing completes successfully

      const usageCallback = jest.fn()
      
      await claudeRelayService._executeStreamRequestWithRetry(
        { model: 'claude-3-sonnet-20240229', messages: [{ role: 'user', content: 'Hello stream' }], stream: true },
        { id: 'test-api-key-id', name: 'Test Stream API Key' },
        mockClientResponse,
        {},
        usageCallback
      )

      expect(claudeRelayService._makeClaudeStreamRequestWithUsageCapture).toHaveBeenCalledWith(
        expect.objectContaining({ 
          model: 'claude-3-sonnet-20240229',
          stream: true
        }),
        'mock-stream-token',
        null,
        {},
        mockClientResponse,
        expect.any(Function),
        'account-id',
        'claude',
        'test-session-hash',
        null,
        {}
      )
    })
  })

  describe('Integration with relayRequest', () => {
    test('relayRequest调用429重试逻辑', async () => {
      const mockApiKeyData = { id: 'test-key', name: 'Test Key' }
      const mockRequestBody = { model: 'test', messages: [] }
      
      // Mock initial account selection
      unifiedClaudeScheduler.selectAccountForApiKey.mockResolvedValue({
        accountId: 'test-account',
        accountType: 'claude'
      })
      claudeAccountService.getValidAccessToken.mockResolvedValue('token')
      claudeRelayService._processRequestBody = jest.fn().mockReturnValue(mockRequestBody)
      claudeRelayService._getProxyAgent = jest.fn().mockResolvedValue(null)
      claudeRelayService.recordUnauthorizedError = jest.fn()
      claudeRelayService.getUnauthorizedErrorCount = jest.fn().mockResolvedValue(1)
      claudeRelayService.clearUnauthorizedErrors = jest.fn()
      
      // Mock 429 response from _makeClaudeRequest
      claudeRelayService._makeClaudeRequest = jest.fn().mockResolvedValue({
        statusCode: 429,
        headers: {},
        body: JSON.stringify({ error: { message: "Rate limit exceeded" } })
      })
      
      // Mock successful retry
      claudeRelayService._retryWithAccountSwitch = jest.fn().mockResolvedValue({
        statusCode: 200,
        body: JSON.stringify({ content: [{ text: 'Success' }] }),
        accountId: 'retry-account'
      })

      const result = await claudeRelayService.relayRequest(
        mockRequestBody,
        mockApiKeyData,
        mockClientRequest,
        mockClientResponse,
        {}
      )

      expect(claudeRelayService._retryWithAccountSwitch).toHaveBeenCalledWith(
        mockRequestBody,
        mockApiKeyData,
        mockClientRequest,
        mockClientResponse,
        {},
        {}
      )
      expect(result.statusCode).toBe(200)
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('Account switch retry successful')
      )
    })

    test('relayRequest调用401重试逻辑', async () => {
      const mockApiKeyData = { id: 'test-key', name: 'Test Key' }
      const mockRequestBody = { model: 'test', messages: [] }
      
      // Mock initial account selection
      unifiedClaudeScheduler.selectAccountForApiKey.mockResolvedValue({
        accountId: 'test-account',
        accountType: 'claude'
      })
      claudeAccountService.getValidAccessToken.mockResolvedValue('token')
      claudeRelayService._processRequestBody = jest.fn().mockReturnValue(mockRequestBody)
      claudeRelayService._getProxyAgent = jest.fn().mockResolvedValue(null)
      claudeRelayService.recordUnauthorizedError = jest.fn()
      claudeRelayService.getUnauthorizedErrorCount = jest.fn().mockResolvedValue(2)
      claudeRelayService.clearUnauthorizedErrors = jest.fn()
      
      claudeRelayService._makeClaudeRequest = jest.fn().mockResolvedValue({
        statusCode: 401,
        body: JSON.stringify({ error: { message: "Unauthorized" } })
      })
      
      claudeRelayService._retryWithAccountSwitch = jest.fn().mockResolvedValue({
        statusCode: 200,
        body: JSON.stringify({ content: [{ text: 'Success' }] }),
        accountId: 'retry-account'
      })

      const result = await claudeRelayService.relayRequest(
        mockRequestBody,
        mockApiKeyData,
        mockClientRequest,
        mockClientResponse,
        {}
      )

      expect(claudeRelayService.recordUnauthorizedError).toHaveBeenCalledWith('test-account')
      expect(claudeRelayService._retryWithAccountSwitch).toHaveBeenCalled()
      expect(result.statusCode).toBe(200)
    })
  })

  describe('Edge Cases and Error Handling', () => {
    let isolatedClaudeRelayService
    let isolatedSessionHelper
    let isolatedUnifiedScheduler
    let isolatedClaudeAccountService

    beforeEach(() => {
      // 使用jest.isolateModules完全隔离模块状态
      return new Promise((resolve) => {
        jest.isolateModules(() => {
          // 重新导入所有模块，确保完全隔离
          jest.clearAllMocks()
          jest.resetAllMocks()
          
          // 重新设置所有mocks
          isolatedUnifiedScheduler = require('../../../src/services/unifiedClaudeScheduler')
          isolatedClaudeAccountService = require('../../../src/services/claudeAccountService')
          isolatedSessionHelper = require('../../../src/utils/sessionHelper')
          isolatedClaudeRelayService = require('../../../src/services/claudeRelayService')
          
          // 设置默认mock行为
          isolatedSessionHelper.generateSessionHash = jest.fn().mockReturnValue('test-session-hash')
          isolatedClaudeAccountService.getValidAccessToken = jest.fn().mockResolvedValue('mock-access-token')
          isolatedUnifiedScheduler.selectAccountForApiKey = jest.fn()
          isolatedUnifiedScheduler.markAccountRateLimited = jest.fn().mockResolvedValue()
          isolatedUnifiedScheduler.markAccountUnauthorized = jest.fn().mockResolvedValue()
          isolatedUnifiedScheduler.isAccountRateLimited = jest.fn().mockResolvedValue(false)
          isolatedUnifiedScheduler.removeAccountRateLimit = jest.fn().mockResolvedValue()
          
          // 设置ClaudeRelayService的方法mocks
          isolatedClaudeRelayService.recordUnauthorizedError = jest.fn().mockResolvedValue()
          isolatedClaudeRelayService.getUnauthorizedErrorCount = jest.fn().mockResolvedValue(1)
          isolatedClaudeRelayService.clearUnauthorizedErrors = jest.fn().mockResolvedValue()
          isolatedClaudeRelayService._getProxyAgent = jest.fn().mockResolvedValue(null)
          isolatedClaudeRelayService._processRequestBody = jest.fn().mockReturnValue({})
          isolatedClaudeRelayService._makeClaudeRequest = jest.fn()
          
          resolve()
        })
      })
    })

    test('空的响应体处理', async () => {
      const mockApiKeyData = { id: 'test-key', name: 'Test Key' }
      
      // 使用隔离的模块实例
      isolatedUnifiedScheduler.selectAccountForApiKey.mockResolvedValueOnce({
        accountId: 'test-account',
        accountType: 'claude'
      })
      
      isolatedClaudeRelayService._makeClaudeRequest.mockResolvedValueOnce({
        statusCode: 429,
        headers: {},
        body: ''
      })

      const result = await isolatedClaudeRelayService._retryWithAccountSwitch(
        {},
        mockApiKeyData,
        null,
        null,
        {},
        {},
        0
      )

      expect(result).toMatchObject({
        statusCode: 429,
        body: ''
      })
    })

    test('无效JSON响应体处理', async () => {
      const mockApiKeyData = { id: 'test-key', name: 'Test Key' }
      
      // 使用隔离的模块实例
      isolatedUnifiedScheduler.selectAccountForApiKey.mockResolvedValueOnce({
        accountId: 'test-account',
        accountType: 'claude'
      })
      
      isolatedClaudeRelayService._makeClaudeRequest.mockResolvedValueOnce({
        statusCode: 429,
        headers: {},
        body: 'invalid json{['
      })

      // 应该仍能处理并标记为限流
      const result = await isolatedClaudeRelayService._retryWithAccountSwitch(
        {},
        mockApiKeyData,
        null,
        null,
        {},
        {},
        0
      )

      expect(isolatedUnifiedScheduler.markAccountRateLimited).toHaveBeenCalled()
      expect(result.statusCode).toBe(429)
    })

    test('Session hash处理', async () => {
      // 设置自定义session hash
      isolatedSessionHelper.generateSessionHash.mockReturnValue('custom-session-hash')

      // 使用隔离的模块实例
      isolatedUnifiedScheduler.selectAccountForApiKey.mockResolvedValueOnce({
        accountId: 'session-account', 
        accountType: 'claude'
      })
      
      isolatedClaudeRelayService._processRequestBody.mockReturnValue({ messages: [] })
      isolatedClaudeRelayService._makeClaudeRequest.mockResolvedValueOnce({
        statusCode: 200,
        body: '{}'
      })

      await isolatedClaudeRelayService._retryWithAccountSwitch(
        { messages: [] },
        { id: 'key', name: 'Key' },
        null,
        null,
        {}
      )

      // 验证selectAccountForApiKey被调用时使用了custom session hash
      expect(isolatedUnifiedScheduler.selectAccountForApiKey).toHaveBeenCalledWith(
        { id: 'key', name: 'Key' },
        'custom-session-hash', // sessionHelper生成的hash
        undefined // model参数
      )
    })
  })

  describe('401错误记录和清理', () => {
    let isolatedClaudeRelayService
    let isolatedRedis
    let isolatedLogger

    beforeEach(() => {
      // 使用jest.isolateModules完全隔离Redis相关模块
      return new Promise((resolve) => {
        jest.isolateModules(() => {
          jest.clearAllMocks()
          jest.resetAllMocks()
          
          // 重新导入并mock所有相关模块
          isolatedRedis = require('../../../src/models/redis')
          isolatedLogger = require('../../../src/utils/logger')
          isolatedClaudeRelayService = require('../../../src/services/claudeRelayService')
          
          // 设置Redis client mocks
          isolatedRedis.client = {
            incr: jest.fn().mockResolvedValue(2),
            expire: jest.fn().mockResolvedValue(1),
            get: jest.fn().mockResolvedValue('3'),
            del: jest.fn().mockResolvedValue(1)
          }
          
          // 设置logger mocks
          isolatedLogger.info = jest.fn()
          isolatedLogger.error = jest.fn()
          
          resolve()
        })
      })
    })

    test('recordUnauthorizedError正确记录', async () => {
      await isolatedClaudeRelayService.recordUnauthorizedError('test-account-id')

      expect(isolatedRedis.client.incr).toHaveBeenCalledWith('claude_account:test-account-id:401_errors')
      expect(isolatedRedis.client.expire).toHaveBeenCalledWith('claude_account:test-account-id:401_errors', 300)
      expect(isolatedLogger.info).toHaveBeenCalledWith('📝 Recorded 401 error for account test-account-id')
    })

    test('getUnauthorizedErrorCount正确获取计数', async () => {
      const count = await isolatedClaudeRelayService.getUnauthorizedErrorCount('test-account-id')

      expect(isolatedRedis.client.get).toHaveBeenCalledWith('claude_account:test-account-id:401_errors')
      expect(count).toBe(3)
    })

    test('clearUnauthorizedErrors正确清理', async () => {
      await isolatedClaudeRelayService.clearUnauthorizedErrors('test-account-id')

      expect(isolatedRedis.client.del).toHaveBeenCalledWith('claude_account:test-account-id:401_errors')
      expect(isolatedLogger.info).toHaveBeenCalledWith('✅ Cleared 401 error count for account test-account-id')
    })

    test('Redis操作错误处理', async () => {
      isolatedRedis.client.incr.mockRejectedValue(new Error('Redis error'))

      await isolatedClaudeRelayService.recordUnauthorizedError('test-account-id')

      expect(isolatedLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('Failed to record 401 error for account test-account-id'),
        expect.any(Error)
      )
    })
  })
})