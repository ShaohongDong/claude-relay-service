const connectionPoolManager = require('./connectionPoolManager')
const logger = require('./logger')
const config = require('../../config/config')
const { SocksProxyAgent } = require('socks-proxy-agent')
const { HttpsProxyAgent } = require('https-proxy-agent')

/**
 * 统一的代理创建工具
 * 支持 SOCKS5 和 HTTP/HTTPS 代理，可配置 IPv4/IPv6
 * 集成专用连接池管理器以实现连接复用和故障转移
 */
class ProxyHelper {
  /**
   * 创建代理 Agent（使用连接池管理器）
   * @param {object|string|null} proxyConfig - 代理配置对象或 JSON 字符串
   * @param {object} options - 额外选项
   * @param {boolean|number} options.useIPv4 - 是否使用 IPv4 (true=IPv4, false=IPv6, undefined=auto)
   * @param {string} options.accountId - 账户ID（用于连接池分离）
   * @returns {Agent|null} 代理 Agent 实例或 null
   */
  static createProxyAgent(proxyConfig, options = {}) {
    if (!proxyConfig) {
      return null
    }

    try {
      // 解析代理配置
      const proxy = typeof proxyConfig === 'string' ? JSON.parse(proxyConfig) : proxyConfig

      // 验证必要字段
      if (!proxy.type || !proxy.host || !proxy.port) {
        logger.warn('⚠️ Invalid proxy configuration: missing required fields (type, host, port)')
        return null
      }

      // 获取账户ID，如果没有提供则使用默认值
      const accountId = options.accountId || 'default'

      // 从连接池管理器获取Agent
      const agent = connectionPoolManager.getAgent(accountId, proxyConfig, {
        useIPv4: ProxyHelper._getIPFamilyPreference(options.useIPv4)
      })

      if (agent) {
        logger.debug(`🏊 Retrieved connection pool agent for account ${accountId}: ${ProxyHelper.getProxyDescription(proxyConfig)}`)
      }

      return agent
    } catch (error) {
      logger.warn('⚠️ Failed to get proxy agent from connection pool:', error.message)
      // 降级到直接创建Agent（兼容性保证）
      return ProxyHelper._createDirectAgent(proxyConfig, options)
    }
  }

  /**
   * 直接创建Agent（降级方案）
   * @private
   */
  static _createDirectAgent(proxyConfig, options = {}) {
    logger.warn('⚠️ Using direct agent creation as fallback')
    
    try {
      const proxy = typeof proxyConfig === 'string' ? JSON.parse(proxyConfig) : proxyConfig
      const useIPv4 = ProxyHelper._getIPFamilyPreference(options.useIPv4)
      const auth = proxy.username && proxy.password ? `${proxy.username}:${proxy.password}@` : ''

      const agentOptions = {
        timeout: config.proxy?.connectTimeout || 10000,
        keepAlive: config.proxy?.keepAlive !== false,
        keepAliveMsecs: 30000,
        maxSockets: config.proxy?.maxSockets || 100,
        maxFreeSockets: config.proxy?.maxFreeSockets || 10
      }

      if (useIPv4 !== null) {
        agentOptions.family = useIPv4 ? 4 : 6
      }

      if (proxy.type === 'socks5') {
        const socksUrl = `socks5://${auth}${proxy.host}:${proxy.port}`
        return new SocksProxyAgent(socksUrl, agentOptions)
      } else if (proxy.type === 'http' || proxy.type === 'https') {
        const proxyUrl = `${proxy.type}://${auth}${proxy.host}:${proxy.port}`
        return new HttpsProxyAgent(proxyUrl, agentOptions)
      } else {
        throw new Error(`Unsupported proxy type: ${proxy.type}`)
      }
    } catch (error) {
      logger.error('❌ Direct agent creation failed:', error.message)
      return null
    }
  }

  /**
   * 获取 IP 协议族偏好设置
   * @param {boolean|number|string} preference - 用户偏好设置
   * @returns {boolean|null} true=IPv4, false=IPv6, null=auto
   * @private
   */
  static _getIPFamilyPreference(preference) {
    // 如果没有指定偏好，使用配置文件或默认值
    if (preference === undefined) {
      // 从配置文件读取默认设置，默认使用 IPv4
      const defaultUseIPv4 = config.proxy?.useIPv4
      if (defaultUseIPv4 !== undefined) {
        return defaultUseIPv4
      }
      // 默认值：IPv4（兼容性更好）
      return true
    }

    // 处理各种输入格式
    if (typeof preference === 'boolean') {
      return preference
    }
    if (typeof preference === 'number') {
      return preference === 4 ? true : preference === 6 ? false : null
    }
    if (typeof preference === 'string') {
      const lower = preference.toLowerCase()
      if (lower === 'ipv4' || lower === '4') {
        return true
      }
      if (lower === 'ipv6' || lower === '6') {
        return false
      }
      if (lower === 'auto' || lower === 'both') {
        return null
      }
    }

    // 无法识别的值，返回默认（IPv4）
    return true
  }

