// 基础网络模拟测试 - 验证基本功能
const { NetworkSimulator, networkTestUtils } = require('../../setup/network-simulator')
const axios = require('axios')

describe('🔧 基础网络模拟测试', () => {
  it('应该成功拦截和模拟HTTP请求', async () => {
    await networkTestUtils.withNetworkSimulation(async (simulator) => {
      // 设置简单的mock
      const claudeMock = simulator.mockClaudeAPI()
      claudeMock.messages({ tokens: 10 })

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
      expect(response.data).toBeDefined()
      expect(response.data.type).toBe('message')
    })
  })

  it('应该成功模拟网络错误', async () => {
    await networkTestUtils.withNetworkSimulation(async (simulator) => {
      // 设置认证错误mock
      const claudeMock = simulator.mockClaudeAPI()
      claudeMock.authError()

      // 验证错误被正确抛出
      await expect(axios.post('https://api.anthropic.com/v1/messages', {
        messages: [{ role: 'user', content: 'Auth test' }]
      }, {
        headers: { 'Authorization': 'Bearer invalid-token' }
      })).rejects.toMatchObject({
        response: { status: 401 }
      })
    })
  })
})