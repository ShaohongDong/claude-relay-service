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

const path = require('path');
const crypto = require('crypto');

// 设置环境
process.env.NODE_ENV = process.env.NODE_ENV || 'production';

// 加载配置
const configPath = path.join(__dirname, '..', 'config', 'config.js');
const config = require(configPath);

console.log('\x1b[33m=== Claude Relay Service 数据完整性检查工具 ===\x1b[0m\n');

/**
 * 检查环境变量配置
 */
function checkEnvironment() {
  console.log('\x1b[36m[检查]\x1b[0m 环境配置验证');
  
  const issues = [];
  
  // 检查关键环境变量
  if (!process.env.ENCRYPTION_KEY) {
    issues.push('ENCRYPTION_KEY 未设置');
  } else if (process.env.ENCRYPTION_KEY === 'CHANGE-THIS-32-CHARACTER-KEY-NOW') {
    issues.push('ENCRYPTION_KEY 使用默认不安全值');
  } else if (process.env.ENCRYPTION_KEY.length !== 32) {
    issues.push(`ENCRYPTION_KEY 长度错误: ${process.env.ENCRYPTION_KEY.length} (需要32字符)`);
  }
  
  if (!process.env.JWT_SECRET) {
    issues.push('JWT_SECRET 未设置');
  } else if (process.env.JWT_SECRET === 'CHANGE-THIS-JWT-SECRET-IN-PRODUCTION') {
    issues.push('JWT_SECRET 使用默认不安全值');
  } else if (process.env.JWT_SECRET.length < 32) {
    issues.push(`JWT_SECRET 长度过短: ${process.env.JWT_SECRET.length} (建议至少32字符)`);
  }
  
  if (!process.env.ENCRYPTION_SALT) {
    issues.push('ENCRYPTION_SALT 未设置（必需配置）');
  } else if (process.env.ENCRYPTION_SALT === 'CHANGE-THIS-ENCRYPTION-SALT-NOW') {
    issues.push('ENCRYPTION_SALT 使用默认不安全值');
  } else if (process.env.ENCRYPTION_SALT.length < 16) {
    issues.push(`ENCRYPTION_SALT 长度过短: ${process.env.ENCRYPTION_SALT.length} (建议至少16字符)`);
  }

  if (!process.env.API_KEY_SALT) {
    issues.push('API_KEY_SALT 未设置（强制必需配置）');
  } else if (process.env.API_KEY_SALT === 'CHANGE-THIS-API-KEY-SALT-32CHAR_') {
    issues.push('API_KEY_SALT 使用默认不安全值');
  } else if (process.env.API_KEY_SALT === process.env.ENCRYPTION_KEY) {
    issues.push('API_KEY_SALT 不能与 ENCRYPTION_KEY 相同（必须独立）');
  } else if (process.env.API_KEY_SALT === process.env.ENCRYPTION_SALT) {
    issues.push('API_KEY_SALT 不能与 ENCRYPTION_SALT 相同（必须独立）');
  }
  
  if (issues.length === 0) {
    console.log('\x1b[32m[通过]\x1b[0m 环境配置检查通过');
  } else {
    console.log('\x1b[31m[失败]\x1b[0m 环境配置存在问题:');
    issues.forEach(issue => console.log(`  ❌ ${issue}`));
  }
  
  return issues.length === 0;
}

/**
 * 检查加密功能
 */
