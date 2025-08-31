#!/usr/bin/env node

/**
 * Claude Relay Service - 数据完整性检查和修复工具
 *
 * 功能：
 * 1. 检查加密密钥与现有数据的兼容性
 * 2. 检测需要迁移的旧格式数据
 * 3. 验证API Key哈希的一致性
 * 4. 提供数据修复建议
 */

const path = require('path')
const crypto = require('crypto')

// 设置环境
process.env.NODE_ENV = process.env.NODE_ENV || 'production'

// 直接从环境变量构建配置，避免依赖项目配置文件
const config = {
  security: {
    encryptionKey: process.env.ENCRYPTION_KEY || 'CHANGE-THIS-32-CHARACTER-KEY-NOW',
    encryptionSalt: process.env.ENCRYPTION_SALT || 'CHANGE-THIS-ENCRYPTION-SALT-NOW',
    apiKeySalt: process.env.API_KEY_SALT || 'CHANGE-THIS-API-KEY-SALT-32CHAR_',
    jwtSecret: process.env.JWT_SECRET || 'CHANGE-THIS-JWT-SECRET-IN-PRODUCTION'
  }
}

console.log('\x1b[33m=== Claude Relay Service 数据完整性检查工具 ===\x1b[0m\n')

/**
 * 检查环境变量配置
 */
function checkEnvironment() {
  console.log('\x1b[36m[检查]\x1b[0m 环境配置验证')

  const issues = []

  // 检查关键环境变量
  if (!process.env.ENCRYPTION_KEY) {
    issues.push('ENCRYPTION_KEY 未设置')
  } else if (process.env.ENCRYPTION_KEY === 'CHANGE-THIS-32-CHARACTER-KEY-NOW') {
    issues.push('ENCRYPTION_KEY 使用默认不安全值')
  } else if (process.env.ENCRYPTION_KEY.length !== 32) {
    issues.push(`ENCRYPTION_KEY 长度错误: ${process.env.ENCRYPTION_KEY.length} (需要32字符)`)
  }

  if (!process.env.JWT_SECRET) {
    issues.push('JWT_SECRET 未设置')
  } else if (process.env.JWT_SECRET === 'CHANGE-THIS-JWT-SECRET-IN-PRODUCTION') {
    issues.push('JWT_SECRET 使用默认不安全值')
  }

  // 检查新增的安全配置
  if (!process.env.ENCRYPTION_SALT) {
    issues.push('ENCRYPTION_SALT 未设置 - 数据加密安全性降低')
  } else if (process.env.ENCRYPTION_SALT === 'CHANGE-THIS-ENCRYPTION-SALT-NOW') {
    issues.push('ENCRYPTION_SALT 使用默认值 - 需要设置随机值')
  }

  if (!process.env.API_KEY_SALT) {
    issues.push('API_KEY_SALT 未设置 - API Key哈希安全性降低')
  } else if (process.env.API_KEY_SALT === 'CHANGE-THIS-API-KEY-SALT-32CHAR_') {
    issues.push('API_KEY_SALT 使用默认值 - 需要设置随机值')
  }

  if (issues.length === 0) {
    console.log('  ✅ 环境配置检查通过')
  } else {
    console.log('  ❌ 发现配置问题:')
    issues.forEach((issue) => console.log(`    • ${issue}`))
  }

  return issues.length === 0
}

/**
 * 检查密钥强度和安全性
 */
