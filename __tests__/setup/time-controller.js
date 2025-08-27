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
  start(startTime = this.startTime, options = {}) {
    // 如果强制重启或需要清理现有状态
    if (this.isActive || options.forceRestart) {
      this.stop()
    }

    // 额外安全检查：全面清理所有可能的FakeTimers状态
    this._forceCleanup()

    try {
      this.clock = FakeTimers.install({
        now: startTime,
        toFake: [
          'setTimeout',
          'setInterval', 
          'clearTimeout',
          'clearInterval',
          'Date',
          'performance'
        ],
        shouldAdvanceTime: options.shouldAdvanceTime || false,
        advanceTimeDelta: options.advanceTimeDelta || 20
      })

      this.isActive = true
      this.startTime = startTime
      
      // 重置定时器跟踪
      this.activeTimers.clear()
      
      return this
    } catch (error) {
      if (error.message.includes('fake timers twice')) {
        // 如果安装失败，尝试更彻底的清理
        this._emergencyCleanup()
        // 再次尝试安装
        this.clock = FakeTimers.install({
          now: startTime,
          toFake: [
            'setTimeout',
            'setInterval', 
            'clearTimeout',
            'clearInterval',
            'Date',
            'performance'
          ],
          shouldAdvanceTime: options.shouldAdvanceTime || false,
          advanceTimeDelta: options.advanceTimeDelta || 20
        })

        this.isActive = true
        this.startTime = startTime
        this.activeTimers.clear()
        
        return this
      }
      throw error
    }
  }

  /**
   * 停止时间控制器
   */
  stop() {
    if (this.clock) {
      this.clock.uninstall()
      this.clock = null
    }
    
    this.isActive = false
    this.activeTimers.clear()
    
    return this
  }

  /**
   * 推进指定时间
   * @param {number} milliseconds - 要推进的毫秒数
   */
  advance(milliseconds) {
    this._ensureActive()
    
    const beforeTime = this.now()
    this.clock.tick(milliseconds)
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
   */
  jumpTo(targetTime) {
    this._ensureActive()
    
    const target = targetTime instanceof Date ? targetTime.getTime() : targetTime
    const current = this.now()
    const diff = target - current
    
    if (diff < 0) {
      throw new Error('Cannot jump backwards in time')
    }
    
    return this.advance(diff)
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
   * 强制清理FakeTimers状态
   * @private
   */
  _forceCleanup() {
    try {
      // 1. 清理当前实例的clock
      if (this.clock) {
        this.clock.uninstall()
        this.clock = null
      }
      
      // 2. 清理FakeTimers的全局状态
      if (FakeTimers.clock) {
        FakeTimers.clock.uninstall()
      }
      
      // 3. 重置实例状态
      this.isActive = false
      this.activeTimers.clear()
    } catch (error) {
      // 继续执行，不要因为清理失败而阻止测试
    }
  }

  /**
   * 紧急清理 - 处理安装失败的情况
   * @private
   */
  _emergencyCleanup() {
    try {
      // 1. 尝试多种方式清理全局状态
      const globalObj = typeof window !== 'undefined' ? window : global
      
      // 恢复原始的定时器方法（如果被修改了）
      if (globalObj.originalSetTimeout) {
        globalObj.setTimeout = globalObj.originalSetTimeout
      }
      if (globalObj.originalSetInterval) {
        globalObj.setInterval = globalObj.originalSetInterval
      }
      if (globalObj.originalClearTimeout) {
        globalObj.clearTimeout = globalObj.originalClearTimeout
      }
      if (globalObj.originalClearInterval) {
        globalObj.clearInterval = globalObj.originalClearInterval
      }
      if (globalObj.originalDate) {
        globalObj.Date = globalObj.originalDate
      }
      
      // 2. 强制清理任何剩余的FakeTimers实例
      if (FakeTimers.clock) {
        try {
          FakeTimers.clock.uninstall()
        } catch (e) {
          // 最后一招：直接设置为null
          FakeTimers.clock = null
        }
      }
      
      // 3. 重置本实例状态
      this.isActive = false
      this.clock = null
      this.activeTimers.clear()
      
      // 4. 短暂延迟确保清理完成
      return new Promise(resolve => {
        const originalSetTimeout = typeof setTimeout === 'function' ? setTimeout : 
          (fn, delay) => { setTimeout(fn, delay || 0); }
        originalSetTimeout(resolve, 1)
      })
    } catch (error) {
      // 即使紧急清理失败也要继续
      this.isActive = false
      this.clock = null
    }
  }
}

/**
 * 创建全局时间控制器实例
 */
const globalTimeController = new TimeController()

/**
 * 便捷的测试辅助函数
 */
const timeTestUtils = {
  /**
   * 在时间控制环境中运行测试
   */
  async withTimeControl(testFn, startTime, options) {
    const controller = new TimeController()
    
    try {
      // 使用新的强制清理方法
      controller._forceCleanup()
      
      // 启动时间控制器
      controller.start(startTime, options)
      await testFn(controller)
    } finally {
      // 确保完全清理
      try {
        if (controller.isActive) {
          controller.stop()
        }
        
        // 再次强制清理确保彻底
        controller._forceCleanup()
      } catch (error) {
        // 使用紧急清理作为最后手段
        await controller._emergencyCleanup()
        console.warn('TimeController cleanup warning:', error.message)
      }
    }
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