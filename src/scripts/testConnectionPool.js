#!/usr/bin/env node

/**
 * 连接池自动重连功能和响应时间测试脚本
 * 
 * 测试内容：
 * 1. 连接池预热效果（延迟从1.7秒降低到50-200ms）
 * 2. 事件驱动自动重连功能（1-3秒响应时间）
 * 3. 连接失败恢复能力
 * 4. 系统整体稳定性
 */

const redis = require('../models/redis')
const logger = require('../utils/logger')
const ProxyHelper = require('../utils/proxyHelper')
const { performance } = require('perf_hooks')

class ConnectionPoolTester {
  constructor() {
    this.testResults = {
      preheatTests: [],
      reconnectionTests: [],
      performanceTests: [],
      stabilityTests: []
    }
    
    this.testAccounts = []
    this.poolManager = null
    this.hybridManager = null
    this.lifecycleManager = null
  }

  async initialize() {
    logger.info('🚀 初始化连接池测试环境...')
    
    try {
      // 连接Redis
      if (!redis.isConnected) {
        await redis.connect()
      }
      
      // 获取测试账户
      await this.loadTestAccounts()
      
      // 初始化连接池系统（独立测试实例）
      await this.initializeConnectionPoolSystem()
      
      logger.success('✅ 测试环境初始化完成')
    } catch (error) {
      logger.error('❌ 测试环境初始化失败:', error.message)
      throw error
    }
  }

  async loadTestAccounts() {
    try {
      const accountKeys = await redis.client.keys('claude:account:*')
      
      for (const key of accountKeys.slice(0, 3)) { // 限制测试账户数量
        const accountData = await redis.client.hgetall(key)
        if (accountData && accountData.id && accountData.proxy) {
          this.testAccounts.push({
            id: accountData.id,
            name: accountData.name || `测试账户-${accountData.id.slice(0, 8)}`,
            proxy: JSON.parse(accountData.proxy)
          })
        }
      }
      
      if (this.testAccounts.length === 0) {
        throw new Error('未找到可用的测试账户')
      }
      
      logger.info(`📋 加载测试账户: ${this.testAccounts.length}个`)
    } catch (error) {
      logger.error('❌ 加载测试账户失败:', error.message)
      throw error
    }
  }

  async initializeConnectionPoolSystem() {
    try {
      // 使用测试专用的连接池系统
      const globalConnectionPoolManager = require('../services/globalConnectionPoolManager')
      this.poolManager = globalConnectionPoolManager
      
      const HybridConnectionManager = require('../services/hybridConnectionManager')
      this.hybridManager = new HybridConnectionManager(this.poolManager)
      
      const ConnectionLifecycleManager = require('../services/connectionLifecycleManager')
      this.lifecycleManager = new ConnectionLifecycleManager()
      
      // 初始化连接池
      if (!this.poolManager.isInitialized) {
        await this.poolManager.initializeAllPools()
      }
      
      // 启动管理器
      await this.hybridManager.start()
      this.lifecycleManager.start()
      
      logger.info('🔗 连接池测试系统已就绪')
    } catch (error) {
      logger.error('❌ 连接池系统初始化失败:', error.message)
      throw error
    }
  }

  // 测试1: 连接预热效果测试
  async testConnectionPreheat() {
    logger.info('🔥 开始连接预热效果测试...')
    
    for (const account of this.testAccounts) {
      try {
        // 测试预热连接的响应时间
        const startTime = performance.now()
        const connection = ProxyHelper.getConnectionForAccount(account.id)
        const endTime = performance.now()
        
        const latency = endTime - startTime
        
        this.testResults.preheatTests.push({
          accountId: account.id,
          accountName: account.name,
          latency: latency,
          connectionId: connection.connectionId,
          success: true,
          timestamp: new Date().toISOString()
        })
        
        logger.info(`🔥 预热测试 - ${account.name}: ${latency.toFixed(2)}ms`)
        
        // 验证延迟是否在预期范围内（50-200ms）
        if (latency <= 200) {
          logger.success(`✅ 预热效果良好: ${latency.toFixed(2)}ms <= 200ms`)
        } else if (latency <= 500) {
          logger.warn(`⚠️ 预热效果一般: ${latency.toFixed(2)}ms > 200ms`)
        } else {
          logger.error(`❌ 预热效果较差: ${latency.toFixed(2)}ms > 500ms`)
        }
        
      } catch (error) {
        logger.error(`❌ 预热测试失败 - ${account.name}: ${error.message}`)
        this.testResults.preheatTests.push({
          accountId: account.id,
          accountName: account.name,
          latency: null,
          success: false,
          error: error.message,
          timestamp: new Date().toISOString()
        })
      }
    }
  }

