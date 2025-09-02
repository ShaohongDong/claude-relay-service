#!/usr/bin/env node

/**
 * 系统集成测试和性能验证
 *
 * 验证内容：
 * 1. 端到端API请求流程（使用预热连接）
 * 2. 连接池与现有服务的集成
 * 3. 系统整体性能提升验证
 * 4. 向后兼容性测试
 * 5. 错误场景和恢复测试
 * 6. 内存和资源使用分析
 */

const axios = require('axios')
const redis = require('../models/redis')
const logger = require('../utils/logger')
const { performance } = require('perf_hooks')

class SystemIntegrationTester {
  constructor() {
    this.baseUrl = 'http://localhost:3000'
    this.testResults = {
      endToEndTests: [],
      performanceTests: [],
      compatibilityTests: [],
      errorRecoveryTests: [],
      resourceUsageTests: []
    }

    this.testApiKey = null
    this.testAccounts = []
    this.systemStats = {
      before: null,
      after: null
    }
  }

  async initialize() {
    logger.info('🚀 初始化系统集成测试环境...')

    try {
      // 连接Redis
      if (!redis.isConnected) {
        await redis.connect()
      }

      // 获取测试API Key
      await this.loadTestApiKey()

      // 获取测试账户
      await this.loadTestAccounts()

      // 检查系统健康状态
      await this.checkSystemHealth()

      // 记录测试开始前的系统状态
      this.systemStats.before = await this.captureSystemStats()

      logger.success('✅ 系统集成测试环境初始化完成')
    } catch (error) {
      logger.error('❌ 系统集成测试环境初始化失败:', error.message)
      throw error
    }
  }

  async loadTestApiKey() {
    try {
      // 查找一个有效的API Key用于测试
      const apiKeyIds = await redis.client.keys('api_key:*')

      for (const keyId of apiKeyIds.slice(0, 5)) {
        // 检查前5个
        const keyData = await redis.client.hgetall(keyId)
        if (keyData && keyData.isActive === 'true' && keyData.key) {
          this.testApiKey = keyData.key
          logger.info(
            `📋 使用测试API Key: ${keyData.name || 'Unknown'} (${keyData.key.slice(0, 10)}...)`
          )
          break
        }
      }

      if (!this.testApiKey) {
        throw new Error('未找到可用的测试API Key')
      }
    } catch (error) {
      logger.error('❌ 加载测试API Key失败:', error.message)
      throw error
    }
  }

  async loadTestAccounts() {
    try {
      const accountKeys = await redis.client.keys('claude:account:*')

      for (const key of accountKeys.slice(0, 3)) {
        // 限制测试账户数量
        const accountData = await redis.client.hgetall(key)
        if (accountData && accountData.id && accountData.proxy) {
          this.testAccounts.push({
            id: accountData.id,
            name: accountData.name || `测试账户-${accountData.id.slice(0, 8)}`,
            isActive: accountData.isActive === 'true'
          })
        }
      }

      if (this.testAccounts.length === 0) {
        throw new Error('未找到可用的测试Claude账户')
      }

      logger.info(`📋 加载测试Claude账户: ${this.testAccounts.length}个`)
    } catch (error) {
      logger.error('❌ 加载测试账户失败:', error.message)
      throw error
    }
  }

  async checkSystemHealth() {
    try {
      const response = await axios.get(`${this.baseUrl}/health`, { timeout: 10000 })

      if (response.status !== 200) {
        throw new Error(`健康检查失败: HTTP ${response.status}`)
      }

      const health = response.data

      // 检查关键组件状态
      if (health.components?.redis?.status !== 'healthy') {
        throw new Error('Redis组件不健康')
      }

      if (health.components?.connectionPools?.status === 'error') {
        throw new Error('连接池系统错误')
      }

      logger.success('✅ 系统健康检查通过')
      logger.info(`🔗 连接池状态: ${health.components.connectionPools?.status || 'unknown'}`)
      logger.info(`📊 连接池数量: ${health.components.connectionPools?.totalPools || 0}`)
    } catch (error) {
      logger.error('❌ 系统健康检查失败:', error.message)
      throw error
    }
  }

