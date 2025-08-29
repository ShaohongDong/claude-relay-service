const logger = require('./logger')
const memoryOptimizer = require('./memoryOptimizer')
const asyncMonitor = require('./asyncMonitor')

/**
 * 批处理 Redis 操作管理器
 * 自动收集和批量执行 Redis 命令以提高性能
 */
class BatchOperationManager {
  constructor(redisClient) {
    this.client = redisClient
    this.pendingOperations = []
    this.batchTimeout = null
    this.config = {
      maxBatchSize: 100,      // 最大批处理大小
      batchDelayMs: 50,       // 批处理延迟时间（毫秒）
      maxRetries: 3,          // 最大重试次数
      retryDelayMs: 100       // 重试延迟时间
    }
    this.stats = {
      totalBatches: 0,
      totalOperations: 0,
      averageBatchSize: 0,
      errors: 0,
      retries: 0
    }
    
    // 创建操作对象池
    this.operationPool = memoryOptimizer.getObjectPool('batchOperation') || 
      memoryOptimizer.registerObjectPool(
        'batchOperation',
        () => ({
          command: '',
          args: [],
          resolve: null,
          reject: null,
          timestamp: 0
        }),
        (op) => {
          op.command = ''
          op.args.length = 0
          op.resolve = null
          op.reject = null
          op.timestamp = 0
        },
        50
      )
  }

  /**
   * 添加 Redis 操作到批处理队列
   */
  addOperation(command, args) {
    return new Promise((resolve, reject) => {
      const operation = this.operationPool.acquire()
      operation.command = command
      operation.args = [...args]
      operation.resolve = resolve
      operation.reject = reject
      operation.timestamp = Date.now()
      
      this.pendingOperations.push(operation)
      
      // 跟踪 Promise
      asyncMonitor.trackPromise(
        new Promise((res, rej) => {
          operation.resolve = (result) => {
            res(result)
            resolve(result)
          }
          operation.reject = (error) => {
            rej(error)
            reject(error)
          }
        }),
        {
          type: 'redis_batch_operation',
          command,
          timeout: 10000
        }
      )
      
      // 检查是否需要立即执行批处理
      if (this.pendingOperations.length >= this.config.maxBatchSize) {
        this.executeBatch()
      } else if (!this.batchTimeout) {
        // 设置延迟批处理
        this.batchTimeout = setTimeout(() => {
          this.executeBatch()
        }, this.config.batchDelayMs)
      }
    })
  }

  /**
   * 执行批处理操作
   */
  async executeBatch(retryCount = 0) {
    if (this.pendingOperations.length === 0) {
      return
    }
    
    // 清除超时定时器
    if (this.batchTimeout) {
      clearTimeout(this.batchTimeout)
      this.batchTimeout = null
    }
    
    const operations = [...this.pendingOperations]
    this.pendingOperations.length = 0
    
    try {
      const pipeline = this.client.pipeline()
      
      // 添加所有操作到 pipeline
      operations.forEach(op => {
        pipeline[op.command](...op.args)
      })
      
      // 执行 pipeline
      const results = await pipeline.exec()
      
      // 处理结果
      this.processResults(operations, results)
      
      // 更新统计信息
      this.updateStats(operations.length, true)
      
      logger.debug(`📦 Executed Redis batch: ${operations.length} operations`)
      
    } catch (error) {
      logger.error('❌ Redis batch execution failed:', error)
      
      // 重试逻辑
      if (retryCount < this.config.maxRetries) {
        this.stats.retries++
        logger.warn(`🔄 Retrying Redis batch (attempt ${retryCount + 1}/${this.config.maxRetries})`)
        
        // 延迟重试
        setTimeout(() => {
          // 将操作重新添加到队列
          this.pendingOperations.unshift(...operations)
          this.executeBatch(retryCount + 1)
        }, this.config.retryDelayMs * Math.pow(2, retryCount))
        
      } else {
        // 重试失败，拒绝所有操作
        operations.forEach(op => {
          if (op.reject) {
            op.reject(error)
          }
          if (op._poolRelease) {
            op._poolRelease()
          }
        })
        
        this.updateStats(operations.length, false)
      }
    }
  }

