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
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
      "Connection": "keep-alive",
      "Accept": "*/*",
      "Accept-Encoding": "gzip, deflate, br, zstd",
      "Content-Type": "application/json",
      "bx-umidtoken": "T2gARzE0q1loODDRbQpw1Z64ChJVg-bmRwfVyv_j8polIDtbGjWWeMXaSqT4x43Jp_E=",
      "sec-ch-ua": "\"Not(A:Brand\";v=\"99\", \"Microsoft Edge\";v=\"133\", \"Chromium\";v=\"133\"",
      "bx-ua": "231!Gi/3E4mU9Bz+jmrE2k3B+qBjUq/YvqY2leOxacSC80vTPuB9lMZY9mRWFzrwLEkVa1wFtLD+zHNgrn8XY+MyBuYeq/H3f3xUv26oQ/UwKrQwgnlfAxvliVeH7qjfIqgMxkaltXMY18qf2jLSIEcdJCK772UnN7WEkMj94OoBikeNuUd/MBSf6MGiA++fapJkRD9rL50ZeSltJq6puucQU4y36evr+Tmep4Dqk+I9xGdFlRa8lJlCok+++4mWYi++6PJcjOrRLIBDjDmnuOXMEuy19T1fHkZj0MLTwbtxEp6I1aJHrvTMbb4QMWrfQAnwNtmuaKfTmmNxek8zi9fsofRKzTDAFYITZOHOKfi3FMyPX0SgkqOdJvshDhZrxSQdCBOJ51rb+p17Gt9BUZ369CVWSl3fLkIPD2xPcTqfpls0TdONrQIGUAKNheaibBtiG58AjsNMl+NOUJsL8LiM6aKWPFsin7Fx4hcVrsaG2wh8IddmORpIL74ObR97Czi1ue3H8GaJrB3YZPOfEOrIEuR75rIwQ1fJ/7lZMpb4p/vaV8/Be7crlqW3Jv4jLs6RT+yJeWUU7xsv6INpqc7l/1KOmfZ5XtwXsqGbbYUb8xbvVwTcpw6wqIdpGHrzMJGimiMZBNZ+PyzsLVFP/4GwTQBMFvBtWQJTJhjDNFiN/SnqWogGpsjJ4pgbJvvggNNq7M8opb+Qfj96wnJqtuembLFR5JETrWTUKUU4rTYUyICcmLdz1UOoR2uPHra8CUZdgBk3JoBUnOuuAVOKDtM8xrL8LI6eMMmP6JcX2T0gPeSRiZoavKrD+RjkWq/M2hBzdhQsVa1ttJvj/QG0XhcQZfDHohdv/hIrjoYRuGa9cOjeRe52hfoO+pi85RxKZkHypF5IUbNFJTIKkWgDZyMmwjt9AGo12EGx3Qb6h+2ICARSMqqleyIZT9REu0Mes3n/UC4hHjP31fVThAE93pqyMhEB5T6JzbtyvyZDncwuNngHdA36A4oQCArIw5lqIn5STpQFOWaLJALjIWn4apu8ND+5IGYv2rT2ttt4MMeT/fYF2ItFvKJxgAat9EQ1ol9ltZw9F1z2507Q1UAfsrHDsZZomry0YV1EGUYkZmadguz/1KRR/OYO/10/OISIgVD3T/8B+1OTXCuNOoMg+/fVWHBiuUnNCrnHcvu5mqvI4TxOsAslOt3gRCCrVo0JcIyoceLI0GocHK4yLK2sNB5dktuDn4mITXOQrMHOtEpJnsH21mHjMr9Oub7liX8f1qseGLWz36V40VqFiDklgBJKXZFB/AfD4zcSTLUov0k38Vdtpu/vU3bofe3ENFdi8/vroJOaq5tZQOD0ds3ZRjCFiQ4vR5zd8FU4+0cnalaM8qWhFuQ46oBLYUCB1L7vUOfsoQMIWZIUAhxfI2O8K38o00H+3jUdqb6l9RpltAXg0u2Z+nHh00Xqg10mRDuxhT0YGgZCPt5rx4MGWyEpNxnsnvWvA9aUQTuG82FDqdhNSedU/GVgYZQVbkfFSXnI5nVDs9k8EY6MmW6aw7EOrKGRdPD3jH1WlRavpuzAzpy8wFWlDL6WYYGZNy8cSjKm",
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
      "cookie": `_bl_uid=9Om3b8tj75t35j0wOu7jqaF4Oeb1; cna=DDN2IDt/3BICARucaW+edQsK; cnaui=c7ba94ca-a70a-4a3f-8559-41c6c1431faa; aui=c7ba94ca-a70a-4a3f-8559-41c6c1431faa; x-ap=cn-hongkong; sca=f05e9fe1; acw_tc=0a03e56417472357084307298e4e5b58a896269f71f1901be2b7cc8ed1d7f3; token=${authToken}; ssxmod_itna=YqRxyDuD9DBGYDKeYQiQei=d07DRQTqTDzxC5iOD+xQH508D6QDB4=Fy7pxD=KqY7laxqeYgimqDsq5xiNDAxq0iDC8ej1QQFrhxY7fCOgDqefQ8Dmjd5t7oe4QbK5rbY9TIz17QMKE7eDU4GnD0=eKD=VDYYfDBYD74G+DDeDixGm3eDStxD9DGP3cjTN6eDEDYP3xA3Di4D+AnrDmk4DGMExy7P3=0LdhDDl3fAP=iLah1i8NOw=rD90AeDMFxGX0B8YAlFjcK4rh=S0b=o5xB=nxBQNNOn4y7IdoZuWaQNVQ8DKKxwpiiP7Dx9heWGseA447KWD7iwxWDxQqVGTtK2FUBYDiTOCsKO5Y8eEw1UqzRkeZwdBgtjCeY053Bd=AQAo5l05D25V85e0sblG/Dqo8D7ix4D; ssxmod_itna2=YqRxyDuD9DBGYDKeYQiQei=d07DRQTqTDzxC5iOD+xQH508D6QDB4=Fy7pxD=KqY7laxqeYgiQ4iTwQRCeT=qfDGN1Mf+73m3MWWckPY8yhEfxqaE4hxq673u=kpxacmFMwngLmP4hn7A0Yq7ebaQ7tlBqi/C9teBmrK=it4D; SERVERID=ef8b367f7709b6209044c79e85306444|1747235728|1747233827; atpsida=fd79db1227a6e536536cb8a3_1747235728_10; tfstk=ghDEWk07bppUXEULtAwPgPILwg2LQ88XKYa7q0muAy4HJYwzqPoPRXiSq8JzS4UhK6XojR0b0uVHw92GIPZcZXwox7PzcuF3xyALIGqqo3Qkv3CGvAuVF9Tp90XzF8YXlK9jvMw8EE_PUhhFJuqlKLaut12LVFdvts9jvDIi60crvKszb3Autz0ut5fgAPfuq90uI1q4S9qlKubMbPUGKk2u-Gvg0uqlE42kbc4Tq8qnr7xZjbBrEvWa8WxWD0A5RNyLTrm37tot3kx0kKUOETDaYczmxQBlEArU9YKu7Lv4ObmYMviyUOeI0f2g4YKcazPqZvwiKFv067DiSl0BV_EZa0DYpWsAHqyEzSD3_gxrA8zUQlDDVsUsQygoL5xf37wihS2n1CLQNJrqrv3F4T0mfmML6Y8VSzhQDRqrenfzz7jPmaEgqhH-TafztlEalh-ZcMOdGIbHv25Rw5xTbrt20_C8tlEalh-Nw_FiWlzX0n5..; isg=BK6u-78BSr0Hc7HBFOBnWghU_wRwr3KpIWqlZNh2t7Fsu0wVSD7tuPS9cydXY2rB`
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
