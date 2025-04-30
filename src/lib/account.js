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
      "bx-umidtoken": "T2gAXHjo-gwZXMp1imYSacNSgg-s39D066VZk8P5QWsDfU4ZIXgyrsgJuXBruLtZd6U=",
      "sec-ch-ua": "\"Not(A:Brand\";v=\"99\", \"Microsoft Edge\";v=\"133\", \"Chromium\";v=\"133\"",
      "bx-ua": "231!h+E3A4mUEDD+j3W42k301dBjUq/YvqY2leOxacSC80vTPuB9lMZY9mRWFzrwLEkVa1wFtLD+zjulzVfhndyTScQXMkGVcC9byQmtk201ePaqQWYrovREV0wqL2CUPUKzVOkGN8s47podMfj9LFgnfgRmaQC4v6FA24XxeEVbKOAY5YPubzsWeDqB05ZDyS+Lzcg1lF4gt+bJEsc9QoihanFaXtGr+hmep4Dqk+I9xGdFZPnJAFlCok+++4mWYi++6RXTo7bA9PBDjDj5v8uhhQ9Vstr6KJVROO+MEa5m/C+6DVWIUOPAdDF7fCD5iyX9A6PyJaMbcrrlWT9w2jzDDVJlRXNoYF2PE9IwmgkXZC96lFy5ilUdyOh8FcxIDrP8IQZVcfVsqwov+gu5mUZseHnZePUZfu6iYBQv/ZG1nUQZCt9pnbFxIcfghR0h2Yd2MzwASLwx5l0l+6VZ9werLV5MbFgua/QW/vcco6NDk3LUf6/K/ZO6Jru3gNbCP8PsU5cpRqFto7QQct1iV9bdynts4xcV62a0pTQn1FPmPSfr+X++1Iakro1EUGCAb0ow0K2/W0r07/0uzytd//ieMsV3pKwvkIL18vcr3eabA/rgQodUSZAcQk6KynHBluFRciPEB/HKr3/IxhgLzgXEOYZFGC7ITheGuH2zRLLo+iT70Fbf9EWHKSgkjV0BwyrcYNKpUHailiX1sp6Y+fohGcGEYkbYbOaOTvi9nkZAlxeVqdLBDSRGOQcuG5ASZ9hiFjLWDQ8J6gfiWlti/KFyDrStIs8fp7GbzN8rVVZS5LncwKP+lEbtRaKKvfpj+0AZH2iMepwhsIT/PARBPtv5iAyEto+riE35sEKzceLjZaKkaUBltderSMy/mHCdw2MlQmVwet3HzIh21KdPThucnO9AR/FsuP/wsqX35NuzzUWXVesKcusoCVIf6raou8a09W6ZnGqilKW3xzHqfsL2+mHUVojQO5pt/QhTWR+QVjhe7sraRSmqYVhTeAZdpVtr3kv4UweZkfTdOnoxczbJAdmrUOXMSlmlvKvtka/wdeW5wZ7SGyhLpiTj73bg3dQaBLmBS8PzApjXkqfP9d0UZE83yTxkCwrr8c01aAfFj2FvPKV98e/whvujHsv+hF91fpmeTluY+iCgmusfM6fIlr19nkKT6izq09Gxq71+31PVu1uqk7zGB2toEqlczQba7V7gyLhW82bXLYiYqOk2O+++vNWxbab+HccRimTS7mcRgEzXyomnnEkQuWUQiA7vxKZFPb6eWmWx1lGRQBQfOj8TbuwePXDaoTqrgtaUBSPSEpwMaFib3Rn6fCvVovIXuqczTMUiFb8GqifNbL+9Adh1JxlDh+fBBZmkFcpsqIeRxEyIDzLesmCKy4TXCXjvNXyu4AE/j5yV0dEykCCNqzWFGRswKuu82sS/ePB6GUa151SkkXf6nSqlT/rCR69QWAEs+fIh8+cZsOsiJRFINGVZXlE9KwQp3GfJxpdKG2bWUo2fOC00b+2vZ8QGgQTc+V1J4l55EcIlqzXv1bSwnTZhx4sNw+yy+2jvayfC942QBgNVYkvuLGemk1Mmalia7SrVNvjJVvg2kn2K1x/ppVxl0y8bGwHCNc0i9vG=",
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
      "cookie": `cna=qS5EIEcjlH0BASQOBGAZfs5p; _bl_uid=kOmRv8RR5mhvUg19zssbrybb6hbL; _gcl_au=1.1.828597960.1740456102.2077920929.1743157094.1743157245; acw_tc=0a03e53617439970410204419e5ae8476c313711757a6ffde5f510ddf8b989; x-ap=ap-southeast-1; sca=b18a215e; token=${authToken}; cnaui=3c1ea2c7-1757-4f25-8ed1-a2f626e29b24; aui=3c1ea2c7-1757-4f25-8ed1-a2f626e29b24; xlly_s=1; atpsida=c6a630bb7936baa90617b57c_1743997052_3; ssxmod_itna=mqUxRDBDnD00I4eKYIxAK0QD2W3nDAQDRDl4Bti=GgexFqAPqDHIa3vYW0K37WIi77DoqTQi84D/I7heDZDG9dDqx0obXl0DoDkY00Rm3d=i70e+FBR7O59+g+Yo4eCT+rhhMxT8iZkyY+eDU4GnD0=QtbrbDYAfDBYD74G+DDeDixGmteDSDxD9DGPdglTi2eDEDYPdxA3Di4D+jebDmd4DGqf4x7QaRmxD0ux58mDS8a946PmzMeqOPubDjTPD/R+LO0RC2FkKYa9APkcmGeGyi5GuDPmbNjHORnniHpYPSTxb93xbj7o7DYqAx7GdMk4Cr=7iGeDYexqn2NO0D5x=AOdkxDiheKCrnGDblqUi+n2tyxNgr+iI0m0IHSbbAAoerdWreGI3+mCjw4QxPe5K/NzC0q7T/oD; ssxmod_itna2=mqUxRDBDnD00I4eKYIxAK0QD2W3nDAQDRDl4Bti=GgexFqAPqDHIa3vYW0K37WIi77DoqTQi4DWmW7AooeFKD7p1Qm42brDlZfuadWO0cDBoG2Y/ceQbvQh3KUTri14Hybv+/t7D9e/UE/kNcAMQMWwDEj4qe=G6Htd=QQi3czLrU+RblYn4PM40Ujb=rkRbPfTtd5Q=lzrXogWfNc4QcfewBAMP1xmWuARDUb6yWulPiEMv28dHMtdyhu=NMY=c/jiLyjfoQSTLpX8DkalnZQ4TKPu6WvB7MFM=wWaxuxCvLW=xZc1MPp4x+uW7m134DuWs/TUeTsGm4RRaYGPzy9I+tWW5BrCWw4I+PtKgBFkSTlAqI+ulRp9zx1Kn0S+M+PHF7Do50mR5n4kj+OeokWvFQDAmmF3EpYwfeYL4SLIDqtwtaqqWnTwKHiDkRhA98szKFOwHaamnqqoFOIOQ7u2eTpSp+9uWGaLB4K3Ik3Y=gasI+inmkNYhtaElHNkq4DHEfnMDylRoxeSZ9qsqYGzHNVSeSqIxn5m41cCkApxug/e6P7vAchFWWzqIOs54hK4wus+xaW09fewn9Yw+F0oujbN=u1DBTrG2q8A0eQdTkFuVjRex/2hAnhTCC5aGl8Ap0eSs0w4SqoRh5Yxze7p7bOlMTkqqITfjDYy9lmstx3N9IanhzSwwoD5I2ds/Ky2D8QLYdtwDQGSqeDxSUyGxE45WvGXv8D7XGEmbtliqgieQpSoKDxzwsDU0GzqV44EYPwXRwxD4zBq1YGTG4idR8zvW44xtRG1SGvGe7G+mYt4CBV3DKdL0GwnYHwnu4Y4xD; SERVERID=e4ed9fad8a5a5834ea1011f9e693e4e5|1743997148|1743997041; tfstk=gvni4oONXVz1xTGR6Xr6rkI6pY8KWOZbCjIYMoF28WPIXjL_M2qqUb4YuFgttSVEwRoY0NzDY-VHhNR_uD2UFRJb7iJboJPKas747IaU8-wc_OyZm2smFxi9Cop_fAZb0QdJ2nDsCo_N1QWimkkUC-xA0PSafklI8zlv23HsQ2PtoPt-XRWCJ5F40PzVT9PQnNyqgryUYWwb31yVbpDUOWyV0SSaTkyTU1PqgoJnLWw40Rl4CNP-04oeOzMSInwJfcwgS7ka_AHKY6ZF5YVh0ion-PVzvWjV0D2ipF2w2gYYa4NTyScevGqmL-c3yVAljjDqFqznm1JtaXumgJgBiZVouA3SuyvwbvqgsbmQrO70jqlsmPgGhLMUbXg7NP8BOJmt2rV7-6RZpvVarqc9OiPtrvl3yDCd2uuStm4z4gu58a-WLiweHD7flPyQK7ej68vhsMoLApvhyxaad8NJKpbvIPyQLVJHKaSY7Jwtt; isg=BHV1ACwtfscri5o1J-FRXnOihPEv8ikEff_vAveQ5-w7zpjAu0YA1SKAGJJ4jkG8`
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
