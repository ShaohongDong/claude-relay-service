// Redis 模拟对象
class RedisMock {
  constructor() {
    this.data = new Map()
    this.hashes = new Map()
    this.lists = new Map()
    this.sets = new Map()
    this.ttls = new Map()
  }

  // 基本字符串操作
  async get(key) {
    if (this.ttls.has(key) && this.ttls.get(key) < Date.now()) {
      this.data.delete(key)
      this.ttls.delete(key)
      return null
    }
    return this.data.get(key) || null
  }

  async set(key, value, ...args) {
    this.data.set(key, value)
    
    // 处理 EX 参数 (秒)
    const exIndex = args.indexOf('EX')
    if (exIndex !== -1 && args[exIndex + 1]) {
      const seconds = parseInt(args[exIndex + 1])
      this.ttls.set(key, Date.now() + seconds * 1000)
    }
    
    // 处理 PX 参数 (毫秒)
    const pxIndex = args.indexOf('PX')
    if (pxIndex !== -1 && args[pxIndex + 1]) {
      const milliseconds = parseInt(args[pxIndex + 1])
      this.ttls.set(key, Date.now() + milliseconds)
    }
    
    return 'OK'
  }

  async setex(key, seconds, value) {
    this.data.set(key, value)
    this.ttls.set(key, Date.now() + seconds * 1000)
    return 'OK'
  }

  async del(...keys) {
    let count = 0
    keys.forEach(key => {
      if (this.data.delete(key)) count++
      this.ttls.delete(key)
      this.hashes.delete(key)
      this.lists.delete(key)
      this.sets.delete(key)
    })
    return count
  }

  async exists(...keys) {
    return keys.filter(key => this.data.has(key) || this.hashes.has(key)).length
  }

  async expire(key, seconds) {
    if (this.data.has(key) || this.hashes.has(key)) {
      this.ttls.set(key, Date.now() + seconds * 1000)
      return 1
    }
    return 0
  }

  async ttl(key) {
    if (this.ttls.has(key)) {
      const remaining = Math.ceil((this.ttls.get(key) - Date.now()) / 1000)
      return remaining > 0 ? remaining : -2
    }
    return this.data.has(key) || this.hashes.has(key) ? -1 : -2
  }

  // 哈希操作
  async hget(key, field) {
    const hash = this.hashes.get(key)
    return hash ? hash.get(field) || null : null
  }

  async hset(key, field, value) {
    if (!this.hashes.has(key)) {
      this.hashes.set(key, new Map())
    }
    const hash = this.hashes.get(key)
    const isNew = !hash.has(field)
    hash.set(field, value)
    return isNew ? 1 : 0
  }

  async hmset(key, ...args) {
    if (!this.hashes.has(key)) {
      this.hashes.set(key, new Map())
    }
    const hash = this.hashes.get(key)
    
    // 如果传入的是对象
    if (args.length === 1 && typeof args[0] === 'object') {
      Object.entries(args[0]).forEach(([field, value]) => {
        hash.set(field, value)
      })
    } else {
      // 如果传入的是 field1, value1, field2, value2... 格式
      for (let i = 0; i < args.length; i += 2) {
        if (i + 1 < args.length) {
          hash.set(args[i], args[i + 1])
        }
      }
    }
    return 'OK'
  }

  async hmget(key, ...fields) {
    const hash = this.hashes.get(key)
    if (!hash) return fields.map(() => null)
    return fields.map(field => hash.get(field) || null)
  }

  async hgetall(key) {
    const hash = this.hashes.get(key)
    if (!hash) return {}
    
    const result = {}
    for (const [field, value] of hash.entries()) {
      result[field] = value
    }
    return result
  }

  async hdel(key, ...fields) {
    const hash = this.hashes.get(key)
    if (!hash) return 0
    
    let count = 0
    fields.forEach(field => {
      if (hash.delete(field)) count++
    })
    
    if (hash.size === 0) {
      this.hashes.delete(key)
    }
    
    return count
  }

  async hkeys(key) {
    const hash = this.hashes.get(key)
    return hash ? Array.from(hash.keys()) : []
  }

  async hvals(key) {
    const hash = this.hashes.get(key)
    return hash ? Array.from(hash.values()) : []
  }

  async hlen(key) {
    const hash = this.hashes.get(key)
    return hash ? hash.size : 0
  }

  // 列表操作
  async lpush(key, ...values) {
    if (!this.lists.has(key)) {
      this.lists.set(key, [])
    }
    const list = this.lists.get(key)
    values.reverse().forEach(value => list.unshift(value))
    return list.length
  }

