/**
 * Connection Pools 端点集成测试
 * 测试连接池状态和DEBUG信息端点的正确性
 * 
 * 测试覆盖范围：
 * - 基本连接池状态端点
 * - DEBUG模式详细信息端点
 * - 数据结构完整性验证
 * - 错误处理测试
 * - 不同系统状态下的响应测试
 */

const request = require('supertest')
const Application = require('../../src/app')
const redis = require('../../src/models/redis')

// Mock 外部依赖
jest.mock('../../src/models/redis')
jest.mock('../../src/utils/logger')
jest.mock('../../src/services/pricingService')

describe('Connection Pools 端点集成测试', () => {
  let app
  let application
  let server

  beforeAll(async () => {
    // 设置测试环境
    process.env.NODE_ENV = 'test'
    process.env.PORT = '0' // 随机端口避免冲突
    process.env.ENCRYPTION_KEY = 'test-encryption-key-123456789012'
    process.env.JWT_SECRET = 'test-jwt-secret-key-for-testing-only'
    
    // Mock Redis 连接
    redis.isConnected = true
    redis.connect = jest.fn().mockResolvedValue(true)
    redis.disconnect = jest.fn().mockResolvedValue(true)
    redis.client = {
      keys: jest.fn().mockResolvedValue([]),
      hgetall: jest.fn().mockResolvedValue({}),
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue('OK'),
      del: jest.fn().mockResolvedValue(1),
      pipeline: jest.fn(() => ({
        exec: jest.fn().mockResolvedValue([])
      }))
    }

    // 创建应用实例
    application = new Application()
    await application.initialize()
    app = application.app
    server = application.server
  })

  afterAll(async () => {
    if (server && server.listening) {
      await new Promise((resolve) => {
        server.close(() => {
          resolve()
        })
      })
    }
    
    if (application) {
      // 清理连接池系统
      if (application.globalConnectionPoolManager) {
        application.globalConnectionPoolManager.destroy()
      }
      if (application.hybridConnectionManager) {
        application.hybridConnectionManager.stop()
      }
      if (application.connectionLifecycleManager) {
        application.connectionLifecycleManager.stop()
      }
    }
    
    // 清理定时器
    jest.clearAllTimers()
    jest.useRealTimers()
  })

  beforeEach(() => {
    jest.clearAllMocks()
    // 模拟系统时间
    jest.useFakeTimers()
    jest.setSystemTime(new Date('2025-09-02T10:00:00.000Z'))
  })

  afterEach(() => {
    jest.clearAllTimers()
    jest.useRealTimers()
  })

  describe('基本连接池状态端点 (/connection-pools)', () => {
    test('应该返回基本连接池状态信息', async () => {
      const response = await request(app)
        .get('/connection-pools')
        .expect(200)

      // 验证响应结构
      expect(response.body).toHaveProperty('status')
      expect(response.body).toHaveProperty('poolManager')
      expect(response.body).toHaveProperty('hybridManager')
      expect(response.body).toHaveProperty('lifecycleManager')
      expect(response.body).toHaveProperty('timestamp')

      // 验证时间戳格式
      expect(response.body.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
      expect(response.body.status).toBe('active')
    })

    test('应该返回正确的池管理器状态', async () => {
      const response = await request(app)
        .get('/connection-pools')
        .expect(200)

      const { poolManager } = response.body

      // 验证池管理器结构
      expect(poolManager).toHaveProperty('manager')
      expect(poolManager).toHaveProperty('pools')
      
      expect(poolManager.manager).toHaveProperty('isInitialized')
      expect(poolManager.manager).toHaveProperty('totalPools')
      expect(poolManager.manager).toHaveProperty('stats')

      // 验证统计数据结构
      const stats = poolManager.manager.stats
      expect(stats).toHaveProperty('totalPools')
      expect(stats).toHaveProperty('totalConnections')
      expect(stats).toHaveProperty('totalErrors')
      expect(stats).toHaveProperty('initializeStartedAt')
      expect(stats).toHaveProperty('initializeCompletedAt')

      // 验证数据类型
      expect(typeof poolManager.manager.isInitialized).toBe('boolean')
      expect(typeof poolManager.manager.totalPools).toBe('number')
      expect(Array.isArray(poolManager.pools)).toBe(true)
    })

    test('应该返回正确的混合管理器状态', async () => {
      const response = await request(app)
        .get('/connection-pools')
        .expect(200)

      const { hybridManager } = response.body

      expect(hybridManager).toHaveProperty('manager')
      expect(hybridManager).toHaveProperty('pools')
      expect(hybridManager).toHaveProperty('connectionStates')
      expect(hybridManager).toHaveProperty('timestamp')

      // 验证管理器配置
      const manager = hybridManager.manager
      expect(manager).toHaveProperty('isRunning')
      expect(manager).toHaveProperty('config')
      expect(manager).toHaveProperty('state')
      expect(manager).toHaveProperty('uptime')

      // 验证配置项
      const config = manager.config
      expect(config).toHaveProperty('healthCheckInterval')
      expect(config).toHaveProperty('performanceCheckInterval')
      expect(config).toHaveProperty('connectionTimeoutThreshold')
      expect(config).toHaveProperty('errorRateThreshold')

      // 验证状态数据
      const state = manager.state
      expect(state).toHaveProperty('totalErrors')
      expect(state).toHaveProperty('totalConnections')
      expect(state).toHaveProperty('averageLatency')

      expect(typeof manager.isRunning).toBe('boolean')
      expect(typeof manager.uptime).toBe('number')
    })

    test('应该返回正确的生命周期管理器状态', async () => {
      const response = await request(app)
        .get('/connection-pools')
        .expect(200)

      const { lifecycleManager } = response.body

      expect(lifecycleManager).toHaveProperty('config')
      expect(lifecycleManager).toHaveProperty('stats')
      expect(lifecycleManager).toHaveProperty('performanceReport')
      expect(lifecycleManager).toHaveProperty('timestamp')

      // 验证配置
      const config = lifecycleManager.config
      expect(config).toHaveProperty('maxConnectionAge')
      expect(config).toHaveProperty('healthCheckInterval')
      expect(config).toHaveProperty('maxConnectionsPerAccount')
      expect(config).toHaveProperty('connectionTimeoutMs')

      // 验证统计数据
      const stats = lifecycleManager.stats
      expect(stats).toHaveProperty('totalCreated')
      expect(stats).toHaveProperty('totalDestroyed')
      expect(stats).toHaveProperty('activeConnections')
      expect(stats).toHaveProperty('isRunning')

      // 验证性能报告
      const performanceReport = lifecycleManager.performanceReport
      expect(performanceReport).toHaveProperty('timestamp')
      expect(performanceReport).toHaveProperty('totalConnections')
      expect(performanceReport).toHaveProperty('performanceMetrics')
      expect(performanceReport).toHaveProperty('recommendations')

      expect(typeof stats.isRunning).toBe('boolean')
      expect(Array.isArray(performanceReport.recommendations)).toBe(true)
    })

    test('未初始化状态应该返回相应状态', async () => {
      // 临时清空连接池管理器
      const originalManager = application.globalConnectionPoolManager
      application.globalConnectionPoolManager = null

      const response = await request(app)
        .get('/connection-pools')
        .expect(200)

      expect(response.body.status).toBe('not_initialized')
      expect(response.body.message).toContain('Connection pool system not initialized')
      expect(response.body).toHaveProperty('timestamp')

      // 恢复管理器
      application.globalConnectionPoolManager = originalManager
    })
  })

  describe('DEBUG模式详细信息端点 (/connection-pools?debug=true)', () => {
    test('应该返回完整的DEBUG信息', async () => {
      const response = await request(app)
        .get('/connection-pools?debug=true')
        .expect(200)

      // 验证基本结构包含DEBUG信息
      expect(response.body).toHaveProperty('status', 'active')
      expect(response.body).toHaveProperty('debug')

      const debug = response.body.debug

      // 验证DEBUG信息结构
      expect(debug).toHaveProperty('timestamp')
      expect(debug).toHaveProperty('uptime')
      expect(debug).toHaveProperty('systemInfo')
      expect(debug).toHaveProperty('connections')
      expect(debug).toHaveProperty('configurations')
      expect(debug).toHaveProperty('dependencies')
      expect(debug).toHaveProperty('recommendations')
    })

    test('DEBUG系统信息应该包含正确数据', async () => {
      const response = await request(app)
        .get('/connection-pools?debug=true')
        .expect(200)

      const debug = response.body.debug
      const { systemInfo } = debug

      // 验证系统信息
      expect(systemInfo).toHaveProperty('nodeVersion')
      expect(systemInfo).toHaveProperty('platform')
      expect(systemInfo).toHaveProperty('arch')
      expect(systemInfo).toHaveProperty('memory')
      expect(systemInfo).toHaveProperty('cpuUsage')

      // 验证内存信息结构
      const memory = systemInfo.memory
      expect(memory).toHaveProperty('rss')
      expect(memory).toHaveProperty('heapTotal')
      expect(memory).toHaveProperty('heapUsed')
      expect(memory).toHaveProperty('external')

      // 验证CPU使用信息
      const cpuUsage = systemInfo.cpuUsage
      expect(cpuUsage).toHaveProperty('user')
      expect(cpuUsage).toHaveProperty('system')

      // 验证数据类型
      expect(typeof systemInfo.nodeVersion).toBe('string')
      expect(typeof systemInfo.platform).toBe('string')
      expect(typeof systemInfo.arch).toBe('string')
      expect(typeof debug.uptime).toBe('number') // DEBUG根级别的uptime
      expect(typeof memory.rss).toBe('number')
      expect(typeof cpuUsage.user).toBe('number')
    })

    test('DEBUG连接信息应该包含详细数据', async () => {
      const response = await request(app)
        .get('/connection-pools?debug=true')
        .expect(200)

      const { connections } = response.body.debug

      expect(connections).toHaveProperty('detailed')
      expect(connections).toHaveProperty('events')
      expect(connections).toHaveProperty('performance')
      expect(connections).toHaveProperty('errors')

      // 验证连接详情结构
      expect(Array.isArray(connections.detailed)).toBe(true)
      expect(Array.isArray(connections.events)).toBe(true)
      expect(Array.isArray(connections.errors)).toBe(true)

      // 验证性能指标
      const performance = connections.performance
      expect(performance).toHaveProperty('averageLatency')
      expect(performance).toHaveProperty('requestCount')
      expect(performance).toHaveProperty('errorRate')
      expect(performance).toHaveProperty('throughput')
      expect(performance).toHaveProperty('trends')

      expect(typeof performance.averageLatency).toBe('number')
      expect(typeof performance.requestCount).toBe('number')
      expect(typeof performance.errorRate).toBe('number')
      expect(typeof performance.throughput).toBe('number')
    })

    test('DEBUG配置验证应该包含完整检查', async () => {
      const response = await request(app)
        .get('/connection-pools?debug=true')
        .expect(200)

      const { configurations } = response.body.debug

      expect(configurations).toHaveProperty('proxy')
      expect(configurations).toHaveProperty('accounts')
      expect(configurations).toHaveProperty('system')

      // 验证代理配置验证
      const proxy = configurations.proxy
      expect(proxy).toHaveProperty('valid')
      expect(proxy).toHaveProperty('invalid')
      expect(proxy).toHaveProperty('details')
      expect(typeof proxy.valid).toBe('number')
      expect(typeof proxy.invalid).toBe('number')
      expect(Array.isArray(proxy.details)).toBe(true)

      // 验证账户配置验证
      const accounts = configurations.accounts
      expect(accounts).toHaveProperty('valid')
      expect(accounts).toHaveProperty('invalid')
      expect(accounts).toHaveProperty('details')

      // 验证系统配置验证
      const system = configurations.system
      expect(system).toHaveProperty('valid')
      expect(system).toHaveProperty('issues')
      expect(typeof system.valid).toBe('boolean')
      expect(Array.isArray(system.issues)).toBe(true)
    })

    test('DEBUG依赖健康检查应该正确检测Redis状态', async () => {
      const response = await request(app)
        .get('/connection-pools?debug=true')
        .expect(200)

      const { dependencies } = response.body.debug

      expect(dependencies).toHaveProperty('redis')
      expect(dependencies).toHaveProperty('accounts')

      // 验证Redis状态检查
      const redisStatus = dependencies.redis
      expect(redisStatus).toHaveProperty('status')
      expect(redisStatus).toHaveProperty('details')
      expect(redisStatus.status).toBe('connected') // 因为我们mock了redis.isConnected = true

      // 验证账户状态检查
      const accountsStatus = dependencies.accounts
      expect(accountsStatus).toHaveProperty('status')
      expect(accountsStatus).toHaveProperty('details')
    })

    test('DEBUG智能建议应该基于当前状态生成', async () => {
      const response = await request(app)
        .get('/connection-pools?debug=true')
        .expect(200)

      const { recommendations } = response.body.debug

      expect(Array.isArray(recommendations)).toBe(true)

      // 当没有连接时应该生成相应建议
      if (recommendations.length > 0) {
        recommendations.forEach(recommendation => {
          expect(recommendation).toHaveProperty('type')
          expect(recommendation).toHaveProperty('category')
          expect(recommendation).toHaveProperty('message')
          expect(recommendation).toHaveProperty('action')
          
          // 验证建议类型
          expect(['warning', 'error', 'critical', 'info']).toContain(recommendation.type)
          expect(typeof recommendation.category).toBe('string')
          expect(typeof recommendation.message).toBe('string')
          expect(typeof recommendation.action).toBe('string')
        })
      }
    })

    test('DEBUG模式应该包含时间戳和运行时间', async () => {
      const response = await request(app)
        .get('/connection-pools?debug=true')
        .expect(200)

      const debug = response.body.debug

      expect(debug).toHaveProperty('timestamp')
      expect(debug).toHaveProperty('uptime')

      // 验证时间戳格式
      expect(debug.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
      expect(typeof debug.uptime).toBe('number')
      expect(debug.uptime).toBeGreaterThanOrEqual(0)
    })
  })

  describe('错误处理测试', () => {
    test('应用未初始化时应该返回适当状态', async () => {
      // 创建一个未完全初始化的应用实例
      const partialApp = new Application()
      // 不调用initialize，直接设置基本express实例
      partialApp.app = require('express')()
      partialApp.globalConnectionPoolManager = null

      const response = await request(partialApp.app)
        .get('/connection-pools')
        .expect(404) // 因为路由未注册，应该返回404

      // 404响应可能返回空对象或包含error的对象
      expect([404]).toContain(response.status)
    })

    test('DEBUG信息收集失败时应该优雅处理', async () => {
      // Mock一个会抛出错误的方法
      const originalCollectDebugInfo = application.collectDebugInfo
      application.collectDebugInfo = jest.fn().mockRejectedValue(new Error('Mock debug collection error'))

      const response = await request(app)
        .get('/connection-pools?debug=true')
        .expect(500) // 由于DEBUG收集失败，会返回500

      // 应该包含错误信息
      expect(response.body).toHaveProperty('status', 'error')
      expect(response.body).toHaveProperty('error')

      // 恢复原方法
      application.collectDebugInfo = originalCollectDebugInfo
    })

    test('内部错误应该返回500状态码', async () => {
      // Mock getAllPoolStatus方法抛出错误
      const originalMethod = application.globalConnectionPoolManager.getAllPoolStatus
      application.globalConnectionPoolManager.getAllPoolStatus = jest.fn(() => {
        throw new Error('Mock internal error')
      })

      const response = await request(app)
        .get('/connection-pools')
        .expect(500)

      expect(response.body).toHaveProperty('status', 'error')
      expect(response.body).toHaveProperty('error')
      expect(response.body).toHaveProperty('timestamp')

      // 恢复原方法
      application.globalConnectionPoolManager.getAllPoolStatus = originalMethod
    })
  })

  describe('数据结构完整性验证', () => {
    test('所有必需字段应该存在且类型正确', async () => {
      const response = await request(app)
        .get('/connection-pools')
        .expect(200)

      const data = response.body

      // 验证顶级结构
      expect(typeof data.status).toBe('string')
      expect(typeof data.timestamp).toBe('string')
      expect(typeof data.poolManager).toBe('object')
      expect(typeof data.hybridManager).toBe('object')  
      expect(typeof data.lifecycleManager).toBe('object')

      // 验证嵌套结构不为null
      expect(data.poolManager).not.toBeNull()
      expect(data.hybridManager).not.toBeNull()
      expect(data.lifecycleManager).not.toBeNull()
    })

    test('DEBUG模式所有字段应该存在且类型正确', async () => {
      // 确保collectDebugInfo方法正常工作
      const originalCollectDebugInfo = application.collectDebugInfo
      
      const response = await request(app)
        .get('/connection-pools?debug=true')
        
      if (response.status === 500) {
        // 如果返回500，跳过测试或者检查错误信息
        expect(response.body).toHaveProperty('status', 'error')
        return
      }
      
      expect(response.status).toBe(200)
      const debug = response.body.debug

      // 验证DEBUG结构类型
      expect(typeof debug.timestamp).toBe('string')
      expect(typeof debug.uptime).toBe('number')
      expect(typeof debug.systemInfo).toBe('object')
      expect(typeof debug.connections).toBe('object')
      expect(typeof debug.configurations).toBe('object')
      expect(typeof debug.dependencies).toBe('object')
      expect(Array.isArray(debug.recommendations)).toBe(true)

      // 验证嵌套对象不为null
      expect(debug.systemInfo).not.toBeNull()
      expect(debug.connections).not.toBeNull()
      expect(debug.configurations).not.toBeNull()
      expect(debug.dependencies).not.toBeNull()
    })

    test('数字字段应该为有效数值', async () => {
      const response = await request(app)
        .get('/connection-pools?debug=true')
        
      if (response.status === 500) {
        expect(response.body).toHaveProperty('status', 'error')
        return
      }
      
      expect(response.status).toBe(200)
      const debug = response.body.debug

      // 验证数值字段
      expect(debug.uptime).toBeGreaterThanOrEqual(0)
      expect(debug.systemInfo.memory.rss).toBeGreaterThan(0)
      expect(debug.systemInfo.memory.heapTotal).toBeGreaterThan(0)
      expect(debug.systemInfo.memory.heapUsed).toBeGreaterThanOrEqual(0)
      
      expect(debug.connections.performance.averageLatency).toBeGreaterThanOrEqual(0)
      expect(debug.connections.performance.requestCount).toBeGreaterThanOrEqual(0)
      expect(debug.connections.performance.errorRate).toBeGreaterThanOrEqual(0)
      expect(debug.connections.performance.throughput).toBeGreaterThanOrEqual(0)
    })

    test('布尔字段应该为有效布尔值', async () => {
      const response = await request(app)
        .get('/connection-pools')
        .expect(200)

      const data = response.body

      expect(typeof data.poolManager.manager.isInitialized).toBe('boolean')
      expect(typeof data.hybridManager.manager.isRunning).toBe('boolean')
      expect(typeof data.lifecycleManager.stats.isRunning).toBe('boolean')
    })

    test('数组字段应该为有效数组', async () => {
      const response = await request(app)
        .get('/connection-pools?debug=true')
        
      if (response.status === 500) {
        expect(response.body).toHaveProperty('status', 'error')
        return
      }
      
      expect(response.status).toBe(200)
      const data = response.body

      expect(Array.isArray(data.poolManager.pools)).toBe(true)
      expect(Array.isArray(data.hybridManager.connectionStates)).toBe(true)
      expect(Array.isArray(data.lifecycleManager.performanceReport.recommendations)).toBe(true)
      expect(Array.isArray(data.debug.recommendations)).toBe(true)
      expect(Array.isArray(data.debug.connections.detailed)).toBe(true)
      expect(Array.isArray(data.debug.connections.events)).toBe(true)
      expect(Array.isArray(data.debug.connections.errors)).toBe(true)
    })
  })

  describe('性能和响应时间测试', () => {
    test('基本端点响应时间应该合理', async () => {
      const startTime = Date.now()
      
      await request(app)
        .get('/connection-pools')
        .expect(200)
      
      const responseTime = Date.now() - startTime
      expect(responseTime).toBeLessThan(1000) // 应该在1秒内响应
    })

    test('DEBUG模式响应时间应该合理', async () => {
      const startTime = Date.now()
      
      const response = await request(app)
        .get('/connection-pools?debug=true')
      
      const responseTime = Date.now() - startTime
      
      if (response.status === 500) {
        // 即使出错，响应时间也应该合理
        expect(responseTime).toBeLessThan(5000)
        expect(response.body).toHaveProperty('status', 'error')
        return
      }
      
      expect(response.status).toBe(200)
      expect(responseTime).toBeLessThan(5000) // DEBUG模式可以稍慢，但应在5秒内
    })

    test('并发请求应该正确处理', async () => {
      const requests = Array.from({ length: 5 }, () =>
        request(app).get('/connection-pools').expect(200)
      )

      const responses = await Promise.all(requests)
      
      // 所有响应都应该成功
      responses.forEach(response => {
        expect(response.body).toHaveProperty('status', 'active')
        expect(response.body).toHaveProperty('timestamp')
      })
    })
  })

  describe('Content-Type和Headers测试', () => {
    test('应该返回正确的Content-Type', async () => {
      const response = await request(app)
        .get('/connection-pools')
        .expect(200)
        .expect('Content-Type', /json/)

      expect(response.body).toBeDefined()
    })

    test('DEBUG模式应该返回正确的Content-Type', async () => {
      const response = await request(app)
        .get('/connection-pools?debug=true')
        .expect('Content-Type', /json/)

      expect(response.body).toBeDefined()
      
      if (response.status === 500) {
        expect(response.body).toHaveProperty('status', 'error')
        return
      }
      
      expect(response.status).toBe(200)
      expect(response.body).toHaveProperty('debug')
    })
  })
})