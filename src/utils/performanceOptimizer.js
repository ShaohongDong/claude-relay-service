const { v4: uuidv4 } = require('uuid')
const logger = require('./logger')

/**
 * 性能优化器 - 减少深拷贝和提高请求处理效率
 * 功能：
 * - 智能浅拷贝+按需深拷贝策略
 * - 对象复用池机制
 * - 系统提示词预编译和缓存
 * - 配置数据本地缓存
 */
class PerformanceOptimizer {
  constructor() {
    // 对象复用池
    this.objectPool = {
      uuids: [], // UUID复用池
      requestContexts: [], // 请求上下文对象池
      systemPrompts: new Map(), // 系统提示词缓存
      accountConfigs: new Map(), // 账户配置缓存
      regexCache: new Map() // 正则表达式缓存
    }

    // 缓存TTL配置
    this.cacheTTL = {
      systemPrompts: 5 * 60 * 1000, // 5分钟
      accountConfigs: 30 * 1000, // 30秒
      regexCache: 10 * 60 * 1000 // 10分钟
    }

    // 预编译常用的系统提示词
    this.precompiledPrompts = new Map()
    this.initializePrecompiledPrompts()

    logger.info('🚀 性能优化器已初始化')
  }

  /**
   * 智能拷贝请求体 - 根据需要选择浅拷贝或深拷贝
   * @param {object} body - 原始请求体
   * @param {boolean} needsSystemModification - 是否需要修改system字段
   * @param {boolean} needsDeepCopy - 是否强制深拷贝
   * @returns {object} 优化后的请求体副本
   */
  smartCopyRequestBody(body, needsSystemModification = false, needsDeepCopy = false) {
    if (!body || typeof body !== 'object') {
      return body
    }

    const startTime = process.hrtime.bigint()

    let result
    if (needsDeepCopy || this._needsDeepCopy(body, needsSystemModification)) {
      // 需要深拷贝的场景：复杂嵌套结构或系统字段修改
      result = this._optimizedDeepCopy(body)
      logger.debug('🔄 使用优化深拷贝策略')
    } else {
      // 大多数情况使用浅拷贝+字段级修改
      result = this._smartShallowCopy(body, needsSystemModification)
      logger.debug('⚡ 使用智能浅拷贝策略')
    }

    const endTime = process.hrtime.bigint()
    const durationMs = Number(endTime - startTime) / 1000000

    if (durationMs > 5) {
      logger.debug(`📊 请求体拷贝耗时: ${durationMs.toFixed(2)}ms`)
    }

    return result
  }

  /**
   * 智能浅拷贝 - 只在需要时拷贝特定字段
   * @param {object} body - 原始请求体
   * @param {boolean} needsSystemModification - 是否需要修改system字段
   * @returns {object} 浅拷贝结果
   * @private
   */
  _smartShallowCopy(body, needsSystemModification) {
    const result = { ...body }

    // 如果需要修改system字段，对其进行深拷贝
    if (needsSystemModification && body.system) {
      if (Array.isArray(body.system)) {
        result.system = [...body.system.map((item) => ({ ...item }))]
      } else if (typeof body.system === 'string') {
        result.system = body.system // 字符串是不可变的，直接复用
      } else {
        result.system = { ...body.system }
      }
    }

    // 如果有messages且包含复杂结构，进行选择性深拷贝
    if (body.messages && Array.isArray(body.messages) && this._hasComplexMessages(body.messages)) {
      result.messages = body.messages.map((msg) => {
        if (Array.isArray(msg.content)) {
          return { ...msg, content: [...msg.content.map((item) => ({ ...item }))] }
        }
        return { ...msg }
      })
    }

    return result
  }

  /**
   * 优化的深拷贝 - 避免JSON.parse(JSON.stringify)的性能开销
   * @param {object} obj - 要拷贝的对象
   * @returns {object} 深拷贝结果
   * @private
   */
  _optimizedDeepCopy(obj) {
    if (obj === null || typeof obj !== 'object') {
      return obj
    }

    if (Array.isArray(obj)) {
      return obj.map((item) => this._optimizedDeepCopy(item))
    }

    const result = {}
    for (const key in obj) {
      if (obj.hasOwnProperty(key)) {
        result[key] = this._optimizedDeepCopy(obj[key])
      }
    }

    return result
  }

