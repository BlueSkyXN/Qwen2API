const express = require('express')
const router = express.Router()
const uuid = require('uuid')
const { uploadImage } = require('../lib/upload.js')
const { isJson } = require('../lib/tools.js')
const { sendChatRequest } = require('../lib/request.js')
const accountManager = require('../lib/account.js')
const { createImageRequest, awaitImage } = require('../lib/image.js')

router.post(`${process.env.API_PREFIX ? process.env.API_PREFIX : ''}/v1/chat/completions`, async (req, res) => {

  // 身份验证
  let authToken = req.headers.authorization
  const messages = req.body.messages

  if (!authToken) {
    return res.status(403)
      .json({
        error: "请提供正确的 Authorization token"
      })
  }

  if (authToken === `Bearer ${process.env.API_KEY}` && accountManager) {
    authToken = accountManager.getAccountToken()
  } else if (authToken) {
    authToken = authToken.replace('Bearer ', '')
  }

  // 判断是否开启流式输出
  if (req.body.stream === null || req.body.stream === undefined) {
    req.body.stream = false
  }
  const stream = req.body.stream

  console.log(`[${new Date().toLocaleString()}]: model: ${req.body.model} | stream: ${stream} | authToken: ${authToken.replace('Bearer ', '').slice(0, Math.floor(authToken.length / 2))}...`)


  let file_url = null
  const isFileMessage = Array.isArray(messages[messages.length - 1].content) === true

  if (isFileMessage) {

    const file = messages[messages.length - 1].content.filter(item => item.type !== 'text')[0]

    if (file && file.type === 'image_url') {
      file_url = await uploadImage(file.image_url.url, authToken)
    }

    if (file_url) {
      messages[messages.length - 1].content[messages[messages.length - 1].content.length - 1] = {
        "type": "image",
        "image": file_url,
      }
    } else {
      res.status(500)
        .json({
          error: "请求发送失败！！！"
        })
      return
    }
  }

  const setResHeader = (stream) => {
    try {
      if (stream) {
        res.set({
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        })
      } else {
        res.set({
          'Content-Type': 'application/json',
        })
      }
    } catch (e) {
      console.log(e)
    }
  }


  const notStreamResponse = async (response) => {
    setResHeader(false)
    try {
      // console.log(response)
      const bodyTemplate = {
        "id": `chatcmpl-${uuid.v4()}`,
        "object": "chat.completion",
        "created": new Date().getTime(),
        "model": req.body.model,
        "choices": [
          {
            "index": 0,
            "message": {
              "role": "assistant",
              "content": response.choices[0].message.content
            },
            "finish_reason": "stop"
          }
        ],
        "usage": {
          "prompt_tokens": JSON.stringify(req.body.messages).length,
          "completion_tokens": response.choices[0].message.content.length,
          "total_tokens": JSON.stringify(req.body.messages).length + response.choices[0].message.content.length
        }
      }
      res.json(bodyTemplate)
    } catch (error) {
      console.log(error)
      res.status(500)
        .json({
          error: "服务错误!!!"
        })
    }
  }

  const streamResponse = async (response, thinkingEnabled) => {
    try {
      const id = uuid.v4()
      const decoder = new TextDecoder('utf-8')
      let backContent = null
      let webSearchInfo = null
      let temp_content = ''
      let thinkEnd = false
      
      // 新增变量，用于处理phase标记的思考过程
      let previousPhase = null
      let isInThinkingPhase = false

      response.on('start', () => {
        setResHeader(true)
      })

      response.on('data', async (chunk) => {
        const decodeText = decoder.decode(chunk, { stream: true })
        // console.log(decodeText)
        const lists = decodeText.split('\n').filter(item => item.trim() !== '')
        for (const item of lists) {
          try {
            let decodeJson = isJson(item.replace("data: ", '')) ? JSON.parse(item.replace("data: ", '')) : null
            if (decodeJson === null) {
              temp_content += item
              decodeJson = isJson(temp_content.replace("data: ", '')) ? JSON.parse(temp_content.replace("data: ", '')) : null
              if (decodeJson === null) {
                continue
              }
              temp_content = ''
            }

            // 处理 web_search 信息
            if (decodeJson.choices[0].delta.name === 'web_search') {
              webSearchInfo = decodeJson.choices[0].delta.extra.web_search_info
            }

            // 处理内容
            let content = decodeJson.choices[0].delta.content || ''
            
            // 处理phase标记的思考过程 (针对Qwen3系列模型)
            if (decodeJson.choices[0].delta.phase) {
              const currentPhase = decodeJson.choices[0].delta.phase
              
              // 检测阶段转换
              if (previousPhase !== currentPhase) {
                // 从无到think - 添加开始标签
                if (currentPhase === 'think' && !isInThinkingPhase) {
                  content = '<think>' + content
                  isInThinkingPhase = true
                } 
                // 从think到answer - 添加结束标签
                else if (previousPhase === 'think' && currentPhase === 'answer' && isInThinkingPhase) {
                  content = '</think>' + content
                  isInThinkingPhase = false
                }
                
                previousPhase = currentPhase
              }
            }

            if (backContent !== null) {
              content = content.replace(backContent, '')
            }

            backContent = decodeJson.choices[0].delta.content || ''

            // 处理思考内容的显示/隐藏逻辑
            if (thinkingEnabled && process.env.OUTPUT_THINK === "false") {
              // 针对老模型和新转换的phase模型，都能处理<think>标签
              if (!thinkEnd) {
                // 如果内容中包含</think>，说明思考结束
                if (content.includes("</think>")) {
                  content = content.replace("</think>", "")
                  thinkEnd = true
                } 
                // 如果思考还未结束，且没有</think>标签，跳过输出
                else if (!content.includes("</think>")) {
                  continue
                }
              }
            }

            // 处理搜索信息
            if (webSearchInfo && process.env.OUTPUT_THINK === "true") {
              if (thinkingEnabled && content.includes("<think>")) {
                content = content.replace("<think>", `<think>\n\n\n${await accountManager.generateMarkdownTable(webSearchInfo, process.env.SEARCH_INFO_MODE || "table")}\n\n\n`)
                webSearchInfo = null
              } else if (!thinkingEnabled) {
                content = `<think>\n${await accountManager.generateMarkdownTable(webSearchInfo, process.env.SEARCH_INFO_MODE || "table")}\n</think>\n${content}`
                webSearchInfo = null
              }
            }
            // console.log(content)
            // 确保有内容才发送
            if (content) {
              const StreamTemplate = {
                "id": `chatcmpl-${id}`,
                "object": "chat.completion.chunk",
                "created": new Date().getTime(),
                "choices": [
                  {
                    "index": 0,
                    "delta": {
                      "content": content
                    },
                    "finish_reason": null
                  }
                ]
              }
              res.write(`data: ${JSON.stringify(StreamTemplate)}\n\n`)
            }
          } catch (error) {
            console.log(error)
            res.status(500).json({ error: "服务错误!!!" })
          }
        }
      })

      response.on('end', async () => {
        if (process.env.OUTPUT_THINK === "false" && webSearchInfo) {
          const webSearchTable = await accountManager.generateMarkdownTable(webSearchInfo, process.env.SEARCH_INFO_MODE || "table")
          res.write(`data: ${JSON.stringify({
            "id": `chatcmpl-${id}`,
            "object": "chat.completion.chunk",
            "created": new Date().getTime(),
            "choices": [
              {
                "index": 0,
                "delta": {
                  "content": `\n\n\n${webSearchTable}`
                }
              }
            ]
          })}\n\n`)
        }
        res.write(`data: [DONE]\n\n`)
        res.end()
      })
    } catch (error) {
      console.log(error)
      res.status(500).json({ error: "服务错误!!!" })
    }
  }

  try {
    let response_data = null
    if (req.body.model.includes('-draw')) {
      response_data = await createImageRequest(req.body.messages[req.body.messages.length - 1].content, req.body.model, '1024*1024', authToken)
      console.log(response_data)
    } else {
      response_data = await sendChatRequest(req.body.model, messages, stream, authToken)
    }

    if (response_data.status === !200 || !response_data.response) {
      res.status(500)
        .json({
          error: "请求发送失败！！！"
        })
      return
    }

    if (req.body.model.includes('-draw')) {
      response_data = await awaitImage(response_data.response, authToken)
      if (response_data.status !== 200) {
        res.status(500)
          .json({
            error: "请求发送失败！！！"
          })
        return
      }
    }

    if (stream) {
      if (req.body.model.includes('-draw')) {
        const StreamTemplate = {
          "id": `chatcmpl-${uuid.v4()}`,
          "object": "chat.completion.chunk",
          "created": new Date().getTime(),
          "choices": [
            {
              "index": 0,
              "delta": {
                "content": `![${response_data.url}](${response_data.url})`
              },
              "finish_reason": null
            }
          ]
        }
        setResHeader(stream)
        res.write(`data: ${JSON.stringify(StreamTemplate)}\n\n`)
        res.write(`data: [DONE]\n\n`)
        res.end()
      } else {
        streamResponse(response_data.response, (req.body.model.includes('-thinking') || req.body.model.includes('qwq-32b')) ? true : false)
      }

    } else {
      if (req.body.model.includes('-draw')) {
        const bodyTemplate = {
          "id": `chatcmpl-${uuid.v4()}`,
          "object": "chat.completion",
          "created": new Date().getTime(),
          "model": req.body.model,
          "choices": [
            {
              "index": 0,
              "message": {
                "role": "assistant",
                "content": `![${response_data.url}](${response_data.url})`
              },
              "finish_reason": "stop"
            }
          ],
          "usage": {
            "prompt_tokens": 1024,
            "completion_tokens": 1024,
            "total_tokens": 2048
          }
        }
        setResHeader(stream)
        res.json(bodyTemplate)
      } else {
        notStreamResponse(response_data.response)
      }
    }

  } catch (error) {
    console.log(error)
    res.status(500)
      .json({
        error: "token无效,请求发送失败！！！"
      })
  }

})

module.exports = router