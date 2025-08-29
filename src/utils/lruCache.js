const memoryOptimizer = require('./memoryOptimizer')
const asyncMonitor = require('./asyncMonitor')

/**
 * 增强版 LRU (Least Recently Used) 缓存实现
 * 集成内存优化、智能过期和自适应清理策略
 */
class LRUCache {
  constructor(maxSize = 500) {
    this.maxSize = maxSize
    this.cache = new Map()
    this.hits = 0
    this.misses = 0
    this.evictions = 0
    this.lastCleanup = Date.now()
    
    // 增强的清理配置
    this.cleanupConfig = {
      baseInterval: 5 * 60 * 1000,     // 5分钟基础清理间隔
      adaptiveCleanup: true,           // 自适应清理
      memoryPressureThreshold: 0.8,   // 内存压力阈值
      aggressiveCleanupThreshold: 0.9, // 激进清理阈值
      minCleanupInterval: 30 * 1000,   // 最小清理间隔（30秒）
      maxCleanupInterval: 15 * 60 * 1000 // 最大清理间隔（15分钟）
    }
    
    // 动态调整的清理间隔
    this.currentCleanupInterval = this.cleanupConfig.baseInterval
    
    // 内存使用情况
    this.memoryStats = {
      lastMemoryCheck: Date.now(),
      memoryPressure: 0,
      adaptiveCleanupCount: 0
    }
    
    // 启动智能清理
    this.startIntelligentCleanup()
    
    // 注册到内存优化器（如果可用）
    if (memoryOptimizer) {
      this.registerWithMemoryOptimizer()
    }
  }

  /**
   * 获取缓存值
   * @param {string} key - 缓存键
   * @returns {*} 缓存的值，如果不存在则返回 undefined
   */
  get(key) {
    // 定期清理
    if (Date.now() - this.lastCleanup > this.cleanupInterval) {
      this.cleanup()
    }

    const item = this.cache.get(key)
    if (!item) {
      this.misses++
      return undefined
    }

    // 检查是否过期
    if (item.expiry && Date.now() > item.expiry) {
      this.cache.delete(key)
      this.misses++
      return undefined
    }

    // 更新访问时间，将元素移到最后（最近使用）
    this.cache.delete(key)
    this.cache.set(key, {
      ...item,
      lastAccessed: Date.now()
    })

    this.hits++
    return item.value
  }

  /**
   * 设置缓存值
   * @param {string} key - 缓存键
   * @param {*} value - 要缓存的值
   * @param {number} ttl - 生存时间（毫秒），默认5分钟
   */
  set(key, value, ttl = 5 * 60 * 1000) {
    // 如果缓存已满，删除最少使用的项
    if (this.cache.size >= this.maxSize && !this.cache.has(key)) {
      const firstKey = this.cache.keys().next().value
      this.cache.delete(firstKey)
      this.evictions++
    }

    this.cache.set(key, {
      value,
      createdAt: Date.now(),
      lastAccessed: Date.now(),
      expiry: ttl ? Date.now() + ttl : null
    })
  }

  /**
   * 清理过期项
   */
  cleanup() {
    const now = Date.now()
    let cleanedCount = 0

    for (const [key, item] of this.cache.entries()) {
      if (item.expiry && now > item.expiry) {
        this.cache.delete(key)
        cleanedCount++
      }
    }

    this.lastCleanup = now
    if (cleanedCount > 0) {
      console.log(`🧹 LRU Cache: Cleaned ${cleanedCount} expired items`)
    }
  }

  /**
   * 清空缓存
   */
  clear() {
    const { size } = this.cache
    this.cache.clear()
    this.hits = 0
    this.misses = 0
    this.evictions = 0
    console.log(`🗑️ LRU Cache: Cleared ${size} items`)
  }

  /**
   * 获取缓存统计信息
   */
  getStats() {
    const total = this.hits + this.misses
    const hitRate = total > 0 ? ((this.hits / total) * 100).toFixed(2) : 0

    return {
      size: this.cache.size,
      maxSize: this.maxSize,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      hitRate: `${hitRate}%`,
      total
    }
  }

  /**
   * 打印缓存统计信息
   */
  printStats() {
    const stats = this.getStats()
    console.log(
      `📊 LRU Cache Stats: Size: ${stats.size}/${stats.maxSize}, Hit Rate: ${stats.hitRate}, Hits: ${stats.hits}, Misses: ${stats.misses}, Evictions: ${stats.evictions}`
    )
  }

  /**
   * 启动智能清理系统
   */
  startIntelligentCleanup() {
    if (this.cleanupTimer) {
      return // 已经启动
    }
    
    const scheduleNextCleanup = () => {
      this.cleanupTimer = setTimeout(() => {
        this.intelligentCleanup()
        scheduleNextCleanup()
      }, this.currentCleanupInterval)
    }
    
    scheduleNextCleanup()
    
    // 注册清理资源
    if (asyncMonitor) {
      asyncMonitor.registerResource(
        this.cleanupTimer,
        () => {
          if (this.cleanupTimer) {
            clearTimeout(this.cleanupTimer)
            this.cleanupTimer = null
          }
        },
        { type: 'cache_cleanup_timer' }
      )
    }
  }