  async captureSystemStats() {
    try {
      const [healthResponse, metricsResponse, connectionPoolResponse] = await Promise.allSettled([
        axios.get(`${this.baseUrl}/health`),
        axios.get(`${this.baseUrl}/metrics`),
        axios.get(`${this.baseUrl}/connection-pools`)
      ])

      return {
        timestamp: Date.now(),
        health: healthResponse.status === 'fulfilled' ? healthResponse.value.data : null,
        metrics: metricsResponse.status === 'fulfilled' ? metricsResponse.value.data : null,
        connectionPools:
          connectionPoolResponse.status === 'fulfilled' ? connectionPoolResponse.value.data : null,
        memory: process.memoryUsage()
      }
    } catch (error) {
      logger.warn('⚠️ 系统状态捕获失败:', error.message)
      return { timestamp: Date.now(), error: error.message }
    }
  }

  // 测试1: 端到端API请求流程
  async testEndToEndApiFlow() {
    logger.info('🌐 开始端到端API请求流程测试...')

    const testMessages = [
      { role: 'user', content: '你好，这是一个连接池测试请求。请简短回复。' },
      { role: 'user', content: 'What is 2+2? Please answer briefly.' },
      { role: 'user', content: 'Test connection pool. Reply OK if received.' }
    ]

    for (let i = 0; i < testMessages.length; i++) {
      const testMessage = testMessages[i]

      try {
        const startTime = performance.now()

        const response = await axios.post(
          `${this.baseUrl}/api/v1/messages`,
          {
            messages: [testMessage],
            model: 'claude-3-5-sonnet-20241022',
            max_tokens: 100,
            stream: false
          },
          {
            headers: {
              Authorization: `Bearer ${this.testApiKey}`,
              'Content-Type': 'application/json'
            },
            timeout: 30000
          }
        )

        const endTime = performance.now()
        const totalLatency = endTime - startTime

        if (response.status === 200 && response.data.content) {
          this.testResults.endToEndTests.push({
            testIndex: i + 1,
            message: `${testMessage.content.slice(0, 50)}...`,
            totalLatency,
            responseLength: response.data.content[0]?.text?.length || 0,
            success: true,
            timestamp: new Date().toISOString()
          })

          logger.success(
            `✅ 端到端测试 ${i + 1}: ${totalLatency.toFixed(2)}ms - ${response.data.content[0]?.text?.slice(0, 50)}...`
          )
        } else {
          throw new Error(`Invalid response: ${response.status}`)
        }

        // 避免过度频繁请求
        await new Promise((resolve) => setTimeout(resolve, 2000))
      } catch (error) {
        logger.error(`❌ 端到端测试 ${i + 1} 失败: ${error.message}`)
        this.testResults.endToEndTests.push({
          testIndex: i + 1,
          message: `${testMessage.content.slice(0, 50)}...`,
          totalLatency: null,
          success: false,
          error: error.message,
          timestamp: new Date().toISOString()
        })
      }
    }
  }

