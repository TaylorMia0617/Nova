# NovelAssistance

Local-first desktop writing workspace for novel drafting, reference management, and AI-assisted writing.

## Current Runtime

This project currently ships on `Electron`.

- `src-tauri/` is legacy exploration material and is not the active desktop runtime.
- Development, packaging, and file access currently run through the Electron app.
- Tauri migration is being evaluated; see `docs/tauri-migration-assessment.md`.

## Features

- Three-column desktop layout:
  Explorer, editor, and AI copilot
- Real workspace file management:
  open, create, rename, duplicate, move, and delete files/folders
- Monaco-based editor with Markdown-focused formatting
- Local reference files for characters, places, items, skills, and world notes
- BYOK AI support for OpenAI-compatible endpoints and remote MCP-assisted workflows

## Security and Data Behavior

- Workspace file operations are restricted to the currently opened workspace root.
- API keys are session-only by default.
- Users can explicitly enable local API key persistence on the current device.
- Copilot conversations are stored per-workspace inside `.novel-assistance/conversations/`.

## AI Request Rules

### 1. Supported AI API styles

The app currently supports two OpenAI-compatible request styles:

- `Responses API`
  Example endpoint:
  `https://api.openai.com/v1/responses`
- `Chat Completions API`
  Example endpoint:
  `https://api.deepseek.com/v1/chat/completions`

The app automatically chooses the request format based on the `AI Base URL`:

- If the URL ends with `/v1/responses`, the app sends:
  `model + instructions + input + max_output_tokens`
- If the URL ends with `/v1/chat/completions`, the app sends:
  `model + messages + max_tokens`

Important:

- `AI Base URL` must be a full request endpoint, not only a service root.
- Example of correct values:
  `https://api.openai.com/v1/responses`
  `https://api.deepseek.com/v1/chat/completions`
- Example of incorrect values:
  `https://api.deepseek.com`
  `https://api.openai.com`

### 2. Model profile fields

Each model profile contains:

- `Name`
- `Model ID`
- `AI Base URL`
- `API Key`
- `MCP Server URL` (optional)
- `Remember secrets on this device`

Rules:

- `Model ID` must match the target provider's actual model name.
- `API Key` is always sent as:
  `Authorization: Bearer <your-key>`
- If your provider needs extra custom headers, the current UI does not yet expose them.
- Anthropic-style endpoints are not currently supported unless they also expose an OpenAI-compatible path.

### 3. MCP behavior

`MCP Server URL` is optional.

- Leave it empty if you only want direct AI chat.
- Fill it only when you have a remote MCP server endpoint.

Important distinction:

- `AI Base URL` is the model request endpoint.
- `MCP Server URL` is the remote MCP tool server endpoint.

They are not the same thing.

When `MCP Server URL` is configured:

- the app first attempts a minimal MCP tool lookup / call flow
- returned MCP text context is appended to the final AI prompt
- if MCP fails during chat requests, the request fails with the returned error

### 4. Conversation and context rules

- Copilot memory is stored per workspace in:
  `.novel-assistance/conversations/`
- The current editor file content is included as document context.
- Recent chat history is included in the AI request.
- Attached text files are converted into plain-text context and appended to the prompt.
- Attachments are not uploaded as binary files and do not use multimodal file APIs.

### 5. Attachment rules

Supported attachment types are text-oriented files only, including:

- `txt`
- `md`
- `json`
- `csv`
- `yaml`
- `yml`
- `xml`
- `html`
- `js`
- `ts`
- `py`
- `rs`
- `java`
- `c`
- `cpp`

Rules:

- Attachments are read locally by Electron.
- The app stores attachment metadata and text content in conversation history.
- Attachments are added to the prompt as supplemental context.
- PDF / DOCX attachments are not parsed in the current version.

### 6. Request troubleshooting

If a request fails:

- `401 Unauthorized`
  Usually means the API key is invalid, rejected by an upstream gateway, or the endpoint does not accept the current auth style.
- `No response text`
  Usually means the endpoint is not actually compatible with the request format implied by the URL.
- MCP errors
  Usually mean the `MCP Server URL` is not a valid remote MCP endpoint, or its tool contract differs from the minimal integration used here.

Recommended checks:

1. Confirm `AI Base URL` is a full endpoint.
2. Confirm the endpoint is either `responses`-compatible or `chat/completions`-compatible.
3. Confirm the `Model ID` matches the provider.
4. Confirm the same key and endpoint work in `curl`.
5. If `curl` works but the app does not, compare headers and request body format.

## Development

### Prerequisites

- Node.js 18+
- npm

### Install

```bash
npm install
```

### Run the desktop app

```bash
npm run desktop:dev
```

This starts Vite and then launches Electron against the local renderer.

### Build the desktop app

```bash
npm run desktop:build
```

## Project Notes

- The workspace `settings` folder stores built-in reference text files used by editor suggestions.
- External workspace edits are refreshed through workspace change events and window focus recovery instead of fixed polling.

## License

MIT
