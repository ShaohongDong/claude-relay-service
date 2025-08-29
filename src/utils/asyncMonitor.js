const logger = require('./logger')

/**
 * Promise 跟踪器
 * 用于跟踪和监控未完成的 Promise 对象
 */
class PromiseTracker {
  constructor() {
    this.promises = new Map()
    this.nextId = 1
    this.stats = {
      created: 0,
      resolved: 0,
      rejected: 0,
      timeout: 0,
      leaked: 0
    }
  }

  /**
   * 跟踪一个 Promise
   */
  track(promise, metadata = {}) {
    const id = this.nextId++
    const created = Date.now()
    
    const trackingInfo = {
      id,
      promise,
      created,
      metadata: {
        stack: new Error().stack,
        ...metadata
      },
      timeoutId: null
    }
    
    this.promises.set(id, trackingInfo)
    this.stats.created++
    
    // 自动清理已完成的 Promise
    promise
      .then(() => {
        this.untrack(id, 'resolved')
      })
      .catch(() => {
        this.untrack(id, 'rejected')
      })
    
    // 设置超时检测
    if (metadata.timeout) {
      trackingInfo.timeoutId = setTimeout(() => {
        this.handleTimeout(id, metadata.timeout)
      }, metadata.timeout)
    }
    
    logger.debug(`📊 Promise tracked: ${id}, total active: ${this.promises.size}`)
    
    return id
  }

  /**
   * 取消跟踪 Promise
   */
  untrack(id, reason = 'unknown') {
    const trackingInfo = this.promises.get(id)
    if (!trackingInfo) {
      return false
    }
    
    // 清除超时定时器
    if (trackingInfo.timeoutId) {
      clearTimeout(trackingInfo.timeoutId)
    }
    
    this.promises.delete(id)
    
    // 更新统计信息
    if (reason === 'resolved') {
      this.stats.resolved++
    } else if (reason === 'rejected') {
      this.stats.rejected++
    }
    
    logger.debug(`📊 Promise untracked: ${id} (${reason}), remaining: ${this.promises.size}`)
    
    return true
  }

  /**
   * 处理 Promise 超时
   */
  handleTimeout(id, timeoutMs) {
    const trackingInfo = this.promises.get(id)
    if (!trackingInfo) {
      return
    }
    
    this.stats.timeout++
    
    logger.warn(`⏰ Promise timeout detected`, {
      id,
      timeout: timeoutMs,
      age: Date.now() - trackingInfo.created,
      metadata: trackingInfo.metadata
    })
    
    // 清理超时的 Promise
    this.untrack(id, 'timeout')
  }

  /**
   * 检测可能的 Promise 泄漏
   */
  detectLeaks(maxAge = 300000) { // 5分钟
    const now = Date.now()
    const leakedPromises = []
    
    for (const [id, trackingInfo] of this.promises) {
      const age = now - trackingInfo.created
      
      if (age > maxAge) {
        leakedPromises.push({
          id,
          age,
          metadata: trackingInfo.metadata
        })
      }
    }
    
    if (leakedPromises.length > 0) {
      this.stats.leaked += leakedPromises.length
      
      logger.error(`🚨 Promise leak detected`, {
        count: leakedPromises.length,
        totalActive: this.promises.size,
        leaks: leakedPromises.slice(0, 5) // 只显示前5个
      })
      
      // 清理泄漏的 Promise
      leakedPromises.forEach(leak => {
        this.untrack(leak.id, 'leaked')
      })
    }
    
    return leakedPromises
  }

  /**
   * 获取当前活跃的 Promise 信息
   */
  getActivePromises() {
    const active = []
    const now = Date.now()
    
    for (const [id, trackingInfo] of this.promises) {
      active.push({
        id,
        age: now - trackingInfo.created,
        metadata: {
          ...trackingInfo.metadata,
          stack: undefined // 不包含堆栈信息，避免过大
        }
      })
    }
    
    return active.sort((a, b) => b.age - a.age) // 按年龄排序
  }