  // 测试2: 自动重连功能测试
  async testAutoReconnection() {
    logger.info('🔄 开始自动重连功能测试...')
    
    for (const account of this.testAccounts) {
      try {
        // 获取连接池
        const pool = this.poolManager.pools.get(account.id)
        if (!pool) {
          logger.warn(`⚠️ 账户连接池不存在: ${account.id}`)
          continue
        }
        
        // 模拟连接断开
        logger.info(`🔌 模拟连接断开: ${account.name}`)
        const startTime = performance.now()
        
        // 强制断开连接（模拟网络故障）
        await this.simulateConnectionFailure(pool, account.id)
        
        // 等待自动重连
        const reconnectionResult = await this.waitForReconnection(pool, account.id, 10000)
        const endTime = performance.now()
        
        const reconnectionTime = endTime - startTime
        
        this.testResults.reconnectionTests.push({
          accountId: account.id,
          accountName: account.name,
          reconnectionTime: reconnectionTime,
          success: reconnectionResult.success,
          reconnectionCount: reconnectionResult.attempts,
          timestamp: new Date().toISOString()
        })
        
        if (reconnectionResult.success) {
          logger.success(`✅ 自动重连成功 - ${account.name}: ${reconnectionTime.toFixed(2)}ms`)
          
          // 验证重连时间是否在预期范围内（1-3秒）
          if (reconnectionTime <= 3000) {
            logger.success(`✅ 重连时间符合预期: ${reconnectionTime.toFixed(2)}ms <= 3000ms`)
          } else {
            logger.warn(`⚠️ 重连时间超出预期: ${reconnectionTime.toFixed(2)}ms > 3000ms`)
          }
        } else {
          logger.error(`❌ 自动重连失败 - ${account.name}: 超时`)
        }
        
      } catch (error) {
        logger.error(`❌ 重连测试失败 - ${account.name}: ${error.message}`)
        this.testResults.reconnectionTests.push({
          accountId: account.id,
          accountName: account.name,
          reconnectionTime: null,
          success: false,
          error: error.message,
          timestamp: new Date().toISOString()
        })
      }
    }
  }

  // 测试3: 性能压力测试
  async testPerformanceUnderLoad() {
    logger.info('⚡ 开始性能压力测试...')
    
    const testConcurrency = 10
    const testDuration = 30000 // 30秒
    
    for (const account of this.testAccounts) {
      try {
        const startTime = performance.now()
        const promises = []
        let successCount = 0
        let errorCount = 0
        let totalLatency = 0
        
        logger.info(`⚡ 启动并发测试: ${account.name} (${testConcurrency}并发)`)
        
        // 启动并发测试
        for (let i = 0; i < testConcurrency; i++) {
          promises.push(this.performConcurrentConnectionTest(account, testDuration)
            .then(result => {
              if (result.success) {
                successCount++
                totalLatency += result.avgLatency
              } else {
                errorCount++
              }
            })
            .catch(() => errorCount++))
        }
        
        await Promise.all(promises)
        
        const endTime = performance.now()
        const testTime = endTime - startTime
        const avgLatency = successCount > 0 ? totalLatency / successCount : 0
        
        this.testResults.performanceTests.push({
          accountId: account.id,
          accountName: account.name,
          testDuration: testTime,
          concurrency: testConcurrency,
          successCount: successCount,
          errorCount: errorCount,
          avgLatency: avgLatency,
          throughput: (successCount / (testTime / 1000)).toFixed(2),
          timestamp: new Date().toISOString()
        })
        
        logger.info(`⚡ 性能测试完成 - ${account.name}: ${successCount}成功/${errorCount}失败, 平均延迟: ${avgLatency.toFixed(2)}ms`)
        
      } catch (error) {
        logger.error(`❌ 性能测试失败 - ${account.name}: ${error.message}`)
      }
    }
  }

