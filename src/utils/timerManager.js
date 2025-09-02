const logger = require('./logger')

/**
 * 全局定时器管理器
 * 统一管理和清理所有系统定时器，防止restart时的资源泄漏
 */
class TimerManager {
  constructor() {
    this.timers = new Map() // timerId -> { id, type, interval, timeout, callback, metadata }
    this.intervals = new Map() // intervalId -> timerId
    this.timeouts = new Map() // timeoutId -> timerId
    this.stats = {
      totalCreated: 0,
      totalCleared: 0,
      activeTimers: 0
    }
    this.isCleanupRegistered = false

    logger.info('⏲️ 全局定时器管理器已创建')
    this.setupProcessExitHandlers()
  }

  /**
   * 注册定时器（setInterval的包装）
   */
  setInterval(callback, interval, metadata = {}) {
    if (typeof callback !== 'function') {
      throw new Error('Callback must be a function')
    }
    if (typeof interval !== 'number' || interval <= 0) {
      throw new Error('Interval must be a positive number')
    }

    const timerId = this.generateTimerId('interval')

    try {
      const intervalId = setInterval(callback, interval)

      const timerInfo = {
        id: timerId,
        type: 'interval',
        interval,
        intervalId,
        callback,
        metadata: {
          name: metadata.name || 'unnamed',
          description: metadata.description || '',
          service: metadata.service || 'unknown',
          createdAt: Date.now(),
          ...metadata
        }
      }

      this.timers.set(timerId, timerInfo)
      this.intervals.set(intervalId, timerId)
      this.stats.totalCreated++
      this.stats.activeTimers++

      logger.debug(`⏲️ 定时器已注册: ${timerId} (${timerInfo.metadata.name}) - 间隔: ${interval}ms`)

      return { timerId, intervalId }
    } catch (error) {
      logger.error(`❌ 注册定时器失败: ${error.message}`)
      throw error
    }
  }

  /**
   * 注册超时定时器（setTimeout的包装）
   */
  setTimeout(callback, timeout, metadata = {}) {
    if (typeof callback !== 'function') {
      throw new Error('Callback must be a function')
    }
    if (typeof timeout !== 'number' || timeout < 0) {
      throw new Error('Timeout must be a non-negative number')
    }

    const timerId = this.generateTimerId('timeout')

    try {
      const timeoutId = setTimeout(() => {
        // 执行回调后自动清理（使用静默模式避免重复清理警告）
        try {
          callback()
        } finally {
          this.clearTimer(timerId, true) // 静默清理，避免重复清理警告
        }
      }, timeout)

      const timerInfo = {
        id: timerId,
        type: 'timeout',
        timeout,
        timeoutId,
        callback,
        metadata: {
          name: metadata.name || 'unnamed',
          description: metadata.description || '',
          service: metadata.service || 'unknown',
          createdAt: Date.now(),
          ...metadata
        }
      }

      this.timers.set(timerId, timerInfo)
      this.timeouts.set(timeoutId, timerId)
      this.stats.totalCreated++
      this.stats.activeTimers++

      logger.debug(
        `⏲️ 超时定时器已注册: ${timerId} (${timerInfo.metadata.name}) - 超时: ${timeout}ms`
      )

      return { timerId, timeoutId }
    } catch (error) {
      logger.error(`❌ 注册超时定时器失败: ${error.message}`)
      throw error
    }
  }

  /**
   * 清理指定定时器
   * @param {string} timerId - 定时器ID
   * @param {boolean} silent - 静默模式，不记录不存在的警告
   */
  clearTimer(timerId, silent = false) {
    const timer = this.timers.get(timerId)
    if (!timer) {
      if (!silent) {
        logger.warn(`⚠️ 定时器不存在: ${timerId}`)
      }
      return false
    }

    try {
      if (timer.type === 'interval') {
        clearInterval(timer.intervalId)
        this.intervals.delete(timer.intervalId)
      } else if (timer.type === 'timeout') {
        clearTimeout(timer.timeoutId)
        this.timeouts.delete(timer.timeoutId)
      }

      this.timers.delete(timerId)
      this.stats.totalCleared++
      this.stats.activeTimers--

      logger.debug(`⏲️ 定时器已清理: ${timerId} (${timer.metadata.name})`)
      return true
    } catch (error) {
      logger.error(`❌ 清理定时器失败: ${timerId} - ${error.message}`)
      return false
    }
  }

  /**
   * 安全清理定时器（用于外部调用，自动处理重复清理）
   * @param {string} timerId - 定时器ID
   * @returns {boolean} 是否成功清理
   */
  safeCleanTimer(timerId) {
    return this.clearTimer(timerId, true) // 使用静默模式
  }

  /**
   * 按服务清理定时器
   */
  clearTimersByService(serviceName) {
    const timersToClean = []

    for (const [timerId, timer] of this.timers) {
      if (timer.metadata.service === serviceName) {
        timersToClean.push(timerId)
      }
    }

    let clearedCount = 0
    for (const timerId of timersToClean) {
      if (this.clearTimer(timerId, true)) {
        // 使用静默模式避免批量清理时的警告
        clearedCount++
      }
    }

    logger.info(`⏲️ 服务定时器清理完成: ${serviceName} (${clearedCount}/${timersToClean.length})`)
    return clearedCount
  }

