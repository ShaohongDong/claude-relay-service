const os = require('os')
const logger = require('./logger')

/**
 * 对象池管理器
 * 用于复用大对象，减少内存分配和垃圾回收开销
 */
class ObjectPool {
  constructor(createFn, resetFn, maxSize = 100) {
    this.createFn = createFn
    this.resetFn = resetFn
    this.maxSize = maxSize
    this.pool = []
    this.created = 0
    this.reused = 0
    this.released = 0
  }

  /**
   * 获取对象（从池中复用或创建新对象）
   */
  acquire() {
    let obj

    if (this.pool.length > 0) {
      obj = this.pool.pop()
      this.reused++
    } else {
      obj = this.createFn()
      this.created++
    }

    // 添加释放方法到对象
    obj._poolRelease = () => this.release(obj)
    
    return obj
  }

  /**
   * 释放对象回到池中
   */
  release(obj) {
    if (this.pool.length < this.maxSize) {
      // 重置对象状态
      if (this.resetFn) {
        this.resetFn(obj)
      }
      
      // 移除释放方法，避免重复释放
      delete obj._poolRelease
      
      this.pool.push(obj)
      this.released++
    }
    // 如果池已满，让对象被垃圾回收
  }

  /**
   * 获取池统计信息
   */
  getStats() {
    return {
      poolSize: this.pool.length,
      maxSize: this.maxSize,
      created: this.created,
      reused: this.reused,
      released: this.released,
      reuseRate: this.created > 0 ? (this.reused / this.created * 100).toFixed(2) + '%' : '0%'
    }
  }

  /**
   * 清空对象池
   */
  clear() {
    this.pool.length = 0
    this.created = 0
    this.reused = 0
    this.released = 0
  }
}

/**
 * Buffer 池管理器
 * 专门用于管理 Buffer 对象，减少内存分配
 */
class BufferPool {
  constructor() {
    // 根据常见 Buffer 大小创建不同的池
    this.pools = new Map([
      [1024, new ObjectPool(() => Buffer.alloc(1024), (buf) => buf.fill(0), 50)],
      [4096, new ObjectPool(() => Buffer.alloc(4096), (buf) => buf.fill(0), 30)],
      [16384, new ObjectPool(() => Buffer.alloc(16384), (buf) => buf.fill(0), 20)],
      [65536, new ObjectPool(() => Buffer.alloc(65536), (buf) => buf.fill(0), 10)]
    ])
  }

  /**
   * 获取指定大小的 Buffer
   */
  acquire(size) {
    // 找到最接近的池大小
    const poolSize = this.findBestPoolSize(size)
    
    if (poolSize && this.pools.has(poolSize)) {
      const buffer = this.pools.get(poolSize).acquire()
      return buffer.slice(0, size) // 返回所需大小的部分
    }

    // 如果没有合适的池，直接分配
    return Buffer.alloc(size)
  }

  /**
   * 找到最合适的池大小
   */
  findBestPoolSize(size) {
    const poolSizes = Array.from(this.pools.keys()).sort((a, b) => a - b)
    
    for (const poolSize of poolSizes) {
      if (size <= poolSize) {
        return poolSize
      }
    }
    
    return null
  }

  /**
   * 获取所有池的统计信息
   */
  getStats() {
    const stats = {}
    for (const [size, pool] of this.pools) {
      stats[`buffer_${size}`] = pool.getStats()
    }
    return stats
  }

  /**
   * 清空所有 Buffer 池
   */
  clear() {
    for (const pool of this.pools.values()) {
      pool.clear()
    }
  }
}

/**
 * 内存优化器主类
 * 提供垃圾回收优化、内存监控和对象池管理
 */
