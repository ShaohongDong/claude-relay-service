// 测试用的请求样本数据

module.exports = {
  // 有效的Claude消息请求
  validClaudeRequest: {
    model: 'claude-3-5-sonnet-20241022',
    max_tokens: 1024,
    messages: [
      {
        role: 'user',
        content: 'Hello, how are you?'
      }
    ],
    stream: false
  },

  // 流式请求
  streamingRequest: {
    model: 'claude-3-5-sonnet-20241022',
    max_tokens: 1024,
    messages: [
      {
        role: 'user',
        content: 'Tell me a short story'
      }
    ],
    stream: true
  },

  // Claude Code格式的请求
  claudeCodeRequest: {
    model: 'claude-3-5-sonnet-20241022',
    max_tokens: 4096,
    system: [
      {
        type: 'text',
        text: "You are Claude Code, Anthropic's official CLI for Claude."
      }
    ],
    messages: [
      {
        role: 'user',
        content: 'Help me write a Python function'
      }
    ],
    stream: false
  },

  // 无效请求样本
  invalidRequests: {
    // 缺少messages字段
    missingMessages: {
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 1024
    },

    // 空的messages数组
    emptyMessages: {
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 1024,
      messages: []
    },

    // 无效的messages格式
    invalidMessages: {
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 1024,
      messages: 'not an array'
    },

    // 缺少必需的role字段
    invalidMessageStructure: {
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 1024,
      messages: [
        {
          content: 'Hello'
          // missing role field
        }
      ]
    }
  },

  // 测试用的请求头
  validHeaders: {
    'content-type': 'application/json',
    'user-agent': 'claude-cli/1.0.0',
    'x-api-key': 'cr_test_key_12345'
  },

  claudeCodeHeaders: {
    'content-type': 'application/json',
    'user-agent': 'claude-cli/1.2.3',
    'authorization': 'Bearer cr_test_claude_code_key',
    'anthropic-version': '2023-06-01'
  },

  geminiHeaders: {
    'content-type': 'application/json',
    'x-goog-api-key': 'cr_test_gemini_key_67890',
    'user-agent': 'GeminiCLI/1.0.0'
  },

  // API Key测试样本
  apiKeys: {
    valid: 'cr_1234567890abcdef',
    invalid: 'sk_invalid_key',
    malformed: '123',
    tooLong: 'cr_' + 'x'.repeat(600)
  },

  // OAuth token样本
  tokens: {
    validOAuth: {
      access_token: 'test_access_token_12345',
      refresh_token: 'test_refresh_token_67890',
      expires_in: 3600,
      token_type: 'Bearer',
      scope: 'openid profile email'
    },

    expiredOAuth: {
      access_token: 'expired_access_token',
      refresh_token: 'test_refresh_token_expired',
      expires_in: -1,
      token_type: 'Bearer',
      scope: 'openid profile email'
    }
  },

  // 账户信息样本
  accounts: {
    claude: {
      id: 'test-claude-account-1',
      name: 'Test Claude Account',
      email: 'test@example.com',
      proxy: null,
      isActive: true,
      refreshToken: 'encrypted_refresh_token',
      accessToken: 'encrypted_access_token',
      tokenExpiresAt: new Date(Date.now() + 3600000).toISOString()
    },

    gemini: {
      id: 'test-gemini-account-1',
      name: 'Test Gemini Account',
      email: 'gemini@example.com',
      proxy: null,
      isActive: true,
      refreshToken: 'encrypted_gemini_refresh_token',
      accessToken: 'encrypted_gemini_access_token',
      tokenExpiresAt: new Date(Date.now() + 3600000).toISOString()
    }
  },

  // 代理配置样本
  proxyConfigs: {
    http: {
      host: '127.0.0.1',
      port: 8080,
      protocol: 'http'
    },

    https: {
      host: '127.0.0.1',
      port: 8080,
      protocol: 'https'
    },

    socks5: {
      host: '127.0.0.1',
      port: 1080,
      protocol: 'socks5',
      username: 'testuser',
      password: 'testpass'
    }
  },

  // 响应样本
  responses: {
    claude: {
      id: 'msg_test123',
      type: 'message',
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: 'Hello! How can I help you today?'
        }
      ],
      model: 'claude-3-5-sonnet-20241022',
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: {
        input_tokens: 10,
        output_tokens: 20
      }
    },

    streamChunk: {
      type: 'content_block_delta',
      index: 0,
      delta: {
        type: 'text_delta',
        text: 'Hello'
      }
    }
  },

  // 错误响应样本
  errors: {
    unauthorized: {
      type: 'error',
      error: {
        type: 'authentication_error',
        message: 'Invalid API key'
      }
    },

    rateLimited: {
      type: 'error',
      error: {
        type: 'rate_limit_error',
        message: 'Rate limit exceeded'
      }
    },

    invalidRequest: {
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message: 'Invalid request format'
      }
    }
  }
}