  /**
   * 判断是否需要深拷贝
   * @param {object} body - 请求体
   * @param {boolean} needsSystemModification - 是否需要修改system
   * @returns {boolean} 是否需要深拷贝
   * @private
   */
  _needsDeepCopy(body, needsSystemModification) {
    // 简单对象且不需要修改system字段，使用浅拷贝
    if (!needsSystemModification && this._isSimpleObject(body)) {
      return false
    }

    // 复杂嵌套结构或需要修改system字段，使用深拷贝
    return true
  }

  /**
   * 检查是否为简单对象（没有深层嵌套）
   * @param {object} obj - 要检查的对象
   * @returns {boolean} 是否为简单对象
   * @private
   */
  _isSimpleObject(obj) {
    if (!obj || typeof obj !== 'object') {
      return true
    }

    for (const key in obj) {
      if (obj.hasOwnProperty(key)) {
        const value = obj[key]
        if (Array.isArray(value) && value.length > 0) {
          // 检查数组元素是否为简单类型
          const hasComplexItem = value.some((item) => typeof item === 'object' && item !== null)
          if (hasComplexItem) {
            return false
          }
        } else if (typeof value === 'object' && value !== null) {
          return false
        }
      }
    }

    return true
  }

  /**
   * 检查消息是否包含复杂结构
   * @param {Array} messages - 消息数组
   * @returns {boolean} 是否包含复杂结构
   * @private
   */
  _hasComplexMessages(messages) {
    return messages.some((msg) => Array.isArray(msg.content))
  }

  /**
   * 获取复用的UUID - 从对象池或创建新的
   * @returns {string} UUID
   */
  getPooledUUID() {
    if (this.objectPool.uuids.length > 0) {
      return this.objectPool.uuids.pop()
    }
    return uuidv4()
  }

  /**
   * 回收UUID到对象池
   * @param {string} uuid - 要回收的UUID
   */
  recycleUUID(uuid) {
    if (this.objectPool.uuids.length < 50) {
      // 限制池大小
      this.objectPool.uuids.push(uuid)
    }
  }

  /**
   * 获取复用的请求上下文对象
   * @returns {object} 请求上下文对象
   */
  getPooledRequestContext() {
    if (this.objectPool.requestContexts.length > 0) {
      const context = this.objectPool.requestContexts.pop()
      // 重置对象属性
      Object.keys(context).forEach((key) => delete context[key])
      return context
    }
    return {}
  }

  /**
   * 回收请求上下文对象到池中
   * @param {object} context - 要回收的上下文对象
   */
  recycleRequestContext(context) {
    if (this.objectPool.requestContexts.length < 20) {
      // 限制池大小
      this.objectPool.requestContexts.push(context)
    }
  }

  /**
   * 初始化预编译的系统提示词
   * @private
   */
  initializePrecompiledPrompts() {
    const claudeCodePrompt = "You are Claude Code, Anthropic's official CLI for Claude."

    // 预编译常用的系统提示词组合
    this.precompiledPrompts.set('claude_code_only', [
      {
        type: 'text',
        text: claudeCodePrompt,
        cache_control: { type: 'ephemeral' }
      }
    ])

    this.precompiledPrompts.set('claude_code_with_string', (userPrompt) => [
      {
        type: 'text',
        text: claudeCodePrompt,
        cache_control: { type: 'ephemeral' }
      },
      {
        type: 'text',
        text: userPrompt
      }
    ])

    logger.debug('📝 预编译系统提示词已初始化')
  }

  /**
   * 获取预编译的系统提示词
   * @param {string} key - 提示词键
   * @param {any} param - 参数
   * @returns {Array|null} 预编译的提示词数组
   */
  getPrecompiledPrompt(key, param = null) {
    const template = this.precompiledPrompts.get(key)
    if (typeof template === 'function') {
      return template(param)
    }
    return template || null
  }

  /**
   * 缓存账户配置
   * @param {string} accountId - 账户ID
   * @param {object} config - 配置对象
   */
  cacheAccountConfig(accountId, config) {
    const cacheKey = `account_${accountId}`
    this.objectPool.accountConfigs.set(cacheKey, {
      data: config,
      timestamp: Date.now()
    })
  }

