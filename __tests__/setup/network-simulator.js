// 网络模拟测试工具 - 使用nock提供真实HTTP交互模拟
const nock = require('nock')
const { EventEmitter } = require('events')

/**
 * 网络模拟器 - 提供完整的HTTP/HTTPS请求模拟
 * 专门针对Claude Relay Service的网络交互模式
 */
class NetworkSimulator {
  constructor() {
    this.interceptors = new Map()
    this.activeScenarios = new Set()
    this.requestHistory = []
    this.isRecording = false
    this.proxyConfig = null
  }

  /**
   * 初始化网络模拟环境
   * @param {Object} options - 配置选项
   */
  initialize(options = {}) {
    // 清理之前可能存在的拦截器
    nock.cleanAll()
    
    // 启用网络拦截 - 默认禁用所有网络连接
    if (!options.allowRealNetwork) {
      nock.disableNetConnect()
      
      // 允许本地连接（用于测试服务器）
      if (options.allowLocalhost) {
        nock.enableNetConnect('127.0.0.1')
        nock.enableNetConnect('localhost')
      }
    }
    
    // 启用请求记录
    if (options.enableRecording) {
      this.startRecording()
    }
    
    // 设置代理配置
    if (options.proxyConfig) {
      this.proxyConfig = options.proxyConfig
    }
    
    return this
  }

  /**
   * 清理所有网络拦截
   */
  cleanup() {
    nock.cleanAll()
    nock.enableNetConnect() // 重新启用所有网络连接
    this.interceptors.clear()
    this.activeScenarios.clear()
    this.requestHistory = []
    this.isRecording = false
    this.proxyConfig = null
    
    return this
  }

  /**
   * 开始记录网络请求
   */
  startRecording() {
    this.isRecording = true
    this.requestHistory = []
    
    // 拦截所有请求进行记录
    nock.recorder.rec({
      dont_print: true,
      output_objects: true,
      enable_reqheaders_recording: true
    })
    
    return this
  }

  /**
   * 停止记录并获取记录的请求
   */
  stopRecording() {
    const recorded = nock.recorder.play()
    this.isRecording = false
    nock.recorder.clear()
    
    return recorded.map(req => ({
      ...req,
      timestamp: new Date()
    }))
  }

  /**
   * 模拟Claude API响应
   */
  mockClaudeAPI() {
    const claudeAPI = nock('https://api.anthropic.com', {
      reqheaders: {
        'authorization': /^Bearer /,
        'content-type': 'application/json',
        'anthropic-version': /^2023-/
      }
    })

    return {
      // 成功的消息响应
      messages: (options = {}) => {
        const {
          model = 'claude-3-5-sonnet-20241022',
          streaming = false,
          delay = 100,
          tokens = 150
        } = options

        if (streaming) {
          return this._mockStreamingResponse(claudeAPI, '/v1/messages', {
            model,
            delay,
            tokens
          })
        } else {
          return claudeAPI
            .post('/v1/messages')
            .delay(delay)
            .reply(200, {
              id: `msg_${Math.random().toString(36).substr(2, 9)}`,
              type: 'message',
              role: 'assistant',
              content: [{
                type: 'text',
                text: 'This is a simulated Claude response for testing.'
              }],
              model,
              stop_reason: 'end_turn',
              stop_sequence: null,
              usage: {
                input_tokens: 10,
                output_tokens: tokens
              }
            })
        }
      },

      // 模型列表
      models: () => claudeAPI
        .get('/v1/models')
        .reply(200, {
          data: [
            {
              id: 'claude-3-5-sonnet-20241022',
              object: 'model',
              created: 1234567890,
              owned_by: 'anthropic'
            },
            {
              id: 'claude-3-haiku-20240307',
              object: 'model', 
              created: 1234567890,
              owned_by: 'anthropic'
            }
          ]
        }),

      // 认证错误
      authError: () => nock('https://api.anthropic.com')
        .post('/v1/messages')
        .reply(401, {
          type: 'error',
          error: {
            type: 'authentication_error',
            message: 'Invalid API Key'
          }
        }),

      // 速率限制错误
      rateLimitError: () => nock('https://api.anthropic.com')
        .post('/v1/messages')
        .reply(429, {
          type: 'error',
          error: {
            type: 'rate_limit_error',
            message: 'Rate limit exceeded'
          }
        }, {
          'retry-after': '60'
        }),

      // 服务器错误
      serverError: (statusCode = 500) => nock('https://api.anthropic.com')
        .post('/v1/messages')
        .reply(statusCode, {
          type: 'error',
          error: {
            type: 'internal_server_error',
            message: 'Internal server error'
          }
        })
    }
  }

