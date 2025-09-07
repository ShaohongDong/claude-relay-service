const { performance } = require('perf_hooks')
const performanceOptimizer = require('../../src/utils/performanceOptimizer')
const memoryMonitor = require('../../src/utils/memoryMonitor')
const logger = require('../../src/utils/logger')

/**
 * 性能优化基准测试套件
 * 验证所有性能优化的效果
 */
class PerformanceBenchmarkSuite {
  constructor() {
    this.results = {
      deepCopy: {},
      systemPrompt: {},
      objectPool: {},
      accountCache: {},
      memoryUsage: {},
      overall: {}
    }
    
    // 测试数据生成器
    this.testData = this.generateTestData()
  }

  /**
   * 生成测试数据
   */
  generateTestData() {
    const simpleRequest = {
      model: 'claude-sonnet-4-20250514',
      messages: [
        {
          role: 'user',
          content: 'Hello, how are you?'
        }
      ],
      max_tokens: 100,
      temperature: 0.7
    }

    const complexRequest = {
      model: 'claude-sonnet-4-20250514',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Analyze this complex data structure' },
            { type: 'text', text: 'With multiple content blocks', cache_control: { type: 'ephemeral' } }
          ]
        },
        {
          role: 'assistant', 
          content: 'I understand the request'
        },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Continue with analysis' },
            { type: 'text', text: 'More complex nested data', cache_control: { type: 'ephemeral' } }
          ]
        }
      ],
      system: [
        { type: 'text', text: 'You are a helpful assistant' },
        { type: 'text', text: 'Please analyze data carefully', cache_control: { type: 'ephemeral' } }
      ],
      max_tokens: 4000,
      temperature: 0.7,
      top_p: 0.9
    }

    const systemPromptVariations = [
      null,
      'Simple system prompt',
      [
        { type: 'text', text: 'Array system prompt' }
      ],
      [
        { type: 'text', text: 'You are Claude Code, Anthropic\'s official CLI for Claude.' },
        { type: 'text', text: 'Additional system context' }
      ]
    ]

    return {
      simple: simpleRequest,
      complex: complexRequest,
      systemPromptVariations,
      largeRequest: this.generateLargeRequest()
    }
  }

  /**
   * 生成大型请求用于压力测试
   */
  generateLargeRequest() {
    const messages = []
    for (let i = 0; i < 50; i++) {
      messages.push({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `Message ${i}: ${'x'.repeat(200)}`
      })
    }

    return {
      model: 'claude-sonnet-4-20250514',
      messages,
      system: Array.from({ length: 10 }, (_, i) => ({
        type: 'text',
        text: `System prompt ${i}: ${'y'.repeat(100)}`,
        cache_control: { type: 'ephemeral' }
      })),
      max_tokens: 4000
    }
  }

  /**
   * 运行完整的基准测试套件
   */
  async runFullBenchmark() {
    console.log('🚀 开始性能优化基准测试...\n')

    // 启动内存监控
    memoryMonitor.startMonitoring(5000) // 5秒间隔

    try {
      // 1. 深拷贝性能测试
      await this.testDeepCopyPerformance()
      
      // 2. 系统提示词处理性能测试
      await this.testSystemPromptPerformance()
      
      // 3. 对象池性能测试
      await this.testObjectPoolPerformance()
      
      // 4. 账户缓存性能测试
      await this.testAccountCachePerformance()
      
      // 5. 内存使用测试
      await this.testMemoryUsage()
      
      // 6. 综合性能测试
      await this.testOverallPerformance()
      
      // 生成报告
      this.generateReport()
      
    } finally {
      // 停止内存监控
      memoryMonitor.stopMonitoring()
    }
  }

  /**
   * 测试深拷贝性能
   */
  async testDeepCopyPerformance() {
    console.log('📋 测试深拷贝性能优化...')

    const iterations = 10000
    const testCases = [
      { name: 'simple', data: this.testData.simple },
      { name: 'complex', data: this.testData.complex },
      { name: 'large', data: this.testData.largeRequest }
    ]

    for (const testCase of testCases) {
      console.log(`  测试案例: ${testCase.name}`)

      // 测试原始深拷贝方法
      const originalStart = performance.now()
      for (let i = 0; i < iterations; i++) {
        JSON.parse(JSON.stringify(testCase.data))
      }
      const originalTime = performance.now() - originalStart

      // 测试优化后的智能拷贝
      const optimizedStart = performance.now()
      for (let i = 0; i < iterations; i++) {
        performanceOptimizer.smartCopyRequestBody(testCase.data, false, false)
      }
      const optimizedTime = performance.now() - optimizedStart

      // 测试带修改的智能拷贝
      const modifiedStart = performance.now()
      for (let i = 0; i < iterations; i++) {
        performanceOptimizer.smartCopyRequestBody(testCase.data, true, false)
      }
      const modifiedTime = performance.now() - modifiedStart

      const improvement = ((originalTime - optimizedTime) / originalTime * 100)
      
      this.results.deepCopy[testCase.name] = {
        original: originalTime,
        optimized: optimizedTime,
        withModification: modifiedTime,
        improvement: improvement,
        speedup: originalTime / optimizedTime
      }

      console.log(`    原始方法: ${originalTime.toFixed(2)}ms`)
      console.log(`    优化方法: ${optimizedTime.toFixed(2)}ms`)
      console.log(`    带修改: ${modifiedTime.toFixed(2)}ms`)
      console.log(`    性能提升: ${improvement.toFixed(1)}% (${(originalTime / optimizedTime).toFixed(1)}x)`)
    }
    
    console.log('')
  }

  /**
   * 测试系统提示词处理性能
   */
  async testSystemPromptPerformance() {
    console.log('💭 测试系统提示词处理性能...')

    const iterations = 10000

    for (let i = 0; i < this.testData.systemPromptVariations.length; i++) {
      const systemPrompt = this.testData.systemPromptVariations[i]
      console.log(`  测试系统提示词变体 ${i + 1}`)

      // 模拟原始处理逻辑（简化版本）
      const originalStart = performance.now()
      for (let j = 0; j < iterations; j++) {
        const testBody = { ...this.testData.simple, system: systemPrompt }
        this.simulateOriginalSystemPromptProcessing(testBody)
      }
      const originalTime = performance.now() - originalStart

      // 测试优化后的处理逻辑
      const optimizedStart = performance.now()
      for (let j = 0; j < iterations; j++) {
        const testBody = { ...this.testData.simple, system: systemPrompt }
        this.simulateOptimizedSystemPromptProcessing(testBody)
      }
      const optimizedTime = performance.now() - optimizedStart

      const improvement = ((originalTime - optimizedTime) / originalTime * 100)
      
      if (!this.results.systemPrompt.variations) {
        this.results.systemPrompt.variations = []
      }
      
      this.results.systemPrompt.variations[i] = {
        original: originalTime,
        optimized: optimizedTime,
        improvement: improvement,
        speedup: originalTime / optimizedTime
      }

      console.log(`    原始方法: ${originalTime.toFixed(2)}ms`)
      console.log(`    优化方法: ${optimizedTime.toFixed(2)}ms`)
      console.log(`    性能提升: ${improvement.toFixed(1)}% (${(originalTime / optimizedTime).toFixed(1)}x)`)
    }
    
    console.log('')
  }

  /**
   * 模拟原始系统提示词处理（简化版）
   */
  simulateOriginalSystemPromptProcessing(body) {
    const claudeCodeSystemPrompt = "You are Claude Code, Anthropic's official CLI for Claude."
    
    // 模拟复杂的原始逻辑
    if (!body.system) {
      body.system = [{
        type: 'text',
        text: claudeCodeSystemPrompt,
        cache_control: { type: 'ephemeral' }
      }]
    } else if (typeof body.system === 'string') {
      if (body.system.trim() === claudeCodeSystemPrompt) {
        body.system = [{
          type: 'text',
          text: claudeCodeSystemPrompt,
          cache_control: { type: 'ephemeral' }
        }]
      } else {
        body.system = [
          {
            type: 'text',
            text: claudeCodeSystemPrompt,
            cache_control: { type: 'ephemeral' }
          },
          {
            type: 'text',
            text: body.system
          }
        ]
      }
    }
    // 更多原始逻辑...
  }

  /**
   * 模拟优化后的系统提示词处理
   */
  simulateOptimizedSystemPromptProcessing(body) {
    const claudeCodePrompt = performanceOptimizer.getPrecompiledPrompt('claude_code_only')[0]
    
    if (!body.system) {
      body.system = [claudeCodePrompt]
    } else if (typeof body.system === 'string') {
      body.system = performanceOptimizer.getPrecompiledPrompt(
        'claude_code_with_string', 
        body.system
      )
    }
    // 优化后的简化逻辑...
  }

  /**
   * 测试对象池性能
   */
  async testObjectPoolPerformance() {
    console.log('🔄 测试对象池性能...')

    const iterations = 50000

    // 测试UUID性能
    console.log('  测试UUID生成和回收...')
    
    // 原始UUID生成
    const { v4: uuidv4 } = require('uuid')
    const uuidOriginalStart = performance.now()
    const uuids = []
    for (let i = 0; i < iterations; i++) {
      uuids.push(uuidv4())
    }
    const uuidOriginalTime = performance.now() - uuidOriginalStart

    // 对象池UUID
    const uuidPoolStart = performance.now()
    const pooledUuids = []
    for (let i = 0; i < iterations; i++) {
      pooledUuids.push(performanceOptimizer.getPooledUUID())
    }
    
    // 回收UUID
    for (const uuid of pooledUuids) {
      performanceOptimizer.recycleUUID(uuid)
    }
    const uuidPoolTime = performance.now() - uuidPoolStart

    // 测试请求上下文对象池
    console.log('  测试请求上下文对象池...')
    
    const contextOriginalStart = performance.now()
    for (let i = 0; i < iterations; i++) {
      const context = {}
      context.id = i
      context.timestamp = Date.now()
      context.data = { test: 'data' }
      // 模拟使用后丢弃
    }
    const contextOriginalTime = performance.now() - contextOriginalStart

    const contextPoolStart = performance.now()
    const contexts = []
    for (let i = 0; i < iterations; i++) {
      const context = performanceOptimizer.getPooledRequestContext()
      context.id = i
      context.timestamp = Date.now()
      context.data = { test: 'data' }
      contexts.push(context)
    }
    
    // 回收对象
    for (const context of contexts) {
      performanceOptimizer.recycleRequestContext(context)
    }
    const contextPoolTime = performance.now() - contextPoolStart

    this.results.objectPool = {
      uuid: {
        original: uuidOriginalTime,
        pooled: uuidPoolTime,
        improvement: ((uuidOriginalTime - uuidPoolTime) / uuidOriginalTime * 100),
        speedup: uuidOriginalTime / uuidPoolTime
      },
      requestContext: {
        original: contextOriginalTime,
        pooled: contextPoolTime,
        improvement: ((contextOriginalTime - contextPoolTime) / contextOriginalTime * 100),
        speedup: contextOriginalTime / contextPoolTime
      }
    }

    console.log(`    UUID - 原始: ${uuidOriginalTime.toFixed(2)}ms, 池化: ${uuidPoolTime.toFixed(2)}ms, 提升: ${this.results.objectPool.uuid.improvement.toFixed(1)}%`)
    console.log(`    Context - 原始: ${contextOriginalTime.toFixed(2)}ms, 池化: ${contextPoolTime.toFixed(2)}ms, 提升: ${this.results.objectPool.requestContext.improvement.toFixed(1)}%`)
    console.log('')
  }

  /**
   * 测试账户缓存性能
   */
  async testAccountCachePerformance() {
    console.log('🏪 测试账户配置缓存性能...')

    const accountIds = Array.from({ length: 100 }, (_, i) => `account_${i}`)
    const mockAccountConfig = {
      id: 'test_account',
      proxy: {
        type: 'socks5',
        host: '127.0.0.1',
        port: 1080,
        username: 'user',
        password: 'pass'
      },
      isActive: true,
      status: 'active'
    }

    // 预填充缓存
    for (const accountId of accountIds) {
      performanceOptimizer.cacheAccountConfig(accountId, { ...mockAccountConfig, id: accountId })
    }

    const iterations = 10000

    // 测试缓存命中性能
    const cacheStart = performance.now()
    let cacheHits = 0
    for (let i = 0; i < iterations; i++) {
      const accountId = accountIds[i % accountIds.length]
      const config = performanceOptimizer.getCachedAccountConfig(accountId)
      if (config) cacheHits++
    }
    const cacheTime = performance.now() - cacheStart

    // 模拟数据库查询性能（简化）
    const dbStart = performance.now()
    for (let i = 0; i < iterations; i++) {
      // 模拟数据库查询延迟
      const mockDbDelay = Math.random() * 0.1 // 0-0.1ms模拟查询
      const startTime = performance.now()
      while (performance.now() - startTime < mockDbDelay) {
        // 忙等待模拟查询时间
      }
    }
    const dbTime = performance.now() - dbStart

    this.results.accountCache = {
      cache: cacheTime,
      database: dbTime,
      hitRate: (cacheHits / iterations) * 100,
      improvement: ((dbTime - cacheTime) / dbTime * 100),
      speedup: dbTime / cacheTime
    }

    console.log(`    缓存查询: ${cacheTime.toFixed(2)}ms`)
    console.log(`    数据库查询: ${dbTime.toFixed(2)}ms`) 
    console.log(`    缓存命中率: ${this.results.accountCache.hitRate.toFixed(1)}%`)
    console.log(`    性能提升: ${this.results.accountCache.improvement.toFixed(1)}% (${this.results.accountCache.speedup.toFixed(1)}x)`)
    console.log('')
  }

  /**
   * 测试内存使用
   */
  async testMemoryUsage() {
    console.log('🧠 测试内存使用优化...')

    // 记录初始内存
    const initialMemory = process.memoryUsage()

    // 执行大量操作来测试内存管理
    const operations = 1000
    console.log(`  执行 ${operations} 次复合操作...`)

    for (let i = 0; i < operations; i++) {
      // 智能拷贝
      performanceOptimizer.smartCopyRequestBody(this.testData.complex, true, false)
      
      // 对象池操作
      const uuid = performanceOptimizer.getPooledUUID()
      const context = performanceOptimizer.getPooledRequestContext()
      performanceOptimizer.recycleUUID(uuid)
      performanceOptimizer.recycleRequestContext(context)
      
      // 缓存操作
      performanceOptimizer.cacheAccountConfig(`test_${i}`, { id: `test_${i}` })
      performanceOptimizer.getCachedAccountConfig(`test_${i}`)
    }

    // 手动触发垃圾回收（如果可用）
    if (global.gc) {
      global.gc()
    }

    const finalMemory = process.memoryUsage()

    this.results.memoryUsage = {
      initial: initialMemory,
      final: finalMemory,
      heapGrowth: finalMemory.heapUsed - initialMemory.heapUsed,
      rssGrowth: finalMemory.rss - initialMemory.rss,
      optimizerStats: performanceOptimizer.getStats()
    }

    console.log(`    初始堆内存: ${(initialMemory.heapUsed / 1024 / 1024).toFixed(2)}MB`)
    console.log(`    最终堆内存: ${(finalMemory.heapUsed / 1024 / 1024).toFixed(2)}MB`)
    console.log(`    堆内存增长: ${(this.results.memoryUsage.heapGrowth / 1024 / 1024).toFixed(2)}MB`)
    console.log(`    RSS增长: ${(this.results.memoryUsage.rssGrowth / 1024 / 1024).toFixed(2)}MB`)
    console.log('')
  }

  /**
   * 测试整体性能
   */
  async testOverallPerformance() {
    console.log('🎯 测试整体性能优化...')

    const iterations = 1000
    const clientHeaders = { 'user-agent': 'test-client/1.0' }

    // 模拟原始处理流程
    const originalStart = performance.now()
    for (let i = 0; i < iterations; i++) {
      const body = JSON.parse(JSON.stringify(this.testData.complex))
      this.simulateOriginalSystemPromptProcessing(body)
    }
    const originalTime = performance.now() - originalStart

    // 模拟优化后处理流程
    const optimizedStart = performance.now()
    for (let i = 0; i < iterations; i++) {
      const body = performanceOptimizer.smartCopyRequestBody(this.testData.complex, true, false)
      this.simulateOptimizedSystemPromptProcessing(body)
    }
    const optimizedTime = performance.now() - optimizedStart

    this.results.overall = {
      original: originalTime,
      optimized: optimizedTime,
      improvement: ((originalTime - optimizedTime) / originalTime * 100),
      speedup: originalTime / optimizedTime
    }

    console.log(`    原始处理: ${originalTime.toFixed(2)}ms`)
    console.log(`    优化处理: ${optimizedTime.toFixed(2)}ms`)
    console.log(`    整体性能提升: ${this.results.overall.improvement.toFixed(1)}% (${this.results.overall.speedup.toFixed(1)}x)`)
    console.log('')
  }

  /**
   * 生成详细的性能报告
   */
  generateReport() {
    console.log('📊 性能优化基准测试报告')
    console.log('=' * 50)
    
    console.log('\n🚀 整体性能提升:')
    console.log(`  - 整体处理速度提升: ${this.results.overall.improvement.toFixed(1)}%`)
    console.log(`  - 加速比: ${this.results.overall.speedup.toFixed(1)}x`)
    
    console.log('\n📋 深拷贝优化效果:')
    for (const [testCase, result] of Object.entries(this.results.deepCopy)) {
      console.log(`  - ${testCase}: ${result.improvement.toFixed(1)}% 提升 (${result.speedup.toFixed(1)}x)`)
    }
    
    console.log('\n💭 系统提示词优化:')
    if (this.results.systemPrompt.variations) {
      this.results.systemPrompt.variations.forEach((result, i) => {
        if (result) {
          console.log(`  - 变体 ${i + 1}: ${result.improvement.toFixed(1)}% 提升 (${result.speedup.toFixed(1)}x)`)
        }
      })
    }
    
    console.log('\n🔄 对象池优化:')
    console.log(`  - UUID池: ${this.results.objectPool.uuid.improvement.toFixed(1)}% 提升`)
    console.log(`  - 上下文池: ${this.results.objectPool.requestContext.improvement.toFixed(1)}% 提升`)
    
    console.log('\n🏪 缓存优化:')
    console.log(`  - 缓存命中率: ${this.results.accountCache.hitRate.toFixed(1)}%`)
    console.log(`  - 查询性能提升: ${this.results.accountCache.improvement.toFixed(1)}%`)
    
    console.log('\n🧠 内存使用:')
    console.log(`  - 堆内存增长: ${(this.results.memoryUsage.heapGrowth / 1024 / 1024).toFixed(2)}MB`)
    console.log(`  - 对象池状态: ${JSON.stringify(this.results.memoryUsage.optimizerStats.objectPool)}`)
    
    console.log('\n📈 性能改进汇总:')
    const improvements = [
      { name: '深拷贝', value: this.results.deepCopy.complex?.improvement || 0 },
      { name: '系统提示词', value: this.results.systemPrompt.variations?.[0]?.improvement || 0 },
      { name: '对象池', value: this.results.objectPool.uuid.improvement },
      { name: '缓存', value: this.results.accountCache.improvement },
      { name: '整体', value: this.results.overall.improvement }
    ]
    
    improvements.forEach(item => {
      console.log(`  - ${item.name}: ${item.value.toFixed(1)}% 提升`)
    })
    
    const averageImprovement = improvements.reduce((sum, item) => sum + item.value, 0) / improvements.length
    console.log(`  - 平均提升: ${averageImprovement.toFixed(1)}%`)
    
    console.log('\n✅ 基准测试完成!')
    console.log(`📝 详细结果已保存到内存中，可通过 .results 属性访问`)
  }
}

// 如果直接运行此脚本
if (require.main === module) {
  const benchmark = new PerformanceBenchmarkSuite()
  
  benchmark.runFullBenchmark().then(() => {
    console.log('\n🎉 所有基准测试已完成!')
    process.exit(0)
  }).catch(error => {
    console.error('❌ 基准测试失败:', error)
    process.exit(1)
  })
}

module.exports = PerformanceBenchmarkSuite