/**
 * ClaudeAccountService Merge功能单元测试
 * 测试merge冲突解决后的功能：会话窗口状态清理和自动恢复调度逻辑
 */

const claudeAccountService = require('../../../src/services/claudeAccountService')
const redis = require('../../../src/models/redis')
const logger = require('../../../src/utils/logger')

// Mock所有外部依赖
jest.mock('../../../src/models/redis')
jest.mock('../../../src/utils/logger')
jest.mock('../../../src/utils/webhookNotifier')

describe('ClaudeAccountService Merge功能测试', () => {
  let mockRedis
  let mockWebhookNotifier

  const testAccountId = 'test-account-123'
  const now = new Date()
  const windowStart = new Date(now.getTime() - 2 * 60 * 60 * 1000) // 2小时前
  const windowEnd = new Date(now.getTime() + 3 * 60 * 60 * 1000) // 3小时后

  const mockAccountData = {
    id: testAccountId,
    name: 'Test Account',
    description: 'Test Claude Account',
    isActive: 'true',
    status: 'active',
    schedulable: 'true',
    sessionWindowStart: windowStart.toISOString(),
    sessionWindowEnd: windowEnd.toISOString(),
    lastRequestTime: now.toISOString()
  }

  beforeEach(() => {
    jest.clearAllMocks()

    // 设置Redis mock
    mockRedis = {
      getClaudeAccount: jest.fn(),
      setClaudeAccount: jest.fn()
    }
    redis.getClaudeAccount = mockRedis.getClaudeAccount
    redis.setClaudeAccount = mockRedis.setClaudeAccount

    // Mock webhook notifier
    mockWebhookNotifier = {
      sendAccountAnomalyNotification: jest.fn().mockResolvedValue()
    }
    jest.doMock('../../../src/utils/webhookNotifier', () => mockWebhookNotifier)
  })

  describe('updateSessionWindow - 会话窗口状态清理测试', () => {
    test('应该清除会话窗口状态当进入新窗口时', async () => {
      const accountDataWithStatus = {
        ...mockAccountData,
        sessionWindowStatus: 'allowed_warning',
        sessionWindowStatusUpdatedAt: new Date().toISOString(),
        // 设置过期的窗口，触发新窗口创建
        sessionWindowStart: new Date(now.getTime() - 6 * 60 * 60 * 1000).toISOString(), // 6小时前开始
        sessionWindowEnd: new Date(now.getTime() - 1 * 60 * 60 * 1000).toISOString() // 1小时前结束（已过期）
      }

      mockRedis.getClaudeAccount.mockResolvedValue(accountDataWithStatus)

      const result = await claudeAccountService.updateSessionWindow(testAccountId)

      // 验证状态被清除
      expect(result.sessionWindowStatus).toBeUndefined()
      expect(result.sessionWindowStatusUpdatedAt).toBeUndefined()

      // 验证Redis被调用保存更新后的数据
      expect(mockRedis.setClaudeAccount).toHaveBeenCalledWith(
        testAccountId,
        expect.not.objectContaining({
          sessionWindowStatus: expect.anything(),
          sessionWindowStatusUpdatedAt: expect.anything()
        })
      )

      // 验证新窗口被创建
      expect(result.sessionWindowStart).toBeTruthy()
      expect(result.sessionWindowEnd).toBeTruthy()
      expect(new Date(result.sessionWindowStart).getTime()).toBeGreaterThanOrEqual(
        new Date(accountDataWithStatus.sessionWindowStart).getTime()
      )
    })

    test('在活跃窗口内时不应该清除会话窗口状态', async () => {
      const accountDataWithStatus = {
        ...mockAccountData,
        sessionWindowStatus: 'allowed',
        sessionWindowStatusUpdatedAt: new Date().toISOString()
      }

      mockRedis.getClaudeAccount.mockResolvedValue(accountDataWithStatus)

      const result = await claudeAccountService.updateSessionWindow(testAccountId, accountDataWithStatus)

      // 在活跃窗口内，状态应该保持
      expect(result.sessionWindowStatus).toBe('allowed')
      expect(result.sessionWindowStatusUpdatedAt).toBeTruthy()

      // 只更新最后请求时间
      expect(result.lastRequestTime).toBeTruthy()
    })
  })

  describe('updateSessionWindow - 自动恢复调度逻辑测试', () => {
    test('应该自动恢复因5小时限制被停止的账户', async () => {
      const stoppedAccountData = {
        ...mockAccountData,
        schedulable: 'false',
        stoppedReason: '5小时使用量接近限制，自动停止调度',
        autoStoppedAt: new Date().toISOString(),
        // 设置过期窗口以触发新窗口创建
        sessionWindowStart: new Date(now.getTime() - 6 * 60 * 60 * 1000).toISOString(),
        sessionWindowEnd: new Date(now.getTime() - 1 * 60 * 60 * 1000).toISOString()
      }

      mockRedis.getClaudeAccount.mockResolvedValue(stoppedAccountData)

      const result = await claudeAccountService.updateSessionWindow(testAccountId)

      // 验证自动恢复逻辑
      expect(result.schedulable).toBe('true')
      expect(result.stoppedReason).toBeUndefined()
      expect(result.autoStoppedAt).toBeUndefined()

      // 验证Webhook通知被发送
      expect(mockWebhookNotifier.sendAccountAnomalyNotification).toHaveBeenCalledWith({
        accountId: testAccountId,
        accountName: 'Test Account',
        platform: 'claude',
        status: 'resumed',
        errorCode: 'CLAUDE_5H_LIMIT_RESUMED',
        reason: '进入新的5小时窗口，已自动恢复调度',
        timestamp: expect.any(String)
      })

      // 验证成功日志
      expect(logger.info).toHaveBeenCalledWith(
        `✅ Auto-resuming scheduling for account ${stoppedAccountData.name} (${testAccountId}) - new session window started`
      )
    })

    test('不应该恢复非5小时限制原因停止的账户', async () => {
      const stoppedAccountData = {
        ...mockAccountData,
        schedulable: 'false',
        stoppedReason: '手动停止调度',
        autoStoppedAt: new Date().toISOString(),
        // 设置过期窗口
        sessionWindowStart: new Date(now.getTime() - 6 * 60 * 60 * 1000).toISOString(),
        sessionWindowEnd: new Date(now.getTime() - 1 * 60 * 60 * 1000).toISOString()
      }

      mockRedis.getClaudeAccount.mockResolvedValue(stoppedAccountData)

      const result = await claudeAccountService.updateSessionWindow(testAccountId)

      // 不应该自动恢复
      expect(result.schedulable).toBe('false')
      expect(result.stoppedReason).toBe('手动停止调度')
      expect(result.autoStoppedAt).toBeTruthy()

      // 不应该发送Webhook通知
      expect(mockWebhookNotifier.sendAccountAnomalyNotification).not.toHaveBeenCalled()
    })

    test('不应该恢复没有autoStoppedAt字段的停止账户', async () => {
      const stoppedAccountData = {
        ...mockAccountData,
        schedulable: 'false',
        stoppedReason: '5小时使用量接近限制，自动停止调度',
        // 没有autoStoppedAt字段
        // 设置过期窗口
        sessionWindowStart: new Date(now.getTime() - 6 * 60 * 60 * 1000).toISOString(),
        sessionWindowEnd: new Date(now.getTime() - 1 * 60 * 60 * 1000).toISOString()
      }

      mockRedis.getClaudeAccount.mockResolvedValue(stoppedAccountData)

      const result = await claudeAccountService.updateSessionWindow(testAccountId)

      // 不应该自动恢复（缺少autoStoppedAt字段）
      expect(result.schedulable).toBe('false')
      expect(result.stoppedReason).toBe('5小时使用量接近限制，自动停止调度')

      // 不应该发送Webhook通知
      expect(mockWebhookNotifier.sendAccountAnomalyNotification).not.toHaveBeenCalled()
    })

    test('Webhook通知失败时应该记录错误但不影响主流程', async () => {
      const stoppedAccountData = {
        ...mockAccountData,
        schedulable: 'false',
        stoppedReason: '5小时使用量接近限制，自动停止调度',
        autoStoppedAt: new Date().toISOString(),
        sessionWindowStart: new Date(now.getTime() - 6 * 60 * 60 * 1000).toISOString(),
        sessionWindowEnd: new Date(now.getTime() - 1 * 60 * 60 * 1000).toISOString()
      }

      // Mock webhook发送失败
      const webhookError = new Error('Webhook failed')
      mockWebhookNotifier.sendAccountAnomalyNotification.mockRejectedValue(webhookError)

      mockRedis.getClaudeAccount.mockResolvedValue(stoppedAccountData)

      const result = await claudeAccountService.updateSessionWindow(testAccountId)

      // 主要逻辑应该仍然成功
      expect(result.schedulable).toBe('true')
      expect(result.stoppedReason).toBeUndefined()
      expect(result.autoStoppedAt).toBeUndefined()

      // 应该记录错误日志
      expect(logger.error).toHaveBeenCalledWith(
        'Failed to send webhook notification:',
        webhookError
      )
    })
  })

  describe('组合场景测试', () => {
    test('应该同时执行状态清理和自动恢复', async () => {
      const complexAccountData = {
        ...mockAccountData,
        // 会话窗口状态
        sessionWindowStatus: 'allowed_warning',
        sessionWindowStatusUpdatedAt: new Date().toISOString(),
        // 自动停止状态
        schedulable: 'false',
        stoppedReason: '5小时使用量接近限制，自动停止调度',
        autoStoppedAt: new Date().toISOString(),
        // 过期的窗口
        sessionWindowStart: new Date(now.getTime() - 6 * 60 * 60 * 1000).toISOString(),
        sessionWindowEnd: new Date(now.getTime() - 1 * 60 * 60 * 1000).toISOString()
      }

      mockRedis.getClaudeAccount.mockResolvedValue(complexAccountData)

      const result = await claudeAccountService.updateSessionWindow(testAccountId)

      // 验证状态清理
      expect(result.sessionWindowStatus).toBeUndefined()
      expect(result.sessionWindowStatusUpdatedAt).toBeUndefined()

      // 验证自动恢复
      expect(result.schedulable).toBe('true')
      expect(result.stoppedReason).toBeUndefined()
      expect(result.autoStoppedAt).toBeUndefined()

      // 验证新窗口创建
      expect(result.sessionWindowStart).toBeTruthy()
      expect(result.sessionWindowEnd).toBeTruthy()

      // 验证最终数据保存
      expect(mockRedis.setClaudeAccount).toHaveBeenCalledWith(
        testAccountId,
        expect.objectContaining({
          schedulable: 'true'
        })
      )
      
      // 验证被删除的字段不存在
      const savedData = mockRedis.setClaudeAccount.mock.calls[0][1]
      expect(savedData).not.toHaveProperty('sessionWindowStatus')
      expect(savedData).not.toHaveProperty('sessionWindowStatusUpdatedAt')
      expect(savedData).not.toHaveProperty('stoppedReason')
      expect(savedData).not.toHaveProperty('autoStoppedAt')

      // 验证Webhook通知
      expect(mockWebhookNotifier.sendAccountAnomalyNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'resumed',
          errorCode: 'CLAUDE_5H_LIMIT_RESUMED'
        })
      )
    })
  })
})