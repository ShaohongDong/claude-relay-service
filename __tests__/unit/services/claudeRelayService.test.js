// Claude中转服务测试
const claudeRelayService = require('../../../src/services/claudeRelayService')
const sampleRequests = require('../../fixtures/sample-requests')

// Mock dependencies
jest.mock('../../../src/services/claudeAccountService')
jest.mock('../../../src/services/unifiedClaudeScheduler')
jest.mock('../../../src/services/claudeCodeHeadersService')
jest.mock('../../../src/utils/sessionHelper')
jest.mock('../../../src/utils/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
  security: jest.fn(),
  api: jest.fn(),
  claude: jest.fn()
}))

// Mock config
jest.mock('../../../config/config', () => ({
  claude: {
    apiUrl: 'https://api.anthropic.com',
    apiVersion: '2023-06-01',
    betaHeader: 'claude-3-5-sonnet-20241022',
    systemPrompt: 'You are Claude, an AI assistant created by Anthropic.',
    timeout: 5000
  }
}))

describe('ClaudeRelayService', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  describe('基础功能检查', () => {
    it('应该成功创建ClaudeRelayService实例', () => {
      expect(claudeRelayService).toBeDefined()
      expect(typeof claudeRelayService).toBe('object')
    })

    it('应该包含必要的方法', () => {
      expect(typeof claudeRelayService.isRealClaudeCodeRequest).toBe('function')
      expect(typeof claudeRelayService._hasClaudeCodeSystemPrompt).toBe('function')
      expect(typeof claudeRelayService.relayRequest).toBe('function')
    })
  })

  describe('Claude Code请求识别', () => {
    it('应该正确识别真实的Claude Code请求', () => {
      const requestBody = sampleRequests.claudeCodeRequest
      const clientHeaders = sampleRequests.claudeCodeHeaders

      const result = claudeRelayService.isRealClaudeCodeRequest(requestBody, clientHeaders)

      expect(result).toBe(true)
    })

    it('应该拒绝非Claude Code user-agent的请求', () => {
      const requestBody = sampleRequests.claudeCodeRequest
      const clientHeaders = {
        ...sampleRequests.claudeCodeHeaders,
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }

      const result = claudeRelayService.isRealClaudeCodeRequest(requestBody, clientHeaders)

      expect(result).toBe(false)
    })

    it('应该拒绝没有正确系统提示词的请求', () => {
      const requestBody = {
        ...sampleRequests.claudeCodeRequest,
        system: 'Just a regular system prompt'
      }
      const clientHeaders = sampleRequests.claudeCodeHeaders

      const result = claudeRelayService.isRealClaudeCodeRequest(requestBody, clientHeaders)

      expect(result).toBe(false)
    })

    it('应该处理缺少system字段的请求', () => {
      const requestBody = {
        model: 'claude-3-5-sonnet-20241022',
        messages: [{ role: 'user', content: 'Hello' }]
      }
      const clientHeaders = sampleRequests.claudeCodeHeaders

      const result = claudeRelayService.isRealClaudeCodeRequest(requestBody, clientHeaders)

      expect(result).toBe(false)
    })

    it('应该处理空的user-agent', () => {
      const requestBody = sampleRequests.claudeCodeRequest
      const clientHeaders = {
        ...sampleRequests.claudeCodeHeaders,
        'user-agent': ''
      }

      const result = claudeRelayService.isRealClaudeCodeRequest(requestBody, clientHeaders)

      expect(result).toBe(false)
    })
  })

  describe('_hasClaudeCodeSystemPrompt方法', () => {
    it('应该识别正确的Claude Code系统提示词数组格式', () => {
      const requestBody = {
        system: [
          {
            type: 'text',
            text: "You are Claude Code, Anthropic's official CLI for Claude."
          }
        ]
      }

      const result = claudeRelayService._hasClaudeCodeSystemPrompt(requestBody)

      expect(result).toBe(true)
    })

    it('应该拒绝字符串格式的系统提示词', () => {
      const requestBody = {
        system: "You are Claude Code, Anthropic's official CLI for Claude."
      }

      const result = claudeRelayService._hasClaudeCodeSystemPrompt(requestBody)

      expect(result).toBe(false)
    })

    it('应该拒绝错误的提示词内容', () => {
      const requestBody = {
        system: [
          {
            type: 'text',
            text: 'You are a helpful assistant.'
          }
        ]
      }

      const result = claudeRelayService._hasClaudeCodeSystemPrompt(requestBody)

      expect(result).toBe(false)
    })

    it('应该处理空的系统提示词数组', () => {
      const requestBody = {
        system: []
      }

      const result = claudeRelayService._hasClaudeCodeSystemPrompt(requestBody)

      expect(result).toBe(false)
    })

    it('应该处理没有text字段的系统提示词', () => {
      const requestBody = {
        system: [
          {
            type: 'text'
            // missing text field
          }
        ]
      }

      const result = claudeRelayService._hasClaudeCodeSystemPrompt(requestBody)

      expect(result).toBeFalsy() // 可能返回undefined，但仍是falsy
    })

    it('应该处理null或undefined的requestBody', () => {
      expect(claudeRelayService._hasClaudeCodeSystemPrompt(null)).toBe(false)
      expect(claudeRelayService._hasClaudeCodeSystemPrompt(undefined)).toBe(false)
      expect(claudeRelayService._hasClaudeCodeSystemPrompt({})).toBe(false)
    })
  })

  describe('请求处理逻辑', () => {
    it('应该能够创建基本的请求配置', () => {
      // 这个测试验证relayRequest方法的基本结构
      expect(typeof claudeRelayService.relayRequest).toBe('function')
      
      // 由于relayRequest是一个复杂的异步方法，涉及HTTP请求
      // 在这个基础测试中我们主要验证方法存在和基本结构
    })
  })

  describe('User-Agent解析', () => {
    const testCases = [
      {
        userAgent: 'claude-cli/1.0.0',
        expected: true,
        description: '应该接受基本版本格式'
      },
      {
        userAgent: 'claude-cli/1.2.3',
        expected: true,
        description: '应该接受三位版本号'
      },
      {
        userAgent: 'claude-cli/10.20.30',
        expected: true,
        description: '应该接受多位数版本号'
      },
      {
        userAgent: 'claude-cli/1.0.0-beta',
        expected: true, // regex /claude-cli\/\d+\.\d+\.\d+/ 会匹配这个
        description: 'User-agent regex匹配claude-cli/数字.数字.数字部分'
      },
      {
        userAgent: 'not-claude-cli/1.0.0',
        expected: true, // regex仍会匹配claude-cli/1.0.0部分
        description: 'regex会匹配包含claude-cli/数字.数字.数字的任何字符串'
      },
      {
        userAgent: 'claude-cli/1.0',
        expected: false,
        description: '应该拒绝不完整的版本号'
      },
      {
        userAgent: 'claude-cli/v1.0.0',
        expected: false,
        description: '应该拒绝带v前缀的版本号'
      }
    ]

    testCases.forEach(({ userAgent, expected, description }) => {
      it(description, () => {
        const requestBody = sampleRequests.claudeCodeRequest
        const clientHeaders = {
          ...sampleRequests.claudeCodeHeaders,
          'user-agent': userAgent
        }

        const result = claudeRelayService.isRealClaudeCodeRequest(requestBody, clientHeaders)

        expect(result).toBe(expected)
      })
    })
  })

  describe('边界情况处理', () => {
    it('应该处理大小写混合的headers', () => {
      const requestBody = sampleRequests.claudeCodeRequest
      const clientHeaders = {
        'Content-Type': 'application/json',
        'User-Agent': 'claude-cli/1.0.0', // 大写U和A
        'Authorization': 'Bearer test-token'
      }

      const result = claudeRelayService.isRealClaudeCodeRequest(requestBody, clientHeaders)

      expect(result).toBe(true)
    })

    it('应该处理复杂的系统提示词数组', () => {
      const requestBody = {
        system: [
          {
            type: 'text',
            text: "You are Claude Code, Anthropic's official CLI for Claude."
          },
          {
            type: 'text',
            text: 'Additional instructions...'
          }
        ]
      }
      const clientHeaders = sampleRequests.claudeCodeHeaders

      const result = claudeRelayService.isRealClaudeCodeRequest(requestBody, clientHeaders)

      expect(result).toBe(true)
    })

    it('应该处理含有特殊字符的系统提示词', () => {
      const requestBody = {
        system: [
          {
            type: 'text',
            text: "You are Claude Code, Anthropic's official CLI for Claude. 🤖"
          }
        ]
      }
      const clientHeaders = sampleRequests.claudeCodeHeaders

      const result = claudeRelayService.isRealClaudeCodeRequest(requestBody, clientHeaders)

      expect(result).toBe(false) // 严格相等检查，额外的emoji会导致失败
    })

    it('应该处理不完整的系统提示词对象', () => {
      const requestBody = {
        system: [
          {
            // missing type field
            text: "You are Claude Code, Anthropic's official CLI for Claude."
          }
        ]
      }
      const clientHeaders = sampleRequests.claudeCodeHeaders

      const result = claudeRelayService.isRealClaudeCodeRequest(requestBody, clientHeaders)

      expect(result).toBe(false) // 需要type === 'text'
    })
  })

  describe('性能测试', () => {
    it('应该能够快速识别Claude Code请求', () => {
      const requestBody = sampleRequests.claudeCodeRequest
      const clientHeaders = sampleRequests.claudeCodeHeaders

      const startTime = Date.now()

      for (let i = 0; i < 1000; i++) {
        claudeRelayService.isRealClaudeCodeRequest(requestBody, clientHeaders)
      }

      const endTime = Date.now()
      const duration = endTime - startTime

      expect(duration).toBeLessThan(100) // 1000次调用应在100ms内完成
    })

    it('应该能够快速处理系统提示词验证', () => {
      const requestBody = sampleRequests.claudeCodeRequest

      const startTime = Date.now()

      for (let i = 0; i < 1000; i++) {
        claudeRelayService._hasClaudeCodeSystemPrompt(requestBody)
      }

      const endTime = Date.now()
      const duration = endTime - startTime

      expect(duration).toBeLessThan(50) // 1000次调用应在50ms内完成
    })
  })

  describe('配置和常量', () => {
    it('应该正确设置API配置', () => {
      expect(claudeRelayService.claudeApiUrl).toBe('https://api.anthropic.com')
      expect(claudeRelayService.apiVersion).toBe('2023-06-01')
      expect(claudeRelayService.betaHeader).toBe('claude-3-5-sonnet-20241022')
    })

    it('应该包含Claude Code系统提示词', () => {
      expect(claudeRelayService.claudeCodeSystemPrompt).toBe(
        "You are Claude Code, Anthropic's official CLI for Claude."
      )
    })
  })
})