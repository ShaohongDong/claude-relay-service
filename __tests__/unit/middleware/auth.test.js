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
      expect(logger.security).toHaveBeenCalledWith(expect.stringContaining('API key validation failed'))
      expect(next).not.toHaveBeenCalled()
    })

    it('应该处理验证服务错误', async () => {
      apiKeyService.validateApiKey.mockRejectedValue(new Error('Database connection failed'))

      await authenticateApiKey(req, res, next)

      expect(res.status).toHaveBeenCalledWith(500)
      expect(res.json).toHaveBeenCalledWith({
        error: 'Internal server error',
        message: 'Authentication service temporarily unavailable'
      })
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('API key validation error:'),
        expect.any(Error)
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
          rateLimitWindow: '3600',
          rateLimitRequests: '100'
        }
      })
    })

    it('应该在速率限制内正常通过', async () => {
      mockRateLimiter.consume.mockResolvedValue({ remainingPoints: 50, msBeforeNext: 1000 })

      await authenticateApiKey(req, res, next)

      expect(mockRateLimiter.consume).toHaveBeenCalledWith('test-key-id')
      expect(next).toHaveBeenCalled()
      expect(res.status).not.toHaveBeenCalled()
    })

    it('应该在超出速率限制时返回429错误', async () => {
      const rateLimitError = new Error('Rate limit exceeded')
      rateLimitError.remainingPoints = 0
      rateLimitError.msBeforeNext = 30000
      mockRateLimiter.consume.mockRejectedValue(rateLimitError)

      await authenticateApiKey(req, res, next)

      expect(res.status).toHaveBeenCalledWith(429)
      expect(res.json).toHaveBeenCalledWith({
        error: 'Rate limit exceeded',
        message: 'Too many requests. Please try again later.',
        retryAfter: Math.ceil(30000 / 1000) // 30秒
      })
      expect(logger.security).toHaveBeenCalledWith(expect.stringContaining('Rate limit exceeded'))
      expect(next).not.toHaveBeenCalled()
    })

    it('应该处理速率限制器错误', async () => {
      mockRateLimiter.consume.mockRejectedValue(new Error('Redis connection failed'))

      await authenticateApiKey(req, res, next)

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('Rate limiter error:'),
        expect.any(Error)
      )
      // 应该继续处理请求，即使速率限制器失败
      expect(next).toHaveBeenCalled()
    })
  })

  describe('并发限制', () => {
    beforeEach(() => {
      req.headers['x-api-key'] = sampleRequests.apiKeys.valid
    })

    it('应该在并发限制内正常通过', async () => {
      const mockKeyData = {
        id: 'test-key-id',
        name: 'Test Key',
        isActive: 'true',
        concurrencyLimit: '5',
        currentConcurrency: '2'
      }

      apiKeyService.validateApiKey.mockResolvedValue({
        valid: true,
        keyData: mockKeyData
      })

      await authenticateApiKey(req, res, next)

      expect(next).toHaveBeenCalled()
      expect(res.status).not.toHaveBeenCalled()
    })

    it('应该在超出并发限制时返回429错误', async () => {
      const mockKeyData = {
        id: 'test-key-id',
        name: 'Test Key',
        isActive: 'true',
        concurrencyLimit: '3',
        currentConcurrency: '3' // 已达到限制
      }

      apiKeyService.validateApiKey.mockResolvedValue({
        valid: true,
        keyData: mockKeyData
      })

      await authenticateApiKey(req, res, next)

      expect(res.status).toHaveBeenCalledWith(429)
      expect(res.json).toHaveBeenCalledWith({
        error: 'Concurrency limit exceeded',
        message: 'Too many concurrent requests for this API key. Please wait for current requests to complete.'
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
      expect(req.authProcessingTime).toBeGreaterThan(0)
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
        expect.stringContaining('API key validation failed from 192.168.1.102')
      )
    })

    it('应该记录安全事件 - 速率限制超出', async () => {
      req.headers['x-api-key'] = sampleRequests.apiKeys.valid
      req.ip = '192.168.1.103'

      apiKeyService.validateApiKey.mockResolvedValue({
        valid: true,
        keyData: { id: 'test-key-id', name: 'Test Key', isActive: 'true' }
      })

      const rateLimitError = new Error('Rate limit exceeded')
      rateLimitError.remainingPoints = 0
      rateLimitError.msBeforeNext = 60000
      mockRateLimiter.consume.mockRejectedValue(rateLimitError)

      await authenticateApiKey(req, res, next)

      expect(logger.security).toHaveBeenCalledWith(
        expect.stringContaining('Rate limit exceeded for key test-key-id from 192.168.1.103')
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

      await authenticateApiKey(req, res, next)

      // 实际上Authorization header仍会被检查，但Basic格式不会提取到apiKey
      expect(res.status).toHaveBeenCalledWith(401)
      expect(res.json).toHaveBeenCalledWith({
        error: 'Missing API key',
        message: 'Please provide an API key in the x-api-key header or Authorization header'
      })
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
        error: 'Internal server error',
        message: 'Authentication service temporarily unavailable'
      })
    })
  })
})