  /**
   * 清理所有定时器
   */
  clearAllTimers() {
    logger.info(`⏲️ 开始清理所有定时器 (${this.timers.size} 个)...`)

    let clearedIntervals = 0
    let clearedTimeouts = 0
    let errors = 0

    // 清理所有interval
    for (const [intervalId, timerId] of this.intervals) {
      try {
        clearInterval(intervalId)
        clearedIntervals++
      } catch (error) {
        errors++
        logger.warn(`⚠️ 清理interval失败: ${intervalId} - ${error.message}`)
      }
    }

    // 清理所有timeout
    for (const [timeoutId, timerId] of this.timeouts) {
      try {
        clearTimeout(timeoutId)
        clearedTimeouts++
      } catch (error) {
        errors++
        logger.warn(`⚠️ 清理timeout失败: ${timeoutId} - ${error.message}`)
      }
    }

    // 更新统计信息
    this.stats.totalCleared += clearedIntervals + clearedTimeouts
    this.stats.activeTimers = 0

    // 清空所有映射
    this.timers.clear()
    this.intervals.clear()
    this.timeouts.clear()

    logger.success(
      `✅ 所有定时器已清理: interval ${clearedIntervals}, timeout ${clearedTimeouts}, 错误 ${errors}`
    )

    return {
      intervals: clearedIntervals,
      timeouts: clearedTimeouts,
      errors,
      total: clearedIntervals + clearedTimeouts
    }
  }

  /**
   * 获取定时器状态
   */
  getStatus() {
    const timersByService = new Map()
    const timersByType = { interval: 0, timeout: 0 }

    for (const timer of this.timers.values()) {
      // 按服务分组
      const { service } = timer.metadata
      if (!timersByService.has(service)) {
        timersByService.set(service, { interval: 0, timeout: 0, timers: [] })
      }
      timersByService.get(service)[timer.type]++
      timersByService.get(service).timers.push({
        id: timer.id,
        name: timer.metadata.name,
        type: timer.type,
        createdAt: timer.metadata.createdAt
      })

      // 按类型统计
      timersByType[timer.type]++
    }

    return {
      stats: { ...this.stats },
      activeTimers: this.timers.size,
      byType: timersByType,
      byService: Object.fromEntries(timersByService),
      totalMaps: {
        timers: this.timers.size,
        intervals: this.intervals.size,
        timeouts: this.timeouts.size
      }
    }
  }

  /**
   * 获取详细的定时器列表
   */
  getTimerList() {
    const timerList = []

    for (const timer of this.timers.values()) {
      timerList.push({
        id: timer.id,
        type: timer.type,
        name: timer.metadata.name,
        service: timer.metadata.service,
        description: timer.metadata.description,
        createdAt: timer.metadata.createdAt,
        uptime: Date.now() - timer.metadata.createdAt,
        interval: timer.interval,
        timeout: timer.timeout
      })
    }

    return timerList.sort((a, b) => a.createdAt - b.createdAt)
  }

  /**
   * 生成唯一的定时器ID
   */
  generateTimerId(type) {
    const timestamp = Date.now()
    const random = Math.random().toString(36).substring(2, 8)
    return `timer_${type}_${timestamp}_${random}`
  }

  /**
   * 设置进程退出处理器
   */
  setupProcessExitHandlers() {
    if (this.isCleanupRegistered) {
      return
    }

    const exitHandler = (eventType) => {
      logger.info(`📤 定时器管理器接收到 ${eventType} 事件，清理所有定时器`)
      this.clearAllTimers()
    }

    // 使用once避免重复注册
    process.once('exit', () => exitHandler('exit'))
    process.once('SIGINT', () => exitHandler('SIGINT'))
    process.once('SIGTERM', () => exitHandler('SIGTERM'))
    process.once('SIGHUP', () => exitHandler('SIGHUP'))

    this.isCleanupRegistered = true
    logger.info('✅ 定时器管理器进程退出处理器已初始化')
  }

  /**
   * 健康检查
   */
  healthCheck() {
    const status = this.getStatus()
    const now = Date.now()

    // 检查是否有过期的timeout（可能泄漏）
    let suspiciousTimeouts = 0
    for (const timer of this.timers.values()) {
      if (timer.type === 'timeout') {
        const age = now - timer.metadata.createdAt
        if (age > timer.timeout * 2) {
          // 如果存在时间超过预期timeout的2倍
          suspiciousTimeouts++
        }
      }
    }

    return {
      healthy: true,
      activeTimers: status.activeTimers,
      stats: status.stats,
      suspiciousTimeouts,
      timestamp: new Date().toISOString()
    }
  }
}

// 创建全局单例实例
const globalTimerManager = new TimerManager()

module.exports = globalTimerManager
