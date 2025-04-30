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

  // 新增函数 - 专门处理Qwen3系列模型的思考输出，完全重建SSE流，强制实现增量传输
  const streamResponseQwen3 = async (response, thinkingEnabled) => {
    try {
      const id = uuid.v4()
      const decoder = new TextDecoder('utf-8')
      let temp_content = ''
      let webSearchInfo = null
      
      // 状态追踪变量
      let completeContent = ""        // 已发送的全部内容
      let currentPhase = null         // 当前阶段
      let previousPhase = null        // 前一个阶段
      let isInThinkingPhase = false   // 是否处于思考阶段
      let hasFinishedThinking = false // 是否已完成思考
      let thinkContent = ""           // 完整思考内容
      let phaseJustChanged = false    // 阶段是否刚刚改变
      
      // 用于SSE响应头
      response.on('start', () => {
        setResHeader(true)
      })

      // 辅助函数：发送SSE消息
      const sendSSEChunk = (content) => {
        if (!content || content.length === 0) return;
        
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
        completeContent += content
      }

      // 处理收到的数据块
      response.on('data', async (chunk) => {
        const decodeText = decoder.decode(chunk, { stream: true })
        console.log('原始SSE块:', decodeText)
        
        // 解析SSE消息
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

            // 提取阶段信息和内容
            const phase = decodeJson.choices[0].delta.phase || ''
            const status = decodeJson.choices[0].delta.status || ''
            let content = decodeJson.choices[0].delta.content || ''
            
            console.log(`处理SSE块: Phase=${phase}, Status=${status}, Content长度=${content.length}`)
            
            // 检测阶段变化
            if (phase && phase !== previousPhase) {
              console.log(`阶段转换: ${previousPhase || 'null'} -> ${phase}`)
              previousPhase = currentPhase
              currentPhase = phase
              phaseJustChanged = true
              
              // 处理从think到answer的转换
              if (previousPhase === 'think' && currentPhase === 'answer') {
                if (!hasFinishedThinking) {
                  // 强制插入</think>结束标签
                  console.log('阶段转换: 强制插入思考结束标签')
                  sendSSEChunk("</think>")
                  hasFinishedThinking = true
                }
                isInThinkingPhase = false
              }
              
              // 处理从无到think的转换
              if (currentPhase === 'think' && !isInThinkingPhase) {
                isInThinkingPhase = true
                // 思考开始标签应该由首个内容块处理
              }
            }
            
            // 处理思考结束信号
            if (phase === 'think' && status === 'finished') {
              console.log('检测到思考阶段结束信号')
              if (isInThinkingPhase && !hasFinishedThinking) {
                sendSSEChunk("</think>")
                hasFinishedThinking = true
              }
              continue; // 跳过空消息
            }
            
            // 确定真正的增量内容
            if (content) {
              // 计算新内容
              let newContent = "";
              
              // 第一个think消息需要添加<think>标签
              if (currentPhase === 'think' && thinkContent === "" && content) {
                newContent = "<think>" + content;
                thinkContent += content;
              }
              // 检测是否是answer阶段的第一条消息（通常包含完整think内容）
              else if (currentPhase === 'answer' && phaseJustChanged && content.length > 0) {
                console.log("检测到answer阶段第一条消息，执行去重...");
                
                // 从全量内容中移除已知的思考内容
                if (thinkContent && content.includes(thinkContent)) {
                  // 找到思考内容在全量回答中的位置
                  const thinkPos = content.indexOf(thinkContent);
                  // 仅保留思考内容之后的部分作为真正新内容
                  newContent = content.substring(thinkPos + thinkContent.length);
                  console.log(`已移除重复的思考内容，提取的新内容长度：${newContent.length}`);
                } else {
                  // 如果无法精确匹配，使用完全去重算法
                  newContent = getUniquePart(content, completeContent);
                  console.log(`使用完全去重算法，提取的新内容长度：${newContent.length}`);
                }
                phaseJustChanged = false;
              }
              // 一般情况：增量更新
              else {
                // 检测重复内容，只保留新部分
                newContent = getUniquePart(content, completeContent);
                
                // 如果是思考阶段，更新累积的思考内容
                if (currentPhase === 'think') {
                  thinkContent += newContent;
                }
              }
              
              // 处理思考内容的显示/隐藏逻辑
              if (thinkingEnabled && process.env.OUTPUT_THINK === "false" && isInThinkingPhase) {
                // 不显示思考内容，但仍然跟踪它
                continue;
              }
              
              // 发送真正的增量内容
              if (newContent.length > 0) {
                sendSSEChunk(newContent);
              }
            }
          } catch (error) {
            console.log('处理SSE块时出错:', error)
            console.error(error);
          }
        }
      });

      // 流结束处理
      response.on('end', async () => {
        if (process.env.OUTPUT_THINK === "false" && webSearchInfo) {
          const webSearchTable = await accountManager.generateMarkdownTable(webSearchInfo, 
                                                    process.env.SEARCH_INFO_MODE || "table")
          sendSSEChunk(`\n\n\n${webSearchTable}`);
        }
        console.log('SSE响应结束')
        res.write(`data: [DONE]\n\n`)
        res.end()
      });
    } catch (error) {
      console.log('streamResponseQwen3函数出错:', error)
      res.status(500).json({ error: "服务错误!!!" })
    }
  };

  // 辅助函数：获取内容的真正新部分
  function getUniquePart(newContent, existingContent) {
    // 如果完全相同，则没有新内容
    if (newContent === existingContent) {
      return "";
    }
    
    // 如果新内容完全在已有内容中
    if (existingContent.includes(newContent)) {
      return "";
    }
    
    // 如果新内容包含已有内容（全量更新情况）
    if (newContent.includes(existingContent) && existingContent.length > 0) {
      return newContent.substring(existingContent.length);
    }
    
    // 寻找重叠部分
    // 两种重叠：1. 已有内容结尾与新内容开头重叠
    //         2. 新内容某个部分与已有内容完全匹配
    
    // 方法1：查找最大后缀-前缀重叠
    let maxOverlap = 0;
    if (existingContent.length > 0) {
      // 查找已有内容的后缀与新内容的前缀的最大重叠
      for (let i = 1; i <= Math.min(existingContent.length, newContent.length); i++) {
        if (existingContent.endsWith(newContent.substring(0, i))) {
          maxOverlap = i;
        }
      }
    }
    
    // 如果找到重叠，只保留新内容中未重叠的部分
    if (maxOverlap > 0) {
      return newContent.substring(maxOverlap);
    }
    
    // 方法2：查找子串匹配
    // 在新内容中找到与已有内容最长的匹配部分
    let maxMatchLength = 0;
    let matchEndPos = -1;
    
    // 只有当已有内容与新内容都较长时才进行这个计算
    if (existingContent.length > 5 && newContent.length > existingContent.length) {
      for (let i = 0; i < newContent.length - 5; i++) {
        for (let length = 5; length <= Math.min(existingContent.length, newContent.length - i); length++) {
          const substr = newContent.substring(i, i + length);
          if (existingContent.includes(substr) && length > maxMatchLength) {
            maxMatchLength = length;
            matchEndPos = i + length;
          }
        }
      }
    }
    
    // 如果找到大块匹配，只保留匹配后的内容
    if (maxMatchLength > 5 && matchEndPos > 0) {
      return newContent.substring(matchEndPos);
    }
    
    // 如果以上都不适用，返回整个新内容
    return newContent;
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