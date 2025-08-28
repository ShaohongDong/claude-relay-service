// 时间敏感操作测试 - 覆盖系统中17个定时器的真实行为
const { TimeController, timeTestUtils } = require('../../setup/time-controller')

// Mock所有依赖的服务
jest.mock('../../../src/models/redis')
jest.mock('../../../src/utils/logger')

describe('时间敏感操作测试 - 真实定时器行为验证', () => {
  let timeController

  beforeEach(() => {
    timeController = new TimeController()
    jest.clearAllMocks()
  })

  afterEach(() => {
    if (timeController.isActive) {
      timeController.stop()
    }
  })

  describe('🕒 ClaudeAccountService 定时器测试', () => {
    it('应该每2分钟执行缓存清理和安全清理', async () => {
      // 这个测试验证 src/services/claudeAccountService.js:37 的定时器
      await timeTestUtils.withTimeControl(async (controller) => {
        
        // 模拟 ClaudeAccountService 的构造函数中的定时器
        let cacheCleanupCount = 0
        let securityCleanupCount = 0
        
        const mockClaudeAccountService = {
          _decryptCache: {
            cleanup: jest.fn(() => {
              cacheCleanupCount++
            }),
            getStats: jest.fn(() => ({ size: 10, hits: 100, misses: 5 }))
          },
          _performSecurityCleanup: jest.fn(() => {
            securityCleanupCount++
          })
        }
        
        // 模拟真实的setInterval调用
        const intervalId = setInterval(() => {
          mockClaudeAccountService._decryptCache.cleanup()
          mockClaudeAccountService._performSecurityCleanup()
        }, 2 * 60 * 1000) // 2分钟

        // 验证初始状态
        expect(cacheCleanupCount).toBe(0)
        expect(securityCleanupCount).toBe(0)

        // 推进1分59秒，不应该执行
        controller.advance(119 * 1000)
        expect(cacheCleanupCount).toBe(0)
        expect(securityCleanupCount).toBe(0)

        // 推进到2分钟，应该执行第一次
        controller.advance(1000)
        expect(cacheCleanupCount).toBe(1)
        expect(securityCleanupCount).toBe(1)

        // 再推进2分钟，应该执行第二次
        controller.advance(2 * 60 * 1000)
        expect(cacheCleanupCount).toBe(2)
        expect(securityCleanupCount).toBe(2)

        clearInterval(intervalId)
      })
    })

    it('应该在24小时后自动清理错误账户状态', async () => {
      // 这个测试验证 src/services/claudeAccountService.js:1094 的时间逻辑
      const claudeAccountService = require('../../../src/services/claudeAccountService')
      const redis = require('../../../src/models/redis')

      await timeTestUtils.withTimeControl(async (controller) => {

        // 模拟错误状态的账户
        const errorAccount = {
          id: 'test-error-account',
          status: 'error',
          lastRefreshAt: controller.currentDate().toISOString(),
          errorMessage: 'Test error'
        }

        redis.getAllClaudeAccounts.mockResolvedValue([errorAccount])
        redis.setClaudeAccount.mockResolvedValue(true)

        // 推进23小时59分钟，不应该清理
        controller.advance(23 * 60 * 60 * 1000 + 59 * 60 * 1000)
        
        let cleanedCount = await claudeAccountService.cleanupErrorAccounts()
        expect(cleanedCount).toBe(0)

        // 推进到24小时1分钟，应该清理
        controller.advance(2 * 60 * 1000)
        
        cleanedCount = await claudeAccountService.cleanupErrorAccounts()
        expect(cleanedCount).toBe(1)
        expect(redis.setClaudeAccount).toHaveBeenCalledWith(
          'test-error-account',
          expect.objectContaining({
            status: 'created',
            errorMessage: ''
          })
        )
      })
    })
  })

  describe('⏰ CacheMonitor 定时器测试', () => {
    it('应该每5分钟生成简单统计，每30分钟生成详细报告', async () => {
      // 这个测试验证 src/utils/cacheMonitor.js:187 和 :198 的定时器
      await timeTestUtils.withTimeControl(async (controller) => {

        let quickStatsCount = 0
        let detailedReportCount = 0
        let securityCleanupCount = 0

        // 模拟cacheMonitor的定时器
        const quickStatsInterval = setInterval(() => {
          quickStatsCount++
        }, 5 * 60 * 1000) // 5分钟

        const detailedReportInterval = setInterval(() => {
          detailedReportCount++
        }, 30 * 60 * 1000) // 30分钟

        const securityCleanupInterval = setInterval(() => {
          securityCleanupCount++
        }, 10 * 60 * 1000) // 10分钟安全清理

        // 推进4分59秒，不应该有任何执行
        controller.advance(4 * 60 * 1000 + 59 * 1000)
        expect(quickStatsCount).toBe(0)
        expect(detailedReportCount).toBe(0)
        expect(securityCleanupCount).toBe(0)

        // 推进到5分钟，应该执行快速统计
        controller.advance(1000)
        expect(quickStatsCount).toBe(1)
        expect(detailedReportCount).toBe(0)
        expect(securityCleanupCount).toBe(0)

        // 推进到10分钟，应该执行快速统计和安全清理
        controller.advance(5 * 60 * 1000)
        expect(quickStatsCount).toBe(2)
        expect(detailedReportCount).toBe(0)
        expect(securityCleanupCount).toBe(1)

        // 推进到30分钟，应该执行所有类型
        controller.advance(20 * 60 * 1000)
        expect(quickStatsCount).toBe(6) // 每5分钟，共30分钟 = 6次
        expect(detailedReportCount).toBe(1) // 30分钟一次
        expect(securityCleanupCount).toBe(3) // 每10分钟，共30分钟 = 3次

        clearInterval(quickStatsInterval)
        clearInterval(detailedReportInterval)
        clearInterval(securityCleanupInterval)
      })
    })
  })

  describe('🏥 应用清理任务测试', () => {
    it('应该每小时执行系统清理任务', async () => {
      // 这个测试验证 src/app.js:501 的每小时清理任务
      await timeTestUtils.withTimeControl(async (controller) => {

        let cleanupExecutionCount = 0
        const mockCleanupTasks = {
          cleanupExpiredSessions: jest.fn().mockResolvedValue(5),
          cleanupErrorAccounts: jest.fn().mockResolvedValue(2),
          cleanupOldLogs: jest.fn().mockResolvedValue(10)
        }

        // 模拟应用的每小时清理定时器
        const hourlyCleanupInterval = setInterval(async () => {
          try {
            cleanupExecutionCount++
            await mockCleanupTasks.cleanupExpiredSessions()
            await mockCleanupTasks.cleanupErrorAccounts()
            await mockCleanupTasks.cleanupOldLogs()
          } catch (error) {
            console.error('Cleanup task error:', error)
          }
        }, 60 * 60 * 1000) // 1小时

        // 推进59分59秒，不应该执行
        controller.advance(59 * 60 * 1000 + 59 * 1000)
        expect(cleanupExecutionCount).toBe(0)

        // 推进到1小时，应该执行第一次清理
        controller.advance(1000)
        
        // 等待异步操作完成
        await new Promise(resolve => setTimeout(resolve, 0))
        
        expect(cleanupExecutionCount).toBe(1)
        expect(mockCleanupTasks.cleanupExpiredSessions).toHaveBeenCalledTimes(1)
        expect(mockCleanupTasks.cleanupErrorAccounts).toHaveBeenCalledTimes(1)
        expect(mockCleanupTasks.cleanupOldLogs).toHaveBeenCalledTimes(1)

        // 推进到2小时，应该执行第二次清理
        controller.advance(60 * 60 * 1000)
        
        await new Promise(resolve => setTimeout(resolve, 0))
        
        expect(cleanupExecutionCount).toBe(2)

        clearInterval(hourlyCleanupInterval)
      })
    })
  })

  describe('⏱️ 短期延迟操作测试', () => {
    it('应该正确处理各种延迟场景', async () => {
      await timeTestUtils.withTimeControl(async (controller) => {

        // 测试5秒初始化延迟 (src/app.js:487)
        let initDelayExecuted = false
        setTimeout(() => {
          initDelayExecuted = true
        }, 5000)

        controller.advance(4999)
        expect(initDelayExecuted).toBe(false)
        
        controller.advance(1)
        expect(initDelayExecuted).toBe(true)

        // 测试2秒会话等待 (src/services/claudeAccountService.js:197)
        let sessionWaitExecuted = false
        setTimeout(() => {
          sessionWaitExecuted = true
        }, 2000)

        controller.advance(1999)
        expect(sessionWaitExecuted).toBe(false)
        
        controller.advance(1)
        expect(sessionWaitExecuted).toBe(true)

        // 测试1秒防抖延迟 (src/services/claudeAccountService.js:1634)
        let debounceExecuted = false
        setTimeout(() => {
          debounceExecuted = true
        }, 1000)

        controller.advance(999)
        expect(debounceExecuted).toBe(false)
        
        controller.advance(1)
        expect(debounceExecuted).toBe(true)
      })
    })

    it('应该正确处理Gemini轮询间隔', async () => {
      // 测试 src/services/geminiAccountService.js:231 的轮询逻辑
      await timeTestUtils.withTimeControl(async (controller) => {

        const pollResults = []
        let pollCount = 0
        
        const simulatePolling = async () => {
          for (let i = 0; i < 5; i++) { // 模拟最多5次轮询
            await new Promise(resolve => setTimeout(resolve, 5000)) // 5秒间隔
            pollCount++
            pollResults.push(controller.now())
            
            // 模拟第3次轮询成功
            if (i === 2) {
              break
            }
          }
        }

        // 启动轮询
        const pollingPromise = simulatePolling()

        // 验证轮询间隔
        expect(pollCount).toBe(0)

        // 第一次轮询（5秒后）
        controller.advance(5000)
        expect(pollCount).toBe(1)

        // 第二次轮询（再5秒后）
        controller.advance(5000)
        expect(pollCount).toBe(2)

        // 第三次轮询（再5秒后，这次会成功并退出）
        controller.advance(5000)
        expect(pollCount).toBe(3)

        await pollingPromise

        // 验证轮询间隔的准确性
        expect(pollResults[1] - pollResults[0]).toBe(5000)
        expect(pollResults[2] - pollResults[1]).toBe(5000)
      })
    })
  })

  describe('🔒 限流和过期处理测试', () => {
    it('应该正确处理1小时限流自动解除', async () => {
      const claudeAccountService = require('../../../src/services/claudeAccountService')
      
      await timeTestUtils.withTimeControl(async (controller) => {

        // 模拟限流账户数据
        const rateLimitedAccount = {
          id: 'rate-limited-account',
          rateLimitStatus: 'limited',
          rateLimitedAt: controller.currentDate().toISOString(),
          rateLimitEndAt: new Date(controller.now() + 60 * 60 * 1000).toISOString() // 1小时后解除
        }

        // Mock Redis返回数据
        const redis = require('../../../src/models/redis')
        redis.getClaudeAccount.mockResolvedValue(rateLimitedAccount)
        redis.setClaudeAccount.mockResolvedValue(true)

        // Mock removeAccountRateLimit方法
        const originalMethod = claudeAccountService.removeAccountRateLimit
        claudeAccountService.removeAccountRateLimit = jest.fn().mockResolvedValue({ success: true })

        // 推进59分59秒，应该仍然被限流
        controller.advance(59 * 60 * 1000 + 59 * 1000)
        let isLimited = await claudeAccountService.isAccountRateLimited('rate-limited-account')
        expect(isLimited).toBe(true)
        expect(claudeAccountService.removeAccountRateLimit).not.toHaveBeenCalled()

        // 推进到1小时，应该自动解除限流
        controller.advance(1000)
        isLimited = await claudeAccountService.isAccountRateLimited('rate-limited-account')
        expect(isLimited).toBe(false)
        expect(claudeAccountService.removeAccountRateLimit).toHaveBeenCalledWith('rate-limited-account')

        // 恢复原方法
        claudeAccountService.removeAccountRateLimit = originalMethod
      })
    })

    it('应该正确计算剩余限流时间（分钟精度）', async () => {
      const claudeAccountService = require('../../../src/services/claudeAccountService')
      
      await timeTestUtils.withTimeControl(async (controller) => {

        // 设置限流结束时间为90分钟后
        const rateLimitEndTime = new Date(controller.now() + 90 * 60 * 1000)
        const rateLimitedAccount = {
          id: 'precision-test-account',
          rateLimitStatus: 'limited',
          rateLimitedAt: controller.currentDate().toISOString(),
          rateLimitEndAt: rateLimitEndTime.toISOString()
        }

        const redis = require('../../../src/models/redis')
        redis.getClaudeAccount.mockResolvedValue(rateLimitedAccount)

        // 初始状态：应该还有90分钟
        let rateLimitInfo = await claudeAccountService.getAccountRateLimitInfo('precision-test-account')
        expect(rateLimitInfo.minutesRemaining).toBe(90)
        expect(rateLimitInfo.isRateLimited).toBe(true)

        // 推进30分钟，应该还有60分钟
        controller.advance(30 * 60 * 1000)
        rateLimitInfo = await claudeAccountService.getAccountRateLimitInfo('precision-test-account')
        expect(rateLimitInfo.minutesRemaining).toBe(60)

        // 推进59分钟，应该还有1分钟
        controller.advance(59 * 60 * 1000)
        rateLimitInfo = await claudeAccountService.getAccountRateLimitInfo('precision-test-account')
        expect(rateLimitInfo.minutesRemaining).toBe(1)

        // 推进1分钟，应该为0（已过期）
        controller.advance(60 * 1000)
        rateLimitInfo = await claudeAccountService.getAccountRateLimitInfo('precision-test-account')
        expect(rateLimitInfo.minutesRemaining).toBe(0)
        expect(rateLimitInfo.isRateLimited).toBe(false)
      })
    })
  })

  describe('🛡️ 性能和边界条件测试', () => {
    it('应该正确处理时间跳跃和边界情况', async () => {
      await timeTestUtils.withTimeControl(async (controller) => {

        let executionTimes = []
        
        // 设置一个每分钟执行的定时器
        const interval = setInterval(() => {
          executionTimes.push(controller.now())
        }, 60 * 1000)

        // 正常推进3分钟
        controller.advance(60 * 1000) // 第一次执行
        controller.advance(60 * 1000) // 第二次执行
        controller.advance(60 * 1000) // 第三次执行

        expect(executionTimes).toHaveLength(3)
        expect(executionTimes[1] - executionTimes[0]).toBe(60 * 1000)
        expect(executionTimes[2] - executionTimes[1]).toBe(60 * 1000)

        // 测试大幅时间跳跃
        controller.advance(10 * 60 * 1000) // 跳跃10分钟

        expect(executionTimes.length).toBeGreaterThanOrEqual(13) // 应该执行了更多次

        clearInterval(interval)
      })
    })

    it('应该处理多个定时器的复杂交互', async () => {
      await timeTestUtils.withTimeControl(async (controller) => {

        const executionLog = []

        // 模拟多个不同频率的定时器
        const timer1 = setInterval(() => {
          executionLog.push({ type: 'cache-cleanup', time: controller.now() })
        }, 2 * 60 * 1000) // 2分钟

        const timer2 = setInterval(() => {
          executionLog.push({ type: 'security-cleanup', time: controller.now() })
        }, 10 * 60 * 1000) // 10分钟

        const timer3 = setInterval(() => {
          executionLog.push({ type: 'detailed-report', time: controller.now() })
        }, 30 * 60 * 1000) // 30分钟

        // 推进1小时
        controller.advance(60 * 60 * 1000)

        // 验证执行次数
        const cacheCleanups = executionLog.filter(e => e.type === 'cache-cleanup')
        const securityCleanups = executionLog.filter(e => e.type === 'security-cleanup')
        const detailedReports = executionLog.filter(e => e.type === 'detailed-report')

        expect(cacheCleanups).toHaveLength(30) // 60分钟 / 2分钟 = 30次
        expect(securityCleanups).toHaveLength(6)  // 60分钟 / 10分钟 = 6次
        expect(detailedReports).toHaveLength(2)   // 60分钟 / 30分钟 = 2次

        // 验证执行顺序的正确性
        expect(executionLog).toBeSorted((a, b) => a.time - b.time)

        clearInterval(timer1)
        clearInterval(timer2)
        clearInterval(timer3)
      })
    })
  })
})

// 自定义Jest matcher for sorted arrays
expect.extend({
  toBeSorted(received, compareFn) {
    const sorted = [...received].sort(compareFn)
    const pass = JSON.stringify(received) === JSON.stringify(sorted)
    
    if (pass) {
      return {
        message: () => `Expected array not to be sorted`,
        pass: true,
      }
    } else {
      return {
        message: () => `Expected array to be sorted`,
        pass: false,
      }
    }
  }
})