  // 测试4: 系统稳定性测试
  async testSystemStability() {
    logger.info('🛡️ 开始系统稳定性测试...')
    
    const testDuration = 60000 // 1分钟
    const startTime = performance.now()
    
    let totalOperations = 0
    let successOperations = 0
    let errorOperations = 0
    
    const stabilityInterval = setInterval(async () => {
      for (const account of this.testAccounts) {
        try {
          totalOperations++
          
          // 随机执行不同类型的操作
          const operation = Math.floor(Math.random() * 3)
          
          switch (operation) {
            case 0:
              // 获取连接测试
              ProxyHelper.getConnectionForAccount(account.id)
              break
            case 1:
              // 健康检查测试
              await this.poolManager.performHealthCheck()
              break
            case 2:
              // 连接池状态查询
              this.poolManager.getPoolStatus(account.id)
              break
          }
          
          successOperations++
        } catch (error) {
          errorOperations++
          logger.debug(`稳定性测试操作失败: ${error.message}`)
        }
      }
    }, 1000) // 每秒执行一次
    
    // 等待测试完成
    await new Promise(resolve => setTimeout(resolve, testDuration))
    clearInterval(stabilityInterval)
    
    const endTime = performance.now()
    const actualDuration = endTime - startTime
    
    const successRate = totalOperations > 0 ? (successOperations / totalOperations) * 100 : 0
    
    this.testResults.stabilityTests.push({
      testDuration: actualDuration,
      totalOperations: totalOperations,
      successOperations: successOperations,
      errorOperations: errorOperations,
      successRate: successRate,
      opsPerSecond: (totalOperations / (actualDuration / 1000)).toFixed(2),
      timestamp: new Date().toISOString()
    })
    
    logger.info(`🛡️ 稳定性测试完成: ${successOperations}/${totalOperations} (${successRate.toFixed(2)}%成功率)`)
    
    if (successRate >= 95) {
      logger.success(`✅ 系统稳定性优秀: ${successRate.toFixed(2)}%`)
    } else if (successRate >= 90) {
      logger.warn(`⚠️ 系统稳定性良好: ${successRate.toFixed(2)}%`)
    } else {
      logger.error(`❌ 系统稳定性较差: ${successRate.toFixed(2)}%`)
    }
  }

  // 模拟连接失败
  async simulateConnectionFailure(pool, accountId) {
    try {
      // 强制销毁当前连接
      if (pool.connections && pool.connections.size > 0) {
        for (const [connectionId, connection] of pool.connections) {
          if (connection.agent && connection.agent.destroy) {
            connection.agent.destroy()
            logger.debug(`🔌 强制断开连接: ${connectionId}`)
            break
          }
        }
      }
    } catch (error) {
      logger.debug(`模拟连接失败过程中的错误: ${error.message}`)
    }
  }

  // 等待自动重连
  async waitForReconnection(pool, accountId, timeout = 5000) {
    return new Promise((resolve) => {
      let attempts = 0
      const maxAttempts = timeout / 100
      
      const checkConnection = async () => {
        attempts++
        
        try {
          // 尝试获取新连接
          const connection = ProxyHelper.getConnectionForAccount(accountId)
          if (connection && connection.connectionId) {
            resolve({ success: true, attempts: attempts })
            return
          }
        } catch (error) {
          // 连接还未恢复
        }
        
        if (attempts >= maxAttempts) {
          resolve({ success: false, attempts: attempts })
        } else {
          setTimeout(checkConnection, 100)
        }
      }
      
      setTimeout(checkConnection, 100)
    })
  }

