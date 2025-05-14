const axios = require('axios')
const { sha256Encrypt } = require('./tools')
const fs = require('fs')
const path = require('path')
const { JwtDecode } = require('./tools')

class Account {
  constructor(accountTokens) {

    this.accountTokens = []

    if (process.env.RUN_MODE !== "hf") {
      this.accountTokensPath = path.join(__dirname, '../../data/accountTokens.json')
      this.dataDir = path.dirname(this.accountTokensPath)
      // 确保数据目录存在
      if (!fs.existsSync(this.dataDir)) {
        try {
          fs.mkdirSync(this.dataDir, { recursive: true })
        } catch (error) {
          console.error('创建数据目录失败:', error)
          process.exit(1)
        }
      }

      // 加载账户信息
      this.loadAccountTokens()

      // 设置定期保存
      this.saveInterval = setInterval(() => this.saveAccountTokens(), 60000) // 每分钟保存一次
    }

    // 设置定期刷新令牌 (每6小时刷新一次)
    this.refreshInterval = setInterval(() => this.autoRefreshTokens(), 6 * 60 * 60 * 1000)

    this.init(accountTokens)
    this.currentIndex = 0
    this.models = [
      "qwen-max-latest",
      "qwen-plus-2025-01-25",
      "qwen-turbo-2025-02-11",
      "qwq-32b",
      "qvq-72b-preview-0310",
      "qwen2.5-omni-7b",
      "qwen2.5-72b-instruct",
      "qwen2.5-coder-32b-instruct",
      "qwen2.5-14b-instruct-1m",
      "qwen2.5-vl-32b-instruct",
      // 新增的Qwen3系列模型
      "qwen3-235b-a22b",
      "qwen3-30b-a3b",
      "qwen3-32b"
    ]

    this.defaultHeaders = {
      "Host": "chat.qwen.ai",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36 Edg/133.0.0.0",
      "Connection": "keep-alive",
      "Accept": "*/*",
      "Accept-Encoding": "gzip, deflate, br, zstd",
      "Content-Type": "application/json",
      "bx-umidtoken": "T2gAH4jC27wJ1eiyaccyvfCzL3GnQNYDgc6MwON4mc0YhFaeKdEJDX9Fa69NKeUPjHQ=",
      "sec-ch-ua": "\"Not(A:Brand\";v=\"99\", \"Microsoft Edge\";v=\"133\", \"Chromium\";v=\"133\"",
      "bx-ua": "231!51D3dAmU+YE+j3Wk2k3B+qBjUq/YvqY2leOxacSC80vTPuB9lMZY9mRWFzrwLEkVa1wFtLD+zHNgrn8XY+MyBuYeq/H3f3xUv26oQ/UwKrQwgnlfAxvliVeH7qjfIqgMxkaltXMY18qf2jLSIEcdJCK772UnN7WEkMj94OoBikeNuUd/MBSf6MGiA++fapJkRD9rL50ZeSltJq6puucQU4y36evr+wmep4Dqk+I9xGdF7m96KFlCok+++4mWYi++6RgljOvkQPBDjDmnuOXMEuy19T1fHkZj0MLTwbtxEgk/tK624jvDa31qyFuYUZPPvqoscIErxerP2d67O4ZgV2IzZembwKmUu5WqDXyUjPKAhK/2o8UNHxwwZUO368lrb8gumr+f+keuoeQM3Ek4jM5r8HpR/pvL99LRwU6a5LyHTDMfBCUbsu7yh8pLAIfUHzbScAPyvelm8oNQEC3418MBYBXzog0FYgaKR4ndMH15OBT9hWiphBAtUtY2DsAhtTScRFGCKZpsBONhLW9EExs4Y8bcfUforLEWUCwV5FSze4IPnL0SVQk6oKn7LR61jkUQq9eICc1PyskMzyAD4TDUthmziiGKNb6grsy/pyzPVWcwU3Pv26WitHgYTcCSpeo9H2872KksAxnsiQazW4JqUlm8WAYltV7QjsBmZBVWPDduBbjKioFarTDKg2v/pIwc4yzwgaAHcj8gY61gHJTJ7YxJbUPO4Hb9BNC1hgRGN6f5ARekE2+vdkx+SzkIbpPpk0xNrWtlWWs8/uUweJl2Q1Olkyqzsr1LTVMvmysVNtL+F5xhycP+xexMVo9mwn8+N/xxQM6Xid0lr9RtfP889TqJu5htpNAq4ulUUbapeuoZg7Nv8cQIwkG9ZPoUQvmZ8r/VUO8zqBkf+lm6hCCKwDHXY7hd0ZOxUyMMfD6RXOvvUsp4/xM1ideMKPNB1tJtBJL4xjVuWRtncrFSfw5daDnwezSXIgcj0SGycDIDk9vzDST1s5wlL3U971qp0uZtDa8B1U9ttvJyFSzlJQ6VXSWXNvY2xumdPq0Mfugkg3MRxIcXx62+s0zbkx1f85y0eV5FDLGlBgaRyon6bvC8DGgHbm/FyJTR5y0dIEtkhUIocWgYrcRZ8iO/wD7DkFfl4r2U2laL5kDv5+3ISOhbxBfYLByBd85wozIFkC3nzzFbPPM7qw9gqS3bNzry4Tmu1DgGyWTb6gBLgdlSIE0A4qFsphHxKLijR59YGpWUSfss9OM2Y9oFNwUTVLD+Z0o7axeI7FEp2nJbLnmK4snNDje12CNiuFkTkML8hTDaAQN2mnZfTqFLHasQnw/n8QlpRO+EjnDiixluCifJdumzo5QtTM75seaaXlkeMcM8wXrGULE38LueAw1mQwxSy3l7nfyMt2BqoUKt8oEt4jqWQhxOySFQBq98uXnMR7f9m2YnZ17VfJyEdq64wW5C86jBMYmg2LhKIc5ij7sHqlPGMHsrQopQpzGmZOFnC7EuKZYk8zAdrmwNhLZF/oXT0fcb4njP8n/aqbhzQJSY7LFSPTJduUuI3XnHcg4YcN3H5+C0SaeXtcn4GFZ3ZC5AKCEEXRybO4==",
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": "\"Windows\"",
      "bx-v": "2.5.28",
      "origin": "https://chat.qwen.ai",
      "sec-fetch-site": "same-origin",
      "sec-fetch-mode": "cors",
      "sec-fetch-dest": "empty",
      "referer": "https://chat.qwen.ai/",
      "accept-language": "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7",
      "priority": "u=1, i"
    }
  }