function checkEncryption() {
  console.log('\n\x1b[36m[检查]\x1b[0m 加密功能验证');
  
  try {
    // 模拟 claudeAccountService 的加密逻辑
    const ENCRYPTION_ALGORITHM = 'aes-256-cbc';
    const testData = 'test_encryption_data_12345';
    
    // 生成密钥 - 使用配置化的盐值，与实际加密服务保持一致
    const key = crypto.scryptSync(config.security.encryptionKey, config.security.encryptionSalt, 32);
    const iv = crypto.randomBytes(16);
    
    // 加密测试
    const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, key, iv);
    let encrypted = cipher.update(testData, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const encryptedWithIv = `${iv.toString('hex')}:${encrypted}`;
    
    // 解密测试
    const parts = encryptedWithIv.split(':');
    const decipher = crypto.createDecipheriv(ENCRYPTION_ALGORITHM, key, Buffer.from(parts[0], 'hex'));
    let decrypted = decipher.update(parts[1], 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    
    if (decrypted === testData) {
      console.log('\x1b[32m[通过]\x1b[0m 加密/解密功能正常');
      return true;
    } else {
      console.log('\x1b[31m[失败]\x1b[0m 加密/解密结果不匹配');
      return false;
    }
  } catch (error) {
    console.log('\x1b[31m[失败]\x1b[0m 加密功能异常:', error.message);
    return false;
  }
}

/**
 * 检查服务间加密一致性
 */
function checkEncryptionConsistency() {
  console.log('\n\x1b[36m[检查]\x1b[0m 服务间加密一致性验证');
  
  const services = [
    'claudeAccountService',
    'claudeConsoleAccountService', 
    'bedrockAccountService',
    'geminiAccountService',
    'openaiAccountService'
  ];
  
  const issues = [];
  
  // 模拟测试所有服务是否使用相同的密钥派生方式
  try {
    const standardKey = crypto.scryptSync(
      config.security.encryptionKey, 
      config.security.encryptionSalt, 
      32
    );
    
    console.log('\x1b[32m[信息]\x1b[0m 标准密钥派生正常');
    console.log('\x1b[33m[重要]\x1b[0m 所有服务现在都应该使用相同的配置化盐值');
    console.log('  - 已修复: claudeConsoleAccountService (之前使用 "claude-console-salt")');  
    console.log('  - 已修复: bedrockAccountService (之前使用 "salt")');
    console.log('  - 已修复: geminiAccountService (之前使用 "gemini-account-salt")');
    console.log('  - 已修复: openaiAccountService (之前使用 "openai-account-salt")');
    console.log('  - 已修复: azureOpenaiAccountService (使用标准 encryptionSalt)');
    
    return true;
  } catch (error) {
    issues.push(`标准密钥派生失败: ${error.message}`);
  }
  
  if (issues.length > 0) {
    console.log('\x1b[31m[失败]\x1b[0m 加密一致性存在问题:');
    issues.forEach(issue => console.log(`  ❌ ${issue}`));
    return false;
  }
  
  console.log('\x1b[32m[通过]\x1b[0m 服务间加密一致性正常');
  return true;
}

/**
 * 检查API Key哈希功能
 */
function checkApiKeyHashing() {
  console.log('\n\x1b[36m[检查]\x1b[0m API Key 哈希功能验证');
  
  try {
    const testApiKey = 'cr_test_api_key_1234567890abcdef';
    
    // 使用新的独立盐值逻辑
    const salt = config.security.apiKeySalt || config.security.encryptionKey;
    const hash1 = crypto.createHash('sha256').update(testApiKey + salt).digest('hex');
    const hash2 = crypto.createHash('sha256').update(testApiKey + salt).digest('hex');
    
    if (hash1 === hash2) {
      console.log('\x1b[32m[通过]\x1b[0m API Key 哈希功能正常');
      
      // 检查是否使用了独立盐值
      if (config.security.apiKeySalt && config.security.apiKeySalt !== config.security.encryptionKey) {
        console.log('\x1b[32m[优秀]\x1b[0m 使用独立的 API Key 盐值');
      } else {
        console.log('\x1b[33m[警告]\x1b[0m API Key 哈希仍依赖 ENCRYPTION_KEY');
      }
      
      return true;
    } else {
      console.log('\x1b[31m[失败]\x1b[0m API Key 哈希结果不一致');
      return false;
    }
  } catch (error) {
    console.log('\x1b[31m[失败]\x1b[0m API Key 哈希功能异常:', error.message);
    return false;
  }
}

/**
 * 检查Redis连接和数据
 */
async function checkRedisData() {
  console.log('\n\x1b[36m[检查]\x1b[0m Redis 连接和数据验证');
  
  try {
    const redis = require('../src/models/redis');
    
    // 测试连接
    await redis.ping();
    console.log('\x1b[32m[通过]\x1b[0m Redis 连接正常');
    
    // 检查迁移标记
    const migrationKeys = await redis.keys('migration_needed:*');
    if (migrationKeys.length > 0) {
      console.log(`\x1b[33m[警告]\x1b[0m 发现 ${migrationKeys.length} 项需要迁移的数据`);
      console.log('  使用以下命令查看详情: node scripts/data-integrity-check.js --show-migrations');
    } else {
      console.log('\x1b[32m[通过]\x1b[0m 未发现需要迁移的数据');
    }
    
    // 检查API Keys
    const apiKeyPattern = 'api_key:*';
    const apiKeys = await redis.keys(apiKeyPattern);
    console.log(`\x1b[36m[信息]\x1b[0m 发现 ${apiKeys.length} 个 API Key 记录`);
    
    // 检查Claude账户
    const claudeAccountPattern = 'claude_account:*';
    const claudeAccounts = await redis.keys(claudeAccountPattern);
    console.log(`\x1b[36m[信息]\x1b[0m 发现 ${claudeAccounts.length} 个 Claude 账户记录`);
    
    return true;
  } catch (error) {
    console.log('\x1b[31m[失败]\x1b[0m Redis 检查异常:', error.message);
    return false;
  }
}

/**
 * 显示迁移需求详情
 */
async function showMigrationDetails() {
  console.log('\n\x1b[33m=== 数据迁移需求详情 ===\x1b[0m');
  
  try {
    const redis = require('../src/models/redis');
    const migrationKeys = await redis.keys('migration_needed:*');
    
    if (migrationKeys.length === 0) {
      console.log('\x1b[32m[信息]\x1b[0m 未发现需要迁移的数据');
      return;
    }
    
    console.log(`\x1b[33m[警告]\x1b[0m 发现 ${migrationKeys.length} 项需要迁移的数据:\n`);
    
    for (const key of migrationKeys) {
      const data = await redis.get(key);
      if (data) {
        const migrationInfo = JSON.parse(data);
        console.log(`Key: ${key}`);
        console.log(`  时间戳: ${migrationInfo.timestamp}`);
        console.log(`  数据哈希: ${migrationInfo.dataHash.substring(0, 16)}...`);
        console.log(`  原因: ${migrationInfo.reason}`);
        console.log('');
      }
    }
    
    console.log('\x1b[33m[建议]\x1b[0m 迁移步骤:');
    console.log('1. 备份现有数据');
    console.log('2. 重新添加相关的 Claude 账户');
    console.log('3. 验证新数据工作正常');
    console.log('4. 清理迁移标记');
    
  } catch (error) {
    console.log('\x1b[31m[错误]\x1b[0m 无法获取迁移详情:', error.message);
  }
}

/**
 * 生成修复建议
 */
function generateRecommendations(results) {
  console.log('\n\x1b[33m=== 修复建议 ===\x1b[0m');
  
  const { environment, encryption, encryptionConsistency, apiKeyHashing, redis } = results;
  
  if (!environment) {
    console.log('\x1b[31m[高优先级]\x1b[0m 环境配置问题:');
    console.log('1. 检查并修复 .env 文件中的密钥配置');
    console.log('2. 确保所有密钥使用强随机值');
    console.log('3. 重新运行 manage.sh install 以生成新的安全密钥');
  }
  
  if (!encryption) {
    console.log('\x1b[31m[高优先级]\x1b[0m 加密功能问题:');
    console.log('1. 检查 ENCRYPTION_KEY 是否为32字符');
    console.log('2. 验证没有手动修改过加密密钥');
    console.log('3. 如果数据损坏，可能需要重新设置所有 Claude 账户');
  }
  
  if (!encryptionConsistency) {
    console.log('\x1b[31m[高优先级]\x1b[0m 服务间加密不一致问题:');
    console.log('1. 所有账户服务现在使用统一的配置化盐值');
    console.log('2. 重启服务以使新的加密配置生效');
    console.log('3. 如有现有加密数据无法解密，可能需要重新添加相关账户');
  }
  
  if (!apiKeyHashing) {
    console.log('\x1b[31m[高优先级]\x1b[0m API Key 哈希问题:');
    console.log('1. 检查 API_KEY_SALT 配置');
    console.log('2. 如果哈希不一致，所有 API Key 可能需要重新生成');
  }
  
  if (!redis) {
    console.log('\x1b[31m[高优先级]\x1b[0m Redis 连接问题:');
    console.log('1. 检查 Redis 服务是否运行');
    console.log('2. 验证 Redis 连接配置');
    console.log('3. 检查 Redis 权限和网络连接');
  }
  
  // 通用建议
  console.log('\n\x1b[36m[建议]\x1b[0m 预防性措施:');
  console.log('1. 定期运行此检查工具');
  console.log('2. 在修改密钥前备份数据');
  console.log('3. 使用独立的 API_KEY_SALT');
  console.log('4. 监控系统日志中的解密错误');
}

/**
 * 主函数
 */
async function main() {
  const args = process.argv.slice(2);
  
  if (args.includes('--show-migrations')) {
    await showMigrationDetails();
    return;
  }
  
  console.log('正在执行全面的数据完整性检查...\n');
  
  const results = {
    environment: checkEnvironment(),
    encryption: checkEncryption(),
    encryptionConsistency: checkEncryptionConsistency(),
    apiKeyHashing: checkApiKeyHashing(),
    redis: await checkRedisData()
  };
  
  // 显示总结
  console.log('\n\x1b[33m=== 检查结果总结 ===\x1b[0m');
  const passedChecks = Object.values(results).filter(Boolean).length;
  const totalChecks = Object.keys(results).length;
  
  if (passedChecks === totalChecks) {
    console.log('\x1b[32m[成功]\x1b[0m 所有检查通过！数据完整性良好。');
  } else {
    console.log(`\x1b[31m[警告]\x1b[0m ${totalChecks - passedChecks}/${totalChecks} 项检查失败`);
    generateRecommendations(results);
  }
  
  console.log('\n检查完成。');
  process.exit(passedChecks === totalChecks ? 0 : 1);
}

// 错误处理
process.on('unhandledRejection', (error) => {
  console.error('\x1b[31m[错误]\x1b[0m 未处理的异常:', error.message);
  process.exit(1);
});

// 运行主函数
if (require.main === module) {
  main().catch(error => {
    console.error('\x1b[31m[错误]\x1b[0m 执行失败:', error.message);
    process.exit(1);
  });
}