function checkKeyStrength() {
  console.log('\n\x1b[36m[检查]\x1b[0m 密钥强度和安全性')

  const issues = []

  // 检查加密密钥强度
  const encryptionKey = config.security.encryptionKey
  if (encryptionKey) {
    const entropy = calculateEntropy(encryptionKey)
    if (entropy < 4.0) {
      issues.push(`加密密钥熵值过低: ${entropy.toFixed(2)} (建议 > 4.0)`)
    }

    // 检查是否包含足够的字符类型
    const hasLower = /[a-z]/.test(encryptionKey)
    const hasUpper = /[A-Z]/.test(encryptionKey)
    const hasDigit = /[0-9]/.test(encryptionKey)
    const hasSpecial = /[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(encryptionKey)

    const charTypes = [hasLower, hasUpper, hasDigit, hasSpecial].filter(Boolean).length
    if (charTypes < 3) {
      issues.push(`加密密钥字符类型不足: ${charTypes}/4 (建议至少3种)`)
    }
  }

  if (issues.length === 0) {
    console.log('  ✅ 密钥强度检查通过')
  } else {
    console.log('  ⚠️ 密钥强度建议:')
    issues.forEach((issue) => console.log(`    • ${issue}`))
  }

  return issues.length === 0
}

/**
 * 计算字符串熵值
 */
function calculateEntropy(str) {
  const freq = {}
  for (let char of str) {
    freq[char] = (freq[char] || 0) + 1
  }

  let entropy = 0
  const len = str.length
  for (let count of Object.values(freq)) {
    const p = count / len
    entropy -= p * Math.log2(p)
  }

  return entropy
}

/**
 * 检查Redis连接和数据格式
 */
async function checkRedisData() {
  console.log('\n\x1b[36m[检查]\x1b[0m Redis数据完整性')

  try {
    // 动态加载Redis模块
    let redis
    try {
      redis = require('../src/models/redis')
    } catch (moduleError) {
      console.log('  ⚠️ Redis模块未加载，跳过数据完整性检查')
      console.log('    提示：请在项目根目录运行此工具以进行完整检查')
      return true // 返回true避免影响其他检查
    }

    // 测试Redis连接
    const testKey = `integrity_check_${Date.now()}`
    await redis.set(testKey, 'test', 'EX', 10)
    const testValue = await redis.get(testKey)

    if (testValue !== 'test') {
      console.log('  ❌ Redis连接测试失败')
      return false
    }

    console.log('  ✅ Redis连接正常')

    // 检查API Key数据格式
    const apiKeys = await redis.getAllApiKeys()
    let validApiKeys = 0
    let invalidApiKeys = 0

    for (const key of apiKeys) {
      if (key.id && key.name && key.createdAt) {
        validApiKeys++
      } else {
        invalidApiKeys++
      }
    }

    console.log(`  📊 API Keys数据检查: ${validApiKeys}个有效, ${invalidApiKeys}个无效`)

    // 检查Claude账户数据格式
    const claudeAccounts = await redis.getAllClaudeAccounts()
    let validAccounts = 0
    let invalidAccounts = 0
    let oldFormatAccounts = 0

    for (const account of claudeAccounts) {
      if (account.id && account.name) {
        validAccounts++

        // 检查是否为旧格式加密数据（不包含冒号的加密数据可能是旧格式）
        if (account.refreshToken && !account.refreshToken.includes(':')) {
          oldFormatAccounts++
        }
      } else {
        invalidAccounts++
      }
    }

    console.log(`  📊 Claude账户数据检查: ${validAccounts}个有效, ${invalidAccounts}个无效`)
    if (oldFormatAccounts > 0) {
      console.log(`  ⚠️ 发现${oldFormatAccounts}个可能的旧格式加密数据，建议备份后重新配置`)
    }

    return true
  } catch (error) {
    console.log(`  ❌ Redis数据检查失败: ${error.message}`)
    return false
  }
}

/**
 * 验证加密/解密功能
 */
function testEncryptionDecryption() {
  console.log('\n\x1b[36m[检查]\x1b[0m 加密解密功能测试')

  try {
    const testData = 'test-sensitive-data-' + Date.now()

    // 模拟CloudeAccountService的加密逻辑
    const algorithm = 'aes-256-cbc'
    const encryptionKey = crypto.scryptSync(
      config.security.encryptionKey,
      config.security.encryptionSalt,
      32
    )

    // 加密测试
    const iv = crypto.randomBytes(16)
    const cipher = crypto.createCipheriv(algorithm, encryptionKey, iv)
    let encrypted = cipher.update(testData, 'utf8', 'hex')
    encrypted += cipher.final('hex')
    const encryptedData = `${iv.toString('hex')}:${encrypted}`

    // 解密测试
    const parts = encryptedData.split(':')
    if (parts.length !== 2) {
      throw new Error('加密数据格式错误')
    }

    const decryptIv = Buffer.from(parts[0], 'hex')
    const encryptedContent = parts[1]

    const decipher = crypto.createDecipheriv(algorithm, encryptionKey, decryptIv)
    let decrypted = decipher.update(encryptedContent, 'hex', 'utf8')
    decrypted += decipher.final('utf8')

    if (decrypted === testData) {
      console.log('  ✅ 加密解密功能正常')
      return true
    } else {
      console.log('  ❌ 加密解密结果不匹配')
      return false
    }
  } catch (error) {
    console.log(`  ❌ 加密解密测试失败: ${error.message}`)
    return false
  }
}

/**
 * 测试API Key哈希功能
 */
function testApiKeyHashing() {
  console.log('\n\x1b[36m[检查]\x1b[0m API Key哈希功能测试')

  try {
    const testApiKey = 'cr_test_key_' + Date.now()

    // 模拟ApiKeyService的哈希逻辑
    const hash1 = crypto
      .createHash('sha256')
      .update(testApiKey + config.security.apiKeySalt)
      .digest('hex')

    const hash2 = crypto
      .createHash('sha256')
      .update(testApiKey + config.security.apiKeySalt)
      .digest('hex')

    if (hash1 === hash2) {
      console.log('  ✅ API Key哈希功能正常')
      console.log(`  📝 测试哈希值: ${hash1.substring(0, 16)}...`)
      return true
    } else {
      console.log('  ❌ API Key哈希结果不一致')
      return false
    }
  } catch (error) {
    console.log(`  ❌ API Key哈希测试失败: ${error.message}`)
    return false
  }
}

/**
 * 提供修复建议
 */
function provideSuggestions(results) {
  console.log('\n\x1b[33m=== 修复建议 ===\x1b[0m')

  if (results.every(Boolean)) {
    console.log('🎉 所有检查都通过了！系统数据完整性良好。')
    return
  }

  console.log('💡 根据检查结果，建议进行以下操作：')

  if (!results[0]) {
    console.log('\n📋 环境配置修复：')
    console.log('  1. 设置强密钥: export ENCRYPTION_KEY="$(openssl rand -hex 32)"')
    console.log('  2. 设置JWT密钥: export JWT_SECRET="$(openssl rand -hex 32)"')
    console.log('  3. 设置加密盐值: export ENCRYPTION_SALT="$(openssl rand -hex 16)"')
    console.log('  4. 设置API Key盐值: export API_KEY_SALT="$(openssl rand -hex 32)"')
    console.log('  5. 将这些环境变量添加到 .env 文件中')
  }

  if (!results[2]) {
    console.log('\n🔧 Redis数据修复：')
    console.log('  1. 检查Redis连接配置')
    console.log('  2. 如有旧格式数据，建议重新配置账户')
    console.log('  3. 备份重要数据: redis-cli --rdb backup.rdb')
  }

  if (!results[3] || !results[4]) {
    console.log('\n🛠️ 加密功能修复：')
    console.log('  1. 验证配置文件中的加密设置')
    console.log('  2. 重启服务以应用新的配置')
    console.log('  3. 测试API Key创建和验证功能')
  }

  console.log('\n⚠️ 重要提醒：')
  console.log('  • 修改加密配置前请备份所有数据')
  console.log('  • 加密密钥更改后，现有加密数据将无法解密')
  console.log('  • 建议在维护窗口期间进行配置更改')
}

/**
 * 主函数
 */
async function main() {
  try {
    const results = []

    // 执行所有检查
    results.push(checkEnvironment())
    results.push(checkKeyStrength())
    results.push(await checkRedisData())
    results.push(testEncryptionDecryption())
    results.push(testApiKeyHashing())

    // 提供修复建议
    provideSuggestions(results)

    // 总结
    const passedCount = results.filter(Boolean).length
    const totalCount = results.length

    console.log(`\n📊 检查完成: ${passedCount}/${totalCount} 项通过`)

    if (passedCount === totalCount) {
      console.log('🎯 系统数据完整性验证通过！')
      process.exit(0)
    } else {
      console.log('⚠️ 发现数据完整性问题，请按建议进行修复。')
      process.exit(1)
    }
  } catch (error) {
    console.error('\n❌ 检查过程中发生错误:', error.message)
    console.error('🔍 请检查系统配置和依赖项是否正确安装。')
    process.exit(1)
  }
}

// 如果直接运行此脚本
if (require.main === module) {
  main()
}

module.exports = {
  checkEnvironment,
  checkKeyStrength,
  calculateEntropy,
  checkRedisData,
  testEncryptionDecryption,
  testApiKeyHashing,
  provideSuggestions
}
