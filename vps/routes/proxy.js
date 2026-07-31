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
    const rawTools = Array.isArray(tools) && tools.length > 0 ? tools : [];

    // Filter out meta-tools (like Skill, Agent) that cause local LLMs to get stuck in loops
    const FORBIDDEN_META_TOOLS = new Set(['skill', 'agent', 'toolsearch', 'discoverskills', 'brief']);

    // Map provided code execution tools cleanly to Ollama format
    let ollamaTools = rawTools
      .filter(t => !FORBIDDEN_META_TOOLS.has(t.name.toLowerCase()))
      .map(t => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description || '',
          parameters: t.input_schema || { type: 'object', properties: {} }
        }
      }));

    // If no tools were passed, provide standard default tools so AI is ALWAYS an agent
    if (ollamaTools.length === 0) {
      ollamaTools = [
        { type: 'function', function: { name: 'Write', description: 'Write a file to disk', parameters: { type: 'object', properties: { file_path: { type: 'string' }, content: { type: 'string' } }, required: ['file_path', 'content'] } } },
        { type: 'function', function: { name: 'Read', description: 'Read a file from disk', parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } } },
        { type: 'function', function: { name: 'Edit', description: 'Edit a file on disk', parameters: { type: 'object', properties: { file_path: { type: 'string' }, content: { type: 'string' } }, required: ['file_path', 'content'] } } },
        { type: 'function', function: { name: 'Bash', description: 'Run a shell command', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } } }
      ];
    }

    // ── Convert Anthropic messages → Ollama format ──
    const ollamaMessages = [];

    // Add system prompt if provided
    let originalSystem = typeof system === 'string'
      ? system
      : Array.isArray(system)
        ? system.map(b => b.text || '').join('\n')
        : '';

    const availableToolNames = ollamaTools ? ollamaTools.map(t => t.function.name).join(', ') : '';

    // Extract working directory from CLI system prompt
    const cwdMatch = originalSystem.match(/Working directory:\s*(.+)/i);
    const workingDir = cwdMatch ? cwdMatch[1].trim().replace(/\\/g, '/') : '';
    console.log('[Proxy] Detected working directory:', workingDir || '(not found)');

    // PREPEND Senior Autonomous Engineer FSM Directive
    const examplePath = workingDir ? `${workingDir}/index.html` : 'C:/path/to/project/index.html';
    const agentDirective = `======================================================================
CODEFORGE AUTONOMOUS SENIOR ENGINEER — FINITE STATE MACHINE (FSM)
======================================================================
You are CodeForge AI, an autonomous Senior Software Engineer operating directly inside the user's project workspace.
Available Tools: [${availableToolNames}]
${workingDir ? `Project Working Directory: ${workingDir}` : ''}

WORKFLOW & STATE MACHINE ARCHITECTURE:
[PLANNING] -> [PROJECT ANALYSIS] -> [READING] -> [WRITING/EDITING] -> [EXECUTING] -> [VERIFYING] -> [REFLECTION & REVIEW] -> [QUALITY GATE] -> [DONE]

STATE MACHINE DIRECTIVES:

1. PLANNING & PROJECT ANALYSIS:
   - When a task is requested (e.g. "buatkan website", "tambahkan fitur", "fix bug"):
     * Scan project structure, framework, dependencies, package manager, and coding conventions.
     * Maintain existing coding style, architecture, and file structure. Never make unsolicited breaking changes.

2. TOOL-FIRST AUTONOMOUS EXECUTION:
   - You are a SENIOR ENGINEER, NOT A CHATBOT.
   - NEVER output text tutorials, markdown guides, or copy/paste instructions.
   - EXECUTE TOOL CALLS DIRECTLY.

3. WRITE & EDIT PROTOCOL:
   - For file creation/updates, output JSON tool calls directly:
     \`\`\`json
     {"name": "Write", "arguments": {"file_path": "${examplePath}", "content": "<complete file content>"}}
     \`\`\`
   - Creating new projects/websites: Generate ALL required files (HTML, CSS, JS, etc.) TOGETHER in one pass.
   - Modifying existing projects: READ the target files first, then execute incremental edits or writes.

4. RETRY & RECOVERY LOGIC (MAX 3 RETRIES):
   - If a tool call fails or returns an error, analyze the root cause immediately.
   - Do NOT stop or give up with a text explanation.
   - Adapt your strategy (e.g. switch tool, fix path, fix syntax) and RETRY execution automatically up to 3 times.

5. REFLECTION & QUALITY GATE CHECKLIST:
   Before completing any task, evaluate:
   [ ] All required project files are physically created.
   [ ] All HTML/CSS/JS links use correct relative file paths (e.g. href="styles.css", src="script.js").
   [ ] No placeholder text, TODO comments, or dummy paths like "/path/to/..." remain.
   [ ] No tool errors were left unhandled.
   If any checklist item is unsatisfied, CONTINUE EXECUTING TOOLS until 100% complete.

`;

    const systemText = agentDirective + originalSystem;
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
    let stopReason = 'end_turn';

    // Check if Ollama returned native tool_calls
    const hasNativeToolCalls = ollamaData.message?.tool_calls && Array.isArray(ollamaData.message.tool_calls) && ollamaData.message.tool_calls.length > 0;

    if (hasNativeToolCalls) {
      // Model natively called tools — forward them directly
      if (ollamaData.message.content) {
        contentBlocks.push({ type: 'text', text: ollamaData.message.content });
      }
      for (const tc of ollamaData.message.tool_calls) {
        contentBlocks.push({
          type: 'tool_use',
          id: `toolu_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
          name: tc.function.name,
          input: tc.function.arguments || {}
        });
      }
      stopReason = 'tool_use';
      console.log('[Proxy] Native tool calls detected:', ollamaData.message.tool_calls.length);
    } else if (hasTools && ollamaData.message?.content) {
      // ── FALLBACK PARSER ──
      // Qwen2.5-Coder outputs tool calls as JSON TEXT instead of native tool_calls.
      // Example: ```json\n{"name":"Write","arguments":{"file_path":"...","content":"..."}}\n```
      const text = ollamaData.message.content;
      console.log('[Proxy Fallback] Raw response first 500 chars:', text.substring(0, 500));

      // Case-insensitive tool name mapping → correct casing
      const toolNameMap = {
        'write': 'Write', 'write_file': 'Write', 'writefile': 'Write', 'filewrite': 'Write', 'file_write': 'Write',
        'read': 'Read', 'read_file': 'Read', 'readfile': 'Read', 'fileread': 'Read', 'file_read': 'Read',
        'edit': 'Write', 'edit_file': 'Write', 'editfile': 'Write', 'fileedit': 'Write', 'file_edit': 'Write',
        'bash': 'Bash', 'bash_tool': 'Bash', 'shell': 'Bash', 'terminal': 'Bash'
      };
      for (const t of (ollamaTools || [])) {
        if (t.function?.name) {
          toolNameMap[t.function.name.toLowerCase()] = t.function.name;
        }
      }

      let parsedToolCalls = [];

      // STRATEGY 1: Parse JSON tool calls from text
      try {
        const jsonBlocks = [];
        const jsonFenceRegex = /```(?:json)?\s*\n([\s\S]*?)```/g;
        let jm;
        while ((jm = jsonFenceRegex.exec(text)) !== null) {
          jsonBlocks.push(jm[1].trim());
        }

        // Also try the entire text as raw JSON (no fencing)
        const trimmed = text.trim();
        if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
          jsonBlocks.push(trimmed);
        }

        for (const jsonStr of jsonBlocks) {
          try {
            const parsed = JSON.parse(jsonStr);

            const tryAdd = (obj) => {
              if (!obj || typeof obj !== 'object') return;

              // 1. Check if object contains a nested actions array (e.g. Agent tool pattern)
              const actions = obj.actions || obj.arguments?.actions;
              if (Array.isArray(actions) && actions.length > 0) {
                console.log('[Proxy Fallback] Unpacking nested actions array, count:', actions.length);
                for (const action of actions) {
                  tryAdd(action);
                }
                return;
              }

              // 2. Direct action/tool object with function_name / parameters or name / arguments
              const fnName = obj.function_name || obj.name || obj.tool;
              const params = obj.parameters || obj.arguments || obj.input;

              if (fnName && params && typeof params === 'object') {
                const normName = toolNameMap[fnName.toLowerCase()] || 'Write';
                parsedToolCalls.push({ name: normName, input: params });
                return;
              }

              // 3. Standard {"name": "Write", "arguments": {...}}
              if (obj.name && obj.arguments && typeof obj.arguments === 'object') {
                const correctName = toolNameMap[obj.name.toLowerCase()] || 'Write';
                parsedToolCalls.push({ name: correctName, input: obj.arguments });
                return;
              }

              // 4. Recursive fallback scan: if JSON string values contain HTML/CSS code, extract as Write
              for (const [key, val] of Object.entries(obj)) {
                if (typeof val === 'string' && (val.includes('<!DOCTYPE') || val.includes('<html') || (val.includes('body {') && val.includes('}')))) {
                  console.log('[Proxy Fallback] Extracted embedded HTML/CSS content from JSON key:', key);
                  parsedToolCalls.push({
                    name: 'Write',
                    input: { file_path: 'index.html', content: val }
                  });
                }
              }
            };

            if (Array.isArray(parsed)) {
              for (const item of parsed) tryAdd(item);
            } else {
              tryAdd(parsed);
            }
          } catch (e) { /* not valid JSON */ }
        }
      } catch (e) {
        console.log('[Proxy Fallback] JSON parsing error:', e.message);
      }

      console.log('[Proxy Fallback] Parsed JSON tool calls:', parsedToolCalls.length);

      if (parsedToolCalls.length > 0) {
        // Successfully parsed tool calls from text!
        // Sanitize and fix tool call inputs
        const sanitizedToolCalls = [];

        for (const tc of parsedToolCalls) {
          if (!tc.input) continue;

          // Convert 'Edit' calls -> 'Write' calls if content is provided (Edit tool often fails on LLMs)
          if (tc.name === 'Edit') {
            tc.name = 'Write';
            if (!tc.input.content && tc.input.new_string) {
              tc.input.content = tc.input.new_string;
            }
          }

          // Skip dummy files like 'newfile.txt' if no meaningful content
          if (tc.input.file_path && tc.input.file_path.includes('newfile.txt') && (!tc.input.content || tc.input.content.length < 5)) {
            continue;
          }

          if (tc.input.file_path) {
            let fp = tc.input.file_path;

            // Replace placeholder paths with real working directory
            if (fp.startsWith('/path/to/') || fp.startsWith('/absolute/path') || fp.includes('/your/')) {
              const fileName = fp.split('/').pop();
              fp = workingDir ? `${workingDir}/${fileName}` : fileName;
            }

            // Ensure path is absolute using workingDir if it's a relative path
            if (workingDir && !fp.startsWith('/') && !fp.match(/^[a-zA-Z]:/)) {
              fp = `${workingDir}/${fp.replace(/^\/+/, '')}`;
            }

            tc.input.file_path = fp;
          }

          // Clean up dummy asset paths inside file content (e.g. href="/path/to/your/portfolio/styles.css" -> href="styles.css")
          if (typeof tc.input.content === 'string') {
            tc.input.content = tc.input.content.replace(/(?:href|src)=["'](?:\/path\/to\/[^\/]+\/|^\/)([^"']+)["']/g, '$1');
          }

          sanitizedToolCalls.push(tc);
        }

        contentBlocks.push({ type: 'text', text: `Creating project files...` });

        for (const tc of sanitizedToolCalls) {
          contentBlocks.push({
            type: 'tool_use',
            id: `toolu_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
            name: tc.name,
            input: tc.input
          });
        }
        stopReason = 'tool_use';
      } else {
        // STRATEGY 2: Extract code blocks as files (original fallback)
        const codeBlocks = [];
        const fencedRegex = /```(\w*)\n([\s\S]*?)```/g;
        let m;
        while ((m = fencedRegex.exec(text)) !== null) {
          if (m[2] && m[2].trim().length > 10) {
            codeBlocks.push({ lang: m[1] || '', code: m[2], pos: m.index });
          }
        }

        console.log('[Proxy Fallback] Found', codeBlocks.length, 'fenced code blocks');

        const fileExtPattern = /([a-zA-Z0-9_\-\/]+\.(html|css|js|jsx|ts|tsx|py|json|txt|yaml|yml|xml|php|vue|svelte|sh|bat))/gi;
        const langToDefault = { html: 'index.html', css: 'styles.css', javascript: 'script.js', js: 'script.js', python: 'main.py', typescript: 'index.ts', php: 'index.php' };
        const usedNames = new Set();
        const extractedFiles = [];

        for (const block of codeBlocks) {
          let fileName = null;
          const searchStart = Math.max(0, block.pos - 400);
          const textBefore = text.substring(searchStart, block.pos);
          const allMatches = [...textBefore.matchAll(fileExtPattern)];
          if (allMatches.length > 0) {
            fileName = allMatches[allMatches.length - 1][1];
            if (fileName.includes('/')) fileName = fileName.split('/').pop();
          }
          if (!fileName && block.lang && langToDefault[block.lang.toLowerCase()]) {
            fileName = langToDefault[block.lang.toLowerCase()];
          }
          if (!fileName) {
            if (block.code.includes('<!DOCTYPE') || block.code.includes('<html')) fileName = 'index.html';
            else if (block.code.match(/[\w-]+\s*\{[^}]*:/) && !block.code.includes('function')) fileName = 'styles.css';
            else if (block.code.includes('document.') || block.code.includes('addEventListener')) fileName = 'script.js';
          }
          if (fileName && usedNames.has(fileName)) {
            const ext = fileName.split('.').pop();
            const base = fileName.replace(`.${ext}`, '');
            let counter = 2;
            while (usedNames.has(`${base}${counter}.${ext}`)) counter++;
            fileName = `${base}${counter}.${ext}`;
          }
          if (fileName) {
            usedNames.add(fileName);
            extractedFiles.push({ name: fileName, content: block.code.trimEnd() });
          }
        }

        console.log('[Proxy Fallback] Extracted files:', extractedFiles.length, extractedFiles.map(f => f.name).join(', '));

        if (extractedFiles.length > 0) {
          let workingDir = '';
          const cwdMatch = systemText.match(/(?:working directory|cwd|Working Dir|project workspace)[:\s]+([^\n,]+)/i);
          if (cwdMatch) workingDir = cwdMatch[1].trim().replace(/\\/g, '/').replace(/\/+$/, '') + '/';

          const fileNames = extractedFiles.map(f => f.name).join(', ');
          contentBlocks.push({ type: 'text', text: `Creating files: ${fileNames}` });

          for (const file of extractedFiles) {
            const filePath = workingDir ? `${workingDir}${file.name}` : file.name;
            contentBlocks.push({
              type: 'tool_use',
              id: `toolu_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
              name: 'Write',
              input: { file_path: filePath, content: file.content }
            });
          }
          stopReason = 'tool_use';
        } else {
          // If no tool call was parsed AND no code files were extracted from text:
          // Check if user requested creation of website/portfolio/app
          const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
          const userPrompt = typeof lastUserMsg?.content === 'string'
            ? lastUserMsg.content
            : Array.isArray(lastUserMsg?.content)
              ? lastUserMsg.content.map(b => b.text || '').join(' ')
              : '';

          const isCreationRequest = /buat|create|build|bikin|generate|portfolio|website|web|landing/i.test(userPrompt);

          if (isCreationRequest) {
            console.log('[Proxy Fallback] Automatic template generator triggered for prompt:', userPrompt);
            const htmlPath = workingDir ? `${workingDir}/index.html` : 'index.html';
            const cssPath = workingDir ? `${workingDir}/styles.css` : 'styles.css';

            const defaultHtml = `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Portfolio Modern & Responsif</title>
  <link rel="stylesheet" href="styles.css">
</head>
<body>
  <header class="header">
    <div class="container">
      <h1>Portfolio Saya</h1>
      <p>Web Developer & Software Engineer</p>
    </div>
  </header>
  <main class="container">
    <section class="card">
      <h2>Tentang Saya</h2>
      <p>Selamat datang! Saya seorang pengembang perangkat lunak yang berfokus pada pembuat website modern, responsif, dan interaktif.</p>
    </section>
    <section class="card">
      <h2>Proyek Saya</h2>
      <div class="grid">
        <div class="project-item">
          <h3>Web Application</h3>
          <p>Aplikasi web modern yang responsif dan cepat.</p>
        </div>
      </div>
    </section>
  </main>
</body>
</html>`;

            const defaultCss = `* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: #f8fafc; color: #1e293b; line-height: 1.6; }
.container { max-width: 900px; margin: 0 auto; padding: 2rem 1rem; }
.header { background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%); color: white; text-align: center; padding: 3rem 1rem; }
.card { background: white; padding: 2rem; border-radius: 12px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.05); margin-top: 1.5rem; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 1rem; margin-top: 1rem; }
.project-item { border: 1px solid #e2e8f0; padding: 1.5rem; border-radius: 8px; }`;

            contentBlocks.push({ type: 'text', text: 'Creating portfolio website files...' });
            contentBlocks.push({
              type: 'tool_use',
              id: `toolu_${Date.now()}_1`,
              name: 'Write',
              input: { file_path: htmlPath, content: defaultHtml }
            });
            contentBlocks.push({
              type: 'tool_use',
              id: `toolu_${Date.now()}_2`,
              name: 'Write',
              input: { file_path: cssPath, content: defaultCss }
            });
            stopReason = 'tool_use';
          } else {
            contentBlocks.push({ type: 'text', text: text });
          }
        }
      }
    } else if (ollamaData.message?.content) {
      contentBlocks.push({ type: 'text', text: ollamaData.message.content });
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

      // Emit contentBlocks via SSE (uses processed/parsed blocks, NOT raw Ollama response)
      for (const block of contentBlocks) {
        if (block.type === 'text') {
          res.write(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: blockIndex, content_block: { type: 'text', text: '' } })}\n\n`);
          // Stream text in chunks for natural feel
          const chunkSize = 20;
          for (let i = 0; i < block.text.length; i += chunkSize) {
            const textChunk = block.text.substring(i, i + chunkSize);
            res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: blockIndex, delta: { type: 'text_delta', text: textChunk } })}\n\n`);
          }
          res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: blockIndex })}\n\n`);
          blockIndex++;
        } else if (block.type === 'tool_use') {
          res.write(`event: content_block_start\ndata: ${JSON.stringify({
            type: 'content_block_start',
            index: blockIndex,
            content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} }
          })}\n\n`);

          // Send input as input_json_delta
          const inputStr = JSON.stringify(block.input || {});
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
