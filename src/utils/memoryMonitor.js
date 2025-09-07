const logger = require('./logger')

/**
 * 内存监控和GC优化系统
 * 功能：
 * - 实时内存使用监控
 * - 智能垃圾回收触发
 * - 内存泄漏检测
 * - 性能统计和报告
 */
class MemoryMonitor {
  constructor() {
    this.isMonitoring = false
    this.monitorInterval = null
    this.gcThresholds = {
      heapUsed: 0.85, // 堆内存使用率超过85%触发GC
      rss: 1024 * 1024 * 1024, // RSS超过1GB触发GC
      external: 512 * 1024 * 1024 // 外部内存超过512MB触发GC
    }

    // 历史数据记录
    this.memoryHistory = []
    this.gcHistory = []
    this.maxHistorySize = 100

    // 内存泄漏检测
    this.leakDetection = {
      enabled: true,
      thresholdGrowth: 50 * 1024 * 1024, // 50MB增长阈值
      checkInterval: 10, // 每10次检查进行一次泄漏检测
      currentCheck: 0,
      baselineMemory: null
    }

    // 性能统计
    this.stats = {
      totalGCCalls: 0,
      totalMemorySaved: 0,
      averageGCTime: 0,
      memoryLeaksDetected: 0,
      lastGCTime: null
    }

    logger.info('🧠 内存监控系统已初始化')
  }

  /**
   * 启动内存监控
   * @param {number} intervalMs - 监控间隔（毫秒）
   */
  startMonitoring(intervalMs = 30000) {
    // 默认30秒
    if (this.isMonitoring) {
      logger.warn('⚠️ 内存监控已在运行中')
      return
    }

    this.isMonitoring = true
    this.leakDetection.baselineMemory = this.getCurrentMemoryUsage()

    this.monitorInterval = setInterval(() => {
      this.performMemoryCheck()
    }, intervalMs)

    logger.info(`🚀 内存监控已启动，检查间隔: ${intervalMs}ms`)
  }

  /**
   * 停止内存监控
   */
  stopMonitoring() {
    if (!this.isMonitoring) {
      return
    }

    this.isMonitoring = false

    if (this.monitorInterval) {
      clearInterval(this.monitorInterval)
      this.monitorInterval = null
    }

    logger.info('🛑 内存监控已停止')
  }

  /**
   * 执行内存检查
   * @private
   */
  performMemoryCheck() {
    const memoryUsage = this.getCurrentMemoryUsage()

    // 记录内存历史
    this.recordMemoryHistory(memoryUsage)

    // 检查是否需要触发GC
    const gcNeeded = this.checkGCNeeded(memoryUsage)
    if (gcNeeded.needed) {
      this.performOptimizedGC(gcNeeded.reason, memoryUsage)
    }

    // 内存泄漏检测
    if (this.leakDetection.enabled) {
      this.checkMemoryLeak(memoryUsage)
    }

    // 输出监控日志（仅在内存使用较高时）
    if (memoryUsage.heapUsedPercent > 70 || memoryUsage.rss > 512 * 1024 * 1024) {
      logger.info(
        `🧠 内存监控: 堆内存 ${(memoryUsage.heapUsed / 1024 / 1024).toFixed(1)}MB (${memoryUsage.heapUsedPercent.toFixed(1)}%), RSS ${(memoryUsage.rss / 1024 / 1024).toFixed(1)}MB`
      )
    }
  }

  /**
   * 获取当前内存使用情况
   * @returns {object} 内存使用信息
   */
  getCurrentMemoryUsage() {
    const usage = process.memoryUsage()
    return {
      rss: usage.rss,
      heapTotal: usage.heapTotal,
      heapUsed: usage.heapUsed,
      heapUsedPercent: (usage.heapUsed / usage.heapTotal) * 100,
      external: usage.external,
      arrayBuffers: usage.arrayBuffers,
      timestamp: Date.now()
    }
  }

  /**
   * 记录内存历史
   * @param {object} memoryUsage - 内存使用信息
   * @private
   */
  recordMemoryHistory(memoryUsage) {
    this.memoryHistory.push(memoryUsage)

    // 保持历史记录大小
    if (this.memoryHistory.length > this.maxHistorySize) {
      this.memoryHistory.shift()
    }
  }

