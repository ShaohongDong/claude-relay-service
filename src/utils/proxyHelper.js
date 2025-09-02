const { SocksProxyAgent } = require('socks-proxy-agent')
const { HttpsProxyAgent } = require('https-proxy-agent')
const logger = require('./logger')
const config = require('../../config/config')
const { performance } = require('perf_hooks')

// 懒加载全局连接池管理器，避免循环依赖
let globalConnectionPoolManager = null
function getConnectionPoolManager() {
  if (!globalConnectionPoolManager) {
    globalConnectionPoolManager = require('../services/globalConnectionPoolManager')
  }
  return globalConnectionPoolManager
}

/**
 * 代理助手 - 简化版
 * 主要功能：
 * - 从连接池获取预热连接
 * - 代理连接监控和日志记录
 * - 代理配置验证和工具方法
 */
class ProxyHelper {
  /**
   * 从连接池获取账户的预热连接（主要接口）
   * @param {string} accountId - 账户ID
   * @returns {object} 连接对象，包含httpsAgent
   */
  static getConnectionForAccount(accountId) {
    try {
      const poolManager = getConnectionPoolManager()
      const connection = poolManager.getConnectionForAccount(accountId)

      logger.debug(`🔗 从连接池获取连接: 账户 ${accountId}, 连接 ${connection.connectionId}`)
      return connection
    } catch (error) {
      logger.error(`❌ 连接池获取连接失败: 账户 ${accountId} - ${error.message}`)
      throw new Error(`Failed to get connection for account ${accountId}: ${error.message}`)
    }
  }

  /**
   * 创建代理 Agent（保留用于向后兼容和降级）
   * @param {object|string|null} proxyConfig - 代理配置对象或 JSON 字符串
   * @param {object} options - 额外选项
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

      // 获取 IPv4/IPv6 配置
      const useIPv4 = ProxyHelper._getIPFamilyPreference(options.useIPv4)

      // 构建认证信息
      const auth = proxy.username && proxy.password ? `${proxy.username}:${proxy.password}@` : ''

      // 根据代理类型创建 Agent
      if (proxy.type === 'socks5') {
        const socksUrl = `socks5://${auth}${proxy.host}:${proxy.port}`
        const socksOptions = {}

        // 设置 IP 协议族（如果指定）
        if (useIPv4 !== null) {
          socksOptions.family = useIPv4 ? 4 : 6
        }

        return new SocksProxyAgent(socksUrl, socksOptions)
      } else if (proxy.type === 'http' || proxy.type === 'https') {
        const proxyUrl = `${proxy.type}://${auth}${proxy.host}:${proxy.port}`
        const httpOptions = {}

        // HttpsProxyAgent 支持 family 参数（通过底层的 agent-base）
        if (useIPv4 !== null) {
          httpOptions.family = useIPv4 ? 4 : 6
        }

        return new HttpsProxyAgent(proxyUrl, httpOptions)
      } else {
        logger.warn(`⚠️ Unsupported proxy type: ${proxy.type}`)
        return null
      }
    } catch (error) {
      logger.warn('⚠️ Failed to create proxy agent:', error.message)
      return null
    }
  }

  /**
   * 为axios请求添加代理连接时间监控
   * @param {object} axiosConfig - axios配置对象
   * @param {object|string|null} proxyConfig - 代理配置（仅用于显示）
   * @param {object} options - 额外选项
   * @returns {object} 增强的axios配置对象
   */
  static addProxyMonitoring(axiosConfig, proxyConfig, options = {}) {
    const proxyInfo = ProxyHelper.maskProxyInfo(proxyConfig)

    // 记录请求开始时间
    const originalStartTime = performance.now()

    // 创建一个包装的请求变换器来记录开始时间
    const originalTransformRequest = axiosConfig.transformRequest || []
    axiosConfig.transformRequest = [
      function recordStartTime(data, headers) {
        // 在headers中记录开始时间和代理信息
        headers['X-Proxy-Start-Time'] = originalStartTime.toString()
        headers['X-Proxy-Info'] = proxyInfo

        if (Array.isArray(originalTransformRequest)) {
          return originalTransformRequest.reduce(
            (result, transformer) =>
              typeof transformer === 'function' ? transformer(result, headers) : result,
            data
          )
        } else if (typeof originalTransformRequest === 'function') {
          return originalTransformRequest(data, headers)
        }
        return data
      }
    ]

    return axiosConfig
  }

  /**
   * 记录代理连接耗时（用于axios响应拦截器）
   * @param {object} response - axios响应对象
   */
  static logProxyConnectTime(response) {
    try {
      const startTimeHeader = response.config.headers?.['X-Proxy-Start-Time']
      const proxyInfoHeader = response.config.headers?.['X-Proxy-Info']

      if (startTimeHeader && proxyInfoHeader) {
        const startTime = parseFloat(startTimeHeader)
        const connectTime = performance.now() - startTime

        // 连接耗时超过1秒时使用warn级别，否则使用debug级别
        if (connectTime > 1000) {
          logger.warn(
            `🔗 代理连接耗时较长 - ${proxyInfoHeader} - 总耗时: ${connectTime.toFixed(2)}ms`
          )
        } else {
          logger.debug(`🔗 代理连接成功 - ${proxyInfoHeader} - 总耗时: ${connectTime.toFixed(2)}ms`)
        }
      }
    } catch (error) {
      logger.debug('Failed to log proxy connect time:', error.message)
    }
  }

  /**
   * 记录代理连接错误
   * @param {Error} error - axios错误对象
   */
  static logProxyConnectError(error) {
    try {
      const startTimeHeader = error.config?.headers?.['X-Proxy-Start-Time']
      const proxyInfoHeader = error.config?.headers?.['X-Proxy-Info']

      if (startTimeHeader && proxyInfoHeader) {
        const startTime = parseFloat(startTimeHeader)
        const connectTime = performance.now() - startTime

        logger.warn(
          `🔗 代理连接失败 - ${proxyInfoHeader} - 耗时: ${connectTime.toFixed(2)}ms - 错误: ${error.message}`
        )
      }
    } catch (logError) {
      logger.debug('Failed to log proxy connect error:', logError.message)
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
   * 获取连接池状态（调试和监控用）
   * @param {string} accountId - 账户ID（可选，获取特定账户状态）
   * @returns {object} 连接池状态信息
   */
  static getConnectionPoolStatus(accountId = null) {
    try {
      const poolManager = getConnectionPoolManager()

      if (accountId) {
        return poolManager.getPoolStatus(accountId)
      } else {
        return poolManager.getAllPoolStatus()
      }
    } catch (error) {
      logger.error('❌ 获取连接池状态失败:', error.message)
      return null
    }
  }

  /**
   * 执行连接池健康检查
   * @returns {object} 健康检查结果
   */
  static async performHealthCheck() {
    try {
      const poolManager = getConnectionPoolManager()
      return await poolManager.performHealthCheck()
    } catch (error) {
      logger.error('❌ 连接池健康检查失败:', error.message)
      return null
    }
  }
}

module.exports = ProxyHelper
