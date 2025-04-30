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
      let backContent = null;
      let webSearchInfo = null;
      let temp_content = '';
      
      // 用于处理思考阶段的变量
      let completeThinkContent = '';  // 存储完整的思考内容
      let previousPhase = null;
      let isInThinkingPhase = false;
      let hasFinishedThinking = false;
      
      response.on('start', () => {
        setResHeader(true);
      });

      response.on('data', async (chunk) => {
        const decodeText = decoder.decode(chunk, { stream: true });
        
        // 开发调试日志 - 生产环境可注释
        console.log('原始SSE块:', decodeText);
        
        const lists = decodeText.split('\n').filter(item => item.trim() !== '');
        
        for (const item of lists) {
          try {
            let decodeJson = isJson(item.replace("data: ", '')) ? JSON.parse(item.replace("data: ", '')) : null;
            if (decodeJson === null) {
              temp_content += item;
              decodeJson = isJson(temp_content.replace("data: ", '')) ? JSON.parse(temp_content.replace("data: ", '')) : null;
              if (decodeJson === null) {
                continue;
              }
              temp_content = '';
            }

            // 处理web_search信息
            if (decodeJson.choices[0].delta.name === 'web_search') {
              webSearchInfo = decodeJson.choices[0].delta.extra.web_search_info;
            }

            // 获取phase和status
            const phase = decodeJson.choices[0].delta.phase || '';
            const status = decodeJson.choices[0].delta.status || '';
            
            // 处理内容
            let content = decodeJson.choices[0].delta.content || '';
            
            console.log(`处理SSE块: Phase=${phase}, Status=${status}, Content长度=${content.length}`);
            
            // --- 关键优化点1: 思考阶段结束处理 ---
            if (phase === 'think' && status === 'finished') {
              console.log('检测到思考阶段结束信号: phase=think, status=finished');
              
              // 当收到think结束信号时，发送</think>标签
              if (isInThinkingPhase && !hasFinishedThinking) {
                const endThinkTemplate = {
                  "id": `chatcmpl-${id}`,
                  "object": "chat.completion.chunk",
                  "created": new Date().getTime(),
                  "choices": [
                    {
                      "index": 0,
                      "delta": {
                        "content": "</think>"
                      },
                      "finish_reason": null
                    }
                  ]
                };
                res.write(`data: ${JSON.stringify(endThinkTemplate)}\n\n`);
                hasFinishedThinking = true;
              }
              
              // 重置临时内容状态，避免后续答案阶段包含思考内容
              backContent = null;
              content = '';
              continue;  // 跳过当前块，不发送空内容
            }
            
            // --- 关键优化点2: 阶段转换处理 ---
            if (phase && previousPhase !== phase) {
              console.log(`阶段转换: ${previousPhase || 'null'} -> ${phase}`);
              
              // 从无到think - 添加开始标签
              if (phase === 'think' && !isInThinkingPhase) {
                content = '<think>' + content;
                isInThinkingPhase = true;
                completeThinkContent = content; // 开始收集思考内容
              } 
              // 从think到answer - 确保思考已正常结束
              else if (previousPhase === 'think' && phase === 'answer') {
                // 如果没有明确的思考结束信号但阶段已转换，强制插入结束标签
                if (isInThinkingPhase && !hasFinishedThinking) {
                  console.log('检测到phase从think切换到answer，但无明确结束信号，插入结束标签');
                  const endThinkTemplate = {
                    "id": `chatcmpl-${id}`,
                    "object": "chat.completion.chunk",
                    "created": new Date().getTime(),
                    "choices": [
                      {
                        "index": 0,
                        "delta": {
                          "content": "</think>"
                        },
                        "finish_reason": null
                      }
                    ]
                  };
                  res.write(`data: ${JSON.stringify(endThinkTemplate)}\n\n`);
                  hasFinishedThinking = true;
                }
                
                isInThinkingPhase = false;
                
                // --- 关键优化点3: 解决重复内容问题 ---
                // 1. 检查当前content是否包含completeThinkContent (完整思考内容)
                if (content.includes(completeThinkContent)) {
                  content = content.replace(completeThinkContent, '');
                }
                
                // 2. 重置backContent，避免思考内容泄漏
                backContent = null;
              }
              
              previousPhase = phase;
            }
            
            // 在思考阶段收集完整内容
            if (phase === 'think' && content) {
              completeThinkContent += content;
            }

            // --- 关键优化点4: 更精确的增量内容计算 ---
            if (backContent !== null && content) {
              // 完全相同，跳过
              if (content === backContent) {
                continue;
              } 
              // 前缀重复，只取新部分
              else if (content.startsWith(backContent)) {
                content = content.substring(backContent.length);
              } 
              // 后缀重复，只取新部分
              else if (backContent.endsWith(content)) {
                continue; // 完全包含，跳过
              }
              // 部分重叠，查找最大重叠部分
              else {
                // 寻找最大重叠字符串
                let maxOverlap = 0;
                const minLength = Math.min(backContent.length, content.length);
                
                // 检查backContent结尾与content开头的重叠
                for (let i = 1; i <= minLength; i++) {
                  if (backContent.substring(backContent.length - i) === content.substring(0, i)) {
                    maxOverlap = i;
                  }
                }
                
                // 如果发现显著重叠，剪裁内容
                if (maxOverlap > 20) { // 阈值可调整
                  content = content.substring(maxOverlap);
                } else {
                  // 如果没有显著重叠，尝试简单替换
                  const testContent = content.replace(backContent, '');
                  if (testContent.length < content.length) {
                    content = testContent;
                  }
                  // 如果替换无效，保持原内容（可能是全新内容）
                }
              }
            }
            
            // 更新上一个内容
            if (content && content.trim() !== '') {
              backContent = decodeJson.choices[0].delta.content || '';
            }

            // 处理思考内容的显示/隐藏逻辑
            if (thinkingEnabled && process.env.OUTPUT_THINK === "false") {
              if (!hasFinishedThinking && isInThinkingPhase) {
                // 思考未结束且不显示思考内容时跳过
                continue;
              }
            }

            // 处理搜索信息
            if (webSearchInfo && process.env.OUTPUT_THINK === "true") {
              if (thinkingEnabled && content.includes("<think>")) {
                content = content.replace("<think>", `<think>\n\n\n${await accountManager.generateMarkdownTable(webSearchInfo, process.env.SEARCH_INFO_MODE || "table")}\n\n\n`);
                webSearchInfo = null;
              } else if (!thinkingEnabled) {
                content = `<think>\n${await accountManager.generateMarkdownTable(webSearchInfo, process.env.SEARCH_INFO_MODE || "table")}\n</think>\n${content}`;
                webSearchInfo = null;
              }
            }

            // 确保有内容才发送
            if (content && content.trim() !== '') {
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
          } catch (error) {
            console.log('处理SSE块时出错:', error);
            res.status(500).json({ error: "服务错误!!!" });
          }
        }
      });

      response.on('end', async () => {
        // 处理结束逻辑保持不变
        if (process.env.OUTPUT_THINK === "false" && webSearchInfo) {
          const webSearchTable = await accountManager.generateMarkdownTable(webSearchInfo, process.env.SEARCH_INFO_MODE || "table");
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
          })}\n\n`);
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