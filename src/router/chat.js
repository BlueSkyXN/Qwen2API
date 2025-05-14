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
    console.log('notStreamResponse 参数类型:', typeof response, response);
    setResHeader(false)
    try {
      if (!response || !response.choices || !Array.isArray(response.choices) || !response.choices[0]) {
        console.error('notStreamResponse: response.choices[0] 不存在', response);
        res.status(500).json({ error: "上游响应格式错误" });
        return;
      }
      console.log('notStreamResponse response:', JSON.stringify(response, null, 2));
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
              "content": response.choices[0].message ? response.choices[0].message.content : null
            },
            "finish_reason": "stop"
          }
        ],
        "usage": {
          "prompt_tokens": JSON.stringify(req.body.messages).length,
          "completion_tokens": response.choices[0].message ? response.choices[0].message.content.length : 0,
          "total_tokens": JSON.stringify(req.body.messages).length + (response.choices[0].message ? response.choices[0].message.content.length : 0)
        }
      }
      res.json(bodyTemplate)
    } catch (error) {
      console.log('notStreamResponse error:', error)
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
        console.log('streamResponse chunk:', decodeText); // 新增日志
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
      console.log('streamResponse error:', error)
      res.status(500).json({ error: "服务错误!!!" })
    }
  }

  // 新增函数 - 专门处理Qwen3系列模型的思考输出

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
          res.write(`data: ${JSON.stringify(streamTemplate)}\n\n`);
        };
  
        response.on('data', async (chunk) => {
          const rawChunkText = decoder.decode(chunk, { stream: true });
          console.log('streamResponseQwen3 chunk:', rawChunkText); // 新增日志
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
                const qwenContent = delta.content;
                const phase = delta.phase || currentPhase;
                const status = delta.status || '';
  
                if (phase && phase !== currentPhase) {
                  currentPhase = phase;
                }
  
                if (currentPhase === 'think') {
                  if (qwenContent !== null && qwenContent !== undefined) {
                      accumulatedThinkContent += qwenContent;
                      if (thinkingEnabled && process.env.OUTPUT_THINK !== "false") {
                          sendSSE(qwenContent, 'reasoning_delta');
                      }
                  }
                  if (status === 'finished') {
                  }
                }
                else if (currentPhase === 'answer') {
                  if (qwenContent !== null && qwenContent !== undefined) {
                      const currentFullQwenContent = qwenContent;
                      let newAnswerDelta = "";
  
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
                              const potentialDelta = currentFullQwenContent.substring(lastSentAnswerContent.length);
                              if(potentialDelta.length < currentFullQwenContent.length && potentialDelta.length > 0) {
                                  newAnswerDelta = potentialDelta;
                                  lastSentAnswerContent = currentFullQwenContent;
                              } else {
                                  newAnswerDelta = "";
                              }
                          }
                      }
  
                      if (newAnswerDelta.length > 0) {
                          sendSSE(newAnswerDelta, 'content_delta');
                      }
                  }
                   if (status === 'finished') {
                   }
                }
              } catch (error) {
              }
            }
          }
        });
  
        response.on('end', async () => {
          if (temp_content_buffer.trim().startsWith('data:')) {
          }
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
                    if (!res.writableEnded) res.end();
                }
            }
        });
  
      } catch (error) {
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
      console.log('createImageRequest 返回:', JSON.stringify(response_data, null, 2)); // 新增日志
    } else {
      response_data = await sendChatRequest(req.body.model, messages, stream, authToken)
      console.log('sendChatRequest 返回:', JSON.stringify(response_data, null, 2)); // 新增日志
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
        const isQwen3 = req.body.model.startsWith('qwen3')
        const thinkingEnabled = (req.body.model.includes('-thinking') || req.body.model.includes('qwq-32b'))
        
        if (isQwen3 && thinkingEnabled) {
          streamResponseQwen3(response_data.response, true)
        } else {
          streamResponse(response_data.response, thinkingEnabled)
        }
      }

    } else {
      console.log('主流程 response_data:', JSON.stringify(response_data, null, 2));
      console.log('主流程 response_data.response:', response_data ? JSON.stringify(response_data.response, null, 2) : response_data);
      notStreamResponse(response_data.response)
    }

  } catch (error) {
    console.log('主 try/catch error:', error)
    res.status(500)
      .json({
        error: "token无效,请求发送失败！！！"
      })
  }

})

module.exports = router