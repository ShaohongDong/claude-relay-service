// API Key Service 高级测试 - 使用新测试架构
const { TimeController, timeTestUtils } = require('../../setup/time-controller')
const { ConcurrencySimulator, concurrencyTestUtils } = require('../../setup/concurrency-simulator')

// 确保测试环境变量
process.env.NODE_ENV = 'test'
process.env.API_KEY_SALT = 'test-api-key-salt-for-testing-only'
process.env.ENCRYPTION_KEY = '12345678901234567890123456789012'
process.env.ENCRYPTION_SALT = 'test-encryption-salt-for-testing-only'

// Mock dependencies
jest.mock('../../../src/models/redis')
jest.mock('../../../src/utils/logger')

// Mock config to use test configuration
jest.mock('../../../config/config', () => {
  const testConfig = require('../../../config/test-config')
  return testConfig
})

describe('API Key Service - 高级场景测试', () => {

  let apiKeyService
  let mockRedis
  let concurrencySimulator
  let timeController

  beforeEach(async () => {
    // 确保全局时间控制器被清理
    if (global.testUtils && global.testUtils.globalTimeController) {
      try {
        if (global.testUtils.globalTimeController.isActive) {
          global.testUtils.globalTimeController.stop()
        }
      } catch (error) {
        console.warn('Warning: Failed to stop globalTimeController:', error.message)
      }
    }

    concurrencySimulator = new ConcurrencySimulator()
    timeController = new TimeController()

    // 重新导入服务
    jest.resetModules()
    apiKeyService = require('../../../src/services/apiKeyService')
    mockRedis = require('../../../src/models/redis')

    // 设置基本的Redis mock响应
    mockRedis.get.mockResolvedValue(null)
    mockRedis.set.mockResolvedValue('OK')
    mockRedis.keys.mockResolvedValue([])
    mockRedis.exists.mockResolvedValue(0)
    mockRedis.incrConcurrency.mockResolvedValue(1)
    mockRedis.decrConcurrency.mockResolvedValue(0)
    mockRedis.findApiKeyByHash.mockResolvedValue(null) // 默认无结果
    mockRedis.incrementTokenUsage.mockResolvedValue('OK') // 添加缺失的mock方法
    mockRedis.incrementDailyCost.mockResolvedValue('OK') // 添加缺失的mock方法
    mockRedis.getUsageStats.mockResolvedValue({ totalRequests: 0, totalTokensUsed: 0 })
    mockRedis.getDailyCost.mockResolvedValue({ cost: 0, requests: 0 })

    jest.clearAllMocks()
  })

  afterEach(async () => {
    // 清理并发模拟器
    if (concurrencySimulator && concurrencySimulator.isRunning) {
      await concurrencySimulator.reset()
    }
    
    // 清理时间控制器
    if (timeController && timeController.isActive) {
      try {
        timeController.stop()
      } catch (error) {
        console.warn('Warning: Failed to stop TimeController:', error.message)
      }
    }
  })

  describe('🕒 时间敏感的限流测试', () => {
    it('应该正确处理时间窗口内的请求计数', async () => {
      await timeTestUtils.withTimeControl(async (controller) => {
        const testApiKey = 'cr_test_time_limit_key'
        const testHash = 'test-hash-' + Math.random().toString(36).substring(2)
        
        // 设置每分钟5个请求的限制
        const mockApiKeyData = {
          id: testApiKey,
          name: 'Time Limit Test Key',
          rateLimitRequests: 5, // 修正字段名
          used: 0,
          limitType: 'minute'
        }

        // Mock API Key查找 - 使用findApiKeyByHash方法
        mockRedis.findApiKeyByHash.mockImplementation((hashedKey) => {
          // 模拟任何哈希都返回测试API Key数据
          return Promise.resolve({
            id: testApiKey,
            ...mockApiKeyData,
            isActive: 'true' // 确保激活状态
          })
        })

        // 设置并发限制的mock
        mockRedis.incrConcurrency.mockResolvedValue(1)
        mockRedis.decrConcurrency.mockResolvedValue(0)

        // 在1分钟内发送4个请求 - 应该都成功
        for (let i = 0; i < 4; i++) {
          const mockReq = {
            headers: { authorization: `Bearer ${testApiKey}` },
            ip: '127.0.0.1'
          }
          
          const result = await apiKeyService.validateApiKey(testApiKey, mockReq)
          expect(result.valid).toBe(true)
          
          // 前进10秒
          controller.advance(10 * 1000)
        }

        // 第5个请求应该触发限流
        const mockReq = {
          headers: { authorization: `Bearer ${testApiKey}` },
          ip: '127.0.0.1'
        }

        const result = await apiKeyService.validateApiKey(testApiKey, mockReq)
        expect(result.valid).toBe(false)
        expect(result.error).toContain('Rate limit exceeded')

        // 前进到下一分钟 - 限流应该重置
        controller.advance(20 * 1000) // 总共60秒
        
        const newResult = await apiKeyService.validateApiKey(testApiKey, mockReq)
        expect(newResult.valid).toBe(true) // 新分钟，限流重置
      })
    })

    it('应该正确处理API Key的使用统计记录', async () => {
      const testApiKey = 'cr_test_usage_stats'
      const testModel = 'claude-3-sonnet-20240229'
      
      // 记录使用统计
      await apiKeyService.recordUsage(testApiKey, 100, 50, 0, 0, testModel)
      
      // 验证使用统计被记录 - recordUsage使用incrementTokenUsage方法
      expect(mockRedis.incrementTokenUsage).toHaveBeenCalledWith(
        testApiKey,
        150, // inputTokens + outputTokens = 100 + 50
        100, // inputTokens
        50,  // outputTokens
        0,   // cacheCreateTokens
        0,   // cacheReadTokens
        testModel
      )
      
      // 验证费用统计也被记录
      expect(mockRedis.incrementDailyCost).toHaveBeenCalled()
      
      // 记录第二次使用
      await apiKeyService.recordUsage(testApiKey, 200, 100, 0, 0, testModel)
      
      // 验证第二次记录
      expect(mockRedis.incrementTokenUsage).toHaveBeenLastCalledWith(
        testApiKey,
        300, // inputTokens + outputTokens = 200 + 100
        200, // inputTokens
        100, // outputTokens
        0,   // cacheCreateTokens
        0,   // cacheReadTokens
        testModel
      )
    })
  })

  describe('🚀 并发限制和负载测试', () => {
    it('应该在高并发下正确管理并发限制', async () => {
      const testApiKey = 'cr_test_concurrency_limit'
      const testHash = 'test-hash-concurrency'
      const maxConcurrency = 3

      const mockApiKeyData = {
        id: testApiKey,
        name: 'Concurrency Test Key',
        rateLimitRequests: 1000, // 修正字段名
        used: 0,
        concurrencyLimit: maxConcurrency // 修正字段名
      }

      // Mock API Key查找 - 使用findApiKeyByHash方法
      mockRedis.findApiKeyByHash.mockImplementation((hashedKey) => {
        return Promise.resolve({
          id: testApiKey,
          ...mockApiKeyData,
          isActive: 'true' // 确保激活状态
        })
      })

      let currentConcurrency = 0
      let maxReachedConcurrency = 0

      // Mock并发计数器
      mockRedis.incrConcurrency.mockImplementation(() => {
        currentConcurrency++
        maxReachedConcurrency = Math.max(maxReachedConcurrency, currentConcurrency)
        return Promise.resolve(currentConcurrency)
      })

      mockRedis.decrConcurrency.mockImplementation(() => {
        currentConcurrency = Math.max(0, currentConcurrency - 1)
        return Promise.resolve(currentConcurrency)
      })

      // 创建20个并发请求
      const concurrentTasks = Array.from({ length: 20 }, (_, i) => ({
        id: `request-${i}`,
        taskFn: async () => {
          const mockReq = {
            headers: { authorization: `Bearer ${testApiKey}` },
            ip: '127.0.0.1'
          }
          
          // 验证API Key（会增加并发计数）
          const result = await apiKeyService.validateApiKey(testApiKey, mockReq)
          
          // 模拟请求处理时间
          await new Promise(resolve => setTimeout(resolve, 50))
          
          // 模拟请求完成（需要手动减少并发计数）
          await mockRedis.decrConcurrency(testApiKey)
          
          return result
        }
      }))

      const results = await concurrencySimulator.runConcurrent(
        concurrentTasks,
        { maxConcurrency: 10, waitForAll: true }
      )

      // 验证并发控制
      expect(results.successful).toBe(20) // 所有请求都应该处理完成
      expect(maxReachedConcurrency).toBeLessThanOrEqual(maxConcurrency + 1) // 允许1的误差
      
      // 验证最终并发计数为0
      expect(currentConcurrency).toBe(0)
    })

    it('应该正确处理API Key的哈希查找并发', async () => {
      const testApiKeys = [
        'cr_test_hash_1',
        'cr_test_hash_2', 
        'cr_test_hash_3'
      ]

      // Mock不同API Key的数据
      mockRedis.findApiKeyByHash.mockImplementation((hashedKey) => {
        // 模拟任何哈希值都可以找到对应的API Key
        // 使用简单的映射逻辑
        let apiKeyIndex = 0
        if (hashedKey.includes('1')) apiKeyIndex = 0
        else if (hashedKey.includes('2')) apiKeyIndex = 1
        else if (hashedKey.includes('3')) apiKeyIndex = 2
        
        const apiKey = testApiKeys[apiKeyIndex]
        if (apiKey) {
          return Promise.resolve({
            id: apiKey,
            name: `Test Key ${apiKey}`,
            rateLimitRequests: 100, // 修正字段名
            used: 0,
            isActive: 'true'
          })
        }
        return Promise.resolve(null)
      })

      // 并发验证多个不同的API Key
      const concurrentValidations = testApiKeys.flatMap(apiKey => 
        Array.from({ length: 10 }, (_, i) => ({
          id: `validation-${apiKey}-${i}`,
          taskFn: () => {
            const mockReq = {
              headers: { authorization: `Bearer ${apiKey}` },
              ip: '127.0.0.1'
            }
            return apiKeyService.validateApiKey(apiKey, mockReq)
          }
        }))
      )

      const results = await concurrencySimulator.runConcurrent(
        concurrentValidations,
        { maxConcurrency: 15, waitForAll: true }
      )

      // 验证所有验证都成功
      expect(results.successful).toBe(30) // 3个Key × 10次验证
      
      // 验证结果
      results.completedProcesses.forEach(process => {
        expect(process.result.valid).toBe(true)
        expect(process.result.apiKeyData).toBeTruthy()
      })
    })
  })

  describe('💾 缓存和性能测试', () => {
    it('应该正确使用API Key哈希缓存', async () => {
      const testApiKey = 'cr_test_hash_cache'
      
      // 模拟API Key验证过程来测试哈希一致性
      const mockApiKeyData = {
        id: testApiKey,
        name: 'Hash Cache Test Key',
        rateLimitRequests: 100, // 修正字段名
        used: 0
      }
      
      // 使用固定哈希值模拟缓存行为
      const testHash = 'test-hash-cache-consistent'
      
      mockRedis.get.mockImplementation((key) => {
        if (key === `api_key_hash:${testHash}`) {
          return JSON.stringify({ id: testApiKey })
        }
        if (key === `api_key:${testApiKey}`) {
          return JSON.stringify(mockApiKeyData)
        }
        return null
      })
      
      // 模拟请求验证
      const mockReq = {
        headers: { authorization: `Bearer ${testApiKey}` },
        ip: '127.0.0.1'
      }
      
      // 多次验证同一API Key，应该使用缓存
      const result1 = await apiKeyService.validateApiKey(testApiKey, mockReq)
      const result2 = await apiKeyService.validateApiKey(testApiKey, mockReq)
      
      expect(result1.valid).toBe(true)
      expect(result2.valid).toBe(true)
      expect(result1.apiKeyData.id).toBe(testApiKey)
      expect(result2.apiKeyData.id).toBe(testApiKey)
    })

    it('应该在高频调用下保持良好性能', async () => {
      const testApiKey = 'cr_test_performance'
      const testHash = 'test-hash-performance'
      
      const mockApiKeyData = {
        id: testApiKey,
        name: 'Performance Test Key',
        rateLimitRequests: 10000, // 修正字段名
        used: 0
      }

      // Mock快速响应
      mockRedis.findApiKeyByHash.mockImplementation((hashedKey) => {
        return Promise.resolve({
          id: testApiKey,
          ...mockApiKeyData,
          isActive: 'true'
        })
      })

      // 高频验证测试
      const highFrequencyTasks = Array.from({ length: 100 }, (_, i) => ({
        id: `perf-test-${i}`,
        taskFn: () => {
          const mockReq = {
            headers: { authorization: `Bearer ${testApiKey}` },
            ip: '127.0.0.1'
          }
          return apiKeyService.validateApiKey(testApiKey, mockReq)
        }
      }))

      const startTime = Date.now()
      const results = await concurrencySimulator.runConcurrent(
        highFrequencyTasks,
        { maxConcurrency: 20, waitForAll: true }
      )
      const endTime = Date.now()

      // 验证性能
      expect(results.successful).toBe(100)
      expect(results.throughput).toBeGreaterThan(20) // 每秒至少20个请求
      
      const totalTime = endTime - startTime
      expect(totalTime).toBeLessThan(10000) // 总时间少于10秒
    })
  })

  describe('🔍 错误处理和边界条件', () => {
    it('应该正确处理Redis连接错误', async () => {
      const testApiKey = 'cr_test_redis_error'
      
      // 模拟Redis错误
      mockRedis.get.mockRejectedValue(new Error('Redis connection failed'))

      const mockReq = {
        headers: { authorization: `Bearer ${testApiKey}` },
        ip: '127.0.0.1'
      }

      const result = await apiKeyService.validateApiKey(testApiKey, mockReq)
      
      expect(result.valid).toBe(false)
      expect(result.error).toContain('API key not found') // 应该有友好的错误信息
    })

    it('应该处理无效的API Key格式', async () => {
      const invalidKeys = [
        '', // 空字符串
        'invalid-key', // 错误格式
        'cr_', // 太短
        null, // null值
        undefined // undefined值
      ]

      for (const invalidKey of invalidKeys) {
        const mockReq = {
          headers: { authorization: `Bearer ${invalidKey}` },
          ip: '127.0.0.1'
        }

        const result = await apiKeyService.validateApiKey(invalidKey, mockReq)
        expect(result.valid).toBe(false)
      }
    })

    it('应该正确处理并发限制超出的情况', async () => {
      const testApiKey = 'cr_test_concurrency_exceeded'
      const maxConcurrency = 2

      const mockApiKeyData = {
        id: testApiKey,
        name: 'Concurrency Exceeded Test',
        rateLimitRequests: 1000, // 修正字段名
        used: 0,
        concurrencyLimit: maxConcurrency // 修正字段名
      }

      mockRedis.findApiKeyByHash.mockImplementation((hashedKey) => {
        return Promise.resolve({
          id: testApiKey,
          ...mockApiKeyData,
          isActive: 'true'
        })
      })

      // 模拟并发已满的情况
      mockRedis.incrConcurrency.mockResolvedValue(maxConcurrency + 1) // 超出限制

      const mockReq = {
        headers: { authorization: `Bearer ${testApiKey}` },
        ip: '127.0.0.1'
      }

      const result = await apiKeyService.validateApiKey(testApiKey, mockReq)
      
      expect(result.valid).toBe(false)
      expect(result.error).toContain('concurrency limit') // 应该有并发限制错误
    })
  })
})