  /**
   * 获取缓存的账户配置
   * @param {string} accountId - 账户ID
   * @returns {object|null} 配置对象或null
   */
  getCachedAccountConfig(accountId) {
    const cacheKey = `account_${accountId}`
    const cached = this.objectPool.accountConfigs.get(cacheKey)

    if (!cached) {
      return null
    }

    // 检查TTL
    if (Date.now() - cached.timestamp > this.cacheTTL.accountConfigs) {
      this.objectPool.accountConfigs.delete(cacheKey)
      return null
    }

    return cached.data
  }

  /**
   * 获取缓存的正则表达式
   * @param {string} pattern - 正则模式
   * @param {string} flags - 正则标志
   * @returns {RegExp} 正则表达式对象
   */
  getCachedRegExp(pattern, flags = '') {
    const cacheKey = `${pattern}_${flags}`

    if (!this.objectPool.regexCache.has(cacheKey)) {
      this.objectPool.regexCache.set(cacheKey, {
        regex: new RegExp(pattern, flags),
        timestamp: Date.now()
      })
    }

    const cached = this.objectPool.regexCache.get(cacheKey)

    // 检查TTL
    if (Date.now() - cached.timestamp > this.cacheTTL.regexCache) {
      this.objectPool.regexCache.delete(cacheKey)
      return new RegExp(pattern, flags)
    }

    return cached.regex
  }

  /**
   * 清理过期缓存
   */
  cleanupExpiredCache() {
    const now = Date.now()

    // 清理账户配置缓存
    for (const [key, value] of this.objectPool.accountConfigs.entries()) {
      if (now - value.timestamp > this.cacheTTL.accountConfigs) {
        this.objectPool.accountConfigs.delete(key)
      }
    }

    // 清理正则缓存
    for (const [key, value] of this.objectPool.regexCache.entries()) {
      if (now - value.timestamp > this.cacheTTL.regexCache) {
        this.objectPool.regexCache.delete(key)
      }
    }

    // 限制对象池大小
    if (this.objectPool.uuids.length > 50) {
      this.objectPool.uuids.splice(50)
    }
    if (this.objectPool.requestContexts.length > 20) {
      this.objectPool.requestContexts.splice(20)
    }
  }

  /**
   * 获取性能统计信息
   * @returns {object} 统计信息
   */
  getStats() {
    return {
      objectPool: {
        uuids: this.objectPool.uuids.length,
        requestContexts: this.objectPool.requestContexts.length,
        systemPrompts: this.precompiledPrompts.size,
        accountConfigs: this.objectPool.accountConfigs.size,
        regexCache: this.objectPool.regexCache.size
      },
      cacheTTL: this.cacheTTL,
      memoryUsage: process.memoryUsage()
    }
  }

  /**
   * 启动定期清理任务
   */
  startCleanupTask() {
    // 每5分钟清理一次过期缓存
    this.cleanupInterval = setInterval(
      () => {
        this.cleanupExpiredCache()
        logger.debug('🧹 执行定期缓存清理')
      },
      5 * 60 * 1000
    )

    logger.info('🕐 性能优化器定期清理任务已启动')
  }

  /**
   * 停止清理任务
   */
  stopCleanupTask() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval)
      this.cleanupInterval = null
      logger.info('🛑 性能优化器定期清理任务已停止')
    }
  }

  /**
   * 销毁优化器，释放资源
   */
  destroy() {
    this.stopCleanupTask()

    // 清空所有缓存
    this.objectPool.uuids = []
    this.objectPool.requestContexts = []
    this.objectPool.accountConfigs.clear()
    this.objectPool.regexCache.clear()
    this.precompiledPrompts.clear()

    logger.info('🗑️ 性能优化器已销毁')
  }
}

// 创建单例实例
const performanceOptimizer = new PerformanceOptimizer()

// 启动定期清理任务
performanceOptimizer.startCleanupTask()

// 进程退出时清理资源
process.on('exit', () => {
  performanceOptimizer.destroy()
})

module.exports = performanceOptimizer