  /**
   * 检查是否需要触发GC
   * @param {object} memoryUsage - 当前内存使用
   * @returns {object} GC检查结果
   * @private
   */
  checkGCNeeded(memoryUsage) {
    const reasons = []

    // 检查堆内存使用率
    if (memoryUsage.heapUsedPercent > this.gcThresholds.heapUsed * 100) {
      reasons.push(`堆内存使用率过高: ${memoryUsage.heapUsedPercent.toFixed(1)}%`)
    }

    // 检查RSS内存
    if (memoryUsage.rss > this.gcThresholds.rss) {
      reasons.push(`RSS内存过高: ${(memoryUsage.rss / 1024 / 1024).toFixed(1)}MB`)
    }

    // 检查外部内存
    if (memoryUsage.external > this.gcThresholds.external) {
      reasons.push(`外部内存过高: ${(memoryUsage.external / 1024 / 1024).toFixed(1)}MB`)
    }

    return {
      needed: reasons.length > 0,
      reason: reasons.join(', ')
    }
  }

  /**
   * 执行优化的垃圾回收
   * @param {string} reason - 触发GC的原因
   * @param {object} beforeMemory - GC前的内存使用
   * @private
   */
  performOptimizedGC(reason, beforeMemory) {
    const startTime = process.hrtime.bigint()

    logger.info(`🗑️ 触发垃圾回收: ${reason}`)

    try {
      // 强制垃圾回收（需要--expose-gc参数启动Node.js）
      if (global.gc) {
        global.gc()
      } else {
        // 如果没有--expose-gc，使用间接方法
        this.indirectGCTrigger()
      }

      const endTime = process.hrtime.bigint()
      const gcDuration = Number(endTime - startTime) / 1000000 // 转换为毫秒

      // 检查GC效果
      const afterMemory = this.getCurrentMemoryUsage()
      const memorySaved = beforeMemory.heapUsed - afterMemory.heapUsed

      // 记录GC历史
      const gcRecord = {
        timestamp: Date.now(),
        reason,
        duration: gcDuration,
        beforeHeapUsed: beforeMemory.heapUsed,
        afterHeapUsed: afterMemory.heapUsed,
        memorySaved,
        effectiveness: (memorySaved / beforeMemory.heapUsed) * 100
      }

      this.gcHistory.push(gcRecord)
      if (this.gcHistory.length > this.maxHistorySize) {
        this.gcHistory.shift()
      }

      // 更新统计
      this.stats.totalGCCalls++
      this.stats.totalMemorySaved += memorySaved
      this.stats.averageGCTime =
        (this.stats.averageGCTime * (this.stats.totalGCCalls - 1) + gcDuration) /
        this.stats.totalGCCalls
      this.stats.lastGCTime = Date.now()

      logger.info(
        `✅ 垃圾回收完成: 耗时 ${gcDuration.toFixed(2)}ms, 回收 ${(memorySaved / 1024 / 1024).toFixed(1)}MB, 效率 ${gcRecord.effectiveness.toFixed(1)}%`
      )
    } catch (error) {
      logger.error('❌ 垃圾回收执行失败:', error.message)
    }
  }

  /**
   * 间接触发垃圾回收（当没有--expose-gc时使用）
   * @private
   */
  indirectGCTrigger() {
    // 创建大量对象然后释放，间接触发GC
    const arrays = []
    for (let i = 0; i < 1000; i++) {
      arrays.push(new Array(1000))
    }
    arrays.length = 0 // 清空数组，让V8有机会回收
  }

  /**
   * 检查内存泄漏
   * @param {object} currentMemory - 当前内存使用
   * @private
   */
  checkMemoryLeak(currentMemory) {
    this.leakDetection.currentCheck++

    if (this.leakDetection.currentCheck % this.leakDetection.checkInterval !== 0) {
      return
    }

    if (!this.leakDetection.baselineMemory) {
      this.leakDetection.baselineMemory = currentMemory
      return
    }

    const memoryGrowth = currentMemory.heapUsed - this.leakDetection.baselineMemory.heapUsed

    if (memoryGrowth > this.leakDetection.thresholdGrowth) {
      this.stats.memoryLeaksDetected++

      logger.warn(
        `🚨 可能存在内存泄漏: 内存增长 ${(memoryGrowth / 1024 / 1024).toFixed(1)}MB 超过阈值 ${(this.leakDetection.thresholdGrowth / 1024 / 1024).toFixed(1)}MB`
      )

      // 触发强制GC以确认是否为泄漏
      this.performOptimizedGC('内存泄漏检测', currentMemory)

      // 重新设置基线
      setTimeout(() => {
        this.leakDetection.baselineMemory = this.getCurrentMemoryUsage()
      }, 5000) // 5秒后重新设置基线
    }
  }