  loadAccountTokens() {
    try {
      if (!fs.existsSync(this.accountTokensPath)) {
        this.accountTokens = []
        this.saveAccountTokens()
      } else {
        const data = fs.readFileSync(this.accountTokensPath, 'utf-8')
        try {
          this.accountTokens = JSON.parse(data)
          // 验证数据格式
          if (!Array.isArray(this.accountTokens)) {
            console.error('账户数据格式错误，重置为空数组')
            this.accountTokens = []
          }
        } catch (jsonError) {
          console.error('解析账户数据失败，创建备份并重置:', jsonError)
          // 创建备份
          const backupPath = `${this.accountTokensPath}.bak.${Date.now()}`
          fs.copyFileSync(this.accountTokensPath, backupPath)
          this.accountTokens = []
        }
      }
    } catch (error) {
      console.error('加载账户数据失败:', error)
      this.accountTokens = []
    }

    // 添加自定义方法到数组
    this.accountTokens = this.extendTokensArray(this.accountTokens)
  }

  extendTokensArray(array) {
    // 创建代理来拦截修改操作，实现自动保存
    return new Proxy(array, {
      set: (target, prop, value) => {
        target[prop] = value
        this.saveAccountTokens()
        return true
      },
      deleteProperty: (target, prop) => {
        delete target[prop]
        this.saveAccountTokens()
        return true
      }
    })
  }