  /**
   * 获取统计信息
   */
  getStats() {
    return {
      active: this.promises.size,
      ...this.stats
    }
  }

  /**
   * 清空所有跟踪的 Promise
   */
  clear() {
    // 清理所有超时定时器
    for (const trackingInfo of this.promises.values()) {
      if (trackingInfo.timeoutId) {
        clearTimeout(trackingInfo.timeoutId)
      }
    }
    
    this.promises.clear()
    this.stats = {
      created: 0,
      resolved: 0,
      rejected: 0,
      timeout: 0,
      leaked: 0
    }
  }
}

/**
 * 资源清理器
 * 管理需要清理的资源，如定时器、事件监听器等
 */
class ResourceCleaner {
  constructor() {
    this.resources = new Map()
    this.nextId = 1
    this.cleanupIntervals = new Set()
  }

  /**
   * 注册需要清理的资源
   */
  register(resource, cleanupFn, metadata = {}) {
    const id = this.nextId++
    const registered = Date.now()
    
    const resourceInfo = {
      id,
      resource,
      cleanupFn,
      registered,
      metadata
    }
    
    this.resources.set(id, resourceInfo)
    
    logger.debug(`🧹 Resource registered: ${id} (${metadata.type || 'unknown'})`)
    
    return id
  }

  /**
   * 清理指定资源
   */
  cleanup(id) {
    const resourceInfo = this.resources.get(id)
    if (!resourceInfo) {
      return false
    }
    
    try {
      if (resourceInfo.cleanupFn) {
        resourceInfo.cleanupFn(resourceInfo.resource)
      }
      
      this.resources.delete(id)
      
      logger.debug(`🧹 Resource cleaned: ${id}`)
      
      return true
    } catch (error) {
      logger.error(`❌ Failed to cleanup resource ${id}:`, error)
      return false
    }
  }

  /**
   * 清理所有资源
   */
  cleanupAll() {
    let cleaned = 0
    let failed = 0
    
    for (const [id] of this.resources) {
      if (this.cleanup(id)) {
        cleaned++
      } else {
        failed++
      }
    }
    
    // 清理定时器
    for (const interval of this.cleanupIntervals) {
      clearInterval(interval)
    }
    this.cleanupIntervals.clear()
    
    logger.info(`🧹 Resource cleanup completed: ${cleaned} cleaned, ${failed} failed`)
    
    return { cleaned, failed }
  }

  /**
   * 自动清理过期资源
   */
  startAutoCleanup(maxAge = 3600000, interval = 300000) { // 1小时过期，5分钟检查一次
    const cleanupInterval = setInterval(() => {
      const now = Date.now()
      const expiredResources = []
      
      for (const [id, resourceInfo] of this.resources) {
        const age = now - resourceInfo.registered
        if (age > maxAge) {
          expiredResources.push(id)
        }
      }
      
      if (expiredResources.length > 0) {
        logger.warn(`🧹 Cleaning up ${expiredResources.length} expired resources`)
        
        for (const id of expiredResources) {
          this.cleanup(id)
        }
      }
    }, interval)
    
    this.cleanupIntervals.add(cleanupInterval)
    
    logger.info(`🧹 Auto cleanup started: maxAge=${maxAge}ms, interval=${interval}ms`)
  }

  /**
   * 获取资源统计信息
   */
  getStats() {
    const now = Date.now()
    const resources = Array.from(this.resources.values())
    
    const stats = {
      total: resources.length,
      byType: {},
      oldestAge: 0,
      avgAge: 0
    }
    
    if (resources.length > 0) {
      const ages = resources.map(r => now - r.registered)
      stats.oldestAge = Math.max(...ages)
      stats.avgAge = ages.reduce((sum, age) => sum + age, 0) / ages.length
      
      // 按类型统计
      resources.forEach(r => {
        const type = r.metadata.type || 'unknown'
        stats.byType[type] = (stats.byType[type] || 0) + 1
      })
    }
    
    return stats
  }
}

/**
 * 异步操作监控器
 * 统一管理 Promise 跟踪、超时处理和资源清理
 */
