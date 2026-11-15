# qqstudio

Chat UI on http://localhost:8003 that talks to llama-server at http://127.0.0.1:9931.

    npm run dev           (or double-click start.bat) - hot reload
    npm start             - plain, no server restarts

Needs Node 18+. No npm install required.

Override with env vars: `PORT`, `LLAMA_URL`.

- Model list comes from llama-server `/v1/models`. If you run llama-server in router mode
  (multiple models), all of them show up and the selected one is sent as `model`.
- Replies stream from `/v1/chat/completions`; reasoning (`reasoning_content`) is shown in a
  collapsible "thinking" block and is not sent back in history.

## Tools

The agent loop runs in the browser; tools run in `server.js` (`tools.js`).

| Tool | Approval |
|---|---|
| list_dir, read_file, search_files, web_search, image_search, show_image, fetch_url | automatic |
| write_file, download_file, delete_file (Recycle Bin), move_file, run_command | asks (unless "auto-approve" is ticked) |

All paths are limited to `ALLOWED_ROOTS` (semicolon-separated, default `C:\claude-tools`).
Note: `run_command` can still do anything cmd.exe can — that's why it asks.

Tool calling needs llama-server's Jinja chat templates (`--jinja`; on by default in recent builds).
If the model never calls tools, check that first.

## Hot reload

- `server.js` / `tools.js` changes: `dev.js` restarts the server; open pages reload once it's back.
- `public/*.html|css|js` changes: open pages reload immediately (no restart).
- Turn off with `HOT_RELOAD=0`. A page reload clears the current chat.

## Installing models (Models page)

Search Hugging Face for GGUF repos, expand one, click Download on a quant.
Saved to `<models folder>\<vendor>\<model-name>\<file>.gguf` (folder is remembered in the browser).
Split models download all parts. Cancelled/failed downloads resume from the `.part` file.
Gated repos: accept the license on huggingface.co and set `HF_TOKEN` before starting the server.
llama-server's `--models-dir` only scans one level, so the Models page generates `models.ini` (all models, any depth, with mmproj)
and shows the command: `llama-server --models-preset "...\\models.ini" --jinja --port 9931`. Restart llama-server after it changes.

## User data

Everything that isn't code lives in `%USERPROFILE%\.qqstudio` (override with `QQSTUDIO_HOME`):

    config.json          models folder, general settings
    models\              default models folder (<vendor>\<model>\<file>.gguf)
    tools.json           tool on/off + ask-first
    llama-server.json    engine executable, arguments, autostart
    models.ini           generated llama-server presets
    llama-server.pid     running engine (for re-adoption)
    logs\llama-server.log
    chats\*.json         chat history
    skills\<name>\SKILL.md  skills (Anthropic Agent Skills format)
    skills.json          enabled/disabled skills
    mcp.json             MCP servers (Claude Desktop format)

Back up / move this folder to keep your chats and settings.

## Skills

Drop folders with a `SKILL.md` (frontmatter `name` + `description`, then instructions) into `~\.qqstudio\skills\`.
Settings > Skills enables/disables them. Per chat (+ menu): **Pin** = full instructions always in the system prompt,
**Auto** = model sees name + description and calls `load_skill` when relevant, **Off**. Skill folders are readable by the file tools.

## MCP servers

`~\.qqstudio\mcp.json`, same shape as Claude Desktop's config (paste yours in Settings > MCP Servers):

    { "mcpServers": {
        "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "C:\\data"] },
        "remote":     { "url": "https://host/mcp", "headers": { "Authorization": "Bearer ..." } },
        "paused":     { "command": "...", "disabled": true } } }

stdio and Streamable HTTP transports (legacy SSE-only servers are not supported). Tools show up as `<server>__<tool>`
in Settings > Tools (Ask first on unless the server marks the tool read-only) and can be switched per chat in the + menu.

## Security

The API only answers requests for localhost and rejects cross-site browser requests, so other websites can't drive it.
Tools marked Ask first are also enforced server-side (approval or a chat in Auto mode is required).

## Thinking levels

Per chat (🧠 in the composer): Default (send nothing), Off (`enable_thinking: false`, budget 0),
Low/Medium/High (`chat_template_kwargs.reasoning_effort` + `reasoning_budget_tokens` from Settings > Engine), Max (no cap).
Per-request budgets need llama.cpp b9982+. Effort only changes behaviour for models whose chat template reads it.
