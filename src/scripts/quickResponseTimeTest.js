#!/usr/bin/env node

/**
 * 快速响应时间对比测试
 * 验证连接池预热效果：从1.7秒降低到50-200ms
 */

const ProxyHelper = require('../utils/proxyHelper')
const redis = require('../models/redis')
const logger = require('../utils/logger')
const { performance } = require('perf_hooks')

async function quickResponseTimeTest() {
  try {
    logger.info('⚡ 快速响应时间测试启动...')

    // 连接Redis
    if (!redis.isConnected) {
      await redis.connect()
    }

    // 获取一个测试账户
    const accountKeys = await redis.client.keys('claude:account:*')
    if (accountKeys.length === 0) {
      throw new Error('未找到可用的测试账户')
    }

    const accountData = await redis.client.hgetall(accountKeys[0])
    if (!accountData || !accountData.id || !accountData.proxy) {
      throw new Error('测试账户数据不完整')
    }

    const accountId = accountData.id
    const accountName = accountData.name || `测试账户-${accountId.slice(0, 8)}`

    logger.info(`🎯 测试账户: ${accountName} (${accountId})`)

    // 执行多次测试获取平均值
    const testRounds = 10
    const latencies = []

    logger.info(`📊 执行 ${testRounds} 轮响应时间测试...`)

    for (let i = 1; i <= testRounds; i++) {
      try {
        const startTime = performance.now()
        const connection = ProxyHelper.getConnectionForAccount(accountId)
        const endTime = performance.now()

        const latency = endTime - startTime
        latencies.push(latency)

        logger.info(`🔄 第${i}轮: ${latency.toFixed(2)}ms (连接ID: ${connection.connectionId})`)

        // 短暂暂停避免过度测试
        await new Promise((resolve) => setTimeout(resolve, 500))
      } catch (error) {
        logger.error(`❌ 第${i}轮测试失败: ${error.message}`)
      }
    }

    if (latencies.length === 0) {
      throw new Error('所有测试轮次均失败')
    }

    // 统计分析
    const avgLatency = latencies.reduce((sum, lat) => sum + lat, 0) / latencies.length
    const maxLatency = Math.max(...latencies)
    const minLatency = Math.min(...latencies)
    const medianLatency = latencies.sort((a, b) => a - b)[Math.floor(latencies.length / 2)]

    // 计算改进百分比（相对于1.7秒基准）
    const baselineLatency = 1700 // 1.7秒 = 1700ms
    const improvement = ((baselineLatency - avgLatency) / baselineLatency) * 100

    // 输出测试结果
    logger.info('')
    logger.info('📋 ================================')
    logger.info('📋 响应时间测试结果')
    logger.info('📋 ================================')
    logger.info(`📊 测试轮次: ${latencies.length}/${testRounds}`)
    logger.info(`⚡ 平均延迟: ${avgLatency.toFixed(2)}ms`)
    logger.info(`⚡ 最小延迟: ${minLatency.toFixed(2)}ms`)
    logger.info(`⚡ 最大延迟: ${maxLatency.toFixed(2)}ms`)
    logger.info(`⚡ 中位延迟: ${medianLatency.toFixed(2)}ms`)
    logger.info(`📈 性能改进: ${improvement.toFixed(1)}% (相对于1700ms基准)`)

    // 评估结果
    let status = '🔥 优秀'
    let statusColor = '✅'

    if (avgLatency <= 200) {
      status = '🔥 优秀 - 达到预期目标 (≤200ms)'
      statusColor = '✅'
    } else if (avgLatency <= 500) {
      status = '👍 良好 - 显著改进但可进一步优化'
      statusColor = '⚠️'
    } else if (avgLatency <= 1000) {
      status = '📈 有改进 - 但未达到最佳预期'
      statusColor = '⚠️'
    } else {
      status = '🔴 需要优化 - 改进效果不明显'
      statusColor = '❌'
    }

    logger.info(`${statusColor} 评估结果: ${status}`)

    // 具体建议
    if (avgLatency <= 200) {
      logger.success('🎉 连接池预热效果显著！响应时间已优化到预期范围内')
    } else if (avgLatency <= 500) {
      logger.warn('💡 建议: 检查代理配置和网络延迟，进一步优化连接建立过程')
    } else {
      logger.error('🔧 需要: 检查连接池配置、代理设置或网络环境')
    }

    logger.info('📋 ================================')

    return {
      success: true,
      avgLatency,
      improvement,
      status: avgLatency <= 200 ? 'excellent' : avgLatency <= 500 ? 'good' : 'needs_optimization'
    }
  } catch (error) {
    logger.error('💥 快速响应时间测试失败:', error.message)
    return {
      success: false,
      error: error.message
    }
  }
}

// 直接运行测试
if (require.main === module) {
  quickResponseTimeTest()
    .then((result) => {
      if (result.success) {
        logger.success('✅ 快速响应时间测试完成')
        process.exit(0)
      } else {
        logger.error('❌ 快速响应时间测试失败')
        process.exit(1)
      }
    })
    .catch((error) => {
      logger.error('💥 测试执行异常:', error)
      process.exit(1)
    })
}

module.exports = quickResponseTimeTest