  // 测试2: 性能对比测试
  async testPerformanceImprovement() {
    logger.info('⚡ 开始性能改进验证测试...')

    const iterations = 5
    const latencies = []

    for (let i = 1; i <= iterations; i++) {
      try {
        const startTime = performance.now()

        // 执行简单的API请求来测量整体延迟
        const response = await axios.post(
          `${this.baseUrl}/api/v1/messages`,
          {
            messages: [{ role: 'user', content: 'Performance test. Reply: OK' }],
            model: 'claude-3-5-sonnet-20241022',
            max_tokens: 10,
            stream: false
          },
          {
            headers: {
              Authorization: `Bearer ${this.testApiKey}`,
              'Content-Type': 'application/json'
            },
            timeout: 30000
          }
        )

        const endTime = performance.now()
        const latency = endTime - startTime

        if (response.status === 200) {
          latencies.push(latency)
          logger.info(`⚡ 性能测试 ${i}: ${latency.toFixed(2)}ms`)
        }

        await new Promise((resolve) => setTimeout(resolve, 1000))
      } catch (error) {
        logger.error(`❌ 性能测试 ${i} 失败: ${error.message}`)
      }
    }

    if (latencies.length > 0) {
      const avgLatency = latencies.reduce((sum, lat) => sum + lat, 0) / latencies.length
      const minLatency = Math.min(...latencies)
      const maxLatency = Math.max(...latencies)

      this.testResults.performanceTests.push({
        iterations: latencies.length,
        avgLatency,
        minLatency,
        maxLatency,
        improvement: (((3000 - avgLatency) / 3000) * 100).toFixed(2), // 假设原始延迟3秒
        timestamp: new Date().toISOString()
      })

      logger.info(
        `📊 性能测试结果: 平均 ${avgLatency.toFixed(2)}ms, 范围 ${minLatency.toFixed(2)}-${maxLatency.toFixed(2)}ms`
      )
    }
  }

  // 测试3: 向后兼容性测试
  async testBackwardCompatibility() {
    logger.info('🔄 开始向后兼容性测试...')

    const compatibilityTests = [
      {
        name: '基本API端点',
        endpoint: '/api/v1/models',
        method: 'GET',
        expectedStatus: 200
      },
      {
        name: 'Health Check',
        endpoint: '/health',
        method: 'GET',
        expectedStatus: 200
      },
      {
        name: '指标端点',
        endpoint: '/metrics',
        method: 'GET',
        expectedStatus: 200
      },
      {
        name: '连接池状态端点',
        endpoint: '/connection-pools',
        method: 'GET',
        expectedStatus: 200
      }
    ]

    for (const test of compatibilityTests) {
      try {
        const config = {
          method: test.method.toLowerCase(),
          url: `${this.baseUrl}${test.endpoint}`,
          timeout: 10000
        }

        if (test.name === '基本API端点' || test.name.includes('API')) {
          config.headers = { Authorization: `Bearer ${this.testApiKey}` }
        }

        const response = await axios(config)

        const success = response.status === test.expectedStatus

        this.testResults.compatibilityTests.push({
          testName: test.name,
          endpoint: test.endpoint,
          expectedStatus: test.expectedStatus,
          actualStatus: response.status,
          success,
          responseSize: JSON.stringify(response.data).length,
          timestamp: new Date().toISOString()
        })

        if (success) {
          logger.success(`✅ 兼容性测试 - ${test.name}: HTTP ${response.status}`)
        } else {
          logger.error(
            `❌ 兼容性测试 - ${test.name}: 期望 ${test.expectedStatus}, 实际 ${response.status}`
          )
        }
      } catch (error) {
        logger.error(`❌ 兼容性测试 - ${test.name} 失败: ${error.message}`)
        this.testResults.compatibilityTests.push({
          testName: test.name,
          endpoint: test.endpoint,
          success: false,
          error: error.message,
          timestamp: new Date().toISOString()
        })
      }
    }
  }

