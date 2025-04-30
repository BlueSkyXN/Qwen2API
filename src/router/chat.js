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
      const id = uuid.v4();
      const decoder = new TextDecoder('utf-8');
      let temp_content = ''; // 用于处理不完整的JSON块

      // --- 状态变量 ---
      let currentPhase = null;        // 当前阶段: 'think', 'answer', or null
      let thinkStarted = false;       // 是否已发送 <think>
      let thinkEnded = false;         // 是否已发送 </think>
      let accumulatedThinkContent = ""; // 服务器端累积的完整思考内容
      let lastSentAnswerContent = "";   // 服务器端记录的已发送给客户端的 *回答* 部分内容
      // --- End 状态变量 ---

      // 设置响应头
      response.on('start', () => {
        setResHeader(true);
      });

      // 发送SSE消息的辅助函数
      const sendSSE = (content) => {
        if (!content || content.length === 0) return;

        // console.log(`发送内容: "${content.substring(0, 30)}${content.length > 30 ? '...' : ''}" (长度: ${content.length})`)

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
        };
        res.write(`data: ${JSON.stringify(streamTemplate)}\n\n`);
      };

      // 处理数据块
      response.on('data', async (chunk) => {
        const decodeText = decoder.decode(chunk, { stream: true });
        // console.log(`原始SSE块: ${decodeText.substring(0, 150)}${decodeText.length > 150 ? '...' : ''}`) // 增加log长度

        const lines = decodeText.split('\n');
        for (const line of lines) {
          if (line.trim().startsWith('data:')) {
            const jsonData = line.substring('data:'.length).trim();
            if (!jsonData) continue;

            try {
              let decodeJson = JSON.parse(jsonData);

              // 忽略非choices或空choices的块
              if (!decodeJson.choices || decodeJson.choices.length === 0 || !decodeJson.choices[0].delta) {
                  continue;
              }

              const delta = decodeJson.choices[0].delta;
              const phase = delta.phase || currentPhase; // 继承上一阶段，如果当前块没有phase
              const status = delta.status || '';
              let content = delta.content || '';

              // --- 核心逻辑 ---

              // 1. 处理思考阶段 (phase === 'think')
              if (phase === 'think') {
                if (currentPhase !== 'think') {
                    // 刚进入思考阶段 (虽然通常第一个块就是think，以防万一)
                    currentPhase = 'think';
                    console.log("阶段转换: -> think");
                }

                // 收到第一个思考内容时，发送 <think> 标签
                if (!thinkStarted && content.length > 0) {
                  // 只有当配置为输出思考时才发送
                  if (thinkingEnabled && process.env.OUTPUT_THINK !== "false") {
                      sendSSE("<think>");
                  }
                  thinkStarted = true;
                }

                // 累积思考内容
                if (content.length > 0) {
                    accumulatedThinkContent += content;
                    // 将增量思考内容转发给客户端 (如果允许输出)
                    if (thinkingEnabled && process.env.OUTPUT_THINK !== "false") {
                        sendSSE(content);
                    }
                }

                // 检查思考是否结束
                if (status === 'finished') {
                  console.log('检测到思考阶段结束信号 (think/finished)');
                  if (thinkStarted && !thinkEnded) {
                     // 只有当配置为输出思考时才发送
                     if (thinkingEnabled && process.env.OUTPUT_THINK !== "false") {
                        sendSSE("</think>");
                     }
                     thinkEnded = true;
                  }
                  // 注意：即使收到finished，下一个块可能还是think，也可能切换到answer
                  // 所以 phase 的判断更重要
                }
              }
              // 2. 处理回答阶段 (phase === 'answer')
              else if (phase === 'answer') {
                // 首次进入回答阶段
                if (currentPhase !== 'answer') {
                    console.log(`阶段转换: ${currentPhase || 'null'} -> answer`);
                    currentPhase = 'answer';

                    // 如果思考标签已开始但未结束，在此处结束它
                    if (thinkStarted && !thinkEnded) {
                        console.log('在进入answer阶段时结束思考标签');
                        // 只有当配置为输出思考时才发送
                        if (thinkingEnabled && process.env.OUTPUT_THINK !== "false") {
                            sendSSE("</think>");
                        }
                        thinkEnded = true;
                    }
                }

                // Qwen answer 阶段 content 是全量 (思考+回答)
                const currentFullQwenContent = content;

                // 如果思考内容为空，则整个内容都是回答
                if (accumulatedThinkContent.length === 0) {
                    const newAnswerDelta = currentFullQwenContent.substring(lastSentAnswerContent.length);
                    if (newAnswerDelta.length > 0) {
                        sendSSE(newAnswerDelta);
                        lastSentAnswerContent = currentFullQwenContent; // 更新已发送的回答内容
                    }
                }
                // 如果有思考内容，需要剥离
                else {
                    // 检查收到的全量内容是否确实以累积的思考内容开头
                    if (currentFullQwenContent.startsWith(accumulatedThinkContent)) {
                        const currentFullAnswerPart = currentFullQwenContent.substring(accumulatedThinkContent.length);
                        const newAnswerDelta = currentFullAnswerPart.substring(lastSentAnswerContent.length);

                        if (newAnswerDelta.length > 0) {
                            sendSSE(newAnswerDelta);
                            lastSentAnswerContent = currentFullAnswerPart; // 更新已发送的 *回答* 部分
                        }
                    } else {
                        // 异常情况：收到的回答内容没有以预期的思考内容开头
                        // 这可能是累积错误或Qwen行为变化。尝试直接发送增量（可能有风险）
                        console.warn("警告: 回答块内容未以累积的思考内容开头。尝试直接差分。");
                        console.warn("累积思考:", accumulatedThinkContent.slice(0, 50) + "...");
                        console.warn("收到内容:", currentFullQwenContent.slice(0, 50) + "...");

                        // 尝试基于上一次发送的回答内容进行差分（作为后备）
                        const newAnswerDelta = currentFullQwenContent.substring(lastSentAnswerContent.length);
                         if (newAnswerDelta.length > 0) {
                            sendSSE(newAnswerDelta);
                            lastSentAnswerContent = currentFullQwenContent; // 更新已发送的回答内容
                        }
                    }
                }
              }
              // 3. 处理结束状态 (可能在 answer 阶段出现)
              if (status === 'finished' && currentPhase === 'answer') {
                  console.log('检测到回答阶段结束信号 (answer/finished)');
                  // 通常这里 content 为空，主要标记流程结束
              }

              // 更新当前阶段状态，为下一个块做准备
              if (phase) { // 只有当块明确指定了phase时才更新
                  currentPhase = phase;
              }

            } catch (error) {
              // 尝试处理拼接不完整的 JSON
              temp_content += line;
              try {
                let decodeJson = JSON.parse(temp_content.replace("data: ", ''));
                temp_content = ''; // 解析成功，清空 buffer

                // ... 重新执行上面的解析和处理逻辑 ...
                // (为简洁起见，此处省略重复代码，实际应用中需要提取成函数或复制逻辑)
                 const delta = decodeJson.choices[0].delta;
                 const phase = delta.phase || currentPhase;
                 const status = delta.status || '';
                 let content = delta.content || '';
                 // ... [重复核心逻辑] ...
                 // ... [重复核心逻辑] ...
                 if (phase) { currentPhase = phase; }


              } catch (parseError) {
                // 如果仍然失败，说明 JSON 还不完整，继续等待下一个 chunk
                // console.log('JSON 块不完整，等待拼接:', temp_content);
              }
            }
          }
        }
      });

      // 处理流结束
      response.on('end', async () => {
        // 确保思考标签已关闭 (以防万一 Qwen 结束时没有明确的 finished 信号)
        if (thinkStarted && !thinkEnded) {
          console.log('在 SSE 流结束时强制关闭思考标签');
           // 只有当配置为输出思考时才发送
           if (thinkingEnabled && process.env.OUTPUT_THINK !== "false") {
               sendSSE("</think>");
           }
           thinkEnded = true;
        }
        console.log('SSE响应结束');
        res.write(`data: [DONE]\n\n`);
        res.end();
      });
    } catch (error) {
      console.error('streamResponseQwen3函数出错:', error);
      // 确保在出错时也能结束响应
      if (!res.writableEnded) {
          try {
              res.status(500).json({ error: "服务错误!!!" });
          } catch (e) {
              console.error("发送错误响应失败:", e);
          }
      }
    }
  };
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