  /**
   * 处理批处理结果
   */
  processResults(operations, results) {
    operations.forEach((op, index) => {
      try {
        const [error, result] = results[index]
        
        if (error) {
          if (op.reject) {
            op.reject(error)
          }
        } else {
          if (op.resolve) {
            op.resolve(result)
          }
        }
        
        // 释放操作对象回池
        if (op._poolRelease) {
          op._poolRelease()
        }
        
      } catch (processError) {
        logger.error(`❌ Error processing batch result ${index}:`, processError)
        
        if (op.reject) {
          op.reject(processError)
        }
        
        if (op._poolRelease) {
          op._poolRelease()
        }
      }
    })
  }

  /**
   * 更新统计信息
   */
  updateStats(operationCount, success) {
    this.stats.totalBatches++
    this.stats.totalOperations += operationCount
    
    if (!success) {
      this.stats.errors++
    }
    
    // 计算平均批处理大小
    this.stats.averageBatchSize = this.stats.totalOperations / this.stats.totalBatches
  }

  /**
   * 强制执行所有待处理操作
   */
  async flush() {
    if (this.pendingOperations.length > 0) {
      await this.executeBatch()
    }
  }

  /**
   * 获取统计信息
   */
  getStats() {
    return {
      ...this.stats,
      pendingOperations: this.pendingOperations.length,
      config: { ...this.config }
    }
  }

  /**
   * 配置批处理参数
   */
  configure(newConfig) {
    this.config = { ...this.config, ...newConfig }
    logger.info('⚙️ Redis batch manager configured:', this.config)
  }

  /**
   * 清理资源
   */
  cleanup() {
    if (this.batchTimeout) {
      clearTimeout(this.batchTimeout)
      this.batchTimeout = null
    }
    
    // 拒绝所有待处理操作
    this.pendingOperations.forEach(op => {
      if (op.reject) {
        op.reject(new Error('Batch manager is shutting down'))
      }
      if (op._poolRelease) {
        op._poolRelease()
      }
    })
    
    this.pendingOperations.length = 0
    
    logger.info('🧹 Redis batch manager cleaned up')
  }
}

/**
 * 智能 Redis Pipeline 优化器
 * 提供高级的 Pipeline 管理和优化功能
 */
class OptimizedRedisPipeline {
  constructor(redisClient) {
    this.client = redisClient
    this.batchManager = new BatchOperationManager(redisClient)
    
    // 智能 Pipeline 配置
    this.config = {
      enableBatching: true,           // 启用批处理
      enableIntelligentDelay: true,   // 启用智能延迟
      enableCompression: false,       // 启用数据压缩
      maxPipelineSize: 1000,         // 最大 Pipeline 大小
      intelligentDelayThreshold: 10,  // 智能延迟阈值
      compressionThreshold: 1024      // 压缩阈值（字节）
    }
    
    this.stats = {
      totalPipelines: 0,
      totalCommands: 0,
      savedRoundTrips: 0,
      compressionSavings: 0
    }
  }

  /**
   * 创建优化的 Pipeline
   */
  createPipeline() {
    return new OptimizedPipeline(this.client, this.config, this.stats)
  }

  /**
   * 批处理操作（自动优化）
   */
  async batch(operations) {
    if (!this.config.enableBatching) {
      // 如果禁用批处理，使用传统 Pipeline
      return this.executePipeline(operations)
    }
    
    // 使用批处理管理器
    const promises = operations.map(op => {
      const { command, args } = op
      return this.batchManager.addOperation(command, args || [])
    })
    
    return Promise.all(promises)
  }

  /**
   * 执行传统 Pipeline
   */
  async executePipeline(operations) {
    const pipeline = this.client.pipeline()
    
    operations.forEach(op => {
      const { command, args } = op
      pipeline[command](...(args || []))
    })
    
    const results = await pipeline.exec()
    this.stats.totalPipelines++
    this.stats.totalCommands += operations.length
    
    return results.map(([error, result]) => {
      if (error) throw error
      return result
    })
  }