  // 并发连接测试
  async performConcurrentConnectionTest(account, duration) {
    const startTime = performance.now()
    const latencies = []
    let operations = 0
    
    return new Promise((resolve) => {
      const testInterval = setInterval(() => {
        try {
          const opStart = performance.now()
          ProxyHelper.getConnectionForAccount(account.id)
          const opEnd = performance.now()
          
          latencies.push(opEnd - opStart)
          operations++
        } catch (error) {
          // 操作失败
        }
      }, 100)
      
      setTimeout(() => {
        clearInterval(testInterval)
        const avgLatency = latencies.length > 0 ? 
          latencies.reduce((sum, lat) => sum + lat, 0) / latencies.length : 0
        
        resolve({
          success: latencies.length > 0,
          operations: operations,
          avgLatency: avgLatency,
          duration: performance.now() - startTime
        })
      }, duration)
    })
  }

  // 生成测试报告
  generateReport() {
    logger.info('📊 生成测试报告...')
    
    const report = {
      summary: {
        totalAccounts: this.testAccounts.length,
        testStartTime: new Date().toISOString(),
        testResults: this.testResults
      },
      preheatAnalysis: this.analyzePreheatResults(),
      reconnectionAnalysis: this.analyzeReconnectionResults(),
      performanceAnalysis: this.analyzePerformanceResults(),
      stabilityAnalysis: this.analyzeStabilityResults(),
      recommendations: this.generateRecommendations()
    }
    
    return report
  }

  analyzePreheatResults() {
    const results = this.testResults.preheatTests
    const successResults = results.filter(r => r.success)
    
    if (successResults.length === 0) {
      return { status: 'failed', message: '所有预热测试均失败' }
    }
    
    const avgLatency = successResults.reduce((sum, r) => sum + r.latency, 0) / successResults.length
    const maxLatency = Math.max(...successResults.map(r => r.latency))
    const minLatency = Math.min(...successResults.map(r => r.latency))
    
    return {
      status: avgLatency <= 200 ? 'excellent' : avgLatency <= 500 ? 'good' : 'poor',
      avgLatency: avgLatency.toFixed(2),
      maxLatency: maxLatency.toFixed(2),
      minLatency: minLatency.toFixed(2),
      successRate: ((successResults.length / results.length) * 100).toFixed(2),
      improvement: ((1700 - avgLatency) / 1700 * 100).toFixed(2) // 相对于1.7秒的改进
    }
  }

  analyzeReconnectionResults() {
    const results = this.testResults.reconnectionTests
    const successResults = results.filter(r => r.success)
    
    if (successResults.length === 0) {
      return { status: 'failed', message: '所有重连测试均失败' }
    }
    
    const avgReconnectionTime = successResults.reduce((sum, r) => sum + r.reconnectionTime, 0) / successResults.length
    const maxReconnectionTime = Math.max(...successResults.map(r => r.reconnectionTime))
    
    return {
      status: avgReconnectionTime <= 3000 ? 'excellent' : avgReconnectionTime <= 5000 ? 'good' : 'poor',
      avgReconnectionTime: avgReconnectionTime.toFixed(2),
      maxReconnectionTime: maxReconnectionTime.toFixed(2),
      successRate: ((successResults.length / results.length) * 100).toFixed(2)
    }
  }

  analyzePerformanceResults() {
    const results = this.testResults.performanceTests
    
    if (results.length === 0) {
      return { status: 'no_data', message: '无性能测试数据' }
    }
    
    const avgThroughput = results.reduce((sum, r) => sum + parseFloat(r.throughput), 0) / results.length
    const avgLatency = results.reduce((sum, r) => sum + r.avgLatency, 0) / results.length
    const totalSuccess = results.reduce((sum, r) => sum + r.successCount, 0)
    const totalErrors = results.reduce((sum, r) => sum + r.errorCount, 0)
    
    return {
      status: totalErrors / (totalSuccess + totalErrors) < 0.05 ? 'excellent' : 'acceptable',
      avgThroughput: avgThroughput.toFixed(2),
      avgLatency: avgLatency.toFixed(2),
      totalOperations: totalSuccess + totalErrors,
      errorRate: ((totalErrors / (totalSuccess + totalErrors)) * 100).toFixed(2)
    }
  }

