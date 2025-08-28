// 基础网络模拟测试 - 验证基本功能
const nock = require('nock')
const axios = require('axios')

describe('🔧 基础网络模拟测试', () => {
  beforeEach(() => {
    nock.cleanAll()
    nock.disableNetConnect()
  })
  
  afterEach(() => {
    nock.cleanAll()
    nock.enableNetConnect()
  })

  it('应该成功拦截和模拟HTTP请求', async () => {
    // 创建成功响应mock
    const scope = nock('https://api.anthropic.com')
      .post('/v1/messages')
      .reply(200, {
        id: 'msg_test123',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'Test response' }],
        model: 'claude-3-5-sonnet-20241022',
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 10 }
      })

    // 发送请求
    const response = await axios.post('https://api.anthropic.com/v1/messages', {
      model: 'claude-3-5-sonnet-20241022',
      messages: [{ role: 'user', content: 'Basic test' }]
    }, {
      headers: {
        'Authorization': 'Bearer test-token',
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01'
      }
    })

    // 验证响应
    expect(response.status).toBe(200)
    expect(response.data.type).toBe('message')
    expect(scope.isDone()).toBe(true)
  })

  it('应该成功模拟网络错误', async () => {
    // 创建认证错误mock
    const scope = nock('https://api.anthropic.com')
      .post('/v1/messages')
      .reply(401, {
        type: 'error',
        error: {
          type: 'authentication_error',
          message: 'Invalid API Key'
        }
      })

    // 验证错误被正确抛出
    await expect(axios.post('https://api.anthropic.com/v1/messages', {
      messages: [{ role: 'user', content: 'Auth test' }]
    }, {
      headers: { 'Authorization': 'Bearer invalid-token' }
    })).rejects.toMatchObject({
      response: { status: 401 }
    })
    
    expect(scope.isDone()).toBe(true)
  })
})