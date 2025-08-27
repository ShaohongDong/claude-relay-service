// 并发测试模拟器 - 用于测试分布式锁、竞争条件和超时控制
const { EventEmitter } = require('events')

/**
 * 并发模拟器 - 专门用于测试系统中的并发场景
 */
class ConcurrencySimulator extends EventEmitter {
  constructor() {
    super()
    this.processCount = 0
    this.runningProcesses = new Map()
    this.completedProcesses = []
    this.lockResults = new Map()
    this.networkLatencyRange = [0, 100] // 默认0-100ms延迟
    this.failureRate = 0 // 默认0%失败率
    this.isRunning = false
  }

  /**
   * 设置网络延迟范围
   * @param {number} min - 最小延迟(ms)
   * @param {number} max - 最大延迟(ms)
   */
  setNetworkLatency(min, max) {
    this.networkLatencyRange = [min, max]
    return this
  }

  /**
   * 设置操作失败率
   * @param {number} rate - 失败率 (0-1)
   */
  setFailureRate(rate) {
    this.failureRate = Math.max(0, Math.min(1, rate))
    return this
  }

  /**
   * 模拟网络延迟
   */
  async _simulateNetworkLatency() {
    const [min, max] = this.networkLatencyRange
    const delay = min + Math.random() * (max - min)
    if (delay > 0) {
      await new Promise(resolve => setTimeout(resolve, delay))
    }
    return delay
  }

  /**
   * 模拟操作失败
   * @param {string} operation - 操作名称
   */
  _simulateFailure(operation) {
    if (this.failureRate > 0 && Math.random() < this.failureRate) {
      throw new Error(`Simulated failure: ${operation}`)
    }
  }

  /**
   * 创建进程模拟器
   * @param {string} processId - 进程ID
   * @param {Function} taskFn - 要执行的任务函数
   * @param {Object} options - 选项
   */
  createProcess(processId, taskFn, options = {}) {
    const process = {
      id: processId,
      taskFn,
      options: {
        priority: options.priority || 0,
        maxRetries: options.maxRetries || 0,
        timeout: options.timeout || 30000, // 30秒默认超时
        ...options
      },
      status: 'pending',
      startTime: null,
      endTime: null,
      result: null,
      error: null,
      retryCount: 0,
      metrics: {
        totalTime: 0,
        networkTime: 0,
        processingTime: 0
      }
    }

    this.runningProcesses.set(processId, process)
    this.emit('processCreated', process)
    
    return process
  }

