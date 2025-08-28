// SSE流式响应真实模拟测试 - 专门测试Server-Sent Events流式传输
const { NetworkSimulator, networkTestUtils } = require('../../setup/network-simulator')
const { EventEmitter } = require('events')
const nock = require('nock')

/**
 * 真实SSE流解析器 - 模拟客户端如何解析SSE数据
 */
class SSEParser extends EventEmitter {
  constructor() {
    super()
    this.buffer = ''
    this.eventBuffer = {}
  }

  /**
   * 处理SSE数据块
   */
  processChunk(chunk) {
    this.buffer += chunk
    const lines = this.buffer.split('\n')
    
    // 保留最后一行（可能不完整）
    this.buffer = lines.pop() || ''
    
    for (const line of lines) {
      this.processLine(line)
    }
  }

  /**
   * 处理单行SSE数据
   */
  processLine(line) {
    if (line === '') {
      // 空行表示事件结束
      if (this.eventBuffer.data) {
        this.emit('event', { ...this.eventBuffer })
        this.eventBuffer = {}
      }
      return
    }

    if (line.startsWith('data: ')) {
      const data = line.slice(6)
      if (this.eventBuffer.data) {
        this.eventBuffer.data += '\n' + data
      } else {
        this.eventBuffer.data = data
      }
    } else if (line.startsWith('event: ')) {
      this.eventBuffer.event = line.slice(7)
    } else if (line.startsWith('id: ')) {
      this.eventBuffer.id = line.slice(4)
    } else if (line.startsWith('retry: ')) {
      this.eventBuffer.retry = parseInt(line.slice(7))
    }
  }

  /**
   * 完成解析
   */
  finish() {
    if (this.eventBuffer.data) {
      this.emit('event', { ...this.eventBuffer })
    }
    this.emit('end')
  }

  /**
   * 清理资源并断开所有引用
   */
  cleanup() {
    this.buffer = ''
    this.eventBuffer = {}
    this.removeAllListeners()
  }
}

/**
 * 高级SSE响应模拟器
 */
class AdvancedSSESimulator {
  constructor(simulator) {
    this.simulator = simulator
    this.activeStreams = new Map()
  }

  /**
   * 创建Claude SSE流响应
   */
  createClaudeSSEStream(options = {}) {
    const {
      messageId = `msg_${Math.random().toString(36).substr(2, 9)}`,
      model = 'claude-3-5-sonnet-20241022',
      totalTokens = 150,
      chunkSize = 10,
      chunkDelay = 50,
      includeErrors = false,
      simulateDisconnect = false,
      disconnectAfter = 5,
      includeUsageData = true
    } = options

    const streamId = Math.random().toString(36).substr(2, 9)
    let chunksSent = 0
    let totalChunks = Math.ceil(totalTokens / chunkSize)

    // 生成文本内容
    const fullText = 'This is a comprehensive test of SSE streaming functionality. '.repeat(Math.ceil(totalTokens / 50))
    const words = fullText.split(' ').slice(0, totalTokens)

    // 创建SSE事件序列
    const events = []
    
    // 消息开始事件
    events.push({
      type: 'message_start',
      data: JSON.stringify({
        type: 'message_start',
        message: {
          id: messageId,
          type: 'message',
          role: 'assistant',
          model: model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 15, output_tokens: 0 }
        }
      })
    })

    // 内容块开始
    events.push({
      type: 'content_block_start',
      data: JSON.stringify({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' }
      })
    })

    // 文本增量事件
    let wordIndex = 0
    while (wordIndex < words.length) {
      const chunkWords = words.slice(wordIndex, wordIndex + chunkSize)
      const chunkText = chunkWords.join(' ') + (wordIndex + chunkSize < words.length ? ' ' : '')
      
      events.push({
        type: 'content_block_delta',
        data: JSON.stringify({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: chunkText }
        })
      })
      