  analyzeStabilityResults() {
    const results = this.testResults.stabilityTests
    
    if (results.length === 0) {
      return { status: 'no_data', message: '无稳定性测试数据' }
    }
    
    const result = results[0]
    
    return {
      status: result.successRate >= 95 ? 'excellent' : result.successRate >= 90 ? 'good' : 'poor',
      successRate: result.successRate.toFixed(2),
      opsPerSecond: result.opsPerSecond,
      totalOperations: result.totalOperations
    }
  }

  generateRecommendations() {
    const recommendations = []
    const preheat = this.analyzePreheatResults()
    const reconnection = this.analyzeReconnectionResults()
    const performance = this.analyzePerformanceResults()
    const stability = this.analyzeStabilityResults()
    
    if (preheat.status === 'poor') {
      recommendations.push('连接预热效果较差，建议检查网络延迟和代理配置')
    }
    
    if (reconnection.status === 'poor') {
      recommendations.push('自动重连时间过长，建议优化重连策略')
    }
    
    if (performance.errorRate > 5) {
      recommendations.push('错误率偏高，建议检查连接池配置和错误处理机制')
    }
    
    if (stability.status === 'poor') {
      recommendations.push('系统稳定性较差，建议增强错误处理和重试机制')
    }
    
    if (recommendations.length === 0) {
      recommendations.push('系统运行良好，所有测试指标均符合预期')
    }
    
    return recommendations
  }

  async cleanup() {
    logger.info('🧹 清理测试环境...')
    
    try {
      if (this.lifecycleManager) {
        this.lifecycleManager.stop()
      }
      
      if (this.hybridManager) {
        this.hybridManager.stop()
      }
      
      logger.success('✅ 测试环境清理完成')
    } catch (error) {
      logger.error('❌ 清理测试环境失败:', error.message)
    }
  }

  // 运行所有测试
  async runAllTests() {
    try {
      await this.initialize()
      
      logger.info('🎯 开始执行连接池综合测试...')
      
      // 执行所有测试
      await this.testConnectionPreheat()
      await new Promise(resolve => setTimeout(resolve, 2000)) // 等待2秒
      
      await this.testAutoReconnection()
      await new Promise(resolve => setTimeout(resolve, 2000)) // 等待2秒
      
      await this.testPerformanceUnderLoad()
      await new Promise(resolve => setTimeout(resolve, 2000)) // 等待2秒
      
      await this.testSystemStability()
      
      // 生成报告
      const report = this.generateReport()
      
      // 输出报告
      logger.info('📋 ================================')
      logger.info('📋 连接池测试报告')
      logger.info('📋 ================================')
      
      logger.info(`📊 预热测试: ${report.preheatAnalysis.status} (平均延迟: ${report.preheatAnalysis.avgLatency}ms)`)
      logger.info(`🔄 重连测试: ${report.reconnectionAnalysis.status} (平均重连时间: ${report.reconnectionAnalysis.avgReconnectionTime}ms)`)
      logger.info(`⚡ 性能测试: ${report.performanceAnalysis.status} (错误率: ${report.performanceAnalysis.errorRate}%)`)
      logger.info(`🛡️ 稳定性测试: ${report.stabilityAnalysis.status} (成功率: ${report.stabilityAnalysis.successRate}%)`)
      
      logger.info('💡 建议:')
      report.recommendations.forEach(rec => logger.info(`   - ${rec}`))
      
      logger.info('📋 ================================')
      
      return report
      
    } catch (error) {
      logger.error('💥 测试执行失败:', error.message)
      throw error
    } finally {
      await this.cleanup()
    }
  }
}

// 执行测试
if (require.main === module) {
  const tester = new ConnectionPoolTester()
  
  tester.runAllTests()
    .then((report) => {
      logger.success('✅ 连接池测试完成')
      process.exit(0)
    })
    .catch((error) => {
      logger.error('💥 连接池测试失败:', error)
      process.exit(1)
    })
}

module.exports = ConnectionPoolTester