  /**
   * 模拟Gemini API响应
   */
  mockGeminiAPI() {
    const geminiAPI = nock('https://generativelanguage.googleapis.com', {
      reqheaders: {
        'authorization': /^Bearer /,
        'content-type': 'application/json'
      }
    })

    return {
      // 生成内容响应
      generateContent: (options = {}) => {
        const {
          model = 'gemini-1.5-pro',
          streaming = false,
          delay = 120,
          tokens = 200
        } = options

        if (streaming) {
          return this._mockStreamingResponse(geminiAPI, `/v1beta/models/${model}:streamGenerateContent`, {
            model,
            delay,
            tokens,
            format: 'gemini'
          })
        } else {
          return geminiAPI
            .post(`/v1beta/models/${model}:generateContent`)
            .delay(delay)
            .reply(200, {
              candidates: [{
                content: {
                  parts: [{
                    text: 'This is a simulated Gemini response for testing.'
                  }],
                  role: 'model'
                },
                finishReason: 'STOP',
                index: 0
              }],
              usageMetadata: {
                promptTokenCount: 10,
                candidatesTokenCount: tokens,
                totalTokenCount: 10 + tokens
              }
            })
        }
      },

      // 模型信息
      models: () => geminiAPI
        .get('/v1beta/models')
        .reply(200, {
          models: [
            {
              name: 'models/gemini-1.5-pro',
              displayName: 'Gemini 1.5 Pro',
              description: 'Gemini 1.5 Pro model'
            }
          ]
        }),

      // API Key错误
      invalidApiKey: () => geminiAPI
        .post(/\/v1beta\/models\/.*:generateContent/)
        .reply(400, {
          error: {
            code: 400,
            message: 'API key not valid. Please pass a valid API key.',
            status: 'INVALID_ARGUMENT'
          }
        })
    }
  }

  /**
   * 模拟OAuth端点
   */
  mockOAuthEndpoints() {
    const claudeOAuth = nock('https://claude.ai')
    const googleOAuth = nock('https://oauth2.googleapis.com')

    return {
      claude: {
        // Token交换
        tokenExchange: (options = {}) => {
          const { success = true, delay = 200 } = options
          
          if (success) {
            return claudeOAuth
              .post('/api/oauth/token')
              .delay(delay)
              .reply(200, {
                access_token: `access_${Math.random().toString(36).substr(2, 20)}`,
                refresh_token: `refresh_${Math.random().toString(36).substr(2, 20)}`,
                expires_in: 3600,
                token_type: 'Bearer',
                scope: 'openid profile'
              })
          } else {
            return claudeOAuth
              .post('/api/oauth/token')
              .delay(delay)
              .reply(400, {
                error: 'invalid_grant',
                error_description: 'Invalid authorization code'
              })
          }
        },

        // Token刷新
        tokenRefresh: (options = {}) => {
          const { success = true, delay = 150 } = options
          
          if (success) {
            return claudeOAuth
              .post('/api/oauth/token')
              .delay(delay)
              .reply(200, {
                access_token: `new_access_${Math.random().toString(36).substr(2, 20)}`,
                expires_in: 3600,
                token_type: 'Bearer'
              })
          } else {
            return claudeOAuth
              .post('/api/oauth/token')
              .delay(delay)
              .reply(400, {
                error: 'invalid_grant',
                error_description: 'Invalid refresh token'
              })
          }
        }
      },

      google: {
        // Token刷新
        tokenRefresh: (options = {}) => {
          const { success = true, delay = 180 } = options
          
          return googleOAuth
            .post('/token')
            .delay(delay)
            .reply(success ? 200 : 400, success ? {
              access_token: `google_access_${Math.random().toString(36).substr(2, 20)}`,
              expires_in: 3600,
              token_type: 'Bearer'
            } : {
              error: 'invalid_grant',
              error_description: 'Token has been expired or revoked.'
            })
        }
      }
    }
  }

