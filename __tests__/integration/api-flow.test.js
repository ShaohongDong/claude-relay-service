// API流程集成测试
const request = require('supertest')
const express = require('express')
const apiRoutes = require('../../src/routes/api')
const { authenticateApiKey } = require('../../src/middleware/auth')
const sampleRequests = require('../fixtures/sample-requests')

// Mock所有依赖服务
jest.mock('../../src/services/apiKeyService')
jest.mock('../../src/services/claudeRelayService')
jest.mock('../../src/services/claudeConsoleRelayService')
jest.mock('../../src/services/bedrockRelayService')
jest.mock('../../src/services/bedrockAccountService')
jest.mock('../../src/services/unifiedClaudeScheduler')
jest.mock('../../src/models/redis')
jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
  security: jest.fn(),
  api: jest.fn(),
  claude: jest.fn()
}))
jest.mock('../../src/utils/sessionHelper')

// Mock config
jest.mock('../../config/config', () => ({
  claude: {
    apiUrl: 'https://api.anthropic.com',
    apiVersion: '2023-06-01',
    betaHeader: 'claude-3-5-sonnet-20241022'
  },
  security: {
    apiKeyPrefix: 'cr_',
    encryptionKey: '12345678901234567890123456789012',
    apiKeySalt: 'test-salt'
  },
  limits: {
    defaultTokenLimit: 1000
  }
}))

