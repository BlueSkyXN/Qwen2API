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
      "cookie": `token=${authToken};_bl_uid=9Om3b8tj75t35j0wOu7jqaF4Oeb1; cna=DDN2IDt/3BICARucaW+edQsK; cnaui=c7ba94ca-a70a-4a3f-8559-41c6c1431faa; aui=c7ba94ca-a70a-4a3f-8559-41c6c1431faa; acw_tc=0a03e55a17475394677153028e5699eaea36ad00fe2a5d6f3d8909f39ad7ac; x-ap=cn-hongkong; sca=572a3a46; SERVERID=1696c47c3d6d5c05dc40cb1f764cc4b7|1747539482|1747539467; atpsida=4a759f680ee94a49d4b1915b_1747539482_3; tfstk=gZ1t5JwZ5kqiE019-NynndQw5TahkJbaAG7SinxihMIdcGaZiZ9icjIpxP7M1lSpDisYuja40e1d4E6GnNtXMIL2vrzwcR5pDiTPifa47wtv7EzVDZzwlnsfDnXgK7bN7IRbqmFuZNyJD62hXhG6OrTyocaHCLmRy2ObquV3_JHNtIsc5EoYJwtekEMjCiMBdF-B5c9fcH9BPUm6GisjA2TyzEtXGd_QJE-BcIOfcBapoHtjwvy9vVTKMTrCMnF02ihjG6L9dJbeAQOuoF99VNtLVu1KadK55Hh027LOBnKFNk2d8gB1jeSYwkd5UMCvFIFt4FBCyBtMN8Hp6wjNwC18XfYHtHv5hpU_1wd9XgCeeqM96tsNMdWtuz7B1MWy4dwUYeCGZKKypDZ1-wK6etIgYjtGewspE6mnZQ6PvspWNgRPZ_nhS0xJoAaLJxk2Cey68eDysnpnveKuWFHq3KTeJ34LJxk2Ce8pqPnt3xJX8; isg=BHl5GmOWNUGRNuZAF1lIKxutiOVThm048mMSJZuvsaAfIpi05NcOCUw0pCbUmgVw; ssxmod_itna=YqRxyDuD9DBGYDKeYQiQei=d07DRQTqTDzxC5iOD+xQH508D6QDB4b1y7pxD=K8eZ9ET2AxaRxGX37KxiNDAxq0iDC8ej1QGmThxY7fCrgDqettDbFpd5Ae4xKYhwDomSYrLtQI1wiQ4GLDY=DCqhx3fND4+3Dt4DIDAYDDxDWDYo4xGUTDG=D7ORQgju3xi3DbObDf4DmDGAokeDgIDDBzb0=FObqlRbYDDNYYK4P=idasa0ONOq=rBc0IeDMFxGX0B8YInFjcK+is=S0iPEKxB=nxBjtNrW4y7Kd5cTWTeX/98DKKxqpiiP7DimG4SwDaiDuG4DTrQG4YGOBykR2Y9Rr94D8R+Cj4ZO558eEw1UqzRkeZL43Bt9Ep/2DqixsExp2NgG5/DxDhxM75A2srnG0eqY8D7GYPiDD; ssxmod_itna2=YqRxyDuD9DBGYDKeYQiQei=d07DRQTqTDzxC5iOD+xQH508D6QDB4b1y7pxD=K8eZ9ET2AxaKxAEriK6joeKQ0jqDsHYiabchO2003KPOaYKfcAF5GYkpcazHoMG1UZpkvTIYR2u54GQjutq0Wht1ee4D`
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