  /**
   * 模拟网络错误场景
   */
  mockNetworkErrors() {
    return {
      // 连接超时
      timeout: (url, delay = 30000) => {
        const scope = nock(url).persist()
        const methods = ['get', 'post', 'put', 'patch', 'delete']
        
        methods.forEach(method => {
          scope[method](() => true)
            .delay(delay)
            .replyWithError({ code: 'ETIMEDOUT', message: 'Request timeout' })
        })
        
        return scope
      },

      // 连接拒绝
      connectionRefused: (url) => {
        const scope = nock(url).persist()
        const methods = ['get', 'post', 'put', 'patch', 'delete']
        
        methods.forEach(method => {
          scope[method](() => true)
            .replyWithError({ code: 'ECONNREFUSED', message: 'Connection refused' })
        })
        
        return scope
      },

      // DNS解析失败
      dnsError: (url) => {
        const scope = nock(url).persist()
        const methods = ['get', 'post', 'put', 'patch', 'delete']
        
        methods.forEach(method => {
          scope[method](() => true)
            .replyWithError({ code: 'ENOTFOUND', message: 'DNS lookup failed' })
        })
        
        return scope
      },

      // SSL/TLS错误
      sslError: (url) => {
        const scope = nock(url).persist()
        const methods = ['get', 'post', 'put', 'patch', 'delete']
        
        methods.forEach(method => {
          scope[method](() => true)
            .replyWithError({ code: 'DEPTH_ZERO_SELF_SIGNED_CERT', message: 'SSL certificate error' })
        })
        
        return scope
      },

      // 网络中断（间歇性错误）
      intermittentError: (url, successRate = 0.5) => {
        const scope = nock(url).persist()
        const methods = ['get', 'post', 'put', 'patch', 'delete']
        
        methods.forEach(method => {
          scope[method](() => true)
            .reply(() => {
              if (Math.random() < successRate) {
                return [200, { success: true }]
              } else {
                return [500, { error: 'Service temporarily unavailable' }]
              }
            })
        })
        
        return scope
      },

      // 慢速网络
      slowNetwork: (url, minDelay = 5000, maxDelay = 15000) => {
        const scope = nock(url).persist()
        const methods = ['get', 'post', 'put', 'patch', 'delete']
        
        methods.forEach(method => {
          scope[method](() => true)
            .delay(() => Math.random() * (maxDelay - minDelay) + minDelay)
            .reply(200, { data: 'slow response' })
        })
        
        return scope
      }
    }
  }

  /**
   * 模拟流式响应
   * @private
   */
  _mockStreamingResponse(scope, path, options = {}) {
    const { model, delay = 100, tokens = 150, format = 'claude' } = options
    
    return scope
      .post(path)
      .delay(delay)
      .reply(200, (uri, requestBody) => {
        // 创建SSE流模拟
        const chunks = this._generateStreamChunks(model, tokens, format)
        let chunkIndex = 0
        
        // 返回可读流
        const stream = new EventEmitter()
        
        const sendNextChunk = () => {
          if (chunkIndex < chunks.length) {
            stream.emit('data', chunks[chunkIndex])
            chunkIndex++
            setTimeout(sendNextChunk, 50) // 50ms间隔发送chunks
          } else {
            stream.emit('end')
          }
        }
        
        // 立即开始发送
        setTimeout(sendNextChunk, 10)
        
        return stream
      }, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        'connection': 'keep-alive'
      })
  }

  /**
   * 生成流式响应数据块
   * @private
   */
  _generateStreamChunks(model, tokens, format = 'claude') {
    const chunks = []
    const words = ['This', 'is', 'a', 'simulated', 'streaming', 'response', 'for', 'testing', 'purposes', '.']
    
    if (format === 'claude') {
      // Claude格式的SSE chunks
      chunks.push('data: {"type":"message_start","message":{"id":"msg_test","type":"message","role":"assistant","model":"' + model + '","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":10,"output_tokens":0}}}\n\n')
      
      chunks.push('data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n')
      
      // 文本块
      words.forEach(word => {
        chunks.push(`data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"${word} "}}\n\n`)
      })
      
      chunks.push('data: {"type":"content_block_stop","index":0}\n\n')
      
      chunks.push(`data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":${tokens}}}\n\n`)
      
      chunks.push('data: {"type":"message_stop"}\n\n')
      
    } else if (format === 'gemini') {
      // Gemini格式的streaming chunks
      words.forEach((word, index) => {
        chunks.push(`data: {"candidates":[{"content":{"parts":[{"text":"${word} "}],"role":"model"},"finishReason":null,"index":0}]}\n\n`)
      })
      
      chunks.push(`data: {"candidates":[{"finishReason":"STOP","index":0}],"usageMetadata":{"candidatesTokenCount":${tokens}}}\n\n`)
    }
    
    return chunks
  }

  /**
   * 创建代理测试场景
   */
  createProxyScenarios() {
    return {
      // SOCKS5代理测试
      socksProxy: (proxyHost = '127.0.0.1', proxyPort = 1080) => {
        return {
          type: 'socks5',
          config: {
            host: proxyHost,
            port: proxyPort,
            username: 'testuser',
            password: 'testpass'
          },
          mock: () => {
            // 模拟通过代理的请求
            return nock('https://api.anthropic.com')
              .persist()
              .post('/v1/messages')
              .reply(200, { message: 'Request via SOCKS5 proxy successful' })
          }
        }
      },

      // HTTP代理测试
      httpProxy: (proxyHost = '127.0.0.1', proxyPort = 8080) => {
        return {
          type: 'http',
          config: {
            host: proxyHost,
            port: proxyPort,
            auth: 'testuser:testpass'
          },
          mock: () => {
            return nock('https://api.anthropic.com')
              .persist()
              .post('/v1/messages')
              .reply(200, { message: 'Request via HTTP proxy successful' })
          }
        }
      },

      // 代理认证失败
      proxyAuthFailure: () => {
        return nock('https://api.anthropic.com')
          .persist()
          .post('/v1/messages')
          .replyWithError({ code: 'ECONNREFUSED', message: 'Proxy authentication required' })
      }
    }
  }

  /**
   * 获取请求统计信息
   */
  getRequestStats() {
    const pendingMocks = nock.pendingMocks()
    const activeMocks = nock.activeMocks()
    
    return {
      pendingMocks: pendingMocks.length,
      activeMocks: activeMocks.length,
      interceptors: this.interceptors.size,
      scenarios: this.activeScenarios.size,
      recordedRequests: this.requestHistory.length,
      isRecording: this.isRecording
    }
  }

  /**
   * 验证所有预期的请求都被调用了
   */
  verifyAllRequestsCalled() {
    const pending = nock.pendingMocks()
    if (pending.length > 0) {
      throw new Error(`Pending mocks not satisfied: ${pending.join(', ')}`)
    }
    return true
  }

  /**
   * 便捷API - 直接模拟超时错误
   * @param {string} url - 要模拟的URL
   * @param {number} delay - 超时延迟时间
   */
  simulateTimeout(url, delay = 30000) {
    const errors = this.mockNetworkErrors()
    return errors.timeout(url, delay)
  }

  /**
   * 便捷API - 直接模拟HTTP错误
   * @param {string} url - 要模拟的URL
   * @param {number} statusCode - HTTP状态码
   * @param {string|Object} errorData - 错误数据
   */
  simulateHttpError(url, statusCode = 500, errorData = 'Server Error') {
    const errorResponse = typeof errorData === 'string' 
      ? { error: errorData }
      : errorData

    const scope = nock(url).persist()
    const methods = ['get', 'post', 'put', 'patch', 'delete']
    
    methods.forEach(method => {
      scope[method](() => true)
        .reply(statusCode, errorResponse)
    })
    
    return scope
  }

  /**
   * 便捷API - 直接模拟连接被拒绝错误
   * @param {string} url - 要模拟的URL
   */
  simulateConnectionRefused(url) {
    const errors = this.mockNetworkErrors()
    return errors.connectionRefused(url)
  }

  /**
   * 便捷API - 直接模拟DNS错误
   * @param {string} url - 要模拟的URL
   */
  simulateDnsError(url) {
    const errors = this.mockNetworkErrors()
    return errors.dnsError(url)
  }

  /**
   * 便捷API - 直接模拟SSL错误
   * @param {string} url - 要模拟的URL
   */
  simulateSslError(url) {
    const errors = this.mockNetworkErrors()
    return errors.sslError(url)
  }

  /**
   * 便捷API - 直接模拟网络中断
   * @param {string} url - 要模拟的URL
   * @param {number} successRate - 成功率 (0-1)
   */
  simulateIntermittentError(url, successRate = 0.5) {
    const errors = this.mockNetworkErrors()
    return errors.intermittentError(url, successRate)
  }
}

