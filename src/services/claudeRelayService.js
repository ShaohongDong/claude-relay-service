const https = require('https')
const zlib = require('zlib')
const fs = require('fs')
const path = require('path')
const ProxyHelper = require('../utils/proxyHelper')
const claudeAccountService = require('./claudeAccountService')
const unifiedClaudeScheduler = require('./unifiedClaudeScheduler')
const sessionHelper = require('../utils/sessionHelper')
const logger = require('../utils/logger')
const config = require('../../config/config')
const claudeCodeHeadersService = require('./claudeCodeHeadersService')
const redis = require('../models/redis')
const performanceOptimizer = require('../utils/performanceOptimizer')

class ClaudeRelayService {
  constructor() {
    this.claudeApiUrl = config.claude.apiUrl
    this.apiVersion = config.claude.apiVersion
    this.betaHeader = config.claude.betaHeader
    this.systemPrompt = config.claude.systemPrompt
    this.claudeCodeSystemPrompt = "You are Claude Code, Anthropic's official CLI for Claude."
  }

  // 🔍 判断是否是真实的 Claude Code 请求
  isRealClaudeCodeRequest(requestBody, clientHeaders) {
    // 检查 user-agent 是否匹配 Claude Code 格式
    const userAgent = clientHeaders?.['user-agent'] || clientHeaders?.['User-Agent'] || ''
    const isClaudeCodeUserAgent = /^claude-cli\/[\d.]+\s+\(/i.test(userAgent)

    // 检查系统提示词是否包含 Claude Code 标识
    const hasClaudeCodeSystemPrompt = this._hasClaudeCodeSystemPrompt(requestBody)

    // 只有当 user-agent 匹配且系统提示词正确时，才认为是真实的 Claude Code 请求
    return isClaudeCodeUserAgent && hasClaudeCodeSystemPrompt
  }

  // 🔍 检查请求中是否包含 Claude Code 系统提示词
  _hasClaudeCodeSystemPrompt(requestBody) {
    if (!requestBody || !requestBody.system) {
      return false
    }

    // 如果是字符串格式，一定不是真实的 Claude Code 请求
    if (typeof requestBody.system === 'string') {
      return false
    }

    // 处理数组格式
    if (Array.isArray(requestBody.system) && requestBody.system.length > 0) {
      const firstItem = requestBody.system[0]
      // 检查第一个元素是否包含 Claude Code 提示词
      return (
        firstItem &&
        firstItem.type === 'text' &&
        firstItem.text &&
        firstItem.text === this.claudeCodeSystemPrompt
      )
    }

    return false
  }

  // 🚀 转发请求到Claude API
  async relayRequest(
    requestBody,
    apiKeyData,
    clientRequest,
    clientResponse,
    clientHeaders,
    options = {}
  ) {
    let upstreamRequest = null

    try {
      // 调试日志：查看API Key数据
      logger.info('🔍 API Key data received:', {
        apiKeyName: apiKeyData.name,
        enableModelRestriction: apiKeyData.enableModelRestriction,
        restrictedModels: apiKeyData.restrictedModels,
        requestedModel: requestBody.model
      })

      // 检查模型限制
      if (
        apiKeyData.enableModelRestriction &&
        apiKeyData.restrictedModels &&
        apiKeyData.restrictedModels.length > 0
      ) {
        const requestedModel = requestBody.model
        logger.info(
          `🔒 Model restriction check - Requested model: ${requestedModel}, Restricted models: ${JSON.stringify(apiKeyData.restrictedModels)}`
        )

        if (requestedModel && apiKeyData.restrictedModels.includes(requestedModel)) {
          logger.warn(
            `🚫 Model restriction violation for key ${apiKeyData.name}: Attempted to use restricted model ${requestedModel}`
          )
          return {
            statusCode: 403,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              error: {
                type: 'forbidden',
                message: '暂无该模型访问权限'
              }
            })
          }
        }
      }

      // 生成会话哈希用于sticky会话
      const sessionHash = sessionHelper.generateSessionHash(requestBody)

      // 选择可用的Claude账户（支持专属绑定和sticky会话）
      const accountSelection = await unifiedClaudeScheduler.selectAccountForApiKey(
        apiKeyData,
        sessionHash,
        requestBody.model
      )
      const { accountId } = accountSelection
      const { accountType } = accountSelection

      logger.info(
        `📤 Processing API request for key: ${apiKeyData.name || apiKeyData.id}, account: ${accountId} (${accountType})${sessionHash ? `, session: ${sessionHash}` : ''}`
      )

      // 获取有效的访问token
      const accessToken = await claudeAccountService.getValidAccessToken(accountId)

      // 处理请求体（传递 clientHeaders 以判断是否需要设置 Claude Code 系统提示词）
      const processedBody = this._processRequestBody(requestBody, clientHeaders)

      // 获取代理配置
      const proxyAgent = await this._getProxyAgent(accountId)

      // 设置客户端断开监听器
      const handleClientDisconnect = () => {
        logger.info('🔌 Client disconnected, aborting upstream request')
        if (upstreamRequest && !upstreamRequest.destroyed) {
          upstreamRequest.destroy()
        }
      }

      // 监听客户端断开事件
      if (clientRequest) {
        clientRequest.once('close', handleClientDisconnect)
      }
      if (clientResponse) {
        clientResponse.once('close', handleClientDisconnect)
      }

      // 发送请求到Claude API（传入回调以获取请求对象）
      const response = await this._makeClaudeRequest(
        processedBody,
        accessToken,
        proxyAgent,
        clientHeaders,
        accountId,
        (req) => {
          upstreamRequest = req
        },
        options
      )

      // 移除监听器（请求成功完成）
      if (clientRequest) {
        clientRequest.removeListener('close', handleClientDisconnect)
      }
      if (clientResponse) {
        clientResponse.removeListener('close', handleClientDisconnect)
      }

      // 检查响应是否为限流错误或认证错误
      if (response.statusCode !== 200 && response.statusCode !== 201) {
        let isRateLimited = false
        let rateLimitResetTimestamp = null

        // 检查是否为401状态码（未授权）
        if (response.statusCode === 401) {
          logger.warn(`🔐 Unauthorized error (401) detected for account ${accountId}`)

          // 记录401错误
          await this.recordUnauthorizedError(accountId)

          // 检查是否需要标记为异常（遇到1次401就停止调度）
          const errorCount = await this.getUnauthorizedErrorCount(accountId)
          logger.info(
            `🔐 Account ${accountId} has ${errorCount} consecutive 401 errors in the last 5 minutes`
          )

          if (errorCount >= 1) {
            logger.error(
              `❌ Account ${accountId} encountered 401 error (${errorCount} errors), marking as unauthorized and attempting account switch`
            )
            await unifiedClaudeScheduler.markAccountUnauthorized(
              accountId,
              accountType,
              sessionHash
            )
          }

          // 对于401错误，也尝试账户切换重试
          try {
            logger.info(
              `🔄 Initiating account switch retry for 401 error - API Key: ${apiKeyData.name}`
            )
            const retryResponse = await this._retryWithAccountSwitch(
              requestBody,
              apiKeyData,
              clientRequest,
              clientResponse,
              clientHeaders,
              options
            )

            // 如果重试成功，返回新的响应
            logger.info(
              `✅ Account switch retry successful for 401 error - API Key: ${apiKeyData.name}`
            )
            return retryResponse
          } catch (retryError) {
            logger.error(
              `❌ Account switch retry failed for 401 error - API Key: ${apiKeyData.name}:`,
              retryError.message
            )
            // 重试失败，继续使用原始的401响应
          }
        }
        // 检查是否为403状态码（禁止访问）
        else if (response.statusCode === 403) {
          logger.error(
            `🚫 Forbidden error (403) detected for account ${accountId}, marking as blocked`
          )
          await unifiedClaudeScheduler.markAccountBlocked(accountId, accountType, sessionHash)
        }
        // 检查是否为5xx状态码
        else if (response.statusCode >= 500 && response.statusCode < 600) {
          logger.warn(`🔥 Server error (${response.statusCode}) detected for account ${accountId}`)
          // 记录5xx错误
          await claudeAccountService.recordServerError(accountId, response.statusCode)
          // 检查是否需要标记为临时错误状态（连续3次500）
          const errorCount = await claudeAccountService.getServerErrorCount(accountId)
          logger.info(
            `🔥 Account ${accountId} has ${errorCount} consecutive 5xx errors in the last 5 minutes`
          )
          if (errorCount > 10) {
            logger.error(
              `❌ Account ${accountId} exceeded 5xx error threshold (${errorCount} errors), marking as temp_error`
            )
            await claudeAccountService.markAccountTempError(accountId, sessionHash)
          }
        }
        // 检查是否为429状态码
        else if (response.statusCode === 429) {
          isRateLimited = true

          // 提取限流重置时间戳
          if (response.headers && response.headers['anthropic-ratelimit-unified-reset']) {
            rateLimitResetTimestamp = parseInt(
              response.headers['anthropic-ratelimit-unified-reset']
            )
            logger.info(
              `🕐 Extracted rate limit reset timestamp: ${rateLimitResetTimestamp} (${new Date(rateLimitResetTimestamp * 1000).toISOString()})`
            )
          }
        } else {
          // 检查响应体中的错误信息
          try {
            const responseBody =
              typeof response.body === 'string' ? JSON.parse(response.body) : response.body
            if (
              responseBody &&
              responseBody.error &&
              responseBody.error.message &&
              responseBody.error.message.toLowerCase().includes("exceed your account's rate limit")
            ) {
              isRateLimited = true
            }
          } catch (e) {
            // 如果解析失败，检查原始字符串
            if (
              response.body &&
              response.body.toLowerCase().includes("exceed your account's rate limit")
            ) {
              isRateLimited = true
            }
          }
        }

        if (isRateLimited) {
          logger.warn(
            `🚫 Rate limit detected for account ${accountId}, status: ${response.statusCode}, attempting account switch retry`
          )

          // 先标记当前账户为限流状态
          await unifiedClaudeScheduler.markAccountRateLimited(
            accountId,
            accountType,
            sessionHash,
            rateLimitResetTimestamp
          )

          // 尝试账户切换重试
          try {
            logger.info(
              `🔄 Initiating account switch retry for 429 error - API Key: ${apiKeyData.name}`
            )
            const retryResponse = await this._retryWithAccountSwitch(
              requestBody,
              apiKeyData,
              clientRequest,
              clientResponse,
              clientHeaders,
              options
            )

            // 如果重试成功，返回新的响应
            logger.info(`✅ Account switch retry successful for API Key: ${apiKeyData.name}`)
            return retryResponse
          } catch (retryError) {
            logger.error(
              `❌ Account switch retry failed for API Key: ${apiKeyData.name}:`,
              retryError.message
            )
            // 重试失败，继续使用原始的限流响应
          }
        }
      } else if (response.statusCode === 200 || response.statusCode === 201) {
        // 提取5小时会话窗口状态
        // 使用大小写不敏感的方式获取响应头
        const get5hStatus = (headers) => {
          if (!headers) {
            return null
          }
          // HTTP头部名称不区分大小写，需要处理不同情况
          return (
            headers['anthropic-ratelimit-unified-5h-status'] ||
            headers['Anthropic-Ratelimit-Unified-5h-Status'] ||
            headers['ANTHROPIC-RATELIMIT-UNIFIED-5H-STATUS']
          )
        }

        const sessionWindowStatus = get5hStatus(response.headers)
        if (sessionWindowStatus) {
          logger.info(`📊 Session window status for account ${accountId}: ${sessionWindowStatus}`)
          // 保存会话窗口状态到账户数据
          await claudeAccountService.updateSessionWindowStatus(accountId, sessionWindowStatus)
        }

        // 请求成功，清除401和500错误计数
        await this.clearUnauthorizedErrors(accountId)
        await claudeAccountService.clearInternalErrors(accountId)
        // 如果请求成功，检查并移除限流状态
        const isRateLimited = await unifiedClaudeScheduler.isAccountRateLimited(
          accountId,
          accountType
        )
        if (isRateLimited) {
          await unifiedClaudeScheduler.removeAccountRateLimit(accountId, accountType)
        }

        // 只有真实的 Claude Code 请求才更新 headers
        if (
          clientHeaders &&
          Object.keys(clientHeaders).length > 0 &&
          this.isRealClaudeCodeRequest(requestBody, clientHeaders)
        ) {
          await claudeCodeHeadersService.storeAccountHeaders(accountId, clientHeaders)
        }
      }

      // 记录成功的API调用并打印详细的usage数据
      let responseBody = null
      try {
        responseBody = typeof response.body === 'string' ? JSON.parse(response.body) : response.body
      } catch (e) {
        logger.debug('Failed to parse response body for usage logging')
      }

      if (responseBody && responseBody.usage) {
        const { usage } = responseBody
        // 打印原始usage数据为JSON字符串
        logger.info(
          `📊 === Non-Stream Request Usage Summary === Model: ${requestBody.model}, Usage: ${JSON.stringify(usage)}`
        )
      } else {
        // 如果没有usage数据，使用估算值
        const inputTokens = requestBody.messages
          ? requestBody.messages.reduce((sum, msg) => sum + (msg.content?.length || 0), 0) / 4
          : 0
        const outputTokens = response.content
          ? response.content.reduce((sum, content) => sum + (content.text?.length || 0), 0) / 4
          : 0

        logger.info(
          `✅ API request completed - Key: ${apiKeyData.name}, Account: ${accountId}, Model: ${requestBody.model}, Input: ~${Math.round(inputTokens)} tokens (estimated), Output: ~${Math.round(outputTokens)} tokens (estimated)`
        )
      }

      // 在响应中添加accountId，以便调用方记录账户级别统计
      response.accountId = accountId
      return response
    } catch (error) {
      logger.error(
        `❌ Claude relay request failed for key: ${apiKeyData.name || apiKeyData.id}:`,
        error.message
      )
      throw error
    }
  }

  // 🔄 处理请求体
  _processRequestBody(body, clientHeaders = {}) {
    if (!body) {
      return body
    }

    // 判断是否是真实的 Claude Code 请求
    const isRealClaudeCode = this.isRealClaudeCodeRequest(body, clientHeaders)
    const needsSystemModification = !isRealClaudeCode

    // 使用智能拷贝策略替代深拷贝
    const processedBody = performanceOptimizer.smartCopyRequestBody(
      body,
      needsSystemModification,
      false // 不强制深拷贝
    )

    // 验证并限制max_tokens参数
    this._validateAndLimitMaxTokens(processedBody)

    // 移除cache_control中的ttl字段
    this._stripTtlFromCacheControl(processedBody)

    // 如果不是真实的 Claude Code 请求，需要设置 Claude Code 系统提示词
    if (!isRealClaudeCode) {
      this._optimizedSystemPromptProcessing(processedBody)
    }

    // 处理原有的系统提示（如果配置了）
    if (this.systemPrompt && this.systemPrompt.trim()) {
      const systemPrompt = {
        type: 'text',
        text: this.systemPrompt
      }

      // 经过上面的处理，system 现在应该总是数组格式
      if (processedBody.system && Array.isArray(processedBody.system)) {
        // 不要重复添加相同的系统提示
        const hasSystemPrompt = processedBody.system.some(
          (item) => item && item.text && item.text === this.systemPrompt
        )
        if (!hasSystemPrompt) {
          processedBody.system.push(systemPrompt)
        }
      } else {
        // 理论上不应该走到这里，但为了安全起见
        processedBody.system = [systemPrompt]
      }
    } else {
      // 如果没有配置系统提示，且system字段为空，则删除它
      if (processedBody.system && Array.isArray(processedBody.system)) {
        const hasValidContent = processedBody.system.some(
          (item) => item && item.text && item.text.trim()
        )
        if (!hasValidContent) {
          delete processedBody.system
        }
      }
    }

    // Claude API只允许temperature或top_p其中之一，优先使用temperature
    if (processedBody.top_p !== undefined && processedBody.top_p !== null) {
      delete processedBody.top_p
    }

    return processedBody
  }

  // 🔢 验证并限制max_tokens参数
  _validateAndLimitMaxTokens(body) {
    if (!body || !body.max_tokens) {
      return
    }

    try {
      // 读取模型定价配置文件
      const pricingFilePath = path.join(__dirname, '../../data/model_pricing.json')

      if (!fs.existsSync(pricingFilePath)) {
        logger.warn('⚠️ Model pricing file not found, skipping max_tokens validation')
        return
      }

      const pricingData = JSON.parse(fs.readFileSync(pricingFilePath, 'utf8'))
      const model = body.model || 'claude-sonnet-4-20250514'

      // 查找对应模型的配置
      const modelConfig = pricingData[model]

      if (!modelConfig) {
        // 如果找不到模型配置，直接透传客户端参数，不进行任何干预
        logger.info(
          `📝 Model ${model} not found in pricing file, passing through client parameters without modification`
        )
        return
      }

      // 获取模型的最大token限制
      const maxLimit = modelConfig.max_tokens || modelConfig.max_output_tokens

      if (!maxLimit) {
        logger.debug(`🔍 No max_tokens limit found for model ${model}, skipping validation`)
        return
      }

      // 检查并调整max_tokens
      if (body.max_tokens > maxLimit) {
        logger.warn(
          `⚠️ max_tokens ${body.max_tokens} exceeds limit ${maxLimit} for model ${model}, adjusting to ${maxLimit}`
        )
        body.max_tokens = maxLimit
      }
    } catch (error) {
      logger.error('❌ Failed to validate max_tokens from pricing file:', error)
      // 如果文件读取失败，不进行校验，让请求继续处理
    }
  }

  // 🧹 移除TTL字段
  _stripTtlFromCacheControl(body) {
    if (!body || typeof body !== 'object') {
      return
    }

    const processContentArray = (contentArray) => {
      if (!Array.isArray(contentArray)) {
        return
      }

      contentArray.forEach((item) => {
        if (item && typeof item === 'object' && item.cache_control) {
          if (item.cache_control.ttl) {
            delete item.cache_control.ttl
            logger.debug('🧹 Removed ttl from cache_control')
          }
        }
      })
    }

    if (Array.isArray(body.system)) {
      processContentArray(body.system)
    }

    if (Array.isArray(body.messages)) {
      body.messages.forEach((message) => {
        if (message && Array.isArray(message.content)) {
          processContentArray(message.content)
        }
      })
    }
  }

  // ⚡ 优化的系统提示词处理
  _optimizedSystemPromptProcessing(processedBody) {
    // 使用预编译的Claude Code提示词
    const claudeCodePrompt = performanceOptimizer.getPrecompiledPrompt('claude_code_only')[0]

    if (!processedBody.system) {
      // 用户没有传递system，使用预编译提示词
      processedBody.system = [claudeCodePrompt]
      return
    }

    if (typeof processedBody.system === 'string') {
      // 字符串格式：检查是否与Claude Code提示词相同
      if (processedBody.system.trim() === this.claudeCodeSystemPrompt) {
        processedBody.system = [claudeCodePrompt]
      } else {
        // 使用预编译模板
        processedBody.system = performanceOptimizer.getPrecompiledPrompt(
          'claude_code_with_string',
          processedBody.system
        )
      }
      return
    }

    if (Array.isArray(processedBody.system)) {
      // 检查第一个元素是否已经是Claude Code提示词
      const firstItem = processedBody.system[0]
      const isFirstItemClaudeCode =
        firstItem && firstItem.type === 'text' && firstItem.text === this.claudeCodeSystemPrompt

      if (!isFirstItemClaudeCode) {
        // 使用缓存的正则表达式过滤重复的Claude Code提示词
        const claudeCodeRegex = performanceOptimizer.getCachedRegExp(
          `^${this.claudeCodeSystemPrompt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`
        )

        const filteredSystem = processedBody.system.filter(
          (item) => !(item && item.type === 'text' && claudeCodeRegex.test(item.text))
        )
        processedBody.system = [claudeCodePrompt, ...filteredSystem]
      }
      return
    }

    // 其他格式，使用预编译提示词
    logger.warn('⚠️ Unexpected system field type:', typeof processedBody.system)
    processedBody.system = [claudeCodePrompt]
  }

  // 🌐 获取代理Agent（使用统一的代理工具和缓存）
  async _getProxyAgent(accountId) {
    try {
      // 尝试从缓存获取账户配置
      let account = performanceOptimizer.getCachedAccountConfig(accountId)

      if (!account) {
        // 缓存未命中，查询数据库
        const accountData = await claudeAccountService.getAllAccounts()
        account = accountData.find((acc) => acc.id === accountId)

        if (account) {
          // 缓存账户配置
          performanceOptimizer.cacheAccountConfig(accountId, account)
        }
      }

      if (!account || !account.proxy) {
        logger.debug('🌐 No proxy configured for Claude account')
        return null
      }

      const proxyAgent = ProxyHelper.createProxyAgent(account.proxy)
      if (proxyAgent) {
        logger.info(
          `🌐 Using proxy for Claude request: ${ProxyHelper.getProxyDescription(account.proxy)}`
        )
      }
      return proxyAgent
    } catch (error) {
      logger.warn('⚠️ Failed to create proxy agent:', error)
      return null
    }
  }

  // 🔧 过滤客户端请求头
  _filterClientHeaders(clientHeaders) {
    // 需要移除的敏感 headers
    const sensitiveHeaders = [
      'content-type',
      'user-agent',
      'x-api-key',
      'authorization',
      'host',
      'content-length',
      'connection',
      'proxy-authorization',
      'content-encoding',
      'transfer-encoding'
    ]

    // 应该保留的 headers（用于会话一致性和追踪）
    const allowedHeaders = ['x-request-id']

    const filteredHeaders = {}

    // 转发客户端的非敏感 headers
    Object.keys(clientHeaders || {}).forEach((key) => {
      const lowerKey = key.toLowerCase()
      // 如果在允许列表中，直接保留
      if (allowedHeaders.includes(lowerKey)) {
        filteredHeaders[key] = clientHeaders[key]
      }
      // 如果不在敏感列表中，也保留
      else if (!sensitiveHeaders.includes(lowerKey)) {
        filteredHeaders[key] = clientHeaders[key]
      }
    })

    return filteredHeaders
  }

  // 🔗 发送请求到Claude API
  async _makeClaudeRequest(
    body,
    accessToken,
    proxyAgent,
    clientHeaders,
    accountId,
    onRequest,
    requestOptions = {}
  ) {
    const url = new URL(this.claudeApiUrl)

    // 获取账户信息用于统一 User-Agent
    const account = await claudeAccountService.getAccount(accountId)

    // 获取统一的 User-Agent
    const unifiedUA = await this.captureAndGetUnifiedUserAgent(clientHeaders, account)

    // 获取过滤后的客户端 headers
    const filteredHeaders = this._filterClientHeaders(clientHeaders)

    // 判断是否是真实的 Claude Code 请求
    const isRealClaudeCode = this.isRealClaudeCodeRequest(body, clientHeaders)

    // 如果不是真实的 Claude Code 请求，需要使用从账户获取的 Claude Code headers
    const finalHeaders = { ...filteredHeaders }

    if (!isRealClaudeCode) {
      // 获取该账号存储的 Claude Code headers
      const claudeCodeHeaders = await claudeCodeHeadersService.getAccountHeaders(accountId)

      // 只添加客户端没有提供的 headers
      Object.keys(claudeCodeHeaders).forEach((key) => {
        const lowerKey = key.toLowerCase()
        if (!finalHeaders[key] && !finalHeaders[lowerKey]) {
          finalHeaders[key] = claudeCodeHeaders[key]
        }
      })
    }

    return new Promise((resolve, reject) => {
      // 支持自定义路径（如 count_tokens）
      let requestPath = url.pathname
      if (requestOptions.customPath) {
        const baseUrl = new URL('https://api.anthropic.com')
        const customUrl = new URL(requestOptions.customPath, baseUrl)
        requestPath = customUrl.pathname
      }

      const options = {
        hostname: url.hostname,
        port: url.port || 443,
        path: requestPath,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
          'anthropic-version': this.apiVersion,
          ...finalHeaders
        },
        agent: proxyAgent,
        timeout: config.proxy.timeout
      }

      // 使用统一 User-Agent 或客户端提供的，最后使用默认值
      if (!options.headers['User-Agent'] && !options.headers['user-agent']) {
        const userAgent =
          unifiedUA ||
          clientHeaders?.['user-agent'] ||
          clientHeaders?.['User-Agent'] ||
          'claude-cli/1.0.102 (external, cli)'
        options.headers['User-Agent'] = userAgent
      }

      logger.info(`🔗 指纹是这个: ${options.headers['User-Agent']}`)
      logger.info(`🔗 指纹是这个: ${options.headers['user-agent']}`)

      // 使用自定义的 betaHeader 或默认值
      const betaHeader =
        requestOptions?.betaHeader !== undefined ? requestOptions.betaHeader : this.betaHeader
      if (betaHeader) {
        options.headers['anthropic-beta'] = betaHeader
      }

      const req = https.request(options, (res) => {
        let responseData = Buffer.alloc(0)

        res.on('data', (chunk) => {
          responseData = Buffer.concat([responseData, chunk])
        })

        res.on('end', () => {
          try {
            let bodyString = ''

            // 根据Content-Encoding处理响应数据
            const contentEncoding = res.headers['content-encoding']
            if (contentEncoding === 'gzip') {
              try {
                bodyString = zlib.gunzipSync(responseData).toString('utf8')
              } catch (unzipError) {
                logger.error('❌ Failed to decompress gzip response:', unzipError)
                bodyString = responseData.toString('utf8')
              }
            } else if (contentEncoding === 'deflate') {
              try {
                bodyString = zlib.inflateSync(responseData).toString('utf8')
              } catch (unzipError) {
                logger.error('❌ Failed to decompress deflate response:', unzipError)
                bodyString = responseData.toString('utf8')
              }
            } else {
              bodyString = responseData.toString('utf8')
            }

            const response = {
              statusCode: res.statusCode,
              headers: res.headers,
              body: bodyString
            }

            logger.debug(`🔗 Claude API response: ${res.statusCode}`)

            resolve(response)
          } catch (error) {
            logger.error('❌ Failed to parse Claude API response:', error)
            reject(error)
          }
        })
      })

      // 如果提供了 onRequest 回调，传递请求对象
      if (onRequest && typeof onRequest === 'function') {
        onRequest(req)
      }

      req.on('error', (error) => {
        console.error(': ❌ ', error)
        logger.error('❌ Claude API request error:', error.message, {
          code: error.code,
          errno: error.errno,
          syscall: error.syscall,
          address: error.address,
          port: error.port
        })

        // 根据错误类型提供更具体的错误信息
        let errorMessage = 'Upstream request failed'
        if (error.code === 'ECONNRESET') {
          errorMessage = 'Connection reset by Claude API server'
        } else if (error.code === 'ENOTFOUND') {
          errorMessage = 'Unable to resolve Claude API hostname'
        } else if (error.code === 'ECONNREFUSED') {
          errorMessage = 'Connection refused by Claude API server'
        } else if (error.code === 'ETIMEDOUT') {
          errorMessage = 'Connection timed out to Claude API server'
        }

        reject(new Error(errorMessage))
      })

      req.on('timeout', () => {
        req.destroy()
        logger.error('❌ Claude API request timeout')
        reject(new Error('Request timeout'))
      })

      // 写入请求体
      req.write(JSON.stringify(body))
      req.end()
    })
  }

  // 🌊 处理流式响应（带usage数据捕获）
  async relayStreamRequestWithUsageCapture(
    requestBody,
    apiKeyData,
    responseStream,
    clientHeaders,
    usageCallback,
    streamTransformer = null,
    options = {}
  ) {
    try {
      // 调试日志：查看API Key数据（流式请求）
      logger.info('🔍 [Stream] API Key data received:', {
        apiKeyName: apiKeyData.name,
        enableModelRestriction: apiKeyData.enableModelRestriction,
        restrictedModels: apiKeyData.restrictedModels,
        requestedModel: requestBody.model
      })

      // 检查模型限制
      if (
        apiKeyData.enableModelRestriction &&
        apiKeyData.restrictedModels &&
        apiKeyData.restrictedModels.length > 0
      ) {
        const requestedModel = requestBody.model
        logger.info(
          `🔒 [Stream] Model restriction check - Requested model: ${requestedModel}, Restricted models: ${JSON.stringify(apiKeyData.restrictedModels)}`
        )

        if (requestedModel && apiKeyData.restrictedModels.includes(requestedModel)) {
          logger.warn(
            `🚫 Model restriction violation for key ${apiKeyData.name}: Attempted to use restricted model ${requestedModel}`
          )

          // 对于流式响应，需要写入错误并结束流
          const errorResponse = JSON.stringify({
            error: {
              type: 'forbidden',
              message: '暂无该模型访问权限'
            }
          })

          responseStream.writeHead(403, { 'Content-Type': 'application/json' })
          responseStream.end(errorResponse)
          return
        }
      }

      // 实现流式请求的账户切换重试逻辑
      await this._executeStreamRequestWithRetry(
        requestBody,
        apiKeyData,
        responseStream,
        clientHeaders,
        usageCallback,
        streamTransformer,
        options
      )
    } catch (error) {
      logger.error('❌ Claude stream relay with usage capture failed:', error)
      throw error
    }
  }

  // 🌊 执行带重试的流式请求
  async _executeStreamRequestWithRetry(
    requestBody,
    apiKeyData,
    responseStream,
    clientHeaders,
    usageCallback,
    streamTransformer = null,
    options = {},
    maxRetries = 2
  ) {
    let lastError = null
    let originalSessionHash = null

    // 生成会话哈希用于sticky会话
    const sessionHash = sessionHelper.generateSessionHash(requestBody)
    originalSessionHash = sessionHash

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        logger.info(
          `🌊 Stream request attempt ${attempt + 1}/${maxRetries + 1} for API key: ${apiKeyData.name}`
        )

        // 在重试时，需要重新选择账户（因为之前的账户已被标记为限流）
        const currentSessionHash = attempt === 0 ? originalSessionHash : null // 首次尝试使用原session，重试时不使用

        // 选择可用的Claude账户（支持专属绑定和sticky会话）
        const accountSelection = await unifiedClaudeScheduler.selectAccountForApiKey(
          apiKeyData,
          currentSessionHash,
          requestBody.model
        )
        const { accountId } = accountSelection
        const { accountType } = accountSelection

        logger.info(
          `📡 Stream attempt ${attempt + 1}: Processing streaming API request for key: ${apiKeyData.name || apiKeyData.id}, account: ${accountId} (${accountType})${currentSessionHash ? `, session: ${currentSessionHash}` : ''}`
        )

        // 获取有效的访问token
        const accessToken = await claudeAccountService.getValidAccessToken(accountId)

        // 处理请求体（传递 clientHeaders 以判断是否需要设置 Claude Code 系统提示词）
        const processedBody = this._processRequestBody(requestBody, clientHeaders)

        // 获取代理配置
        const proxyAgent = await this._getProxyAgent(accountId)

        // 发送流式请求并捕获usage数据
        await this._makeClaudeStreamRequestWithUsageCapture(
          processedBody,
          accessToken,
          proxyAgent,
          clientHeaders,
          responseStream,
          (usageData) => {
            // 在usageCallback中添加accountId
            usageCallback({ ...usageData, accountId })
          },
          accountId,
          accountType,
          currentSessionHash,
          streamTransformer,
          options
        )

        // 如果执行到这里，说明流式请求成功完成
        if (attempt > 0) {
          logger.info(
            `✅ Stream account switch retry successful after ${attempt + 1} attempts - Key: ${apiKeyData.name}, Final Account: ${accountId}, Model: ${requestBody.model}`
          )
        }
        return // 成功完成，退出重试循环
      } catch (error) {
        logger.error(`❌ Stream attempt ${attempt + 1} failed:`, error.message)

        // 检查是否是可重试的错误（429限流或401未授权）
        const isRetryableError =
          error.message.includes('429') ||
          error.message.includes('Rate limit') ||
          error.message.includes('401') ||
          error.message.includes('Unauthorized') ||
          error.response?.statusCode === 429 ||
          error.response?.statusCode === 401

        if (isRetryableError && attempt < maxRetries) {
          logger.warn(
            `🔄 Stream retryable error detected, attempting account switch for attempt ${attempt + 2}`
          )

          // 短暂延迟后重试，避免过快重试
          await new Promise((resolve) => setTimeout(resolve, 1000))
          lastError = error
          continue
        } else {
          // 不可重试的错误，或者已达到最大重试次数
          if (attempt >= maxRetries) {
            logger.error(
              `❌ All stream attempts failed after ${maxRetries + 1} attempts for API key: ${apiKeyData.name}`
            )
          }
          throw error
        }
      }
    }

    // 如果所有重试都失败了（理论上不应该到达这里，因为上面会抛出错误）
    if (lastError) {
      throw lastError
    }

    throw new Error(`All stream attempts failed for API key: ${apiKeyData.name}`)
  }

  // 🌊 发送流式请求到Claude API（带usage数据捕获）
  async _makeClaudeStreamRequestWithUsageCapture(
    body,
    accessToken,
    proxyAgent,
    clientHeaders,
    responseStream,
    usageCallback,
    accountId,
    accountType,
    sessionHash,
    streamTransformer = null,
    requestOptions = {}
  ) {
    // 获取账户信息用于统一 User-Agent
    const account = await claudeAccountService.getAccount(accountId)

    // 获取统一的 User-Agent
    const unifiedUA = await this.captureAndGetUnifiedUserAgent(clientHeaders, account)

    // 获取过滤后的客户端 headers
    const filteredHeaders = this._filterClientHeaders(clientHeaders)

    // 判断是否是真实的 Claude Code 请求
    const isRealClaudeCode = this.isRealClaudeCodeRequest(body, clientHeaders)

    // 如果不是真实的 Claude Code 请求，需要使用从账户获取的 Claude Code headers
    const finalHeaders = { ...filteredHeaders }

    if (!isRealClaudeCode) {
      // 获取该账号存储的 Claude Code headers
      const claudeCodeHeaders = await claudeCodeHeadersService.getAccountHeaders(accountId)

      // 只添加客户端没有提供的 headers
      Object.keys(claudeCodeHeaders).forEach((key) => {
        const lowerKey = key.toLowerCase()
        if (!finalHeaders[key] && !finalHeaders[lowerKey]) {
          finalHeaders[key] = claudeCodeHeaders[key]
        }
      })
    }

    return new Promise((resolve, reject) => {
      const url = new URL(this.claudeApiUrl)

      const options = {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
          'anthropic-version': this.apiVersion,
          ...finalHeaders
        },
        agent: proxyAgent,
        timeout: config.proxy.timeout
      }

      // 使用统一 User-Agent 或客户端提供的，最后使用默认值
      if (!options.headers['User-Agent'] && !options.headers['user-agent']) {
        const userAgent =
          unifiedUA ||
          clientHeaders?.['user-agent'] ||
          clientHeaders?.['User-Agent'] ||
          'claude-cli/1.0.102 (external, cli)'
        options.headers['User-Agent'] = userAgent
      }

      // 使用自定义的 betaHeader 或默认值
      const betaHeader =
        requestOptions?.betaHeader !== undefined ? requestOptions.betaHeader : this.betaHeader
      if (betaHeader) {
        options.headers['anthropic-beta'] = betaHeader
      }

      const req = https.request(options, (res) => {
        logger.debug(`🌊 Claude stream response status: ${res.statusCode}`)

        // 错误响应处理
        if (res.statusCode !== 200) {
          // 将错误处理逻辑封装在一个异步函数中
          const handleErrorResponse = async () => {
            if (res.statusCode === 401) {
              logger.warn(`🔐 [Stream] Unauthorized error (401) detected for account ${accountId}`)

              await this.recordUnauthorizedError(accountId)

              const errorCount = await this.getUnauthorizedErrorCount(accountId)
              logger.info(
                `🔐 [Stream] Account ${accountId} has ${errorCount} consecutive 401 errors in the last 5 minutes`
              )

              if (errorCount >= 1) {
                logger.error(
                  `❌ [Stream] Account ${accountId} encountered 401 error (${errorCount} errors), marking as unauthorized`
                )
                await unifiedClaudeScheduler.markAccountUnauthorized(
                  accountId,
                  accountType,
                  sessionHash
                )
              }
            } else if (res.statusCode === 403) {
              logger.error(
                `🚫 [Stream] Forbidden error (403) detected for account ${accountId}, marking as blocked`
              )
              await unifiedClaudeScheduler.markAccountBlocked(accountId, accountType, sessionHash)
            } else if (res.statusCode >= 500 && res.statusCode < 600) {
              logger.warn(
                `🔥 [Stream] Server error (${res.statusCode}) detected for account ${accountId}`
              )
              // 记录5xx错误
              await claudeAccountService.recordServerError(accountId, res.statusCode)
              // 检查是否需要标记为临时错误状态（连续3次500）
              const errorCount = await claudeAccountService.getServerErrorCount(accountId)
              logger.info(
                `🔥 [Stream] Account ${accountId} has ${errorCount} consecutive 5xx errors in the last 5 minutes`
              )
              if (errorCount > 10) {
                logger.error(
                  `❌ [Stream] Account ${accountId} exceeded 5xx error threshold (${errorCount} errors), marking as temp_error`
                )
                await claudeAccountService.markAccountTempError(accountId, sessionHash)
              }
            }
          }

          // 调用异步错误处理函数
          handleErrorResponse().catch((err) => {
            logger.error('❌ Error in stream error handler:', err)
          })

          logger.error(`❌ Claude API returned error status: ${res.statusCode}`)

          // 对于429错误，立即标记账户并reject以触发重试机制
          if (res.statusCode === 429) {
            logger.warn(
              `🚫 Stream HTTP 429 error detected, marking account and rejecting to enable retry`
            )

            // 提取限流重置时间戳
            let rateLimitResetTimestamp = null
            if (res.headers && res.headers['anthropic-ratelimit-unified-reset']) {
              rateLimitResetTimestamp = parseInt(res.headers['anthropic-ratelimit-unified-reset'])
              logger.info(
                `🕐 Extracted rate limit reset timestamp from stream: ${rateLimitResetTimestamp} (${new Date(rateLimitResetTimestamp * 1000).toISOString()})`
              )
            }

            // 立即标记账户为限流状态
            unifiedClaudeScheduler
              .markAccountRateLimited(accountId, accountType, sessionHash, rateLimitResetTimestamp)
              .then(() => {
                logger.info(`✅ Account ${accountId} marked as rate limited before stream retry`)
              })
              .catch((markError) => {
                logger.error(`❌ Failed to mark account ${accountId} as rate limited:`, markError)
              })

            reject(new Error(`Claude API rate limit (HTTP 429) for account ${accountId}`))
            return
          }

          // 对于其他错误，收集错误数据
          let errorData = ''

          res.on('data', (chunk) => {
            errorData += chunk.toString()
          })

          res.on('end', () => {
            console.error(': ❌ ', errorData)
            logger.error('❌ Claude API error response:', errorData)
            if (!responseStream.destroyed) {
              // 发送错误事件
              responseStream.write('event: error\n')
              responseStream.write(
                `data: ${JSON.stringify({
                  error: 'Claude API error',
                  status: res.statusCode,
                  details: errorData,
                  timestamp: new Date().toISOString()
                })}\n\n`
              )
              responseStream.end()
            }
            reject(new Error(`Claude API error: ${res.statusCode}`))
          })
          return
        }

        let buffer = ''
        const allUsageData = [] // 收集所有的usage事件
        let currentUsageData = {} // 当前正在收集的usage数据
        let rateLimitDetected = false // 限流检测标志

        // 监听数据块，解析SSE并寻找usage信息
        res.on('data', (chunk) => {
          try {
            const chunkStr = chunk.toString()

            buffer += chunkStr

            // 处理完整的SSE行
            const lines = buffer.split('\n')
            buffer = lines.pop() || '' // 保留最后的不完整行

            // 转发已处理的完整行到客户端
            if (lines.length > 0 && !responseStream.destroyed) {
              const linesToForward = lines.join('\n') + (lines.length > 0 ? '\n' : '')
              // 如果有流转换器，应用转换
              if (streamTransformer) {
                const transformed = streamTransformer(linesToForward)
                if (transformed) {
                  responseStream.write(transformed)
                }
              } else {
                responseStream.write(linesToForward)
              }
            }

            for (const line of lines) {
              // 解析SSE数据寻找usage信息
              if (line.startsWith('data: ') && line.length > 6) {
                try {
                  const jsonStr = line.slice(6)
                  const data = JSON.parse(jsonStr)

                  // 收集来自不同事件的usage数据
                  if (data.type === 'message_start' && data.message && data.message.usage) {
                    // 新的消息开始，如果之前有数据，先保存
                    if (
                      currentUsageData.input_tokens !== undefined &&
                      currentUsageData.output_tokens !== undefined
                    ) {
                      allUsageData.push({ ...currentUsageData })
                      currentUsageData = {}
                    }

                    // message_start包含input tokens、cache tokens和模型信息
                    currentUsageData.input_tokens = data.message.usage.input_tokens || 0
                    currentUsageData.cache_creation_input_tokens =
                      data.message.usage.cache_creation_input_tokens || 0
                    currentUsageData.cache_read_input_tokens =
                      data.message.usage.cache_read_input_tokens || 0
                    currentUsageData.model = data.message.model

                    // 检查是否有详细的 cache_creation 对象
                    if (
                      data.message.usage.cache_creation &&
                      typeof data.message.usage.cache_creation === 'object'
                    ) {
                      currentUsageData.cache_creation = {
                        ephemeral_5m_input_tokens:
                          data.message.usage.cache_creation.ephemeral_5m_input_tokens || 0,
                        ephemeral_1h_input_tokens:
                          data.message.usage.cache_creation.ephemeral_1h_input_tokens || 0
                      }
                      logger.debug(
                        '📊 Collected detailed cache creation data:',
                        JSON.stringify(currentUsageData.cache_creation)
                      )
                    }

                    logger.debug(
                      '📊 Collected input/cache data from message_start:',
                      JSON.stringify(currentUsageData)
                    )
                  }

                  // message_delta包含最终的output tokens
                  if (
                    data.type === 'message_delta' &&
                    data.usage &&
                    data.usage.output_tokens !== undefined
                  ) {
                    currentUsageData.output_tokens = data.usage.output_tokens || 0

                    logger.debug(
                      '📊 Collected output data from message_delta:',
                      JSON.stringify(currentUsageData)
                    )

                    // 如果已经收集到了input数据和output数据，这是一个完整的usage
                    if (currentUsageData.input_tokens !== undefined) {
                      logger.debug(
                        '🎯 Complete usage data collected for model:',
                        currentUsageData.model,
                        '- Input:',
                        currentUsageData.input_tokens,
                        'Output:',
                        currentUsageData.output_tokens
                      )
                      // 保存到列表中，但不立即触发回调
                      allUsageData.push({ ...currentUsageData })
                      // 重置当前数据，准备接收下一个
                      currentUsageData = {}
                    }
                  }

                  // 检查是否有限流错误
                  if (
                    data.type === 'error' &&
                    data.error &&
                    data.error.message &&
                    data.error.message.toLowerCase().includes("exceed your account's rate limit")
                  ) {
                    rateLimitDetected = true
                    logger.warn(
                      `🚫 Rate limit detected in SSE stream for account ${accountId}, marking account and rejecting to enable retry`
                    )

                    // 立即标记账户为限流状态
                    unifiedClaudeScheduler
                      .markAccountRateLimited(
                        accountId,
                        accountType,
                        sessionHash,
                        null // SSE错误通常不包含重置时间戳
                      )
                      .then(() => {
                        logger.info(
                          `✅ Account ${accountId} marked as rate limited from SSE stream before retry`
                        )
                      })
                      .catch((markError) => {
                        logger.error(
                          `❌ Failed to mark account ${accountId} as rate limited from SSE:`,
                          markError
                        )
                      })

                    // 立即抛出错误以触发重试机制
                    reject(
                      new Error(
                        `Claude API rate limit exceeded for account ${accountId}: ${data.error.message}`
                      )
                    )
                    return
                  }
                } catch (parseError) {
                  // 忽略JSON解析错误，继续处理
                  logger.debug('🔍 SSE line not JSON or no usage data:', line.slice(0, 100))
                }
              }
            }
          } catch (error) {
            logger.error('❌ Error processing stream data:', error)
            // 发送错误但不破坏流，让它自然结束
            if (!responseStream.destroyed) {
              responseStream.write('event: error\n')
              responseStream.write(
                `data: ${JSON.stringify({
                  error: 'Stream processing error',
                  message: error.message,
                  timestamp: new Date().toISOString()
                })}\n\n`
              )
            }
          }
        })

        res.on('end', async () => {
          try {
            // 处理缓冲区中剩余的数据
            if (buffer.trim() && !responseStream.destroyed) {
              if (streamTransformer) {
                const transformed = streamTransformer(buffer)
                if (transformed) {
                  responseStream.write(transformed)
                }
              } else {
                responseStream.write(buffer)
              }
            }

            // 确保流正确结束
            if (!responseStream.destroyed) {
              responseStream.end()
            }
          } catch (error) {
            logger.error('❌ Error processing stream end:', error)
          }

          // 如果还有未完成的usage数据，尝试保存
          if (currentUsageData.input_tokens !== undefined) {
            if (currentUsageData.output_tokens === undefined) {
              currentUsageData.output_tokens = 0 // 如果没有output，设为0
            }
            allUsageData.push(currentUsageData)
          }

          // 检查是否捕获到usage数据
          if (allUsageData.length === 0) {
            logger.warn(
              '⚠️ Stream completed but no usage data was captured! This indicates a problem with SSE parsing or Claude API response format.'
            )
          } else {
            // 打印此次请求的所有usage数据汇总
            const totalUsage = allUsageData.reduce(
              (acc, usage) => ({
                input_tokens: (acc.input_tokens || 0) + (usage.input_tokens || 0),
                output_tokens: (acc.output_tokens || 0) + (usage.output_tokens || 0),
                cache_creation_input_tokens:
                  (acc.cache_creation_input_tokens || 0) + (usage.cache_creation_input_tokens || 0),
                cache_read_input_tokens:
                  (acc.cache_read_input_tokens || 0) + (usage.cache_read_input_tokens || 0),
                models: [...(acc.models || []), usage.model].filter(Boolean)
              }),
              {}
            )

            // 打印原始的usage数据为JSON字符串，避免嵌套问题
            logger.info(
              `📊 === Stream Request Usage Summary === Model: ${body.model}, Total Events: ${allUsageData.length}, Usage Data: ${JSON.stringify(allUsageData)}`
            )

            // 一般一个请求只会使用一个模型，即使有多个usage事件也应该合并
            // 计算总的usage
            const finalUsage = {
              input_tokens: totalUsage.input_tokens,
              output_tokens: totalUsage.output_tokens,
              cache_creation_input_tokens: totalUsage.cache_creation_input_tokens,
              cache_read_input_tokens: totalUsage.cache_read_input_tokens,
              model: allUsageData[allUsageData.length - 1].model || body.model // 使用最后一个模型或请求模型
            }

            // 如果有详细的cache_creation数据，合并它们
            let totalEphemeral5m = 0
            let totalEphemeral1h = 0
            allUsageData.forEach((usage) => {
              if (usage.cache_creation && typeof usage.cache_creation === 'object') {
                totalEphemeral5m += usage.cache_creation.ephemeral_5m_input_tokens || 0
                totalEphemeral1h += usage.cache_creation.ephemeral_1h_input_tokens || 0
              }
            })

            // 如果有详细的缓存数据，添加到finalUsage
            if (totalEphemeral5m > 0 || totalEphemeral1h > 0) {
              finalUsage.cache_creation = {
                ephemeral_5m_input_tokens: totalEphemeral5m,
                ephemeral_1h_input_tokens: totalEphemeral1h
              }
              logger.info(
                '📊 Detailed cache creation breakdown:',
                JSON.stringify(finalUsage.cache_creation)
              )
            }

            // 调用一次usageCallback记录合并后的数据
            usageCallback(finalUsage)
          }

          // 提取5小时会话窗口状态
          // 使用大小写不敏感的方式获取响应头
          const get5hStatus = (headers) => {
            if (!headers) {
              return null
            }
            // HTTP头部名称不区分大小写，需要处理不同情况
            return (
              headers['anthropic-ratelimit-unified-5h-status'] ||
              headers['Anthropic-Ratelimit-Unified-5h-Status'] ||
              headers['ANTHROPIC-RATELIMIT-UNIFIED-5H-STATUS']
            )
          }

          const sessionWindowStatus = get5hStatus(res.headers)
          if (sessionWindowStatus) {
            logger.info(`📊 Session window status for account ${accountId}: ${sessionWindowStatus}`)
            // 保存会话窗口状态到账户数据
            await claudeAccountService.updateSessionWindowStatus(accountId, sessionWindowStatus)
          }

          // 处理限流状态
          if (rateLimitDetected || res.statusCode === 429) {
            // 提取限流重置时间戳
            let rateLimitResetTimestamp = null
            if (res.headers && res.headers['anthropic-ratelimit-unified-reset']) {
              rateLimitResetTimestamp = parseInt(res.headers['anthropic-ratelimit-unified-reset'])
              logger.info(
                `🕐 Extracted rate limit reset timestamp from stream: ${rateLimitResetTimestamp} (${new Date(rateLimitResetTimestamp * 1000).toISOString()})`
              )
            }

            // 标记账号为限流状态并删除粘性会话映射
            await unifiedClaudeScheduler.markAccountRateLimited(
              accountId,
              accountType,
              sessionHash,
              rateLimitResetTimestamp
            )
          } else if (res.statusCode === 200) {
            // 请求成功，清除401和500错误计数
            await this.clearUnauthorizedErrors(accountId)
            await claudeAccountService.clearInternalErrors(accountId)
            // 如果请求成功，检查并移除限流状态
            const isRateLimited = await unifiedClaudeScheduler.isAccountRateLimited(
              accountId,
              accountType
            )
            if (isRateLimited) {
              await unifiedClaudeScheduler.removeAccountRateLimit(accountId, accountType)
            }

            // 只有真实的 Claude Code 请求才更新 headers（流式请求）
            if (
              clientHeaders &&
              Object.keys(clientHeaders).length > 0 &&
              this.isRealClaudeCodeRequest(body, clientHeaders)
            ) {
              await claudeCodeHeadersService.storeAccountHeaders(accountId, clientHeaders)
            }
          }

          logger.debug('🌊 Claude stream response with usage capture completed')
          resolve()
        })
      })

      req.on('error', (error) => {
        logger.error('❌ Claude stream request error:', error.message, {
          code: error.code,
          errno: error.errno,
          syscall: error.syscall
        })

        // 根据错误类型提供更具体的错误信息
        let errorMessage = 'Upstream request failed'
        let statusCode = 500
        if (error.code === 'ECONNRESET') {
          errorMessage = 'Connection reset by Claude API server'
          statusCode = 502
        } else if (error.code === 'ENOTFOUND') {
          errorMessage = 'Unable to resolve Claude API hostname'
          statusCode = 502
        } else if (error.code === 'ECONNREFUSED') {
          errorMessage = 'Connection refused by Claude API server'
          statusCode = 502
        } else if (error.code === 'ETIMEDOUT') {
          errorMessage = 'Connection timed out to Claude API server'
          statusCode = 504
        }

        if (!responseStream.headersSent) {
          responseStream.writeHead(statusCode, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive'
          })
        }

        if (!responseStream.destroyed) {
          // 发送 SSE 错误事件
          responseStream.write('event: error\n')
          responseStream.write(
            `data: ${JSON.stringify({
              error: errorMessage,
              code: error.code,
              timestamp: new Date().toISOString()
            })}\n\n`
          )
          responseStream.end()
        }
        reject(error)
      })

      req.on('timeout', () => {
        req.destroy()
        logger.error('❌ Claude stream request timeout')
        if (!responseStream.headersSent) {
          responseStream.writeHead(504, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive'
          })
        }
        if (!responseStream.destroyed) {
          // 发送 SSE 错误事件
          responseStream.write('event: error\n')
          responseStream.write(
            `data: ${JSON.stringify({
              error: 'Request timeout',
              code: 'TIMEOUT',
              timestamp: new Date().toISOString()
            })}\n\n`
          )
          responseStream.end()
        }
        reject(new Error('Request timeout'))
      })

      // 处理客户端断开连接
      responseStream.on('close', () => {
        logger.debug('🔌 Client disconnected, cleaning up stream')
        if (!req.destroyed) {
          req.destroy()
        }
      })

      // 写入请求体
      req.write(JSON.stringify(body))
      req.end()
    })
  }

  // 🌊 发送流式请求到Claude API
  async _makeClaudeStreamRequest(
    body,
    accessToken,
    proxyAgent,
    clientHeaders,
    responseStream,
    requestOptions = {}
  ) {
    return new Promise((resolve, reject) => {
      const url = new URL(this.claudeApiUrl)

      // 获取过滤后的客户端 headers
      const filteredHeaders = this._filterClientHeaders(clientHeaders)

      const options = {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
          'anthropic-version': this.apiVersion,
          ...filteredHeaders
        },
        agent: proxyAgent,
        timeout: config.proxy.timeout
      }

      // 如果客户端没有提供 User-Agent，使用默认值
      if (!filteredHeaders['User-Agent'] && !filteredHeaders['user-agent']) {
        // 第三个方法不支持统一 User-Agent，使用简化逻辑
        const userAgent =
          clientHeaders?.['user-agent'] ||
          clientHeaders?.['User-Agent'] ||
          'claude-cli/1.0.102 (external, cli)'
        options.headers['User-Agent'] = userAgent
      }

      // 使用自定义的 betaHeader 或默认值
      const betaHeader =
        requestOptions?.betaHeader !== undefined ? requestOptions.betaHeader : this.betaHeader
      if (betaHeader) {
        options.headers['anthropic-beta'] = betaHeader
      }

      const req = https.request(options, (res) => {
        // 设置响应头
        responseStream.statusCode = res.statusCode
        Object.keys(res.headers).forEach((key) => {
          responseStream.setHeader(key, res.headers[key])
        })

        // 管道响应数据
        res.pipe(responseStream)

        res.on('end', () => {
          logger.debug('🌊 Claude stream response completed')
          resolve()
        })
      })

      req.on('error', (error) => {
        logger.error('❌ Claude stream request error:', error.message, {
          code: error.code,
          errno: error.errno,
          syscall: error.syscall
        })

        // 根据错误类型提供更具体的错误信息
        let errorMessage = 'Upstream request failed'
        let statusCode = 500
        if (error.code === 'ECONNRESET') {
          errorMessage = 'Connection reset by Claude API server'
          statusCode = 502
        } else if (error.code === 'ENOTFOUND') {
          errorMessage = 'Unable to resolve Claude API hostname'
          statusCode = 502
        } else if (error.code === 'ECONNREFUSED') {
          errorMessage = 'Connection refused by Claude API server'
          statusCode = 502
        } else if (error.code === 'ETIMEDOUT') {
          errorMessage = 'Connection timed out to Claude API server'
          statusCode = 504
        }

        if (!responseStream.headersSent) {
          responseStream.writeHead(statusCode, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive'
          })
        }

        if (!responseStream.destroyed) {
          // 发送 SSE 错误事件
          responseStream.write('event: error\n')
          responseStream.write(
            `data: ${JSON.stringify({
              error: errorMessage,
              code: error.code,
              timestamp: new Date().toISOString()
            })}\n\n`
          )
          responseStream.end()
        }
        reject(error)
      })

      req.on('timeout', () => {
        req.destroy()
        logger.error('❌ Claude stream request timeout')
        if (!responseStream.headersSent) {
          responseStream.writeHead(504, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive'
          })
        }
        if (!responseStream.destroyed) {
          // 发送 SSE 错误事件
          responseStream.write('event: error\n')
          responseStream.write(
            `data: ${JSON.stringify({
              error: 'Request timeout',
              code: 'TIMEOUT',
              timestamp: new Date().toISOString()
            })}\n\n`
          )
          responseStream.end()
        }
        reject(new Error('Request timeout'))
      })

      // 处理客户端断开连接
      responseStream.on('close', () => {
        logger.debug('🔌 Client disconnected, cleaning up stream')
        if (!req.destroyed) {
          req.destroy()
        }
      })

      // 写入请求体
      req.write(JSON.stringify(body))
      req.end()
    })
  }

  // 🔄 重试逻辑
  async _retryRequest(requestFunc, maxRetries = 3) {
    let lastError

    for (let i = 0; i < maxRetries; i++) {
      try {
        return await requestFunc()
      } catch (error) {
        lastError = error

        if (i < maxRetries - 1) {
          const delay = Math.pow(2, i) * 1000 // 指数退避
          logger.warn(`⏳ Retry ${i + 1}/${maxRetries} in ${delay}ms: ${error.message}`)
          await new Promise((resolve) => setTimeout(resolve, delay))
        }
      }
    }

    throw lastError
  }

  // 🔄 账户切换重试逻辑（专用于429限流错误和401未授权错误）
  async _retryWithAccountSwitch(
    originalRequestBody,
    apiKeyData,
    clientRequest,
    clientResponse,
    clientHeaders,
    options = {},
    maxRetries = 2
  ) {
    let lastResponse = null
    let lastError = null
    let originalSessionHash = null

    // 生成会话哈希用于sticky会话
    const sessionHash = sessionHelper.generateSessionHash(originalRequestBody)
    originalSessionHash = sessionHash

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        logger.info(
          `🔄 Account switch retry attempt ${attempt + 1}/${maxRetries + 1} for API key: ${apiKeyData.name}`
        )

        // 在重试时，需要重新选择账户（因为之前的账户已被标记为限流）
        const currentSessionHash = attempt === 0 ? originalSessionHash : null // 首次尝试使用原session，重试时不使用

        const accountSelection = await unifiedClaudeScheduler.selectAccountForApiKey(
          apiKeyData,
          currentSessionHash,
          originalRequestBody.model
        )
        const { accountId } = accountSelection
        const { accountType } = accountSelection

        logger.info(
          `🎯 Retry attempt ${attempt + 1}: Using account ${accountId} (${accountType}) for API key ${apiKeyData.name}`
        )

        // 获取有效的访问token
        const accessToken = await claudeAccountService.getValidAccessToken(accountId)

        // 处理请求体
        const processedBody = this._processRequestBody(originalRequestBody, clientHeaders)

        // 获取代理配置
        const proxyAgent = await this._getProxyAgent(accountId)

        // 使用状态管理避免重试中的竞态条件
        const retryRequestState = {
          upstreamRequest: null,
          clientDisconnected: false
        }

        // 设置客户端断开监听器
        const handleClientDisconnect = () => {
          logger.info('🔌 Client disconnected during retry, marking for cleanup')
          retryRequestState.clientDisconnected = true

          if (retryRequestState.upstreamRequest && !retryRequestState.upstreamRequest.destroyed) {
            logger.info('🔌 Destroying retry upstream request due to client disconnect')
            retryRequestState.upstreamRequest.destroy()
          }
        }

        // 监听客户端断开事件
        if (clientRequest) {
          clientRequest.once('close', handleClientDisconnect)
        }
        if (clientResponse) {
          clientResponse.once('close', handleClientDisconnect)
        }

        // 发送请求到Claude API
        const response = await this._makeClaudeRequest(
          processedBody,
          accessToken,
          proxyAgent,
          clientHeaders,
          accountId,
          (req) => {
            retryRequestState.upstreamRequest = req

            // 如果客户端已经断开，立即销毁请求
            if (retryRequestState.clientDisconnected && req && !req.destroyed) {
              logger.info(
                '🔌 Client already disconnected during retry, destroying upstream request immediately'
              )
              req.destroy()
            }
          },
          options
        )

        // 移除监听器
        if (clientRequest) {
          clientRequest.removeListener('close', handleClientDisconnect)
        }
        if (clientResponse) {
          clientResponse.removeListener('close', handleClientDisconnect)
        }

        // 检查是否仍然是429错误
        if (response.statusCode === 429) {
          let isRateLimited = false
          let rateLimitResetTimestamp = null

          // 提取限流重置时间戳
          if (response.headers && response.headers['anthropic-ratelimit-unified-reset']) {
            rateLimitResetTimestamp = parseInt(
              response.headers['anthropic-ratelimit-unified-reset']
            )
          }

          // 检查响应体中的限流错误
          try {
            const responseBody =
              typeof response.body === 'string' ? JSON.parse(response.body) : response.body
            if (
              responseBody &&
              responseBody.error &&
              responseBody.error.message &&
              responseBody.error.message.toLowerCase().includes("exceed your account's rate limit")
            ) {
              isRateLimited = true
            }
          } catch (e) {
            if (
              response.body &&
              response.body.toLowerCase().includes("exceed your account's rate limit")
            ) {
              isRateLimited = true
            }
          }

          if (response.statusCode === 429 || isRateLimited) {
            logger.warn(
              `🚫 Retry attempt ${attempt + 1}: Account ${accountId} also rate limited (429), marking and trying next account`
            )

            // 标记当前账户为限流状态
            await unifiedClaudeScheduler.markAccountRateLimited(
              accountId,
              accountType,
              currentSessionHash,
              rateLimitResetTimestamp
            )

            // 如果还有重试机会，继续下一次重试
            if (attempt < maxRetries) {
              lastResponse = response

              // 短暂延迟后重试，避免过快重试
              await new Promise((resolve) => setTimeout(resolve, 500))
              continue
            }
          }
        } else if (response.statusCode === 401) {
          // 处理401错误
          logger.warn(
            `🔐 Retry attempt ${attempt + 1}: Unauthorized error (401) for account ${accountId}`
          )

          await this.recordUnauthorizedError(accountId)
          const errorCount = await this.getUnauthorizedErrorCount(accountId)

          if (errorCount >= 3) {
            logger.error(
              `❌ Account ${accountId} exceeded 401 error threshold, marking as unauthorized`
            )
            await unifiedClaudeScheduler.markAccountUnauthorized(
              accountId,
              accountType,
              currentSessionHash
            )
          }

          // 如果还有重试机会，尝试下一个账户
          if (attempt < maxRetries) {
            lastResponse = response
            await new Promise((resolve) => setTimeout(resolve, 500))
            continue
          }
        }

        // 请求成功的情况
        if (response.statusCode === 200 || response.statusCode === 201) {
          // 清除401错误计数
          await this.clearUnauthorizedErrors(accountId)

          // 如果请求成功，检查并移除限流状态
          const isRateLimited = await unifiedClaudeScheduler.isAccountRateLimited(
            accountId,
            accountType
          )
          if (isRateLimited) {
            await unifiedClaudeScheduler.removeAccountRateLimit(accountId, accountType)
          }

          // 只有真实的 Claude Code 请求才更新 headers
          if (
            clientHeaders &&
            Object.keys(clientHeaders).length > 0 &&
            this.isRealClaudeCodeRequest(originalRequestBody, clientHeaders)
          ) {
            await claudeCodeHeadersService.storeAccountHeaders(accountId, clientHeaders)
          }

          // 在响应中添加accountId，以便调用方记录账户级别统计
          response.accountId = accountId

          if (attempt > 0) {
            logger.info(
              `✅ Account switch retry successful after ${attempt + 1} attempts - Key: ${apiKeyData.name}, Final Account: ${accountId}, Model: ${originalRequestBody.model}`
            )
          }

          return response
        }

        // 其他错误情况，记录并准备重试或返回
        lastResponse = response
        if (attempt < maxRetries) {
          logger.warn(
            `⚠️ Retry attempt ${attempt + 1}: Request failed with status ${response.statusCode}, trying next account`
          )
          await new Promise((resolve) => setTimeout(resolve, 500))
        }
      } catch (error) {
        logger.error(`❌ Retry attempt ${attempt + 1} failed with error:`, error.message)
        lastError = error

        if (attempt < maxRetries) {
          await new Promise((resolve) => setTimeout(resolve, 500))
        }
      }
    }

    // 所有重试都失败了，返回最后的响应或抛出错误
    if (lastResponse) {
      logger.error(
        `❌ All account switch retries failed after ${maxRetries + 1} attempts for API key: ${apiKeyData.name}. Final status: ${lastResponse.statusCode}`
      )
      return lastResponse
    }

    if (lastError) {
      logger.error(
        `❌ All account switch retries failed after ${maxRetries + 1} attempts for API key: ${apiKeyData.name} with error: ${lastError.message}`
      )
      throw lastError
    }

    // 理论上不应该到达这里
    throw new Error(`All account switch retries failed for API key: ${apiKeyData.name}`)
  }

  // 🔐 记录401未授权错误
  async recordUnauthorizedError(accountId) {
    try {
      const key = `claude_account:${accountId}:401_errors`

      // 增加错误计数，设置5分钟过期时间
      await redis.client.incr(key)
      await redis.client.expire(key, 300) // 5分钟

      logger.info(`📝 Recorded 401 error for account ${accountId}`)
    } catch (error) {
      logger.error(`❌ Failed to record 401 error for account ${accountId}:`, error)
    }
  }

  // 🔍 获取401错误计数
  async getUnauthorizedErrorCount(accountId) {
    try {
      const key = `claude_account:${accountId}:401_errors`

      const count = await redis.client.get(key)
      return parseInt(count) || 0
    } catch (error) {
      logger.error(`❌ Failed to get 401 error count for account ${accountId}:`, error)
      return 0
    }
  }

  // 🧹 清除401错误计数
  async clearUnauthorizedErrors(accountId) {
    try {
      const key = `claude_account:${accountId}:401_errors`

      await redis.client.del(key)
      logger.info(`✅ Cleared 401 error count for account ${accountId}`)
    } catch (error) {
      logger.error(`❌ Failed to clear 401 errors for account ${accountId}:`, error)
    }
  }

  // 🔧 动态捕获并获取统一的 User-Agent
  async captureAndGetUnifiedUserAgent(clientHeaders, account) {
    if (account.useUnifiedUserAgent !== 'true') {
      return null
    }

    const CACHE_KEY = 'claude_code_user_agent:daily'
    const TTL = 90000 // 25小时

    // ⚠️ 重要：这里通过正则表达式判断是否为 Claude Code 客户端
    // 如果未来 Claude Code 的 User-Agent 格式发生变化，需要更新这个正则表达式
    // 当前已知格式：claude-cli/1.0.102 (external, cli)
    const CLAUDE_CODE_UA_PATTERN = /^claude-cli\/[\d.]+\s+\(/i

    const clientUA = clientHeaders?.['user-agent'] || clientHeaders?.['User-Agent']
    let cachedUA = await redis.client.get(CACHE_KEY)

    if (clientUA && CLAUDE_CODE_UA_PATTERN.test(clientUA)) {
      if (!cachedUA) {
        // 没有缓存，直接存储
        await redis.client.setex(CACHE_KEY, TTL, clientUA)
        logger.info(`📱 Captured unified Claude Code User-Agent: ${clientUA}`)
        cachedUA = clientUA
      } else {
        // 有缓存，比较版本号，保存更新的版本
        const shouldUpdate = this.compareClaudeCodeVersions(clientUA, cachedUA)
        if (shouldUpdate) {
          await redis.client.setex(CACHE_KEY, TTL, clientUA)
          logger.info(`🔄 Updated to newer Claude Code User-Agent: ${clientUA} (was: ${cachedUA})`)
          cachedUA = clientUA
        } else {
          // 当前版本不比缓存版本新，仅刷新TTL
          await redis.client.expire(CACHE_KEY, TTL)
        }
      }
    }

    return cachedUA // 没有缓存返回 null
  }

  // 🔄 比较Claude Code版本号，判断是否需要更新
  // 返回 true 表示 newUA 版本更新，需要更新缓存
  compareClaudeCodeVersions(newUA, cachedUA) {
    try {
      // 提取版本号：claude-cli/1.0.102 (external, cli) -> 1.0.102
      // 支持多段版本号格式，如 1.0.102、2.1.0.beta1 等
      const newVersionMatch = newUA.match(/claude-cli\/([\d.]+(?:[a-zA-Z0-9-]*)?)/i)
      const cachedVersionMatch = cachedUA.match(/claude-cli\/([\d.]+(?:[a-zA-Z0-9-]*)?)/i)

      if (!newVersionMatch || !cachedVersionMatch) {
        // 无法解析版本号，优先使用新的
        logger.warn(`⚠️ Unable to parse Claude Code versions: new=${newUA}, cached=${cachedUA}`)
        return true
      }

      const newVersion = newVersionMatch[1]
      const cachedVersion = cachedVersionMatch[1]

      // 比较版本号 (semantic version)
      const compareResult = this.compareSemanticVersions(newVersion, cachedVersion)

      logger.debug(`🔍 Version comparison: ${newVersion} vs ${cachedVersion} = ${compareResult}`)

      return compareResult > 0 // 新版本更大则返回 true
    } catch (error) {
      logger.warn(`⚠️ Error comparing Claude Code versions, defaulting to update: ${error.message}`)
      return true // 出错时优先使用新的
    }
  }

  // 🔢 比较版本号
  // 返回：1 表示 v1 > v2，-1 表示 v1 < v2，0 表示相等
  compareSemanticVersions(version1, version2) {
    // 将版本号字符串按"."分割成数字数组
    const arr1 = version1.split('.')
    const arr2 = version2.split('.')

    // 获取两个版本号数组中的最大长度
    const maxLength = Math.max(arr1.length, arr2.length)

    // 循环遍历，逐段比较版本号
    for (let i = 0; i < maxLength; i++) {
      // 如果某个版本号的某一段不存在，则视为0
      const num1 = parseInt(arr1[i] || 0, 10)
      const num2 = parseInt(arr2[i] || 0, 10)

      if (num1 > num2) {
        return 1 // version1 大于 version2
      }
      if (num1 < num2) {
        return -1 // version1 小于 version2
      }
    }

    return 0 // 两个版本号相等
  }

  // 🎯 健康检查
  async healthCheck() {
    try {
      const accounts = await claudeAccountService.getAllAccounts()
      const activeAccounts = accounts.filter((acc) => acc.isActive && acc.status === 'active')

      return {
        healthy: activeAccounts.length > 0,
        activeAccounts: activeAccounts.length,
        totalAccounts: accounts.length,
        timestamp: new Date().toISOString()
      }
    } catch (error) {
      logger.error('❌ Health check failed:', error)
      return {
        healthy: false,
        error: error.message,
        timestamp: new Date().toISOString()
      }
    }
  }
}

module.exports = new ClaudeRelayService()
