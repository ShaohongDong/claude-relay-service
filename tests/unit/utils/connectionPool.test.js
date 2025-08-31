const EventEmitter = require('events')

// Mock dependencies
jest.mock('../../../src/utils/logger')
jest.mock('../../../config/config')
jest.mock('socks-proxy-agent')
jest.mock('https-proxy-agent')

const logger = require('../../../src/utils/logger')

// Mock config
const mockConfig = {
  proxy: {
    keepAlive: true,
    maxSockets: 100,
    maxFreeSockets: 10,
    connectTimeout: 10000
  }
}

// Mock ProxyAgents with EventEmitter capabilities
class MockSocksAgent extends EventEmitter {
  constructor() {
    super()
    this.destroyed = false
  }
  
  destroy() {
    this.destroyed = true
    this.emit('destroy')
  }
  
  createConnection(...args) {
    const socket = new EventEmitter()
    socket.destroyed = false
    socket.destroy = () => {
      socket.destroyed = true
      socket.emit('close')
    }
    return socket
  }
}

class MockHttpsAgent extends EventEmitter {
  constructor() {
    super()
    this.destroyed = false
  }
  
  destroy() {
    this.destroyed = true
    this.emit('destroy')
  }
  
  createConnection(...args) {
    const socket = new EventEmitter()
    socket.destroyed = false
    socket.destroy = () => {
      socket.destroyed = true
      socket.emit('close')
    }
    return socket
  }
}

const { SocksProxyAgent } = require('socks-proxy-agent')
const { HttpsProxyAgent } = require('https-proxy-agent')

SocksProxyAgent.mockImplementation(() => new MockSocksAgent())
HttpsProxyAgent.mockImplementation(() => new MockHttpsAgent())

// Set up config mock
require.cache[require.resolve('../../../config/config')] = {
  exports: mockConfig
}

