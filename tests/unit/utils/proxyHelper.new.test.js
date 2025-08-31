// Mock all dependencies first
jest.mock('../../../src/utils/logger')
jest.mock('../../../src/utils/connectionPoolManager', () => ({
  getAgent: jest.fn(),
  getStats: jest.fn(),
  cleanup: jest.fn()
}))
jest.mock('../../../config/config', () => ({
  proxy: {
    keepAlive: true,
    maxSockets: 100,
    maxFreeSockets: 10,
    connectTimeout: 10000,
    useIPv4: true
  },
  logging: {
    level: 'info',
    dirname: '/tmp/logs',
    maxSize: '10m',
    maxFiles: 5
  }
}))

// Mock socks and https proxy agents with proper factory functions
const mockSocksAgent = { on: jest.fn(), destroy: jest.fn(), type: 'socks-mock' }
const mockHttpsAgent = { on: jest.fn(), destroy: jest.fn(), type: 'https-mock' }

jest.mock('socks-proxy-agent', () => ({
  SocksProxyAgent: jest.fn(() => mockSocksAgent)
}))
jest.mock('https-proxy-agent', () => ({
  HttpsProxyAgent: jest.fn(() => mockHttpsAgent)
}))

const logger = require('../../../src/utils/logger')
const connectionPoolManager = require('../../../src/utils/connectionPoolManager')
const { SocksProxyAgent } = require('socks-proxy-agent')
const { HttpsProxyAgent } = require('https-proxy-agent')

// Import ProxyHelper after all mocks are set up
const ProxyHelper = require('../../../src/utils/proxyHelper')

