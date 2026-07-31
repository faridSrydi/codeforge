import { Router } from 'express';
import { getUserById, getUserDailyRequestCount, logRequest } from '../db.js';

const router = Router();

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://ollama:11434';
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || 'qwen2.5-coder:14b';

/**
 * POST /v1/messages, /v1/beta/messages
 * Anthropic-compatible Messages API proxy → Ollama (with native Tool Use support)
 */
router.post(['/messages', '/v1/messages', '/beta/messages', '/'], async (req, res) => {
  const startTime = Date.now();

  try {
    // ── Rate limit check ──
    const user = getUserById(req.user.id);
    if (!user) {
      return res.status(401).json({
        type: 'error',
        error: { type: 'authentication_error', message: 'User not found.' }
      });
    }

    if (!user.isActive) {
      return res.status(403).json({
        type: 'error',
        error: { type: 'permission_error', message: 'Your account has been deactivated.' }
      });
    }

    const dailyCount = getUserDailyRequestCount(user.id);
    if (dailyCount >= user.maxRequestsPerDay) {
      return res.status(429).json({
        type: 'error',
        error: { type: 'rate_limit_error', message: `Daily request limit reached (${user.maxRequestsPerDay}). Try again tomorrow.` }
      });
    }

    // ── Parse Anthropic-format request ──
    const { messages, model, max_tokens, system, stream, temperature, top_p, stop_sequences, tools } = req.body;

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({
        type: 'error',
        error: { type: 'invalid_request_error', message: '"messages" field is required and must be an array.' }
      });
    }

    // Convert Anthropic tools → Ollama format
    const ollamaTools = Array.isArray(tools) && tools.length > 0 ? tools.map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description || '',
        parameters: t.input_schema || { type: 'object', properties: {} }
      }
    })) : undefined;

    // ── Convert Anthropic messages → Ollama format ──
    const ollamaMessages = [];

    // Add system prompt if provided
    if (system) {
      const systemText = typeof system === 'string'
        ? system
        : Array.isArray(system)
          ? system.map(b => b.text || '').join('\n')
          : '';
      if (systemText) {
        ollamaMessages.push({ role: 'system', content: systemText });
      }
    }

    // Convert messages
    for (const msg of messages) {
      const role = msg.role === 'assistant' ? 'assistant' : 'user';

      if (typeof msg.content === 'string') {
        ollamaMessages.push({ role, content: msg.content });
      } else if (Array.isArray(msg.content)) {
        let textContent = '';
        const toolCalls = [];

        for (const block of msg.content) {
          if (block.type === 'text') {
            textContent += (textContent ? '\n' : '') + block.text;
          } else if (block.type === 'tool_use') {
            toolCalls.push({
              function: {
                name: block.name,
                arguments: block.input || {}
              }
            });
          } else if (block.type === 'tool_result') {
            const resContent = typeof block.content === 'string'
              ? block.content
              : Array.isArray(block.content)
                ? block.content.map(b => b.text || '').join('\n')
                : JSON.stringify(block.content || '');
            textContent += `\n[Tool Result for ${block.tool_use_id}]:\n${resContent}`;
          }
        }

        const msgObj = { role, content: textContent };
        if (toolCalls.length > 0) {
          msgObj.tool_calls = toolCalls;
        }
        ollamaMessages.push(msgObj);
      }
    }

    const ollamaModel = DEFAULT_MODEL;

    // ── Streaming mode ──
    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      const messageId = `msg_${Date.now()}`;
      res.write(`event: message_start\ndata: ${JSON.stringify({
        type: 'message_start',
        message: {
          id: messageId,
          type: 'message',
          role: 'assistant',
          content: [],
          model: ollamaModel,
          stop_reason: null,
          usage: { input_tokens: 0, output_tokens: 0 }
        }
      })}\n\n`);

      res.write(`event: content_block_start\ndata: ${JSON.stringify({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' }
      })}\n\n`);

      try {
        const ollamaRes = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: ollamaModel,
            messages: ollamaMessages,
            stream: true,
            ...(ollamaTools && { tools: ollamaTools }),
            options: {
              ...(temperature !== undefined && { temperature }),
              ...(top_p !== undefined && { top_p }),
              ...(max_tokens && { num_predict: max_tokens }),
              ...(stop_sequences && { stop: stop_sequences })
            }
          })
        });

        if (!ollamaRes.ok) {
          const errorText = await ollamaRes.text();
          console.error('[Ollama API Error]', ollamaRes.status, errorText);
          const errorMsg = errorText.includes('not found')
            ? `AI Model "${ollamaModel}" is currently downloading/loading on VPS. Please wait a moment or run on VPS: docker exec -d codeforge-ollama ollama pull ${ollamaModel}`
            : `Ollama error: ${errorText}`;
          res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'api_error', message: errorMsg } })}\n\n`);
          res.end();
          return;
        }

        const reader = ollamaRes.body.getReader();
        const decoder = new TextDecoder();
        let totalOutputTokens = 0;
        let totalInputTokens = 0;
        let buffer = '';
        let currentBlockIndex = 0;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const chunk = JSON.parse(line);

              // Standard text content
              if (chunk.message?.content) {
                res.write(`event: content_block_delta\ndata: ${JSON.stringify({
                  type: 'content_block_delta',
                  index: currentBlockIndex,
                  delta: { type: 'text_delta', text: chunk.message.content }
                })}\n\n`);
              }

              // Tool calls from model
              if (chunk.message?.tool_calls && Array.isArray(chunk.message.tool_calls)) {
                for (const tc of chunk.message.tool_calls) {
                  currentBlockIndex++;
                  const toolUseId = `toolu_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
                  res.write(`event: content_block_start\ndata: ${JSON.stringify({
                    type: 'content_block_start',
                    index: currentBlockIndex,
                    content_block: {
                      type: 'tool_use',
                      id: toolUseId,
                      name: tc.function.name,
                      input: tc.function.arguments || {}
                    }
                  })}\n\n`);

                  res.write(`event: content_block_stop\ndata: ${JSON.stringify({
                    type: 'content_block_stop',
                    index: currentBlockIndex
                  })}\n\n`);
                }
              }

              if (chunk.done) {
                totalOutputTokens = chunk.eval_count || 0;
                totalInputTokens = chunk.prompt_eval_count || 0;
              }
            } catch (e) {
              // Skip malformed JSON lines
            }
          }
        }

        // Send content_block_stop
        res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`);

        // Send message_delta with stop reason
        res.write(`event: message_delta\ndata: ${JSON.stringify({
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: totalOutputTokens }
        })}\n\n`);

        // Send message_stop
        res.write(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);

        res.end();

        // Log request
        logRequest({
          userId: req.user.id,
          model: ollamaModel,
          inputTokens: totalInputTokens,
          outputTokens: totalOutputTokens,
          durationMs: Date.now() - startTime,
          status: 'success'
        });

      } catch (fetchErr) {
        res.write(`event: error\ndata: ${JSON.stringify({
          type: 'error',
          error: { type: 'api_error', message: `Failed to connect to AI model: ${fetchErr.message}` }
        })}\n\n`);
        res.end();

        logRequest({ userId: req.user.id, model: ollamaModel, durationMs: Date.now() - startTime, status: 'error' });
      }

      return;
    }

    // ── Non-streaming mode ──
    const ollamaRes = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: ollamaModel,
        messages: ollamaMessages,
        stream: false,
        ...(ollamaTools && { tools: ollamaTools }),
        options: {
          ...(temperature !== undefined && { temperature }),
          ...(top_p !== undefined && { top_p }),
          ...(max_tokens && { num_predict: max_tokens }),
          ...(stop_sequences && { stop: stop_sequences })
        }
      })
    });

    if (!ollamaRes.ok) {
      const errorText = await ollamaRes.text();
      console.error('[Ollama API Error]', ollamaRes.status, errorText);
      const errorMsg = errorText.includes('not found')
        ? `AI Model "${ollamaModel}" is currently downloading/loading on VPS. Please wait a moment or run on VPS: docker exec -d codeforge-ollama ollama pull ${ollamaModel}`
        : `AI model error: ${errorText}`;
      logRequest({ userId: req.user.id, model: ollamaModel, durationMs: Date.now() - startTime, status: 'error' });
      return res.status(400).json({
        type: 'error',
        error: { type: 'api_error', message: errorMsg }
      });
    }

    const ollamaData = await ollamaRes.json();
    const inputTokens = ollamaData.prompt_eval_count || 0;
    const outputTokens = ollamaData.eval_count || 0;

    const contentBlocks = [];
    if (ollamaData.message?.content) {
      contentBlocks.push({ type: 'text', text: ollamaData.message.content });
    }

    if (ollamaData.message?.tool_calls && Array.isArray(ollamaData.message.tool_calls)) {
      for (const tc of ollamaData.message.tool_calls) {
        contentBlocks.push({
          type: 'tool_use',
          id: `toolu_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
          name: tc.function.name,
          input: tc.function.arguments || {}
        });
      }
    }

    // Log request
    logRequest({
      userId: req.user.id,
      model: ollamaModel,
      inputTokens,
      outputTokens,
      durationMs: Date.now() - startTime,
      status: 'success'
    });

    // ── Return Anthropic-compatible response ──
    res.json({
      id: `msg_${Date.now()}`,
      type: 'message',
      role: 'assistant',
      content: contentBlocks,
      model: ollamaModel,
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens
      }
    });

  } catch (err) {
    console.error('[Proxy Error]', err);
    logRequest({ userId: req.user?.id, model: DEFAULT_MODEL, durationMs: Date.now() - startTime, status: 'error' });
    res.status(500).json({
      type: 'error',
      error: { type: 'api_error', message: `Proxy error: ${err.message}` }
    });
  }
});

/**
 * GET /v1/models
 * Returns available models (Anthropic-compatible format)
 */
router.get('/models', async (req, res) => {
  try {
    const ollamaRes = await fetch(`${OLLAMA_BASE_URL}/api/tags`);
    if (!ollamaRes.ok) {
      return res.json({ data: [{ id: DEFAULT_MODEL, object: 'model' }] });
    }
    const data = await ollamaRes.json();
    const models = (data.models || []).map(m => ({
      id: m.name,
      object: 'model',
      created: new Date(m.modified_at).getTime() / 1000,
      owned_by: 'self-hosted'
    }));
    res.json({ data: models });
  } catch {
    res.json({ data: [{ id: DEFAULT_MODEL, object: 'model' }] });
  }
});

export default router;
