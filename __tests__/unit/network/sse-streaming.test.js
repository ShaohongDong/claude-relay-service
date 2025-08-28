// SSE流式响应测试 - 简化版本，专注于SSE解析逻辑
const { EventEmitter } = require('events')

/**
 * 简化SSE解析器 - 只处理解析逻辑，不涉及HTTP
 */
class SimpleSSEParser extends EventEmitter {
  constructor() {
    super()
    this.events = []
    this.buffer = ''
    this.currentEvent = {}
  }

  /**
   * 处理SSE数据块
   */
  processChunk(chunk) {
    this.buffer += chunk
    const lines = this.buffer.split('\n')
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
      if (this.currentEvent.data) {
        const event = { ...this.currentEvent }
        this.events.push(event)
        this.emit('event', event)
        this.currentEvent = {}
      }
      return
    }

    if (line.startsWith('data: ')) {
      const data = line.slice(6)
      if (this.currentEvent.data) {
        this.currentEvent.data += '\n' + data
      } else {
        this.currentEvent.data = data
      }
    } else if (line.startsWith('event: ')) {
      this.currentEvent.event = line.slice(7)
    } else if (line.startsWith('id: ')) {
      this.currentEvent.id = line.slice(4)
    }
  }

  /**
   * 直接处理完整SSE数据
   */
  processData(sseText) {
    const lines = sseText.split('\n')
    for (const line of lines) {
      this.processLine(line)
    }
    return this.events
  }

  /**
   * 清理资源
   */
  cleanup() {
    this.events = []
    this.buffer = ''
    this.currentEvent = {}
  }
}

describe('🌊 SSE流式响应解析测试（简化框架）', () => {
  let parser

  beforeEach(() => {
    parser = new SimpleSSEParser()
  })

  afterEach(() => {
    if (parser) {
      parser.cleanup()
      parser = null
    }
  })

  describe('🎯 基础SSE解析功能', () => {
    it('应该正确解析Claude SSE事件序列', () => {
      const sseData = [
        'data: {"type":"message_start","message":{"id":"msg_test","type":"message","role":"assistant","model":"claude-3-5-sonnet-20241022"}}',
        '',
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
        '',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}',
        '',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" world"}}',
        '',
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":50}}',
        '',
        'data: {"type":"message_stop"}',
        '',
        ''
      ].join('\n')

      const receivedEvents = []
      parser.on('event', (event) => {
        receivedEvents.push(event)
      })

      parser.processData(sseData)

      // 验证解析结果
      expect(receivedEvents.length).toBeGreaterThan(0)
      
      // 验证事件类型
      const eventTypes = receivedEvents.map(event => {
        try {
          return JSON.parse(event.data).type
        } catch {
          return null
        }
      }).filter(Boolean)
      
      expect(eventTypes).toContain('message_start')
      expect(eventTypes).toContain('content_block_delta')
      expect(eventTypes).toContain('message_stop')
      
      // 验证usage数据提取
      const usageEvent = receivedEvents.find(event => {
        try {
          const data = JSON.parse(event.data)
          return data.type === 'message_delta' && data.usage
        } catch {
          return false
        }
      })
      
      expect(usageEvent).toBeDefined()
      if (usageEvent) {
        const usageData = JSON.parse(usageEvent.data)
        expect(usageData.usage.output_tokens).toBe(50)
      }
    })

    it('应该从SSE流中准确提取token使用统计', () => {
      const expectedTokens = 123
      
      const sseData = [
        'data: {"type":"message_start","message":{"id":"msg_usage","type":"message","role":"assistant","model":"claude-3-5-sonnet-20241022"}}',
        '',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Test"}}',
        '',
        `data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":${expectedTokens}}}`,
        '',
        'data: {"type":"message_stop"}',
        '',
        ''
      ].join('\n')

      let extractedTokens = 0
      
      parser.on('event', (event) => {
        try {
          const data = JSON.parse(event.data)
          if (data.type === 'message_delta' && data.usage && data.usage.output_tokens) {
            extractedTokens = data.usage.output_tokens
          }
        } catch (error) {
          // 忽略解析错误
        }
      })

      parser.processData(sseData)

      // 验证token提取
      expect(extractedTokens).toBe(expectedTokens)
    })
  })

  describe('🔧 SSE解析器健壮性测试', () => {
    it('应该处理格式错误的SSE数据', () => {
      const malformedSSE = [
        'data: invalid json {',
        '',
        'malformed line without prefix',
        '',
        'data: {"type":"valid_event","message":"test"}',
        '',
        ''
      ].join('\n')

      const receivedEvents = []
      const errors = []
      
      parser.on('event', (event) => {
        receivedEvents.push(event)
      })

      parser.on('error', (error) => {
        errors.push(error)
      })

      parser.processData(malformedSSE)

      // 应该至少解析出一个有效事件
      const validEvents = receivedEvents.filter(event => {
        try {
          JSON.parse(event.data)
          return true
        } catch {
          return false
        }
      })

      expect(validEvents.length).toBeGreaterThan(0)
    })

    it('应该处理分片的SSE数据', () => {
      const chunks = [
        'data: {"type":"me',
        'ssage_start","message":{"id":"test"}}',
        '\n\n',
        'data: {"type":"content_block',
        '_delta","delta":{"text":"hello"}}',
        '\n\n'
      ]

      const receivedEvents = []
      
      parser.on('event', (event) => {
        receivedEvents.push(event)
      })

      // 逐块处理数据
      for (const chunk of chunks) {
        parser.processChunk(chunk)
      }

      // 验证能正确重组分片数据
      expect(receivedEvents.length).toBe(2)
      
      const firstEvent = JSON.parse(receivedEvents[0].data)
      expect(firstEvent.type).toBe('message_start')
      expect(firstEvent.message.id).toBe('test')
      
      const secondEvent = JSON.parse(receivedEvents[1].data)
      expect(secondEvent.type).toBe('content_block_delta')
      expect(secondEvent.delta.text).toBe('hello')
    })
  })

  describe('⚡ 性能和边界条件测试', () => {
    it('应该处理大量并发事件', () => {
      const eventCount = 100
      const sseLines = []
      
      for (let i = 0; i < eventCount; i++) {
        sseLines.push(`data: {"type":"test_event","index":${i},"data":"test_${i}"}`)
        sseLines.push('')
      }
      
      const sseData = sseLines.join('\n')
      const receivedEvents = []
      
      parser.on('event', (event) => {
        receivedEvents.push(event)
      })

      const startTime = Date.now()
      parser.processData(sseData)
      const duration = Date.now() - startTime

      expect(receivedEvents.length).toBe(eventCount)
      expect(duration).toBeLessThan(100) // 应该在100ms内完成
      
      // 验证事件顺序
      for (let i = 0; i < eventCount; i++) {
        const eventData = JSON.parse(receivedEvents[i].data)
        expect(eventData.index).toBe(i)
      }
    })

    it('应该正确处理空数据和边界情况', () => {
      const testCases = [
        '', // 空字符串
        '\n\n\n', // 只有换行
        'data: \n\n', // 空data
        'event: test\ndata: {"type":"test"}\n\n', // 带event字段
        'id: 123\ndata: {"type":"test"}\n\n' // 带id字段
      ]

      for (const testCase of testCases) {
        parser.cleanup() // 重置parser
        const events = []
        
        parser.on('event', (event) => {
          events.push(event)
        })

        expect(() => {
          parser.processData(testCase)
        }).not.toThrow()
      }
    })
  })
})