class MemoryOptimizer {
  constructor() {
    this.enabled = process.env.NODE_ENV !== 'test' // 测试环境下默认禁用
    
    // 对象池
    this.objectPools = new Map()
    
    // Buffer 池
    this.bufferPool = new BufferPool()
    
    // 内存监控配置
    this.memoryConfig = {
      // 内存使用超过 80% 时触发告警
      alertThreshold: 0.8,
      // 内存使用超过 90% 时强制执行 GC
      forceGcThreshold: 0.9,
      // 监控间隔 (毫秒)
      monitorInterval: 30000, // 30 秒
      // GC 间隔限制 (毫秒) - 避免频繁执行 GC
      gcCooldown: 10000 // 10 秒
    }
    
    // 运行时状态
    this.stats = {
      gcTriggered: 0,
      memoryAlerts: 0,
      lastGcTime: 0,
      maxMemoryUsage: 0,
      avgMemoryUsage: 0,
      monitoringStart: Date.now()
    }
    
    this.memoryReadings = []
    this.monitoringInterval = null
    
    if (this.enabled) {
      this.startMonitoring()
    }
  }

  /**
   * 注册对象池
   */
  registerObjectPool(name, createFn, resetFn, maxSize = 100) {
    if (!this.enabled) return
    
    const pool = new ObjectPool(createFn, resetFn, maxSize)
    this.objectPools.set(name, pool)
    
    logger.debug(`📦 Registered object pool: ${name} (maxSize: ${maxSize})`)
    return pool
  }

  /**
   * 获取对象池
   */
  getObjectPool(name) {
    return this.objectPools.get(name)
  }

  /**
   * 获取 Buffer 池
   */
  getBufferPool() {
    return this.bufferPool
  }

  /**
   * 手动触发垃圾回收
   */
  forceGarbageCollection(reason = 'manual') {
    if (!this.enabled || !global.gc) {
      return false
    }

    const now = Date.now()
    
    // 检查 GC 冷却时间
    if (now - this.stats.lastGcTime < this.memoryConfig.gcCooldown) {
      logger.debug(`🗑️ GC skipped due to cooldown period (${reason})`)
      return false
    }

    try {
      const beforeMemory = process.memoryUsage()
      
      global.gc()
      
      const afterMemory = process.memoryUsage()
      const savedMemory = beforeMemory.heapUsed - afterMemory.heapUsed
      
      this.stats.gcTriggered++
      this.stats.lastGcTime = now
      
      logger.info(`🗑️ Garbage collection completed (${reason})`, {
        savedMemory: `${Math.round(savedMemory / 1024 / 1024)}MB`,
        beforeHeap: `${Math.round(beforeMemory.heapUsed / 1024 / 1024)}MB`,
        afterHeap: `${Math.round(afterMemory.heapUsed / 1024 / 1024)}MB`
      })
      
      return true
    } catch (error) {
      logger.error('❌ Failed to trigger garbage collection:', error)
      return false
    }
  }

  /**
   * 检查内存使用情况
   */
  checkMemoryUsage() {
    if (!this.enabled) return null

    const memory = process.memoryUsage()
    const totalMemory = os.totalmem()
    const freeMemory = os.freemem()
    const systemUsage = (totalMemory - freeMemory) / totalMemory
    
    const heapUsage = memory.heapUsed / memory.heapTotal
    const processMemory = (memory.rss / 1024 / 1024) // MB
    
    // 记录内存使用情况
    this.memoryReadings.push({
      timestamp: Date.now(),
      heapUsage,
      processMemory,
      systemUsage
    })
    
    // 保持最近 100 个读数
    if (this.memoryReadings.length > 100) {
      this.memoryReadings.shift()
    }
    
    // 更新统计信息
    this.stats.maxMemoryUsage = Math.max(this.stats.maxMemoryUsage, heapUsage)
    this.stats.avgMemoryUsage = this.memoryReadings.reduce((sum, reading) => 
      sum + reading.heapUsage, 0) / this.memoryReadings.length

    return {
      heapUsage,
      processMemory,
      systemUsage,
      memory
    }
  }

