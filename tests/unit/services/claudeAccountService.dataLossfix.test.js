/**
 * Claude Account Service 数据丢失修复测试
 * 专门测试 updateSessionWindow 数据持久化修复和相关安全增强功能
 */

const claudeAccountService = require('../../../src/services/claudeAccountService')
const redis = require('../../../src/models/redis')
const logger = require('../../../src/utils/logger')

// Mock 外部依赖
jest.mock('../../../src/models/redis')
jest.mock('../../../src/utils/logger')

describe('Claude Account Service 数据丢失修复测试', () => {
  let mockRedis

  const testAccountId = 'test-account-123'
  const mockAccountData = {
    id: testAccountId,
    name: 'Test Account',
    email: 'test@example.com',
    accessToken: 'encrypted_access_token',
    refreshToken: 'encrypted_refresh_token',
    lastUsedAt: '2024-01-01T00:00:00.000Z',
    sessionWindowStart: null,
    sessionWindowEnd: null,
    lastRequestTime: null,
    createdAt: '2024-01-01T00:00:00.000Z'
  }

  beforeEach(() => {
    jest.clearAllMocks()
    
    // 设置 mock Redis 方法
    mockRedis = {
      getClaudeAccount: jest.fn(),
      setClaudeAccount: jest.fn(),
      getAllClaudeAccounts: jest.fn()
    }
    
    redis.getClaudeAccount = mockRedis.getClaudeAccount
    redis.setClaudeAccount = mockRedis.setClaudeAccount
    redis.getAllClaudeAccounts = mockRedis.getAllClaudeAccounts
    
    // Mock logger 方法
    logger.info = jest.fn()
    logger.warn = jest.fn()
    logger.error = jest.fn()
    
    // 设置默认返回值
    mockRedis.getClaudeAccount.mockResolvedValue(mockAccountData)
    mockRedis.setClaudeAccount.mockResolvedValue(true)
  })

  describe('updateSessionWindow 数据持久化修复测试', () => {
    test('应该在窗口内更新时保存数据到Redis', async () => {
      // 设置一个活跃的会话窗口
      const now = new Date()
      const windowStart = new Date(now.getTime() - 30 * 60 * 1000) // 30分钟前
      const windowEnd = new Date(now.getTime() + 30 * 60 * 1000) // 30分钟后
      
      const accountDataWithWindow = {
        ...mockAccountData,
        sessionWindowStart: windowStart.toISOString(),
        sessionWindowEnd: windowEnd.toISOString(),
        lastRequestTime: new Date(now.getTime() - 10 * 60 * 1000).toISOString()
      }
      
      mockRedis.getClaudeAccount.mockResolvedValue(accountDataWithWindow)
      
      // 调用方法
      const result = await claudeAccountService.updateSessionWindow(testAccountId)
      
      // 验证数据保存到Redis
      expect(mockRedis.setClaudeAccount).toHaveBeenCalledWith(testAccountId, expect.objectContaining({
        lastRequestTime: expect.any(String),
        sessionWindowStart: windowStart.toISOString(),
        sessionWindowEnd: windowEnd.toISOString()
      }))
      
      // 验证返回的数据结构
      expect(result.lastRequestTime).toBeTruthy()
      expect(result.sessionWindowStart).toBe(windowStart.toISOString())
      expect(result.sessionWindowEnd).toBe(windowEnd.toISOString())
    })

    test('应该在创建新窗口时保存数据到Redis', async () => {
      // 设置无会话窗口或过期窗口的账户数据
      const accountDataNoWindow = {
        ...mockAccountData,
        sessionWindowStart: null,
        sessionWindowEnd: null,
        lastRequestTime: null
      }
      
      mockRedis.getClaudeAccount.mockResolvedValue(accountDataNoWindow)
      
      // 调用方法
      const result = await claudeAccountService.updateSessionWindow(testAccountId)
      
      // 验证数据保存到Redis
      expect(mockRedis.setClaudeAccount).toHaveBeenCalledWith(testAccountId, expect.objectContaining({
        sessionWindowStart: expect.any(String),
        sessionWindowEnd: expect.any(String),
        lastRequestTime: expect.any(String)
      }))
      
      // 验证新窗口已创建
      expect(result.sessionWindowStart).toBeTruthy()
      expect(result.sessionWindowEnd).toBeTruthy()
      expect(result.lastRequestTime).toBeTruthy()
      
      // 验证日志记录
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('Created new session window')
      )
    })

    test('应该在窗口过期时创建新窗口并保存到Redis', async () => {
      const now = new Date()
      const expiredWindowStart = new Date(now.getTime() - 120 * 60 * 1000) // 2小时前
      const expiredWindowEnd = new Date(now.getTime() - 60 * 60 * 1000) // 1小时前过期
      
      const accountDataWithExpiredWindow = {
        ...mockAccountData,
        sessionWindowStart: expiredWindowStart.toISOString(),
        sessionWindowEnd: expiredWindowEnd.toISOString(),
        lastRequestTime: expiredWindowStart.toISOString()
      }
      
      mockRedis.getClaudeAccount.mockResolvedValue(accountDataWithExpiredWindow)
      
      // 调用方法
      const result = await claudeAccountService.updateSessionWindow(testAccountId)
      
      // 验证数据保存到Redis
      expect(mockRedis.setClaudeAccount).toHaveBeenCalledWith(testAccountId, expect.objectContaining({
        sessionWindowStart: expect.any(String),
        sessionWindowEnd: expect.any(String),
        lastRequestTime: expect.any(String)
      }))
      
      // 验证新窗口已创建（不同于过期的窗口）
      expect(result.sessionWindowStart).not.toBe(expiredWindowStart.toISOString())
      expect(result.sessionWindowEnd).not.toBe(expiredWindowEnd.toISOString())
      
      // 验证窗口过期日志
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('Session window expired')
      )
    })

    test('应该正确处理传入的accountData参数并保存', async () => {
      const passedAccountData = { ...mockAccountData }
      
      // 不设置 getClaudeAccount 的返回值，因为我们传入了 accountData
      
      // 调用方法并传入 accountData
      const result = await claudeAccountService.updateSessionWindow(testAccountId, passedAccountData)
      
      // 验证没有从Redis获取数据
      expect(mockRedis.getClaudeAccount).not.toHaveBeenCalled()
      
      // 验证数据被保存到Redis
      expect(mockRedis.setClaudeAccount).toHaveBeenCalledWith(testAccountId, expect.any(Object))
      
      // 验证返回数据包含新的会话窗口信息
      expect(result.sessionWindowStart).toBeTruthy()
      expect(result.sessionWindowEnd).toBeTruthy()
      expect(result.lastRequestTime).toBeTruthy()
    })

    test('应该在Redis保存失败时抛出错误', async () => {
      mockRedis.setClaudeAccount.mockRejectedValue(new Error('Redis save failed'))
      
      // 调用方法并期望抛出错误
      await expect(
        claudeAccountService.updateSessionWindow(testAccountId)
      ).rejects.toThrow()
      
      // 验证错误日志
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('Failed to update session window'),
        expect.any(Error)
      )
    })

    test('应该在账户不存在时抛出错误', async () => {
      mockRedis.getClaudeAccount.mockResolvedValue(null)
      
      // 调用方法并期望抛出错误
      await expect(
        claudeAccountService.updateSessionWindow(testAccountId)
      ).rejects.toThrow('Account not found')
    })

    test('应该在Redis获取账户失败时抛出错误', async () => {
      mockRedis.getClaudeAccount.mockRejectedValue(new Error('Redis get failed'))
      
      // 调用方法并期望抛出错误
      await expect(
        claudeAccountService.updateSessionWindow(testAccountId)
      ).rejects.toThrow()
      
      // 验证错误日志
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('Failed to update session window'),
        expect.any(Error)
      )
    })
  })

  describe('数据持久化完整性测试', () => {
    test('应该确保每次更新都调用Redis保存操作', async () => {
      const testCases = [
        // 无窗口
        { sessionWindowStart: null, sessionWindowEnd: null },
        // 过期窗口
        { 
          sessionWindowStart: new Date(Date.now() - 120 * 60 * 1000).toISOString(),
          sessionWindowEnd: new Date(Date.now() - 60 * 60 * 1000).toISOString()
        },
        // 活跃窗口
        { 
          sessionWindowStart: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
          sessionWindowEnd: new Date(Date.now() + 30 * 60 * 1000).toISOString()
        }
      ]
      
      for (const testCase of testCases) {
        // 清理之前的调用
        mockRedis.setClaudeAccount.mockClear()
        
        const accountData = { ...mockAccountData, ...testCase }
        mockRedis.getClaudeAccount.mockResolvedValue(accountData)
        
        // 调用方法
        await claudeAccountService.updateSessionWindow(testAccountId)
        
        // 验证每种情况都保存到Redis
        expect(mockRedis.setClaudeAccount).toHaveBeenCalledTimes(1)
        expect(mockRedis.setClaudeAccount).toHaveBeenCalledWith(testAccountId, expect.any(Object))
      }
    })

    test('应该保持数据一致性和完整性', async () => {
      const originalData = { ...mockAccountData }
      
      const result = await claudeAccountService.updateSessionWindow(testAccountId, originalData)
      
      // 获取保存到Redis的数据
      const savedData = mockRedis.setClaudeAccount.mock.calls[0][1]
      
      // 验证原始数据保持不变（除了会话窗口相关字段）
      expect(savedData.id).toBe(originalData.id)
      expect(savedData.name).toBe(originalData.name)
      expect(savedData.email).toBe(originalData.email)
      expect(savedData.accessToken).toBe(originalData.accessToken)
      expect(savedData.refreshToken).toBe(originalData.refreshToken)
      expect(savedData.createdAt).toBe(originalData.createdAt)
      
      // 验证会话窗口字段已更新
      expect(savedData.sessionWindowStart).toBeTruthy()
      expect(savedData.sessionWindowEnd).toBeTruthy()
      expect(savedData.lastRequestTime).toBeTruthy()
      
      // 验证返回的数据与保存的数据一致
      expect(result).toEqual(savedData)
    })
  })

  describe('边界条件和错误处理测试', () => {
    test('应该处理空的accountData对象', async () => {
      mockRedis.getClaudeAccount.mockResolvedValue({})
      
      await expect(
        claudeAccountService.updateSessionWindow(testAccountId)
      ).rejects.toThrow('Account not found')
    })

    test('应该处理Redis连接超时', async () => {
      const timeoutError = new Error('Connection timeout')
      timeoutError.code = 'ETIMEDOUT'
      
      mockRedis.setClaudeAccount.mockRejectedValue(timeoutError)
      
      await expect(
        claudeAccountService.updateSessionWindow(testAccountId)
      ).rejects.toThrow('Connection timeout')
    })

    test('应该处理并发更新场景', async () => {
      // 模拟并发调用
      const promises = Array(5).fill().map(() => 
        claudeAccountService.updateSessionWindow(testAccountId)
      )
      
      const results = await Promise.all(promises)
      
      // 验证所有调用都成功
      results.forEach(result => {
        expect(result).toBeTruthy()
        expect(result.sessionWindowStart).toBeTruthy()
        expect(result.sessionWindowEnd).toBeTruthy()
      })
      
      // 验证Redis保存被调用了正确的次数
      expect(mockRedis.setClaudeAccount).toHaveBeenCalledTimes(5)
    })
  })
})