  async rpush(key, ...values) {
    if (!this.lists.has(key)) {
      this.lists.set(key, [])
    }
    const list = this.lists.get(key)
    values.forEach(value => list.push(value))
    return list.length
  }

  async lpop(key) {
    const list = this.lists.get(key)
    return list && list.length > 0 ? list.shift() : null
  }

  async rpop(key) {
    const list = this.lists.get(key)
    return list && list.length > 0 ? list.pop() : null
  }

  async llen(key) {
    const list = this.lists.get(key)
    return list ? list.length : 0
  }

  async lrange(key, start, stop) {
    const list = this.lists.get(key)
    if (!list) return []
    
    const length = list.length
    const startIndex = start < 0 ? Math.max(0, length + start) : Math.min(start, length)
    const stopIndex = stop < 0 ? length + stop + 1 : stop + 1
    
    return list.slice(startIndex, stopIndex)
  }

  // 集合操作
  async sadd(key, ...members) {
    if (!this.sets.has(key)) {
      this.sets.set(key, new Set())
    }
    const set = this.sets.get(key)
    let count = 0
    members.forEach(member => {
      if (!set.has(member)) {
        set.add(member)
        count++
      }
    })
    return count
  }

  async smembers(key) {
    const set = this.sets.get(key)
    return set ? Array.from(set) : []
  }

  async sismember(key, member) {
    const set = this.sets.get(key)
    return set ? (set.has(member) ? 1 : 0) : 0
  }

  async srem(key, ...members) {
    const set = this.sets.get(key)
    if (!set) return 0
    
    let count = 0
    members.forEach(member => {
      if (set.delete(member)) count++
    })
    
    if (set.size === 0) {
      this.sets.delete(key)
    }
    
    return count
  }

  async scard(key) {
    const set = this.sets.get(key)
    return set ? set.size : 0
  }

  // 通用操作
  async keys(pattern) {
    const allKeys = new Set([
      ...this.data.keys(),
      ...this.hashes.keys(),
      ...this.lists.keys(),
      ...this.sets.keys()
    ])
    
    if (pattern === '*') {
      return Array.from(allKeys)
    }
    
    // 简单的glob模式匹配
    const regex = new RegExp(pattern.replace(/\*/g, '.*').replace(/\?/g, '.'))
    return Array.from(allKeys).filter(key => regex.test(key))
  }

  async flushall() {
    this.data.clear()
    this.hashes.clear()
    this.lists.clear()
    this.sets.clear()
    this.ttls.clear()
    return 'OK'
  }

  async ping() {
    return 'PONG'
  }

  // 事务支持
  multi() {
    return new RedisTransactionMock(this)
  }

  // 管道支持
  pipeline() {
    return new RedisPipelineMock(this)
  }
}

// 模拟事务
class RedisTransactionMock {
  constructor(redis) {
    this.redis = redis
    this.commands = []
  }

  // 添加所有Redis命令到事务中
  get(key) { this.commands.push(['get', key]); return this }
  set(key, value, ...args) { this.commands.push(['set', key, value, ...args]); return this }
  del(...keys) { this.commands.push(['del', ...keys]); return this }
  hget(key, field) { this.commands.push(['hget', key, field]); return this }
  hset(key, field, value) { this.commands.push(['hset', key, field, value]); return this }
  hmset(key, ...args) { this.commands.push(['hmset', key, ...args]); return this }

  async exec() {
    const results = []
    for (const [command, ...args] of this.commands) {
      try {
        const result = await this.redis[command](...args)
        results.push(result)
      } catch (error) {
        results.push(error)
      }
    }
    return results
  }
}

// 模拟管道
class RedisPipelineMock {
  constructor(redis) {
    this.redis = redis
    this.commands = []
  }

  // 添加所有Redis命令到管道中
  get(key) { this.commands.push(['get', key]); return this }
  set(key, value, ...args) { this.commands.push(['set', key, value, ...args]); return this }
  del(...keys) { this.commands.push(['del', ...keys]); return this }
  hget(key, field) { this.commands.push(['hget', key, field]); return this }
  hset(key, field, value) { this.commands.push(['hset', key, field, value]); return this }
  hmset(key, ...args) { this.commands.push(['hmset', key, ...args]); return this }

  async exec() {
    const results = []
    for (const [command, ...args] of this.commands) {
      try {
        const result = await this.redis[command](...args)
        results.push([null, result])
      } catch (error) {
        results.push([error, null])
      }
    }
    return results
  }
}

module.exports = { RedisMock, RedisTransactionMock, RedisPipelineMock }