  saveAccountTokens() {
    try {
      fs.writeFileSync(this.accountTokensPath, JSON.stringify(this.accountTokens, null, 2))
    } catch (error) {
      console.error('保存账户数据失败:', error)
    }
  }

  // 添加一个方法来清理过期的令牌
  cleanExpiredTokens() {
    const now = Math.floor(Date.now() / 1000)
    const validTokens = this.accountTokens.filter(token => {
      const isValid = token.expiresAt > now
      if (!isValid) {
        console.log(`令牌已过期: ${token.username || token.id}`)
      }
      return isValid
    })

    if (validTokens.length !== this.accountTokens.length) {
      this.accountTokens.length = 0 // 清空原数组
      validTokens.forEach(token => this.accountTokens.push(token)) // 添加有效令牌
    }
  }

  // 添加自动刷新令牌的方法
  async autoRefreshTokens() {
    console.log('开始自动刷新令牌...')

    // 找出即将过期的令牌 (24小时内过期)
    const now = Math.floor(Date.now() / 1000)
    const expirationThreshold = now + 24 * 60 * 60

    const needsRefresh = this.accountTokens.filter(token =>
      token.type === "username_password" && token.expiresAt < expirationThreshold
    )

    if (needsRefresh.length === 0) {
      console.log('没有需要刷新的令牌')
      return 0
    }

    console.log(`发现 ${needsRefresh.length} 个令牌需要刷新`)
    let refreshedCount = 0
    for (const token of needsRefresh) {
      // 只刷新类型为username_password且即将过期的令牌
      const refreshed = await this.refreshSingleToken(token)
      if (refreshed) refreshedCount++
    }

    console.log(`成功刷新了 ${refreshedCount} 个令牌`)
    return refreshedCount
  }

  // 添加检查令牌是否即将过期的方法
  isTokenExpiringSoon(token, thresholdHours = 6) {
    const now = Math.floor(Date.now() / 1000)
    const thresholdSeconds = thresholdHours * 60 * 60
    return token.expiresAt - now < thresholdSeconds
  }

  // 修改getAccountToken方法，处理即将过期的令牌
  getAccountToken() {
    this.cleanExpiredTokens() // 每次获取前清理过期令牌

    if (this.accountTokens.length === 0) {
      console.error('没有可用的账户令牌')
      return null
    }

    if (this.currentIndex >= this.accountTokens.length) {
      this.currentIndex = 0
    }

    const token = this.accountTokens[this.currentIndex]
    this.currentIndex++

    // 检查令牌是否即将过期
    if (token.type === "username_password" && this.isTokenExpiringSoon(token)) {
      console.log(`令牌即将过期，尝试刷新: ${token.username}`)
      // 异步刷新令牌，不阻塞当前请求
      this.refreshSingleToken(token).catch(err =>
        console.error(`刷新令牌失败 (${token.username}):`, err.message)
      )
    }

    // 更新请求计数
    token.requestNumber = (token.requestNumber || 0) + 1
    token.lastUsed = new Date().toISOString()

    if (token.token) {
      return token.token
    } else {
      // 尝试下一个令牌
      return this.getAccountToken()
    }
  }

  // 刷新单个令牌的方法
  async refreshSingleToken(token) {
    if (token.type !== "username_password") {
      return false
    }

    try {
      const newToken = await this.login(token.username, token.password)
      if (newToken) {
        const decoded = JwtDecode(newToken)
        const now = Math.floor(Date.now() / 1000)

        // 找到并更新令牌
        const index = this.accountTokens.findIndex(t => t.username === token.username)
        if (index !== -1) {
          this.accountTokens[index] = {
            ...token,
            token: newToken,
            expiresAt: decoded.exp,
            lastRefreshed: new Date().toISOString()
          }
          console.log(`刷新令牌成功: ${token.username} (还有${Math.round((decoded.exp - now) / 3600)}小时过期)`)
          return true
        }
      }
    } catch (error) {
      console.error(`刷新令牌失败 (${token.username}):`, error.message)
    }

    return false
  }

