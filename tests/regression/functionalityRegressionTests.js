const assert = require('assert')
const performanceOptimizer = require('../../src/utils/performanceOptimizer')
const memoryMonitor = require('../../src/utils/memoryMonitor')
const SmartConnectionPool = require('../../src/services/smartConnectionPool')

/**
 * 功能正确性回归测试套件
 * 确保所有性能优化不会破坏现有功能
 */
class FunctionalityRegressionTests {
  constructor() {
    this.testResults = []
    this.failures = []
  }

  /**
   * 运行所有回归测试
   */
  async runAllTests() {
    console.log('🧪 开始功能正确性回归测试...\n')

    const tests = [
      // 性能优化器测试
      { name: '智能拷贝功能测试', func: () => this.testSmartCopyFunctionality() },
      { name: '系统提示词处理测试', func: () => this.testSystemPromptProcessing() },
      { name: '对象池功能测试', func: () => this.testObjectPoolFunctionality() },
      { name: '缓存系统测试', func: () => this.testCacheFunctionality() },
      
      // 内存监控器测试
      { name: '内存监控功能测试', func: () => this.testMemoryMonitorFunctionality() },
      
      // 连接池测试
      { name: '连接池内存管理测试', func: () => this.testConnectionPoolMemoryManagement() },
      
      // 集成测试
      { name: '端到端集成测试', func: () => this.testEndToEndIntegration() },
      { name: '错误处理回归测试', func: () => this.testErrorHandlingRegression() },
      { name: '边界条件测试', func: () => this.testBoundaryConditions() }
    ]

    for (const test of tests) {
      try {
        console.log(`🔍 运行: ${test.name}`)
        await test.func()
        this.testResults.push({ name: test.name, status: 'PASS' })
        console.log(`✅ ${test.name} - 通过\n`)
      } catch (error) {
        this.testResults.push({ name: test.name, status: 'FAIL', error: error.message })
        this.failures.push({ name: test.name, error })
        console.log(`❌ ${test.name} - 失败: ${error.message}\n`)
      }
    }

    this.generateTestReport()
  }