  /**
   * 智能清理：根据内存压力和缓存使用情况动态调整清理策略
   */
  intelligentCleanup() {
    const now = Date.now()
    
    // 检查内存压力
    const memoryPressure = this.checkMemoryPressure()
    this.memoryStats.memoryPressure = memoryPressure
    this.memoryStats.lastMemoryCheck = now
    
    let cleanedCount = 0
    let strategy = 'normal'
    
    if (memoryPressure > this.cleanupConfig.aggressiveCleanupThreshold) {
      // 激进清理：清理更多项目
      cleanedCount = this.aggressiveCleanup()
      strategy = 'aggressive'
      this.adjustCleanupInterval('decrease')
    } else if (memoryPressure > this.cleanupConfig.memoryPressureThreshold) {
      // 中等压力：标准清理
      cleanedCount = this.cleanup()
      strategy = 'standard'
      this.adjustCleanupInterval('maintain')
    } else {
      // 低压力：轻量清理
      cleanedCount = this.lightCleanup()
      strategy = 'light'
      this.adjustCleanupInterval('increase')
    }
    
    this.memoryStats.adaptiveCleanupCount++
    
    if (cleanedCount > 0) {
      console.log(`🧹 Intelligent cleanup (${strategy}): cleaned ${cleanedCount} items, memory pressure: ${(memoryPressure * 100).toFixed(2)}%`)
    }
  }

  /**
   * 检查内存压力
   */
  checkMemoryPressure() {
    if (memoryOptimizer) {
      const memoryInfo = memoryOptimizer.checkMemoryUsage()
      return memoryInfo ? memoryInfo.heapUsage : 0
    }
    
    // 简单的内存压力计算
    const memory = process.memoryUsage()
    return memory.heapUsed / memory.heapTotal
  }

  /**
   * 激进清理：在高内存压力下清理更多项目
   */
  aggressiveCleanup() {
    const now = Date.now()
    let cleanedCount = 0
    const maxAge = 2 * 60 * 1000 // 2分钟
    const targetReduction = Math.floor(this.cache.size * 0.3) // 清理30%
    
    const itemsToClean = []
    
    // 收集需要清理的项目
    for (const [key, item] of this.cache.entries()) {
      const age = now - item.lastAccessed
      const priority = this.calculateCleanupPriority(item, age)
      
      if (age > maxAge || priority < 0.3) {
        itemsToClean.push({ key, priority, age })
      }
    }
    
    // 按优先级排序（优先级低的先删）
    itemsToClean.sort((a, b) => a.priority - b.priority)
    
    // 删除项目
    const toDelete = Math.min(itemsToClean.length, targetReduction)
    for (let i = 0; i < toDelete; i++) {
      this.cache.delete(itemsToClean[i].key)
      cleanedCount++
    }
    
    this.lastCleanup = now
    return cleanedCount
  }

  /**
   * 轻量清理：在低内存压力下进行最小清理
   */
  lightCleanup() {
    const now = Date.now()
    let cleanedCount = 0
    const maxAge = 10 * 60 * 1000 // 10分钟
    
    for (const [key, item] of this.cache.entries()) {
      // 只清理明确过期的项目
      if (item.expiry && now > item.expiry) {
        this.cache.delete(key)
        cleanedCount++
      } else if (now - item.lastAccessed > maxAge) {
        // 或者很久未访问的项目
        this.cache.delete(key)
        cleanedCount++
      }
    }
    
    this.lastCleanup = now
    return cleanedCount
  }

  /**
   * 计算清理优先级（0-1，越低优先级越高，越容易被清理）
   */
  calculateCleanupPriority(item, age) {
    const now = Date.now()
    
    // 基础因子
    const ageFactor = Math.min(age / (10 * 60 * 1000), 1) // 年龄因子（0-1）
    const accessFactor = Math.min((now - item.lastAccessed) / (5 * 60 * 1000), 1) // 访问间隔因子
    
    // 过期因子
    let expiryFactor = 0
    if (item.expiry) {
      if (now > item.expiry) {
        expiryFactor = 1 // 已过期
      } else {
        const timeToExpiry = item.expiry - now
        expiryFactor = Math.max(0, 1 - timeToExpiry / (5 * 60 * 1000)) // 即将过期
      }
    }
    
    // 综合优先级（越低越容易被清理）
    return Math.max(0, 1 - (ageFactor * 0.4 + accessFactor * 0.4 + expiryFactor * 0.2))
  }

  /**
   * 调整清理间隔
   */
  adjustCleanupInterval(direction) {
    if (!this.cleanupConfig.adaptiveCleanup) {
      return
    }
    
    const { minCleanupInterval, maxCleanupInterval, baseInterval } = this.cleanupConfig
    
    switch (direction) {
      case 'decrease':
        // 增加清理频率
        this.currentCleanupInterval = Math.max(
          minCleanupInterval,
          this.currentCleanupInterval * 0.7
        )
        break
      case 'increase':
        // 降低清理频率
        this.currentCleanupInterval = Math.min(
          maxCleanupInterval,
          this.currentCleanupInterval * 1.3
        )
        break
      case 'maintain':
        // 保持或轻微调整向基础间隔
        const diff = baseInterval - this.currentCleanupInterval
        this.currentCleanupInterval += diff * 0.1
        break
    }
  }

  /**
   * 注册到内存优化器
   */
  registerWithMemoryOptimizer() {
    // 这将在之后由服务调用时实现
    // memoryOptimizer.registerCache(this)
  }

  /**
   * 获取增强的统计信息
   */
  getEnhancedStats() {
    const baseStats = this.getStats()
    return {
      ...baseStats,
      memoryStats: { ...this.memoryStats },
      cleanupConfig: { ...this.cleanupConfig },
      currentCleanupInterval: this.currentCleanupInterval,
      memoryPressure: this.memoryStats.memoryPressure,
      adaptiveCleanups: this.memoryStats.adaptiveCleanupCount
    }
  }

  /**
   * 清理所有资源
   */
  destroy() {
    // 清理定时器
    if (this.cleanupTimer) {
      clearTimeout(this.cleanupTimer)
      this.cleanupTimer = null
    }
    
    // 清空缓存
    this.clear()
    
    console.log('🗑️ Enhanced LRU Cache destroyed')
  }
}

module.exports = LRUCache
