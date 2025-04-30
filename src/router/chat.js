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

  // 原有的流处理函数 - 处理传统模型
  const streamResponse = async (response, thinkingEnabled) => {
    try {
      const id = uuid.v4()
      const decoder = new TextDecoder('utf-8')
      let backContent = null
      let webSearchInfo = null
      let temp_content = ''
      let thinkEnd = false

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
            let content = decodeJson.choices[0].delta.content

            if (backContent !== null) {
              content = content.replace(backContent, '')
            }

            backContent = decodeJson.choices[0].delta.content

            if (thinkingEnabled && process.env.OUTPUT_THINK === "false" && !thinkEnd && !backContent.includes("</think>")) {
              continue
            } else if (thinkingEnabled && process.env.OUTPUT_THINK === "false" && !thinkEnd && backContent.includes("</think>")) {
              content = content.replace("</think>", "")
              thinkEnd = true
            }

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

  // 新增函数 - 专门处理Qwen3系列模型的思考输出
  const streamResponseQwen3 = async (response, thinkingEnabled) => {
    try {
      const id = uuid.v4()
      const decoder = new TextDecoder('utf-8')
      let webSearchInfo = null
      let temp_content = ''
      
      // 核心变量：用于收集思考内容
      let completeThinkContent = ""  // 收集完整的思考内容(不含标签)
      let previousPhase = null       // 前一个阶段
      let currentPhase = null        // 当前阶段 
      let isInThinkingPhase = false  // 是否处于思考阶段
      let thinkEndSent = false       // 是否已发送思考结束标签
      let thinkStartSent = false     // 是否已发送思考开始标签
      let isFirstAnswerChunk = true  // 是否是答案阶段的第一个块
      
      // 设置响应头
      response.on('start', () => {
        setResHeader(true)
      })

      // 辅助函数：发送SSE消息
      const sendSSE = (content) => {
        if (!content || content.length === 0) return;
        
        console.log(`发送内容: "${content.substring(0, 30)}${content.length > 30 ? '...' : ''}" (长度: ${content.length})`)
        
        const streamTemplate = {
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
        res.write(`data: ${JSON.stringify(streamTemplate)}\n\n`)
      }

      // 处理数据块
      response.on('data', async (chunk) => {
        const decodeText = decoder.decode(chunk, { stream: true })
        console.log(`原始SSE块: ${decodeText.substring(0, 100)}${decodeText.length > 100 ? '...' : ''}`)
        
        // 解析数据块
        const lists = decodeText.split('\n').filter(item => item.trim() !== '')
        for (const item of lists) {
          try {
            // 解析JSON
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

            // 获取phase和status - 关键部分
            const phase = decodeJson.choices[0].delta.phase || ''
            const status = decodeJson.choices[0].delta.status || ''
            let content = decodeJson.choices[0].delta.content || ''
            
            console.log(`处理SSE块: Phase=${phase}, Status=${status}, Content长度=${content.length}`)
            
            // 检测phase变化 - 关键部分
            if (phase && phase !== currentPhase) {
              previousPhase = currentPhase
              currentPhase = phase
              console.log(`阶段转换: ${previousPhase || 'null'} -> ${phase}`)
              
              // 处理从think到answer的转换
              if (previousPhase === 'think' && currentPhase === 'answer') {
                console.log(`思考阶段结束，收集到的完整思考内容长度: ${completeThinkContent.length}`)
                
                // 如果未发送思考结束标签，发送它
                if (!thinkEndSent && thinkStartSent) {
                  sendSSE("</think>")
                  thinkEndSent = true
                }
                
                isFirstAnswerChunk = true
                isInThinkingPhase = false
              }
              // 处理进入think阶段
              else if (currentPhase === 'think') {
                isInThinkingPhase = true
              }
            }
            
            // 处理思考结束信号
            if (phase === 'think' && status === 'finished') {
              console.log('检测到思考阶段结束信号')
              
              // 如果未发送思考结束标签，发送它
              if (!thinkEndSent && thinkStartSent) {
                sendSSE("</think>")
                thinkEndSent = true
              }
              
              isInThinkingPhase = false
              continue  // 跳过空内容
            }
            
            // 没有内容则跳过
            if (!content || content.length === 0) continue
            
            // 处理思考阶段内容 - 关键部分
            if (isInThinkingPhase) {
              // 收集思考内容
              completeThinkContent += content
              
              // 第一个思考块需要添加标签
              if (!thinkStartSent) {
                content = "<think>" + content
                thinkStartSent = true
              }
              
              // 如果不显示思考，则不发送
              if (thinkingEnabled && process.env.OUTPUT_THINK === "false") {
                continue
              }
            }
            // 处理回答阶段内容 - 关键部分
            else if (currentPhase === 'answer') {
              // 关键逻辑：处理回答阶段的第一个消息
              if (isFirstAnswerChunk) {
                console.log(`处理首个回答块，内容长度: ${content.length}`)
                
                // 检查内容是否包含完整的思考内容
                if (completeThinkContent && completeThinkContent.length > 0) {
                  if (content.includes(completeThinkContent)) {
                    // 找到思考内容在全量回答中的位置
                    const index = content.indexOf(completeThinkContent)
                    
                    // 如果思考内容在开头，则直接截取后面部分
                    if (index === 0) {
                      content = content.substring(completeThinkContent.length)
                    }
                    // 如果思考内容在中间某处，可能是全量模式，分析情况
                    else {
                      // 尝试查找完整的<think>内容</think>位置
                      const thinkTagStart = content.indexOf("<think>")
                      const thinkTagEnd = content.indexOf("</think>")
                      
                      if (thinkTagStart >= 0 && thinkTagEnd > thinkTagStart) {
                        // 有完整思考标签，提取标签后的内容
                        content = content.substring(thinkTagEnd + 8) // 8是</think>的长度
                      } else {
                        // 没有完整标签，但有思考内容，直接跳过思考内容
                        content = content.substring(index + completeThinkContent.length)
                      }
                    }
                    
                    console.log(`移除完整思考内容后，剩余内容长度: ${content.length}`)
                  }
                  // 即使没有精确匹配，也尝试查找部分匹配
                  else {
                    // 寻找思考内容的后半部分是否在answer内容开头
                    for (let i = Math.floor(completeThinkContent.length / 2); i > 10; i--) {
                      const thinkEnd = completeThinkContent.substring(completeThinkContent.length - i)
                      if (content.startsWith(thinkEnd)) {
                        content = content.substring(i)
                        console.log(`通过部分匹配移除重叠内容，剩余长度: ${content.length}`)
                        break
                      }
                    }
                  }
                }
                
                isFirstAnswerChunk = false
              }
            }
            
            // 发送实际内容
            if (content && content.length > 0) {
              sendSSE(content)
            }
            
          } catch (error) {
            console.error('处理SSE块时出错:', error)
          }
        }
      })

      // 处理流结束
      response.on('end', async () => {
        // 处理搜索信息
        if (process.env.OUTPUT_THINK === "false" && webSearchInfo) {
          const webSearchTable = await accountManager.generateMarkdownTable(webSearchInfo, process.env.SEARCH_INFO_MODE || "table")
          sendSSE(`\n\n\n${webSearchTable}`)
        }
        
        console.log('SSE响应结束')
        res.write(`data: [DONE]\n\n`)
        res.end()
      })
    } catch (error) {
      console.error('streamResponseQwen3函数出错:', error)
      res.status(500).json({ error: "服务错误!!!" })
    }
  }

  // 结束
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
        // 判断是否为Qwen3模型并启用了思考模式
        const isQwen3 = req.body.model.startsWith('qwen3')
        const thinkingEnabled = (req.body.model.includes('-thinking') || req.body.model.includes('qwq-32b'))
        
        // 根据模型类型选择相应的处理函数
        if (isQwen3 && thinkingEnabled) {
          streamResponseQwen3(response_data.response, true)
        } else {
          streamResponse(response_data.response, thinkingEnabled)
        }
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