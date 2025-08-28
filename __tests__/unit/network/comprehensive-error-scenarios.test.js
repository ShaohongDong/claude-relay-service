// 综合网络错误场景测试 - 覆盖15+种真实网络故障情况
const { NetworkSimulator, networkTestUtils } = require('../../setup/network-simulator')
const axios = require('axios')
const nock = require('nock')

/**
 * 高级网络错误模拟器 - 专门用于测试各种网络故障场景
 */
class ComprehensiveErrorSimulator extends NetworkSimulator {
  constructor() {
    super()
    this.errorScenarios = new Map()
    this.activeTests = new Set()
  }

  /**
   * 创建复杂的错误场景
   */
  createAdvancedErrorScenarios() {
    return {
      // 1. 连接超时 - 不同超时时间
      connectionTimeouts: {
        immediate: () => this._createTimeoutError('https://timeout-immediate.test', 0),
        short: () => this._createTimeoutError('https://timeout-short.test', 100),
        medium: () => this._createTimeoutError('https://timeout-medium.test', 5000),
        long: () => this._createTimeoutError('https://timeout-long.test', 30000)
      },

      // 2. 读取超时 - 服务器响应慢
      readTimeouts: {
        partialResponse: () => nock('https://read-timeout.test')
          .get('/partial')
          .delay(10000) // 10秒延迟
          .reply(200, 'Partial response that takes too long'),
        
        hangingResponse: () => nock('https://read-timeout.test')
          .post('/hanging')
          .delay(20000) // 模拟响应延迟
          .reply(200, { data: 'Eventually responds' }),

        slowUpload: () => nock('https://read-timeout.test')
          .put('/upload')
          .delay(15000) // 上传过程中延迟
          .reply(200, { uploaded: true })
      },

      // 3. 连接被拒绝 - 各种拒绝原因
      connectionRefused: {
        portClosed: () => nock('https://refused-port.test')
          .persist()
          .get(() => true)
          .replyWithError({ code: 'ECONNREFUSED', errno: -61, syscall: 'connect' }),
        
        serviceDown: () => nock('https://refused-service.test')
          .persist()
          .post(() => true)
          .replyWithError({ code: 'ECONNREFUSED', message: 'Service unavailable' }),

        firewallBlock: () => nock('https://refused-firewall.test')
          .persist()
          .get(() => true)
          .replyWithError({ code: 'EHOSTUNREACH', message: 'Host unreachable' })
      },

      // 4. DNS解析错误 - 各种DNS问题
      dnsErrors: {
        notFound: () => nock('https://nonexistent-domain.test')
          .persist()
          .get(() => true)
          .replyWithError({ code: 'ENOTFOUND', hostname: 'nonexistent-domain.test' }),
        
        timeout: () => nock('https://dns-timeout.test')
          .persist()
          .get(() => true)
          .replyWithError({ code: 'EAI_AGAIN', message: 'DNS lookup timeout' }),

        tempFailure: () => nock('https://dns-temp-fail.test')
          .persist()
          .get(() => true)
          .replyWithError({ code: 'EAI_AGAIN', message: 'Temporary DNS failure' })
      },

      // 5. SSL/TLS证书错误 - 各种证书问题
      sslErrors: {
        selfSigned: () => nock('https://ssl-self-signed.test')
          .persist()
          .get(() => true)
          .replyWithError({ code: 'DEPTH_ZERO_SELF_SIGNED_CERT' }),
        
        expired: () => nock('https://ssl-expired.test')
          .persist()
          .get(() => true)
          .replyWithError({ code: 'CERT_HAS_EXPIRED' }),

        untrustedRoot: () => nock('https://ssl-untrusted.test')
          .persist()
          .get(() => true)
          .replyWithError({ code: 'SELF_SIGNED_CERT_IN_CHAIN' }),

        hostnameMismatch: () => nock('https://ssl-hostname.test')
          .persist()
          .get(() => true)
          .replyWithError({ code: 'ERR_TLS_CERT_ALTNAME_INVALID' })
      },

      // 6. HTTP客户端错误 (4xx) - 各种客户端错误
      clientErrors: {
        badRequest: () => nock('https://client-errors.test')
          .post('/bad-request')
          .reply(400, { error: 'Bad Request', code: 'INVALID_PAYLOAD' }),
        
        unauthorized: () => nock('https://client-errors.test')
          .get('/unauthorized')
          .reply(401, { error: 'Unauthorized', code: 'INVALID_TOKEN' }),

        forbidden: () => nock('https://client-errors.test')
          .get('/forbidden')
          .reply(403, { error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }),

        notFound: () => nock('https://client-errors.test')
          .get('/not-found')
          .reply(404, { error: 'Not Found', code: 'RESOURCE_NOT_FOUND' }),

        methodNotAllowed: () => nock('https://client-errors.test')
          .put('/method-not-allowed')
          .reply(405, { error: 'Method Not Allowed' }),

        conflict: () => nock('https://client-errors.test')
          .post('/conflict')
          .reply(409, { error: 'Conflict', code: 'RESOURCE_CONFLICT' }),

        payloadTooLarge: () => nock('https://client-errors.test')
          .post('/large-payload')
          .reply(413, { error: 'Payload Too Large' })
      },

      // 7. HTTP服务器错误 (5xx) - 各种服务器错误
      serverErrors: {
        internalError: () => nock('https://server-errors.test')
          .get('/internal')
          .reply(500, { error: 'Internal Server Error', trace: 'stack-trace-here' }),
        
        notImplemented: () => nock('https://server-errors.test')
          .get('/not-implemented')
          .reply(501, { error: 'Not Implemented' }),

        badGateway: () => nock('https://server-errors.test')
          .get('/bad-gateway')
          .reply(502, { error: 'Bad Gateway', upstream: 'api-server-down' }),

        serviceUnavailable: () => nock('https://server-errors.test')
          .get('/unavailable')
          .reply(503, { error: 'Service Unavailable', retryAfter: 300 }),

        gatewayTimeout: () => nock('https://server-errors.test')
          .get('/gateway-timeout')
          .reply(504, { error: 'Gateway Timeout', timeout: 30000 }),

        httpVersionNotSupported: () => nock('https://server-errors.test')
          .get('/version-not-supported')
          .reply(505, { error: 'HTTP Version Not Supported' })
      },

      // 8. 速率限制错误 - 各种限流场景
      rateLimiting: {
        basicRateLimit: () => nock('https://rate-limit.test')
          .get('/basic')
          .reply(429, { error: 'Too Many Requests' }, { 'Retry-After': '60' }),
        
        quotaExceeded: () => nock('https://rate-limit.test')
          .post('/quota')
          .reply(429, { 
            error: 'Quota Exceeded', 
            quotaType: 'daily',
            resetTime: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
          }),

        concurrencyLimit: () => nock('https://rate-limit.test')
          .get('/concurrency')
          .reply(429, { error: 'Too Many Concurrent Requests', maxConcurrent: 10 }),

        tokenBucketEmpty: () => nock('https://rate-limit.test')
          .post('/token-bucket')
          .reply(429, { 
            error: 'Token Bucket Empty', 
            refillRate: '10/min',
            nextToken: Date.now() + 6000 
          })
      },

      // 9. 代理错误 - 各种代理问题
      proxyErrors: {
        authRequired: () => nock('https://proxy-errors.test')
          .get('/auth-required')
          .reply(407, { error: 'Proxy Authentication Required' }),
        
        connectionFailed: () => nock('https://proxy-errors.test')
          .get('/connection-failed')
          .replyWithError({ code: 'ECONNREFUSED', message: 'Proxy connection failed' }),

        tunnelFailed: () => nock('https://proxy-errors.test')
          .get('/tunnel-failed')
          .replyWithError({ code: 'ECONNRESET', message: 'Proxy tunnel establishment failed' })
      },

      // 10. 网络层错误 - 底层网络问题
      networkLayerErrors: {
        unreachable: () => nock('https://network-unreachable.test')
          .persist()
          .get(() => true)
          .replyWithError({ code: 'ENETUNREACH', message: 'Network unreachable' }),
        
        connectionReset: () => nock('https://connection-reset.test')
          .persist()
          .get(() => true)
          .replyWithError({ code: 'ECONNRESET', message: 'Connection reset by peer' }),

        brokenPipe: () => nock('https://broken-pipe.test')
          .persist()
          .post(() => true)
          .replyWithError({ code: 'EPIPE', message: 'Broken pipe' }),

        socketHangUp: () => nock('https://socket-hangup.test')
          .persist()
          .get(() => true)
          .replyWithError({ code: 'ECONNRESET', message: 'socket hang up' })
      },

      // 11. 请求取消场景 - AbortController测试
      requestCancellation: {
        userCancellation: (controller) => {
          setTimeout(() => controller.abort(), 100) // 100ms后取消
          return nock('https://cancellation.test')
            .get('/user-cancel')
            .delay(1000)
            .reply(200, { message: 'This should be cancelled' })
        },
        
        timeoutCancellation: (controller) => {
          setTimeout(() => controller.abort(), 500)
          return nock('https://cancellation.test')
            .post('/timeout-cancel')
            .delay(2000)
            .reply(200, { message: 'Timeout cancellation' })
        }
      },

      // 12. 间歇性网络故障 - 不稳定连接
      intermittentFailures: {
        flakyCconnection: () => {
          let attempts = 0
          return nock('https://intermittent.test')
            .persist()
            .get('/flaky')
            .reply(() => {
              attempts++
              if (attempts % 3 === 0) {
                return [200, { success: true, attempt: attempts }]
              } else if (attempts % 3 === 1) {
                // 模拟连接重置错误 - 返回适当的HTTP错误而不是抛出异常
                return [502, { error: 'Connection reset by peer', code: 'ECONNRESET' }]
              } else {
                return [500, { error: 'Server Error', attempt: attempts }]
              }
            })
        },

        packetLoss: () => {
          let attempts = 0
          return nock('https://packet-loss.test')
            .persist()
            .post('/lossy')
            .reply(() => {
              attempts++
              const dropRate = 0.4 // 40% 丢包率
              if (Math.random() < dropRate) {
                // 模拟丢包超时 - 返回408超时状态而不是抛出异常
                return [408, { error: 'Request timeout', code: 'ETIMEDOUT' }]
              }
              return [200, { received: true, attempt: attempts }]
            })
        }
      },

      // 13. 大负载处理错误
      payloadErrors: {
        tooLargeRequest: () => nock('https://payload-errors.test')
          .post('/large-request')
          .reply(413, { error: 'Request Entity Too Large', maxSize: '10MB' }),
        
        corruptedData: () => nock('https://payload-errors.test')
          .put('/corrupted')
          .reply(422, { error: 'Unprocessable Entity', reason: 'Data corruption detected' }),

        incompleteUpload: () => nock('https://payload-errors.test')
          .post('/incomplete')
          .replyWithError({ code: 'ECONNRESET', message: 'Upload interrupted' })
      },

      // 14. 重定向错误
      redirectErrors: {
        tooManyRedirects: () => {
          const redirectChain = nock('https://redirect-errors.test')
          
          // 创建重定向循环
          for (let i = 0; i < 10; i++) {
            redirectChain
              .get(`/redirect-${i}`)
              .reply(302, '', { 'Location': `https://redirect-errors.test/redirect-${(i + 1) % 3}` })
          }
          
          return redirectChain
        },

        invalidRedirectUrl: () => nock('https://redirect-errors.test')
          .get('/invalid-redirect')
          .reply(302, '', { 'Location': 'not-a-valid-url' })
      }
    }
  }