describe('ProxyHelper 连接池集成测试', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    
    // Set up default mock returns
    connectionPoolManager.getAgent.mockReturnValue({ type: 'mock-agent' })
    connectionPoolManager.getStats.mockReturnValue({
      totalPools: 2,
      globalStats: { totalHits: 10, totalCreates: 2, totalErrors: 0 }
    })
  })

  describe('createProxyAgent', () => {
    test('应该处理空代理配置', () => {
      const agent = ProxyHelper.createProxyAgent(null)
      
      expect(agent).toBeNull()
      expect(connectionPoolManager.getAgent).not.toHaveBeenCalled()
    })

    test('应该处理undefined代理配置', () => {
      const agent = ProxyHelper.createProxyAgent(undefined)
      
      expect(agent).toBeNull()
      expect(connectionPoolManager.getAgent).not.toHaveBeenCalled()
    })

    test('应该验证必要字段 - 缺少type', () => {
      const invalidConfig = { host: 'proxy.com', port: 8080 }
      
      const agent = ProxyHelper.createProxyAgent(invalidConfig)
      
      expect(agent).toBeNull()
      expect(logger.warn).toHaveBeenCalledWith('⚠️ Invalid proxy configuration: missing required fields (type, host, port)')
      expect(connectionPoolManager.getAgent).not.toHaveBeenCalled()
    })

    test('应该验证必要字段 - 缺少host', () => {
      const invalidConfig = { type: 'http', port: 8080 }
      
      const agent = ProxyHelper.createProxyAgent(invalidConfig)
      
      expect(agent).toBeNull()
      expect(logger.warn).toHaveBeenCalledWith('⚠️ Invalid proxy configuration: missing required fields (type, host, port)')
    })

    test('应该验证必要字段 - 缺少port', () => {
      const invalidConfig = { type: 'http', host: 'proxy.com' }
      
      const agent = ProxyHelper.createProxyAgent(invalidConfig)
      
      expect(agent).toBeNull()
      expect(logger.warn).toHaveBeenCalledWith('⚠️ Invalid proxy configuration: missing required fields (type, host, port)')
    })

    test('应该使用连接池管理器获取Agent', () => {
      const proxyConfig = {
        type: 'http',
        host: 'proxy.example.com',
        port: 8080,
        username: 'user',
        password: 'pass'
      }
      const options = { accountId: 'test-account', useIPv4: true }

      const agent = ProxyHelper.createProxyAgent(proxyConfig, options)

      expect(connectionPoolManager.getAgent).toHaveBeenCalledWith(
        'test-account',
        proxyConfig,
        { useIPv4: true }
      )
      expect(agent).toEqual({ type: 'mock-agent' })
      expect(logger.debug).toHaveBeenCalledWith(
        '🏊 Retrieved connection pool agent for account test-account: http://proxy.example.com:8080 (with auth)'
      )
    })

    test('应该使用默认账户ID', () => {
      const proxyConfig = { type: 'socks5', host: 'socks.com', port: 1080 }

      ProxyHelper.createProxyAgent(proxyConfig)

      expect(connectionPoolManager.getAgent).toHaveBeenCalledWith(
        'default',
        proxyConfig,
        { useIPv4: true } // Default value
      )
    })

    test('应该处理字符串格式的代理配置', () => {
      const proxyConfig = { type: 'http', host: 'proxy.com', port: 8080 }
      const configString = JSON.stringify(proxyConfig)

      ProxyHelper.createProxyAgent(configString, { accountId: 'string-test' })

      expect(connectionPoolManager.getAgent).toHaveBeenCalledWith(
        'string-test',
        configString, // Pass original JSON string to connection pool
        { useIPv4: true }
      )
    })

    test('应该在连接池失败时降级到直接创建', () => {
      const proxyConfig = { type: 'http', host: 'proxy.com', port: 8080 }
      connectionPoolManager.getAgent.mockImplementation(() => {
        throw new Error('Connection pool error')
      })

      const agent = ProxyHelper.createProxyAgent(proxyConfig, { accountId: 'fallback-test' })

      expect(logger.warn).toHaveBeenCalledWith(
        '⚠️ Failed to get proxy agent from connection pool:',
        'Connection pool error'
      )
      expect(logger.warn).toHaveBeenCalledWith(
        '⚠️ Using direct agent creation as fallback'
      )
      expect(HttpsProxyAgent).toHaveBeenCalled()
      expect(agent).toEqual({ on: expect.any(Function), destroy: expect.any(Function), type: 'https-mock' })
    })

    test('应该处理连接池管理器返回null的情况', () => {
      connectionPoolManager.getAgent.mockReturnValue(null)
      const proxyConfig = { type: 'http', host: 'proxy.com', port: 8080 }

      const agent = ProxyHelper.createProxyAgent(proxyConfig, { accountId: 'null-test' })

      expect(agent).toBeNull()
      expect(logger.debug).not.toHaveBeenCalled() // Should not log success
    })

    test('应该处理JSON解析错误', () => {
      const invalidJson = 'invalid-json-string'

      const agent = ProxyHelper.createProxyAgent(invalidJson)

      expect(logger.warn).toHaveBeenCalledWith(
        '⚠️ Failed to get proxy agent from connection pool:',
        expect.stringContaining('Unexpected token')
      )
      expect(logger.warn).toHaveBeenCalledWith(
        '⚠️ Using direct agent creation as fallback'
      )
      expect(logger.error).toHaveBeenCalledWith(
        '❌ Direct agent creation failed:',
        expect.stringContaining('Unexpected token')
      )
      expect(agent).toBeNull() // Both pool and direct creation fail
    })
  })

  describe('_createDirectAgent', () => {
    test('应该创建SOCKS5直接Agent', () => {
      // Clear mocks to ensure clean state
      jest.clearAllMocks()
      
      const proxyConfig = {
        type: 'socks5',
        host: 'socks.example.com',
        port: 1080,
        username: 'user',
        password: 'pass'
      }

      const agent = ProxyHelper._createDirectAgent(proxyConfig)

      expect(logger.warn).toHaveBeenCalledWith('⚠️ Using direct agent creation as fallback')
      expect(SocksProxyAgent).toHaveBeenCalledWith(
        'socks5://user:pass@socks.example.com:1080',
        expect.objectContaining({
          timeout: 10000,
          keepAlive: true,
          family: 4 // Default IPv4
        })
      )
      expect(agent).toEqual({ on: expect.any(Function), destroy: expect.any(Function), type: 'socks-mock' })
    })

    test('应该创建HTTP直接Agent', () => {
      // Clear mocks to ensure clean state
      jest.clearAllMocks()
      
      const proxyConfig = { type: 'http', host: 'proxy.com', port: 8080 }

      const agent = ProxyHelper._createDirectAgent(proxyConfig)

      expect(logger.warn).toHaveBeenCalledWith('⚠️ Using direct agent creation as fallback')
      expect(HttpsProxyAgent).toHaveBeenCalledWith(
        'http://proxy.com:8080',
        expect.objectContaining({
          timeout: 10000,
          keepAlive: true,
          family: 4
        })
      )
      expect(agent).toEqual({ on: expect.any(Function), destroy: expect.any(Function), type: 'https-mock' })
    })

    test('应该创建HTTPS直接Agent', () => {
      // Clear mocks to ensure clean state
      jest.clearAllMocks()
      
      const proxyConfig = { type: 'https', host: 'proxy.com', port: 8080 }

      const agent = ProxyHelper._createDirectAgent(proxyConfig)

      expect(logger.warn).toHaveBeenCalledWith('⚠️ Using direct agent creation as fallback')
      expect(HttpsProxyAgent).toHaveBeenCalledWith(
        'https://proxy.com:8080',
        expect.objectContaining({
          timeout: 10000,
          keepAlive: true,
          family: 4
        })
      )
      expect(agent).toEqual({ on: expect.any(Function), destroy: expect.any(Function), type: 'https-mock' })
    })

    test('应该处理无认证的代理', () => {
      // Clear mocks to ensure clean state
      jest.clearAllMocks()
      
      const proxyConfig = { type: 'socks5', host: 'socks.com', port: 1080 }

      const agent = ProxyHelper._createDirectAgent(proxyConfig)

      expect(logger.warn).toHaveBeenCalledWith('⚠️ Using direct agent creation as fallback')
      expect(SocksProxyAgent).toHaveBeenCalledWith(
        'socks5://socks.com:1080',
        expect.objectContaining({
          timeout: 10000,
          keepAlive: true,
          family: 4
        })
      )
      expect(agent).toEqual({ on: expect.any(Function), destroy: expect.any(Function), type: 'socks-mock' })
    })

    test('应该处理IPv6偏好设置', () => {
      // Clear mocks to ensure clean state
      jest.clearAllMocks()
      
      const proxyConfig = { type: 'http', host: 'proxy.com', port: 8080 }
      const options = { useIPv4: false }

      const agent = ProxyHelper._createDirectAgent(proxyConfig, options)

      expect(logger.warn).toHaveBeenCalledWith('⚠️ Using direct agent creation as fallback')
      expect(HttpsProxyAgent).toHaveBeenCalledWith(
        'http://proxy.com:8080',
        expect.objectContaining({
          timeout: 10000,
          keepAlive: true,
          family: 6 // IPv6
        })
      )
      expect(agent).toEqual({ on: expect.any(Function), destroy: expect.any(Function), type: 'https-mock' })
    })

    test('应该处理不支持的代理类型', () => {
      // Clear mocks to ensure clean state
      jest.clearAllMocks()
      
      const proxyConfig = { type: 'invalid', host: 'proxy.com', port: 8080 }

      const agent = ProxyHelper._createDirectAgent(proxyConfig)

      expect(logger.warn).toHaveBeenCalledWith('⚠️ Using direct agent creation as fallback')
      expect(logger.error).toHaveBeenCalledWith(
        '❌ Direct agent creation failed:',
        'Unsupported proxy type: invalid'
      )
      expect(agent).toBeNull()
    })

    test('应该处理Agent创建失败', () => {
      // Clear mocks to ensure clean state
      jest.clearAllMocks()
      
      const proxyConfig = { type: 'http', host: 'proxy.com', port: 8080 }
      
      // Mock HttpsProxyAgent to throw
      HttpsProxyAgent.mockImplementationOnce(() => {
        throw new Error('Agent creation failed')
      })

      const agent = ProxyHelper._createDirectAgent(proxyConfig)

      expect(logger.warn).toHaveBeenCalledWith('⚠️ Using direct agent creation as fallback')
      expect(logger.error).toHaveBeenCalledWith(
        '❌ Direct agent creation failed:',
        'Agent creation failed'
      )
      expect(agent).toBeNull()
    })
  })

  describe('_getIPFamilyPreference', () => {
    test('应该处理布尔值true', () => {
      // Clear mocks to ensure clean state
      jest.clearAllMocks()
      
      const proxyConfig = { type: 'http', host: 'proxy.com', port: 8080 }
      
      const agent = ProxyHelper._createDirectAgent(proxyConfig, { useIPv4: true })
      
      expect(logger.warn).toHaveBeenCalledWith('⚠️ Using direct agent creation as fallback')
      expect(HttpsProxyAgent).toHaveBeenCalledWith(
        'http://proxy.com:8080',
        expect.objectContaining({ family: 4, timeout: 10000, keepAlive: true })
      )
      expect(agent).toEqual({ on: expect.any(Function), destroy: expect.any(Function), type: 'https-mock' })
    })

    test('应该处理布尔值false', () => {
      // Clear mocks to ensure clean state
      jest.clearAllMocks()
      
      const proxyConfig = { type: 'http', host: 'proxy.com', port: 8080 }
      
      const agent = ProxyHelper._createDirectAgent(proxyConfig, { useIPv4: false })
      
      expect(logger.warn).toHaveBeenCalledWith('⚠️ Using direct agent creation as fallback')
      expect(HttpsProxyAgent).toHaveBeenCalledWith(
        'http://proxy.com:8080',
        expect.objectContaining({ family: 6, timeout: 10000, keepAlive: true })
      )
      expect(agent).toEqual({ on: expect.any(Function), destroy: expect.any(Function), type: 'https-mock' })
    })

    test('应该处理数字4', () => {
      // Clear mocks to ensure clean state
      jest.clearAllMocks()
      
      const proxyConfig = { type: 'http', host: 'proxy.com', port: 8080 }
      
      const agent = ProxyHelper._createDirectAgent(proxyConfig, { useIPv4: 4 })
      
      expect(logger.warn).toHaveBeenCalledWith('⚠️ Using direct agent creation as fallback')
      expect(HttpsProxyAgent).toHaveBeenCalledWith(
        'http://proxy.com:8080',
        expect.objectContaining({ family: 4, timeout: 10000, keepAlive: true })
      )
      expect(agent).toEqual({ on: expect.any(Function), destroy: expect.any(Function), type: 'https-mock' })
    })

    test('应该处理数字6', () => {
      // Clear mocks to ensure clean state
      jest.clearAllMocks()
      
      const proxyConfig = { type: 'http', host: 'proxy.com', port: 8080 }
      
      const agent = ProxyHelper._createDirectAgent(proxyConfig, { useIPv4: 6 })
      
      expect(logger.warn).toHaveBeenCalledWith('⚠️ Using direct agent creation as fallback')
      expect(HttpsProxyAgent).toHaveBeenCalledWith(
        'http://proxy.com:8080',
        expect.objectContaining({ family: 6, timeout: 10000, keepAlive: true })
      )
      expect(agent).toEqual({ on: expect.any(Function), destroy: expect.any(Function), type: 'https-mock' })
    })

    test('应该处理字符串ipv4', () => {
      // Clear mocks to ensure clean state
      jest.clearAllMocks()
      
      const proxyConfig = { type: 'http', host: 'proxy.com', port: 8080 }
      
      const agent = ProxyHelper._createDirectAgent(proxyConfig, { useIPv4: 'ipv4' })
      
      expect(logger.warn).toHaveBeenCalledWith('⚠️ Using direct agent creation as fallback')
      expect(HttpsProxyAgent).toHaveBeenCalledWith(
        'http://proxy.com:8080',
        expect.objectContaining({ family: 4, timeout: 10000, keepAlive: true })
      )
      expect(agent).toEqual({ on: expect.any(Function), destroy: expect.any(Function), type: 'https-mock' })
    })

    test('应该处理字符串ipv6', () => {
      // Clear mocks to ensure clean state
      jest.clearAllMocks()
      
      const proxyConfig = { type: 'http', host: 'proxy.com', port: 8080 }
      
      const agent = ProxyHelper._createDirectAgent(proxyConfig, { useIPv4: 'ipv6' })
      
      expect(logger.warn).toHaveBeenCalledWith('⚠️ Using direct agent creation as fallback')
      expect(HttpsProxyAgent).toHaveBeenCalledWith(
        'http://proxy.com:8080',
        expect.objectContaining({ family: 6, timeout: 10000, keepAlive: true })
      )
      expect(agent).toEqual({ on: expect.any(Function), destroy: expect.any(Function), type: 'https-mock' })
    })

    test('应该处理auto偏好', () => {
      // Clear mocks to ensure clean state
      jest.clearAllMocks()
      
      const proxyConfig = { type: 'http', host: 'proxy.com', port: 8080 }
      
      const agent = ProxyHelper._createDirectAgent(proxyConfig, { useIPv4: 'auto' })
      
      expect(logger.warn).toHaveBeenCalledWith('⚠️ Using direct agent creation as fallback')
      // Should not set family when auto (null family preference)
      expect(HttpsProxyAgent).toHaveBeenCalledWith(
        'http://proxy.com:8080',
        expect.objectContaining({ timeout: 10000, keepAlive: true })
      )
      // But should not contain family property
      const callArgs = HttpsProxyAgent.mock.calls[0][1]
      expect(callArgs).not.toHaveProperty('family')
      expect(agent).toEqual({ on: expect.any(Function), destroy: expect.any(Function), type: 'https-mock' })
    })

    test('应该使用默认配置', () => {
      const proxyConfig = { type: 'http', host: 'proxy.com', port: 8080 }
      
      ProxyHelper.createProxyAgent(proxyConfig, { accountId: 'test' })
      
      expect(connectionPoolManager.getAgent).toHaveBeenCalledWith(
        'test',
        proxyConfig,
        { useIPv4: true } // Default from config
      )
    })
  })

  describe('createAccountAgent', () => {
    test('应该为账户创建专用Agent', () => {
      const accountId = 'account-123'
      const proxyConfig = { type: 'socks5', host: 'socks.com', port: 1080 }
      const options = { useIPv4: false }

      const agent = ProxyHelper.createAccountAgent(accountId, proxyConfig, options)

      expect(connectionPoolManager.getAgent).toHaveBeenCalledWith(
        accountId,
        proxyConfig,
        { useIPv4: false } // accountId is not passed as part of options to connectionPoolManager
      )
      expect(agent).toEqual({ type: 'mock-agent' })
    })

    test('应该处理缺失的账户ID', () => {
      const proxyConfig = { type: 'http', host: 'proxy.com', port: 8080 }

      const agent = ProxyHelper.createAccountAgent(null, proxyConfig)

      expect(agent).toBeNull()
      expect(logger.warn).toHaveBeenCalledWith('⚠️ Account ID is required for connection pooling')
      expect(connectionPoolManager.getAgent).not.toHaveBeenCalled()
    })

    test('应该处理空字符串账户ID', () => {
      const proxyConfig = { type: 'http', host: 'proxy.com', port: 8080 }

      const agent = ProxyHelper.createAccountAgent('', proxyConfig)

      expect(agent).toBeNull()
      expect(logger.warn).toHaveBeenCalledWith('⚠️ Account ID is required for connection pooling')
    })

    test('应该传递额外选项', () => {
      const accountId = 'options-account'
      const proxyConfig = { type: 'http', host: 'proxy.com', port: 8080 }
      const options = { useIPv4: true, customOption: 'value' }

      ProxyHelper.createAccountAgent(accountId, proxyConfig, options)

      expect(connectionPoolManager.getAgent).toHaveBeenCalledWith(
        accountId,
        proxyConfig,
        { useIPv4: true } // Only useIPv4 is passed to connectionPoolManager
      )
    })
  })

  describe('getConnectionPoolStats', () => {
    test('应该返回连接池统计信息', () => {
      const expectedStats = {
        totalPools: 3,
        globalStats: { totalHits: 15, totalCreates: 3, totalErrors: 1 },
        poolDetails: [{ poolKey: 'account1:hash1', hits: 10 }]
      }
      connectionPoolManager.getStats.mockReturnValue(expectedStats)

      const stats = ProxyHelper.getConnectionPoolStats()

      expect(stats).toEqual(expectedStats)
      expect(connectionPoolManager.getStats).toHaveBeenCalled()
    })

    test('应该处理获取统计信息异常', () => {
      connectionPoolManager.getStats.mockImplementation(() => {
        throw new Error('Stats error')
      })

      expect(() => {
        ProxyHelper.getConnectionPoolStats()
      }).toThrow('Stats error')
    })
  })

  describe('cleanupConnectionPools', () => {
    test('应该触发连接池清理', () => {
      ProxyHelper.cleanupConnectionPools()

      expect(connectionPoolManager.cleanup).toHaveBeenCalled()
    })

    test('应该处理清理异常', () => {
      connectionPoolManager.cleanup.mockImplementation(() => {
        throw new Error('Cleanup error')
      })

      expect(() => {
        ProxyHelper.cleanupConnectionPools()
      }).toThrow('Cleanup error')
    })
  })

  describe('getProxyDescription', () => {
    test('应该返回HTTP代理描述', () => {
      const config = { type: 'http', host: 'proxy.com', port: 8080 }
      
      const description = ProxyHelper.getProxyDescription(config)
      
      expect(description).toBe('http://proxy.com:8080')
    })

    test('应该返回SOCKS5代理描述', () => {
      const config = { type: 'socks5', host: 'socks.com', port: 1080 }
      
      const description = ProxyHelper.getProxyDescription(config)
      
      expect(description).toBe('socks5://socks.com:1080')
    })

    test('应该处理空配置', () => {
      const description = ProxyHelper.getProxyDescription(null)
      
      expect(description).toBe('No proxy')
    })

    test('应该处理无效JSON', () => {
      const description = ProxyHelper.getProxyDescription('invalid-json')
      
      expect(description).toBe('Invalid proxy config')
    })
  })

  describe('validateProxyConfig', () => {
    test('应该验证有效配置', () => {
      const config = { type: 'http', host: 'proxy.com', port: 8080 }
      
      const isValid = ProxyHelper.validateProxyConfig(config)
      
      expect(isValid).toBe(true)
    })

    test('应该拒绝无效类型', () => {
      const config = { type: 'invalid', host: 'proxy.com', port: 8080 }
      
      const isValid = ProxyHelper.validateProxyConfig(config)
      
      expect(isValid).toBe(false)
    })

    test('应该拒绝缺少字段的配置', () => {
      const config = { type: 'http', host: 'proxy.com' }
      
      const isValid = ProxyHelper.validateProxyConfig(config)
      
      expect(isValid).toBe(false)
    })

    test('应该拒绝无效端口', () => {
      const config = { type: 'http', host: 'proxy.com', port: 'invalid' }
      
      const isValid = ProxyHelper.validateProxyConfig(config)
      
      expect(isValid).toBe(false)
    })

    test('应该拒绝端口范围外的值', () => {
      const config1 = { type: 'http', host: 'proxy.com', port: 0 }
      const config2 = { type: 'http', host: 'proxy.com', port: 65536 }
      
      expect(ProxyHelper.validateProxyConfig(config1)).toBe(false)
      expect(ProxyHelper.validateProxyConfig(config2)).toBe(false)
    })

    test('应该处理字符串配置', () => {
      const config = { type: 'socks5', host: 'socks.com', port: 1080 }
      const configString = JSON.stringify(config)
      
      const isValid = ProxyHelper.validateProxyConfig(configString)
      
      expect(isValid).toBe(true)
    })
  })

  describe('maskProxyInfo', () => {
    test('应该脱敏代理信息', () => {
      const config = {
        type: 'http',
        host: 'proxy.com',
        port: 8080,
        username: 'testuser',
        password: 'secretpass'
      }
      
      const masked = ProxyHelper.maskProxyInfo(config)
      
      expect(masked).toContain('http://proxy.com:8080')
      expect(masked).toContain('t******r') // Masked username
      expect(masked).toContain('********') // Masked password
      expect(masked).not.toContain('secretpass')
    })

    test('应该处理无认证的代理', () => {
      const config = { type: 'socks5', host: 'socks.com', port: 1080 }
      
      const masked = ProxyHelper.maskProxyInfo(config)
      
      expect(masked).toBe('socks5://socks.com:1080')
    })

    test('应该处理短用户名', () => {
      const config = {
        type: 'http',
        host: 'proxy.com',
        port: 8080,
        username: 'ab',
        password: 'pass'
      }
      
      const masked = ProxyHelper.maskProxyInfo(config)
      
      expect(masked).toContain('ab') // Short username not masked
    })
  })

  describe('Legacy createProxy method', () => {
    test('应该显示弃用警告', () => {
      const proxyConfig = { type: 'http', host: 'proxy.com', port: 8080 }

      const agent = ProxyHelper.createProxy(proxyConfig, true)

      expect(logger.warn).toHaveBeenCalledWith(
        '⚠️ ProxyHelper.createProxy is deprecated, use createAccountAgent for connection pooling'
      )
      expect(agent).toEqual({ type: 'mock-agent' })
    })

    test('应该正确转换参数', () => {
      const proxyConfig = { type: 'socks5', host: 'socks.com', port: 1080 }

      ProxyHelper.createProxy(proxyConfig, false)

      expect(connectionPoolManager.getAgent).toHaveBeenCalledWith(
        'default',
        proxyConfig,
        { useIPv4: false }
      )
    })
  })
})