  /**
   * 并发运行多个进程
   * @param {Array} processes - 进程数组或进程配置数组
   * @param {Object} options - 运行选项
   */
  async runConcurrent(processes, options = {}) {
    this.isRunning = true
    const {
      maxConcurrency = processes.length,
      waitForAll = true,
      timeoutMs = 60000
    } = options

    this.emit('concurrentStart', { processCount: processes.length, maxConcurrency })

    try {
      const promises = []
      const semaphore = new Semaphore(maxConcurrency)

      for (const processConfig of processes) {
        const promise = this._runSingleProcess(processConfig, semaphore)
        promises.push(promise)
      }

      let results
      if (waitForAll) {
        // 等待所有进程完成
        results = await Promise.allSettled(promises)
      } else {
        // 使用超时控制
        results = await Promise.race([
          Promise.allSettled(promises),
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Concurrent execution timeout')), timeoutMs)
          )
        ])
      }

      const summary = this._generateSummary(results)
      this.emit('concurrentComplete', summary)
      
      return summary
    } finally {
      this.isRunning = false
    }
  }

  /**
   * 模拟分布式锁竞争
   * @param {string} lockKey - 锁的键
   * @param {number} processCount - 竞争进程数量
   * @param {Function} criticalSectionFn - 临界区函数
   */
  async simulateLockCompetition(lockKey, processCount, criticalSectionFn) {
    this.emit('lockCompetitionStart', { lockKey, processCount })

    const processes = Array.from({ length: processCount }, (_, i) => ({
      id: `process-${i}`,
      taskFn: async () => {
        return await this._attemptLockAndExecute(lockKey, `process-${i}`, criticalSectionFn)
      },
      priority: Math.random() // 随机优先级
    }))

    const results = await this.runConcurrent(processes, {
      maxConcurrency: processCount,
      waitForAll: true
    })

    const lockStats = this._analyzeLockCompetition(results, lockKey)
    this.emit('lockCompetitionComplete', lockStats)

    return lockStats
  }

  /**
   * 尝试获取锁并执行临界区 - 使用真实Redis操作
   */
  async _attemptLockAndExecute(lockKey, processId, criticalSectionFn) {
    const startTime = Date.now()
    let lockAcquired = false
    let lockAcquireTime = 0
    let executionTime = 0
    let result = null
    let error = null
    const lockValue = `${processId}_${Date.now()}_${Math.random().toString(36).substring(2)}`

    try {
      // 模拟获取锁的过程（包含网络延迟）
      const networkLatency = await this._simulateNetworkLatency()
      this._simulateFailure('lock_acquisition')
      
      // 使用Redis的原子操作获取锁
      const redis = global.testRedisInstance
      const lockResult = await redis.set(lockKey, lockValue, 'NX', 'EX', 60) // 60秒TTL
      
      lockAcquired = lockResult === 'OK'
      
      if (lockAcquired) {
        lockAcquireTime = Date.now() - startTime

        // 执行临界区
        const execStart = Date.now()
        result = await criticalSectionFn(processId)
        executionTime = Date.now() - execStart

        // 使用Lua脚本安全地释放锁
        const releaseScript = `
          if redis.call("get", KEYS[1]) == ARGV[1] then
            return redis.call("del", KEYS[1])
          else
            return 0
          end
        `
        await redis.eval(releaseScript, 1, lockKey, lockValue)
        
      } else {
        throw new Error(`Lock ${lockKey} is already held by another process`)
      }
    } catch (err) {
      error = err.message
      
      // 确保在错误情况下也尝试释放锁
      if (lockAcquired) {
        try {
          const redis = global.testRedisInstance
          const releaseScript = `
            if redis.call("get", KEYS[1]) == ARGV[1] then
              return redis.call("del", KEYS[1])
            else
              return 0
            end
          `
          await redis.eval(releaseScript, 1, lockKey, lockValue)
        } catch (releaseError) {
          // 忽略释放锁的错误
        }
      }
    }

    return {
      processId,
      lockKey,
      lockAcquired,
      lockAcquireTime,
      executionTime,
      totalTime: Date.now() - startTime,
      result,
      error
    }
  }

  /**
   * 模拟Promise.race超时控制场景
   * @param {Function} operationFn - 操作函数
   * @param {number} timeoutMs - 超时时间(ms)
   * @param {number} processCount - 并发进程数
   */
  async simulateTimeoutRace(operationFn, timeoutMs, processCount = 1) {
    this.emit('timeoutRaceStart', { timeoutMs, processCount })

    const processes = Array.from({ length: processCount }, (_, i) => ({
      id: `timeout-process-${i}`,
      taskFn: async () => {
        return await this._executeWithTimeout(operationFn, timeoutMs, `timeout-process-${i}`)
      }
    }))

    const results = await this.runConcurrent(processes, {
      maxConcurrency: processCount,
      waitForAll: true
    })

    const timeoutStats = this._analyzeTimeoutRace(results, timeoutMs)
    this.emit('timeoutRaceComplete', timeoutStats)

    return timeoutStats
  }

  /**
   * 执行带超时控制的操作
   */
  async _executeWithTimeout(operationFn, timeoutMs, processId) {
    const startTime = Date.now()
    let isTimeout = false
    let result = null
    let error = null

    try {
      result = await Promise.race([
        operationFn(processId),
        new Promise((_, reject) => 
          setTimeout(() => {
            isTimeout = true
            reject(new Error(`Operation timeout after ${timeoutMs}ms`))
          }, timeoutMs)
        )
      ])
    } catch (err) {
      error = err.message
    }

    return {
      processId,
      isTimeout,
      actualTime: Date.now() - startTime,
      timeoutMs,
      result,
      error
    }
  }

  /**
   * 运行单个进程
   */
  async _runSingleProcess(processConfig, semaphore) {
    let process
    
    // 处理不同的输入格式
    if (typeof processConfig === 'function') {
      process = this.createProcess(`auto-${this.processCount++}`, processConfig)
    } else if (processConfig && typeof processConfig === 'object' && processConfig.taskFn) {
      process = processConfig
      if (!process.id) {
        process.id = `process-${this.processCount++}`
      }
      if (!process.options) {
        process.options = { maxRetries: 0, timeout: 30000 }
      }
    } else {
      throw new Error('Invalid process configuration')
    }

    await semaphore.acquire()

    try {
      process.status = 'running'
      process.startTime = Date.now()
      
      this.emit('processStart', process)

      // 执行任务
      process.result = await process.taskFn()
      process.status = 'completed'
      
    } catch (error) {
      process.error = error
      process.status = 'failed'
      
      // 重试逻辑
      if (process.retryCount < process.options.maxRetries) {
        process.retryCount++
        process.status = 'retrying'
        
        await new Promise(resolve => 
          setTimeout(resolve, Math.pow(2, process.retryCount) * 1000) // 指数退避
        )
        
        return this._runSingleProcess(process, semaphore)
      }
    } finally {
      process.endTime = Date.now()
      process.metrics = process.metrics || {}
      process.metrics.totalTime = process.endTime - process.startTime
      
      this.completedProcesses.push(process)
      this.emit('processComplete', process)
      
      semaphore.release()
    }

    return process
  }

  /**
   * 生成执行摘要
   */
  _generateSummary(results) {
    const summary = {
      totalProcesses: this.completedProcesses.length,
      successful: 0,
      failed: 0,
      totalTime: 0,
      averageTime: 0,
      minTime: Infinity,
      maxTime: 0,
      concurrencyIssues: [],
      performanceMetrics: {},
      completedProcesses: this.completedProcesses // 包含完整的进程信息
    }

    // 使用completedProcesses而不是results参数
    for (const process of this.completedProcesses) {
      if (process.status === 'completed') {
        summary.successful++
      } else if (process.status === 'failed') {
        summary.failed++
      }

      const processTime = process.metrics?.totalTime || 0
      summary.totalTime += processTime
      
      if (processTime > 0) {
        summary.minTime = Math.min(summary.minTime, processTime)
        summary.maxTime = Math.max(summary.maxTime, processTime)
      }
    }

    // 修复除零错误
    if (summary.totalProcesses > 0) {
      summary.averageTime = summary.totalTime / summary.totalProcesses
      summary.successRate = summary.successful / summary.totalProcesses
    } else {
      summary.averageTime = 0
      summary.successRate = 0
    }

    // 修复minTime的初始值问题
    if (summary.minTime === Infinity) {
      summary.minTime = 0
    }

    // 检测潜在的并发问题
    if (summary.averageTime > 0 && summary.maxTime > summary.averageTime * 3) {
      summary.concurrencyIssues.push('High variance in execution times detected')
    }

    if (summary.successRate < 0.95) {
      summary.concurrencyIssues.push('Low success rate may indicate race conditions')
    }

    return summary
  }

  /**
   * 分析锁竞争结果
   */
  _analyzeLockCompetition(results, lockKey) {
    const analysis = {
      lockKey,
      totalProcesses: results.totalProcesses,
      lockAcquisitions: 0,
      lockContentions: 0,
      averageLockAcquireTime: 0,
      lockHolders: [],
      contentionPattern: {}
    }

    let totalLockTime = 0
    
    // 分析completedProcesses中的结果
    for (const process of results.completedProcesses || []) {
      if (process.result && process.result.lockAcquired) {
        analysis.lockAcquisitions++
        analysis.lockHolders.push(process.result.processId)
        totalLockTime += process.result.lockAcquireTime || 0
      } else if (process.result && process.result.lockAcquired === false) {
        analysis.lockContentions++
      }
    }

    analysis.averageLockAcquireTime = analysis.lockAcquisitions > 0 
      ? totalLockTime / analysis.lockAcquisitions 
      : 0

    analysis.contentionRate = analysis.totalProcesses > 0 
      ? analysis.lockContentions / analysis.totalProcesses 
      : 0
    analysis.lockEfficiency = analysis.totalProcesses > 0 
      ? analysis.lockAcquisitions / analysis.totalProcesses 
      : 0

    return analysis
  }

  /**
   * 分析超时竞争结果
   */
  _analyzeTimeoutRace(results, timeoutMs) {
    const analysis = {
      timeoutMs,
      totalProcesses: results.totalProcesses,
      timeoutCount: 0,
      successCount: 0,
      averageExecutionTime: 0,
      timeoutRate: 0,
      performanceDistribution: {
        fast: 0,    // < 25% of timeout
        normal: 0,  // 25-75% of timeout  
        slow: 0,    // 75-100% of timeout
        timeout: 0  // >= timeout
      }
    }

    let totalTime = 0

    for (const result of this.completedProcesses) {
      if (!result.result) continue

      const actualTime = result.result.actualTime || 0
      totalTime += actualTime

      if (result.result.isTimeout) {
        analysis.timeoutCount++
        analysis.performanceDistribution.timeout++
      } else {
        analysis.successCount++
        
        const timeoutPercentage = actualTime / timeoutMs
        if (timeoutPercentage < 0.25) {
          analysis.performanceDistribution.fast++
        } else if (timeoutPercentage < 0.75) {
          analysis.performanceDistribution.normal++
        } else {
          analysis.performanceDistribution.slow++
        }
      }
    }

    analysis.averageExecutionTime = totalTime / analysis.totalProcesses
    analysis.timeoutRate = analysis.timeoutCount / analysis.totalProcesses

    return analysis
  }

  /**
   * 重置模拟器状态
   */
  reset() {
    this.processCount = 0
    this.runningProcesses.clear()
    this.completedProcesses = []
    this.lockResults.clear()
    this.isRunning = false
    this.emit('reset')
    return this
  }

  /**
   * 获取详细统计信息
   */
  getDetailedStats() {
    return {
      isRunning: this.isRunning,
      totalProcessesCreated: this.processCount,
      runningProcesses: this.runningProcesses.size,
      completedProcesses: this.completedProcesses.length,
      activeLocks: this.lockResults.size,
      networkLatencyRange: this.networkLatencyRange,
      failureRate: this.failureRate
    }
  }
}

