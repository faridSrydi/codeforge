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
    let systemText = typeof system === 'string'
      ? system
      : Array.isArray(system)
        ? system.map(b => b.text || '').join('\n')
        : '';

    const availableToolNames = ollamaTools ? ollamaTools.map(t => t.function.name).join(', ') : '';

    systemText += `\n\nAUTONOMOUS AGENT OPERATING DIRECTIVES:
1. You are CodeForge AI, an autonomous software engineer working directly in the user's project workspace directory.
2. You have native tool execution capabilities: [${availableToolNames}].
3. Whenever the user requests any project task (such as "buatkan website portfolio", "tambahkan navbar", "buat landing page"), YOU MUST IMMEDIATELY CALL THE APPROPRIATE TOOLS to write the files directly to disk.
4. DO NOT output code blocks or tutorial text telling the user to copy/paste or save files manually. EXECUTE THE TOOL CALLS DIRECTLY.
5. Take full autonomous initiative: automatically create all necessary project files (e.g. index.html, style.css, script.js) right away using your tools.`;

    ollamaMessages.push({ role: 'system', content: systemText });

    // Convert messages — properly handle tool_result as Ollama 'tool' role
    for (const msg of messages) {
      if (typeof msg.content === 'string') {
        ollamaMessages.push({ role: msg.role === 'assistant' ? 'assistant' : 'user', content: msg.content });
      } else if (Array.isArray(msg.content)) {
        let textContent = '';
        const toolCalls = [];
        const toolResults = [];

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
            toolResults.push({ role: 'tool', content: resContent });
          }
        }

        // Push assistant message with tool_calls if present
        if (msg.role === 'assistant') {
          const msgObj = { role: 'assistant', content: textContent || '' };
          if (toolCalls.length > 0) {
            msgObj.tool_calls = toolCalls;
          }
          ollamaMessages.push(msgObj);
        } else {
          // User message
          if (textContent) {
            ollamaMessages.push({ role: 'user', content: textContent });
          }
          // Push tool results as separate 'tool' role messages
          for (const tr of toolResults) {
            ollamaMessages.push(tr);
          }
        }
      }
    }

    const ollamaModel = DEFAULT_MODEL;
    const hasTools = ollamaTools && ollamaTools.length > 0;

    // ── Build Ollama request body ──
    const ollamaRequestBody = {
      model: ollamaModel,
      messages: ollamaMessages,
      // CRITICAL: Force stream:false when tools are present!
      // Ollama/Qwen2.5-Coder does NOT reliably return tool_calls in streaming mode.
      stream: hasTools ? false : !!stream,
      ...(hasTools && { tools: ollamaTools }),
      options: {
        ...(temperature !== undefined && { temperature }),
        ...(top_p !== undefined && { top_p }),
        ...(max_tokens && { num_predict: max_tokens }),
        ...(stop_sequences && { stop: stop_sequences })
      }
    };

    console.log('[Proxy Debug] hasTools:', hasTools, '| toolCount:', ollamaTools?.length || 0, '| stream:', ollamaRequestBody.stream);
    if (hasTools) {
      console.log('[Proxy Debug] Tool names:', ollamaTools.map(t => t.function.name).join(', '));
    }

    // ── Streaming mode (only when NO tools, otherwise force non-streaming below) ──
    if (stream && !hasTools) {
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
          body: JSON.stringify(ollamaRequestBody)
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
              if (chunk.message?.content) {
                res.write(`event: content_block_delta\ndata: ${JSON.stringify({
                  type: 'content_block_delta',
                  index: 0,
                  delta: { type: 'text_delta', text: chunk.message.content }
                })}\n\n`);
              }
              if (chunk.done) {
                totalOutputTokens = chunk.eval_count || 0;
                totalInputTokens = chunk.prompt_eval_count || 0;
              }
            } catch (e) { /* skip */ }
          }
        }

        res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`);
        res.write(`event: message_delta\ndata: ${JSON.stringify({
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: totalOutputTokens }
        })}\n\n`);
        res.write(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
        res.end();

        logRequest({ userId: req.user.id, model: ollamaModel, inputTokens: totalInputTokens, outputTokens: totalOutputTokens, durationMs: Date.now() - startTime, status: 'success' });
      } catch (fetchErr) {
        res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'api_error', message: `Failed to connect to AI model: ${fetchErr.message}` } })}\n\n`);
        res.end();
        logRequest({ userId: req.user.id, model: ollamaModel, durationMs: Date.now() - startTime, status: 'error' });
      }
      return;
    }

    // ── Non-streaming mode (also used when tools are present + stream was requested) ──
    const simulateStream = stream && hasTools; // CLI asked for stream but we forced non-stream for tools

    const ollamaRes = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ollamaRequestBody)
    });

    if (!ollamaRes.ok) {
      const errorText = await ollamaRes.text();
      console.error('[Ollama API Error]', ollamaRes.status, errorText);
      const errorMsg = errorText.includes('not found')
        ? `AI Model "${ollamaModel}" is currently downloading/loading on VPS. Please wait a moment or run on VPS: docker exec -d codeforge-ollama ollama pull ${ollamaModel}`
        : `AI model error: ${errorText}`;
      logRequest({ userId: req.user.id, model: ollamaModel, durationMs: Date.now() - startTime, status: 'error' });

      if (simulateStream) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'api_error', message: errorMsg } })}\n\n`);
        res.end();
      } else {
        res.status(400).json({ type: 'error', error: { type: 'api_error', message: errorMsg } });
      }
      return;
    }

    const ollamaData = await ollamaRes.json();
    const inputTokens = ollamaData.prompt_eval_count || 0;
    const outputTokens = ollamaData.eval_count || 0;

    console.log('[Proxy Debug] Ollama response keys:', Object.keys(ollamaData));
    console.log('[Proxy Debug] message.content length:', ollamaData.message?.content?.length || 0);
    console.log('[Proxy Debug] message.tool_calls:', JSON.stringify(ollamaData.message?.tool_calls || 'none'));

    const contentBlocks = [];
    if (ollamaData.message?.content) {
      contentBlocks.push({ type: 'text', text: ollamaData.message.content });
    }

    // Determine stop_reason based on whether tool_calls are present
    let stopReason = 'end_turn';

    if (ollamaData.message?.tool_calls && Array.isArray(ollamaData.message.tool_calls)) {
      for (const tc of ollamaData.message.tool_calls) {
        contentBlocks.push({
          type: 'tool_use',
          id: `toolu_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
          name: tc.function.name,
          input: tc.function.arguments || {}
        });
      }
      if (ollamaData.message.tool_calls.length > 0) {
        stopReason = 'tool_use';
      }
    }

    logRequest({ userId: req.user.id, model: ollamaModel, inputTokens, outputTokens, durationMs: Date.now() - startTime, status: 'success' });

    // If CLI requested stream but we forced non-stream, simulate SSE from the complete response
    if (simulateStream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      const messageId = `msg_${Date.now()}`;
      res.write(`event: message_start\ndata: ${JSON.stringify({
        type: 'message_start',
        message: { id: messageId, type: 'message', role: 'assistant', content: [], model: ollamaModel, stop_reason: null, usage: { input_tokens: inputTokens, output_tokens: 0 } }
      })}\n\n`);

      let blockIndex = 0;

      // Emit text content block
      if (ollamaData.message?.content) {
        res.write(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: blockIndex, content_block: { type: 'text', text: '' } })}\n\n`);

        // Stream text in chunks for natural feel
        const fullText = ollamaData.message.content;
        const chunkSize = 20;
        for (let i = 0; i < fullText.length; i += chunkSize) {
          const textChunk = fullText.substring(i, i + chunkSize);
          res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: blockIndex, delta: { type: 'text_delta', text: textChunk } })}\n\n`);
        }
        res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: blockIndex })}\n\n`);
        blockIndex++;
      }

      // Emit tool_use blocks
      if (ollamaData.message?.tool_calls && Array.isArray(ollamaData.message.tool_calls)) {
        for (const tc of ollamaData.message.tool_calls) {
          const toolUseId = `toolu_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
          res.write(`event: content_block_start\ndata: ${JSON.stringify({
            type: 'content_block_start',
            index: blockIndex,
            content_block: { type: 'tool_use', id: toolUseId, name: tc.function.name, input: {} }
          })}\n\n`);

          // Send input as input_json_delta
          const inputStr = JSON.stringify(tc.function.arguments || {});
          res.write(`event: content_block_delta\ndata: ${JSON.stringify({
            type: 'content_block_delta',
            index: blockIndex,
            delta: { type: 'input_json_delta', partial_json: inputStr }
          })}\n\n`);

          res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: blockIndex })}\n\n`);
          blockIndex++;
        }
      }

      res.write(`event: message_delta\ndata: ${JSON.stringify({
        type: 'message_delta',
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { output_tokens: outputTokens }
      })}\n\n`);
      res.write(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
      res.end();
      return;
    }

    // ── Return Anthropic-compatible JSON response (true non-stream) ──
    res.json({
      id: `msg_${Date.now()}`,
      type: 'message',
      role: 'assistant',
      content: contentBlocks,
      model: ollamaModel,
      stop_reason: stopReason,
      stop_sequence: null,
      usage: { input_tokens: inputTokens, output_tokens: outputTokens }
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
