// 测试框架验证 - 确保新的测试基础设施正常工作
const { TimeController, timeTestUtils } = require('../../setup/time-controller')
const { ConcurrencySimulator, concurrencyTestUtils } = require('../../setup/concurrency-simulator')

describe('🧪 测试框架验证', () => {
  describe('⏰ TimeController 基础功能', () => {
    it('应该能够创建和控制时间', async () => {
      const controller = new TimeController()
      
      try {
        await controller.start()
        
        const startTime = controller.now()
        controller.advance(5000) // 推进5秒
        const endTime = controller.now()
        
        expect(endTime - startTime).toBe(5000)
      } finally {
        controller.stop()
      }
    })

    it('应该能够使用withTimeControl工具', async () => {
      let timeAdvanced = false
      
      await timeTestUtils.withTimeControl(async (controller) => {
        const startTime = controller.now()
        controller.advance(1000)
        const endTime = controller.now()
        
        if (endTime - startTime === 1000) {
          timeAdvanced = true
        }
      })
      
      expect(timeAdvanced).toBe(true)
    })

    it('应该正确处理定时器', async () => {
      await timeTestUtils.withTimeControl(async (controller) => {
        let executed = false
        
        setTimeout(() => {
          executed = true
        }, 2000)
        
        // 推进1999ms，不应该执行
        controller.advance(1999)
        expect(executed).toBe(false)
        
        // 推进1ms，应该执行
        controller.advance(1)
        expect(executed).toBe(true)
      })
    })
  })

  describe('🔄 ConcurrencySimulator 基础功能', () => {
    it('应该能够创建并发模拟器', () => {
      const simulator = new ConcurrencySimulator()
      expect(simulator.isRunning).toBe(false)
      expect(simulator.processCount).toBe(0)
    })

    it('应该能够运行并发任务', async () => {
      const simulator = new ConcurrencySimulator()
      
      try {
        const processes = [
          { id: 'task1', taskFn: async () => 'result1' },
          { id: 'task2', taskFn: async () => 'result2' },
          { id: 'task3', taskFn: async () => 'result3' }
        ]

        const results = await simulator.runConcurrent(processes, {
          maxConcurrency: 3,
          waitForAll: true
        })

        expect(results.successful).toBe(3)
        expect(results.failed).toBe(0)
        expect(results.totalProcesses).toBe(3)
      } finally {
        simulator.reset()
      }
    })

    it('应该能够模拟锁竞争', async () => {
      const results = await concurrencyTestUtils.createLockCompetitionTest(
        'test-lock',
        3,
        async (processId) => {
          // 模拟简单的工作负载
          await new Promise(resolve => setTimeout(resolve, 10))
          return { processId, completed: true }
        }
      )()

      expect(results.lockAcquisitions).toBeGreaterThan(0)
      expect(results.totalProcesses).toBe(3)
    })
  })

  describe('🔒 RedisMock 分布式锁功能', () => {
    it('应该支持 SET NX 操作', async () => {
      const redis = global.testRedisInstance
      
      // 第一次设置应该成功
      const result1 = await redis.set('lock-key', 'lock-value', 'NX')
      expect(result1).toBe('OK')
      
      // 第二次设置应该失败（键已存在）
      const result2 = await redis.set('lock-key', 'other-value', 'NX')
      expect(result2).toBeNull()
      
      // 验证值
      const value = await redis.get('lock-key')
      expect(value).toBe('lock-value')
      
      // 清理
      await redis.del('lock-key')
    })

    it('应该支持 SET NX EX 操作（带TTL的分布式锁）', async () => {
      const redis = global.testRedisInstance
      
      // 设置带TTL的锁
      const result = await redis.set('timed-lock', 'lock-value', 'NX', 'EX', 60)
      expect(result).toBe('OK')
      
      // 验证TTL
      const ttl = await redis.ttl('timed-lock')
      expect(ttl).toBeGreaterThan(0)
      expect(ttl).toBeLessThanOrEqual(60)
      
      // 清理
      await redis.del('timed-lock')
    })

    it('应该支持 Lua 脚本执行', async () => {
      const redis = global.testRedisInstance
      
      // 设置一个锁
      await redis.set('script-lock', 'unique-id-123', 'NX', 'EX', 60)
      
      // 使用Lua脚本条件性地删除锁
      const script = `
        if redis.call("get", KEYS[1]) == ARGV[1] then
          return redis.call("del", KEYS[1])
        else
          return 0
        end
      `
      
      // 正确的值应该能删除
      const result1 = await redis.eval(script, 1, 'script-lock', 'unique-id-123')
      expect(result1).toBe(1)
      
      // 验证锁已被删除
      const value = await redis.get('script-lock')
      expect(value).toBeNull()
      
      // 再次尝试删除应该返回0
      const result2 = await redis.eval(script, 1, 'script-lock', 'unique-id-123')
      expect(result2).toBe(0)
    })
  })

  describe('🎯 集成验证', () => {
    it('应该能够组合使用时间控制和并发模拟', async () => {
      await timeTestUtils.withTimeControl(async (timeController) => {
        const simulator = new ConcurrencySimulator()
        
        try {
          let executionCount = 0
          
          const processes = [
            {
              id: 'timed-task-1',
              taskFn: async () => {
                return new Promise(resolve => {
                  setTimeout(() => {
                    executionCount++
                    resolve(`Task completed at ${timeController.now()}`)
                  }, 1000)
                })
              }
            },
            {
              id: 'timed-task-2', 
              taskFn: async () => {
                return new Promise(resolve => {
                  setTimeout(() => {
                    executionCount++
                    resolve(`Task completed at ${timeController.now()}`)
                  }, 2000)
                })
              }
            }
          ]

          // 启动并发任务（不等待完成）
          const resultsPromise = simulator.runConcurrent(processes, {
            maxConcurrency: 2,
            waitForAll: false
          })
          
          // 给异步操作一个机会开始
          await new Promise(resolve => setImmediate(resolve))

          // 推进时间让任务完成
          timeController.advance(1000) // 第一个任务完成
          
          // 给定时器回调执行的机会
          await new Promise(resolve => setImmediate(resolve))
          expect(executionCount).toBe(1)
          
          timeController.advance(1000) // 第二个任务完成
          
          // 再次给回调执行机会
          await new Promise(resolve => setImmediate(resolve))
          expect(executionCount).toBe(2)

          const results = await resultsPromise
          expect(results.successful).toBe(2)
        } finally {
          simulator.reset()
        }
      })
    })

    it('应该能够模拟真实的分布式锁超时场景', async () => {
      await timeTestUtils.withTimeControl(async (timeController) => {
        const redis = global.testRedisInstance
        
        // 设置一个会过期的锁
        await redis.set('expiring-lock', 'holder-1', 'NX', 'EX', 10) // 10秒TTL
        
        // 验证锁存在
        let lockValue = await redis.get('expiring-lock')
        expect(lockValue).toBe('holder-1')
        
        // 推进时间到9秒，锁应该还在
        timeController.advance(9000)
        lockValue = await redis.get('expiring-lock')
        expect(lockValue).toBe('holder-1')
        
        // 推进时间到11秒，锁应该过期
        timeController.advance(2000)
        lockValue = await redis.get('expiring-lock')
        expect(lockValue).toBeNull()
        
        // 现在另一个进程应该能获取锁
        const newLockResult = await redis.set('expiring-lock', 'holder-2', 'NX', 'EX', 10)
        expect(newLockResult).toBe('OK')
      })
    })
  })
})