  /**
   * 创建超时错误的辅助方法
   */
  _createTimeoutError(url, delay) {
    // 对每种HTTP方法分别设置拦截器
    const scope = nock(url).persist()
    const methods = ['get', 'post', 'put', 'patch', 'delete']
    
    methods.forEach(method => {
      scope[method](() => true)
        .delay(delay)
        .replyWithError({ code: 'ETIMEDOUT', message: `Timeout after ${delay}ms` })
    })
    
    return scope
  }

  /**
   * 创建重试测试场景
   */
  createRetryScenarios() {
    return {
      // 指数退避重试测试
      exponentialBackoff: (maxRetries = 3) => {
        let attempts = 0
        return nock('https://retry-test.test')
          .persist()
          .post('/exponential')
          .reply(() => {
            attempts++
            if (attempts <= maxRetries) {
              return [500, { error: 'Server Error', attempt: attempts }]
            } else {
              return [200, { success: true, finalAttempt: attempts }]
            }
          })
      },

      // 线性退避重试测试
      linearBackoff: (maxRetries = 4) => {
        let attempts = 0
        return nock('https://retry-test.test')
          .persist()
          .put('/linear')
          .reply(() => {
            attempts++
            if (attempts <= maxRetries && Math.random() < 0.7) {
              return [503, { error: 'Service Unavailable', attempt: attempts }]
            } else {
              return [200, { success: true, finalAttempt: attempts }]
            }
          })
      },

      // 断路器模式测试
      circuitBreakerPattern: (failureThreshold = 5) => {
        let failures = 0
        let circuitOpen = false
        let lastFailureTime = 0
        const resetTimeout = 5000 // 5秒

        return nock('https://circuit-breaker.test')
          .persist()
          .get('/circuit')
          .reply(() => {
            const now = Date.now()

            // 检查断路器是否应该重置
            if (circuitOpen && (now - lastFailureTime) > resetTimeout) {
              circuitOpen = false
              failures = 0
            }

            // 如果断路器开启，立即返回错误
            if (circuitOpen) {
              return [503, { error: 'Circuit Breaker Open', failures }]
            }

            // 模拟随机失败
            if (Math.random() < 0.6) {
              failures++
              lastFailureTime = now
              
              if (failures >= failureThreshold) {
                circuitOpen = true
              }
              
              return [500, { error: 'Server Error', failures, circuitOpen }]
            } else {
              failures = Math.max(0, failures - 1) // 成功时减少失败计数
              return [200, { success: true, failures }]
            }
          })
      }
    }
  }
}