  init(accountTokens) {
    if (!accountTokens) return

    const accountTokensArray = accountTokens.split(',')
    accountTokensArray.forEach(async (token) => {
      if (token.includes(';')) {
        const account = token.split(';')
        const username = account[0]
        const password = account[1]

        // 检查是否已存在该用户的有效令牌
        const existingAccount = this.accountTokens.find(item => item.username === username)
        if (existingAccount) {
          // 检查令牌是否过期
          const now = Math.floor(Date.now() / 1000)
          if (existingAccount.expiresAt > now) {
            console.log(`${username} 令牌有效，跳过登录`)
            return
          }
          console.log(`${username} 令牌已过期，重新登录`)
        }

        const accountToken = await this.login(username, password)
        if (accountToken) {
          const decoded = JwtDecode(accountToken)

          // 如果用户已存在，更新令牌信息
          if (existingAccount) {
            const index = this.accountTokens.findIndex(item => item.username === username)
            if (index !== -1) {
              this.accountTokens[index] = {
                ...existingAccount,
                token: accountToken,
                expiresAt: decoded.exp,
                lastRefreshed: new Date().toISOString()
              }
              return
            }
          }

          // 添加新用户
          this.accountTokens.push({
            type: "username_password",
            id: decoded.id,
            username: username,
            password: password,
            token: accountToken,
            requestNumber: 0,
            expiresAt: decoded.exp,
            addedAt: new Date().toISOString()
          })
        }
      } else {
        // 处理直接提供的token
        // 检查是否已存在该token
        if (this.accountTokens.find(item => item.token === token)) {
          return
        }

        try {
          const decoded = JwtDecode(token)
          // 检查令牌是否已过期
          const now = Math.floor(Date.now() / 1000)
          if (decoded.exp <= now) {
            console.log(`令牌已过期: ${decoded.id || token.substring(0, 10)}...`)
            return
          }

          this.accountTokens.push({
            type: "token",
            id: decoded.id,
            username: '未设置',
            password: '未设置',
            token: token,
            requestNumber: 0,
            expiresAt: decoded.exp,
            addedAt: new Date().toISOString()
          })
        } catch (error) {
          console.error('无效令牌:', token.substring(0, 10) + '...')
        }
      }
    })
  }

