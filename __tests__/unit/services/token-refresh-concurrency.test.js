// TokenRefreshService 分布式锁竞争测试
const { ConcurrencySimulator, concurrencyTestUtils } = require('../../setup/concurrency-simulator')
const { TimeController, timeTestUtils } = require('../../setup/time-controller')

// Mock依赖
jest.mock('../../../src/models/redis')
jest.mock('../../../src/utils/logger')

describe('TokenRefreshService 分布式锁竞争测试', () => {
  let concurrencySimulator
  let timeController
  let tokenRefreshService
  let mockRedis

  beforeEach(() => {
    concurrencySimulator = new ConcurrencySimulator()
    timeController = new TimeController()
    
    // 重新导入服务以获取新的实例
    jest.resetModules()
    tokenRefreshService = require('../../../src/services/tokenRefreshService')
    mockRedis = require('../../../src/models/redis')
    
    // 配置Redis Mock以支持分布式锁
    mockRedis.getClientSafe.mockReturnValue(global.testRedisInstance)
    
    jest.clearAllMocks()
  })

  afterEach(() => {
    if (concurrencySimulator.isRunning) {
      concurrencySimulator.reset()
    }
    if (timeController.isActive) {
      timeController.stop()
    }
  })

  describe('🔒 分布式锁获取和释放测试', () => {
    it('应该在单进程环境下正确获取和释放锁', async () => {
      const lockKey = 'test-lock-single'
      const service = new (require('../../../src/services/tokenRefreshService'))()

      // 获取锁
      const acquired = await service.acquireLock(lockKey)
      expect(acquired).toBe(true)
      
      // 验证锁的存在
      const lockExists = await global.testRedisInstance.get(lockKey)
      expect(lockExists).toBeTruthy()
      
      // 释放锁
      await service.releaseLock(lockKey)
      
      // 验证锁已被释放
      const lockAfterRelease = await global.testRedisInstance.get(lockKey)
      expect(lockAfterRelease).toBeNull()
    })

    it('应该在多进程竞争中确保只有一个进程获取锁', async () => {
      const lockKey = 'test-lock-competition'
      const processCount = 5
      
      const results = await concurrencyTestUtils.createLockCompetitionTest(
        lockKey,
        processCount,
        async (processId) => {
          const service = new (require('../../../src/services/tokenRefreshService'))()
          
          // 模拟获取锁
          const acquired = await service.acquireLock(lockKey)
          
          if (acquired) {
            // 模拟持有锁期间的工作
            await new Promise(resolve => setTimeout(resolve, 100))
            
            // 释放锁
            await service.releaseLock(lockKey)
            
            return { processId, action: 'token_refresh_completed' }
          } else {
            return { processId, action: 'lock_acquisition_failed' }
          }
        }
      )()

      // 验证锁竞争结果
      expect(results.lockAcquisitions).toBe(1) // 只有一个进程应该获取到锁
      expect(results.lockContentions).toBe(processCount - 1) // 其他进程应该被阻塞
      expect(results.lockEfficiency).toBeCloseTo(1 / processCount, 2)
    })
  })

  describe('⏱️ 锁超时和TTL测试', () => {
    it('应该正确处理锁的TTL过期', async () => {
      await timeTestUtils.withTimeControl(async (controller) => {
        controller.start()
        
        const service = new (require('../../../src/services/tokenRefreshService'))()
        const lockKey = 'test-lock-ttl'
        
        // 获取锁（默认60秒TTL）
        const acquired = await service.acquireLock(lockKey)
        expect(acquired).toBe(true)
        
        // 推进时间到59秒，锁应该还存在
        controller.advance(59 * 1000)
        let lockExists = await global.testRedisInstance.get(lockKey)
        expect(lockExists).toBeTruthy()
        
        // 推进时间到61秒，锁应该过期
        controller.advance(2 * 1000)
        lockExists = await global.testRedisInstance.get(lockKey)
        expect(lockExists).toBeNull()
      })
    })

    it('应该处理锁TTL过期后的重新获取', async () => {
      await timeTestUtils.withTimeControl(async (controller) => {
        controller.start()
        
        const service1 = new (require('../../../src/services/tokenRefreshService'))()
        const service2 = new (require('../../../src/services/tokenRefreshService'))()
        const lockKey = 'test-lock-reacquisition'
        
        // 进程1获取锁
        const acquired1 = await service1.acquireLock(lockKey)
        expect(acquired1).toBe(true)
        
        // 进程2尝试获取锁，应该失败
        const acquired2_attempt1 = await service2.acquireLock(lockKey)
        expect(acquired2_attempt1).toBe(false)
        
        // 推进时间使锁过期
        controller.advance(65 * 1000) // 超过60秒TTL
        
        // 进程2再次尝试获取锁，应该成功
        const acquired2_attempt2 = await service2.acquireLock(lockKey)
        expect(acquired2_attempt2).toBe(true)
        
        // 清理
        await service2.releaseLock(lockKey)
      })
    })
  })

  describe('🏃‍♂️ Token刷新的实际并发场景测试', () => {
    it('应该在多个并发token刷新请求中只执行一次实际刷新', async () => {
      const accountId = 'test-account-concurrent-refresh'
      const platform = 'claude'
      const processCount = 10
      
      let actualRefreshCount = 0
      
      // 模拟token刷新的实际逻辑
      const mockTokenRefresh = async (processId) => {
        const service = new (require('../../../src/services/tokenRefreshService'))()
        
        // 尝试获取刷新锁
        const lockAcquired = await service.acquireRefreshLock(accountId, platform)
        
        if (lockAcquired) {
          try {
            // 模拟实际的token刷新过程
            actualRefreshCount++
            
            // 模拟网络延迟
            await new Promise(resolve => setTimeout(resolve, 200))
            
            return {
              processId,
              action: 'performed_refresh',
              refreshCount: actualRefreshCount
            }
          } finally {
            // 确保释放锁
            await service.releaseRefreshLock(accountId, platform)
          }
        } else {
          // 等待其他进程完成刷新
          await new Promise(resolve => setTimeout(resolve, 2000))
          
          return {
            processId,
            action: 'waited_for_refresh',
            refreshCount: actualRefreshCount
          }
        }
      }

      // 并发执行多个刷新请求
      const results = await concurrencySimulator.runConcurrent(
        Array.from({ length: processCount }, (_, i) => ({
          id: `refresh-process-${i}`,
          taskFn: () => mockTokenRefresh(`refresh-process-${i}`)
        })),
        { maxConcurrency: processCount, waitForAll: true }
      )

      // 验证结果
      expect(results.successful).toBe(processCount) // 所有进程都应该成功完成
      expect(actualRefreshCount).toBe(1) // 只应该执行一次实际刷新
      
      // 验证只有一个进程执行了刷新，其他进程都等待了
      const refreshExecutors = results.completedProcesses?.filter(
        p => p.result?.action === 'performed_refresh'
      ) || []
      const waiters = results.completedProcesses?.filter(
        p => p.result?.action === 'waited_for_refresh'
      ) || []
      
      expect(refreshExecutors).toHaveLength(1)
      expect(waiters).toHaveLength(processCount - 1)
    })

    it('应该处理token刷新过程中的错误和锁释放', async () => {
      const accountId = 'test-account-error-handling'
      const platform = 'claude'
      
      const service = new (require('../../../src/services/tokenRefreshService'))()
      
      // 获取刷新锁
      const lockAcquired = await service.acquireRefreshLock(accountId, platform)
      expect(lockAcquired).toBe(true)
      
      try {
        // 模拟刷新过程中的错误
        throw new Error('Token refresh failed')
      } catch (error) {
        // 确保在错误情况下也能释放锁
        await service.releaseRefreshLock(accountId, platform)
      }
      
      // 验证锁已被释放，其他进程可以获取
      const service2 = new (require('../../../src/services/tokenRefreshService'))()
      const lockAcquired2 = await service2.acquireRefreshLock(accountId, platform)
      expect(lockAcquired2).toBe(true)
      
      await service2.releaseRefreshLock(accountId, platform)
    })
  })

  describe('🔍 锁竞争分析和性能测试', () => {
    it('应该在高并发场景下维持锁的一致性', async () => {
      const lockKey = 'high-concurrency-test'
      const processCount = 50
      const iterationsPerProcess = 5
      
      let totalOperations = 0
      let successfulLockAcquisitions = 0
      
      const highConcurrencyTask = async (processId) => {
        const service = new (require('../../../src/services/tokenRefreshService'))()
        const results = []
        
        for (let i = 0; i < iterationsPerProcess; i++) {
          totalOperations++
          
          const acquired = await service.acquireLock(`${lockKey}-${i}`)
          
          if (acquired) {
            successfulLockAcquisitions++
            
            // 模拟短暂的工作
            await new Promise(resolve => setTimeout(resolve, 10))
            
            await service.releaseLock(`${lockKey}-${i}`)
            
            results.push({
              operation: i,
              result: 'success'
            })
          } else {
            results.push({
              operation: i,
              result: 'failed'
            })
          }
        }
        
        return {
          processId,
          operationsAttempted: iterationsPerProcess,
          operationsSuccessful: results.filter(r => r.result === 'success').length,
          results
        }
      }

      const results = await concurrencyTestUtils.createHighLoadTest(
        highConcurrencyTask,
        processCount,
        30000 // 30秒超时
      )()

      // 验证高并发性能
      expect(results.successful).toBe(processCount)
      expect(results.throughput).toBeGreaterThan(10) // 至少每秒10个成功操作
      expect(successfulLockAcquisitions).toBe(processCount * iterationsPerProcess) // 所有锁获取都应该成功（因为使用不同的key）
    })

    it('应该检测和报告潜在的死锁情况', async () => {
      // 模拟可能导致死锁的场景
      const service1 = new (require('../../../src/services/tokenRefreshService'))()
      const service2 = new (require('../../../src/services/tokenRefreshService'))()
      
      const lock1 = 'resource-1'
      const lock2 = 'resource-2'
      
      // 进程1：先获取lock1，再尝试获取lock2
      const process1Promise = (async () => {
        const acquired1 = await service1.acquireLock(lock1)
        expect(acquired1).toBe(true)
        
        await new Promise(resolve => setTimeout(resolve, 100))
        
        const acquired2 = await service1.acquireLock(lock2)
        
        await service1.releaseLock(lock1)
        if (acquired2) {
          await service1.releaseLock(lock2)
        }
        
        return { process: 1, lock1: true, lock2: acquired2 }
      })()
      
      // 进程2：先获取lock2，再尝试获取lock1
      const process2Promise = (async () => {
        await new Promise(resolve => setTimeout(resolve, 50)) // 稍微延迟启动
        
        const acquired2 = await service2.acquireLock(lock2)
        expect(acquired2).toBe(true)
        
        const acquired1 = await service2.acquireLock(lock1)
        
        await service2.releaseLock(lock2)
        if (acquired1) {
          await service2.releaseLock(lock1)
        }
        
        return { process: 2, lock1: acquired1, lock2: true }
      })()
      
      // 等待两个进程完成
      const [result1, result2] = await Promise.all([process1Promise, process2Promise])
      
      // 验证至少一个进程无法获取第二个锁（避免死锁）
      const process1SecondLock = result1.lock2
      const process2SecondLock = result2.lock1
      
      // 由于锁的互斥性，两个进程不应该都能获取到对方的锁
      expect(process1SecondLock && process2SecondLock).toBe(false)
    })
  })

  describe('📊 锁性能指标和监控', () => {
    it('应该收集和分析锁获取的性能指标', async () => {
      const lockKey = 'performance-metrics-test'
      const service = new (require('../../../src/services/tokenRefreshService'))()
      
      const performanceMetrics = {
        acquisitionTimes: [],
        releaseTimes: [],
        totalOperations: 0
      }
      
      // 执行多次锁操作并收集指标
      for (let i = 0; i < 20; i++) {
        const acquisitionStart = Date.now()
        
        const acquired = await service.acquireLock(`${lockKey}-${i}`)
        const acquisitionTime = Date.now() - acquisitionStart
        
        expect(acquired).toBe(true)
        performanceMetrics.acquisitionTimes.push(acquisitionTime)
        
        // 模拟一些工作
        await new Promise(resolve => setTimeout(resolve, Math.random() * 50))
        
        const releaseStart = Date.now()
        await service.releaseLock(`${lockKey}-${i}`)
        const releaseTime = Date.now() - releaseStart
        
        performanceMetrics.releaseTimes.push(releaseTime)
        performanceMetrics.totalOperations++
      }
      
      // 分析性能指标
      const avgAcquisitionTime = performanceMetrics.acquisitionTimes.reduce((a, b) => a + b, 0) / performanceMetrics.acquisitionTimes.length
      const avgReleaseTime = performanceMetrics.releaseTimes.reduce((a, b) => a + b, 0) / performanceMetrics.releaseTimes.length
      
      // 性能断言
      expect(avgAcquisitionTime).toBeLessThan(10) // 锁获取应该很快（<10ms）
      expect(avgReleaseTime).toBeLessThan(5)     // 锁释放应该更快（<5ms）
      expect(performanceMetrics.totalOperations).toBe(20)
      
      // 检查性能一致性
      const acquisitionStdDev = Math.sqrt(
        performanceMetrics.acquisitionTimes.reduce((acc, time) => 
          acc + Math.pow(time - avgAcquisitionTime, 2), 0
        ) / performanceMetrics.acquisitionTimes.length
      )
      
      expect(acquisitionStdDev).toBeLessThan(avgAcquisitionTime) // 标准差不应该太大
    })
  })
})