class AsyncMonitor {
  constructor() {
    this.enabled = process.env.NODE_ENV !== 'test' // 测试环境下默认禁用
    
    this.promiseTracker = new PromiseTracker()
    this.resourceCleaner = new ResourceCleaner()
    
    // 监控配置
    this.config = {
      // Promise 泄漏检测间隔
      leakDetectionInterval: 60000, // 1分钟
      // Promise 最大存活时间
      maxPromiseAge: 300000, // 5分钟
      // 统计信息输出间隔
      statsReportInterval: 300000, // 5分钟
      // 自动清理配置
      autoCleanupEnabled: true,
      resourceMaxAge: 3600000, // 1小时
      resourceCleanupInterval: 300000 // 5分钟
    }
    
    this.intervals = new Set()
    
    if (this.enabled) {
      this.startMonitoring()
    }
  }

  /**
   * 跟踪 Promise（增强版本，支持超时和元数据）
   */
  trackPromise(promise, options = {}) {
    if (!this.enabled) {
      return promise
    }
    
    const metadata = {
      type: options.type || 'generic',
      timeout: options.timeout,
      name: options.name || 'unnamed',
      source: options.source || 'unknown',
      ...options.metadata
    }
    
    this.promiseTracker.track(promise, metadata)
    
    return promise
  }

  /**
   * 创建带超时的 Promise
   */
  withTimeout(promise, timeoutMs, errorMessage = 'Operation timed out') {
    return new Promise((resolve, reject) => {
      let timeoutId
      
      // 设置超时
      if (timeoutMs > 0) {
        timeoutId = setTimeout(() => {
          reject(new Error(`${errorMessage} (${timeoutMs}ms)`))
        }, timeoutMs)
      }
      
      // 注册资源以便清理
      if (timeoutId) {
        this.resourceCleaner.register(
          { timeoutId },
          (resource) => clearTimeout(resource.timeoutId),
          { type: 'timeout', timeout: timeoutMs }
        )
      }
      
      // 处理 Promise 完成
      promise
        .then((result) => {
          if (timeoutId) clearTimeout(timeoutId)
          resolve(result)
        })
        .catch((error) => {
          if (timeoutId) clearTimeout(timeoutId)
          reject(error)
        })
    })
  }

  /**
   * 创建可取消的 Promise
   */
  cancellable(promiseFn) {
    let cancelled = false
    let cancelCallback = null
    
    const promise = new Promise((resolve, reject) => {
      const innerPromise = promiseFn()
      
      innerPromise
        .then((result) => {
          if (!cancelled) resolve(result)
        })
        .catch((error) => {
          if (!cancelled) reject(error)
        })
    })
    
    promise.cancel = (reason = 'cancelled') => {
      cancelled = true
      if (cancelCallback) {
        cancelCallback(reason)
      }
    }
    
    promise.onCancel = (callback) => {
      cancelCallback = callback
    }
    
    return promise
  }

  /**
   * 批量执行 Promise（带并发控制）
   */
  async batch(promiseFactories, concurrency = 10) {
    const results = []
    const executing = []
    
    for (let i = 0; i < promiseFactories.length; i++) {
      // 等待并发槽位可用
      if (executing.length >= concurrency) {
        await Promise.race(executing)
      }
      
      const promiseFactory = promiseFactories[i]
      
      // 执行函数获得Promise并跟踪
      const promise = typeof promiseFactory === 'function' ? promiseFactory() : promiseFactory
      const tracked = this.trackPromise(promise, {
        type: 'batch',
        batchIndex: i,
        batchSize: promiseFactories.length
      })
      
      // 创建包装Promise来处理完成状态
      const wrappedPromise = tracked.then(
        result => {
          // 从执行队列中移除
          const index = executing.indexOf(wrappedPromise)
          if (index > -1) {
            executing.splice(index, 1)
          }
          return result
        },
        error => {
          // 从执行队列中移除
          const index = executing.indexOf(wrappedPromise)
          if (index > -1) {
            executing.splice(index, 1)
          }
          throw error
        }
      )
      
      executing.push(wrappedPromise)
      results.push(tracked)
    }
    
    // 等待所有Promise完成
    return Promise.all(results)
  }

