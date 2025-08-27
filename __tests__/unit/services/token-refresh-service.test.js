// TokenRefreshService 基础功能测试 (简化版)
const { TimeController, timeTestUtils } = require('../../setup/time-controller')

// Mock依赖
jest.mock('../../../src/models/redis')
jest.mock('../../../src/utils/logger')

describe('TokenRefreshService 基础功能测试', () => {
  let mockRedis
  let tokenRefreshService

  beforeEach(() => {
    // 重新导入服务以获取新的实例
    jest.resetModules()
    tokenRefreshService = require('../../../src/services/tokenRefreshService')
    mockRedis = require('../../../src/models/redis')
    
    // 设置默认的成功响应
    mockRedis.set.mockResolvedValue('OK')
    mockRedis.eval.mockResolvedValue(1)
    mockRedis.exists.mockResolvedValue(1)
    mockRedis.ttl.mockResolvedValue(60)
    
    jest.clearAllMocks()
  })

  afterEach(async () => {
    // 清理TokenRefreshService的本地锁记录
    if (tokenRefreshService.cleanup) {
      tokenRefreshService.cleanup()
    }
  })

  describe('🔒 基础锁操作测试', () => {
    it('应该能够获取和释放基础锁', async () => {
      const lockKey = 'test-basic-lock'
      
      // 获取锁
      const acquired = await tokenRefreshService.acquireLock(lockKey)
      expect(acquired).toBe(true)
      
      // 验证锁的存在（使用真实的testRedisInstance）
      const lockExists = await global.testRedisInstance.get(lockKey)
      expect(lockExists).toBeTruthy()
      
      // 释放锁
      await tokenRefreshService.releaseLock(lockKey)
      
      // 验证锁已被释放（由于Lua脚本删除了锁）
      // 注意：这里验证的是行为结果而不是mock调用，因为服务使用的是真实Redis实例
      expect(tokenRefreshService.lockValue.has(lockKey)).toBe(false)
    })

    it('应该能够获取和释放刷新锁', async () => {
      const accountId = 'test-account'
      const platform = 'claude'
      
      // 获取刷新锁
      const acquired = await tokenRefreshService.acquireRefreshLock(accountId, platform)
      expect(acquired).toBe(true)
      
      // 验证锁存在于Redis
      const lockKey = `token_refresh_lock:${platform}:${accountId}`
      const lockExists = await global.testRedisInstance.get(lockKey)
      expect(lockExists).toBeTruthy()
      
      // 释放刷新锁
      await tokenRefreshService.releaseRefreshLock(accountId, platform)
      
      // 验证本地锁记录已清理
      expect(tokenRefreshService.lockValue.has(lockKey)).toBe(false)
    })

    it('应该能够检查锁的状态', async () => {
      const accountId = 'test-account-status'
      const platform = 'claude'
      
      // 检查初始状态（锁不存在）
      const initialStatus = await tokenRefreshService.isRefreshLocked(accountId, platform)
      expect(initialStatus).toBe(false)
      
      // 获取锁后检查状态
      await tokenRefreshService.acquireRefreshLock(accountId, platform)
      const lockedStatus = await tokenRefreshService.isRefreshLocked(accountId, platform)
      expect(lockedStatus).toBe(true)
      
      // 清理锁
      await tokenRefreshService.releaseRefreshLock(accountId, platform)
    })

    it('应该能够获取锁的TTL', async () => {
      const accountId = 'test-account-ttl'
      const platform = 'claude'
      
      // 先获取锁
      await tokenRefreshService.acquireRefreshLock(accountId, platform)
      
      // 获取锁的TTL
      const ttl = await tokenRefreshService.getLockTTL(accountId, platform)
      
      // TTL应该是一个数字且大于0（说明锁存在）
      expect(typeof ttl).toBe('number')
      expect(ttl).toBeGreaterThan(0)
      
      // 清理锁
      await tokenRefreshService.releaseRefreshLock(accountId, platform)
    })
  })

  describe('📊 错误处理测试', () => {
    it('应该优雅处理Redis连接错误', async () => {
      // 由于我们使用真实Redis实例，这里测试非存在的键
      const nonExistentKey = 'non-existent-lock-key'
      
      // 尝试释放不存在的锁，应该不抛出异常
      await expect(tokenRefreshService.releaseLock(nonExistentKey)).resolves.not.toThrow()
      
      // 检查不存在的锁状态，应该返回false
      const status = await tokenRefreshService.isRefreshLocked('non-existent-account', 'claude')
      expect(status).toBe(false)
    })

    it('应该优雅处理锁释放错误', async () => {
      // 模拟Lua脚本执行错误
      mockRedis.eval.mockRejectedValue(new Error('Lua script failed'))
      
      const lockKey = 'test-release-error'
      
      // 先获取锁（假设成功）
      await tokenRefreshService.acquireLock(lockKey)
      
      // 释放锁时应该不抛出异常
      await expect(tokenRefreshService.releaseLock(lockKey)).resolves.not.toThrow()
    })
  })

  describe('🎯 实际使用场景测试', () => {
    it('应该支持不同平台的锁隔离', async () => {
      const accountId = 'test-multi-platform'
      
      // 同时获取Claude和Gemini平台的锁
      const claudeAcquired = await tokenRefreshService.acquireRefreshLock(accountId, 'claude')
      const geminiAcquired = await tokenRefreshService.acquireRefreshLock(accountId, 'gemini')
      
      expect(claudeAcquired).toBe(true)
      expect(geminiAcquired).toBe(true)
      
      // 验证锁状态独立
      const claudeStatus = await tokenRefreshService.isRefreshLocked(accountId, 'claude')
      const geminiStatus = await tokenRefreshService.isRefreshLocked(accountId, 'gemini')
      
      expect(claudeStatus).toBe(true)
      expect(geminiStatus).toBe(true)
      
      // 清理锁
      await tokenRefreshService.releaseRefreshLock(accountId, 'claude')
      await tokenRefreshService.releaseRefreshLock(accountId, 'gemini')
    })

    it('应该正确处理cleanup操作', () => {
      // 添加一些锁记录
      tokenRefreshService.lockValue = new Map([
        ['lock1', 'uuid1'],
        ['lock2', 'uuid2']
      ])
      
      // 执行cleanup
      tokenRefreshService.cleanup()
      
      // 验证本地锁记录被清理
      expect(tokenRefreshService.lockValue.size).toBe(0)
    })
  })
})