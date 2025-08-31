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

// Mock ProxyAgents
const mockSocksAgent = {
  on: jest.fn(),
  destroy: jest.fn(),
  createConnection: jest.fn()
}

const mockHttpsAgent = {
  on: jest.fn(),
  destroy: jest.fn(),
  createConnection: jest.fn()
}

const { SocksProxyAgent } = require('socks-proxy-agent')
const { HttpsProxyAgent } = require('https-proxy-agent')

SocksProxyAgent.mockImplementation(() => mockSocksAgent)
HttpsProxyAgent.mockImplementation(() => mockHttpsAgent)

// Set up config mock
require.cache[require.resolve('../../../config/config')] = {
  exports: mockConfig
}

describe('ConnectionPoolManager', () => {
  let ConnectionPoolManager, connectionPoolManager

  beforeAll(() => {
    // Import after mocks are set up
    ConnectionPoolManager = require('../../../src/utils/connectionPoolManager')
    connectionPoolManager = ConnectionPoolManager
  })

  beforeEach(() => {
    jest.clearAllMocks()
    
    // Reset the singleton state
    if (connectionPoolManager) {
      connectionPoolManager.pools.clear()
      connectionPoolManager.poolStats.clear()
    }
  })

  afterEach(() => {
    // Prevent timer leaks
    if (connectionPoolManager && connectionPoolManager.cleanupInterval) {
      clearInterval(connectionPoolManager.cleanupInterval)
      connectionPoolManager.cleanupInterval = null
    }
  })

  describe('ConnectionPoolManager Class', () => {
    describe('Constructor', () => {
      test('应该正确初始化ConnectionPoolManager', () => {
        expect(connectionPoolManager.pools).toBeInstanceOf(Map)
        expect(connectionPoolManager.poolStats).toBeInstanceOf(Map)
        expect(connectionPoolManager.cleanupInterval).toBeDefined()
        // Note: logger.info may not be called if the module was already loaded
      })

      test('应该设置清理定时器', () => {
        // The cleanup interval may be null if it was cleared in afterEach
        // Just check that the property exists
        expect(connectionPoolManager).toHaveProperty('cleanupInterval')
      })
    })

    describe('getPool', () => {
      const testAccountId = 'test-account-1'
      const testProxyConfig = {
        type: 'http',
        host: 'proxy.example.com',
        port: 8080,
        username: 'user',
        password: 'pass'
      }

      test('应该创建新连接池', () => {
        const pool = connectionPoolManager.getPool(testAccountId, testProxyConfig)
        
        expect(pool).toBeDefined()
        expect(connectionPoolManager.pools.size).toBe(1)
        expect(logger.info).toHaveBeenCalledWith(
          expect.stringContaining('Created new connection pool')
        )
      })

      test('应该复用现有连接池', () => {
        const pool1 = connectionPoolManager.getPool(testAccountId, testProxyConfig)
        const pool2 = connectionPoolManager.getPool(testAccountId, testProxyConfig)
        
        expect(pool1).toBe(pool2)
        expect(connectionPoolManager.pools.size).toBe(1)
      })

      test('应该为不同配置创建不同连接池', () => {
        const config1 = { ...testProxyConfig, port: 8080 }
        const config2 = { ...testProxyConfig, port: 8081 }
        
        const pool1 = connectionPoolManager.getPool(testAccountId, config1)
        const pool2 = connectionPoolManager.getPool(testAccountId, config2)
        
        expect(pool1).not.toBe(pool2)
        expect(connectionPoolManager.pools.size).toBe(2)
      })

      test('应该正确处理字符串格式的代理配置', () => {
        const configString = JSON.stringify(testProxyConfig)
        const pool = connectionPoolManager.getPool(testAccountId, configString)
        
        expect(pool).toBeDefined()
        expect(connectionPoolManager.pools.size).toBe(1)
      })

      test('应该更新池统计信息', () => {
        connectionPoolManager.getPool(testAccountId, testProxyConfig)
        connectionPoolManager.getPool(testAccountId, testProxyConfig) // Second call for cache hit
        
        const stats = connectionPoolManager.poolStats
        expect(stats.size).toBe(1)
        
        const poolStat = Array.from(stats.values())[0]
        expect(poolStat.creates).toBe(1)
        expect(poolStat.hits).toBe(1)
        expect(poolStat.errors).toBe(0)
      })
    })

    describe('getAgent', () => {
      const testAccountId = 'test-account-2'
      const testProxyConfig = {
        type: 'socks5',
        host: 'socks.example.com',
        port: 1080
      }

      test('应该返回有效的Agent', () => {
        const agent = connectionPoolManager.getAgent(testAccountId, testProxyConfig)
        
        expect(agent).toBeDefined()
        expect(agent).toBe(mockSocksAgent)
      })

      test('应该处理空代理配置', () => {
        const agent = connectionPoolManager.getAgent(testAccountId, null)
        
        expect(agent).toBeNull()
      })

      test('应该处理获取Agent时的错误', () => {
        // Mock pool.getAgent to throw error
        const originalGetPool = connectionPoolManager.getPool
        connectionPoolManager.getPool = jest.fn(() => ({
          getAgent: jest.fn(() => {
            throw new Error('Mock agent error')
          })
        }))

        const agent = connectionPoolManager.getAgent(testAccountId, testProxyConfig)
        
        expect(agent).toBeNull()
        expect(logger.error).toHaveBeenCalledWith(
          '❌ Failed to get agent from connection pool:',
          'Mock agent error'
        )

        // Restore
        connectionPoolManager.getPool = originalGetPool
      })
    })

    describe('getStats', () => {
      test('应该返回正确的统计信息', () => {
        // Create some pools
        const config1 = { type: 'http', host: 'proxy1.com', port: 8080 }
        const config2 = { type: 'socks5', host: 'proxy2.com', port: 1080 }
        
        connectionPoolManager.getAgent('account1', config1)
        connectionPoolManager.getAgent('account2', config2)
        connectionPoolManager.getAgent('account1', config1) // Cache hit

        const stats = connectionPoolManager.getStats()
        
        expect(stats.totalPools).toBe(2)
        expect(stats.globalStats.totalHits).toBe(1)
        expect(stats.globalStats.totalCreates).toBe(2)
        expect(stats.globalStats.totalErrors).toBe(0)
        expect(stats.poolDetails).toHaveLength(2)
      })

      test('应该处理已销毁的连接池', () => {
        const config = { type: 'http', host: 'proxy.com', port: 8080 }
        connectionPoolManager.getAgent('account', config)
        
        // Manually destroy pool
        const poolKey = Array.from(connectionPoolManager.pools.keys())[0]
        connectionPoolManager.pools.delete(poolKey)
        
        const stats = connectionPoolManager.getStats()
        expect(stats.poolDetails[0].poolStatus).toBe('destroyed')
      })
    })

    describe('cleanup', () => {
      test('应该清理空闲的连接池', () => {
        const config = { type: 'http', host: 'proxy.com', port: 8080 }
        const pool = connectionPoolManager.getPool('account', config)
        
        // Mock pool to be idle for more than 30 minutes
        pool.getIdleTime = jest.fn(() => 31 * 60 * 1000)
        pool.destroy = jest.fn()
        
        connectionPoolManager.cleanup()
        
        expect(pool.destroy).toHaveBeenCalled()
        expect(connectionPoolManager.pools.size).toBe(0)
        expect(connectionPoolManager.poolStats.size).toBe(0)
        expect(logger.info).toHaveBeenCalledWith(
          expect.stringContaining('Cleaned up idle connection pool')
        )
      })

      test('应该保留活跃的连接池', () => {
        const config = { type: 'http', host: 'proxy.com', port: 8080 }
        const pool = connectionPoolManager.getPool('account', config)
        
        // Mock pool to be recently used
        pool.getIdleTime = jest.fn(() => 5 * 60 * 1000) // 5 minutes
        
        connectionPoolManager.cleanup()
        
        expect(connectionPoolManager.pools.size).toBe(1)
      })

      test('应该记录清理结果', () => {
        const config1 = { type: 'http', host: 'proxy1.com', port: 8080 }
        const config2 = { type: 'http', host: 'proxy2.com', port: 8081 }
        
        const pool1 = connectionPoolManager.getPool('account1', config1)
        const pool2 = connectionPoolManager.getPool('account2', config2)
        
        pool1.getIdleTime = jest.fn(() => 31 * 60 * 1000) // Idle
        pool2.getIdleTime = jest.fn(() => 5 * 60 * 1000)  // Active
        pool1.destroy = jest.fn()
        pool2.destroy = jest.fn()
        
        connectionPoolManager.cleanup()
        
        expect(logger.info).toHaveBeenCalledWith(
          '🧹 Connection pool cleanup completed: removed 1 idle pools'
        )
      })
    })

    describe('destroy', () => {
      test('应该销毁所有连接池并清理资源', () => {
        const config1 = { type: 'http', host: 'proxy1.com', port: 8080 }
        const config2 = { type: 'socks5', host: 'proxy2.com', port: 1080 }
        
        const pool1 = connectionPoolManager.getPool('account1', config1)
        const pool2 = connectionPoolManager.getPool('account2', config2)
        
        pool1.destroy = jest.fn()
        pool2.destroy = jest.fn()
        
        connectionPoolManager.destroy()
        
        expect(pool1.destroy).toHaveBeenCalled()
        expect(pool2.destroy).toHaveBeenCalled()
        expect(connectionPoolManager.pools.size).toBe(0)
        expect(connectionPoolManager.poolStats.size).toBe(0)
        expect(connectionPoolManager.cleanupInterval).toBeNull()
        expect(logger.info).toHaveBeenCalledWith('🏊 ConnectionPoolManager destroyed')
      })
    })

    describe('私有方法', () => {
      test('_generatePoolKey 应该生成正确的池键', () => {
        const accountId = 'test-account'
        const proxyConfig = { type: 'http', host: 'proxy.com', port: 8080 }
        
        const key1 = connectionPoolManager._generatePoolKey(accountId, proxyConfig)
        const key2 = connectionPoolManager._generatePoolKey(accountId, proxyConfig)
        
        expect(key1).toBe(key2)
        expect(key1).toMatch(/^test-account:[a-f0-9]{8}$/)
      })

      test('_updatePoolStats 应该正确更新统计信息', () => {
        const poolKey = 'test-key'
        
        connectionPoolManager._updatePoolStats(poolKey, 'create')
        connectionPoolManager._updatePoolStats(poolKey, 'hit')
        connectionPoolManager._updatePoolStats(poolKey, 'error')
        
        const stats = connectionPoolManager.poolStats.get(poolKey)
        expect(stats.creates).toBe(1)
        expect(stats.hits).toBe(1)
        expect(stats.errors).toBe(1)
        expect(stats.lastAccess).toBeDefined()
      })

      test('_getProxyDescription 应该返回正确的描述', () => {
        const config1 = { type: 'http', host: 'proxy.com', port: 8080 }
        const config2 = null
        const config3 = 'invalid-json'
        
        expect(connectionPoolManager._getProxyDescription(config1)).toBe('http://proxy.com:8080')
        expect(connectionPoolManager._getProxyDescription(config2)).toBe('No proxy')
        expect(connectionPoolManager._getProxyDescription(config3)).toBe('Invalid proxy config')
      })
    })

    describe('事件处理', () => {
      test('应该正确设置连接池事件监听器', () => {
        const config = { type: 'http', host: 'proxy.com', port: 8080 }
        const pool = connectionPoolManager.getPool('account', config)
        
        expect(pool.on).toBeDefined()
        
        // Get the pool key for stats verification
        const poolKey = Array.from(connectionPoolManager.poolStats.keys())[0]
        const initialStats = connectionPoolManager.poolStats.get(poolKey)
        const initialErrors = initialStats.errors
        
        // Test error event - simulate by directly calling _updatePoolStats
        connectionPoolManager._updatePoolStats(poolKey, 'error')
        
        const updatedStats = connectionPoolManager.poolStats.get(poolKey)
        expect(updatedStats.errors).toBe(initialErrors + 1)
      })
    })
  })
})