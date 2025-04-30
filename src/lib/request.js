const axios = require('axios')
const uuid = require('uuid')
const accountManager = require('./account.js')
const sendChatRequest = async (model, messages, stream, authToken) => {
  if (!messages[messages.length - 1].chat_type) {
    messages[messages.length - 1].chat_type = "t2t"
  }

  if (!messages[messages.length - 1].extra) {
    messages[messages.length - 1].extra = {}
  }

  if (!messages[messages.length - 1].feature_config) {
    messages[messages.length - 1].feature_config = {
      "thinking_enabled": false
    }
  }

  messages.forEach(message => {
    if (message.role === 'developer') {
      message.role = 'system'
    }
  })

  let body = {
    "model": model,
    "messages": messages,
    "stream": stream,
    "chat_type": "t2t",
    "id": uuid.v4()
  }

  // 判断是否开启推理
  let thinkingEnabled = false
  if (model.includes('-thinking') || model.includes('qwq-32b')) {
    thinkingEnabled = true
    
    // 为qwen3系列模型添加特殊的思考配置
    if (model.startsWith('qwen3')) {
      messages[messages.length - 1].feature_config = {
        "thinking_enabled": thinkingEnabled,
        "thinking_budget": 38912
      }
    } else {
      // 原有模型的配置
      messages[messages.length - 1].feature_config = {
        "thinking_enabled": thinkingEnabled
      }
    }
    
    body.model = body.model.replace('-thinking', '')
  }

  if (model.includes('-search')) {
    messages[messages.length - 1].chat_type = 'search'
    body.model = body.model.replace('-search', '')
    body.chat_type = 'search'
  }
  if (accountManager) {
    const models = await accountManager.getModels()
    if (!models.includes(body.model)) {
      body.model = 'qwq-32b'
    }
  }

  try {

    // console.log(JSON.stringify(body))
    const response = await axios.post('https://chat.qwen.ai/api/chat/completions',
      body,
      {
        headers: accountManager.getHeaders(authToken),
        responseType: stream ? 'stream' : 'json'
      }
    )
    // console.log("response", response.data)
    // 结束程序
    // process.exit(0)
    return {
      status: 200,
      response: response.data
    }
  }
  catch (error) {
    console.log(123, error)
    // process.exit(0)
    return {
      status: 500,
      response: null
    }
  }

}

module.exports = {
  sendChatRequest
}