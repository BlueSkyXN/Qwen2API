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
      let webSearchInfo = null;
      let temp_content = '';

      let completeThinkContent = "";
      let completeAnswerContent = ""; // Tracks what was actually SENT as the answer
      let sentAnswerContentForDiffing = ""; // Tracks the last full raw content received in answer phase
      let previousPhase = null;
      let currentPhase = null;
      let isInThinkingPhase = false;
      let thinkEndSent = false;
      let thinkStartSent = false;
      // let sentChunks = []; // Keep if needed for debugging

      response.on('start', () => {
        setResHeader(true);
      });

      const sendSSE = (content) => {
        if (!content || content.length === 0) return;
        // console.log(`发送内容: "${content.substring(0, 30)}${content.length > 30 ? '...' : ''}" (长度: ${content.length})`);
        const streamTemplate = { /* ... as before ... */ };
        res.write(`data: ${JSON.stringify(streamTemplate)}\n\n`);
        // Only update completeAnswerContent if we are NOT in thinking phase
        if (!isInThinkingPhase) {
             completeAnswerContent += content;
        }
        // sentChunks.push(content); // Keep if needed
      };

      response.on('data', async (chunk) => {
        const decodeText = decoder.decode(chunk, { stream: true });
        // console.log(`原始SSE块: ${decodeText.substring(0, 100)}${decodeText.length > 100 ? '...' : ''}`);

        const lists = decodeText.split('\n').filter(item => item.trim() !== '');
        for (const item of lists) {
          try {
            let decodeJson = isJson(item.replace("data: ", '')) ? JSON.parse(item.replace("data: ", '')) : null;
            // ... (handle temp_content for fragmented JSON) ...
            if (decodeJson === null) continue;

            // ... (handle web_search info) ...

            const phase = decodeJson.choices[0].delta.phase || currentPhase || ''; // Use currentPhase if not provided in delta
            const status = decodeJson.choices[0].delta.status || '';
            let content = decodeJson.choices[0].delta.content || '';

            // console.log(`处理SSE块: Phase=${phase}, Status=${status}, Content长度=${content.length}, CurrentPhase=${currentPhase}, IsThinking=${isInThinkingPhase}`);

            // --- Phase Transition Detection ---
            if (phase && phase !== currentPhase) {
              previousPhase = currentPhase;
              currentPhase = phase;
              console.log(`阶段转换: ${previousPhase || 'null'} -> ${phase}`);

              if (previousPhase === 'think' && currentPhase === 'answer') {
                console.log(`思考阶段结束，准备进入回答阶段。`);
                if (thinkingEnabled && process.env.OUTPUT_THINK === "true" && thinkStartSent && !thinkEndSent) {
                  console.log("发送 </think> 标签");
                  sendSSE("</think>");
                  thinkEndSent = true;
                }
                // Reset answer tracking for diffing
                sentAnswerContentForDiffing = "";
                completeAnswerContent = ""; // Reset what's been sent as answer
                isInThinkingPhase = false;
              } else if (currentPhase === 'think') {
                isInThinkingPhase = true;
              }
            }

            // --- Handle 'think' phase finished signal ---
             if (phase === 'think' && status === 'finished') {
                console.log('检测到思考阶段结束信号 (status=finished)');
                if (thinkingEnabled && process.env.OUTPUT_THINK === "true" && thinkStartSent && !thinkEndSent) {
                    console.log("发送 </think> 标签 (基于 status=finished)");
                    sendSSE("</think>");
                    thinkEndSent = true;
                }
                isInThinkingPhase = false;
                // Don't reset answer diffing here, wait for actual phase change event
                continue; // Often has empty content
            }


            // Skip empty content chunks unless it's the final closing tag
            if (!content && !(thinkingEnabled && process.env.OUTPUT_THINK === "true" && !thinkEndSent && currentPhase === 'answer' && previousPhase === 'think')) {
                 continue;
            }


            // --- Content Processing by Phase ---
            if (isInThinkingPhase || phase === 'think') {
              // Accumulate thinking content
              completeThinkContent += content;

              // Send thinking content if enabled
              if (thinkingEnabled && process.env.OUTPUT_THINK === "true") {
                if (!thinkStartSent) {
                  console.log("发送 <think> 标签 + 首个思考内容");
                  sendSSE("<think>" + content);
                  thinkStartSent = true;
                } else {
                  sendSSE(content);
                }
              }
            } else if (currentPhase === 'answer' || phase === 'answer') {
              // Ensure we are marked as not in thinking phase
              isInThinkingPhase = false;

              const newFullContent = content; // It's cumulative in answer phase

              if (sentAnswerContentForDiffing === "") {
                // --- First Answer Chunk ---
                console.log("处理首个回答块");
                let actualAnswerStart = newFullContent;

                // Attempt to remove the thinking part if it exists
                if (completeThinkContent && newFullContent.includes(completeThinkContent)) {
                    const thinkIndex = newFullContent.indexOf(completeThinkContent);
                    actualAnswerStart = newFullContent.substring(thinkIndex + completeThinkContent.length);
                    console.log(`从首个回答块移除思考内容，剩余长度: ${actualAnswerStart.length}`);
                    // Remove potential leading </think> tag if it was part of the raw output
                     if (actualAnswerStart.startsWith("</think>")) {
                         actualAnswerStart = actualAnswerStart.substring("</think>".length);
                         console.log("移除前导 </think> 标签");
                     }
                } else {
                    console.log("警告：首个回答块未找到预期的思考内容。");
                    // Might still need to remove a </think> if it appears
                    if (actualAnswerStart.startsWith("</think>")) {
                         actualAnswerStart = actualAnswerStart.substring("</think>".length);
                         console.log("移除前导 </think> 标签 (无思考内容匹配)");
                     }
                }


                if (actualAnswerStart.length > 0) {
                    sendSSE(actualAnswerStart); // Send the extracted first part
                }
                sentAnswerContentForDiffing = newFullContent; // Store the *full* raw content for next diff

              } else {
                // --- Subsequent Answer Chunks ---
                let incrementalContent = "";
                if (newFullContent.startsWith(sentAnswerContentForDiffing)) {
                  incrementalContent = newFullContent.substring(sentAnswerContentForDiffing.length);
                // Optional: Add more robust diffing here if needed
                // } else if (newFullContent.length > sentAnswerContentForDiffing.length) {
                  // // Fallback: Maybe model corrected something? Find longest common prefix?
                  // console.warn("回答块不以先前内容开头，尝试寻找增量...");
                  // // Basic fallback: send the difference in length - risky
                  // incrementalContent = newFullContent.substring(sentAnswerContentForDiffing.length);
                } else if (newFullContent === sentAnswerContentForDiffing) {
                    // Content is identical, do nothing
                    incrementalContent = "";
                    console.log("内容与上次相同，跳过发送。");
                }
                 else {
                    console.warn(`回答块内容异常: 新内容 (len ${newFullContent.length}) 不以旧内容 (len ${sentAnswerContentForDiffing.length}) 开头。可能需要更复杂的 diff 或模型流异常。将重新同步。`);
                    // Resync: Send the new content entirely? Or just the end part?
                    // Safest might be to send the part that *doesn't* overlap if possible,
                    // but for now, let's just update the diff base and send nothing this round,
                    // or send the whole thing if it's significantly different.
                    // If the new content is SHORTER, it's definitely weird.
                    // Let's just update the base and not send for now to avoid duplication risk.
                    incrementalContent = ""; // Avoid sending potentially wrong diff
                }

                if (incrementalContent.length > 0) {
                  sendSSE(incrementalContent);
                }
                // Always update the base for the next comparison
                sentAnswerContentForDiffing = newFullContent;
              }
            }

          } catch (error) {
            console.error('处理SSE块时出错:', error, 'Item:', item);
          }
        }
      });

      response.on('end', async () => {
        console.log('SSE响应结束');
        // Final check for closing think tag if needed
        if (thinkingEnabled && process.env.OUTPUT_THINK === "true" && thinkStartSent && !thinkEndSent) {
            console.log("发送最终 </think> 标签 (on end)");
            sendSSE("</think>");
            thinkEndSent = true; // Mark as sent
        }
        // ... (handle webSearchInfo if OUTPUT_THINK is false) ...
        res.write(`data: [DONE]\n\n`);
        res.end();
      });

    } catch (error) {
      console.error('streamResponseQwen3函数出错:', error);
      res.status(500).json({ error: "服务错误!!!" });
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