/**
 * 网络测试工具函数
 */
const networkTestUtils = {
  /**
   * 在网络模拟环境中运行测试
   */
  async withNetworkSimulation(testFn, options = {}) {
    const simulator = new NetworkSimulator()
    
    try {
      simulator.initialize(options)
      await testFn(simulator)
    } finally {
      simulator.cleanup()
    }
  },

  /**
   * 创建网络延迟测试
   */
  createLatencyTest(scenarios) {
    return async (simulator) => {
      const results = {}
      
      for (const [name, config] of Object.entries(scenarios)) {
        const startTime = Date.now()
        
        // 设置mock响应
        const mock = nock(config.url)
          .post(config.path || '/')
          .delay(config.delay || 100)
          .reply(200, config.response || { success: true })
        
        try {
          // 执行请求
          const axios = require('axios')
          await axios.post(`${config.url}${config.path || '/'}`, config.data || {})
          
          results[name] = {
            latency: Date.now() - startTime,
            success: true
          }
        } catch (error) {
          results[name] = {
            latency: Date.now() - startTime,
            success: false,
            error: error.message
          }
        }
      }
      
      return results
    }
  },

  /**
   * 创建错误恢复测试
   */
  createRetryTest(maxRetries = 3, retryDelay = 1000) {
    return async (simulator) => {
      let attempts = 0
      
      const mockWithRetry = nock('https://test-api.com')
        .persist()
        .post('/endpoint')
        .reply(() => {
          attempts++
          if (attempts <= maxRetries) {
            return [500, { error: 'Server error' }]
          } else {
            return [200, { success: true, attempts }]
          }
        })
      
      return { attempts, mock: mockWithRetry }
    }
  }
}

module.exports = {
  NetworkSimulator,
  networkTestUtils
}