  /**
   * 验证代理配置
   * @param {object|string} proxyConfig - 代理配置
   * @returns {boolean} 是否有效
   */
  static validateProxyConfig(proxyConfig) {
    if (!proxyConfig) {
      return false
    }

    try {
      const proxy = typeof proxyConfig === 'string' ? JSON.parse(proxyConfig) : proxyConfig

      // 检查必要字段
      if (!proxy.type || !proxy.host || !proxy.port) {
        return false
      }

      // 检查支持的类型
      if (!['socks5', 'http', 'https'].includes(proxy.type)) {
        return false
      }

      // 检查端口范围
      const port = parseInt(proxy.port)
      if (isNaN(port) || port < 1 || port > 65535) {
        return false
      }

      return true
    } catch (error) {
      return false
    }
  }

  /**
   * 获取代理配置的描述信息
   * @param {object|string} proxyConfig - 代理配置
   * @returns {string} 代理描述
   */
  static getProxyDescription(proxyConfig) {
    if (!proxyConfig) {
      return 'No proxy'
    }

    try {
      const proxy = typeof proxyConfig === 'string' ? JSON.parse(proxyConfig) : proxyConfig
      const hasAuth = proxy.username && proxy.password
      return `${proxy.type}://${proxy.host}:${proxy.port}${hasAuth ? ' (with auth)' : ''}`
    } catch (error) {
      return 'Invalid proxy config'
    }
  }

  /**
   * 脱敏代理配置信息用于日志记录
   * @param {object|string} proxyConfig - 代理配置
   * @returns {string} 脱敏后的代理信息
   */
  static maskProxyInfo(proxyConfig) {
    if (!proxyConfig) {
      return 'No proxy'
    }

    try {
      const proxy = typeof proxyConfig === 'string' ? JSON.parse(proxyConfig) : proxyConfig

      let proxyDesc = `${proxy.type}://${proxy.host}:${proxy.port}`

      // 如果有认证信息，进行脱敏处理
      if (proxy.username && proxy.password) {
        const maskedUsername =
          proxy.username.length <= 2
            ? proxy.username
            : proxy.username[0] +
              '*'.repeat(Math.max(1, proxy.username.length - 2)) +
              proxy.username.slice(-1)
        const maskedPassword = '*'.repeat(Math.min(8, proxy.password.length))
        proxyDesc += ` (auth: ${maskedUsername}:${maskedPassword})`
      }

      return proxyDesc
    } catch (error) {
      return 'Invalid proxy config'
    }
  }

  /**
   * 获取连接池统计信息
   * @returns {object} 连接池统计
   */
  static getConnectionPoolStats() {
    return connectionPoolManager.getStats()
  }

  /**
   * 清理连接池
   */
  static cleanupConnectionPools() {
    connectionPoolManager.cleanup()
  }

  /**
   * 为账户创建专用Agent（推荐接口）
   * @param {string} accountId - 账户ID
   * @param {object|string} proxyConfig - 代理配置
   * @param {object} options - 额外选项
   * @returns {Agent|null} 代理Agent实例
   */
  static createAccountAgent(accountId, proxyConfig, options = {}) {
    if (!accountId) {
      logger.warn('⚠️ Account ID is required for connection pooling')
      return null
    }

    return ProxyHelper.createProxyAgent(proxyConfig, {
      ...options,
      accountId
    })
  }

  /**
   * 创建代理 Agent（兼容旧的函数接口）
   * @param {object|string|null} proxyConfig - 代理配置
   * @param {boolean} useIPv4 - 是否使用 IPv4
   * @returns {Agent|null} 代理 Agent 实例或 null
   * @deprecated 使用 createProxyAgent 或 createAccountAgent 替代
   */
  static createProxy(proxyConfig, useIPv4 = true) {
    logger.warn('⚠️ ProxyHelper.createProxy is deprecated, use createAccountAgent for connection pooling')
    return ProxyHelper.createProxyAgent(proxyConfig, { useIPv4 })
  }
}

module.exports = ProxyHelper