  /**
   * 注册资源清理
   */
  registerResource(resource, cleanupFn, metadata = {}) {
    return this.resourceCleaner.register(resource, cleanupFn, metadata)
  }

  /**
   * 清理资源
   */
  cleanupResource(id) {
    return this.resourceCleaner.cleanup(id)
  }

  /**
   * 开始监控
   */
  startMonitoring() {
    if (this.intervals.size > 0) {
      return // 已经在监控中
    }
    
    // Promise 泄漏检测
    const leakDetection = setInterval(() => {
      this.promiseTracker.detectLeaks(this.config.maxPromiseAge)
    }, this.config.leakDetectionInterval)
    this.intervals.add(leakDetection)
    
    // 定期输出统计信息
    const statsReport = setInterval(() => {
      this.reportStats()
    }, this.config.statsReportInterval)
    this.intervals.add(statsReport)
    
    // 启动资源自动清理
    if (this.config.autoCleanupEnabled) {
      this.resourceCleaner.startAutoCleanup(
        this.config.resourceMaxAge,
        this.config.resourceCleanupInterval
      )
    }
    
    logger.info(`📊 Async monitoring started`)
  }

  /**
   * 停止监控
   */
  stopMonitoring() {
    for (const interval of this.intervals) {
      clearInterval(interval)
    }
    this.intervals.clear()
    
    logger.info(`📊 Async monitoring stopped`)
  }

  /**
   * 输出统计报告
   */
  reportStats() {
    const promiseStats = this.promiseTracker.getStats()
    const resourceStats = this.resourceCleaner.getStats()
    
    if (promiseStats.active > 0 || resourceStats.total > 0) {
      logger.info(`📊 Async Monitor Report:`, {
        promises: promiseStats,
        resources: resourceStats
      })
      
      // 如果有过多活跃 Promise，输出详细信息
      if (promiseStats.active > 50) {
        const activePromises = this.promiseTracker.getActivePromises()
        logger.warn(`⚠️ High active Promise count (${promiseStats.active})`, {
          oldest: activePromises.slice(0, 3) // 显示最老的3个
        })
      }
    }
  }

  /**
   * 获取完整统计信息
   */
  getStats() {
    return {
      enabled: this.enabled,
      config: this.config,
      promises: this.promiseTracker.getStats(),
      resources: this.resourceCleaner.getStats(),
      monitoring: {
        intervalsActive: this.intervals.size
      }
    }
  }

  /**
   * 清理所有资源
   */
  cleanup() {
    this.stopMonitoring()
    
    // 清理所有跟踪的 Promise
    this.promiseTracker.clear()
    
    // 清理所有资源
    this.resourceCleaner.cleanupAll()
    
    logger.info(`🧹 Async monitor cleaned up`)
  }

  /**
   * 配置监控参数
   */
  configure(newConfig) {
    const oldConfig = { ...this.config }
    this.config = { ...this.config, ...newConfig }
    
    // 如果监控间隔改变，重启监控
    if (this.enabled && (
      oldConfig.leakDetectionInterval !== this.config.leakDetectionInterval ||
      oldConfig.statsReportInterval !== this.config.statsReportInterval
    )) {
      this.stopMonitoring()
      this.startMonitoring()
    }
    
    logger.info(`⚙️ Async monitor configured`, this.config)
  }
}

// 创建全局实例
const asyncMonitor = new AsyncMonitor()

// 优雅关闭处理
process.on('SIGTERM', () => {
  asyncMonitor.cleanup()
})

process.on('SIGINT', () => {
  asyncMonitor.cleanup()
})

// 未处理的 Promise rejection 监控
process.on('unhandledRejection', (reason, promise) => {
  logger.error('💥 Unhandled Promise Rejection:', {
    reason: reason,
    promise: promise.toString()
  })
})

module.exports = asyncMonitor