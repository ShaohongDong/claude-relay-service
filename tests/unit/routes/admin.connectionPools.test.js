const request = require('supertest')
const express = require('express')

// Mock dependencies
jest.mock('../../../src/utils/logger')
jest.mock('../../../src/utils/proxyHelper')
jest.mock('../../../src/middleware/auth')

const logger = require('../../../src/utils/logger')
const ProxyHelper = require('../../../src/utils/proxyHelper')
const { authenticateAdmin } = require('../../../src/middleware/auth')

// Mock ProxyHelper methods
ProxyHelper.getConnectionPoolStats = jest.fn()
ProxyHelper.cleanupConnectionPools = jest.fn()

// Mock authenticateAdmin middleware
authenticateAdmin.mockImplementation((req, res, next) => {
  // Simulate successful authentication
  req.user = { id: 'admin-1', username: 'testadmin' }
  next()
})

describe('Admin Routes - Connection Pools Management', () => {
  let app
  let adminRouter

  beforeAll(() => {
    // Create express app for testing
    app = express()
    app.use(express.json())

    // Import admin router after mocks are set up
    adminRouter = require('../../../src/routes/admin')
    app.use('/admin', adminRouter)
  })

  beforeEach(() => {
    jest.clearAllMocks()
  })

  describe('GET /admin/connection-pools/stats', () => {
    test('应该返回连接池统计信息', async () => {
      const mockStats = {
        totalPools: 3,
        poolDetails: [
          {
            poolKey: 'account1:hash1',
            hits: 10,
            creates: 1,
            errors: 0,
            poolStatus: {
              accountId: 'account1',
              currentAgent: 'primary',
              connectionState: {
                primary: { healthy: true, errorCount: 0 },
                secondary: { healthy: true, errorCount: 0 }
              },
              stats: {
                requestCount: 15,
                errorCount: 0,
                failoverCount: 0
              }
            }
          }
        ],
        globalStats: {
          totalHits: 25,
          totalCreates: 3,
          totalErrors: 0
        }
      }

      ProxyHelper.getConnectionPoolStats.mockReturnValue(mockStats)

      const response = await request(app)
        .get('/admin/connection-pools/stats')
        .expect(200)

      expect(response.body.success).toBe(true)
      expect(response.body.data).toMatchObject(mockStats)
      expect(response.body.data.timestamp).toBeDefined()
      expect(ProxyHelper.getConnectionPoolStats).toHaveBeenCalledTimes(1)
    })

    test('应该处理获取统计信息时的错误', async () => {
      const mockError = new Error('Stats retrieval failed')
      ProxyHelper.getConnectionPoolStats.mockImplementation(() => {
        throw mockError
      })

      const response = await request(app)
        .get('/admin/connection-pools/stats')
        .expect(500)

      expect(response.body.success).toBe(false)
      expect(response.body.message).toBe('Failed to get connection pool statistics')
      expect(response.body.error).toBe('Stats retrieval failed')
      expect(logger.error).toHaveBeenCalledWith('Failed to get connection pool stats:', mockError)
    })

    test('应该检查管理员认证', async () => {
      // Mock authentication failure
      authenticateAdmin.mockImplementationOnce((req, res, next) => {
        res.status(401).json({ error: 'Unauthorized' })
      })

      await request(app)
        .get('/admin/connection-pools/stats')
        .expect(401)

      expect(ProxyHelper.getConnectionPoolStats).not.toHaveBeenCalled()
    })

    test('应该包含正确的响应格式', async () => {
      const mockStats = {
        totalPools: 1,
        poolDetails: [],
        globalStats: { totalHits: 0, totalCreates: 1, totalErrors: 0 }
      }

      ProxyHelper.getConnectionPoolStats.mockReturnValue(mockStats)

      const response = await request(app)
        .get('/admin/connection-pools/stats')
        .expect(200)

      expect(response.body).toHaveProperty('success', true)
      expect(response.body).toHaveProperty('data')
      expect(response.body.data).toHaveProperty('timestamp')
      expect(response.body.data).toHaveProperty('totalPools', 1)
      expect(response.body.data).toHaveProperty('poolDetails')
      expect(response.body.data).toHaveProperty('globalStats')
    })
  })

  describe('POST /admin/connection-pools/cleanup', () => {
    test('应该成功执行连接池清理', async () => {
      const mockStatsAfterCleanup = {
        totalPools: 2,
        poolDetails: [
          { poolKey: 'account1:hash1', hits: 5, creates: 1, errors: 0 }
        ],
        globalStats: { totalHits: 5, totalCreates: 1, totalErrors: 0 }
      }

      ProxyHelper.getConnectionPoolStats.mockReturnValue(mockStatsAfterCleanup)

      const response = await request(app)
        .post('/admin/connection-pools/cleanup')
        .expect(200)

      expect(response.body.success).toBe(true)
      expect(response.body.message).toBe('Connection pools cleanup completed')
      expect(response.body.data).toEqual(mockStatsAfterCleanup)
      expect(ProxyHelper.cleanupConnectionPools).toHaveBeenCalledTimes(1)
      expect(ProxyHelper.getConnectionPoolStats).toHaveBeenCalledTimes(1)
    })

    test('应该处理清理过程中的错误', async () => {
      const mockError = new Error('Cleanup failed')
      ProxyHelper.cleanupConnectionPools.mockImplementation(() => {
        throw mockError
      })

      const response = await request(app)
        .post('/admin/connection-pools/cleanup')
        .expect(500)

      expect(response.body.success).toBe(false)
      expect(response.body.message).toBe('Failed to cleanup connection pools')
      expect(response.body.error).toBe('Cleanup failed')
      expect(logger.error).toHaveBeenCalledWith('Failed to cleanup connection pools:', mockError)
      expect(ProxyHelper.getConnectionPoolStats).not.toHaveBeenCalled()
    })

    test('应该处理获取清理后统计信息的错误', async () => {
      // Cleanup succeeds but stats retrieval fails
      ProxyHelper.cleanupConnectionPools.mockImplementation(() => {}) // Success
      ProxyHelper.getConnectionPoolStats.mockImplementation(() => {
        throw new Error('Stats after cleanup failed')
      })

      const response = await request(app)
        .post('/admin/connection-pools/cleanup')
        .expect(500)

      expect(ProxyHelper.cleanupConnectionPools).toHaveBeenCalledTimes(1)
      expect(response.body.success).toBe(false)
      expect(response.body.error).toBe('Stats after cleanup failed')
    })

    test('应该检查管理员认证', async () => {
      authenticateAdmin.mockImplementationOnce((req, res, next) => {
        res.status(403).json({ error: 'Forbidden' })
      })

      await request(app)
        .post('/admin/connection-pools/cleanup')
        .expect(403)

      expect(ProxyHelper.cleanupConnectionPools).not.toHaveBeenCalled()
    })

    test('应该在清理后返回更新的统计信息', async () => {
      const mockStatsAfterCleanup = {
        totalPools: 1,
        poolDetails: [],
        globalStats: { totalHits: 0, totalCreates: 0, totalErrors: 0 }
      }

      ProxyHelper.getConnectionPoolStats.mockReturnValue(mockStatsAfterCleanup)

      const response = await request(app)
        .post('/admin/connection-pools/cleanup')
        .expect(200)

      expect(response.body.data.totalPools).toBe(1)
      expect(response.body.data.globalStats.totalHits).toBe(0)
    })
  })

  describe('GET /admin/connection-pools/debug', () => {
    test('应该返回详细的调试信息', async () => {
      const mockStats = {
        totalPools: 2,
        poolDetails: [
          {
            poolKey: 'account1:hash1',
            hits: 8,
            creates: 1,
            errors: 0,
            poolStatus: {
              accountId: 'account1',
              currentAgent: 'secondary',
              stats: { failoverCount: 1 }
            }
          }
        ],
        globalStats: { totalHits: 8, totalCreates: 1, totalErrors: 0 }
      }

      ProxyHelper.getConnectionPoolStats.mockReturnValue(mockStats)

      const response = await request(app)
        .get('/admin/connection-pools/debug')
        .expect(200)

      expect(response.body.success).toBe(true)
      expect(response.body.data).toMatchObject(mockStats)
      expect(response.body.data.timestamp).toBeDefined()
      expect(response.body.data.systemInfo).toBeDefined()
      expect(response.body.data.systemInfo).toHaveProperty('nodeVersion')
      expect(response.body.data.systemInfo).toHaveProperty('platform')
      expect(response.body.data.systemInfo).toHaveProperty('uptime')
      expect(response.body.data.systemInfo).toHaveProperty('memoryUsage')
      expect(response.body.data.systemInfo).toHaveProperty('cpuUsage')
    })

    test('应该包含系统信息', async () => {
      const mockStats = {
        totalPools: 0,
        poolDetails: [],
        globalStats: { totalHits: 0, totalCreates: 0, totalErrors: 0 }
      }

      ProxyHelper.getConnectionPoolStats.mockReturnValue(mockStats)

      const response = await request(app)
        .get('/admin/connection-pools/debug')
        .expect(200)

      const systemInfo = response.body.data.systemInfo
      expect(systemInfo.nodeVersion).toMatch(/^v\d+\.\d+\.\d+/)
      expect(systemInfo.platform).toBeDefined()
      expect(typeof systemInfo.uptime).toBe('number')
      expect(systemInfo.memoryUsage).toHaveProperty('rss')
      expect(systemInfo.memoryUsage).toHaveProperty('heapUsed')
      expect(systemInfo.memoryUsage).toHaveProperty('heapTotal')
      expect(systemInfo.cpuUsage).toHaveProperty('user')
      expect(systemInfo.cpuUsage).toHaveProperty('system')
    })

    test('应该处理获取调试信息时的错误', async () => {
      const mockError = new Error('Debug info retrieval failed')
      ProxyHelper.getConnectionPoolStats.mockImplementation(() => {
        throw mockError
      })

      const response = await request(app)
        .get('/admin/connection-pools/debug')
        .expect(500)

      expect(response.body.success).toBe(false)
      expect(response.body.message).toBe('Failed to get connection pool debug information')
      expect(response.body.error).toBe('Debug info retrieval failed')
      expect(logger.error).toHaveBeenCalledWith('Failed to get connection pool debug info:', mockError)
    })

    test('应该检查管理员认证', async () => {
      authenticateAdmin.mockImplementationOnce((req, res, next) => {
        res.status(401).json({ error: 'Authentication required' })
      })

      await request(app)
        .get('/admin/connection-pools/debug')
        .expect(401)

      expect(ProxyHelper.getConnectionPoolStats).not.toHaveBeenCalled()
    })

    test('应该返回时间戳', async () => {
      const mockStats = {
        totalPools: 1,
        poolDetails: [],
        globalStats: { totalHits: 0, totalCreates: 1, totalErrors: 0 }
      }

      ProxyHelper.getConnectionPoolStats.mockReturnValue(mockStats)

      const startTime = new Date()
      
      const response = await request(app)
        .get('/admin/connection-pools/debug')
        .expect(200)

      const endTime = new Date()
      const responseTime = new Date(response.body.data.timestamp)

      expect(responseTime.getTime()).toBeGreaterThanOrEqual(startTime.getTime())
      expect(responseTime.getTime()).toBeLessThanOrEqual(endTime.getTime())
    })
  })

  describe('路由集成测试', () => {
    test('应该正确处理所有连接池管理路由', async () => {
      const mockStats = {
        totalPools: 1,
        poolDetails: [],
        globalStats: { totalHits: 0, totalCreates: 1, totalErrors: 0 }
      }

      ProxyHelper.getConnectionPoolStats.mockReturnValue(mockStats)

      // Test stats endpoint
      const statsResponse = await request(app)
        .get('/admin/connection-pools/stats')
        .expect(200)
      expect(statsResponse.body.success).toBe(true)

      // Test cleanup endpoint
      const cleanupResponse = await request(app)
        .post('/admin/connection-pools/cleanup')
        .expect(200)
      expect(cleanupResponse.body.success).toBe(true)

      // Test debug endpoint
      const debugResponse = await request(app)
        .get('/admin/connection-pools/debug')
        .expect(200)
      expect(debugResponse.body.success).toBe(true)

      // Verify all calls were made
      expect(ProxyHelper.getConnectionPoolStats).toHaveBeenCalledTimes(3)
      expect(ProxyHelper.cleanupConnectionPools).toHaveBeenCalledTimes(1)
    })

    test('应该为所有端点设置正确的HTTP方法', async () => {
      ProxyHelper.getConnectionPoolStats.mockReturnValue({
        totalPools: 0,
        poolDetails: [],
        globalStats: { totalHits: 0, totalCreates: 0, totalErrors: 0 }
      })

      // Test wrong HTTP methods
      await request(app)
        .post('/admin/connection-pools/stats')
        .expect(404)

      await request(app)
        .get('/admin/connection-pools/cleanup')
        .expect(404)

      await request(app)
        .post('/admin/connection-pools/debug')
        .expect(404)
    })
  })

  describe('错误处理和边界情况', () => {
    test('应该处理ProxyHelper方法返回null', async () => {
      ProxyHelper.getConnectionPoolStats.mockReturnValue(null)

      const response = await request(app)
        .get('/admin/connection-pools/stats')
        .expect(200)

      expect(response.body.success).toBe(true)
      expect(response.body.data.timestamp).toBeDefined()
      expect(response.body.data).toEqual({
        timestamp: response.body.data.timestamp
      })
    })

    test('应该处理空的连接池统计', async () => {
      const emptyStats = {
        totalPools: 0,
        poolDetails: [],
        globalStats: { totalHits: 0, totalCreates: 0, totalErrors: 0 }
      }

      ProxyHelper.getConnectionPoolStats.mockReturnValue(emptyStats)

      const response = await request(app)
        .get('/admin/connection-pools/stats')
        .expect(200)

      expect(response.body.data.totalPools).toBe(0)
      expect(response.body.data.poolDetails).toHaveLength(0)
    })

    test('应该处理系统信息获取异常', async () => {
      const mockStats = { totalPools: 1 }
      ProxyHelper.getConnectionPoolStats.mockReturnValue(mockStats)

      // Mock process methods to throw
      const originalUptime = process.uptime
      const originalMemoryUsage = process.memoryUsage
      const originalCpuUsage = process.cpuUsage

      process.uptime = jest.fn(() => { throw new Error('Uptime error') })
      process.memoryUsage = jest.fn(() => { throw new Error('Memory error') })
      process.cpuUsage = jest.fn(() => { throw new Error('CPU error') })

      const response = await request(app)
        .get('/admin/connection-pools/debug')
        .expect(500)

      expect(response.body.success).toBe(false)

      // Restore original methods
      process.uptime = originalUptime
      process.memoryUsage = originalMemoryUsage
      process.cpuUsage = originalCpuUsage
    })
  })

  describe('响应格式验证', () => {
    test('stats端点应该返回标准格式', async () => {
      const mockStats = {
        totalPools: 2,
        poolDetails: [{ poolKey: 'test' }],
        globalStats: { totalHits: 1, totalCreates: 1, totalErrors: 0 }
      }

      ProxyHelper.getConnectionPoolStats.mockReturnValue(mockStats)

      const response = await request(app)
        .get('/admin/connection-pools/stats')
        .expect(200)

      expect(response.body).toMatchObject({
        success: true,
        data: expect.objectContaining({
          totalPools: 2,
          poolDetails: expect.any(Array),
          globalStats: expect.any(Object),
          timestamp: expect.any(String)
        })
      })
    })

    test('cleanup端点应该返回标准格式', async () => {
      const mockStats = { totalPools: 1 }
      ProxyHelper.getConnectionPoolStats.mockReturnValue(mockStats)

      const response = await request(app)
        .post('/admin/connection-pools/cleanup')
        .expect(200)

      expect(response.body).toMatchObject({
        success: true,
        message: 'Connection pools cleanup completed',
        data: mockStats
      })
    })

    test('debug端点应该返回扩展格式', async () => {
      const mockStats = { totalPools: 0 }
      ProxyHelper.getConnectionPoolStats.mockReturnValue(mockStats)

      const response = await request(app)
        .get('/admin/connection-pools/debug')
        .expect(200)

      expect(response.body).toMatchObject({
        success: true,
        data: expect.objectContaining({
          totalPools: 0,
          timestamp: expect.any(String),
          systemInfo: expect.objectContaining({
            nodeVersion: expect.any(String),
            platform: expect.any(String),
            uptime: expect.any(Number),
            memoryUsage: expect.any(Object),
            cpuUsage: expect.any(Object)
          })
        })
      })
    })
  })
})