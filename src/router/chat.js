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
  // 完全重写的streamResponseQwen3函数 - 双路径处理方案
  const streamResponseQwen3 = async (response, thinkingEnabled) => {
    try {
      const id = uuid.v4();
      const decoder = new TextDecoder('utf-8');
      let webSearchInfo = null;
      let temp_content = '';
      
      // Phase跟踪状态
      let currentPhase = null;
      let previousPhase = null;
      let hasFinishedThinking = false;
      let isFirstAnswerChunk = true;
      
      // 思考阶段内容累积
      let thinkContentBuffer = '';
      let hasOutputThinkStart = false;
      
      // 回答阶段内容累积
      let answerBuffer = '';
      let lastSentContentLength = 0;
      
      response.on('start', () => {
        setResHeader(true);
      });

      response.on('data', async (chunk) => {
        const decodeText = decoder.decode(chunk, { stream: true });
        
        // 调试日志
        console.log('原始SSE块:', decodeText);
        
        const lists = decodeText.split('\n').filter(item => item.trim() !== '');
        
        for (const item of lists) {
          try {
            // 解析JSON
            let decodeJson = null;
            try {
              decodeJson = JSON.parse(item.replace("data: ", ''));
            } catch (e) {
              // 处理不完整的JSON
              temp_content += item;
              try {
                decodeJson = JSON.parse(temp_content.replace("data: ", ''));
                temp_content = '';
              } catch (e2) {
                continue; // 继续累积
              }
            }
            
            if (!decodeJson) continue;
            
            // 提取基本信息
            const phase = decodeJson.choices[0].delta.phase || '';
            const status = decodeJson.choices[0].delta.status || '';
            const content = decodeJson.choices[0].delta.content || '';
            
            console.log(`处理块: phase=${phase}, status=${status}, content长度=${content.length}`);
            
            // 处理web_search信息
            if (decodeJson.choices[0].delta.name === 'web_search') {
              webSearchInfo = decodeJson.choices[0].delta.extra.web_search_info;
            }
            
            // 检测phase变更
            if (phase && phase !== currentPhase) {
              previousPhase = currentPhase;
              currentPhase = phase;
              console.log(`阶段转换: ${previousPhase || 'null'} -> ${currentPhase}`);
              
              // 从think切换到answer
              if (previousPhase === 'think' && currentPhase === 'answer') {
                if (!hasFinishedThinking) {
                  // 发送思考结束标签
                  sendChunk(res, id, "</think>");
                  hasFinishedThinking = true;
                }
                isFirstAnswerChunk = true;
                thinkContentBuffer = ''; // 清空思考缓冲
              }
            }
            
            // ===== 思考阶段处理 =====
            if (phase === 'think') {
              // 思考开始
              if (!hasOutputThinkStart && content) {
                sendChunk(res, id, "<think>" + content);
                hasOutputThinkStart = true;
                thinkContentBuffer += content;
                continue;
              }
              
              // 思考结束信号
              if (status === 'finished') {
                console.log('检测到思考结束信号');
                if (!hasFinishedThinking) {
                  sendChunk(res, id, "</think>");
                  hasFinishedThinking = true;
                }
                continue;
              }
              
              // 普通思考内容 - 如果显示思考
              if (process.env.OUTPUT_THINK !== "false" && content) {
                sendChunk(res, id, content);
                thinkContentBuffer += content;
              } else {
                // 不显示但继续累积思考内容
                thinkContentBuffer += content;
              }
            }
            
            // ===== 回答阶段处理 =====
            else if (phase === 'answer') {
              // 检测第一个answer块(通常包含重复内容)
              if (isFirstAnswerChunk) {
                console.log('处理answer阶段第一个数据块，长度:', content.length);
                
                // 检测是否包含思考内容(简化版 - 长度启发式)
                if (content.length > 100) {
                  console.log('检测到第一个answer块可能包含重复内容，尝试提取增量...');
                  
                  // 尝试查找非重复部分 - 假设思考内容后面跟着的是新内容
                  let newContent = '';
                  
                  // 启发式: 查找思考内容的最后一句话，然后取其后的内容
                  const lastSentenceFromThink = extractLastSentence(thinkContentBuffer);
                  if (lastSentenceFromThink && lastSentenceFromThink.length > 10) {
                    const lastSentencePos = content.lastIndexOf(lastSentenceFromThink);
                    if (lastSentencePos > 0) {
                      newContent = content.substring(lastSentencePos + lastSentenceFromThink.length);
                      console.log(`找到思考内容的最后一句话"${lastSentenceFromThink.slice(0, 30)}..."，提取后续内容`);
                    }
                  }
                  
                  // 如果上面的方法失败，尝试简单的启发式
                  if (!newContent) {
                    // 启发式方法：取内容的最后三分之一作为增量
                    const cutPoint = Math.floor(content.length * 2 / 3);
                    newContent = content.substring(cutPoint);
                    console.log(`使用简单启发式，取内容后三分之一(${newContent.length}字符)作为增量`);
                  }
                  
                  if (newContent && newContent.trim()) {
                    sendChunk(res, id, newContent);
                    answerBuffer = newContent;
                  }
                  
                  isFirstAnswerChunk = false;
                  continue;
                }
              }
              
              // 后续answer块正常处理
              if (content) {
                // 简单增量处理：去除可能重复的部分
                let newContent = content;
                
                // 检测与已发送内容的重叠
                if (answerBuffer) {
                  // 检查尾部/头部重叠
                  let overlapSize = 0;
                  const maxCheck = Math.min(answerBuffer.length, content.length);
                  
                  // 尾部-头部重叠检查
                  for (let i = 1; i <= maxCheck; i++) {
                    if (answerBuffer.endsWith(content.substring(0, i))) {
                      overlapSize = i;
                    }
                  }
                  
                  // 如果有显著重叠，截取非重叠部分
                  if (overlapSize > 5) {
                    newContent = content.substring(overlapSize);
                    console.log(`检测到${overlapSize}字符的重叠，截取后续内容`);
                  }
                }
                
                // 添加到缓冲并发送
                if (newContent && newContent.trim()) {
                  sendChunk(res, id, newContent);
                  answerBuffer += newContent;
                }
              }
              
              isFirstAnswerChunk = false;
            }
            
          } catch (error) {
            console.log('处理SSE块时出错:', error);
          }
        }
      });

      response.on('end', async () => {
        if (process.env.OUTPUT_THINK === "false" && webSearchInfo) {
          const webSearchTable = await accountManager.generateMarkdownTable(webSearchInfo, process.env.SEARCH_INFO_MODE || "table");
          sendChunk(res, id, `\n\n\n${webSearchTable}`);
        }
        console.log('SSE响应结束');
        res.write(`data: [DONE]\n\n`);
        res.end();
      });
    } catch (error) {
      console.log('streamResponseQwen3函数出错:', error);
      res.status(500).json({ error: "服务错误!!!" });
    }
  };

// 辅助函数：发送内容块
function sendChunk(res, id, content) {
  if (!content || content.trim() === '') return;
  
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
  };
  res.write(`data: ${JSON.stringify(StreamTemplate)}\n\n`);
}

// 辅助函数：提取文本中的最后一个句子
function extractLastSentence(text) {
  if (!text) return '';
  
  // 简单的句子分隔符
  const sentenceDelimiters = ['. ', '! ', '? ', '。', '！', '？', '\n\n'];
  
  let lastPosition = -1;
  let delimiterUsed = '';
  
  // 找出最后出现的句子分隔符
  for (const delimiter of sentenceDelimiters) {
    const position = text.lastIndexOf(delimiter);
    if (position > lastPosition) {
      lastPosition = position;
      delimiterUsed = delimiter;
    }
  }
  
  // 如果找到分隔符，返回最后一个句子
  if (lastPosition >= 0) {
    return text.substring(lastPosition + delimiterUsed.length);
  }
  
  // 如果没有找到分隔符，返回整个文本
  return text;
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