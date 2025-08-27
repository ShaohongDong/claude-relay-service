// 网络模拟测试 - 演示NetworkSimulator的完整功能
const { NetworkSimulator, networkTestUtils } = require('../../setup/network-simulator')
const axios = require('axios')

describe('🌐 网络模拟器测试', () => {
  describe('🤖 Claude API 模拟', () => {
    it('应该模拟成功的Claude消息响应', async () => {
      await networkTestUtils.withNetworkSimulation(async (simulator) => {
        // 设置Claude API mock
        const claudeMock = simulator.mockClaudeAPI()
        claudeMock.messages({ tokens: 100, delay: 150 })

        // 发送请求
        const response = await axios.post('https://api.anthropic.com/v1/messages', {
          model: 'claude-3-5-sonnet-20241022',
          max_tokens: 1000,
          messages: [{ role: 'user', content: 'Hello' }]
        }, {
          headers: {
            'Authorization': 'Bearer test-token',
            'Content-Type': 'application/json',
            'anthropic-version': '2023-06-01'
          }
        })

        expect(response.status).toBe(200)
        expect(response.data.type).toBe('message')
        expect(response.data.role).toBe('assistant')
        expect(response.data.usage.output_tokens).toBe(100)
        expect(response.data.content[0].text).toContain('simulated Claude response')
      })
    })

    it('应该模拟Claude流式响应', async () => {
      await networkTestUtils.withNetworkSimulation(async (simulator) => {
        // 设置流式响应mock
        const claudeMock = simulator.mockClaudeAPI()
        claudeMock.messages({ streaming: true, tokens: 50, delay: 100 })

        // 模拟流式请求（这里简化测试，实际应用中会处理SSE）
        const response = await axios.post('https://api.anthropic.com/v1/messages', {
          model: 'claude-3-5-sonnet-20241022',
          stream: true,
          messages: [{ role: 'user', content: 'Stream test' }]
        }, {
          headers: {
            'Authorization': 'Bearer test-token',
            'Content-Type': 'application/json'
          }
        })

        expect(response.status).toBe(200)
        expect(response.headers['content-type']).toBe('text/event-stream')
        expect(response.headers['connection']).toBe('keep-alive')
      })
    })

    it('应该模拟Claude认证错误', async () => {
      await networkTestUtils.withNetworkSimulation(async (simulator) => {
        const claudeMock = simulator.mockClaudeAPI()
        claudeMock.authError()

        await expect(axios.post('https://api.anthropic.com/v1/messages', {
          model: 'claude-3-5-sonnet-20241022',
          messages: [{ role: 'user', content: 'Test' }]
        }, {
          headers: { 'Authorization': 'Bearer invalid-token' }
        })).rejects.toMatchObject({
          response: {
            status: 401,
            data: {
              type: 'error',
              error: {
                type: 'authentication_error'
              }
            }
          }
        })
      })
    })

    it('应该模拟Claude速率限制错误', async () => {
      await networkTestUtils.withNetworkSimulation(async (simulator) => {
        const claudeMock = simulator.mockClaudeAPI()
        claudeMock.rateLimitError()

        await expect(axios.post('https://api.anthropic.com/v1/messages', {
          messages: [{ role: 'user', content: 'Test' }]
        })).rejects.toMatchObject({
          response: {
            status: 429,
            data: {
              error: {
                type: 'rate_limit_error'
              }
            },
            headers: expect.objectContaining({
              'retry-after': '60'
            })
          }
        })
      })
    })
  })

  describe('🔮 Gemini API 模拟', () => {
    it('应该模拟成功的Gemini响应', async () => {
      await networkTestUtils.withNetworkSimulation(async (simulator) => {
        const geminiMock = simulator.mockGeminiAPI()
        geminiMock.generateContent({ tokens: 120, delay: 200 })

        const response = await axios.post('https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent', {
          contents: [{ parts: [{ text: 'Hello Gemini' }] }]
        }, {
          headers: {
            'Authorization': 'Bearer test-token',
            'Content-Type': 'application/json'
          }
        })

        expect(response.status).toBe(200)
        expect(response.data.candidates[0].content.role).toBe('model')
        expect(response.data.usageMetadata.candidatesTokenCount).toBe(120)
      })
    })

    it('应该模拟Gemini流式响应', async () => {
      await networkTestUtils.withNetworkSimulation(async (simulator) => {
        const geminiMock = simulator.mockGeminiAPI()
        geminiMock.generateContent({ streaming: true, tokens: 80 })

        const response = await axios.post('https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:streamGenerateContent', {
          contents: [{ parts: [{ text: 'Stream test' }] }]
        }, {
          headers: { 'Authorization': 'Bearer test-token' }
        })

        expect(response.status).toBe(200)
        expect(response.headers['content-type']).toBe('text/event-stream')
      })
    })

    it('应该模拟Gemini API Key错误', async () => {
      await networkTestUtils.withNetworkSimulation(async (simulator) => {
        const geminiMock = simulator.mockGeminiAPI()
        geminiMock.invalidApiKey()

        await expect(axios.post('https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent', {
          contents: [{ parts: [{ text: 'Test' }] }]
        })).rejects.toMatchObject({
          response: {
            status: 400,
            data: {
              error: {
                code: 400,
                status: 'INVALID_ARGUMENT'
              }
            }
          }
        })
      })
    })
  })

  describe('🔐 OAuth 端点模拟', () => {
    it('应该模拟Claude OAuth Token交换', async () => {
      await networkTestUtils.withNetworkSimulation(async (simulator) => {
        const oauthMock = simulator.mockOAuthEndpoints()
        oauthMock.claude.tokenExchange({ success: true, delay: 250 })

        const response = await axios.post('https://claude.ai/api/oauth/token', {
          grant_type: 'authorization_code',
          code: 'test-auth-code',
          client_id: 'test-client-id'
        })

        expect(response.status).toBe(200)
        expect(response.data.access_token).toMatch(/^access_/)
        expect(response.data.refresh_token).toMatch(/^refresh_/)
        expect(response.data.expires_in).toBe(3600)
        expect(response.data.token_type).toBe('Bearer')
      })
    })

    it('应该模拟Claude Token刷新', async () => {
      await networkTestUtils.withNetworkSimulation(async (simulator) => {
        const oauthMock = simulator.mockOAuthEndpoints()
        oauthMock.claude.tokenRefresh({ success: true })

        const response = await axios.post('https://claude.ai/api/oauth/token', {
          grant_type: 'refresh_token',
          refresh_token: 'test-refresh-token'
        })

        expect(response.status).toBe(200)
        expect(response.data.access_token).toMatch(/^new_access_/)
        expect(response.data.expires_in).toBe(3600)
      })
    })

    it('应该模拟Google OAuth Token刷新', async () => {
      await networkTestUtils.withNetworkSimulation(async (simulator) => {
        const oauthMock = simulator.mockOAuthEndpoints()
        oauthMock.google.tokenRefresh({ success: true, delay: 180 })

        const response = await axios.post('https://oauth2.googleapis.com/token', {
          grant_type: 'refresh_token',
          refresh_token: 'google-refresh-token'
        })

        expect(response.status).toBe(200)
        expect(response.data.access_token).toMatch(/^google_access_/)
      })
    })

    it('应该模拟OAuth刷新失败', async () => {
      await networkTestUtils.withNetworkSimulation(async (simulator) => {
        const oauthMock = simulator.mockOAuthEndpoints()
        oauthMock.claude.tokenRefresh({ success: false })

        await expect(axios.post('https://claude.ai/api/oauth/token', {
          grant_type: 'refresh_token',
          refresh_token: 'invalid-refresh-token'
        })).rejects.toMatchObject({
          response: {
            status: 400,
            data: {
              error: 'invalid_grant'
            }
          }
        })
      })
    })
  })

  describe('⚠️ 网络错误场景模拟', () => {
    it('应该模拟连接超时', async () => {
      await networkTestUtils.withNetworkSimulation(async (simulator) => {
        const errorMock = simulator.mockNetworkErrors()
        errorMock.timeout('https://timeout-test.com', 1000)

        const startTime = Date.now()
        await expect(axios.get('https://timeout-test.com/test', {
          timeout: 500 // 设置较短的超时时间
        })).rejects.toThrow()
        
        const elapsed = Date.now() - startTime
        expect(elapsed).toBeLessThan(600) // 应该在超时时间内失败
      })
    })

    it('应该模拟连接拒绝错误', async () => {
      await networkTestUtils.withNetworkSimulation(async (simulator) => {
        const errorMock = simulator.mockNetworkErrors()
        errorMock.connectionRefused('https://refused-test.com')

        await expect(axios.get('https://refused-test.com/test')).rejects.toMatchObject({
          code: 'ECONNREFUSED'
        })
      })
    })

    it('应该模拟DNS解析失败', async () => {
      await networkTestUtils.withNetworkSimulation(async (simulator) => {
        const errorMock = simulator.mockNetworkErrors()
        errorMock.dnsError('https://nonexistent-domain.com')

        await expect(axios.get('https://nonexistent-domain.com/test')).rejects.toMatchObject({
          code: 'ENOTFOUND'
        })
      })
    })

    it('应该模拟SSL证书错误', async () => {
      await networkTestUtils.withNetworkSimulation(async (simulator) => {
        const errorMock = simulator.mockNetworkErrors()
        errorMock.sslError('https://ssl-error-test.com')

        await expect(axios.get('https://ssl-error-test.com/test')).rejects.toMatchObject({
          code: 'DEPTH_ZERO_SELF_SIGNED_CERT'
        })
      })
    })

    it('应该模拟间歇性网络错误', async () => {
      await networkTestUtils.withNetworkSimulation(async (simulator) => {
        const errorMock = simulator.mockNetworkErrors()
        errorMock.intermittentError('https://intermittent-test.com', 0.3) // 30%成功率

        const results = []
        // 发送多个请求测试间歇性错误
        for (let i = 0; i < 10; i++) {
          try {
            const response = await axios.get('https://intermittent-test.com/test')
            results.push({ success: true, status: response.status })
          } catch (error) {
            results.push({ success: false, status: error.response?.status || 'ERROR' })
          }
        }

        // 应该有成功和失败的混合结果
        const successes = results.filter(r => r.success).length
        const failures = results.filter(r => !r.success).length
        
        expect(successes).toBeGreaterThan(0)
        expect(failures).toBeGreaterThan(0)
      })
    })

    it('应该模拟慢速网络', async () => {
      await networkTestUtils.withNetworkSimulation(async (simulator) => {
        const errorMock = simulator.mockNetworkErrors()
        errorMock.slowNetwork('https://slow-test.com', 2000, 3000) // 2-3秒延迟

        const startTime = Date.now()
        const response = await axios.get('https://slow-test.com/test')
        const elapsed = Date.now() - startTime

        expect(response.status).toBe(200)
        expect(elapsed).toBeGreaterThan(1900) // 至少接近2秒
        expect(elapsed).toBeLessThan(3500) // 不超过3.5秒
      })
    })
  })

  describe('🔄 代理配置测试', () => {
    it('应该模拟SOCKS5代理请求', async () => {
      await networkTestUtils.withNetworkSimulation(async (simulator) => {
        const proxyScenarios = simulator.createProxyScenarios()
        const socksProxy = proxyScenarios.socksProxy('127.0.0.1', 1080)
        socksProxy.mock()

        // 模拟通过SOCKS5代理的请求
        const response = await axios.post('https://api.anthropic.com/v1/messages', {
          model: 'claude-3-5-sonnet-20241022',
          messages: [{ role: 'user', content: 'Proxy test' }]
        })

        expect(response.status).toBe(200)
        expect(response.data.message).toContain('SOCKS5 proxy successful')
        expect(socksProxy.config.type).toBe('socks5')
        expect(socksProxy.config.host).toBe('127.0.0.1')
        expect(socksProxy.config.port).toBe(1080)
      })
    })

    it('应该模拟HTTP代理请求', async () => {
      await networkTestUtils.withNetworkSimulation(async (simulator) => {
        const proxyScenarios = simulator.createProxyScenarios()
        const httpProxy = proxyScenarios.httpProxy('127.0.0.1', 8080)
        httpProxy.mock()

        const response = await axios.post('https://api.anthropic.com/v1/messages', {
          model: 'claude-3-5-sonnet-20241022',
          messages: [{ role: 'user', content: 'HTTP proxy test' }]
        })

        expect(response.status).toBe(200)
        expect(response.data.message).toContain('HTTP proxy successful')
        expect(httpProxy.config.type).toBe('http')
        expect(httpProxy.config.auth).toBe('testuser:testpass')
      })
    })

    it('应该模拟代理认证失败', async () => {
      await networkTestUtils.withNetworkSimulation(async (simulator) => {
        const proxyScenarios = simulator.createProxyScenarios()
        proxyScenarios.proxyAuthFailure()

        await expect(axios.post('https://api.anthropic.com/v1/messages', {
          messages: [{ role: 'user', content: 'Test' }]
        })).rejects.toMatchObject({
          code: 'ECONNREFUSED',
          message: expect.stringContaining('Proxy authentication required')
        })
      })
    })
  })

  describe('📊 网络统计和验证', () => {
    it('应该提供准确的请求统计信息', async () => {
      await networkTestUtils.withNetworkSimulation(async (simulator) => {
        const claudeMock = simulator.mockClaudeAPI()
        claudeMock.messages()
        claudeMock.models()

        // 发送一个请求
        await axios.post('https://api.anthropic.com/v1/messages', {
          messages: [{ role: 'user', content: 'Test' }]
        }, {
          headers: { 'Authorization': 'Bearer test' }
        })

        const stats = simulator.getRequestStats()
        expect(stats.activeMocks).toBeGreaterThan(0)
        expect(stats.pendingMocks).toBeGreaterThan(0) // 还有一个models mock未被调用
      })
    })

    it('应该记录网络请求历史', async () => {
      await networkTestUtils.withNetworkSimulation(async (simulator) => {
        simulator.startRecording()
        
        const claudeMock = simulator.mockClaudeAPI()
        claudeMock.messages()

        await axios.post('https://api.anthropic.com/v1/messages', {
          messages: [{ role: 'user', content: 'Recording test' }]
        }, {
          headers: { 'Authorization': 'Bearer test' }
        })

        const recorded = simulator.stopRecording()
        expect(recorded.length).toBeGreaterThan(0)
        expect(recorded[0]).toHaveProperty('method', 'POST')
        expect(recorded[0]).toHaveProperty('timestamp')
      })
    })

    it('应该验证所有预期请求都被调用', async () => {
      await networkTestUtils.withNetworkSimulation(async (simulator) => {
        const claudeMock = simulator.mockClaudeAPI()
        claudeMock.messages()

        // 调用请求
        await axios.post('https://api.anthropic.com/v1/messages', {
          messages: [{ role: 'user', content: 'Test' }]
        }, {
          headers: { 'Authorization': 'Bearer test' }
        })

        // 验证所有mock都被调用了
        expect(() => simulator.verifyAllRequestsCalled()).not.toThrow()
      })
    })

    it('应该检测未调用的mock', async () => {
      await networkTestUtils.withNetworkSimulation(async (simulator) => {
        const claudeMock = simulator.mockClaudeAPI()
        claudeMock.messages()
        claudeMock.models() // 这个不会被调用

        // 只调用messages
        await axios.post('https://api.anthropic.com/v1/messages', {
          messages: [{ role: 'user', content: 'Test' }]
        }, {
          headers: { 'Authorization': 'Bearer test' }
        })

        // 验证应该失败，因为models mock没被调用
        expect(() => simulator.verifyAllRequestsCalled()).toThrow(/Pending mocks not satisfied/)
      })
    })
  })

  describe('🧪 集成测试场景', () => {
    it('应该支持延迟测试', async () => {
      const latencyScenarios = {
        fast: {
          url: 'https://fast-api.com',
          delay: 100,
          response: { result: 'fast' }
        },
        slow: {
          url: 'https://slow-api.com', 
          delay: 2000,
          response: { result: 'slow' }
        }
      }

      const latencyTest = networkTestUtils.createLatencyTest(latencyScenarios)
      
      await networkTestUtils.withNetworkSimulation(async (simulator) => {
        const results = await latencyTest(simulator)
        
        expect(results.fast.success).toBe(true)
        expect(results.fast.latency).toBeGreaterThan(90)
        expect(results.fast.latency).toBeLessThan(300)
        
        expect(results.slow.success).toBe(true)
        expect(results.slow.latency).toBeGreaterThan(1900)
      })
    })

    it('应该支持重试测试', async () => {
      await networkTestUtils.withNetworkSimulation(async (simulator) => {
        const retryTest = await networkTestUtils.createRetryTest(2, 100)
        const { attempts, mock } = await retryTest(simulator)

        // 模拟重试请求
        for (let i = 0; i < 3; i++) {
          try {
            await axios.post('https://test-api.com/endpoint', { data: 'test' })
            break
          } catch (error) {
            if (i === 2) throw error // 最后一次重试失败就抛出错误
            await new Promise(resolve => setTimeout(resolve, 100)) // 重试延迟
          }
        }

        expect(attempts).toBe(3) // 应该尝试了3次（2次失败 + 1次成功）
      })
    })
  })
})