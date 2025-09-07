/**
 * LRU (Least Recently Used) 缓存实现
 * 用于缓存解密结果，提高性能同时控制内存使用
 * 带有并发安全保护机制
 */
class LRUCache {
  constructor(maxSize = 500) {
    this.maxSize = maxSize
    this.cache = new Map()
    this.hits = 0
    this.misses = 0
    this.evictions = 0
    this.lastCleanup = Date.now()
    this.cleanupInterval = 5 * 60 * 1000 // 5分钟清理一次过期项

    // 🔒 并发安全保护
    this._operationLock = false
    this._lockQueue = []
  }

  /**
   * 获取缓存值
   * @param {string} key - 缓存键
   * @returns {*} 缓存的值，如果不存在则返回 undefined
   */
  async get(key) {
    return this._withLock(async () => {
      // 定期清理
      if (Date.now() - this.lastCleanup > this.cleanupInterval) {
        this._cleanupInternal()
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

      // 🔒 原子操作：更新访问时间，将元素移到最后（最近使用）
      this.cache.delete(key)
      this.cache.set(key, {
        ...item,
        lastAccessed: Date.now()
      })

      this.hits++
      return item.value
    })
  }

  /**
   * 设置缓存值
   * @param {string} key - 缓存键
   * @param {*} value - 要缓存的值
   * @param {number} ttl - 生存时间（毫秒），默认5分钟
   */
  async set(key, value, ttl = 5 * 60 * 1000) {
    return this._withLock(async () => {
      // 🔒 原子操作：如果缓存已满，删除最少使用的项
      if (this.cache.size >= this.maxSize && !this.cache.has(key)) {
        const firstKey = this.cache.keys().next().value
        if (firstKey) {
          this.cache.delete(firstKey)
          this.evictions++
        }
      }

      this.cache.set(key, {
        value,
        createdAt: Date.now(),
        lastAccessed: Date.now(),
        expiry: ttl ? Date.now() + ttl : null
      })
    })
  }

  /**
   * 清理过期项（异步版本）
   */
  async cleanup() {
    return this._withLock(async () => {
      this._cleanupInternal()
    })
  }

  /**
   * 内部清理方法（同步版本，在锁内调用）
   * @private
   */
  _cleanupInternal() {
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
  async clear() {
    return this._withLock(async () => {
      const { size } = this.cache
      this.cache.clear()
      this.hits = 0
      this.misses = 0
      this.evictions = 0
      console.log(`🗑️ LRU Cache: Cleared ${size} items`)
    })
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
   * 🔒 并发安全保护：在锁内执行操作
   * @param {Function} operation - 要执行的操作
   * @returns {Promise} 操作结果
   * @private
   */
  async _withLock(operation) {
    // 如果当前正在执行操作，加入队列等待
    if (this._operationLock) {
      return new Promise((resolve, reject) => {
        this._lockQueue.push(async () => {
          try {
            const result = await this._withLock(operation)
            resolve(result)
          } catch (error) {
            reject(error)
          }
        })
      })
    }

    // 获取锁
    this._operationLock = true

    try {
      // 执行操作
      const result = await operation()
      return result
    } finally {
      // 释放锁
      this._operationLock = false

      // 处理队列中的下一个操作
      if (this._lockQueue.length > 0) {
        const nextOperation = this._lockQueue.shift()
        // 使用 setImmediate 确保在下一个事件循环中执行
        setImmediate(() => nextOperation())
      }
    }
  }

  /**
   * 获取缓存值（同步版本，向后兼容）
   * 注意：这个方法不提供并发安全保护，建议使用 get() 方法
   * @deprecated 建议使用 async get() 方法
   */
  getSync(key) {
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

    this.hits++
    return item.value
  }
}

module.exports = LRUCache
