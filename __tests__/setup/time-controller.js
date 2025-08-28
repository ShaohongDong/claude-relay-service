// 时间控制测试工具
const FakeTimers = require('@sinonjs/fake-timers')

/**
 * 时间控制器 - 提供测试中的精确时间控制
 * 专门针对项目中的17个定时器和时间敏感操作
 */
class TimeController {
  constructor() {
    this.clock = null
    this.isActive = false
    this.startTime = new Date('2024-01-01T00:00:00Z')
    this.activeTimers = new Map()
  }

  /**
   * 启动时间控制器
   * @param {Date} [startTime] - 起始时间，默认为2024-01-01T00:00:00Z
   * @param {Object} [options] - 配置选项
   */
  async start(startTime = this.startTime, options = {}) {
    // 如果已经激活，先停止
    if (this.isActive) {
      await this.stop()
    }

    // 异步清理，确保完全卸载
    await this._syncCleanup()

    const maxRetries = 3
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        this.clock = FakeTimers.install({
          now: startTime,
          toFake: [
            'setTimeout',
            'setInterval', 
            'clearTimeout',
            'clearInterval',
            'Date'
          ],
          shouldAdvanceTime: false // 简化，不使用自动推进
        })

        this.isActive = true
        this.startTime = startTime
        this.activeTimers.clear()
        
        return this
      } catch (error) {
        if (error.message.includes('fake timers twice') && attempt < maxRetries) {
          console.warn(`TimeController: FakeTimers conflict detected, retry ${attempt}/${maxRetries}`)
          // 等待更长时间让之前的清理完成
          await new Promise(resolve => setTimeout(resolve, 50 * attempt))
          await this._syncCleanup()
          continue
        }
        
        throw new Error(`TimeController start failed after ${maxRetries} attempts: ${error.message}`)
      }
    }
  }

  /**
   * 停止时间控制器
   */
  async stop() {
    if (this.clock) {
      this.clock.uninstall()
      this.clock = null
    }
    
    this.isActive = false
    this.activeTimers.clear()
    
    // 等待清理完成
    await new Promise(resolve => process.nextTick(resolve))
    
    return this
  }

  /**
   * 推进指定时间
   * @param {number} milliseconds - 要推进的毫秒数
   */
  advance(milliseconds) {
    this._ensureActive()
    
    const beforeTime = this.now()
    
    try {
      this.clock.tick(milliseconds)
    } catch (error) {
      console.warn(`TimeController advance warning: ${error.message}`)
    }
    
    const afterTime = this.now()
    
    return {
      advanced: afterTime - beforeTime,
      currentTime: afterTime
    }
  }

  /**
   * 推进到下一个定时器执行时间
   */
  advanceToNextTimer() {
    this._ensureActive()
    
    const beforeTime = this.now()
    const result = this.clock.next()
    const afterTime = this.now()
    
    return {
      advanced: afterTime - beforeTime,
      currentTime: afterTime,
      hasMore: result !== undefined
    }
  }

  /**
   * 推进所有定时器直到队列为空
   * @param {number} [maxSteps=100] - 最大步数，防止无限循环
   */
  runAllTimers(maxSteps = 100) {
    this._ensureActive()
    
    let steps = 0
    let totalAdvanced = 0
    const startTime = this.now()
    
    while (steps < maxSteps && this.clock.countTimers() > 0) {
      const result = this.advanceToNextTimer()
      totalAdvanced += result.advanced
      steps++
      
      if (!result.hasMore) {
        break
      }
    }
    
    return {
      steps,
      totalAdvanced,
      finalTime: this.now(),
      remainingTimers: this.clock.countTimers()
    }
  }

  /**
   * 跳转到特定时间点
   * @param {Date|number} targetTime - 目标时间
   * @param {Object} options - 跳转选项
   * @param {boolean} options.allowBackwards - 是否允许时间回跳（默认false）
   */
  jumpTo(targetTime, options = {}) {
    this._ensureActive()
    
    const target = targetTime instanceof Date ? targetTime.getTime() : targetTime
    const current = this.now()
    const diff = target - current
    
    if (diff < 0 && !options.allowBackwards) {
      throw new Error('Cannot jump backwards in time. Use jumpTo(time, {allowBackwards: true}) to override.')
    }
    
    if (diff < 0) {
      // 时间回跳需要重置时钟
      this.clock.reset()
      this.clock.setSystemTime(target)
      return target
    }
    
    return this.advance(diff)
  }

  /**
   * 重置时间到指定时间点（允许回跳）
   * @param {Date|number} time - 重置到的时间点
   */
  resetTo(time) {
    return this.jumpTo(time, { allowBackwards: true })
  }

  /**
   * 获取当前时间
   */
  now() {
    return this.isActive ? this.clock.now : Date.now()
  }

  /**
   * 获取当前Date对象
   */
  currentDate() {
    return new Date(this.now())
  }

  /**
   * 获取定时器统计信息
   */
  getTimerStats() {
    if (!this.isActive) {
      return { active: false }
    }

    return {
      active: true,
      currentTime: this.now(),
      startTime: this.startTime.getTime(),
      elapsedTime: this.now() - this.startTime.getTime(),
      pendingTimers: this.clock.countTimers(),
      nextTimer: this.getNextTimerInfo()
    }
  }

  /**
   * 获取下一个定时器信息
   */
  getNextTimerInfo() {
    if (!this.isActive) {
      return null
    }

    try {
      // 尝试获取下一个定时器的信息
      const timers = this.clock.getTimers ? this.clock.getTimers() : []
      if (timers.length === 0) {
        return null
      }

      const nextTimer = timers[0]
      return {
        callAt: nextTimer.callAt,
        delay: nextTimer.callAt - this.now(),
        type: nextTimer.type || 'unknown'
      }
    } catch (error) {
      return { error: 'Unable to get timer info' }
    }
  }

  /**
   * 模拟真实时间场景 - 处理项目中的具体定时器
   */
  simulateClaudeServiceTimers() {
    if (!this.isActive) {
      throw new Error('TimeController not active')
    }

    const scenarios = {
      // 2分钟缓存清理 - claudeAccountService
      cacheCleanup2min: () => this.advance(2 * 60 * 1000),
      
      // 10分钟缓存清理 - 各种服务
      cacheCleanup10min: () => this.advance(10 * 60 * 1000),
      
      // 30分钟详细报告 - cacheMonitor
      detailReport30min: () => this.advance(30 * 60 * 1000),
      
      // 1小时清理任务 - app.js
      hourlyCleanup: () => this.advance(60 * 60 * 1000),
      
      // 24小时错误账户清理
      errorAccountCleanup24h: () => this.advance(24 * 60 * 60 * 1000),
      
      // 限流重置（通常1小时）
      rateLimitReset: () => this.advance(60 * 60 * 1000),
      
      // 5秒初始化延迟
      initDelay: () => this.advance(5000),
      
      // 会话映射等待（2秒）
      sessionWait: () => this.advance(2000),
      
      // Gemini轮询（5秒间隔）
      geminiPolling: () => this.advance(5000)
    }

    return scenarios
  }

  /**
   * 创建时间断言辅助函数
   */
  createTimeAssertions() {
    const controller = this
    
    return {
      /**
       * 断言定时器在指定时间内执行
       */
      expectTimerToExecuteIn(callback, expectedMs, tolerance = 100) {
        const startTime = controller.now()
        controller.advance(expectedMs - tolerance)
        
        let executed = false
        const originalCallback = callback
        callback = (...args) => {
          executed = true
          return originalCallback(...args)
        }
        
        controller.advance(tolerance * 2)
        
        if (!executed) {
          throw new Error(`Timer did not execute within ${expectedMs}ms`)
        }
        
        const actualTime = controller.now() - startTime
        if (Math.abs(actualTime - expectedMs) > tolerance) {
          throw new Error(`Timer executed at ${actualTime}ms, expected ${expectedMs}ms`)
        }
      },

      /**
       * 断言在指定时间内没有定时器执行
       */
      expectNoTimersIn(ms) {
        const timersBefore = controller.clock.countTimers()
        controller.advance(ms)
        const timersAfter = controller.clock.countTimers()
        
        if (timersAfter < timersBefore) {
          throw new Error(`Unexpected timer execution within ${ms}ms`)
        }
      },

      /**
       * 断言定时器按预期间隔执行
       */
      expectTimerInterval(intervalMs, executionCount = 3, tolerance = 50) {
        const executions = []
        let count = 0
        
        // Mock the timer callback to track executions
        const trackExecution = () => {
          executions.push(controller.now())
          count++
        }
        
        // Advance through multiple intervals
        for (let i = 0; i < executionCount; i++) {
          controller.advance(intervalMs)
        }
        
        // Verify intervals
        for (let i = 1; i < executions.length; i++) {
          const interval = executions[i] - executions[i-1]
          if (Math.abs(interval - intervalMs) > tolerance) {
            throw new Error(`Timer interval ${interval}ms differs from expected ${intervalMs}ms`)
          }
        }
      }
    }
  }

  /**
   * 私有方法：确保控制器处于活动状态
   */
  _ensureActive() {
    if (!this.isActive) {
      throw new Error('TimeController is not active. Call start() first.')
    }
  }

  /**
   * 强制清理所有FakeTimers状态 - 解决重复安装问题
   * @private
   */
  _syncCleanup() {
    try {
      // 1. 清理当前实例的clock
      if (this.clock) {
        this.clock.uninstall()
        this.clock = null
      }
      
      // 2. 尝试清理可能存在的其他FakeTimers实例
      try {
        // 检查全局是否还有活动的FakeTimers
        const globalTimers = global.setTimeout._isFake || global.setInterval._isFake
        if (globalTimers) {
          // 尝试通过创建临时实例来清理
          const tempClock = FakeTimers.install({ toFake: [] })
          tempClock.uninstall()
        }
      } catch (e) {
        // 忽略临时清理错误
      }
      
      // 3. 重置实例状态
      this.isActive = false
      this.activeTimers.clear()
      
      // 4. 强制等待微任务队列清空
      return new Promise(resolve => {
        process.nextTick(() => {
          setTimeout(resolve, 0)
        })
      })
      
    } catch (error) {
      // 继续执行，不要因为清理失败而阻止测试
      this.isActive = false
      this.clock = null
      this.activeTimers.clear()
      return Promise.resolve()
    }
  }

  /**
   * 安全的测试超时处理
   * @param {Function} testFn - 测试函数
   * @param {number} timeoutMs - 超时时间（毫秒）
   * @return {Promise}
   */
  async withTimeout(testFn, timeoutMs = 30000) {
    this._ensureActive()
    
    return new Promise(async (resolve, reject) => {
      let timeoutId = null
      let completed = false
      
      // 创建超时定时器
      timeoutId = setTimeout(() => {
        if (!completed) {
          completed = true
          reject(new Error(`Test timeout after ${timeoutMs}ms`))
        }
      }, timeoutMs)
      
      try {
        const result = await testFn()
        if (!completed) {
          completed = true
          clearTimeout(timeoutId)
          resolve(result)
        }
      } catch (error) {
        if (!completed) {
          completed = true
          clearTimeout(timeoutId)
          reject(error)
        }
      }
    })
  }

  /**
   * 重置时钟状态
   */
  reset() {
    if (this.isActive) {
      this.clock.reset()
      this.clock.setSystemTime(this.startTime)
    }
  }

}

