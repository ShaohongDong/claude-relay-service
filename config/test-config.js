// 测试环境配置文件
module.exports = {
  // 服务器配置
  server: {
    port: process.env.PORT || 3001, // 使用不同端口避免冲突
    host: process.env.HOST || '127.0.0.1'
  },

  // Redis配置
  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT) || 6379,
    password: process.env.REDIS_PASSWORD || '',
    db: 15, // 使用测试专用数据库
    keyPrefix: 'test:claude-relay:',
    retryDelayOnFailover: 100,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1
  },

  // JWT配置
  jwt: {
    secret: process.env.JWT_SECRET || 'test-jwt-secret-key-for-testing-only',
    expiresIn: '24h'
  },

  // 加密配置
  security: {
    encryptionKey: process.env.ENCRYPTION_KEY || '12345678901234567890123456789012',
    apiKeyPrefix: 'cr_',
    apiKeySalt: process.env.API_KEY_SALT || 'test-api-key-salt-for-testing-only'
  },

  // Claude API配置
  claude: {
    apiUrl: 'https://api.anthropic.com',
    apiVersion: '2023-06-01',
    betaHeader: 'claude-3-5-sonnet-20241022',
    systemPrompt: 'You are Claude, an AI assistant created by Anthropic.',
    timeout: 5000 // 较短的超时时间用于测试
  },

  // Gemini API配置
  gemini: {
    apiUrl: 'https://generativelanguage.googleapis.com',
    timeout: 5000
  },

  // 限制配置
  limits: {
    defaultTokenLimit: 1000,
    maxConcurrency: 5,
    rateLimit: {
      windowMs: 15 * 60 * 1000, // 15分钟
      max: 100 // 限制每个窗口期内的请求数
    }
  },

  // 日志配置
  logging: {
    level: 'error', // 测试时只输出错误日志
    file: false, // 不写入文件
    console: false, // 不输出到控制台
    maxSize: '1m',
    maxFiles: 1
  },

  // 代理配置
  proxy: {
    enabled: false, // 测试环境默认不使用代理
    timeout: 3000
  },

  // OAuth配置
  oauth: {
    claude: {
      tokenRefreshUrl: 'https://claude.ai/api/oauth/token',
      clientId: 'test-client-id'
    },
    gemini: {
      tokenRefreshUrl: 'https://oauth2.googleapis.com/token'
    }
  },

  // 测试专用配置
  test: {
    // 是否启用真实的外部API调用（默认使用mock）
    enableRealApiCalls: process.env.TEST_REAL_API === 'true',
    
    // 测试用的默认延迟
    defaultDelay: 10,
    
    // 是否启用详细的测试日志
    verboseLogging: process.env.TEST_VERBOSE === 'true',
    
    // 测试超时时间
    timeout: 5000,
    
    // 清理测试数据
    cleanupAfterTests: true
  }
}