  /**
   * 智能批处理统计操作
   * 专门优化使用统计相关的 Redis 操作
   */
  async batchUsageStats(operations) {
    // 按键分组操作，减少命令数量
    const groupedOps = this.groupOperationsByKey(operations)
    
    // 使用批处理管理器执行分组操作
    const promises = []
    
    for (const [key, ops] of groupedOps) {
      // 合并同类操作
      const mergedOps = this.mergeOperations(ops)
      
      for (const op of mergedOps) {
        promises.push(
          this.batchManager.addOperation(op.command, [key, ...op.args])
        )
      }
    }
    
    return Promise.all(promises)
  }

  /**
   * 按键分组操作
   */
  groupOperationsByKey(operations) {
    const grouped = new Map()
    
    operations.forEach(op => {
      const key = op.key
      if (!grouped.has(key)) {
        grouped.set(key, [])
      }
      grouped.get(key).push(op)
    })
    
    return grouped
  }

  /**
   * 合并同类操作
   */
  mergeOperations(operations) {
    const merged = new Map()
    
    operations.forEach(op => {
      const { command, field, value } = op
      const opKey = `${command}:${field}`
      
      if (command === 'hincrby' && merged.has(opKey)) {
        // 合并 hincrby 操作
        merged.get(opKey).args[1] += value
      } else {
        merged.set(opKey, {
          command,
          args: field ? [field, value] : [value]
        })
      }
    })
    
    return Array.from(merged.values())
  }

  /**
   * 获取完整统计信息
   */
  getStats() {
    return {
      pipeline: { ...this.stats },
      batch: this.batchManager.getStats(),
      config: { ...this.config }
    }
  }

  /**
   * 配置优化器
   */
  configure(newConfig) {
    this.config = { ...this.config, ...newConfig }
    
    // 配置批处理管理器
    if (newConfig.batchConfig) {
      this.batchManager.configure(newConfig.batchConfig)
    }
    
    logger.info('⚙️ Redis pipeline optimizer configured:', this.config)
  }

  /**
   * 强制刷新所有待处理操作
   */
  async flush() {
    await this.batchManager.flush()
  }

  /**
   * 清理资源
   */
  cleanup() {
    this.batchManager.cleanup()
    logger.info('🧹 Redis pipeline optimizer cleaned up')
  }
}

/**
 * 优化的 Pipeline 实例
 */
class OptimizedPipeline {
  constructor(client, config, stats) {
    this.client = client
    this.config = config
    this.stats = stats
    this.pipeline = client.pipeline()
    this.commandCount = 0
    
    // 使用对象池管理命令
    this.bufferPool = memoryOptimizer.getBufferPool()
  }

  /**
   * 添加命令到 Pipeline
   */
  addCommand(command, ...args) {
    this.pipeline[command](...args)
    this.commandCount++
    
    // 检查是否超过最大 Pipeline 大小
    if (this.commandCount >= this.config.maxPipelineSize) {
      logger.warn(`⚠️ Pipeline size limit reached: ${this.commandCount}`)
    }
    
    return this
  }

  /**
   * 执行 Pipeline
   */
  async exec() {
    if (this.commandCount === 0) {
      return []
    }
    
    try {
      const startTime = Date.now()
      const results = await this.pipeline.exec()
      const duration = Date.now() - startTime
      
      // 更新统计信息
      this.stats.totalPipelines++
      this.stats.totalCommands += this.commandCount
      this.stats.savedRoundTrips += Math.max(0, this.commandCount - 1)
      
      logger.debug(`📊 Pipeline executed: ${this.commandCount} commands in ${duration}ms`)
      
      return results
      
    } catch (error) {
      logger.error('❌ Pipeline execution failed:', error)
      throw error
    }
  }

  /**
   * 获取命令数量
   */
  getCommandCount() {
    return this.commandCount
  }
}

module.exports = OptimizedRedisPipeline