/**
 * 创建全局时间控制器实例
 */
const globalTimeController = new TimeController()

/**
 * 全局单例控制器，避免多个实例冲突
 */
let globalControllerInstance = null

/**
 * 便捷的测试辅助函数
 */
const timeTestUtils = {
  /**
   * 在时间控制环境中运行测试 - 使用单例模式避免冲突
   */
  async withTimeControl(testFn, startTime, options) {
    // 使用全局单例，避免重复创建
    if (!globalControllerInstance) {
      globalControllerInstance = new TimeController()
    }
    const controller = globalControllerInstance
    
    try {
      // 启动时间控制器（现在是异步的）
      await controller.start(startTime, options)
      
      // 执行测试函数
      const result = await testFn(controller)
      
      return result
    } finally {
      // 异步清理
      try {
        if (controller.isActive) {
          await controller.stop()
        }
      } catch (error) {
        console.warn('TimeController cleanup warning:', error.message)
      }
    }
  },

  /**
   * 重置全局控制器实例 - 用于测试间的完全隔离
   */
  async resetGlobalController() {
    if (globalControllerInstance?.isActive) {
      await globalControllerInstance.stop()
    }
    globalControllerInstance = null
  },

  /**
   * 快速创建时间控制场景
   */
  createTimeScenario(name, setupFn) {
    return {
      name,
      run: async () => {
        return timeTestUtils.withTimeControl(setupFn)
      }
    }
  },

  /**
   * 常用时间常量
   */
  TIME_CONSTANTS: {
    SECOND: 1000,
    MINUTE: 60 * 1000,
    HOUR: 60 * 60 * 1000,
    DAY: 24 * 60 * 60 * 1000,
    WEEK: 7 * 24 * 60 * 60 * 1000
  }
}

module.exports = {
  TimeController,
  globalTimeController,
  timeTestUtils
}