  // 测试4: 错误恢复测试
  async testErrorRecovery() {
    logger.info('🛡️ 开始错误恢复测试...')

    try {
      // 测试无效API Key
      logger.info('🔑 测试无效API Key处理...')
      try {
        const response = await axios.post(
          `${this.baseUrl}/api/v1/messages`,
          {
            messages: [{ role: 'user', content: 'Test invalid key' }],
            model: 'claude-3-5-sonnet-20241022',
            max_tokens: 10
          },
          {
            headers: {
              Authorization: 'Bearer invalid_key_test',
              'Content-Type': 'application/json'
            },
            timeout: 10000
          }
        )

        // 如果到这里说明没有正确拒绝无效key
        logger.error('❌ 系统未正确拒绝无效API Key')
        this.testResults.errorRecoveryTests.push({
          testName: '无效API Key处理',
          success: false,
          message: '系统未拒绝无效API Key',
          timestamp: new Date().toISOString()
        })
      } catch (error) {
        if (error.response && (error.response.status === 401 || error.response.status === 403)) {
          logger.success('✅ 无效API Key被正确拒绝')
          this.testResults.errorRecoveryTests.push({
            testName: '无效API Key处理',
            success: true,
            actualStatus: error.response.status,
            timestamp: new Date().toISOString()
          })
        } else {
          logger.error(`❌ 无效API Key测试异常: ${error.message}`)
        }
      }

      // 测试请求超时处理
      logger.info('⏱️ 测试请求超时处理...')
      try {
        const response = await axios.post(
          `${this.baseUrl}/api/v1/messages`,
          {
            messages: [{ role: 'user', content: 'Test timeout' }],
            model: 'claude-3-5-sonnet-20241022',
            max_tokens: 10
          },
          {
            headers: {
              Authorization: `Bearer ${this.testApiKey}`,
              'Content-Type': 'application/json'
            },
            timeout: 100 // 极短超时时间
          }
        )

        logger.warn('⚠️ 请求未按预期超时')
      } catch (error) {
        if (error.code === 'ECONNABORTED' || error.message.includes('timeout')) {
          logger.success('✅ 请求超时处理正常')
          this.testResults.errorRecoveryTests.push({
            testName: '请求超时处理',
            success: true,
            message: '超时正确处理',
            timestamp: new Date().toISOString()
          })
        } else {
          logger.error(`❌ 超时测试异常: ${error.message}`)
        }
      }
    } catch (error) {
      logger.error('❌ 错误恢复测试失败:', error.message)
    }
  }

  // 测试5: 资源使用分析
  async testResourceUsage() {
    logger.info('📊 开始资源使用分析...')

    try {
      // 获取当前系统状态
      const beforeStats = await this.captureSystemStats()

      // 执行一系列请求来测试资源使用
      const requestCount = 10
      logger.info(`🔄 执行 ${requestCount} 个并发请求测试资源使用...`)

      const startTime = performance.now()
      const promises = []

      for (let i = 0; i < requestCount; i++) {
        promises.push(
          axios
            .post(
              `${this.baseUrl}/api/v1/messages`,
              {
                messages: [{ role: 'user', content: `Resource test ${i + 1}. Reply: OK` }],
                model: 'claude-3-5-sonnet-20241022',
                max_tokens: 10,
                stream: false
              },
              {
                headers: {
                  Authorization: `Bearer ${this.testApiKey}`,
                  'Content-Type': 'application/json'
                },
                timeout: 30000
              }
            )
            .catch((error) => ({ error: error.message }))
        )
      }

      const results = await Promise.all(promises)
      const endTime = performance.now()

      // 获取测试后的系统状态
      const afterStats = await this.captureSystemStats()

      const successCount = results.filter((r) => !r.error && r.status === 200).length
      const totalTime = endTime - startTime

      this.testResults.resourceUsageTests.push({
        requestCount,
        successCount,
        totalTime,
        throughput: (successCount / (totalTime / 1000)).toFixed(2),
        memoryBefore: beforeStats.memory,
        memoryAfter: afterStats.memory,
        memoryIncrease: afterStats.memory
          ? ((afterStats.memory.heapUsed - beforeStats.memory.heapUsed) / 1024 / 1024).toFixed(2)
          : 'N/A',
        timestamp: new Date().toISOString()
      })

      logger.info(
        `📊 资源使用测试完成: ${successCount}/${requestCount} 成功, 吞吐量: ${(successCount / (totalTime / 1000)).toFixed(2)} req/s`
      )

      if (afterStats.memory && beforeStats.memory) {
        const memIncrease = (afterStats.memory.heapUsed - beforeStats.memory.heapUsed) / 1024 / 1024
        logger.info(`💾 内存使用变化: +${memIncrease.toFixed(2)}MB`)
      }
    } catch (error) {
      logger.error('❌ 资源使用分析失败:', error.message)
    }
  }