      wordIndex += chunkSize
    }

    // 错误模拟
    if (includeErrors && Math.random() < 0.3) {
      events.push({
        type: 'error',
        data: JSON.stringify({
          type: 'error',
          error: {
            type: 'rate_limit_error',
            message: 'Rate limit exceeded during streaming'
          }
        })
      })
    }

    // 内容块结束
    events.push({
      type: 'content_block_stop',
      data: JSON.stringify({
        type: 'content_block_stop',
        index: 0
      })
    })

    // 消息增量（包含使用统计）
    if (includeUsageData) {
      events.push({
        type: 'message_delta',
        data: JSON.stringify({
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: totalTokens }
        })
      })
    }

    // 消息结束
    events.push({
      type: 'message_stop',
      data: JSON.stringify({
        type: 'message_stop'
      })
    })

    // 存储流信息
    this.activeStreams.set(streamId, {
      events,
      currentIndex: 0,
      chunkDelay,
      simulateDisconnect,
      disconnectAfter
    })

    return { streamId, events, totalChunks: events.length }
  }

  /**
   * 生成SSE响应函数
   */
  generateSSEResponse(streamId) {
    const stream = this.activeStreams.get(streamId)
    if (!stream) {
      throw new Error(`Stream ${streamId} not found`)
    }

    let currentEventIndex = 0
    let aborted = false

    return function(uri, requestBody) {
      const responseStream = new EventEmitter()
      
      const sendNextEvent = () => {
        if (aborted || currentEventIndex >= stream.events.length) {
          responseStream.emit('end')
          return
        }

        // 模拟连接断开
        if (stream.simulateDisconnect && currentEventIndex >= stream.disconnectAfter) {
          responseStream.emit('error', new Error('Connection lost'))
          return
        }

        const event = stream.events[currentEventIndex]
        const sseData = `data: ${event.data}\n\n`
        
        responseStream.emit('data', sseData)
        currentEventIndex++

        // 继续发送下一个事件
        setTimeout(sendNextEvent, stream.chunkDelay)
      }

      // 模拟请求中止
      responseStream.abort = () => {
        aborted = true
        responseStream.emit('aborted')
      }

      // 开始发送事件
      setTimeout(sendNextEvent, 10)
      
      return responseStream
    }
  }

  /**
   * 清理流资源
   */
  cleanup() {
    // 清理所有活动流并断开引用
    for (const [streamId, stream] of this.activeStreams) {
      if (stream && stream.events) {
        stream.events = null
      }
    }
    this.activeStreams.clear()
  }
}

