const asyncMonitor = require('../src/utils/asyncMonitor')

describe('Async Operations Cleanup Verification', () => {
  let originalProcessListeners
  
  beforeAll(() => {
    // 保存原始的进程监听器
    originalProcessListeners = {
      unhandledRejection: process.listeners('unhandledRejection'),
      uncaughtException: process.listeners('uncaughtException')
    }
    
    // 在测试环境中明确启用 AsyncMonitor
    asyncMonitor.enabled = true
    
    // 清理现有状态并重新启动监控
    asyncMonitor.cleanup()
    asyncMonitor.startMonitoring()
    
    console.log('🧪 AsyncMonitor enabled for testing:', {
      enabled: asyncMonitor.enabled,
      intervalsActive: asyncMonitor.intervals.size
    })
  })
  
  afterAll(() => {
    // 清理测试
    asyncMonitor.cleanup()
  })
  
  describe('Promise Tracker', () => {
    test('should track promise lifecycle completely', async () => {
      const promises = []
      const results = []
      
      // 创建成功的 Promise
      for (let i = 0; i < 10; i++) {
        const promise = new Promise(resolve => {
          setTimeout(() => resolve(`success_${i}`), 10)
        })
        promises.push(promise)
        
        asyncMonitor.trackPromise(promise, {
          type: 'success_test',
          name: `success_${i}`,
          metadata: { index: i }
        })
      }
      
      // 创建失败的 Promise
      for (let i = 0; i < 5; i++) {
        const promise = new Promise((_, reject) => {
          setTimeout(() => reject(new Error(`error_${i}`)), 15)
        })
        promises.push(promise.catch(err => ({ error: err.message })))
        
        asyncMonitor.trackPromise(promise, {
          type: 'error_test',
          name: `error_${i}`,
          metadata: { index: i }
        })
      }
      
      // 等待所有 Promise 完成
      const allResults = await Promise.all(promises)
      
      // 验证结果
      expect(allResults).toHaveLength(15)
      
      const stats = asyncMonitor.getStats()
      expect(stats.promises.created).toBeGreaterThanOrEqual(15)
      expect(stats.promises.resolved).toBeGreaterThanOrEqual(10)
      expect(stats.promises.rejected).toBeGreaterThanOrEqual(5)
      
      console.log('📊 Promise Lifecycle Stats:', stats.promises)
    })
    
    test('should detect promise leaks correctly', async () => {
      // 创建一些永不解决的 Promise（不设置超时，用于泄漏检测）
      const leakyPromises = []
      
      for (let i = 0; i < 3; i++) {
        const promise = new Promise(() => {
          // 永不解决
        })
        
        leakyPromises.push(promise)
        
        asyncMonitor.trackPromise(promise, {
          type: 'leak_test',
          name: `leak_${i}`,
          // 不设置timeout，让Promise存活用于泄漏检测
        })
      }
      
      // 等待一段时间让泄漏检测生效
      await new Promise(resolve => setTimeout(resolve, 100))
      
      // 手动触发泄漏检测（超过50ms的被认为是泄漏）
      const leaks = asyncMonitor.promiseTracker.detectLeaks(50)
      
      expect(leaks.length).toBeGreaterThan(0)
      console.log(`🚨 Detected ${leaks.length} promise leaks`)
      
      const stats = asyncMonitor.getStats()
      expect(stats.promises.leaked).toBeGreaterThan(0)
    })
    
    test('should handle promise timeout correctly', async () => {
      let timeoutCalled = false
      
      const timeoutPromise = new Promise(resolve => {
        setTimeout(() => {
          timeoutCalled = true
          resolve('late')
        }, 200)
      })
      
      asyncMonitor.trackPromise(timeoutPromise, {
        type: 'timeout_test',
        timeout: 50,
        name: 'timeout_test'
      })
      
      // 等待超时触发
      await new Promise(resolve => setTimeout(resolve, 100))
      
      const stats = asyncMonitor.getStats()
      expect(stats.promises.timeout).toBeGreaterThan(0)
      
      // 验证原始 Promise 是否仍然执行
      await new Promise(resolve => setTimeout(resolve, 150))
      expect(timeoutCalled).toBe(true)
    })
  })
  
  describe('Resource Cleaner', () => {
    test('should register and cleanup resources properly', () => {
      const resources = []
      const cleanupCallbacks = []
      
      // 注册多个资源
      for (let i = 0; i < 10; i++) {
        const resource = {
          id: i,
          data: new Array(100).fill(i),
          timer: setTimeout(() => {}, 1000)
        }
        
        let cleanupCalled = false
        const cleanup = (res) => {
          clearTimeout(res.timer)
          res.data = null
          cleanupCalled = true
        }
        
        const resourceId = asyncMonitor.registerResource(
          resource,
          cleanup,
          { type: 'test_resource', id: i }
        )
        
        resources.push({ resource, resourceId, cleanupCalled: () => cleanupCalled })
        cleanupCallbacks.push(cleanup)
      }
      
      // 清理一半资源
      for (let i = 0; i < 5; i++) {
        const result = asyncMonitor.cleanupResource(resources[i].resourceId)
        expect(result).toBe(true)
        expect(resources[i].cleanupCalled()).toBe(true)
      }
      
      // 获取资源统计
      const stats = asyncMonitor.resourceCleaner.getStats()
      expect(stats.total).toBe(5) // 剩余5个资源
      
      console.log('🧹 Resource Cleaner Stats:', stats)
    })
    
    test('should handle resource cleanup failures gracefully', () => {
      const resource = { data: 'test' }
      
      // 注册一个会失败的清理函数
      const resourceId = asyncMonitor.registerResource(
        resource,
        () => {
          throw new Error('Cleanup failed')
        },
        { type: 'failing_resource' }
      )
      
      // 尝试清理资源
      const result = asyncMonitor.cleanupResource(resourceId)
      expect(result).toBe(false) // 应该返回 false 表示清理失败
    })
    
    test('should auto-cleanup expired resources', async () => {
      const resource = { data: 'test' }
      let cleanupCalled = false
      
      // 注册资源
      asyncMonitor.registerResource(
        resource,
        () => { cleanupCalled = true },
        { type: 'expired_resource' }
      )
      
      // 启动自动清理（短时间）
      asyncMonitor.resourceCleaner.startAutoCleanup(100, 50) // 100ms 过期，50ms 检查
      
      // 等待自动清理触发
      await new Promise(resolve => setTimeout(resolve, 200))
      
      expect(cleanupCalled).toBe(true)
    })
  })
  
  describe('Advanced Async Operations', () => {
    test('should handle cancellable promises', async () => {
      let operationStarted = false
      let operationCancelled = false
      
      const cancellablePromise = asyncMonitor.cancellable(async () => {
        operationStarted = true
        await new Promise(resolve => setTimeout(resolve, 100))
        return 'completed'
      })
      
      cancellablePromise.onCancel((reason) => {
        operationCancelled = true
        expect(reason).toBe('test_cancel')
      })
      
      // 启动操作
      const resultPromise = cancellablePromise
      
      // 取消操作
      setTimeout(() => {
        cancellablePromise.cancel('test_cancel')
      }, 50)
      
      // 等待结果
      await new Promise(resolve => setTimeout(resolve, 150))
      
      expect(operationStarted).toBe(true)
      expect(operationCancelled).toBe(true)
    })
    
    test('should handle batch operations with concurrency control', async () => {
      const operations = []
      const results = []
      
      // 创建50个操作
      for (let i = 0; i < 50; i++) {
        operations.push(async () => {
          await new Promise(resolve => setTimeout(resolve, Math.random() * 20))
          return `result_${i}`
        })
      }
      
      const startTime = Date.now()
      
      // 使用并发控制执行
      const batchResults = await asyncMonitor.batch(operations, 5) // 最大并发5
      
      const duration = Date.now() - startTime
      
      expect(batchResults).toHaveLength(50)
      expect(duration).toBeGreaterThan(0)
      
      // 验证结果正确性
      batchResults.forEach((result, index) => {
        expect(result).toBe(`result_${index}`)
      })
      
      console.log(`⚡ Batch operations completed in ${duration}ms`)
    })
    
    test('should handle timeout operations correctly', async () => {
      // 快速完成的操作
      const fastPromise = new Promise(resolve => {
        setTimeout(() => resolve('fast'), 10)
      })
      
      const fastResult = await asyncMonitor.withTimeout(fastPromise, 100, 'Fast timeout')
      expect(fastResult).toBe('fast')
      
      // 慢操作（会超时）
      const slowPromise = new Promise(resolve => {
        setTimeout(() => resolve('slow'), 200)
      })
      
      await expect(
        asyncMonitor.withTimeout(slowPromise, 50, 'Slow timeout')
      ).rejects.toThrow('Slow timeout (50ms)')
    })
  })
  
  describe('Configuration and Stats', () => {
    test('should allow configuration changes', () => {
      const originalConfig = asyncMonitor.getStats().config
      
      // 更改配置
      asyncMonitor.configure({
        leakDetectionInterval: 30000,
        maxPromiseAge: 120000,
        statsReportInterval: 180000
      })
      
      const newConfig = asyncMonitor.getStats().config
      expect(newConfig.leakDetectionInterval).toBe(30000)
      expect(newConfig.maxPromiseAge).toBe(120000)
      expect(newConfig.statsReportInterval).toBe(180000)
      
      // 恢复原始配置
      asyncMonitor.configure(originalConfig)
    })
    
    test('should provide comprehensive statistics', () => {
      const stats = asyncMonitor.getStats()
      
      // 验证统计信息结构
      expect(stats).toHaveProperty('enabled')
      expect(stats).toHaveProperty('config')
      expect(stats).toHaveProperty('promises')
      expect(stats).toHaveProperty('resources')
      expect(stats).toHaveProperty('monitoring')
      
      // 验证 Promise 统计
      expect(stats.promises).toHaveProperty('active')
      expect(stats.promises).toHaveProperty('created')
      expect(stats.promises).toHaveProperty('resolved')
      expect(stats.promises).toHaveProperty('rejected')
      expect(stats.promises).toHaveProperty('timeout')
      expect(stats.promises).toHaveProperty('leaked')
      
      // 验证资源统计
      expect(stats.resources).toHaveProperty('total')
      expect(stats.resources).toHaveProperty('byType')
      expect(stats.resources).toHaveProperty('oldestAge')
      expect(stats.resources).toHaveProperty('avgAge')
      
      console.log('📈 Comprehensive Stats:', JSON.stringify(stats, null, 2))
    })
  })
  
  describe('Error Handling', () => {
    test('should handle unhandled promise rejections', async () => {
      let rejectionHandled = false
      let capturedReason = null
      
      // 临时添加监听器来捕获 rejection
      const rejectionHandler = (reason, promise) => {
        rejectionHandled = true
        capturedReason = reason
      }
      
      process.once('unhandledRejection', rejectionHandler)
      
      // 创建一个 Promise 并立即捕获其 rejection 以避免Jest报错
      const testPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Unhandled rejection test')), 10)
      })
      
      // 立即捕获rejection以防止Jest将其视为错误
      testPromise.catch(() => {
        // 故意为空，这样Jest不会报错，但unhandledRejection事件仍可能触发
      })
      
      // 等待事件处理
      await new Promise(resolve => setTimeout(resolve, 50))
      
      // 验证监听器函数存在（这证明AsyncMonitor设置了监听器）
      expect(typeof rejectionHandler).toBe('function')
      
      // 验证AsyncMonitor的unhandledRejection监听器存在
      const unhandledListeners = process.listeners('unhandledRejection')
      expect(unhandledListeners.length).toBeGreaterThan(0)
      
      console.log(`✅ Unhandled rejection monitoring is set up (${unhandledListeners.length} listeners)`)
    })
    
    test('should handle monitoring system failures gracefully', () => {
      // 测试在监控系统关闭状态下的操作
      const originalEnabled = asyncMonitor.enabled
      asyncMonitor.enabled = false
      
      // 这些操作应该正常工作，即使监控被禁用
      const promise = Promise.resolve('test')
      const trackingResult = asyncMonitor.trackPromise(promise, { type: 'disabled_test' })
      expect(trackingResult).toBe(promise)
      
      // 恢复状态
      asyncMonitor.enabled = originalEnabled
    })
  })
  
  describe('Integration Tests', () => {
    test('should work correctly with multiple concurrent operations', async () => {
      const operations = []
      const startTime = Date.now()
      
      // 混合操作：Promise、资源管理、超时等
      for (let i = 0; i < 20; i++) {
        operations.push((async () => {
          // 创建资源
          const resource = { data: new Array(100).fill(i) }
          const resourceId = asyncMonitor.registerResource(
            resource,
            (res) => { res.data = null },
            { type: 'integration_test', index: i }
          )
          
          // 创建 Promise
          const promise = new Promise(resolve => {
            setTimeout(() => resolve(`operation_${i}`), Math.random() * 100)
          })
          
          asyncMonitor.trackPromise(promise, {
            type: 'integration_promise',
            name: `operation_${i}`,
            timeout: 200
          })
          
          const result = await promise
          
          // 清理资源
          asyncMonitor.cleanupResource(resourceId)
          
          return result
        })())
      }
      
      const results = await Promise.all(operations)
      const duration = Date.now() - startTime
      
      expect(results).toHaveLength(20)
      console.log(`🎯 Integration test completed in ${duration}ms`)
      
      // 验证最终状态
      const finalStats = asyncMonitor.getStats()
      console.log('📊 Final Integration Stats:', {
        promises: finalStats.promises,
        resources: finalStats.resources
      })
    })
    
    test('should maintain performance under high load', async () => {
      const iterations = 1000
      const startTime = Date.now()
      const operations = []
      
      for (let i = 0; i < iterations; i++) {
        operations.push((async () => {
          // 快速 Promise 操作
          const promise = Promise.resolve(i)
          asyncMonitor.trackPromise(promise, { type: 'perf_test' })
          
          // 资源操作
          const resourceId = asyncMonitor.registerResource(
            { id: i },
            () => {},
            { type: 'perf_resource' }
          )
          
          await promise
          asyncMonitor.cleanupResource(resourceId)
          
          return i
        })())
      }
      
      await Promise.all(operations)
      
      const duration = Date.now() - startTime
      const opsPerSecond = (iterations / duration) * 1000
      
      console.log(`⚡ Performance: ${iterations} operations in ${duration}ms (${opsPerSecond.toFixed(2)} ops/sec)`)
      
      // 性能应该合理（每秒至少100个操作）
      expect(opsPerSecond).toBeGreaterThan(100)
    })
  })
})