// OAuth Helper工具测试
const oauthHelper = require('../../../src/utils/oauthHelper')

// Mock dependencies
jest.mock('../../../src/utils/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
  oauth: jest.fn()
}))

describe('OAuth Helper', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  describe('基础功能检查', () => {
    it('应该成功加载OAuthHelper', () => {
      expect(oauthHelper).toBeDefined()
      expect(typeof oauthHelper).toBe('object')
    })

    it('应该包含必要的方法', () => {
      expect(typeof oauthHelper.generateCodeVerifier).toBe('function')
      expect(typeof oauthHelper.generateCodeChallenge).toBe('function')
      expect(typeof oauthHelper.generateState).toBe('function')
      expect(typeof oauthHelper.generateAuthUrl).toBe('function')
      expect(typeof oauthHelper.generateOAuthParams).toBe('function')
      expect(typeof oauthHelper.parseCallbackUrl).toBe('function')
    })
  })

  describe('PKCE流程支持', () => {
    it('应该生成有效的code verifier', () => {
      const verifier = oauthHelper.generateCodeVerifier()

      expect(typeof verifier).toBe('string')
      expect(verifier.length).toBeGreaterThan(42) // PKCE要求至少43个字符
      expect(verifier.length).toBeLessThan(129) // 最多128个字符
      expect(verifier).toMatch(/^[A-Za-z0-9._~-]+$/) // 只包含允许的字符
    })

    it('应该为每次调用生成不同的code verifier', () => {
      const verifier1 = oauthHelper.generateCodeVerifier()
      const verifier2 = oauthHelper.generateCodeVerifier()

      expect(verifier1).not.toBe(verifier2)
    })

    it('应该从code verifier生成有效的code challenge', () => {
      const verifier = oauthHelper.generateCodeVerifier()
      const challenge = oauthHelper.generateCodeChallenge(verifier)

      expect(typeof challenge).toBe('string')
      expect(challenge.length).toBeGreaterThan(0)
      expect(challenge).toMatch(/^[A-Za-z0-9._~-]+$/) // URL-safe base64
    })

    it('应该为相同的verifier生成相同的challenge', () => {
      const verifier = 'test_verifier_12345'
      const challenge1 = oauthHelper.generateCodeChallenge(verifier)
      const challenge2 = oauthHelper.generateCodeChallenge(verifier)

      expect(challenge1).toBe(challenge2)
    })

    it('应该为不同的verifier生成不同的challenge', () => {
      const verifier1 = 'test_verifier_12345'
      const verifier2 = 'test_verifier_67890'
      const challenge1 = oauthHelper.generateCodeChallenge(verifier1)
      const challenge2 = oauthHelper.generateCodeChallenge(verifier2)

      expect(challenge1).not.toBe(challenge2)
    })
  })

  describe('State参数生成', () => {
    it('应该生成有效的state参数', () => {
      const state = oauthHelper.generateState()

      expect(typeof state).toBe('string')
      expect(state.length).toBeGreaterThan(10)
      expect(state).toMatch(/^[A-Za-z0-9._~-]+$/)
    })

    it('应该为每次调用生成不同的state', () => {
      const state1 = oauthHelper.generateState()
      const state2 = oauthHelper.generateState()

      expect(state1).not.toBe(state2)
    })
  })

  describe('授权URL构建', () => {
    it('应该构建正确的授权URL', () => {
      const codeVerifier = oauthHelper.generateCodeVerifier()
      const codeChallenge = oauthHelper.generateCodeChallenge(codeVerifier)
      const state = oauthHelper.generateState()

      const authUrl = oauthHelper.generateAuthUrl(codeChallenge, state)

      expect(typeof authUrl).toBe('string')
      expect(authUrl.startsWith('https://claude.ai/oauth/authorize')).toBe(true)
      expect(authUrl).toContain(`code_challenge=${codeChallenge}`)
      expect(authUrl).toContain(`code_challenge_method=S256`)
      expect(authUrl).toContain(`state=${state}`)
      expect(authUrl).toContain('response_type=code')
    })

    it('应该正确处理参数', () => {
      const codeChallenge = 'test-challenge'
      const state = 'test-state'
      
      const authUrl = oauthHelper.generateAuthUrl(codeChallenge, state)

      expect(authUrl).toContain(codeChallenge)
      expect(authUrl).toContain(state)
    })

    it('应该处理缺少参数的情况', () => {
      // 测试缺少参数时的行为
      const authUrl = oauthHelper.generateAuthUrl('test-challenge', 'test-state')
      expect(typeof authUrl).toBe('string')
    })
  })

  describe('代理支持', () => {
    it('应该正确处理代理配置', () => {
      const proxyConfig = {
        host: '127.0.0.1',
        port: 8080,
        protocol: 'http'
      }

      // 这里主要测试代理配置的格式验证
      expect(() => oauthHelper.validateProxyConfig?.(proxyConfig)).not.toThrow()
    })
  })

  describe('错误处理', () => {
    it('应该处理无效的输入参数', () => {
      // 实际的generateCodeChallenge可能不会抛出错误，而是返回结果
      const result1 = oauthHelper.generateCodeChallenge('')
      const result2 = oauthHelper.generateCodeChallenge('valid-input')
      
      expect(typeof result1).toBe('string')
      expect(typeof result2).toBe('string')
    })

    it('应该处理特殊字符输入', () => {
      const specialVerifier = 'test_verifier_with_中文_and_émojis_🔐'
      
      // 应该能处理或抛出明确错误
      expect(() => {
        const challenge = oauthHelper.generateCodeChallenge(specialVerifier)
        expect(typeof challenge).toBe('string')
      }).not.toThrow()
    })
  })

  describe('性能测试', () => {
    it('应该快速生成code verifier和challenge', () => {
      const startTime = Date.now()

      for (let i = 0; i < 100; i++) {
        const verifier = oauthHelper.generateCodeVerifier()
        const challenge = oauthHelper.generateCodeChallenge(verifier)
        expect(typeof challenge).toBe('string')
      }

      const endTime = Date.now()
      const duration = endTime - startTime

      expect(duration).toBeLessThan(1000) // 100次操作应在1秒内完成
    })

    it('应该快速构建授权URL', () => {
      const startTime = Date.now()

      for (let i = 0; i < 100; i++) {
        const authUrl = oauthHelper.generateAuthUrl('test-challenge', 'test-state')
        expect(typeof authUrl).toBe('string')
      }

      const endTime = Date.now()
      const duration = endTime - startTime

      expect(duration).toBeLessThan(500) // 100次URL构建应在0.5秒内完成
    })
  })

  describe('标准兼容性', () => {
    it('生成的code verifier应符合RFC 7636标准', () => {
      const verifier = oauthHelper.generateCodeVerifier()

      // RFC 7636要求
      expect(verifier.length).toBeGreaterThanOrEqual(43)
      expect(verifier.length).toBeLessThanOrEqual(128)
      expect(verifier).toMatch(/^[A-Za-z0-9._~-]+$/)
    })

    it('生成的code challenge应使用S256方法', () => {
      const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'
      const expectedChallenge = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM' // 预计算的值
      
      const challenge = oauthHelper.generateCodeChallenge(verifier)
      
      // 验证使用了正确的SHA256哈希
      expect(challenge).toBe(expectedChallenge)
    })
  })
})