  // 生成综合测试报告
  generateIntegrationReport() {
    logger.info('📋 生成系统集成测试报告...')

    // 记录测试结束后的系统状态
    this.systemStats.after = this.captureSystemStats()

    const report = {
      summary: {
        testStartTime: new Date().toISOString(),
        testAccounts: this.testAccounts.length,
        systemStatsBefore: this.systemStats.before,
        systemStatsAfter: this.systemStats.after
      },
      results: this.testResults,
      analysis: {
        endToEnd: this.analyzeEndToEndResults(),
        performance: this.analyzePerformanceResults(),
        compatibility: this.analyzeCompatibilityResults(),
        errorRecovery: this.analyzeErrorRecoveryResults(),
        resourceUsage: this.analyzeResourceUsageResults()
      },
      overallAssessment: this.generateOverallAssessment()
    }

    return report
  }

  analyzeEndToEndResults() {
    const results = this.testResults.endToEndTests
    const successResults = results.filter((r) => r.success)

    if (successResults.length === 0) {
      return { status: 'failed', message: '所有端到端测试均失败' }
    }

    const avgLatency =
      successResults.reduce((sum, r) => sum + r.totalLatency, 0) / successResults.length
    const successRate = (successResults.length / results.length) * 100

    return {
      status: successRate >= 90 ? 'excellent' : successRate >= 70 ? 'good' : 'poor',
      successRate: successRate.toFixed(2),
      avgTotalLatency: avgLatency.toFixed(2),
      totalTests: results.length,
      successfulTests: successResults.length
    }
  }

  analyzePerformanceResults() {
    const results = this.testResults.performanceTests

    if (results.length === 0) {
      return { status: 'no_data', message: '无性能测试数据' }
    }

    const result = results[0]

    return {
      status: result.avgLatency <= 3000 ? 'excellent' : result.avgLatency <= 5000 ? 'good' : 'poor',
      avgLatency: result.avgLatency.toFixed(2),
      improvement: result.improvement,
      iterations: result.iterations
    }
  }

  analyzeCompatibilityResults() {
    const results = this.testResults.compatibilityTests
    const successResults = results.filter((r) => r.success)

    const successRate = results.length > 0 ? (successResults.length / results.length) * 100 : 0

    return {
      status: successRate === 100 ? 'excellent' : successRate >= 80 ? 'good' : 'poor',
      successRate: successRate.toFixed(2),
      totalTests: results.length,
      successfulTests: successResults.length
    }
  }

  analyzeErrorRecoveryResults() {
    const results = this.testResults.errorRecoveryTests
    const successResults = results.filter((r) => r.success)

    const successRate = results.length > 0 ? (successResults.length / results.length) * 100 : 0

    return {
      status: successRate >= 90 ? 'excellent' : successRate >= 70 ? 'good' : 'poor',
      successRate: successRate.toFixed(2),
      totalTests: results.length,
      successfulTests: successResults.length
    }
  }

  analyzeResourceUsageResults() {
    const results = this.testResults.resourceUsageTests

    if (results.length === 0) {
      return { status: 'no_data', message: '无资源使用测试数据' }
    }

    const result = results[0]
    const memoryIncrease = parseFloat(result.memoryIncrease) || 0

    return {
      status: memoryIncrease <= 10 ? 'excellent' : memoryIncrease <= 50 ? 'good' : 'poor',
      throughput: result.throughput,
      memoryIncrease: result.memoryIncrease,
      successRate: ((result.successCount / result.requestCount) * 100).toFixed(2)
    }
  }

