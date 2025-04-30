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

    // 函数：处理 Qwen3 流式输出，使用并行的 reasoning_content 和 content 字段
    const streamResponseQwen3 = async (response, thinkingEnabled) => {
      try {
        const id = uuid.v4();
        const decoder = new TextDecoder('utf-8');
        let temp_content_buffer = ''; // 用于处理不完整的JSON行缓冲
  
        // --- 状态变量 ---
        let currentPhase = null;        // 当前 Qwen 输出阶段: 'think', 'answer', 或 null
        let accumulatedThinkContent = ""; // 服务器端累积的完整思考内容
        let lastSentAnswerContent = "";   // 服务器端记录的、已发送给客户端的 *回答* 部分内容
        // --- End 状态变量 ---
  
        response.on('start', () => {
          setResHeader(true);
        });
  
        // 发送 SSE 数据块的辅助函数
        // type: 'reasoning_delta' -> 发送 reasoning_content
        // type: 'content_delta'  -> 发送 content
        const sendSSE = (deltaText, type = 'content_delta') => {
          if (deltaText === null || deltaText === undefined || deltaText.length === 0) {
            return;
          }
  
          // 构建 delta 负载
          const deltaPayload = {
            role: "assistant"
          };
  
          // *** 关键：根据类型填充不同的并行字段 ***
          if (type === 'reasoning_delta') {
            deltaPayload.reasoning_content = deltaText; // 填充 reasoning_content
            // deltaPayload.content = null; // 可以显式设为 null 或省略
          } else {
            deltaPayload.content = deltaText; // 填充 content
            // deltaPayload.reasoning_content = null; // 可以显式设为 null 或省略
          }
  
          // 构建 SSE 消息体
          const streamTemplate = {
            "id": `chatcmpl-${id}`,
            "object": "chat.completion.chunk",
            "created": new Date().getTime(),
            "choices": [
              {
                "index": 0,
                "delta": deltaPayload, // delta 内部包含并行字段
                "finish_reason": null
              }
            ]
          };
          // console.log(`发送 ${type} 块: ${JSON.stringify(streamTemplate)}`);
          res.write(`data: ${JSON.stringify(streamTemplate)}\n\n`);
        };
  
        response.on('data', async (chunk) => {
          const rawChunkText = decoder.decode(chunk, { stream: true });
          temp_content_buffer += rawChunkText;
  
          let lines = temp_content_buffer.split('\n');
          let completeLines = lines.slice(0, -1);
          temp_content_buffer = lines[lines.length - 1];
  
          for (const line of completeLines) {
            if (line.trim().startsWith('data:')) {
              const jsonData = line.substring('data:'.length).trim();
              if (!jsonData) continue;
  
              try {
                let decodeJson = JSON.parse(jsonData);
  
                if (!decodeJson.choices || decodeJson.choices.length === 0 || !decodeJson.choices[0].delta) {
                  continue;
                }
  
                const delta = decodeJson.choices[0].delta;
                // 注意：这里我们仍然需要读取 Qwen 原始 delta 中的 'content' 字段
                const qwenContent = delta.content;
                const phase = delta.phase || currentPhase;
                const status = delta.status || '';
  
                // --- 核心处理逻辑 ---
                if (phase && phase !== currentPhase) {
                  console.log(`阶段转换: ${currentPhase || 'null'} -> ${phase}`);
                  currentPhase = phase;
                }
  
                // 1. 处理思考阶段 ('think') -> 发送 reasoning_content
                if (currentPhase === 'think') {
                  // Qwen 的思考内容在 qwenContent 里
                  if (qwenContent !== null && qwenContent !== undefined) {
                      accumulatedThinkContent += qwenContent; // 累积思考内容
                      // 如果允许输出，发送包含 reasoning_content 的块
                      if (thinkingEnabled && process.env.OUTPUT_THINK !== "false") {
                          sendSSE(qwenContent, 'reasoning_delta'); // *** 发送推理内容 ***
                      }
                  }
                  if (status === 'finished') {
                    console.log('检测到思考阶段结束信号 (think/finished)');
                  }
                }
                // 2. 处理回答阶段 ('answer') -> 发送 content
                else if (currentPhase === 'answer') {
                   // Qwen 的回答内容（全量）也在 qwenContent 里
                  if (qwenContent !== null && qwenContent !== undefined) {
                      const currentFullQwenContent = qwenContent; // Qwen 的全量内容
                      let newAnswerDelta = ""; // 本次要发送的 *回答* 增量
  
                      // *** 关键的差分逻辑，处理 Qwen 全量输出 ***
                      if (accumulatedThinkContent.length === 0) {
                          newAnswerDelta = currentFullQwenContent.substring(lastSentAnswerContent.length);
                          if (newAnswerDelta.length > 0) {
                             lastSentAnswerContent = currentFullQwenContent;
                          }
                      } else {
                          if (currentFullQwenContent.startsWith(accumulatedThinkContent)) {
                              const currentFullAnswerPart = currentFullQwenContent.substring(accumulatedThinkContent.length);
                              newAnswerDelta = currentFullAnswerPart.substring(lastSentAnswerContent.length);
                              if (newAnswerDelta.length > 0) {
                                  lastSentAnswerContent = currentFullAnswerPart;
                              }
                          } else {
                              console.warn("警告: 回答块内容未以累积的思考内容开头。");
                              const potentialDelta = currentFullQwenContent.substring(lastSentAnswerContent.length);
                              if(potentialDelta.length < currentFullQwenContent.length && potentialDelta.length > 0) {
                                  console.warn("后备策略：基于 lastSentAnswerContent 进行差分。");
                                  newAnswerDelta = potentialDelta;
                                  lastSentAnswerContent = currentFullQwenContent;
                              } else {
                                  console.warn("后备策略失败，跳过发送。");
                                  newAnswerDelta = "";
                              }
                          }
                      }
  
                      // 发送计算出的回答增量（包含 content 字段）
                      if (newAnswerDelta.length > 0) {
                          sendSSE(newAnswerDelta, 'content_delta'); // *** 发送回答内容 ***
                      }
                  }
                   if (status === 'finished') {
                    console.log('检测到回答阶段结束信号 (answer/finished)');
                   }
                }
              } catch (error) {
                console.error('处理单个 SSE 行时出错:', line, error);
              }
            }
          }
        });
  
        response.on('end', async () => {
          if (temp_content_buffer.trim().startsWith('data:')) {
             console.warn("Stream 结束时缓冲区仍有未处理数据:", temp_content_buffer);
          }
          console.log('SSE 响应结束');
          const finalChunk = {
            "id": `chatcmpl-${id}`,
            "object": "chat.completion.chunk",
            "created": new Date().getTime(),
            "choices": [{ "index": 0, "delta": {}, "finish_reason": "stop" }]
          };
          res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
          res.write(`data: [DONE]\n\n`);
          res.end();
        });
  
        response.on('error', (err) => {
            console.error('Qwen API 响应流错误:', err);
            if (!res.writableEnded) {
                try {
                    const errorPayload = { error: { message: "与上游服务通信时出错", type: "upstream_error", code: err.code } };
                     res.write(`data: ${JSON.stringify({
                        "id": `chatcmpl-${id}`,
                        "object": "chat.completion.chunk",
                        "created": new Date().getTime(),
                        "choices": [{ "index": 0, "delta": errorPayload, "finish_reason": "error" }]
                     })}\n\n`);
                     res.write(`data: [DONE]\n\n`);
                     res.end();
                } catch (e) {
                    console.error("发送错误响应失败:", e);
                    if (!res.writableEnded) res.end();
                }
            }
        });
  
      } catch (error) {
        console.error('streamResponseQwen3 函数设置出错:', error);
        if (!res.headersSent && !res.writableEnded) {
            res.status(500).json({ error: {message: "服务器内部错误", type: "internal_server_error"} });
        } else if (!res.writableEnded) {
            res.end();
        }
      }
    }; // end streamResponseQwen3
    
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