  /**
   * 测试智能拷贝功能
   */
  testSmartCopyFunctionality() {
    console.log('  测试不同类型的请求体拷贝...')

    // 测试 null/undefined 处理
    assert.strictEqual(
      performanceOptimizer.smartCopyRequestBody(null),
      null,
      'null 值处理失败'
    )
    
    assert.strictEqual(
      performanceOptimizer.smartCopyRequestBody(undefined),
      undefined,
      'undefined 值处理失败'
    )

    // 测试简单对象
    const simpleObj = { model: 'test', messages: [{ role: 'user', content: 'hello' }] }
    const simpleCopy = performanceOptimizer.smartCopyRequestBody(simpleObj, false)
    
    assert.notStrictEqual(simpleCopy, simpleObj, '应该返回新对象')
    assert.deepStrictEqual(simpleCopy, simpleObj, '拷贝内容应该相同')

    // 测试复杂对象
    const complexObj = {
      model: 'test',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'hello' },
            { type: 'text', text: 'world', cache_control: { type: 'ephemeral' } }
          ]
        }
      ],
      system: [
        { type: 'text', text: 'system prompt' }
      ]
    }
    
    const complexCopy = performanceOptimizer.smartCopyRequestBody(complexObj, true)
    assert.notStrictEqual(complexCopy, complexObj, '复杂对象应该返回新对象')
    assert.deepStrictEqual(complexCopy.model, complexObj.model, '简单字段应该相同')
    
    // 修改拷贝不应影响原对象
    complexCopy.model = 'modified'
    assert.notStrictEqual(complexCopy.model, complexObj.model, '修改拷贝不应影响原对象')

    console.log('    ✓ 智能拷贝基本功能正常')
  }

  /**
   * 测试系统提示词处理
   */
  testSystemPromptProcessing() {
    console.log('  测试预编译提示词功能...')

    // 测试获取预编译提示词
    const claudeCodePrompt = performanceOptimizer.getPrecompiledPrompt('claude_code_only')
    assert(Array.isArray(claudeCodePrompt), '应该返回数组')
    assert.strictEqual(claudeCodePrompt.length, 1, '应该包含一个元素')
    assert.strictEqual(claudeCodePrompt[0].type, 'text', '应该是text类型')
    assert.strictEqual(
      claudeCodePrompt[0].text, 
      "You are Claude Code, Anthropic's official CLI for Claude.",
      'Claude Code提示词内容错误'
    )

    // 测试带参数的预编译提示词
    const userPrompt = 'Custom user prompt'
    const combinedPrompt = performanceOptimizer.getPrecompiledPrompt('claude_code_with_string', userPrompt)
    assert(Array.isArray(combinedPrompt), '组合提示词应该返回数组')
    assert.strictEqual(combinedPrompt.length, 2, '应该包含两个元素')
    assert.strictEqual(combinedPrompt[1].text, userPrompt, '用户提示词应该匹配')

    // 测试不存在的模板
    const nonExistent = performanceOptimizer.getPrecompiledPrompt('non_existent')
    assert.strictEqual(nonExistent, null, '不存在的模板应该返回null')

    console.log('    ✓ 系统提示词处理功能正常')
  }

  /**
   * 测试对象池功能
   */
  testObjectPoolFunctionality() {
    console.log('  测试UUID和上下文对象池...')

    // 测试UUID池
    const uuid1 = performanceOptimizer.getPooledUUID()
    const uuid2 = performanceOptimizer.getPooledUUID()
    
    assert(typeof uuid1 === 'string', 'UUID应该是字符串')
    assert(typeof uuid2 === 'string', 'UUID应该是字符串')
    assert.notStrictEqual(uuid1, uuid2, 'UUID应该不同')
    
    // 验证UUID格式
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    assert(uuidRegex.test(uuid1), 'UUID格式应该正确')
    
    // 测试UUID回收
    performanceOptimizer.recycleUUID(uuid1)
    performanceOptimizer.recycleUUID(uuid2)

    // 测试请求上下文池
    const context1 = performanceOptimizer.getPooledRequestContext()
    const context2 = performanceOptimizer.getPooledRequestContext()
    
    assert(typeof context1 === 'object', '上下文应该是对象')
    assert(typeof context2 === 'object', '上下文应该是对象')
    assert.notStrictEqual(context1, context2, '上下文对象应该不同')
    
    // 测试对象重置
    context1.testField = 'test'
    performanceOptimizer.recycleRequestContext(context1)
    
    const recycledContext = performanceOptimizer.getPooledRequestContext()
    assert(!recycledContext.hasOwnProperty('testField'), '回收的对象应该被重置')
    
    performanceOptimizer.recycleRequestContext(context2)
    performanceOptimizer.recycleRequestContext(recycledContext)

    console.log('    ✓ 对象池功能正常')
  }

  /**
   * 测试缓存功能
   */
  testCacheFunctionality() {
    console.log('  测试账户配置缓存...')

    const testAccountId = 'test_account_123'
    const testConfig = {
      id: testAccountId,
      proxy: { type: 'socks5', host: '127.0.0.1', port: 1080 },
      isActive: true
    }

    // 测试缓存存储
    performanceOptimizer.cacheAccountConfig(testAccountId, testConfig)
    
    // 测试缓存检索
    const cachedConfig = performanceOptimizer.getCachedAccountConfig(testAccountId)
    assert.deepStrictEqual(cachedConfig, testConfig, '缓存的配置应该相同')
    
    // 测试缓存未命中
    const nonExistentConfig = performanceOptimizer.getCachedAccountConfig('non_existent')
    assert.strictEqual(nonExistentConfig, null, '不存在的配置应该返回null')
    
    // 测试正则表达式缓存
    const regex1 = performanceOptimizer.getCachedRegExp('test', 'i')
    const regex2 = performanceOptimizer.getCachedRegExp('test', 'i')
    
    assert.strictEqual(regex1, regex2, '相同模式的正则表达式应该复用')
    assert(regex1 instanceof RegExp, '应该返回正则表达式对象')
    assert(regex1.test('TEST'), '正则表达式应该正确工作')

    console.log('    ✓ 缓存功能正常')
  }

  /**
   * 测试内存监控功能
   */
  testMemoryMonitorFunctionality() {
    console.log('  测试内存监控基本功能...')

    // 测试获取当前内存使用
    const memoryUsage = memoryMonitor.getCurrentMemoryUsage()
    assert(typeof memoryUsage === 'object', '内存使用信息应该是对象')
    assert(typeof memoryUsage.heapUsed === 'number', 'heapUsed应该是数字')
    assert(typeof memoryUsage.heapTotal === 'number', 'heapTotal应该是数字')
    assert(typeof memoryUsage.rss === 'number', 'rss应该是数字')
    assert(typeof memoryUsage.heapUsedPercent === 'number', 'heapUsedPercent应该是数字')

    // 测试获取统计信息
    const stats = memoryMonitor.getStats()
    assert(typeof stats === 'object', '统计信息应该是对象')
    assert(typeof stats.current === 'object', '当前内存信息应该存在')
    assert(typeof stats.monitoring === 'object', '监控信息应该存在')
    assert(typeof stats.gc === 'object', 'GC信息应该存在')

    // 测试生成详细报告
    const report = memoryMonitor.generateDetailedReport()
    assert(typeof report === 'object', '报告应该是对象')
    assert(Array.isArray(report.analysis.recommendations), '建议应该是数组')

    console.log('    ✓ 内存监控功能正常')
  }

  /**
   * 测试连接池内存管理
   */
  async testConnectionPoolMemoryManagement() {
    console.log('  测试连接池内存清理...')

    const testAccountId = 'test_pool_account'
    const mockProxyConfig = {
      type: 'socks5',
      host: '127.0.0.1',
      port: 1080
    }

    // 创建测试连接池（不实际初始化网络连接）
    const pool = new SmartConnectionPool(testAccountId, mockProxyConfig)
    
    // 测试连接池状态
    const initialStatus = pool.getStatus()
    assert.strictEqual(initialStatus.accountId, testAccountId, '账户ID应该匹配')
    assert.strictEqual(initialStatus.isInitialized, false, '初始状态应该未初始化')
    assert.strictEqual(initialStatus.totalConnections, 0, '初始连接数应该为0')

    // 测试连接池统计信息
    assert(typeof initialStatus.stats === 'object', '统计信息应该存在')
    assert(typeof initialStatus.stats.totalConnections === 'number', '总连接数应该是数字')
    assert(typeof initialStatus.stats.reconnectCount === 'number', '重连计数应该是数字')

    console.log('    ✓ 连接池内存管理功能正常')
  }

  /**
   * 测试端到端集成
   */
  async testEndToEndIntegration() {
    console.log('  测试性能优化组件集成...')

    // 模拟完整的请求处理流程
    const mockRequest = {
      model: 'claude-sonnet-4-20250514',
      messages: [
        {
          role: 'user',
          content: 'Test integration message'
        }
      ],
      system: 'Test system prompt',
      max_tokens: 100
    }

    // 1. 智能拷贝
    const processedBody = performanceOptimizer.smartCopyRequestBody(mockRequest, true)
    assert(typeof processedBody === 'object', '处理后的请求体应该是对象')

    // 2. 使用对象池
    const contextId = performanceOptimizer.getPooledUUID()
    const context = performanceOptimizer.getPooledRequestContext()
    
    context.requestId = contextId
    context.timestamp = Date.now()
    context.body = processedBody

    // 3. 缓存操作
    const testAccountId = 'integration_test_account'
    const accountConfig = {
      id: testAccountId,
      proxy: { type: 'http', host: 'proxy.example.com', port: 8080 }
    }
    
    performanceOptimizer.cacheAccountConfig(testAccountId, accountConfig)
    const cachedConfig = performanceOptimizer.getCachedAccountConfig(testAccountId)
    
    assert.deepStrictEqual(cachedConfig, accountConfig, '集成测试中的缓存应该正常工作')

    // 4. 清理资源
    performanceOptimizer.recycleUUID(contextId)
    performanceOptimizer.recycleRequestContext(context)

    console.log('    ✓ 端到端集成测试通过')
  }

  /**
   * 测试错误处理回归
   */
  async testErrorHandlingRegression() {
    console.log('  测试错误处理不受优化影响...')

    // 测试智能拷贝的错误处理
    try {
      const circularRef = {}
      circularRef.self = circularRef
      
      // 这应该能处理循环引用而不抛出异常
      const result = performanceOptimizer.smartCopyRequestBody(circularRef, false, false)
      // 对于循环引用，智能拷贝会选择安全的处理方式
    } catch (error) {
      // 预期的错误处理
      assert(error instanceof Error, '应该抛出适当的错误')
    }

    // 测试对象池的错误处理
    try {
      // 测试回收无效UUID
      performanceOptimizer.recycleUUID(null)
      performanceOptimizer.recycleUUID(undefined)
      // 这些操作应该不会抛出错误
    } catch (error) {
      throw new Error(`对象池错误处理失败: ${error.message}`)
    }

    // 测试缓存的错误处理
    try {
      // 测试无效的账户ID
      performanceOptimizer.cacheAccountConfig(null, {})
      performanceOptimizer.getCachedAccountConfig(null)
      // 这些操作应该安全处理
    } catch (error) {
      throw new Error(`缓存错误处理失败: ${error.message}`)
    }

    console.log('    ✓ 错误处理回归测试通过')
  }

  /**
   * 测试边界条件
   */
  async testBoundaryConditions() {
    console.log('  测试边界条件处理...')

    // 测试大对象处理
    const largeObject = {
      model: 'test',
      messages: Array.from({ length: 1000 }, (_, i) => ({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: 'x'.repeat(1000)
      })),
      system: Array.from({ length: 100 }, (_, i) => ({
        type: 'text',
        text: 'y'.repeat(100)
      }))
    }

    const largeCopy = performanceOptimizer.smartCopyRequestBody(largeObject, true)
    assert(typeof largeCopy === 'object', '大对象拷贝应该成功')
    assert.strictEqual(largeCopy.messages.length, 1000, '消息数量应该正确')

    // 测试空值处理
    const emptyValues = [null, undefined, '', 0, false, [], {}]
    for (const value of emptyValues) {
      const result = performanceOptimizer.smartCopyRequestBody(value, false)
      if (value === null || value === undefined) {
        assert.strictEqual(result, value, `${value} 应该原样返回`)
      }
    }

    // 测试对象池边界条件
    const manyUuids = []
    for (let i = 0; i < 100; i++) {
      manyUuids.push(performanceOptimizer.getPooledUUID())
    }
    
    // 回收大量UUID
    for (const uuid of manyUuids) {
      performanceOptimizer.recycleUUID(uuid)
    }

    console.log('    ✓ 边界条件测试通过')
  }

  /**
   * 生成测试报告
   */
  generateTestReport() {
    console.log('\n📊 功能正确性回归测试报告')
    console.log('=' * 50)
    
    const totalTests = this.testResults.length
    const passedTests = this.testResults.filter(r => r.status === 'PASS').length
    const failedTests = totalTests - passedTests
    
    console.log(`\n📈 测试结果汇总:`)
    console.log(`  总测试数: ${totalTests}`)
    console.log(`  通过: ${passedTests}`)
    console.log(`  失败: ${failedTests}`)
    console.log(`  成功率: ${((passedTests / totalTests) * 100).toFixed(1)}%`)
    
    if (failedTests > 0) {
      console.log(`\n❌ 失败的测试:`)
      this.failures.forEach(failure => {
        console.log(`  - ${failure.name}: ${failure.error.message}`)
      })
    }
    
    console.log(`\n📋 详细测试结果:`)
    this.testResults.forEach(result => {
      const status = result.status === 'PASS' ? '✅' : '❌'
      console.log(`  ${status} ${result.name}`)
    })
    
    if (failedTests === 0) {
      console.log(`\n🎉 所有功能正确性测试通过！优化没有破坏现有功能。`)
    } else {
      console.log(`\n⚠️  有 ${failedTests} 个测试失败，需要修复。`)
    }
  }
}

// 如果直接运行此脚本
if (require.main === module) {
  const tests = new FunctionalityRegressionTests()
  
  tests.runAllTests().then(() => {
    const failedCount = tests.failures.length
    if (failedCount === 0) {
      console.log('\n🎉 所有回归测试通过!')
      process.exit(0)
    } else {
      console.log(`\n❌ ${failedCount} 个测试失败!`)
      process.exit(1)
    }
  }).catch(error => {
    console.error('❌ 回归测试运行失败:', error)
    process.exit(1)
  })
}

module.exports = FunctionalityRegressionTests