/**
 * Jest 测试设置文件
 * 全局测试配置和模拟设置
 */

// 设置测试环境变量
process.env.NODE_ENV = 'test'
process.env.API_KEY_PREFIX = 'cr_'
process.env.ENCRYPTION_KEY = 'test-encryption-key-123456789012'
process.env.JWT_SECRET = 'test-jwt-secret-key-for-testing-only'
process.env.REDIS_HOST = 'localhost'
process.env.REDIS_PORT = '6379'
process.env.LOG_LEVEL = 'error'
// 新增安全配置变量
process.env.ENCRYPTION_SALT = 'test-encryption-salt-for-testing'
process.env.API_KEY_SALT = 'test-api-key-salt-for-testing-32char'

// 全局测试超时
jest.setTimeout(30000)

// 全局 beforeEach 设置
beforeEach(() => {
  // 清除所有定时器
  jest.clearAllTimers()
  
  // 重置所有模块
  jest.resetModules()
})

// 全局 afterEach 清理
afterEach(() => {
  // 清除所有定时器
  jest.clearAllTimers()
  
  // 清除所有mock
  jest.clearAllMocks()
})

// 全局错误处理
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason)
})

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error)
})

// 模拟 console.log 在测试期间
if (process.env.SILENT_TESTS === 'true') {
  global.console = {
    ...console,
    log: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
  }
}