  /**
   * 开始内存监控
   */
  startMonitoring() {
    if (this.monitoringInterval) {
      return // 已经在监控中
    }
    
    this.monitoringInterval = setInterval(() => {
      const memoryInfo = this.checkMemoryUsage()
      if (!memoryInfo) return

      const { heapUsage, processMemory, systemUsage } = memoryInfo
      
      // 检查是否需要触发告警
      if (heapUsage > this.memoryConfig.alertThreshold) {
        this.stats.memoryAlerts++
        
        logger.warn(`🚨 High memory usage detected`, {
          heapUsage: `${(heapUsage * 100).toFixed(2)}%`,
          processMemory: `${processMemory.toFixed(2)}MB`,
          systemUsage: `${(systemUsage * 100).toFixed(2)}%`
        })
        
        // 输出对象池统计信息
        this.logPoolStats()
      }
      
      // 检查是否需要强制 GC
      if (heapUsage > this.memoryConfig.forceGcThreshold) {
        logger.warn(`🗑️ Memory usage critical, forcing garbage collection`)
        this.forceGarbageCollection('memory_critical')
      }
      
    }, this.memoryConfig.monitorInterval)
    
    logger.info(`📊 Memory monitoring started (interval: ${this.memoryConfig.monitorInterval}ms)`)
  }

  /**
   * 停止内存监控
   */
  stopMonitoring() {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval)
      this.monitoringInterval = null
      logger.info(`📊 Memory monitoring stopped`)
    }
  }

  /**
   * 输出对象池统计信息
   */
  logPoolStats() {
    if (this.objectPools.size === 0 && this.bufferPool.pools.size === 0) {
      return
    }

    logger.info(`📦 Object Pool Statistics:`)
    
    // 输出对象池统计
    for (const [name, pool] of this.objectPools) {
      const stats = pool.getStats()
      logger.info(`  ${name}: ${JSON.stringify(stats)}`)
    }
    
    // 输出 Buffer 池统计
    const bufferStats = this.bufferPool.getStats()
    for (const [name, stats] of Object.entries(bufferStats)) {
      logger.info(`  ${name}: ${JSON.stringify(stats)}`)
    }
  }

  /**
   * 获取优化器统计信息
   */
  getStats() {
    const currentMemory = this.checkMemoryUsage()
    
    return {
      enabled: this.enabled,
      runtime: {
        ...this.stats,
        uptime: Date.now() - this.stats.monitoringStart
      },
      memory: currentMemory,
      pools: {
        objectPools: Object.fromEntries(
          Array.from(this.objectPools.entries()).map(([name, pool]) => 
            [name, pool.getStats()])
        ),
        bufferPool: this.bufferPool.getStats()
      },
      config: this.memoryConfig
    }
  }

  /**
   * 清理所有资源
   */
  cleanup() {
    this.stopMonitoring()
    
    // 清空所有对象池
    for (const pool of this.objectPools.values()) {
      pool.clear()
    }
    this.objectPools.clear()
    
    // 清空 Buffer 池
    this.bufferPool.clear()
    
    // 重置统计信息
    this.stats = {
      gcTriggered: 0,
      memoryAlerts: 0,
      lastGcTime: 0,
      maxMemoryUsage: 0,
      avgMemoryUsage: 0,
      monitoringStart: Date.now()
    }
    
    this.memoryReadings = []
    
    logger.info(`🧹 Memory optimizer cleaned up`)
  }

  /**
   * 配置内存监控参数
   */
  configure(config) {
    this.memoryConfig = { ...this.memoryConfig, ...config }
    
    // 如果监控间隔改变，重启监控
    if (this.monitoringInterval && config.monitorInterval) {
      this.stopMonitoring()
      this.startMonitoring()
    }
    
    logger.info(`⚙️ Memory optimizer configured`, this.memoryConfig)
  }
}

// 创建全局实例
const memoryOptimizer = new MemoryOptimizer()

// 优雅关闭处理
process.on('SIGTERM', () => {
  memoryOptimizer.cleanup()
})

process.on('SIGINT', () => {
  memoryOptimizer.cleanup()
})

module.exports = memoryOptimizer