describe('API流程集成测试', () => {
  let app
  let mockApiKeyService
  let mockClaudeRelayService
  let mockUnifiedClaudeScheduler

  beforeAll(() => {
    // 创建Express应用
    app = express()
    app.use(express.json())
    
    // 添加认证中间件
    app.use('/api', authenticateApiKey)
    
    // 添加API路由
    app.use('/api', apiRoutes)
    
    // 错误处理中间件
    app.use((error, req, res, next) => {
      res.status(500).json({ error: error.message })
    })
  })

  beforeEach(() => {
    jest.clearAllMocks()

    // 获取mock实例
    mockApiKeyService = require('../../src/services/apiKeyService')
    mockClaudeRelayService = require('../../src/services/claudeRelayService')
    mockUnifiedClaudeScheduler = require('../../src/services/unifiedClaudeScheduler')

    // 设置默认的successful mocks
    mockApiKeyService.validateApiKey = jest.fn().mockResolvedValue({
      valid: true,
      keyData: {
        id: 'test-key-id',
        name: 'Test Key',
        isActive: 'true',
        tokenLimit: 1000,
        totalTokensUsed: 100,
        permissions: 'all',
        concurrencyLimit: 10,
        rateLimitWindow: '1h',
        rateLimitRequests: 100,
        enableModelRestriction: false,
        restrictedModels: [],
        enableClientRestriction: false,
        allowedClients: [],
        dailyCostLimit: 100,
        dailyCost: 5,
        usage: {
          requests: 0,
          tokens: 1000
        },
        claudeAccountId: null,
        claudeConsoleAccountId: null,
        geminiAccountId: null,
        openaiAccountId: null,
        bedrockAccountId: null
      }
    })

    // Mock for usage stats
    mockApiKeyService.getUsageStats = jest.fn().mockResolvedValue({
      totalTokens: 100,
      requests: 5,
      inputTokens: 50,
      outputTokens: 50
    })

    // Mock for unified scheduler
    mockUnifiedClaudeScheduler.selectAccountForApiKey = jest.fn().mockResolvedValue({
      accountId: 'test-claude-account-1',
      accountType: 'claude-official'
    })

    // Mock for session helper
    const mockSessionHelper = require('../../src/utils/sessionHelper')
    mockSessionHelper.generateSessionHash = jest.fn().mockReturnValue('test-session-hash')
  })

  describe('POST /api/v1/messages', () => {
    it('应该成功处理有效的消息请求', async () => {
      // Mock successful relay
      mockClaudeRelayService.relayRequest = jest.fn().mockResolvedValue({
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sampleRequests.responses.claude)
      })

      const response = await request(app)
        .post('/api/v1/messages')
        .set('x-api-key', sampleRequests.apiKeys.valid)
        .set('content-type', 'application/json')
        .send(sampleRequests.validClaudeRequest)

      expect(response.status).toBe(200)
      expect(mockApiKeyService.validateApiKey).toHaveBeenCalledWith(sampleRequests.apiKeys.valid)
      expect(mockClaudeRelayService.relayRequest).toHaveBeenCalled()
    })

    it('应该拒绝没有API Key的请求', async () => {
      const response = await request(app)
        .post('/api/v1/messages')
        .set('content-type', 'application/json')
        .send(sampleRequests.validClaudeRequest)

      expect(response.status).toBe(401)
      expect(response.body.error).toBe('Missing API key')
    })

    it('应该拒绝无效的API Key', async () => {
      mockApiKeyService.validateApiKey.mockResolvedValue({
        valid: false,
        error: 'Invalid API key'
      })

      const response = await request(app)
        .post('/api/v1/messages')
        .set('x-api-key', sampleRequests.apiKeys.invalid)
        .set('content-type', 'application/json')
        .send(sampleRequests.validClaudeRequest)

      expect(response.status).toBe(401)
      expect(response.body.error).toBe('Invalid API key')
    })

    it('应该验证请求体格式', async () => {
      const response = await request(app)
        .post('/api/v1/messages')
        .set('x-api-key', sampleRequests.apiKeys.valid)
        .set('content-type', 'application/json')
        .send(sampleRequests.invalidRequests.missingMessages)

      expect(response.status).toBe(400)
      expect(response.body.error).toBe('Invalid request')
      expect(response.body.message).toContain('messages')
    })

    it('应该拒绝空的messages数组', async () => {
      const response = await request(app)
        .post('/api/v1/messages')
        .set('x-api-key', sampleRequests.apiKeys.valid)
        .set('content-type', 'application/json')
        .send(sampleRequests.invalidRequests.emptyMessages)

      expect(response.status).toBe(400)
      expect(response.body.error).toBe('Invalid request')
      expect(response.body.message).toContain('cannot be empty')
    })

    it('应该拒绝非数组的messages字段', async () => {
      const response = await request(app)
        .post('/api/v1/messages')
        .set('x-api-key', sampleRequests.apiKeys.valid)
        .set('content-type', 'application/json')
        .send(sampleRequests.invalidRequests.invalidMessages)

      expect(response.status).toBe(400)
      expect(response.body.error).toBe('Invalid request')
      expect(response.body.message).toContain('must be an array')
    })

    it('应该处理Claude Relay Service错误', async () => {
      mockClaudeRelayService.relayRequest.mockRejectedValue(new Error('Relay service error'))

      const response = await request(app)
        .post('/api/v1/messages')
        .set('x-api-key', sampleRequests.apiKeys.valid)
        .set('content-type', 'application/json')
        .send(sampleRequests.validClaudeRequest)

      expect(response.status).toBe(500)
      expect(response.body.error).toContain('Relay service error')
    })

    it('应该支持流式请求', async () => {
      // 流式请求使用不同的方法
      mockClaudeRelayService.relayStreamRequestWithUsageCapture = jest.fn().mockImplementation((body, apiKey, res, headers, callback) => {
        // 模拟SSE流式响应
        res.setHeader('Content-Type', 'text/event-stream')
        res.setHeader('Cache-Control', 'no-cache')
        res.setHeader('Connection', 'keep-alive')
        
        res.write('data: {"type": "message_start"}\n\n')
        res.write('data: {"type": "content_block_start"}\n\n')
        res.write('data: {"type": "content_block_delta", "delta": {"text": "Hello"}}\n\n')
        res.write('data: {"type": "content_block_stop"}\n\n')
        res.write('data: {"type": "message_stop"}\n\n')
        res.end()
        
        // 调用usage回调
        if (callback) {
          callback({ input_tokens: 10, output_tokens: 5 })
        }
        
        return Promise.resolve()
      })

      const response = await request(app)
        .post('/api/v1/messages')
        .set('x-api-key', sampleRequests.apiKeys.valid)
        .set('content-type', 'application/json')
        .send(sampleRequests.streamingRequest)

      expect(response.status).toBe(200)
      expect(response.headers['content-type']).toContain('text/event-stream')
    }, 15000) // 增加超时时间到15秒
  })

  describe('GET /api/v1/models', () => {
    it('应该返回支持的模型列表', async () => {
      const response = await request(app)
        .get('/api/v1/models')
        .set('x-api-key', sampleRequests.apiKeys.valid)

      expect(response.status).toBe(200)
      expect(response.body).toHaveProperty('data')
      expect(Array.isArray(response.body.data)).toBe(true)
    })

    it('应该要求API Key认证', async () => {
      const response = await request(app)
        .get('/api/v1/models')

      expect(response.status).toBe(401)
      expect(response.body.error).toBe('Missing API key')
    })
  })

  describe('GET /api/v1/usage', () => {
    it('应该返回使用统计信息', async () => {
      const response = await request(app)
        .get('/api/v1/usage')
        .set('x-api-key', sampleRequests.apiKeys.valid)

      expect(response.status).toBe(200)
      expect(response.body).toHaveProperty('usage')
    })
  })

  describe('GET /api/v1/key-info', () => {
    it('应该返回API Key信息', async () => {
      const response = await request(app)
        .get('/api/v1/key-info')
        .set('x-api-key', sampleRequests.apiKeys.valid)

      expect(response.status).toBe(200)
      expect(response.body).toHaveProperty('keyInfo')
      expect(response.body.keyInfo.id).toBe('test-key-id')
    })
  })

  describe('错误处理和边界情况', () => {
    it('应该处理JSON解析错误', async () => {
      const response = await request(app)
        .post('/api/v1/messages')
        .set('x-api-key', sampleRequests.apiKeys.valid)
        .set('content-type', 'application/json')
        .send('{"invalid": json}') // 无效JSON

      expect(response.status).toBe(400)
    })

    it('应该处理缺少Content-Type header的请求', async () => {
      const response = await request(app)
        .post('/api/v1/messages')
        .set('x-api-key', sampleRequests.apiKeys.valid)
        .send(JSON.stringify(sampleRequests.validClaudeRequest))

      // 应该仍能处理，因为express.json()会尝试解析
      expect(response.status).not.toBe(415)
    })

    it('应该处理超大请求体', async () => {
      const largeContent = 'x'.repeat(1000000) // 1MB content
      const largeRequest = {
        ...sampleRequests.validClaudeRequest,
        messages: [{
          role: 'user',
          content: largeContent
        }]
      }

      const response = await request(app)
        .post('/api/v1/messages')
        .set('x-api-key', sampleRequests.apiKeys.valid)
        .set('content-type', 'application/json')
        .send(largeRequest)

      // 应该能处理大请求或返回适当错误
      expect([200, 400, 413]).toContain(response.status)
    })

    it('应该处理API Key服务超时', async () => {
      mockApiKeyService.validateApiKey.mockImplementation(() => {
        return new Promise((resolve, reject) => {
          setTimeout(() => reject(new Error('Timeout')), 6000)
        })
      })

      const response = await request(app)
        .post('/api/v1/messages')
        .set('x-api-key', sampleRequests.apiKeys.valid)
        .set('content-type', 'application/json')
        .send(sampleRequests.validClaudeRequest)

      expect(response.status).toBe(500)
    }, 10000) // 增加测试超时时间
  })

  describe('Headers处理', () => {
    it('应该正确传递客户端headers', async () => {
      mockClaudeRelayService.relayRequest = jest.fn().mockResolvedValue({
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sampleRequests.responses.claude)
      })

      const customHeaders = {
        'x-api-key': sampleRequests.apiKeys.valid,
        'content-type': 'application/json',
        'user-agent': 'claude-cli/1.0.0',
        'anthropic-version': '2023-06-01',
        'x-custom-header': 'test-value'
      }

      const response = await request(app)
        .post('/api/v1/messages')
        .set(customHeaders)
        .send(sampleRequests.validClaudeRequest)

      expect(response.status).toBe(200)
      
      // 验证relay service收到了正确的headers  
      const relayCall = mockClaudeRelayService.relayRequest.mock.calls[0]
      const req = relayCall[2] // req对象是第3个参数（索引2）
      expect(req.headers['user-agent']).toBe('claude-cli/1.0.0')
      expect(req.headers['anthropic-version']).toBe('2023-06-01')
    })

    it('应该处理大小写不敏感的headers', async () => {
      mockClaudeRelayService.relayRequest = jest.fn().mockResolvedValue({
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sampleRequests.responses.claude)
      })

      const response = await request(app)
        .post('/api/v1/messages')
        .set('X-API-KEY', sampleRequests.apiKeys.valid) // 大写header名
        .set('Content-Type', 'application/json')
        .send(sampleRequests.validClaudeRequest)

      expect(response.status).toBe(200)
    })
  })
})