describe('ConnectionPool Class', () => {
  let connectionPoolManager, ConnectionPool

  beforeAll(() => {
    // Import after mocks are set up
    connectionPoolManager = require('../../../src/utils/connectionPoolManager')
    
    // Extract ConnectionPool class for direct testing
    // We need to get it from the connectionPoolManager module
    const ConnectionPoolManagerModule = require.cache[require.resolve('../../../src/utils/connectionPoolManager')].exports
    
    // Access the private ConnectionPool class via the manager
    ConnectionPool = eval(`
      const manager = require('../../../src/utils/connectionPoolManager');
      const poolInstance = manager.getPool('test', { type: 'http', host: 'test.com', port: 8080 });
      poolInstance.constructor;
    `)
  })

  beforeEach(() => {
    jest.clearAllMocks()
  })

  afterEach(() => {
    // Clean up any pools created during tests
    if (connectionPoolManager) {
      connectionPoolManager.pools.clear()
      connectionPoolManager.poolStats.clear()
    }
  })

  describe('ConnectionPool Constructor', () => {
    test('应该正确初始化HTTP代理连接池', () => {
      const accountId = 'test-account'
      const proxyConfig = {
        type: 'http',
        host: 'proxy.example.com',
        port: 8080,
        username: 'user',
        password: 'pass'
      }

      const pool = connectionPoolManager.getPool(accountId, proxyConfig)

      expect(pool.accountId).toBe(accountId)
      expect(pool.proxyConfig).toEqual(proxyConfig)
      expect(pool.primaryAgent).toBeDefined()
      expect(pool.secondaryAgent).toBeDefined()
      expect(pool.currentAgent).toBe('primary')
      expect(pool.connectionState.primary.healthy).toBe(true)
      expect(pool.connectionState.secondary.healthy).toBe(true)
    })

    test('应该正确初始化SOCKS5代理连接池', () => {
      const accountId = 'test-socks-account'
      const proxyConfig = {
        type: 'socks5',
        host: 'socks.example.com',
        port: 1080
      }

      const pool = connectionPoolManager.getPool(accountId, proxyConfig)

      expect(pool.accountId).toBe(accountId)
      expect(pool.proxyConfig).toEqual(proxyConfig)
      expect(pool.primaryAgent).toBeDefined()
      expect(pool.secondaryAgent).toBeDefined()
    })

    test('应该处理字符串格式的代理配置', () => {
      const accountId = 'string-config-account'
      const proxyConfig = {
        type: 'http',
        host: 'proxy.example.com',
        port: 8080
      }
      const configString = JSON.stringify(proxyConfig)

      const pool = connectionPoolManager.getPool(accountId, configString)

      expect(pool.proxyConfig).toEqual(proxyConfig)
    })

    test('应该正确设置统计信息', () => {
      const accountId = 'stats-test-account'
      const proxyConfig = { type: 'http', host: 'proxy.com', port: 8080 }

      const pool = connectionPoolManager.getPool(accountId, proxyConfig)

      expect(pool.stats.created).toBeDefined()
      expect(pool.stats.lastUsed).toBeDefined()
      expect(pool.stats.requestCount).toBe(0)
      expect(pool.stats.errorCount).toBe(0)
      expect(pool.stats.failoverCount).toBe(0)
    })
  })

  describe('getAgent', () => {
    let pool
    const accountId = 'agent-test-account'
    const proxyConfig = { type: 'http', host: 'proxy.com', port: 8080 }

    beforeEach(() => {
      pool = connectionPoolManager.getPool(accountId, proxyConfig)
    })

    test('应该返回主连接Agent', () => {
      const agent = pool.getAgent()

      expect(agent).toBe(pool.primaryAgent)
      expect(pool.stats.requestCount).toBe(1)
      expect(pool.stats.lastUsed).toBeGreaterThan(pool.stats.created)
    })

    test('应该在主连接不健康时切换到备用连接', () => {
      // Mark primary as unhealthy
      pool.connectionState.primary.healthy = false

      const agent = pool.getAgent()

      expect(agent).toBe(pool.secondaryAgent)
      expect(pool.currentAgent).toBe('secondary')
      expect(pool.stats.failoverCount).toBe(1)
    })

    test('应该在备用连接不健康时切换回主连接', () => {
      // Start with secondary
      pool.currentAgent = 'secondary'
      pool.connectionState.secondary.healthy = false

      const agent = pool.getAgent()

      expect(agent).toBe(pool.primaryAgent)
      expect(pool.currentAgent).toBe('primary')
      expect(pool.stats.failoverCount).toBe(1)
    })

    test('应该在两个连接都不健康时返回当前Agent', () => {
      pool.connectionState.primary.healthy = false
      pool.connectionState.secondary.healthy = false

      const agent = pool.getAgent()

      expect(agent).toBe(pool.primaryAgent) // Should return current (primary)
    })

    test('应该处理Agent为null的情况', () => {
      pool.primaryAgent = null

      expect(() => {
        pool.getAgent()
      }).not.toThrow()
    })
  })

  describe('getStatus', () => {
    test('应该返回完整的连接池状态', () => {
      const accountId = 'status-test-account'
      const proxyConfig = { type: 'socks5', host: 'socks.com', port: 1080 }
      const pool = connectionPoolManager.getPool(accountId, proxyConfig)

      // Make some requests to change stats
      pool.getAgent()
      pool.getAgent()

      const status = pool.getStatus()

      expect(status.accountId).toBe(accountId)
      expect(status.currentAgent).toBe('primary')
      expect(status.connectionState).toBeDefined()
      expect(status.connectionState.primary).toBeDefined()
      expect(status.connectionState.secondary).toBeDefined()
      expect(status.stats).toBeDefined()
      expect(status.stats.requestCount).toBe(2)
      expect(status.idleTime).toBeDefined()
    })
  })

  describe('getIdleTime', () => {
    test('应该返回正确的空闲时间', async () => {
      const accountId = 'idle-test-account'
      const proxyConfig = { type: 'http', host: 'proxy.com', port: 8080 }
      const pool = connectionPoolManager.getPool(accountId, proxyConfig)

      const initialTime = pool.getIdleTime()
      expect(initialTime).toBeGreaterThanOrEqual(0)

      // Wait a bit and check again
      await new Promise(resolve => setTimeout(resolve, 10))
      
      const laterTime = pool.getIdleTime()
      expect(laterTime).toBeGreaterThan(initialTime)
    })

    test('应该在使用后重置空闲时间', async () => {
      const accountId = 'idle-reset-account'
      const proxyConfig = { type: 'http', host: 'proxy.com', port: 8080 }
      const pool = connectionPoolManager.getPool(accountId, proxyConfig)

      await new Promise(resolve => setTimeout(resolve, 10))
      const beforeUse = pool.getIdleTime()

      pool.getAgent() // Use the pool

      const afterUse = pool.getIdleTime()
      expect(afterUse).toBeLessThan(beforeUse)
    })
  })

  describe('destroy', () => {
    test('应该正确销毁连接池', () => {
      const accountId = 'destroy-test-account'
      const proxyConfig = { type: 'http', host: 'proxy.com', port: 8080 }
      const pool = connectionPoolManager.getPool(accountId, proxyConfig)

      const primaryAgent = pool.primaryAgent
      const secondaryAgent = pool.secondaryAgent

      pool.destroy()

      expect(pool.primaryAgent).toBeNull()
      expect(pool.secondaryAgent).toBeNull()
      expect(primaryAgent.destroyed).toBe(true)
      expect(secondaryAgent.destroyed).toBe(true)
    })

    test('应该处理Agent为null的销毁情况', () => {
      const accountId = 'null-destroy-account'
      const proxyConfig = { type: 'http', host: 'proxy.com', port: 8080 }
      const pool = connectionPoolManager.getPool(accountId, proxyConfig)

      pool.primaryAgent = null
      pool.secondaryAgent = null

      expect(() => {
        pool.destroy()
      }).not.toThrow()
    })
  })

  describe('故障转移逻辑', () => {
    let pool
    const accountId = 'failover-account'
    const proxyConfig = { type: 'http', host: 'proxy.com', port: 8080 }

    beforeEach(() => {
      pool = connectionPoolManager.getPool(accountId, proxyConfig)
    })

    test('应该触发故障转移事件', (done) => {
      pool.on('failover', (from, to) => {
        expect(from).toBe('primary')
        expect(to).toBe('secondary')
        done()
      })

      // Mark primary as unhealthy to trigger failover
      pool.connectionState.primary.healthy = false
      pool.getAgent()
    })

    test('应该更新故障转移统计', () => {
      const initialFailoverCount = pool.stats.failoverCount

      // Mark primary as unhealthy to trigger failover
      pool.connectionState.primary.healthy = false
      pool.getAgent()

      expect(pool.stats.failoverCount).toBe(initialFailoverCount + 1)
    })

    test('应该在多次故障转移时正确切换', () => {
      // Start with primary
      expect(pool.currentAgent).toBe('primary')

      // Failover to secondary
      pool.connectionState.primary.healthy = false
      pool.getAgent()
      expect(pool.currentAgent).toBe('secondary')

      // Failover back to primary
      pool.connectionState.primary.healthy = true
      pool.connectionState.secondary.healthy = false
      pool.getAgent()
      expect(pool.currentAgent).toBe('primary')
    })
  })

  describe('Agent事件监听', () => {
    let pool
    const accountId = 'event-test-account'
    const proxyConfig = { type: 'socks5', host: 'socks.com', port: 1080 }

    beforeEach(() => {
      pool = connectionPoolManager.getPool(accountId, proxyConfig)
    })

    test('应该监听Agent错误事件', (done) => {
      pool.on('connection_failed', (error) => {
        expect(error.message).toBe('Test agent error')
        expect(pool.connectionState.primary.healthy).toBe(false)
        expect(pool.connectionState.primary.errorCount).toBe(1)
        expect(pool.stats.errorCount).toBe(1)
        done()
      })

      // Simulate agent error
      pool.primaryAgent.emit('error', new Error('Test agent error'))
    })

    test('应该正确更新连接状态', () => {
      const initialErrorCount = pool.connectionState.primary.errorCount

      // Simulate agent error
      pool.primaryAgent.emit('error', new Error('Connection error'))

      expect(pool.connectionState.primary.healthy).toBe(false)
      expect(pool.connectionState.primary.lastError).toBe('Connection error')
      expect(pool.connectionState.primary.errorCount).toBe(initialErrorCount + 1)
      expect(pool.stats.errorCount).toBeGreaterThan(0)
    })

    test('应该处理连接成功事件', () => {
      // First mark as unhealthy
      pool.connectionState.primary.healthy = false
      pool.connectionState.primary.errorCount = 5

      // Create a mock connection and simulate connect event
      const mockSocket = pool.primaryAgent.createConnection()
      mockSocket.emit('connect')

      expect(pool.connectionState.primary.healthy).toBe(true)
      expect(pool.connectionState.primary.errorCount).toBe(0)
    })

    test('应该处理连接socket错误', () => {
      const mockSocket = pool.primaryAgent.createConnection()
      
      mockSocket.emit('error', new Error('Socket error'))

      expect(pool.connectionState.primary.healthy).toBe(false)
      expect(pool.connectionState.primary.lastError).toBe('Socket error')
    })
  })

  describe('Agent创建', () => {
    test('应该处理不支持的代理类型', () => {
      const accountId = 'invalid-type-account'
      const proxyConfig = { type: 'invalid', host: 'proxy.com', port: 8080 }

      expect(() => {
        connectionPoolManager.getPool(accountId, proxyConfig)
      }).toThrow('Unsupported proxy type: invalid')
    })

    test('应该正确配置Agent选项', () => {
      const accountId = 'options-test-account'
      const proxyConfig = { type: 'http', host: 'proxy.com', port: 8080 }
      const options = { useIPv4: false }

      const pool = connectionPoolManager.getPool(accountId, proxyConfig, options)

      expect(pool).toBeDefined()
      // Verify that SocksProxyAgent or HttpsProxyAgent was called with correct options
      expect(HttpsProxyAgent).toHaveBeenCalledWith(
        'http://proxy.com:8080',
        expect.objectContaining({
          family: 6, // IPv6
          keepAlive: true,
          maxSockets: 1,
          maxFreeSockets: 1
        })
      )
    })

    test('应该处理带认证的代理配置', () => {
      const accountId = 'auth-test-account'
      const proxyConfig = {
        type: 'socks5',
        host: 'socks.com',
        port: 1080,
        username: 'testuser',
        password: 'testpass'
      }

      const pool = connectionPoolManager.getPool(accountId, proxyConfig)

      expect(pool).toBeDefined()
      expect(SocksProxyAgent).toHaveBeenCalledWith(
        'socks5://testuser:testpass@socks.com:1080',
        expect.any(Object)
      )
    })
  })

  describe('内存和资源管理', () => {
    test('应该正确设置Agent事件监听器数量', () => {
      const accountId = 'memory-test-account'
      const proxyConfig = { type: 'http', host: 'proxy.com', port: 8080 }

      const pool = connectionPoolManager.getPool(accountId, proxyConfig)

      // Check that agents have error listeners
      expect(pool.primaryAgent.listeners('error').length).toBeGreaterThan(0)
      expect(pool.secondaryAgent.listeners('error').length).toBeGreaterThan(0)
    })

    test('应该在销毁时清理所有引用', () => {
      const accountId = 'cleanup-test-account'
      const proxyConfig = { type: 'http', host: 'proxy.com', port: 8080 }

      const pool = connectionPoolManager.getPool(accountId, proxyConfig)
      const primaryAgent = pool.primaryAgent
      const secondaryAgent = pool.secondaryAgent

      pool.destroy()

      expect(pool.primaryAgent).toBeNull()
      expect(pool.secondaryAgent).toBeNull()
      expect(primaryAgent.destroyed).toBe(true)
      expect(secondaryAgent.destroyed).toBe(true)
    })
  })
})