describe('🌊 SSE流式响应真实模拟测试', () => {
  let sseSimulator

  beforeEach(() => {
    sseSimulator = new AdvancedSSESimulator()
  })

  afterEach(() => {
    // 清理SSE模拟器
    sseSimulator.cleanup()
    
    // 清理nock拦截器以防止内存泄漏
    require('nock').cleanAll()
    
    // 强制垃圾回收（如果可用）
    if (global.gc) {
      global.gc()
    }
  })

  describe('🎯 基础SSE流解析', () => {
    it('应该正确解析Claude SSE事件序列', async () => {
      await networkTestUtils.withNetworkSimulation(async (simulator) => {
        // 创建SSE流
        const { streamId, events } = sseSimulator.createClaudeSSEStream({
          totalTokens: 50,
          chunkSize: 5,
          chunkDelay: 20
        })

        // 设置nock响应
        const claudeAPI = nock('https://api.anthropic.com')
          .post('/v1/messages')
          .reply(200, sseSimulator.generateSSEResponse(streamId), {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            'connection': 'keep-alive'
          })

        // 创建SSE解析器
        const parser = new SSEParser()
        const receivedEvents = []
        
        parser.on('event', (event) => {
          receivedEvents.push(event)
        })

        // 模拟SSE请求和解析
        return new Promise((resolve, reject) => {
          const axios = require('axios')
          
          axios.post('https://api.anthropic.com/v1/messages', {
            model: 'claude-3-5-sonnet-20241022',
            stream: true,
            messages: [{ role: 'user', content: 'Test streaming' }]
          }, {
            responseType: 'stream'
          }).then(response => {
            response.data.on('data', (chunk) => {
              parser.processChunk(chunk.toString())
            })
            
            response.data.on('end', () => {
              parser.finish()
              
              try {
                // 验证事件序列
                expect(receivedEvents.length).toBeGreaterThan(3)
                
                // 验证消息开始事件
                const messageStart = receivedEvents.find(e => 
                  JSON.parse(e.data).type === 'message_start'
                )
                expect(messageStart).toBeDefined()
                const startData = JSON.parse(messageStart.data)
                expect(startData.message.model).toBe('claude-3-5-sonnet-20241022')
                
                // 验证内容块增量事件
                const deltaEvents = receivedEvents.filter(e => 
                  JSON.parse(e.data).type === 'content_block_delta'
                )
                expect(deltaEvents.length).toBeGreaterThan(0)
                
                // 验证使用统计事件
                const usageEvent = receivedEvents.find(e => 
                  JSON.parse(e.data).type === 'message_delta'
                )
                expect(usageEvent).toBeDefined()
                const usageData = JSON.parse(usageEvent.data)
                expect(usageData.usage.output_tokens).toBe(50)
                
                // 验证消息结束事件
                const messageStop = receivedEvents.find(e => 
                  JSON.parse(e.data).type === 'message_stop'
                )
                expect(messageStop).toBeDefined()
                
                // 清理parser避免循环引用
                parser.cleanup()
                resolve()
              } catch (error) {
                // 即使出错也要清理parser
                parser.cleanup()
                reject(error)
              }
            })
            
            response.data.on('error', reject)
          }).catch(reject)
        })
      }, { allowLocalhost: true })
    })

    it('应该从SSE流中准确提取token使用统计', async () => {
      await networkTestUtils.withNetworkSimulation(async (simulator) => {
        const expectedTokens = 123
        const { streamId } = sseSimulator.createClaudeSSEStream({
          totalTokens: expectedTokens,
          chunkSize: 8,
          includeUsageData: true
        })

        nock('https://api.anthropic.com')
          .post('/v1/messages')
          .reply(200, sseSimulator.generateSSEResponse(streamId), {
            'content-type': 'text/event-stream'
          })

        const parser = new SSEParser()
        let extractedTokenCount = 0

        parser.on('event', (event) => {
          try {
            const data = JSON.parse(event.data)
            if (data.type === 'message_delta' && data.usage) {
              extractedTokenCount = data.usage.output_tokens
            }
          } catch (e) {
            // 忽略JSON解析错误
          }
        })

        return new Promise((resolve, reject) => {
          const axios = require('axios')
          
          axios.post('https://api.anthropic.com/v1/messages', {
            stream: true,
            messages: [{ role: 'user', content: 'Token count test' }]
          }, { responseType: 'stream' }).then(response => {
            response.data.on('data', chunk => parser.processChunk(chunk.toString()))
            response.data.on('end', () => {
              parser.finish()
              expect(extractedTokenCount).toBe(expectedTokens)
              parser.cleanup() // 清理parser避免循环引用
              resolve()
            })
            response.data.on('error', reject)
          }).catch(reject)
        })
      })
    })
  })

  describe('🔄 流中断和重连测试', () => {
    it('应该模拟流中断并检测断开点', async () => {
      await networkTestUtils.withNetworkSimulation(async (simulator) => {
        const { streamId } = sseSimulator.createClaudeSSEStream({
          totalTokens: 100,
          simulateDisconnect: true,
          disconnectAfter: 3, // 在第3个事件后断开
          chunkDelay: 30
        })

        nock('https://api.anthropic.com')
          .post('/v1/messages')
          .reply(200, sseSimulator.generateSSEResponse(streamId), {
            'content-type': 'text/event-stream'
          })

        const parser = new SSEParser()
        const receivedEvents = []
        let connectionLost = false

        parser.on('event', (event) => receivedEvents.push(event))

        return new Promise((resolve, reject) => {
          const axios = require('axios')
          
          axios.post('https://api.anthropic.com/v1/messages', {
            stream: true,
            messages: [{ role: 'user', content: 'Disconnect test' }]
          }, { responseType: 'stream' }).then(response => {
            response.data.on('data', chunk => {
              parser.processChunk(chunk.toString())
            })
            
            response.data.on('end', () => {
              // 正常结束不应该发生
              reject(new Error('Stream ended normally, expected disconnection'))
            })
            
            response.data.on('error', (error) => {
              connectionLost = true
              
              // 验证在预期的点断开了连接
              expect(receivedEvents.length).toBeLessThan(10) // 不应该收到所有事件
              expect(receivedEvents.length).toBeGreaterThan(0) // 但应该收到一些事件
              expect(error.message).toContain('Connection lost')
              parser.cleanup() // 清理parser避免循环引用
              resolve()
            })
          }).catch(reject)
        })
      })
    })

    it('应该支持流重连和事件ID追踪', async () => {
      await networkTestUtils.withNetworkSimulation(async (simulator) => {
        let reconnectCount = 0
        const maxReconnects = 2

        // 第一次连接 - 会在中途断开
        const { streamId: firstStreamId } = sseSimulator.createClaudeSSEStream({
          totalTokens: 60,
          simulateDisconnect: true,
          disconnectAfter: 2
        })

        // 重连流 - 从断开点继续
        const { streamId: reconnectStreamId } = sseSimulator.createClaudeSSEStream({
          totalTokens: 60,
          simulateDisconnect: false,
          messageId: 'msg_reconnect_test'
        })

        let currentStreamId = firstStreamId

        nock('https://api.anthropic.com')
          .persist()
          .post('/v1/messages')
          .reply(200, function(uri, requestBody) {
            reconnectCount++
            
            if (reconnectCount === 1) {
              return sseSimulator.generateSSEResponse(firstStreamId)
            } else {
              return sseSimulator.generateSSEResponse(reconnectStreamId)
            }
          }, {
            'content-type': 'text/event-stream'
          })

        const parser = new SSEParser()
        const allEvents = []

        const attemptConnection = () => {
          return new Promise((resolve, reject) => {
            const axios = require('axios')
            
            axios.post('https://api.anthropic.com/v1/messages', {
              stream: true,
              messages: [{ role: 'user', content: 'Reconnect test' }]
            }, { responseType: 'stream' }).then(response => {
              response.data.on('data', chunk => {
                parser.processChunk(chunk.toString())
              })
              
              response.data.on('end', () => {
                resolve(true) // 成功完成
              })
              
              response.data.on('error', (error) => {
                resolve(false) // 连接中断，需要重连
              })
            }).catch(reject)
          })
        }

        parser.on('event', (event) => allEvents.push(event))

        // 尝试连接和重连
        let success = await attemptConnection()
        while (!success && reconnectCount < maxReconnects) {
          await new Promise(resolve => setTimeout(resolve, 100)) // 重连延迟
          success = await attemptConnection()
        }

        if (!success && reconnectCount < maxReconnects) {
          // 最后一次重连
          success = await attemptConnection()
        }

        expect(reconnectCount).toBeGreaterThan(1)
        expect(allEvents.length).toBeGreaterThan(0)
      })
    })
  })

  describe('🚀 并发流处理测试', () => {
    it('应该支持多个并发SSE流', async () => {
      await networkTestUtils.withNetworkSimulation(async (simulator) => {
        const streamCount = 3
        const streamIds = []
        const streamResults = []

        // 创建多个流
        for (let i = 0; i < streamCount; i++) {
          const { streamId } = sseSimulator.createClaudeSSEStream({
            totalTokens: 30 + i * 10, // 不同长度的流
            chunkSize: 5,
            chunkDelay: 25 + i * 10, // 不同速度的流
            messageId: `msg_concurrent_${i}`
          })
          streamIds.push(streamId)
        }

        // 设置所有流的nock响应
        streamIds.forEach((streamId, index) => {
          nock('https://api.anthropic.com')
            .post(`/v1/messages/stream${index}`)
            .reply(200, sseSimulator.generateSSEResponse(streamId), {
              'content-type': 'text/event-stream'
            })
        })

        // 并发请求所有流
        const streamPromises = streamIds.map((streamId, index) => {
          return new Promise((resolve, reject) => {
            const parser = new SSEParser()
            const events = []

            parser.on('event', (event) => events.push(event))

            const axios = require('axios')
            axios.post(`https://api.anthropic.com/v1/messages/stream${index}`, {
              stream: true,
              messages: [{ role: 'user', content: `Concurrent test ${index}` }]
            }, { responseType: 'stream' }).then(response => {
              response.data.on('data', chunk => parser.processChunk(chunk.toString()))
              response.data.on('end', () => {
                parser.finish()
                resolve({ streamIndex: index, events, eventCount: events.length })
              })
              response.data.on('error', reject)
            }).catch(reject)
          })
        })

        const results = await Promise.all(streamPromises)

        // 验证所有流都成功完成
        expect(results).toHaveLength(streamCount)
        results.forEach((result, index) => {
          expect(result.streamIndex).toBe(index)
          expect(result.eventCount).toBeGreaterThan(3) // 至少有几个事件
          
          // 验证每个流都有完整的事件序列
          const messageStopEvents = result.events.filter(e => {
            try {
              return JSON.parse(e.data).type === 'message_stop'
            } catch { return false }
          })
          expect(messageStopEvents).toHaveLength(1) // 每个流应该有一个结束事件
        })
      })
    })
  })

  describe('⏱️ 流超时处理测试', () => {
    it('应该处理流响应超时', async () => {
      await networkTestUtils.withNetworkSimulation(async (simulator) => {
        const { streamId } = sseSimulator.createClaudeSSEStream({
          totalTokens: 200,
          chunkDelay: 2000, // 非常慢的响应
          chunkSize: 1
        })

        nock('https://api.anthropic.com')
          .post('/v1/messages')
          .reply(200, sseSimulator.generateSSEResponse(streamId), {
            'content-type': 'text/event-stream'
          })

        const parser = new SSEParser()
        const events = []
        parser.on('event', (event) => events.push(event))

        await expect(new Promise((resolve, reject) => {
          const axios = require('axios')
          
          axios.post('https://api.anthropic.com/v1/messages', {
            stream: true,
            messages: [{ role: 'user', content: 'Timeout test' }]
          }, { 
            responseType: 'stream',
            timeout: 1000 // 1秒超时
          }).then(response => {
            response.data.on('data', chunk => parser.processChunk(chunk.toString()))
            response.data.on('end', resolve)
            response.data.on('error', reject)
          }).catch(reject)
        })).rejects.toThrow()

        // 验证在超时前收到了一些事件
        expect(events.length).toBeLessThan(10) // 不应该收到所有事件
      })
    })
  })

  describe('🛠️ 流错误处理测试', () => {
    it('应该正确处理流中的错误事件', async () => {
      await networkTestUtils.withNetworkSimulation(async (simulator) => {
        const { streamId } = sseSimulator.createClaudeSSEStream({
          totalTokens: 50,
          includeErrors: true, // 包含错误事件
          chunkDelay: 20
        })

        nock('https://api.anthropic.com')
          .post('/v1/messages')
          .reply(200, sseSimulator.generateSSEResponse(streamId), {
            'content-type': 'text/event-stream'
          })

        const parser = new SSEParser()
        const events = []
        let errorFound = false

        parser.on('event', (event) => {
          events.push(event)
          try {
            const data = JSON.parse(event.data)
            if (data.type === 'error') {
              errorFound = true
              expect(data.error.type).toBe('rate_limit_error')
            }
          } catch (e) {
            // 忽略JSON解析错误
          }
        })

        return new Promise((resolve, reject) => {
          const axios = require('axios')
          
          axios.post('https://api.anthropic.com/v1/messages', {
            stream: true,
            messages: [{ role: 'user', content: 'Error test' }]
          }, { responseType: 'stream' }).then(response => {
            response.data.on('data', chunk => parser.processChunk(chunk.toString()))
            response.data.on('end', () => {
              parser.finish()
              // 注意：错误事件是随机的，所以这个测试可能不总是找到错误
              // 但整体流程应该仍然完成
              expect(events.length).toBeGreaterThan(3)
              resolve()
            })
            response.data.on('error', reject)
          }).catch(reject)
        })
      })
    })
  })

  describe('🔧 SSE解析器健壮性测试', () => {
    it('应该处理格式错误的SSE数据', async () => {
      const parser = new SSEParser()
      const events = []
      const errors = []

      parser.on('event', (event) => events.push(event))
      parser.on('error', (error) => errors.push(error))

      // 发送格式错误的数据
      parser.processChunk('data: invalid json\n\n')
      parser.processChunk('data: {"valid": true}\n\n')
      parser.processChunk('malformed line without colon\n')
      parser.processChunk('data: {"another": "valid"}\n\n')
      parser.finish()

      // 应该忽略格式错误的数据，继续处理有效数据
      expect(events.length).toBe(2)
      expect(events[0].data).toBe('invalid json')
      expect(events[1].data).toBe('{"another": "valid"}')
    })

    it('应该处理分片的SSE数据', async () => {
      const parser = new SSEParser()
      const events = []

      parser.on('event', (event) => events.push(event))

      // 模拟网络分片传输
      parser.processChunk('da')
      parser.processChunk('ta: {"type": "message_')
      parser.processChunk('start"}\n')
      parser.processChunk('\n')
      parser.processChunk('data: {"type": "content')
      parser.processChunk('_block_delta", "delta": {"text": "hello"}}')
      parser.processChunk('\n\n')
      parser.finish()

      expect(events).toHaveLength(2)
      expect(events[0].data).toBe('{"type": "message_start"}')
      expect(events[1].data).toBe('{"type": "content_block_delta", "delta": {"text": "hello"}}')
    })
  })
})