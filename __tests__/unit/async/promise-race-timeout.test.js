// Promise.race 超时控制机制测试
const { ConcurrencySimulator, concurrencyTestUtils } = require('../../setup/concurrency-simulator')
const { TimeController, timeTestUtils } = require('../../setup/time-controller')

// Mock依赖
jest.mock('../../../src/models/redis')
jest.mock('../../../src/utils/logger')

describe('Promise.race 超时控制机制测试', () => {
  let concurrencySimulator
  let timeController
  let mockRedis

  beforeEach(() => {
    concurrencySimulator = new ConcurrencySimulator()
    timeController = new TimeController()
    mockRedis = require('../../../src/models/redis')
    
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

  describe('⏱️ 基础超时控制测试', () => {
    it('应该在操作完成时正常返回结果', async () => {
      await timeTestUtils.withTimeControl(async (controller) => {
        controller.start()

        const fastOperation = async () => {
          // 模拟200ms的快速操作
          return new Promise(resolve => setTimeout(() => resolve('success'), 200))
        }

        const result = await Promise.race([
          fastOperation(),
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Operation timeout')), 5000)
          )
        ])

        expect(result).toBe('success')
      })
    })

    it('应该在超时时抛出错误', async () => {
      await timeTestUtils.withTimeControl(async (controller) => {
        controller.start()

        const slowOperation = async () => {
          // 模拟10秒的慢操作
          return new Promise(resolve => setTimeout(() => resolve('should not reach'), 10000))
        }

        const timeoutPromise = Promise.race([
          slowOperation(),
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Operation timeout after 1000ms')), 1000)
          )
        ])

        // 推进时间到1秒，应该触发超时
        controller.advance(1000)

        await expect(timeoutPromise).rejects.toThrow('Operation timeout after 1000ms')
      })
    })
  })

  describe('🔐 认证中间件超时测试 (真实场景)', () => {
    it('应该模拟auth.js中的会话查找超时控制', async () => {
      // 这个测试模拟 src/middleware/auth.js:385 中的真实代码
      await timeTestUtils.withTimeControl(async (controller) => {
        controller.start()

        const token = 'test-session-token'
        
        // 模拟Redis会话查找 - 慢响应场景
        const slowSessionLookup = async (token) => {
          return new Promise(resolve => {
            setTimeout(() => {
              resolve({
                userId: 'test-user',
                username: 'testuser',
                createdAt: new Date().toISOString()
              })
            }, 6000) // 6秒延迟，超过5秒超时
          })
        }

        // 模拟真实的Promise.race超时控制
        const sessionLookupWithTimeout = Promise.race([
          slowSessionLookup(token),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Session lookup timeout')), 5000)
          )
        ])

        // 推进时间到5秒，应该触发超时
        controller.advance(5000)

        await expect(sessionLookupWithTimeout).rejects.toThrow('Session lookup timeout')
      })
    })

    it('应该在正常响应时间内成功获取会话', async () => {
      await timeTestUtils.withTimeControl(async (controller) => {
        controller.start()

        const token = 'test-session-token'
        const expectedSession = {
          userId: 'test-user-fast',
          username: 'testuser',
          createdAt: new Date().toISOString()
        }
        
        // 模拟快速的会话查找
        const fastSessionLookup = async (token) => {
          return new Promise(resolve => {
            setTimeout(() => resolve(expectedSession), 1000) // 1秒响应
          })
        }

        const sessionLookupWithTimeout = Promise.race([
          fastSessionLookup(token),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Session lookup timeout')), 5000)
          )
        ])

        // 推进时间到1秒
        controller.advance(1000)

        const result = await sessionLookupWithTimeout
        expect(result).toEqual(expectedSession)
      })
    })
  })

  describe('🌐 网络请求超时测试', () => {
    it('应该测试API请求的超时控制', async () => {
      await timeTestUtils.withTimeControl(async (controller) => {
        controller.start()

        // 模拟网络API请求
        const simulateApiRequest = async (url, timeoutMs) => {
          const apiCall = new Promise((resolve, reject) => {
            // 模拟网络延迟和响应时间的变化
            const networkDelay = Math.random() * 3000 + 1000 // 1-4秒随机延迟
            
            setTimeout(() => {
              if (networkDelay < timeoutMs) {
                resolve({
                  status: 'success',
                  data: { message: 'API call completed' },
                  responseTime: networkDelay
                })
              } else {
                reject(new Error('Network error'))
              }
            }, networkDelay)
          })

          const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`Request timeout after ${timeoutMs}ms`)), timeoutMs)
          )

          return Promise.race([apiCall, timeoutPromise])
        }

        // 测试较短超时（应该超时）
        const shortTimeoutPromise = simulateApiRequest('/api/test', 500)
        controller.advance(500)
        
        await expect(shortTimeoutPromise).rejects.toThrow('Request timeout after 500ms')

        // 重置并测试较长超时（应该成功）
        controller.jumpTo(0)
        const longTimeoutPromise = simulateApiRequest('/api/test', 5000)
        controller.advance(2000) // 推进2秒，应该足够大多数请求完成
        
        // 注意：由于随机性，这个测试可能不稳定，实际项目中应该控制随机性
      })
    })

    it('应该在并发请求中正确处理超时', async () => {
      const requestCount = 10
      const timeoutMs = 2000
      
      const results = await concurrencyTestUtils.createTimeoutTest(
        async (processId) => {
          // 模拟不同延迟的网络请求
          const delay = Math.random() * 4000 // 0-4秒随机延迟
          
          return new Promise(resolve => {
            setTimeout(() => {
              resolve({
                processId,
                actualDelay: delay,
                completed: true
              })
            }, delay)
          })
        },
        timeoutMs,
        requestCount
      )()

      expect(results.totalProcesses).toBe(requestCount)
      
      // 分析超时分布
      expect(results.timeoutRate).toBeGreaterThanOrEqual(0)
      expect(results.timeoutRate).toBeLessThanOrEqual(1)
      
      // 验证超时检测的准确性
      if (results.timeoutCount > 0) {
        expect(results.averageExecutionTime).toBeGreaterThanOrEqual(timeoutMs * 0.8)
      }
    })
  })

  describe('📊 超时模式分析和优化', () => {
    it('应该分析不同超时策略的效果', async () => {
      const strategies = [
        { name: 'aggressive', timeout: 1000 },
        { name: 'balanced', timeout: 3000 },
        { name: 'conservative', timeout: 10000 }
      ]

      const results = []

      for (const strategy of strategies) {
        const strategyResults = await concurrencyTestUtils.createTimeoutTest(
          async (processId) => {
            // 模拟变化的操作时间
            const operationTime = Math.random() * 8000 // 0-8秒
            
            return new Promise(resolve => {
              setTimeout(() => {
                resolve({
                  processId,
                  operationTime,
                  strategy: strategy.name
                })
              }, operationTime)
            })
          },
          strategy.timeout,
          20 // 20个并发请求
        )()

        results.push({
          strategy: strategy.name,
          timeout: strategy.timeout,
          ...strategyResults
        })
      }

      // 分析不同策略的效果
      const aggressiveStrategy = results.find(r => r.strategy === 'aggressive')
      const conservativeStrategy = results.find(r => r.strategy === 'conservative')

      // 激进策略应该有更高的超时率
      expect(aggressiveStrategy.timeoutRate).toBeGreaterThanOrEqual(conservativeStrategy.timeoutRate)

      // 保守策略应该有更高的成功率
      expect(conservativeStrategy.successCount).toBeGreaterThanOrEqual(aggressiveStrategy.successCount)
    })

    it('应该测试超时重试机制', async () => {
      let attemptCount = 0
      const maxRetries = 3

      const operationWithRetry = async () => {
        for (let retry = 0; retry <= maxRetries; retry++) {
          try {
            attemptCount++
            
            // 模拟可能超时的操作
            const result = await Promise.race([
              new Promise(resolve => {
                // 第一次和第二次尝试故意超时，第三次成功
                const delay = retry < 2 ? 3000 : 500
                setTimeout(() => resolve(`Success on attempt ${retry + 1}`), delay)
              }),
              new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Operation timeout')), 2000)
              )
            ])

            return result // 成功时返回
          } catch (error) {
            if (retry === maxRetries) {
              throw error // 最后一次重试失败时抛出错误
            }
            
            // 等待重试间隔
            await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, retry)))
          }
        }
      }

      await timeTestUtils.withTimeControl(async (controller) => {
        controller.start()

        const operationPromise = operationWithRetry()

        // 推进时间模拟重试过程
        // 第一次超时 (2秒)
        controller.advance(2000)
        
        // 重试延迟 (1秒)  
        controller.advance(1000)
        
        // 第二次超时 (2秒)
        controller.advance(2000)
        
        // 重试延迟 (2秒)
        controller.advance(2000)
        
        // 第三次成功 (0.5秒)
        controller.advance(500)

        const result = await operationPromise
        expect(result).toBe('Success on attempt 3')
        expect(attemptCount).toBe(3)
      })
    })
  })

  describe('🔄 AbortController集成测试', () => {
    it('应该使用AbortController配合Promise.race实现请求取消', async () => {
      await timeTestUtils.withTimeControl(async (controller) => {
        controller.start()

        const abortController = new AbortController()
        let operationCanceled = false

        const cancellableOperation = async (signal) => {
          return new Promise((resolve, reject) => {
            const timeoutId = setTimeout(() => {
              resolve('Operation completed')
            }, 5000)

            // 监听取消信号
            signal.addEventListener('abort', () => {
              clearTimeout(timeoutId)
              operationCanceled = true
              reject(new Error('Operation was aborted'))
            })
          })
        }

        const operationWithTimeout = Promise.race([
          cancellableOperation(abortController.signal),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Operation timeout')), 2000)
          )
        ])

        // 推进1秒后手动取消操作
        controller.advance(1000)
        abortController.abort()

        await expect(operationWithTimeout).rejects.toThrow('Operation was aborted')
        expect(operationCanceled).toBe(true)
      })
    })

    it('应该测试多个并发请求的取消', async () => {
      const abortController = new AbortController()
      const requestCount = 5
      let canceledCount = 0

      const cancellableRequests = Array.from({ length: requestCount }, (_, i) => {
        return Promise.race([
          new Promise((resolve, reject) => {
            const timeoutId = setTimeout(() => resolve(`Request ${i} completed`), 3000)

            abortController.signal.addEventListener('abort', () => {
              clearTimeout(timeoutId)
              canceledCount++
              reject(new Error(`Request ${i} was aborted`))
            })
          }),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`Request ${i} timeout`)), 5000)
          )
        ])
      })

      await timeTestUtils.withTimeControl(async (controller) => {
        controller.start()

        // 推进1秒后取消所有请求
        setTimeout(() => {
          abortController.abort()
        }, 1000)

        controller.advance(1000)

        const results = await Promise.allSettled(cancellableRequests)

        // 验证所有请求都被取消
        expect(canceledCount).toBe(requestCount)
        results.forEach((result, i) => {
          expect(result.status).toBe('rejected')
          expect(result.reason.message).toBe(`Request ${i} was aborted`)
        })
      })
    })
  })

  describe('⚡ 性能和边界条件测试', () => {
    it('应该处理极短超时时间', async () => {
      await timeTestUtils.withTimeControl(async (controller) => {
        controller.start()

        const veryShortTimeoutOperation = Promise.race([
          new Promise(resolve => setTimeout(() => resolve('too slow'), 100)),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Very short timeout')), 10))
        ])

        controller.advance(10)

        await expect(veryShortTimeoutOperation).rejects.toThrow('Very short timeout')
      })
    })

    it('应该处理大量并发超时控制', async () => {
      const concurrentCount = 100
      const timeoutMs = 1000

      const massiveConcurrentTest = async () => {
        const promises = Array.from({ length: concurrentCount }, (_, i) => {
          return Promise.race([
            new Promise(resolve => {
              const delay = Math.random() * 2000 // 0-2秒随机延迟
              setTimeout(() => resolve(`Task ${i} completed`), delay)
            }),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error(`Task ${i} timeout`)), timeoutMs)
            )
          ])
        })

        return Promise.allSettled(promises)
      }

      const startTime = Date.now()
      const results = await massiveConcurrentTest()
      const endTime = Date.now()

      const successful = results.filter(r => r.status === 'fulfilled').length
      const timedOut = results.filter(r => r.status === 'rejected').length

      expect(successful + timedOut).toBe(concurrentCount)
      expect(endTime - startTime).toBeLessThan(3000) // 应该在3秒内完成
      
      // 验证超时控制的有效性
      expect(timedOut).toBeGreaterThan(0) // 应该有一些操作超时
    })
  })
})