  /**
   * 获取内存监控统计信息
   * @returns {object} 统计信息
   */
  getStats() {
    const currentMemory = this.getCurrentMemoryUsage()

    return {
      current: currentMemory,
      monitoring: {
        isActive: this.isMonitoring,
        historySize: this.memoryHistory.length
      },
      gc: {
        totalCalls: this.stats.totalGCCalls,
        totalMemorySaved: this.stats.totalMemorySaved,
        averageTime: this.stats.averageGCTime,
        lastGCTime: this.stats.lastGCTime
      },
      leakDetection: {
        enabled: this.leakDetection.enabled,
        detectedLeaks: this.stats.memoryLeaksDetected,
        currentGrowth: this.leakDetection.baselineMemory
          ? currentMemory.heapUsed - this.leakDetection.baselineMemory.heapUsed
          : 0
      },
      thresholds: this.gcThresholds
    }
  }

  /**
   * 生成详细的内存报告
   * @returns {object} 详细报告
   */
  generateDetailedReport() {
    const stats = this.getStats()

    // 计算内存趋势
    const recentHistory = this.memoryHistory.slice(-10) // 最近10次记录
    let memoryTrend = 'stable'
    if (recentHistory.length >= 2) {
      const firstMemory = recentHistory[0].heapUsed
      const lastMemory = recentHistory[recentHistory.length - 1].heapUsed
      const growth = lastMemory - firstMemory
      const growthPercent = (growth / firstMemory) * 100

      if (growthPercent > 10) {
        memoryTrend = 'increasing'
      } else if (growthPercent < -10) {
        memoryTrend = 'decreasing'
      }
    }

    // 计算平均GC效率
    const recentGCs = this.gcHistory.slice(-10)
    const averageEffectiveness =
      recentGCs.length > 0
        ? recentGCs.reduce((sum, gc) => sum + gc.effectiveness, 0) / recentGCs.length
        : 0

    return {
      ...stats,
      analysis: {
        memoryTrend,
        averageGCEffectiveness: averageEffectiveness,
        recommendations: this.generateRecommendations(stats, memoryTrend, averageEffectiveness)
      },
      recentGCs: recentGCs.map((gc) => ({
        timestamp: new Date(gc.timestamp).toISOString(),
        reason: gc.reason,
        duration: gc.duration,
        memorySaved: gc.memorySaved,
        effectiveness: gc.effectiveness
      }))
    }
  }

  /**
   * 生成优化建议
   * @param {object} stats - 统计信息
   * @param {string} memoryTrend - 内存趋势
   * @param {number} averageEffectiveness - 平均GC效率
   * @returns {Array} 建议列表
   * @private
   */
  generateRecommendations(stats, memoryTrend, averageEffectiveness) {
    const recommendations = []

    if (memoryTrend === 'increasing') {
      recommendations.push('内存持续增长，建议检查是否存在内存泄漏')
    }

    if (averageEffectiveness < 20) {
      recommendations.push('垃圾回收效率较低，可能存在内存碎片问题')
    }

    if (stats.current.heapUsedPercent > 90) {
      recommendations.push('堆内存使用率过高，建议增加应用内存限制或优化内存使用')
    }

    if (stats.gc.totalCalls > 100 && stats.gc.averageTime > 100) {
      recommendations.push('垃圾回收频率过高且耗时较长，建议优化对象生命周期管理')
    }

    if (recommendations.length === 0) {
      recommendations.push('内存使用状况良好')
    }

    return recommendations
  }

  /**
   * 手动触发垃圾回收
   * @param {string} reason - 触发原因
   */
  manualGC(reason = '手动触发') {
    const currentMemory = this.getCurrentMemoryUsage()
    this.performOptimizedGC(reason, currentMemory)
  }

  /**
   * 销毁内存监控器
   */
  destroy() {
    this.stopMonitoring()
    this.memoryHistory = []
    this.gcHistory = []
    logger.info('🗑️ 内存监控器已销毁')
  }
}

// 创建单例实例
const memoryMonitor = new MemoryMonitor()

// 进程退出时清理资源
process.on('exit', () => {
  memoryMonitor.destroy()
})

module.exports = memoryMonitor
