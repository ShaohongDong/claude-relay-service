// 测试环境设置文件
const path = require('path')
const { RedisMock } = require('./redis-mock')
const { TimeController, globalTimeController, timeTestUtils } = require('./time-controller')
const { NetworkSimulator, networkTestUtils } = require('./network-simulator')

// 设置环境变量
process.env.NODE_ENV = 'test'
process.env.JWT_SECRET = 'test-jwt-secret-key-for-testing-only'
process.env.ENCRYPTION_KEY = '12345678901234567890123456789012' // 32字符测试密钥
process.env.ENCRYPTION_SALT = 'test-encryption-salt-for-testing-only' // 加密盐值
process.env.REDIS_HOST = 'localhost'
process.env.REDIS_PORT = '6379'
process.env.API_KEY_SALT = 'test-api-key-salt-for-testing-only'

// 🌐 禁用代理设置以确保nock正常工作
delete process.env.HTTP_PROXY
delete process.env.HTTPS_PROXY
delete process.env.http_proxy
delete process.env.https_proxy
delete process.env.ALL_PROXY
delete process.env.all_proxy

// 设置测试配置路径
const configPath = path.join(__dirname, '../../config/test-config.js')

// 创建全局Redis Mock实例
global.testRedisInstance = new RedisMock()

// Mock Logger模块以防止异步日志文件创建
jest.mock('../../src/utils/logger', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
  verbose: jest.fn(),
  success: jest.fn(),
  authDetail: jest.fn()
}))

// 🕒 时间控制系统 - 使用真实的fake-timers替代简单mock
// 注意：不再简单mock定时器，而是通过TimeController精确控制
// 这样可以测试真实的定时器行为，包括17个不同的定时器场景

// Mock Redis模块
jest.mock('../../src/models/redis', () => {
  return {
    getClient: () => global.testRedisInstance,
    getClientSafe: () => global.testRedisInstance, // 🔒 新增分布式锁支持
    client: global.testRedisInstance,
    incrConcurrency: (apiKeyId) => global.testRedisInstance.incrConcurrency(apiKeyId),
    decrConcurrency: (apiKeyId) => global.testRedisInstance.decrConcurrency(apiKeyId),
    get: (key) => global.testRedisInstance.get(key),
    set: (key, value, ...args) => global.testRedisInstance.set(key, value, ...args),
    setex: (key, seconds, value) => global.testRedisInstance.setex(key, seconds, value),
    del: (...keys) => global.testRedisInstance.del(...keys),
    exists: (...keys) => global.testRedisInstance.exists(...keys),
    keys: (pattern) => global.testRedisInstance.keys(pattern),
    // 🔒 分布式锁相关方法
    eval: (...args) => global.testRedisInstance.eval(...args),
    setnx: (key, value) => global.testRedisInstance.setnx(key, value),
    // Claude account specific methods
    getClaudeAccount: jest.fn(),
    setClaudeAccount: jest.fn(),
    getAllClaudeAccounts: jest.fn(),
    deleteClaudeAccount: jest.fn(),
    // Session mapping methods
    getSessionAccountMapping: jest.fn(),
    setSessionAccountMapping: jest.fn(),
    deleteSessionAccountMapping: jest.fn()
  }
})

// 全局测试超时
jest.setTimeout(10000)

// 全局测试钩子
beforeAll(async () => {
  // 测试开始前的全局设置
  console.log('🧪 Starting test suite...')
})

afterAll(async () => {
  // 🕒 确保时间控制器被正确清理
  if (globalTimeController.isActive) {
    globalTimeController.stop()
  }
  
  // 测试结束后的清理
  console.log('✅ Test suite completed')
})

// 每个测试前的设置
beforeEach(() => {
  // 清理模拟和重置状态
  jest.clearAllMocks()
  
  // 清理Redis Mock数据
  if (global.testRedisInstance) {
    global.testRedisInstance.flushall()
  }
  
  // 🕒 确保时间控制器在每个测试前是干净的状态
  try {
    if (globalTimeController && globalTimeController.isActive) {
      globalTimeController.stop()
    }
  } catch (error) {
    // 忽略清理错误，确保测试可以继续
    console.warn('Warning: Failed to clean up TimeController:', error.message)
  }
  
  // 🌐 清理网络模拟器状态 (但保持nock可用)
  try {
    const nock = require('nock')
    // 只清理已完成的拦截器，不清理正在使用的
    nock.cleanAll()
    // 重新启用网络连接，让每个测试自行决定是否使用nock
    nock.enableNetConnect()
  } catch (error) {
    // 忽略清理错误，确保测试可以继续
    console.warn('Warning: Failed to clean up NetworkSimulator:', error.message)
  }
})

// 全局错误处理
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason)
})

// 设置测试工具
global.testUtils = {
  // 生成测试用的API Key
  generateTestApiKey: () => 'cr_test_' + Math.random().toString(36).substring(2),
  
  // 生成测试用的哈希
  generateTestHash: () => 'testhash_' + Math.random().toString(36).substring(2),
  
  // 模拟延迟
  delay: (ms) => new Promise(resolve => setTimeout(resolve, ms)),
  
  // 创建模拟请求对象
  createMockRequest: (overrides = {}) => ({
    headers: {},
    body: {},
    ip: '127.0.0.1',
    query: {},
    get: jest.fn((header) => overrides.headers?.[header.toLowerCase()] || null),
    originalUrl: '/test',
    // 添加事件监听方法用于并发限制测试
    on: jest.fn(),
    once: jest.fn(),
    removeListener: jest.fn(),
    ...overrides
  }),
  
  // 创建模拟响应对象
  createMockResponse: () => {
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
      send: jest.fn().mockReturnThis(),
      setHeader: jest.fn().mockReturnThis(),
      write: jest.fn().mockReturnThis(),
      end: jest.fn().mockReturnThis(),
      // 添加事件监听方法用于并发限制测试
      on: jest.fn().mockReturnThis(),
      once: jest.fn().mockReturnThis(),
      removeListener: jest.fn().mockReturnThis()
    }
    return res
  },
  
  // 创建模拟next函数
  createMockNext: () => jest.fn(),
  
  // 🕒 时间控制相关工具
  TimeController,
  timeTestUtils,
  globalTimeController,
  
  // 便捷的时间控制函数
  withTimeControl: timeTestUtils.withTimeControl,
  
  // 时间常量
  TIME: timeTestUtils.TIME_CONSTANTS,
  
  // 🌐 网络模拟相关工具
  NetworkSimulator,
  networkTestUtils,
  
  // 便捷的网络模拟函数
  withNetworkSimulation: networkTestUtils.withNetworkSimulation
}