  // 更新销毁方法，清除定时器
  destroy() {
    if (this.saveInterval) {
      clearInterval(this.saveInterval)
    }
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval)
    }
  }

  async checkAccountToken(token) {
    try {
      await axios.get('https://chat.qwen.ai/api/chat/completions', {
        "model": "qwq-32b",
        "messages": [
          {
            "role": "user",
            "content": "你好"
          }
        ],
        "stream": false,
        "chat_type": "t2t",
        "id": uuid.v4()
      }, {
        headers: this.getHeaders(token)
      })
      return true
    } catch (error) {
      console.error('验证令牌失败:', error.message)
      return false
    }
  }

  async getModelList() {
    const modelsList = []
    for (const item of this.models) {
      modelsList.push(item)
      modelsList.push(item + '-thinking')
      modelsList.push(item + '-search')
      modelsList.push(item + '-thinking-search')
      modelsList.push(item + '-draw')
    }

    const models = {
      "object": "list",
      "data": modelsList.map(item => ({
        "id": item,
        "object": "model",
        "created": new Date().getTime(),
        "owned_by": "qwen"
      })),
      "object": "list"
    }
    return models
  }

  async generateMarkdownTable(websites, mode) {
    // 输入校验
    if (!Array.isArray(websites) || websites.length === 0) {
      return ""
    }

    let markdown = ""
    if (mode === "table") {
      markdown += "| **序号** | **网站URL** | **来源** |\n"
      markdown += "|:---|:---|:---|\n"
    }
    // 默认值
    const DEFAULT_TITLE = "未知标题"
    const DEFAULT_URL = "https://www.baidu.com"
    const DEFAULT_HOSTNAME = "未知来源"

    // 表格内容
    websites.forEach((site, index) => {
      const { title, url, hostname } = site
      // 处理字段值，若为空则使用默认值
      const urlCell = `[${title || DEFAULT_TITLE}](${url || DEFAULT_URL})`
      const hostnameCell = hostname || DEFAULT_HOSTNAME
      if (mode === "table") {
        markdown += `| ${index + 1} | ${urlCell} | ${hostnameCell} |\n`
      } else {
        markdown += `[${index + 1}] ${urlCell} | 来源: ${hostnameCell}\n`
      }
    })

    return markdown
  }

  async setDefaultModels(models) {
    this.models = models
  }

  async getModels() {
    return this.models
  }

  getHeaders(authToken) {
    const headers = {
      ...this.defaultHeaders,
      "authorization": `Bearer ${authToken}`,
      "cookie": `cna=qS5EIEcjlH0BASQOBGAZfs5p; _bl_uid=kOmRv8RR5mhvUg19zssbrybb6hbL; _gcl_au=1.1.828597960.1740456102.793002097.1746192600.1746193839; cnaui=0212b625-d7d8-4e4d-b04c-9a70f6f77f70; aui=0212b625-d7d8-4e4d-b04c-9a70f6f77f70; acw_tc=0a03e53917472294407584787e53afb3cf182ff62fc8d92a971fbb51713ebb; x-ap=ap-southeast-1; xlly_s=1; token=${authToken}; sca=f9b4f03c;ssxmod_itna=mqUxRDBDnD00I4eKYIxAK0QD2W3nDAQDRDl4Bti=GgexFqAPqDHI63vYWtQKWjKB=GneqKK4GXoFYxiNDAZ40iDC+ndNQK40K4QjQEbbqeKQOYiKoOGY=2t5rAcibeFt8id2mAauIeKbDB3DbqDy00YeoxGGI4GwDGoD34DiDDPDbfiDAqeD7qDFAWutZnbDm4GWAeGfDDoDY+b5xiUYDDtvKeG2WgbKDDN5C7r4iDhah1i8xOy=2DF0AeDMWxGXj08KAl9LuIxrhP80bZY5xB6uxBQNxOn4yaIdoZuWox+MWGmjbGeMIDqTBq=Dq8rsDn4FYxqDrDfdRgD8hx5CsaQdDDfh0DuGGMpPPAYn6U9ZUBr+t+wwmIafRVerXAPeiKbC0CjwziDdQrhlwx70qA0ZoD; ssxmod_itna2=mqUxRDBDnD00I4eKYIxAK0QD2W3nDAQDRDl4Bti=GgexFqAPqDHI63vYWtQKWjKB=GneqKYxD3bKYi4qhoDFrxKei6mhxD/+xcDWQ79fD8WQT9ScLP6XD7wcX3iqpxnCOwFvHMjag+rdqjDfH0BdqRf6SzE3Du4Y4klQ+YG0RImhfzu29fC+SCnoR8WLfI7iQilpx5B06Y4f=qL0X/+63Hc9H5lpTc6yPrZjH86yXtLUSUSaSG8D/Fn0tR3SXiYdqVdQz=n2o+R7u0kj0vQkXesodcaW81Qq4kZ1CLl1X7lBjlh0SqeHnreeYn7nx9UvH/9mzTW80FQWLQDqCRL7Dg/9XIikDyeKwB+h49Al7Tr975OqtUyP1ewU5ftO2eKuSPSnb2SAP7F1YR0Kq=yRGDc0GpMKF9777U7iubrGwwQGhiyO8GWnakzuI3cG03zm7TcRv8aVST5LSIna48FfIusWPtKBXQukHoxQfbxIry30j7OtgPMay7TkYv7w2kzhosa2+SNkK4UK/DcjRqO+A/bdsQ8C0umPyef+NPWH7vRnp58SOj8jRvPKuFxE1npvk3++446DxzaLVpxUSUcZ3p1Qua1W0D0Tu34+bKpNOu71k8R570inqXMbCERD/86ayTw4pBSHU+WQ6vrD6duBMiaKDIGRgLm4SmaYDsUYlpRlXiB6GS0iV64KBW9QLD6/NefYYxxeqlxmSlAIE7uCDfxxi3S+8F+L2un+QObCQ3CM7DwTDoDwMkB=fO=0w9DvKiKi00wZMWW4PAoK4bAK2x1AYSx47=3tPQYLrdioeD; atpsida=f5e9d0fc2ebbc515ccc2c91f_1747229475_5; SERVERID=7ef554cd34b514fe46f559ab5db907b6|1747229475|1747229440; isg=BA4Oz1MW6l2P4FHgKGxawyTXX-TQj9KJzktbMThQl5HMm6r1rB0tmNSd08f3g8qh; tfstk=g9mrWp6z73KzHCF8rmZF7PBjDaZ8zkR6qDNQKvD3F7VkwDZUKSkFN4MIKk-UiXFltBLdis2sO64kyLeFnSwMpWY-EtX0KfalEzj3micUB8VHppCcemlNAgOJyvjUAkA61htsexrLxCtf2pwlwRwCZHNuErq8dUsHey-seYBmkv0Eeh6U3UVLrWc3rrf0eS2lxgc3mn28ig2hqJfD3SF0KWjlxZ40FJClxXqH3xVYKk2otzvqnjvoEvj4CzvBCwqT8Nn3z5DugGkxY8XgwhFPxMm4UxPiE2IhxmyzzDIZgbhbP2DTW0MMYiESQqq0LDpG8WzZ-0ZmqIxgkymmi-cWdweq8vmT2lWHqxrzaP2zPTjnsxkn5roXIhEzq70Q2v6wNxorNYnqd9b04ug470rMX_VIlAoULDdp0fknB24qY_SzH6e0fNmKz6bUr-e41KJ20TIZ9ibNc1QdJrqT3597FwQLrhw41dKdJwURN-P6FQf..`
    }

    return headers
  }

  async login(username, password) {
    try {
      const response = await axios.post('https://chat.qwen.ai/api/v1/auths/signin', {
        email: username,
        password: sha256Encrypt(password)
      }, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36 Edg/134.0.0.0"
        }
      })

      if (response.data && response.data.token) {
        console.log(`${username} 登录成功`)
        return response.data.token
      } else {
        console.error(`${username} 登录响应缺少令牌`)
        return false
      }
    } catch (e) {
      console.error(`${username} 登录失败:`, e.message)
      return false
    }
  }
}

if ((!process.env.ACCOUNT_TOKENS && process.env.API_KEY) || (process.env.ACCOUNT_TOKENS && !process.env.API_KEY)) {
  console.log('如果需要使用多账户，请设置ACCOUNT_TOKENS和API_KEY')
  process.exit(1)
}

const accountTokens = process.env.ACCOUNT_TOKENS
let accountManager = null

if (accountTokens) {
  accountManager = new Account(accountTokens)

  // 添加进程退出时的清理
  process.on('exit', () => {
    if (accountManager) {
      accountManager.destroy()
    }
  })

  // 处理意外退出
  process.on('SIGINT', () => {
    if (accountManager && !process.env.RUN_MODE === "hf") {
      console.log('正在保存账户数据...')
      accountManager.saveAccountTokens()
      accountManager.destroy()
    }
    process.exit(0)
  })
}

module.exports = accountManager