describe('🌐 综合网络错误场景测试 (15+ 种故障模拟)', () => {
  let errorSimulator

  beforeEach(() => {
    errorSimulator = new ComprehensiveErrorSimulator()
    errorSimulator.initialize({ allowLocalhost: true })
  })

  afterEach(() => {
    errorSimulator.cleanup()
  })

  describe('🔌 连接错误测试', () => {
    it('应该处理各种连接超时情况', async () => {
      const scenarios = errorSimulator.createAdvancedErrorScenarios()
      
      // 测试即时超时
      scenarios.connectionTimeouts.immediate()
      await expect(
        axios.get('https://timeout-immediate.test/test', { timeout: 50 })
      ).rejects.toMatchObject({ code: 'ETIMEDOUT' })

      // 测试短超时
      scenarios.connectionTimeouts.short()
      const shortStart = Date.now()
      await expect(
        axios.get('https://timeout-short.test/test', { timeout: 200 })
      ).rejects.toThrow()
      expect(Date.now() - shortStart).toBeLessThan(300)
    })

    it('应该处理连接被拒绝的各种情况', async () => {
      const scenarios = errorSimulator.createAdvancedErrorScenarios()
      
      // 端口关闭
      scenarios.connectionRefused.portClosed()
      await expect(
        axios.get('https://refused-port.test/test')
      ).rejects.toMatchObject({ code: 'ECONNREFUSED' })

      // 服务宕机
      scenarios.connectionRefused.serviceDown()
      await expect(
        axios.post('https://refused-service.test/api', { data: 'test' })
      ).rejects.toMatchObject({ code: 'ECONNREFUSED' })

      // 防火墙阻止
      scenarios.connectionRefused.firewallBlock()
      await expect(
        axios.get('https://refused-firewall.test/blocked')
      ).rejects.toMatchObject({ code: 'EHOSTUNREACH' })
    })

    it('应该处理读取超时情况', async () => {
      const scenarios = errorSimulator.createAdvancedErrorScenarios()
      
      // 部分响应超时
      scenarios.readTimeouts.partialResponse()
      await expect(
        axios.get('https://read-timeout.test/partial', { timeout: 1000 })
      ).rejects.toThrow()

      // 响应挂起
      scenarios.readTimeouts.hangingResponse()
      await expect(
        axios.post('https://read-timeout.test/hanging', { data: 'test' }, { timeout: 1000 })
      ).rejects.toThrow()
    })
  })

  describe('🔍 DNS和域名解析错误', () => {
    it('应该处理各种DNS错误', async () => {
      const scenarios = errorSimulator.createAdvancedErrorScenarios()
      
      // DNS未找到
      scenarios.dnsErrors.notFound()
      await expect(
        axios.get('https://nonexistent-domain.test/test')
      ).rejects.toMatchObject({ code: 'ENOTFOUND' })

      // DNS超时
      scenarios.dnsErrors.timeout()
      await expect(
        axios.get('https://dns-timeout.test/test')
      ).rejects.toMatchObject({ code: 'EAI_AGAIN' })

      // DNS临时失败
      scenarios.dnsErrors.tempFailure()
      await expect(
        axios.get('https://dns-temp-fail.test/test')
      ).rejects.toMatchObject({ 
        code: 'EAI_AGAIN',
        message: expect.stringContaining('Temporary DNS failure')
      })
    })
  })

  describe('🔒 SSL/TLS证书错误', () => {
    it('应该处理各种SSL证书问题', async () => {
      const scenarios = errorSimulator.createAdvancedErrorScenarios()
      
      // 自签名证书
      scenarios.sslErrors.selfSigned()
      await expect(
        axios.get('https://ssl-self-signed.test/test')
      ).rejects.toMatchObject({ code: 'DEPTH_ZERO_SELF_SIGNED_CERT' })

      // 证书过期
      scenarios.sslErrors.expired()
      await expect(
        axios.get('https://ssl-expired.test/test')
      ).rejects.toMatchObject({ code: 'CERT_HAS_EXPIRED' })

      // 不受信任的根证书
      scenarios.sslErrors.untrustedRoot()
      await expect(
        axios.get('https://ssl-untrusted.test/test')
      ).rejects.toMatchObject({ code: 'SELF_SIGNED_CERT_IN_CHAIN' })

      // 主机名不匹配
      scenarios.sslErrors.hostnameMismatch()
      await expect(
        axios.get('https://ssl-hostname.test/test')
      ).rejects.toMatchObject({ code: 'ERR_TLS_CERT_ALTNAME_INVALID' })
    })
  })

  describe('🚫 HTTP状态码错误', () => {
    it('应该处理各种4xx客户端错误', async () => {
      const scenarios = errorSimulator.createAdvancedErrorScenarios()
      
      // 400 Bad Request
      scenarios.clientErrors.badRequest()
      await expect(
        axios.post('https://client-errors.test/bad-request', { invalid: 'data' })
      ).rejects.toMatchObject({
        response: { 
          status: 400,
          data: { error: 'Bad Request', code: 'INVALID_PAYLOAD' }
        }
      })

      // 401 Unauthorized
      scenarios.clientErrors.unauthorized()
      await expect(
        axios.get('https://client-errors.test/unauthorized')
      ).rejects.toMatchObject({
        response: { 
          status: 401,
          data: { error: 'Unauthorized', code: 'INVALID_TOKEN' }
        }
      })

      // 403 Forbidden
      scenarios.clientErrors.forbidden()
      await expect(
        axios.get('https://client-errors.test/forbidden')
      ).rejects.toMatchObject({
        response: { status: 403 }
      })

      // 404 Not Found
      scenarios.clientErrors.notFound()
      await expect(
        axios.get('https://client-errors.test/not-found')
      ).rejects.toMatchObject({
        response: { status: 404 }
      })

      // 413 Payload Too Large
      scenarios.clientErrors.payloadTooLarge()
      await expect(
        axios.post('https://client-errors.test/large-payload', { data: 'x'.repeat(10000) })
      ).rejects.toMatchObject({
        response: { status: 413 }
      })
    })

    it('应该处理各种5xx服务器错误', async () => {
      const scenarios = errorSimulator.createAdvancedErrorScenarios()
      
      // 500 Internal Server Error
      scenarios.serverErrors.internalError()
      await expect(
        axios.get('https://server-errors.test/internal')
      ).rejects.toMatchObject({
        response: { 
          status: 500,
          data: { error: 'Internal Server Error' }
        }
      })

      // 502 Bad Gateway
      scenarios.serverErrors.badGateway()
      await expect(
        axios.get('https://server-errors.test/bad-gateway')
      ).rejects.toMatchObject({
        response: { 
          status: 502,
          data: { error: 'Bad Gateway', upstream: 'api-server-down' }
        }
      })

      // 503 Service Unavailable
      scenarios.serverErrors.serviceUnavailable()
      await expect(
        axios.get('https://server-errors.test/unavailable')
      ).rejects.toMatchObject({
        response: { 
          status: 503,
          data: { error: 'Service Unavailable', retryAfter: 300 }
        }
      })

      // 504 Gateway Timeout
      scenarios.serverErrors.gatewayTimeout()
      await expect(
        axios.get('https://server-errors.test/gateway-timeout')
      ).rejects.toMatchObject({
        response: { 
          status: 504,
          data: { error: 'Gateway Timeout', timeout: 30000 }
        }
      })
    })
  })

  describe('⏱️ 速率限制错误', () => {
    it('应该处理各种速率限制场景', async () => {
      const scenarios = errorSimulator.createAdvancedErrorScenarios()
      
      // 基础速率限制
      scenarios.rateLimiting.basicRateLimit()
      await expect(
        axios.get('https://rate-limit.test/basic')
      ).rejects.toMatchObject({
        response: { 
          status: 429,
          headers: { 'retry-after': '60' }
        }
      })

      // 配额超出
      scenarios.rateLimiting.quotaExceeded()
      await expect(
        axios.post('https://rate-limit.test/quota', { request: 'data' })
      ).rejects.toMatchObject({
        response: { 
          status: 429,
          data: { 
            error: 'Quota Exceeded',
            quotaType: 'daily'
          }
        }
      })

      // 并发限制
      scenarios.rateLimiting.concurrencyLimit()
      await expect(
        axios.get('https://rate-limit.test/concurrency')
      ).rejects.toMatchObject({
        response: { 
          status: 429,
          data: { 
            error: 'Too Many Concurrent Requests',
            maxConcurrent: 10
          }
        }
      })
    })
  })

  describe('🔗 代理错误', () => {
    it('应该处理各种代理错误', async () => {
      const scenarios = errorSimulator.createAdvancedErrorScenarios()
      
      // 代理认证失败
      scenarios.proxyErrors.authRequired()
      await expect(
        axios.get('https://proxy-errors.test/auth-required')
      ).rejects.toMatchObject({
        response: { status: 407 }
      })

      // 代理连接失败
      scenarios.proxyErrors.connectionFailed()
      await expect(
        axios.get('https://proxy-errors.test/connection-failed')
      ).rejects.toMatchObject({
        code: 'ECONNREFUSED',
        message: expect.stringContaining('Proxy connection failed')
      })
    })
  })

  describe('🌐 网络层错误', () => {
    it('应该处理底层网络错误', async () => {
      const scenarios = errorSimulator.createAdvancedErrorScenarios()
      
      // 网络不可达
      scenarios.networkLayerErrors.unreachable()
      await expect(
        axios.get('https://network-unreachable.test/test')
      ).rejects.toMatchObject({ code: 'ENETUNREACH' })

      // 连接重置
      scenarios.networkLayerErrors.connectionReset()
      await expect(
        axios.get('https://connection-reset.test/test')
      ).rejects.toMatchObject({ code: 'ECONNRESET' })

      // 管道破裂
      scenarios.networkLayerErrors.brokenPipe()
      await expect(
        axios.post('https://broken-pipe.test/data', { large: 'payload' })
      ).rejects.toMatchObject({ code: 'EPIPE' })

      // Socket挂起
      scenarios.networkLayerErrors.socketHangUp()
      await expect(
        axios.get('https://socket-hangup.test/test')
      ).rejects.toMatchObject({ 
        code: 'ECONNRESET',
        message: expect.stringContaining('socket hang up')
      })
    })
  })

  describe('⚡ 请求取消和中断', () => {
    it('应该处理用户取消请求', async () => {
      const scenarios = errorSimulator.createAdvancedErrorScenarios()
      const controller = new AbortController()
      
      scenarios.requestCancellation.userCancellation(controller)
      
      await expect(
        axios.get('https://cancellation.test/user-cancel', {
          signal: controller.signal
        })
      ).rejects.toThrow() // AbortError或相关取消错误
    })

    it('应该处理超时取消', async () => {
      const scenarios = errorSimulator.createAdvancedErrorScenarios()
      const controller = new AbortController()
      
      scenarios.requestCancellation.timeoutCancellation(controller)
      
      await expect(
        axios.post('https://cancellation.test/timeout-cancel', 
          { data: 'test' }, 
          { signal: controller.signal }
        )
      ).rejects.toThrow()
    })
  })

  describe('📉 间歇性网络故障', () => {
    it('应该处理不稳定的连接', async () => {
      const scenarios = errorSimulator.createAdvancedErrorScenarios()
      scenarios.intermittentFailures.flakyCconnection()

      const results = []
      // 尝试多次请求来测试间歇性错误
      for (let i = 0; i < 9; i++) {
        try {
          const response = await axios.get('https://intermittent.test/flaky')
          results.push({ success: true, data: response.data })
        } catch (error) {
          results.push({ success: false, error: error.message })
        }
      }

      // 应该有成功和失败的混合结果
      const successes = results.filter(r => r.success).length
      const failures = results.filter(r => !r.success).length
      
      expect(successes).toBeGreaterThan(0)
      expect(failures).toBeGreaterThan(0)
      expect(results.length).toBe(9)
    }, 15000) // 增加超时时间到15秒

    it('应该处理丢包情况', async () => {
      const scenarios = errorSimulator.createAdvancedErrorScenarios()
      scenarios.intermittentFailures.packetLoss()

      const results = []
      for (let i = 0; i < 10; i++) {
        try {
          const response = await axios.post('https://packet-loss.test/lossy', { packet: i })
          results.push({ success: true, attempt: response.data.attempt })
        } catch (error) {
          results.push({ success: false, error: error.code })
        }
      }

      // 由于40%丢包率，应该有一些失败（408超时或其他错误）
      const failures = results.filter(r => !r.success).length
      expect(failures).toBeGreaterThan(1)
      expect(results.length).toBe(10)
    }, 15000) // 增加超时时间到15秒
  })

  describe('📦 负载和数据错误', () => {
    it('应该处理各种负载错误', async () => {
      const scenarios = errorSimulator.createAdvancedErrorScenarios()
      
      // 请求过大
      scenarios.payloadErrors.tooLargeRequest()
      await expect(
        axios.post('https://payload-errors.test/large-request', { 
          data: 'x'.repeat(15 * 1024 * 1024) // 15MB数据
        })
      ).rejects.toMatchObject({
        response: { 
          status: 413,
          data: { maxSize: '10MB' }
        }
      })

      // 数据损坏
      scenarios.payloadErrors.corruptedData()
      await expect(
        axios.put('https://payload-errors.test/corrupted', { corrupted: 'data' })
      ).rejects.toMatchObject({
        response: { 
          status: 422,
          data: { reason: 'Data corruption detected' }
        }
      })

      // 上传中断
      scenarios.payloadErrors.incompleteUpload()
      await expect(
        axios.post('https://payload-errors.test/incomplete', { file: 'data' })
      ).rejects.toMatchObject({
        code: 'ECONNRESET'
      })
    })
  })

  describe('🔄 重定向错误', () => {
    it('应该处理过多重定向', async () => {
      const scenarios = errorSimulator.createAdvancedErrorScenarios()
      scenarios.redirectErrors.tooManyRedirects()

      await expect(
        axios.get('https://redirect-errors.test/redirect-0', {
          maxRedirects: 5 // 限制重定向次数
        })
      ).rejects.toThrow() // 重定向过多错误
    })
  })

  describe('🔁 重试机制测试', () => {
    it('应该测试指数退避重试', async () => {
      const scenarios = errorSimulator.createRetryScenarios()
      scenarios.exponentialBackoff(2) // 最多重试2次

      let attempts = 0
      const retry = async (maxRetries = 3, baseDelay = 100) => {
        for (let i = 0; i <= maxRetries; i++) {
          try {
            attempts++
            const response = await axios.post('https://retry-test.test/exponential', { attempt: i })
            return response.data
          } catch (error) {
            if (i === maxRetries) throw error
            
            // 指数退避延迟
            const delay = baseDelay * Math.pow(2, i)
            await new Promise(resolve => setTimeout(resolve, delay))
          }
        }
      }

      const result = await retry()
      expect(result.success).toBe(true)
      expect(attempts).toBeGreaterThan(2) // 应该重试了几次
    })

    it('应该测试断路器模式', async () => {
      const scenarios = errorSimulator.createRetryScenarios()
      scenarios.circuitBreakerPattern(3) // 失败3次后开启断路器

      const results = []
      
      // 发送多个请求来触发断路器
      for (let i = 0; i < 10; i++) {
        try {
          const response = await axios.get('https://circuit-breaker.test/circuit')
          results.push({ success: true, failures: response.data.failures })
        } catch (error) {
          results.push({ 
            success: false, 
            status: error.response?.status,
            failures: error.response?.data?.failures,
            circuitOpen: error.response?.data?.circuitOpen
          })
        }
        
        // 小延迟避免请求过快
        await new Promise(resolve => setTimeout(resolve, 50))
      }

      // 验证断路器被触发了
      const circuitOpenResults = results.filter(r => r.circuitOpen === true)
      expect(circuitOpenResults.length).toBeGreaterThan(0)
    })
  })
})