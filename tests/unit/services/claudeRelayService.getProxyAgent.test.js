// Mock all dependencies
jest.mock('../../../src/utils/logger')
jest.mock('../../../src/services/claudeAccountService')
jest.mock('../../../src/utils/proxyHelper')

const logger = require('../../../src/utils/logger')
const claudeAccountService = require('../../../src/services/claudeAccountService')
const ProxyHelper = require('../../../src/utils/proxyHelper')

// Import the service after mocks (it's a singleton instance)
const claudeRelayService = require('../../../src/services/claudeRelayService')

describe('ClaudeRelayService _getProxyAgent 连接池集成测试', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    // No need to instantiate - claudeRelayService is already an instance
  })

  describe('_getProxyAgent', () => {
    const testAccountId = 'test-account-123'
    const mockAccount = {
      id: testAccountId,
      name: 'Test Account',
      proxy: {
        type: 'http',
        host: 'proxy.example.com',
        port: 8080,
        username: 'proxyuser',
        password: 'proxypass'
      }
    }

    test('应该使用连接池管理器获取代理Agent', async () => {
      // Setup mocks
      claudeAccountService.getAllAccounts.mockResolvedValue([mockAccount])
      const mockAgent = { type: 'mock-pool-agent' }
      ProxyHelper.createAccountAgent.mockReturnValue(mockAgent)
      ProxyHelper.getProxyDescription.mockReturnValue('http://proxy.example.com:8080')

      // Execute
      const result = await claudeRelayService._getProxyAgent(testAccountId)

      // Verify
      expect(claudeAccountService.getAllAccounts).toHaveBeenCalledTimes(1)
      expect(ProxyHelper.createAccountAgent).toHaveBeenCalledWith(testAccountId, mockAccount.proxy)
      expect(ProxyHelper.getProxyDescription).toHaveBeenCalledWith(mockAccount.proxy)
      expect(logger.debug).toHaveBeenCalledWith(
        `🏊 Using connection pool agent for account ${testAccountId}: http://proxy.example.com:8080`
      )
      expect(result).toBe(mockAgent)
    })

    test('应该处理没有代理配置的账户', async () => {
      const accountWithoutProxy = {
        id: testAccountId,
        name: 'No Proxy Account'
        // no proxy field
      }
      claudeAccountService.getAllAccounts.mockResolvedValue([accountWithoutProxy])

      const result = await claudeRelayService._getProxyAgent(testAccountId)

      expect(logger.debug).toHaveBeenCalledWith('🌐 No proxy configured for Claude account')
      expect(ProxyHelper.createAccountAgent).not.toHaveBeenCalled()
      expect(result).toBeNull()
    })

    test('应该处理账户不存在的情况', async () => {
      claudeAccountService.getAllAccounts.mockResolvedValue([])

      const result = await claudeRelayService._getProxyAgent('nonexistent-account')

      expect(logger.debug).toHaveBeenCalledWith('🌐 No proxy configured for Claude account')
      expect(ProxyHelper.createAccountAgent).not.toHaveBeenCalled()
      expect(result).toBeNull()
    })

    test('应该处理空的代理配置', async () => {
      const accountWithEmptyProxy = {
        id: testAccountId,
        name: 'Empty Proxy Account',
        proxy: null
      }
      claudeAccountService.getAllAccounts.mockResolvedValue([accountWithEmptyProxy])

      const result = await claudeRelayService._getProxyAgent(testAccountId)

      expect(logger.debug).toHaveBeenCalledWith('🌐 No proxy configured for Claude account')
      expect(result).toBeNull()
    })

    test('应该处理连接池Agent创建失败', async () => {
      claudeAccountService.getAllAccounts.mockResolvedValue([mockAccount])
      ProxyHelper.createAccountAgent.mockReturnValue(null) // Failed to create agent

      const result = await claudeRelayService._getProxyAgent(testAccountId)

      expect(ProxyHelper.createAccountAgent).toHaveBeenCalledWith(testAccountId, mockAccount.proxy)
      expect(logger.warn).toHaveBeenCalledWith(
        `⚠️ Failed to get connection pool agent for account ${testAccountId}`
      )
      expect(logger.debug).not.toHaveBeenCalledWith(
        expect.stringContaining('🏊 Using connection pool agent')
      )
      expect(result).toBeNull()
    })

    test('应该处理ProxyHelper.createAccountAgent抛出异常', async () => {
      claudeAccountService.getAllAccounts.mockResolvedValue([mockAccount])
      const error = new Error('Connection pool error')
      ProxyHelper.createAccountAgent.mockImplementation(() => {
        throw error
      })

      const result = await claudeRelayService._getProxyAgent(testAccountId)

      expect(logger.warn).toHaveBeenCalledWith(
        '⚠️ Failed to get proxy agent from connection pool:',
        'Connection pool error'
      )
      expect(result).toBeNull()
    })

    test('应该处理claudeAccountService.getAllAccounts失败', async () => {
      const error = new Error('Database error')
      claudeAccountService.getAllAccounts.mockRejectedValue(error)

      const result = await claudeRelayService._getProxyAgent(testAccountId)

      expect(logger.warn).toHaveBeenCalledWith(
        '⚠️ Failed to get proxy agent from connection pool:',
        'Database error'
      )
      expect(ProxyHelper.createAccountAgent).not.toHaveBeenCalled()
      expect(result).toBeNull()
    })

    test('应该正确处理多个账户中的特定账户', async () => {
      const accounts = [
        { id: 'account-1', proxy: { type: 'http', host: 'proxy1.com', port: 8080 } },
        mockAccount, // target account
        { id: 'account-3', proxy: { type: 'socks5', host: 'proxy3.com', port: 1080 } }
      ]
      claudeAccountService.getAllAccounts.mockResolvedValue(accounts)
      const mockAgent = { type: 'target-agent' }
      ProxyHelper.createAccountAgent.mockReturnValue(mockAgent)
      ProxyHelper.getProxyDescription.mockReturnValue('http://proxy.example.com:8080')

      const result = await claudeRelayService._getProxyAgent(testAccountId)

      expect(ProxyHelper.createAccountAgent).toHaveBeenCalledWith(testAccountId, mockAccount.proxy)
      expect(result).toBe(mockAgent)
    })

    test('应该处理复杂的代理配置', async () => {
      const complexProxyAccount = {
        id: testAccountId,
        proxy: {
          type: 'socks5',
          host: 'complex.proxy.com',
          port: 1080,
          username: 'complexuser',
          password: 'complexpass',
          timeout: 30000
        }
      }
      claudeAccountService.getAllAccounts.mockResolvedValue([complexProxyAccount])
      const mockAgent = { type: 'complex-agent' }
      ProxyHelper.createAccountAgent.mockReturnValue(mockAgent)
      ProxyHelper.getProxyDescription.mockReturnValue('socks5://complex.proxy.com:1080')

      const result = await claudeRelayService._getProxyAgent(testAccountId)

      expect(ProxyHelper.createAccountAgent).toHaveBeenCalledWith(testAccountId, complexProxyAccount.proxy)
      expect(logger.debug).toHaveBeenCalledWith(
        `🏊 Using connection pool agent for account ${testAccountId}: socks5://complex.proxy.com:1080`
      )
      expect(result).toBe(mockAgent)
    })

    test('应该处理getProxyDescription异常', async () => {
      claudeAccountService.getAllAccounts.mockResolvedValue([mockAccount])
      const mockAgent = { type: 'mock-agent' }
      ProxyHelper.createAccountAgent.mockReturnValue(mockAgent)
      ProxyHelper.getProxyDescription.mockImplementation(() => {
        throw new Error('Description error')
      })

      const result = await claudeRelayService._getProxyAgent(testAccountId)

      // When getProxyDescription throws, the entire method catches it and returns null
      expect(result).toBeNull()
      expect(logger.warn).toHaveBeenCalledWith(
        '⚠️ Failed to get proxy agent from connection pool:',
        'Description error'
      )
    })

    test('应该正确传递账户ID到连接池', async () => {
      const differentAccountId = 'different-account-456'
      const differentAccount = {
        id: differentAccountId,
        proxy: { type: 'http', host: 'different.proxy.com', port: 3128 }
      }
      claudeAccountService.getAllAccounts.mockResolvedValue([differentAccount])
      ProxyHelper.createAccountAgent.mockReturnValue({ type: 'different-agent' })
      ProxyHelper.getProxyDescription.mockReturnValue('http://different.proxy.com:3128')

      await claudeRelayService._getProxyAgent(differentAccountId)

      expect(ProxyHelper.createAccountAgent).toHaveBeenCalledWith(
        differentAccountId,
        differentAccount.proxy
      )
    })

    test('应该处理JSON字符串格式的代理配置', async () => {
      const jsonProxyAccount = {
        id: testAccountId,
        proxy: '{"type":"http","host":"json.proxy.com","port":8080}'
      }
      claudeAccountService.getAllAccounts.mockResolvedValue([jsonProxyAccount])
      ProxyHelper.createAccountAgent.mockReturnValue({ type: 'json-agent' })
      ProxyHelper.getProxyDescription.mockReturnValue('http://json.proxy.com:8080')

      const result = await claudeRelayService._getProxyAgent(testAccountId)

      expect(ProxyHelper.createAccountAgent).toHaveBeenCalledWith(
        testAccountId,
        jsonProxyAccount.proxy
      )
      expect(result).toEqual({ type: 'json-agent' })
    })
  })

  describe('_getProxyAgent 集成验证', () => {
    test('应该与连接池管理器正确集成', async () => {
      const accountId = 'integration-test-account'
      const account = {
        id: accountId,
        proxy: {
          type: 'socks5',
          host: 'integration.proxy.com',
          port: 1080
        }
      }

      claudeAccountService.getAllAccounts.mockResolvedValue([account])
      ProxyHelper.createAccountAgent.mockReturnValue({ pooled: true })
      ProxyHelper.getProxyDescription.mockReturnValue('socks5://integration.proxy.com:1080')

      const result = await claudeRelayService._getProxyAgent(accountId)

      // Verify complete integration flow
      expect(claudeAccountService.getAllAccounts).toHaveBeenCalled()
      expect(ProxyHelper.createAccountAgent).toHaveBeenCalledWith(accountId, account.proxy)
      expect(ProxyHelper.getProxyDescription).toHaveBeenCalledWith(account.proxy)
      expect(logger.debug).toHaveBeenCalledWith(
        expect.stringContaining('🏊 Using connection pool agent')
      )
      expect(result).toEqual({ pooled: true })
    })

    test('应该正确处理连接池失败后的降级', async () => {
      const accountId = 'failover-test'
      const account = { id: accountId, proxy: { type: 'http', host: 'failover.com', port: 8080 } }

      claudeAccountService.getAllAccounts.mockResolvedValue([account])
      ProxyHelper.createAccountAgent.mockReturnValue(null) // Connection pool fails

      const result = await claudeRelayService._getProxyAgent(accountId)

      expect(logger.warn).toHaveBeenCalledWith(
        `⚠️ Failed to get connection pool agent for account ${accountId}`
      )
      expect(result).toBeNull()
    })
  })
})