/**
 * 信号量实现 - 用于控制并发数量
 */
class Semaphore {
  constructor(count) {
    this.count = count
    this.waiting = []
  }

  async acquire() {
    if (this.count > 0) {
      this.count--
      return Promise.resolve()
    }

    return new Promise(resolve => {
      this.waiting.push(resolve)
    })
  }

  release() {
    if (this.waiting.length > 0) {
      const resolve = this.waiting.shift()
      resolve()
    } else {
      this.count++
    }
  }
}

/**
 * 便捷的并发测试工具函数
 */
const concurrencyTestUtils = {
  /**
   * 快速创建锁竞争测试
   */
  createLockCompetitionTest(lockKey, processCount, criticalSectionFn) {
    return async () => {
      const simulator = new ConcurrencySimulator()
      const results = await simulator.simulateLockCompetition(lockKey, processCount, criticalSectionFn)
      
      // 基本断言
      expect(results.lockAcquisitions).toBeGreaterThan(0)
      expect(results.lockAcquisitions).toBeLessThanOrEqual(processCount)
      expect(results.lockEfficiency).toBeGreaterThan(0)
      
      return results
    }
  },

  /**
   * 快速创建超时测试
   */
  createTimeoutTest(operationFn, timeoutMs, processCount = 1) {
    return async () => {
      const simulator = new ConcurrencySimulator()
      const results = await simulator.simulateTimeoutRace(operationFn, timeoutMs, processCount)
      
      // 基本断言
      expect(results.totalProcesses).toBe(processCount)
      expect(results.timeoutRate).toBeGreaterThanOrEqual(0)
      expect(results.timeoutRate).toBeLessThanOrEqual(1)
      
      return results
    }
  },

  /**
   * 创建高负载测试
   */
  createHighLoadTest(taskFn, concurrency = 100, duration = 5000) {
    return async () => {
      const simulator = new ConcurrencySimulator()
      
      const processes = Array.from({ length: concurrency }, (_, i) => ({
        id: `load-test-${i}`,
        taskFn: () => taskFn(i)
      }))

      const startTime = Date.now()
      const results = await simulator.runConcurrent(processes, {
        maxConcurrency: Math.min(concurrency, 50), // 限制实际并发数
        waitForAll: true,
        timeoutMs: duration
      })

      const actualDuration = Date.now() - startTime

      return {
        ...results,
        actualDuration,
        throughput: results.successful / (actualDuration / 1000), // 每秒成功数
        concurrency
      }
    }
  }
}

module.exports = {
  ConcurrencySimulator,
  Semaphore,
  concurrencyTestUtils
}