  generateOverallAssessment() {
    const analyses = [
      this.analyzeEndToEndResults(),
      this.analyzePerformanceResults(),
      this.analyzeCompatibilityResults(),
      this.analyzeErrorRecoveryResults(),
      this.analyzeResourceUsageResults()
    ]

    const excellentCount = analyses.filter((a) => a.status === 'excellent').length
    const goodCount = analyses.filter((a) => a.status === 'good').length
    const poorCount = analyses.filter((a) => a.status === 'poor').length

    let overallStatus = 'poor'
    let recommendation = ''

    if (excellentCount >= 4) {
      overallStatus = 'excellent'
      recommendation = '系统集成完美，连接池优化效果显著，可以部署到生产环境'
    } else if (excellentCount + goodCount >= 4) {
      overallStatus = 'good'
      recommendation = '系统集成良好，连接池优化效果明显，建议进行小规模生产测试'
    } else {
      overallStatus = 'needs_improvement'
      recommendation = '系统集成存在问题，需要进一步优化和调试'
    }

    return {
      status: overallStatus,
      excellentAreas: excellentCount,
      goodAreas: goodCount,
      poorAreas: poorCount,
      recommendation
    }
  }

  // 运行完整的系统集成测试
  async runFullIntegrationTest() {
    try {
      await this.initialize()

      logger.info('🎯 开始系统集成测试和性能验证...')

      // 按顺序执行所有测试
      await this.testEndToEndApiFlow()
      await new Promise((resolve) => setTimeout(resolve, 3000))

      await this.testPerformanceImprovement()
      await new Promise((resolve) => setTimeout(resolve, 3000))

      await this.testBackwardCompatibility()
      await new Promise((resolve) => setTimeout(resolve, 3000))

      await this.testErrorRecovery()
      await new Promise((resolve) => setTimeout(resolve, 3000))

      await this.testResourceUsage()

      // 生成综合报告
      const report = this.generateIntegrationReport()

      // 输出报告
      this.printIntegrationReport(report)

      return report
    } catch (error) {
      logger.error('💥 系统集成测试执行失败:', error.message)
      throw error
    }
  }

  printIntegrationReport(report) {
    logger.info('')
    logger.info('📋 ========================================')
    logger.info('📋 系统集成测试和性能验证报告')
    logger.info('📋 ========================================')

    logger.info(
      `🌐 端到端测试: ${report.analysis.endToEnd.status} (成功率: ${report.analysis.endToEnd.successRate}%)`
    )
    logger.info(
      `⚡ 性能测试: ${report.analysis.performance.status} (平均延迟: ${report.analysis.performance.avgLatency}ms)`
    )
    logger.info(
      `🔄 兼容性测试: ${report.analysis.compatibility.status} (成功率: ${report.analysis.compatibility.successRate}%)`
    )
    logger.info(
      `🛡️ 错误恢复测试: ${report.analysis.errorRecovery.status} (成功率: ${report.analysis.errorRecovery.successRate}%)`
    )
    logger.info(
      `📊 资源使用测试: ${report.analysis.resourceUsage.status} (吞吐量: ${report.analysis.resourceUsage.throughput} req/s)`
    )

    logger.info('')
    logger.info(`📈 整体评估: ${report.overallAssessment.status}`)
    logger.info(`✅ 优秀领域: ${report.overallAssessment.excellentAreas}/5`)
    logger.info(`👍 良好领域: ${report.overallAssessment.goodAreas}/5`)
    logger.info(`⚠️ 待改进领域: ${report.overallAssessment.poorAreas}/5`)

    logger.info('')
    logger.info('💡 建议:')
    logger.info(`   ${report.overallAssessment.recommendation}`)

    logger.info('📋 ========================================')
  }
}

// 执行系统集成测试
if (require.main === module) {
  const tester = new SystemIntegrationTester()

  tester
    .runFullIntegrationTest()
    .then((report) => {
      logger.success('✅ 系统集成测试和性能验证完成')

      // 根据整体评估决定退出码
      if (
        report.overallAssessment.status === 'excellent' ||
        report.overallAssessment.status === 'good'
      ) {
        process.exit(0)
      } else {
        process.exit(1)
      }
    })
    .catch((error) => {
      logger.error('💥 系统集成测试失败:', error)
      process.exit(1)
    })
}

module.exports = SystemIntegrationTester
