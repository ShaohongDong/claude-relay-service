module.exports = {
  // 测试环境
  testEnvironment: 'node',

  // 测试文件匹配模式
  testMatch: ['**/__tests__/**/*.test.js', '**/*.test.js'],

  // 忽略的目录
  testPathIgnorePatterns: ['/node_modules/', '/web/', '/temp/'],

  // 覆盖率配置
  collectCoverage: true,
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'html', 'json-summary'],
  collectCoverageFrom: [
    'src/**/*.js',
    'cli/**/*.js',
    '!src/app.js', // 排除应用启动文件
    '!**/node_modules/**',
    '!**/__tests__/**',
    '!**/coverage/**'
  ],

  // 设置文件
  setupFilesAfterEnv: ['<rootDir>/__tests__/setup/test-setup.js'],

  // 模块映射
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
    '^@config/(.*)$': '<rootDir>/config/$1',
    '^@utils/(.*)$': '<rootDir>/src/utils/$1',
    '^@services/(.*)$': '<rootDir>/src/services/$1'
  },

  // 超时配置
  testTimeout: 10000,

  // 详细输出
  verbose: true,

  // 错误时停止
  bail: false,

  // 并行测试
  maxWorkers: '50%',

  // 清理模拟
  clearMocks: true,
  restoreMocks: true
}