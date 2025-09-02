/**
 * Application DEBUG 信息收集方法单元测试
 * 测试 Application 类中各个 DEBUG 信息收集方法的正确性
 * 
 * 测试范围：
 * - collectDebugInfo 方法
 * - collectConnectionDetails 方法  
 * - collectRecentEvents 方法
 * - collectPerformanceMetrics 方法
 * - collectErrorHistory 方法
 * - validateConfigurations 方法
 * - checkDependencies 方法
 * - generateRecommendations 方法
 */

const Application = require('../../src/app')
const redis = require('../../src/models/redis')

// Mock 外部依赖
jest.mock('../../src/models/redis')
jest.mock('../../src/utils/logger')
jest.mock('../../src/services/pricingService')

describe('Application DEBUG 信息收集方法测试', () => {
  let application
  let mockGlobalConnectionPoolManager
  let mockHybridConnectionManager  
  let mockConnectionLifecycleManager

  beforeAll(() => {
    // 设置测试环境
    process.env.NODE_ENV = 'test'
    process.env.ENCRYPTION_KEY = 'test-encryption-key-123456789012'
    process.env.JWT_SECRET = 'test-jwt-secret-key-for-testing-only'
    process.env.API_KEY_SALT = 'test-api-key-salt-for-testing-32chars'
  })

  beforeEach(async () => {
    // 创建应用实例
    application = new Application()

    // Mock Redis
    redis.isConnected = true
    redis.uptime = 12345
    redis.client = {
      keys: jest.fn().mockResolvedValue(['claude:account:test1', 'claude:account:test2']),
      hgetall: jest.fn().mockResolvedValue({}),
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue('OK')
    }

    // Mock 连接池管理器
    mockGlobalConnectionPoolManager = {
      pools: new Map(),
      errorHistory: [
        { timestamp: Date.now() - 1000, type: 'connection_failed', message: 'Test error 1' },
        { timestamp: Date.now() - 2000, type: 'timeout', message: 'Test error 2' }
      ]
    }

    mockHybridConnectionManager = {
      recentEvents: [
        { timestamp: Date.now() - 500, type: 'connection:established', accountId: 'test1' },
        { timestamp: Date.now() - 1500, type: 'connection:lost', accountId: 'test2' }
      ],
      errorHistory: [
        { timestamp: Date.now() - 800, type: 'hybrid_error', message: 'Hybrid test error' }
      ],
      getManagerStatus: jest.fn(() => ({
        state: {
          averageLatency: 150,
          totalErrors: 2,
          totalConnections: 5
        }
      }))
    }

    mockConnectionLifecycleManager = {
      recentEvents: [
        { timestamp: Date.now() - 300, type: 'lifecycle:cleanup', accountId: 'test1' }
      ],
      getLifecycleStats: jest.fn(() => ({
        totalCreated: 10,
        totalDestroyed: 2,
        isRunning: true
      }))
    }

    // 设置到应用实例
    application.globalConnectionPoolManager = mockGlobalConnectionPoolManager
    application.hybridConnectionManager = mockHybridConnectionManager
    application.connectionLifecycleManager = mockConnectionLifecycleManager
  })

  afterEach(() => {
    jest.clearAllMocks()
  })

  describe('collectDebugInfo 方法测试', () => {
    test('应该返回完整的DEBUG信息结构', async () => {
      const debugInfo = await application.collectDebugInfo()

      // 验证基本结构
      expect(debugInfo).toHaveProperty('timestamp')
      expect(debugInfo).toHaveProperty('uptime')
      expect(debugInfo).toHaveProperty('systemInfo')
      expect(debugInfo).toHaveProperty('connections')
      expect(debugInfo).toHaveProperty('configurations')
      expect(debugInfo).toHaveProperty('dependencies')
      expect(debugInfo).toHaveProperty('recommendations')

      // 验证时间戳格式
      expect(debugInfo.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
      expect(typeof debugInfo.uptime).toBe('number')
    })

    test('应该包含正确的系统信息', async () => {
      const debugInfo = await application.collectDebugInfo()
      const { systemInfo } = debugInfo

      expect(systemInfo).toHaveProperty('nodeVersion')
      expect(systemInfo).toHaveProperty('platform')
      expect(systemInfo).toHaveProperty('arch')
      expect(systemInfo).toHaveProperty('memory')
      expect(systemInfo).toHaveProperty('cpuUsage')

      // 验证系统信息内容
      expect(systemInfo.nodeVersion).toBe(process.version)
      expect(systemInfo.platform).toBe(process.platform)
      expect(systemInfo.arch).toBe(process.arch)
      expect(typeof systemInfo.memory).toBe('object')
      expect(typeof systemInfo.cpuUsage).toBe('object')
    })

    test('收集过程中发生错误时应该优雅处理', async () => {
      // Mock collectConnectionDetails 抛出错误
      application.collectConnectionDetails = jest.fn().mockRejectedValue(new Error('Test collection error'))

      const debugInfo = await application.collectDebugInfo()

      // 应该包含错误信息
      expect(debugInfo).toHaveProperty('collectionError')
      expect(debugInfo.collectionError).toHaveProperty('message', 'Test collection error')
      expect(debugInfo.collectionError).toHaveProperty('stack')
    })
  })

  describe('collectConnectionDetails 方法测试', () => {
    test('没有连接池管理器时应该返回空数组', async () => {
      application.globalConnectionPoolManager = null
      const details = await application.collectConnectionDetails()
      expect(details).toEqual([])
    })

    test('应该收集连接池详细信息', async () => {
      // 创建模拟连接池
      const mockPool = {
        getStatus: jest.fn(() => ({
          accountId: 'test-account-1',
          isInitialized: true,
          totalConnections: 2,
          healthyConnections: 2
        })),
        connections: [
          {
            id: 'conn_1',
            isHealthy: true,
            usageCount: 5,
            createdAt: Date.now() - 10000,
            lastUsedAt: Date.now() - 1000,
            latencyHistory: [100, 120, 90],
            errorHistory: [],
            proxyType: 'socks5',
            status: 'active'
          },
          {
            id: 'conn_2', 
            isHealthy: false,
            usageCount: 2,
            createdAt: Date.now() - 5000,
            lastUsedAt: Date.now() - 3000,
            latencyHistory: [200, 300],
            errorHistory: ['timeout'],
            proxyType: 'http',
            status: 'error'
          }
        ]
      }

      mockGlobalConnectionPoolManager.pools.set('test-account-1', mockPool)

      const details = await application.collectConnectionDetails()

      expect(details).toHaveLength(1)
      expect(details[0]).toHaveProperty('accountId', 'test-account-1')
      expect(details[0]).toHaveProperty('poolStatus')
      expect(details[0]).toHaveProperty('connections')
      expect(details[0].connections).toHaveLength(2)

      // 验证连接详情
      const conn1 = details[0].connections[0]
      expect(conn1).toHaveProperty('id', 'conn_1')
      expect(conn1).toHaveProperty('isHealthy', true)
      expect(conn1).toHaveProperty('usageCount', 5)
      expect(conn1).toHaveProperty('latencyHistory')
      expect(conn1).toHaveProperty('proxyType', 'socks5')
    })

    test('连接池获取状态出错时应该记录错误', async () => {
      const mockPool = {
        getStatus: jest.fn(() => {
          throw new Error('Pool status error')
        })
      }

      mockGlobalConnectionPoolManager.pools.set('error-account', mockPool)

      const details = await application.collectConnectionDetails()

      expect(details).toHaveLength(1)
      expect(details[0]).toHaveProperty('accountId', 'error-account')
      expect(details[0]).toHaveProperty('error', 'Pool status error')
    })
  })

  describe('collectRecentEvents 方法测试', () => {
    test('应该收集并合并最近事件', () => {
      const events = application.collectRecentEvents()

      expect(Array.isArray(events)).toBe(true)
      expect(events.length).toBeGreaterThan(0)

      // 验证事件按时间戳倒序排列
      for (let i = 0; i < events.length - 1; i++) {
        expect(events[i].timestamp).toBeGreaterThanOrEqual(events[i + 1].timestamp)
      }

      // 验证事件来源
      const hybridEvents = events.filter(e => e.type && e.type.startsWith('connection:'))
      const lifecycleEvents = events.filter(e => e.type && e.type.startsWith('lifecycle:'))
      
      expect(hybridEvents.length).toBeGreaterThan(0)
      expect(lifecycleEvents.length).toBeGreaterThan(0)
    })

    test('管理器不存在时应该返回空数组', () => {
      application.hybridConnectionManager = null
      application.connectionLifecycleManager = null

      const events = application.collectRecentEvents()
      expect(events).toEqual([])
    })

    test('应该限制事件数量为最近20个', () => {
      // 创建大量模拟事件
      const manyEvents = Array.from({ length: 30 }, (_, i) => ({
        timestamp: Date.now() - i * 1000,
        type: `test_event_${i}`,
        accountId: 'test'
      }))

      mockHybridConnectionManager.recentEvents = manyEvents.slice(0, 25)
      mockConnectionLifecycleManager.recentEvents = manyEvents.slice(25)

      const events = application.collectRecentEvents()

      // 应该最多返回40个事件（每个管理器最多20个）
      expect(events.length).toBeLessThanOrEqual(40)
    })
  })

  describe('collectPerformanceMetrics 方法测试', () => {
    test('应该收集性能指标', () => {
      const metrics = application.collectPerformanceMetrics()

      expect(metrics).toHaveProperty('averageLatency')
      expect(metrics).toHaveProperty('requestCount')
      expect(metrics).toHaveProperty('errorRate')
      expect(metrics).toHaveProperty('throughput')
      expect(metrics).toHaveProperty('trends')

      // 验证计算结果
      expect(metrics.averageLatency).toBe(150) // 来自mock数据
      expect(metrics.errorRate).toBe(2 / 5) // 2 errors / 5 connections
      expect(metrics.requestCount).toBe(10) // 来自lifecycle stats
    })

    test('管理器不存在时应该返回默认值', () => {
      application.hybridConnectionManager = null
      application.connectionLifecycleManager = null

      const metrics = application.collectPerformanceMetrics()

      expect(metrics.averageLatency).toBe(0)
      expect(metrics.requestCount).toBe(0)
      expect(metrics.errorRate).toBe(0)
      expect(metrics.throughput).toBe(0)
    })

    test('计算过程出错时应该记录错误', () => {
      mockHybridConnectionManager.getManagerStatus = jest.fn(() => {
        throw new Error('Manager status error')
      })

      const metrics = application.collectPerformanceMetrics()

      expect(metrics).toHaveProperty('collectionError', 'Manager status error')
    })
  })

  describe('collectErrorHistory 方法测试', () => {
    test('应该收集并合并错误历史', () => {
      const errors = application.collectErrorHistory()

      expect(Array.isArray(errors)).toBe(true)
      expect(errors.length).toBeGreaterThan(0)

      // 验证错误按时间戳倒序排列
      for (let i = 0; i < errors.length - 1; i++) {
        expect(errors[i].timestamp).toBeGreaterThanOrEqual(errors[i + 1].timestamp)
      }

      // 验证包含不同来源的错误
      const poolErrors = errors.filter(e => e.type === 'connection_failed' || e.type === 'timeout')
      const hybridErrors = errors.filter(e => e.type === 'hybrid_error')
      
      expect(poolErrors.length).toBeGreaterThan(0)
      expect(hybridErrors.length).toBeGreaterThan(0)
    })

    test('管理器不存在时不应该崩溃', () => {
      application.globalConnectionPoolManager = null
      application.hybridConnectionManager = null

      const errors = application.collectErrorHistory()
      expect(Array.isArray(errors)).toBe(true)
    })

    test('收集过程出错时应该记录收集错误', () => {
      // Mock一个会抛出错误的管理器
      application.globalConnectionPoolManager = {
        errorHistory: {
          slice: jest.fn(() => {
            throw new Error('Error history access error')
          })
        }
      }

      const errors = application.collectErrorHistory()

      expect(errors).toContainEqual(
        expect.objectContaining({
          type: 'debug_collection_error',
          message: 'Error history access error'
        })
      )
    })
  })

  describe('validateConfigurations 方法测试', () => {
    test('应该验证系统配置', async () => {
      const validation = await application.validateConfigurations()

      expect(validation).toHaveProperty('proxy')
      expect(validation).toHaveProperty('accounts')
      expect(validation).toHaveProperty('system')

      // 验证系统配置检查
      expect(validation.system.valid).toBe(true) // 因为我们设置了必要的环境变量
      expect(Array.isArray(validation.system.issues)).toBe(true)
    })

    test('缺少环境变量时应该检测到', async () => {
      delete process.env.ENCRYPTION_KEY

      const validation = await application.validateConfigurations()

      expect(validation.system.valid).toBe(false)
      expect(validation.system.issues).toContain('Missing ENCRYPTION_KEY')

      // 恢复环境变量
      process.env.ENCRYPTION_KEY = 'test-encryption-key-123456789012'
    })

    test('应该验证连接池配置', async () => {
      // 添加模拟连接池配置
      const mockPool = {
        getStatus: jest.fn(() => ({
          accountId: 'test-account-1',
          isInitialized: true,
          totalConnections: 2,
          healthyConnections: 2,
          proxyInfo: { type: 'socks5', host: 'proxy.example.com' }
        }))
      }

      mockGlobalConnectionPoolManager.pools.set('test-account-1', mockPool)

      const validation = await application.validateConfigurations()

      expect(validation.proxy.valid).toBe(1)
      expect(validation.proxy.invalid).toBe(0)
      expect(validation.accounts.valid).toBe(1)
      expect(validation.accounts.invalid).toBe(0)

      // 验证详情
      expect(validation.proxy.details).toContainEqual(
        expect.objectContaining({
          accountId: 'test-account-1',
          type: 'socks5',
          status: 'valid'
        })
      )
    })

    test('配置验证出错时应该记录错误', async () => {
      // Mock池状态获取出错
      const mockPool = {
        getStatus: jest.fn(() => {
          throw new Error('Pool status error')
        })
      }

      mockGlobalConnectionPoolManager.pools.set('error-account', mockPool)

      const validation = await application.validateConfigurations()

      expect(validation.accounts.invalid).toBe(1)
      expect(validation.accounts.details).toContainEqual(
        expect.objectContaining({
          accountId: 'error-account',
          error: 'Pool status error'
        })
      )
    })
  })

  describe('checkDependencies 方法测试', () => {
    test('应该检查Redis依赖状态', async () => {
      const dependencies = await application.checkDependencies()

      expect(dependencies).toHaveProperty('redis')
      expect(dependencies).toHaveProperty('accounts')

      // 验证Redis状态
      expect(dependencies.redis.status).toBe('connected')
      expect(dependencies.redis.details.connected).toBe(true)
      expect(dependencies.redis.details.uptime).toBe(12345)
    })

    test('Redis未连接时应该正确检测', async () => {
      redis.isConnected = false

      const dependencies = await application.checkDependencies()

      expect(dependencies.redis.status).toBe('disconnected')
      expect(dependencies.redis.details.connected).toBe(false)
      expect(dependencies.redis.details.error).toContain('Not connected')
    })

    test('应该检查账户可用性', async () => {
      const dependencies = await application.checkDependencies()

      expect(dependencies.accounts.status).toBe('available')
      expect(dependencies.accounts.details.totalAccounts).toBe(2)
      expect(dependencies.accounts.details.accountKeys).toEqual(['claude:account:test1', 'claude:account:test2'])
    })

    test('Redis查询出错时应该记录错误', async () => {
      redis.client.keys.mockRejectedValue(new Error('Redis query error'))

      const dependencies = await application.checkDependencies()

      expect(dependencies.accounts.status).toBe('error')
      expect(dependencies.accounts.details.error).toBe('Redis query error')
    })

    test('检查过程整体出错时应该记录错误', async () => {
      // Mock redis对象为无效状态
      const originalRedis = redis.isConnected
      Object.defineProperty(redis, 'isConnected', {
        get() { throw new Error('Redis access error') }
      })

      const dependencies = await application.checkDependencies()

      expect(dependencies).toHaveProperty('checkError', 'Redis access error')

      // 恢复
      Object.defineProperty(redis, 'isConnected', {
        value: originalRedis,
        writable: true
      })
    })
  })

  describe('generateRecommendations 方法测试', () => {
    test('无连接时应该生成相应建议', () => {
      const debugInfo = {
        connections: {
          detailed: []
        }
      }

      const recommendations = application.generateRecommendations(debugInfo)

      expect(Array.isArray(recommendations)).toBe(true)
      expect(recommendations.length).toBeGreaterThan(0)

      const noConnectionsWarning = recommendations.find(r => 
        r.category === 'connections' && r.message.includes('No active connections')
      )
      expect(noConnectionsWarning).toBeDefined()
      expect(noConnectionsWarning.type).toBe('warning')
    })

    test('高延迟时应该生成性能建议', () => {
      const debugInfo = {
        connections: {
          detailed: [{ connections: [] }],
          performance: {
            averageLatency: 6000 // 6秒，超过5秒阈值
          }
        }
      }

      const recommendations = application.generateRecommendations(debugInfo)

      const latencyWarning = recommendations.find(r => 
        r.category === 'performance' && r.message.includes('High average latency')
      )
      expect(latencyWarning).toBeDefined()
      expect(latencyWarning.type).toBe('warning')
    })

    test('高错误率时应该生成可靠性建议', () => {
      const debugInfo = {
        connections: {
          detailed: [],
          performance: {
            errorRate: 0.15 // 15%，超过10%阈值
          }
        }
      }

      const recommendations = application.generateRecommendations(debugInfo)

      const errorRateWarning = recommendations.find(r => 
        r.category === 'reliability' && r.message.includes('High error rate')
      )
      expect(errorRateWarning).toBeDefined()
      expect(errorRateWarning.type).toBe('error')
    })

    test('配置问题时应该生成配置建议', () => {
      const debugInfo = {
        connections: { detailed: [] },
        configurations: {
          proxy: { invalid: 2 },
          system: { valid: false, issues: ['Missing JWT_SECRET'] }
        }
      }

      const recommendations = application.generateRecommendations(debugInfo)

      const configWarning = recommendations.find(r => 
        r.category === 'configuration'
      )
      expect(configWarning).toBeDefined()

      const securityWarning = recommendations.find(r => 
        r.category === 'security'
      )
      expect(securityWarning).toBeDefined()
      expect(securityWarning.type).toBe('critical')
    })

    test('Redis连接问题时应该生成基础设施建议', () => {
      const debugInfo = {
        connections: { detailed: [] },
        dependencies: {
          redis: { status: 'disconnected' }
        }
      }

      const recommendations = application.generateRecommendations(debugInfo)

      const infraWarning = recommendations.find(r => 
        r.category === 'infrastructure'
      )
      expect(infraWarning).toBeDefined()
      expect(infraWarning.type).toBe('critical')
    })

    test('建议生成出错时应该记录错误', () => {
      const debugInfo = {
        connections: {
          detailed: {
            // 故意传入非数组引发错误
            reduce: undefined
          }
        }
      }

      const recommendations = application.generateRecommendations(debugInfo)

      const errorRecommendation = recommendations.find(r => 
        r.category === 'system' && r.message.includes('Failed to generate')
      )
      expect(errorRecommendation).toBeDefined()
      expect(errorRecommendation.type).toBe('error')
    })

    test('健康连接存在时应该生成较少建议', () => {
      const debugInfo = {
        connections: {
          detailed: [
            {
              connections: [
                { isHealthy: true },
                { isHealthy: true }
              ]
            }
          ],
          performance: {
            averageLatency: 100, // 正常延迟
            errorRate: 0.01 // 低错误率
          }
        },
        configurations: {
          proxy: { invalid: 0 },
          system: { valid: true, issues: [] }
        },
        dependencies: {
          redis: { status: 'connected' }
        }
      }

      const recommendations = application.generateRecommendations(debugInfo)

      // 健康状态下应该建议较少
      expect(recommendations.length).toBe(0)
    })
  })
})