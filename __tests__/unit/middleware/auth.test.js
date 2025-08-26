const { authenticateApiKey } = require('../../../src/middleware/auth')
const apiKeyService = require('../../../src/services/apiKeyService')
const logger = require('../../../src/utils/logger')
const { RateLimiterRedis } = require('rate-limiter-flexible')
const sampleRequests = require('../../fixtures/sample-requests')

// Mock dependencies
jest.mock('../../../src/services/apiKeyService')
jest.mock('../../../src/utils/logger')
jest.mock('../../../src/models/redis')
jest.mock('rate-limiter-flexible')

describe('authenticateApiKey middleware', () => {
  let req, res, next, mockRateLimiter

  beforeEach(() => {
    // Reset mocks
    jest.clearAllMocks()

    // Setup mock request, response, and next
    req = testUtils.createMockRequest()
    res = testUtils.createMockResponse()
    next = testUtils.createMockNext()

    // Mock rate limiter
    mockRateLimiter = {
      consume: jest.fn().mockResolvedValue({ remainingPoints: 10 })
    }
    RateLimiterRedis.mockImplementation(() => mockRateLimiter)

    // Mock logger functions to avoid console output during tests
    logger.security = jest.fn()
    logger.error = jest.fn()
    logger.info = jest.fn()
    logger.warn = jest.fn()
    logger.api = jest.fn() // 中间件使用的API日志方法
  })

  describe('API Key提取和格式验证', () => {
    it('应该从x-api-key header中提取API Key', async () => {
      req.headers['x-api-key'] = sampleRequests.apiKeys.valid

      // Mock successful validation
      apiKeyService.validateApiKey.mockResolvedValue({
        valid: true,
        keyData: { id: 'test-key-id', name: 'Test Key', isActive: 'true' }
      })

      await authenticateApiKey(req, res, next)

      expect(apiKeyService.validateApiKey).toHaveBeenCalledWith(sampleRequests.apiKeys.valid)
      expect(next).toHaveBeenCalled()
      expect(res.status).not.toHaveBeenCalled()
    })

    it('应该从Authorization Bearer header中提取API Key', async () => {
      req.headers['authorization'] = `Bearer ${sampleRequests.apiKeys.valid}`

      apiKeyService.validateApiKey.mockResolvedValue({
        valid: true,
        keyData: { id: 'test-key-id', name: 'Test Key', isActive: 'true' }
      })

      await authenticateApiKey(req, res, next)

      expect(apiKeyService.validateApiKey).toHaveBeenCalledWith(sampleRequests.apiKeys.valid)
      expect(next).toHaveBeenCalled()
    })

    it('应该从x-goog-api-key header中提取API Key (Gemini支持)', async () => {
      req.headers['x-goog-api-key'] = sampleRequests.apiKeys.valid

      apiKeyService.validateApiKey.mockResolvedValue({
        valid: true,
        keyData: { id: 'test-key-id', name: 'Test Key', isActive: 'true' }
      })

      await authenticateApiKey(req, res, next)

      expect(apiKeyService.validateApiKey).toHaveBeenCalledWith(sampleRequests.apiKeys.valid)
      expect(next).toHaveBeenCalled()
    })

    it('应该从query参数中提取API Key', async () => {
      req.query.key = sampleRequests.apiKeys.valid

      apiKeyService.validateApiKey.mockResolvedValue({
        valid: true,
        keyData: { id: 'test-key-id', name: 'Test Key', isActive: 'true' }
      })

      await authenticateApiKey(req, res, next)

      expect(apiKeyService.validateApiKey).toHaveBeenCalledWith(sampleRequests.apiKeys.valid)
      expect(next).toHaveBeenCalled()
    })

    it('应该在缺少API Key时返回401错误', async () => {
      await authenticateApiKey(req, res, next)

      expect(res.status).toHaveBeenCalledWith(401)
      expect(res.json).toHaveBeenCalledWith({
        error: 'Missing API key',
        message: 'Please provide an API key in the x-api-key header or Authorization header'
      })
      expect(logger.security).toHaveBeenCalledWith(expect.stringContaining('Missing API key attempt'))
      expect(next).not.toHaveBeenCalled()
    })
  })

  describe('API Key格式验证', () => {
    it('应该拒绝非字符串格式的API Key', async () => {
      req.headers['x-api-key'] = 12345 // 数字而非字符串

      await authenticateApiKey(req, res, next)

      expect(res.status).toHaveBeenCalledWith(401)
      expect(res.json).toHaveBeenCalledWith({
        error: 'Invalid API key format',
        message: 'API key format is invalid'
      })
      expect(logger.security).toHaveBeenCalledWith(expect.stringContaining('Invalid API key format'))
    })

    it('应该拒绝过短的API Key', async () => {
      req.headers['x-api-key'] = sampleRequests.apiKeys.malformed // 长度为3

      await authenticateApiKey(req, res, next)

      expect(res.status).toHaveBeenCalledWith(401)
      expect(res.json).toHaveBeenCalledWith({
        error: 'Invalid API key format',
        message: 'API key format is invalid'
      })
    })

    it('应该拒绝过长的API Key', async () => {
      req.headers['x-api-key'] = sampleRequests.apiKeys.tooLong

      await authenticateApiKey(req, res, next)

      expect(res.status).toHaveBeenCalledWith(401)
      expect(res.json).toHaveBeenCalledWith({
        error: 'Invalid API key format',
        message: 'API key format is invalid'
      })
    })
  })

  describe('API Key验证', () => {
    beforeEach(() => {
      req.headers['x-api-key'] = sampleRequests.apiKeys.valid
    })

    it('应该接受有效的API Key', async () => {
      const mockKeyData = {
        id: 'test-key-id',
        name: 'Test Key',
        isActive: 'true',
        tokenLimit: '1000',
        totalTokensUsed: '100'
      }

      apiKeyService.validateApiKey.mockResolvedValue({
        valid: true,
        keyData: mockKeyData
      })

      await authenticateApiKey(req, res, next)

      expect(req.apiKeyData).toEqual(mockKeyData)
      expect(req.apiKeyId).toBe('test-key-id')
      expect(next).toHaveBeenCalled()
      expect(res.status).not.toHaveBeenCalled()
    })

    it('应该拒绝无效的API Key', async () => {
      apiKeyService.validateApiKey.mockResolvedValue({
        valid: false,
        error: 'Invalid API key'
      })

      await authenticateApiKey(req, res, next)

      expect(res.status).toHaveBeenCalledWith(401)
      expect(res.json).toHaveBeenCalledWith({
        error: 'Invalid API key',
        message: 'Invalid API key'
      })
      expect(logger.security).toHaveBeenCalledWith(expect.stringContaining('Invalid API key attempt'))
      expect(next).not.toHaveBeenCalled()
    })

    it('应该处理验证服务错误', async () => {
      apiKeyService.validateApiKey.mockRejectedValue(new Error('Database connection failed'))

      await authenticateApiKey(req, res, next)

      expect(res.status).toHaveBeenCalledWith(500)
      expect(res.json).toHaveBeenCalledWith({
        error: 'Authentication error',
        message: 'Internal server error during authentication'
      })
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('Authentication middleware error'),
        expect.any(Object)
      )
    })
  })

  describe('速率限制', () => {
    beforeEach(() => {
      req.headers['x-api-key'] = sampleRequests.apiKeys.valid
      apiKeyService.validateApiKey.mockResolvedValue({
        valid: true,
        keyData: { 
          id: 'test-key-id', 
          name: 'Test Key', 
          isActive: 'true',
          rateLimitWindow: '60', // 60分钟窗口
          rateLimitRequests: '100' // 100次请求限制
        }
      })
    })

    it('应该在速率限制内正常通过', async () => {
      // 模拟Redis中的请求计数器低于限制
      global.testRedisInstance.set('rate_limit:requests:test-key-id', '50')
      global.testRedisInstance.set('rate_limit:window_start:test-key-id', Date.now().toString())

      await authenticateApiKey(req, res, next)

      expect(next).toHaveBeenCalled()
      expect(res.status).not.toHaveBeenCalled()
    })

    it('应该在超出速率限制时返回429错误', async () => {
      const now = Date.now()
      // 模拟Redis中的请求计数器已达到限制
      global.testRedisInstance.set('rate_limit:requests:test-key-id', '100') // 已达到限制
      global.testRedisInstance.set('rate_limit:window_start:test-key-id', now.toString())
      global.testRedisInstance.set('rate_limit:tokens:test-key-id', '0')

      await authenticateApiKey(req, res, next)

      expect(res.status).toHaveBeenCalledWith(429)
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'Rate limit exceeded',
          message: expect.stringContaining('已达到请求次数限制'),
          currentRequests: 100,
          requestLimit: '100' // 字符串格式
        })
      )
      expect(logger.security).toHaveBeenCalledWith(expect.stringContaining('Rate limit exceeded'))
      expect(next).not.toHaveBeenCalled()
    })

    it('应该处理新的时间窗口', async () => {
      // 模拟一个过期的窗口，应该重置计数器
      const oldTime = Date.now() - 4000000 // 超过60分钟前
      global.testRedisInstance.set('rate_limit:window_start:test-key-id', oldTime.toString())
      global.testRedisInstance.set('rate_limit:requests:test-key-id', '100')

      await authenticateApiKey(req, res, next)

      expect(next).toHaveBeenCalled()
      expect(res.status).not.toHaveBeenCalled()
    })
  })

  describe('并发限制', () => {
    beforeEach(() => {
      req.headers['x-api-key'] = sampleRequests.apiKeys.valid
      // Redis清理由全局beforeEach处理，这里不需要重复
    })

    it('应该在并发限制内正常通过', async () => {
      const mockKeyData = {
        id: 'test-key-id',
        name: 'Test Key',
        isActive: 'true',
        concurrencyLimit: 5  // 数字而非字符串
      }

      apiKeyService.validateApiKey.mockResolvedValue({
        valid: true,
        keyData: mockKeyData
      })

      // 设置Redis中的并发计数器为低于限制
      await global.testRedisInstance.set('concurrency:test-key-id', '2')

      await authenticateApiKey(req, res, next)

      expect(next).toHaveBeenCalled()
      expect(res.status).not.toHaveBeenCalled()
    })

    it('应该在超出并发限制时返回429错误', async () => {
      const mockKeyData = {
        id: 'test-key-id',
        name: 'Test Key',
        isActive: 'true',
        concurrencyLimit: 3  // 数字而非字符串
      }

      apiKeyService.validateApiKey.mockResolvedValue({
        valid: true,
        keyData: mockKeyData
      })

      // 先设置Redis中的并发计数器为已达到限制
      await global.testRedisInstance.set('concurrency:test-key-id', '3')

      await authenticateApiKey(req, res, next)

      expect(res.status).toHaveBeenCalledWith(429)
      expect(res.json).toHaveBeenCalledWith({
        error: 'Concurrency limit exceeded',
        message: 'Too many concurrent requests. Limit: 3 concurrent requests',
        currentConcurrency: 3,
        concurrencyLimit: 3
      })
      expect(next).not.toHaveBeenCalled()
    })
  })

  describe('性能测试', () => {
    beforeEach(() => {
      req.headers['x-api-key'] = sampleRequests.apiKeys.valid
      apiKeyService.validateApiKey.mockResolvedValue({
        valid: true,
        keyData: { id: 'test-key-id', name: 'Test Key', isActive: 'true' }
      })
    })

    it('应该在合理时间内完成验证', async () => {
      const startTime = Date.now()

      await authenticateApiKey(req, res, next)

      const endTime = Date.now()
      const duration = endTime - startTime

      expect(duration).toBeLessThan(100) // 应该在100ms内完成
      expect(next).toHaveBeenCalled()
    })

    it('应该记录处理时间', async () => {
      await authenticateApiKey(req, res, next)

      expect(req.authProcessingTime).toBeDefined()
      expect(typeof req.authProcessingTime).toBe('number')
      expect(req.authProcessingTime).toBeGreaterThanOrEqual(0) // 允许0ms处理时间
    })
  })

  describe('安全日志记录', () => {
    it('应该记录安全事件 - 缺少API Key', async () => {
      req.ip = '192.168.1.100'

      await authenticateApiKey(req, res, next)

      expect(logger.security).toHaveBeenCalledWith(
        expect.stringContaining('Missing API key attempt from 192.168.1.100')
      )
    })

    it('应该记录安全事件 - 无效API Key格式', async () => {
      req.headers['x-api-key'] = '123'
      req.ip = '192.168.1.101'

      await authenticateApiKey(req, res, next)

      expect(logger.security).toHaveBeenCalledWith(
        expect.stringContaining('Invalid API key format from 192.168.1.101')
      )
    })

    it('应该记录安全事件 - API Key验证失败', async () => {
      req.headers['x-api-key'] = sampleRequests.apiKeys.valid
      req.ip = '192.168.1.102'

      apiKeyService.validateApiKey.mockResolvedValue({
        valid: false,
        error: 'Expired API key'
      })

      await authenticateApiKey(req, res, next)

      expect(logger.security).toHaveBeenCalledWith(
        expect.stringContaining('Invalid API key attempt: Expired API key from 192.168.1.102')
      )
    })

    it('应该记录安全事件 - 速率限制超出', async () => {
      req.headers['x-api-key'] = sampleRequests.apiKeys.valid
      req.ip = '192.168.1.103'

      apiKeyService.validateApiKey.mockResolvedValue({
        valid: true,
        keyData: { 
          id: 'test-key-id', 
          name: 'Test Key', 
          isActive: 'true',
          rateLimitWindow: '60',
          rateLimitRequests: '100'
        }
      })

      // 模拟速率限制已达到
      const now = Date.now()
      global.testRedisInstance.set('rate_limit:requests:test-key-id', '100')
      global.testRedisInstance.set('rate_limit:window_start:test-key-id', now.toString())
      global.testRedisInstance.set('rate_limit:tokens:test-key-id', '0')

      await authenticateApiKey(req, res, next)

      expect(logger.security).toHaveBeenCalledWith(
        expect.stringContaining('Rate limit exceeded (requests) for key: test-key-id (Test Key), requests: 100/100')
      )
    })
  })

  describe('边界情况和错误处理', () => {
    it('应该处理空的Authorization header', async () => {
      req.headers['authorization'] = 'Bearer '

      await authenticateApiKey(req, res, next)

      expect(res.status).toHaveBeenCalledWith(401)
      expect(res.json).toHaveBeenCalledWith({
        error: 'Missing API key',
        message: 'Please provide an API key in the x-api-key header or Authorization header'
      })
    })

    it('应该处理非Bearer格式的Authorization header', async () => {
      req.headers['authorization'] = 'Basic dGVzdDp0ZXN0'

      // Mock validateApiKey 对于非Bearer格式返回invalid
      apiKeyService.validateApiKey.mockResolvedValue({
        valid: false,
        error: 'Invalid API key format'
      })

      await authenticateApiKey(req, res, next)

      // 实际上'Basic dGVzdDp0ZXN0'会被当作API Key处理，但验证失败
      expect(res.status).toHaveBeenCalledWith(401)
      expect(res.json).toHaveBeenCalledWith({
        error: 'Invalid API key',
        message: 'Invalid API key format'
      })
      expect(next).not.toHaveBeenCalled()
    })

    it('应该处理未知IP地址', async () => {
      delete req.ip

      await authenticateApiKey(req, res, next)

      expect(logger.security).toHaveBeenCalledWith(
        expect.stringContaining('Missing API key attempt from unknown')
      )
    })

    it('应该处理validateApiKey返回null或undefined', async () => {
      req.headers['x-api-key'] = sampleRequests.apiKeys.valid
      apiKeyService.validateApiKey.mockResolvedValue(null)

      await authenticateApiKey(req, res, next)

      expect(res.status).toHaveBeenCalledWith(500)
      expect(res.json).toHaveBeenCalledWith({
        error: 'Authentication error',
        message: 'Internal server error during authentication'
      })
    })
  })
})