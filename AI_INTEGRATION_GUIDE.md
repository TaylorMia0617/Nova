# AI 集成方法指南

本文档总结了 NovelAssistance 项目中的 AI 集成方法，以便在其他项目中复刻。

---

## 1. 功能概述

### 1.1 Suggestion 功能
- 自动补全参考条目
- 支持 `{{名称}}` 格式的参考条目
- 支持 plain 模式（直接输入名称）和 brace 模式（输入 `{{` 后触发）

### 1.2 参考列表管理
- 管理参考条目的 CRUD 操作
- 支持从 `.txt` 文件批量导入
- 支持导出为 `.txt` 文件
- 支持列表搜索

### 1.3 工具调用系统
- AI 可以调用本地工具访问工作区文件
- 支持 `list_directory`：列出目录内容（支持递归）
- 支持 `read_file`：读取文件内容（限制 50KB）
- 支持 `web_search`：搜索互联网（需要用户启用）

### 1.4 系统提示词设计
- 显示工作区根目录路径
- 显示完整的目录结构（树状格式）
- 告诉 AI 可以使用工具访问任何文件

### 1.5 文件缓存机制
- 确保 AI 可以看到最新的文件修改
- 使用 `useRef` 同步存储缓存

### 1.6 搜索限制
- 限制每次请求的搜索次数（默认 15 次）
- 用户可在设置中调整限制

---

## 2. 架构设计

### 2.1 技术栈
- **前端**：React + TypeScript + Zustand
- **后端**：Electron + Node.js
- **AI 服务**：OpenAI 兼容 API

### 2.2 目录结构

```
project/
├── electron/
│   ├── main.cjs              # Electron 主进程
│   └── preload.cjs           # 预加载脚本
├── src/
│   ├── components/
│   │   ├── CopilotPanel.tsx   # AI 对话面板
│   │   ├── EditorPanel.tsx    # 编辑器面板
│   │   └── AssetsPanel.tsx    # 文件资源管理器
│   ├── services/
│   │   ├── aiService.ts       # AI 服务
│   │   ├── mcpService.ts      # 工具调用服务
│   │   └── fileSystemService.ts # 文件系统服务
│   ├── stores/
│   │   ├── fileStore.ts       # 文件状态管理
│   │   └── settingsStore.ts   # 设置状态管理
│   ├── types/
│   │   └── ai.ts              # AI 相关类型定义
│   └── i18n/
│       ├── locales/
│       │   ├── zh-CN.ts       # 中文翻译
│       │   └── en-US.ts       # 英文翻译
│       └── index.ts           # 国际化配置
└── .novel-assistance/
    └── data/
        ├── lists.json         # 列表索引
        └── list-{id}.json     # 列表数据
```

---

## 3. 数据结构

### 3.1 参考列表索引

```typescript
interface ReferenceListIndex {
  id: string;           // 唯一标识符
  name: string;         // 列表名称
  createdAt: string;    // 创建时间
  updatedAt: string;    // 更新时间
}
```

### 3.2 参考列表数据

```typescript
interface ReferenceListData {
  id: string;           // 唯一标识符
  name: string;         // 列表名称
  items: Array<{
    key: string;        // 名称（用于 suggestion）
    value: string;      // 注释
  }>;
}
```

### 3.3 参考条目

```typescript
interface ReferenceEntry {
  name: string;         // 名称
  description?: string; // 注释（可选）
  sourceList?: string;  // 来源列表名称
}
```

### 3.4 工具定义

```typescript
interface McpTool {
  name: string;         // 工具名称
  description: string;  // 工具描述
  inputSchema: {
    type: string;
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}
```

### 3.5 工具调用结果

```typescript
interface McpToolResult {
  toolName: string;     // 工具名称
  result: string;       // 调用结果
}
```

---

## 4. 核心功能实现

### 4.1 Suggestion 功能

#### 4.1.1 数据预处理

使用 `useMemo` 预处理 `referenceEntries` 为 Map，提高查找速度：

```typescript
const referenceEntriesMap = useMemo(() => {
  const map = new Map<string, ReferenceEntry[]>();
  for (const entry of referenceEntries) {
    const lowerName = entry.name.toLowerCase();
    for (let i = 1; i <= lowerName.length; i++) {
      const prefix = lowerName.slice(0, i);
      if (!map.has(prefix)) {
        map.set(prefix, []);
      }
      map.get(prefix)!.push(entry);
    }
  }
  return map;
}, [referenceEntries]);
```

#### 4.1.2 上下文检测

检测光标位置是否有匹配的参考条目：

```typescript
const getSuggestionContext = (model: any, position: any) => {
  const lineContent = model.getLineContent(position.lineNumber);
  const beforeCursor = lineContent.slice(0, Math.max(position.column - 1, 0));
  
  // brace 模式：检测 {{xxx
  const braceMatch = beforeCursor.match(/\{\{([^}\n]*)$/);
  if (braceMatch) {
    return {
      partial: braceMatch[1].trim().toLowerCase(),
      insertMode: "brace" as const,
      startColumn: beforeCursor.lastIndexOf("{{") + 1,
    };
  }
  
  // plain 模式：检测普通文本
  const plainMatch = beforeCursor.match(/[A-Za-z0-9_\u4e00-\u9fff\u00b7\u30fb-]+$/);
  const token = plainMatch ? plainMatch[0] : "";
  
  let partial = "";
  if (token) {
    for (let i = token.length - 1; i >= 0; i--) {
      const suffix = token.slice(i).toLowerCase();
      if (referenceEntriesMap.has(suffix)) {
        partial = token.slice(i);
        break;
      }
    }
  }
  
  if (!partial) return null;
  
  return {
    partial: partial.toLowerCase(),
    insertMode: "plain" as const,
    startColumn: position.column - partial.length,
  };
};
```

#### 4.1.3 触发条件

- **Typing trigger**：输入后 300ms 检查是否有匹配的条目
- **Idle trigger**：空闲 5000ms 后检查是否有匹配的条目
- **ESC 冷却**：用户按 ESC 关闭建议后，5 分钟内不再自动触发

### 4.2 参考列表管理

#### 4.2.1 存储位置

```
.novel-assistance/
└── data/
    ├── lists.json         # 列表索引
    ├── list-{id}.json     # 列表数据
    └── ...
```

#### 4.2.2 核心函数

```typescript
// 获取所有列表索引
async function getReferenceLists(): Promise<ReferenceListIndex[]>

// 获取单个列表数据
async function getReferenceList(listId: string): Promise<ReferenceListData | null>

// 保存列表数据
async function saveReferenceList(list: ReferenceListData): Promise<ReferenceListData>

// 删除列表
async function deleteReferenceList(listId: string): Promise<void>
```

#### 4.2.3 解析参考条目

支持 `{{名称}} 注释` 格式：

```typescript
function parseNamedEntries(content: string): NamedEntry[] {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line): NamedEntry | null => {
      const match = line.match(/^\{\{(.+?)\}\}(?:\s+(.+))?$/);
      if (!match) return null;
      return {
        name: match[1].trim(),
        description: (match[2] ?? "").trim(),
      };
    })
    .filter((entry): entry is NamedEntry => entry !== null);
}
```

### 4.3 工具调用系统

#### 4.3.1 工具定义

```typescript
const LOCAL_FILESYSTEM_TOOLS: McpTool[] = [
  {
    name: "list_directory",
    description: "列出指定目录下的所有文件和文件夹（支持递归）",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "要列出的目录路径（相对于工作区根目录），留空表示根目录"
        },
        recursive: {
          type: "boolean",
          description: "是否递归列出子目录，默认 false"
        }
      },
      required: ["path"]
    }
  },
  {
    name: "read_file",
    description: "读取指定文件的内容（限制50KB）",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "要读取的文件路径（相对于工作区根目录）"
        }
      },
      required: ["path"]
    }
  },
  {
    name: "web_search",
    description: "搜索互联网获取信息（需要用户启用联网搜索）",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "搜索关键词"
        }
      },
      required: ["query"]
    }
  }
];
```

#### 4.3.2 工具调用执行

```typescript
async function runLocalTool(
  toolName: string,
  args: Record<string, unknown>,
  workspaceRoot: string,
  workspaceNodes: WorkspaceNode[],
  options?: { enableWebSearch?: boolean; searchCount?: number; searchLimit?: number }
): Promise<McpToolResult> {
  switch (toolName) {
    case "list_directory":
      // 列出目录内容
      break;
    case "read_file":
      // 读取文件内容
      break;
    case "web_search":
      // 搜索互联网
      break;
    default:
      return { toolName, result: `Error: Unknown tool: ${toolName}` };
  }
}
```

#### 4.3.3 多轮工具调用循环

```typescript
// 实现多轮工具调用循环
let currentResponse = response;
const maxIterations = 100;

for (let iteration = 0; iteration < maxIterations; iteration++) {
  let toolCallMatch = currentResponse.match(/```tool_call\s*\n([\s\S]*?)\n```/);
  if (!toolCallMatch || !rootPath) break;
  
  const toolResults: Array<{ name: string; result: string }> = [];
  
  // 执行当前轮次的所有工具调用
  while (toolCallMatch) {
    const toolCall = JSON.parse(toolCallMatch[1]);
    const toolResult = await runLocalTool(...);
    
    toolResults.push({ name: toolCall.name, result: toolResult.result });
    
    // 移除已处理的工具调用
    currentResponse = currentResponse.replace(toolCallMatch[0], '');
    toolCallMatch = currentResponse.match(/```tool_call\s*\n([\s\S]*?)\n```/);
  }
  
  // 如果有工具调用结果，将结果反馈给 AI 让它继续处理
  if (toolResults.length > 0) {
    const toolContext = toolResults.map(r => `Tool: ${r.name}\nResult: ${r.result}`).join("\n\n");
    
    setStatusText(`Processing tool results (iteration ${iteration + 1})...`);
    
    currentResponse = await callAI({
      ...options,
      userMessage: `Based on the tool results below, please continue with your task:\n\n${toolContext}`,
    });
    
    // 检查 AI 的回复是否包含更多工具调用
    if (!currentResponse.match(/```tool_call\s*\n([\s\S]*?)\n```/)) {
      break;
    }
  }
}

// 组合最终响应
response = currentResponse;
```

### 4.4 系统提示词设计

#### 4.4.1 构建目录结构字符串

```typescript
function buildDirectoryTreeString(nodes: WorkspaceNode[], prefix: string = ""): string {
  const lines: string[] = [];
  
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const isLast = i === nodes.length - 1;
    const connector = isLast ? "└── " : "├── ";
    const childPrefix = isLast ? "    " : "│   ";
    
    if (node.type === "folder") {
      lines.push(`${prefix}${connector}${node.name}/`);
      if (node.children) {
        lines.push(buildDirectoryTreeString(node.children, prefix + childPrefix));
      }
    } else {
      lines.push(`${prefix}${connector}${node.name}`);
    }
  }
  return lines.join("\n");
}
```

#### 4.4.2 系统提示词模板

```
You are a creative writing assistant helping a novelist.
You help with structure, scene writing, line editing, continuity, and narrative clarity.

Workspace root directory: {workspaceRoot}

Workspace directory structure:
```
{directoryTree}
```

You have access to the following tools to explore the workspace:
- list_directory: List files and folders in a directory (supports recursive listing). Use path="" for root directory.
- read_file: Read file content (max 50KB). Use relative path from workspace root.
- web_search: Search the internet for information. Use when you need external knowledge.

Use these tools when you need to read files that are not currently bound to this conversation. You can call them by responding with a JSON block like:
```tool_call
{"name": "list_directory", "arguments": {"path": "", "recursive": true}}
```
or
```tool_call
{"name": "read_file", "arguments": {"path": "chapter-01.txt"}}
```

Current document content:
{context}
```

### 4.5 文件缓存机制

#### 4.5.1 使用 useRef 同步存储缓存

```typescript
const [fileCaches, setFileCaches] = useState<Map<string, FileContentCache>>(new Map());
const fileCachesRef = useRef<Map<string, FileContentCache>>(new Map());

const updateFileCache = (filePath: string, content: string) => {
  const newCache = {
    filePath,
    content,
    lastSentAt: new Date().toISOString(),
  };
  // 同步更新 ref
  fileCachesRef.current = new Map(fileCachesRef.current);
  fileCachesRef.current.set(filePath, newCache);
  // 异步更新 state（用于 UI 显示）
  setFileCaches(fileCachesRef.current);
};
```

#### 4.5.2 在发送消息前更新缓存

```typescript
const handleSendMessage = async () => {
  // 更新文件缓存
  if (activeFile) {
    updateFileCache(activeFile.path, activeFile.content);
  }
  
  const multiFileContext = buildMultiFileContext();
  // ...
};
```

### 4.6 搜索限制

#### 4.6.1 设置存储

```typescript
// settingsStore.ts
interface SettingsState {
  webSearchLimit: number;
  setWebSearchLimit: (value: number) => void;
}

// 初始状态
webSearchLimit: 15,
```

#### 4.6.2 搜索计数

```typescript
const [webSearchCount, setWebSearchCount] = useState(0);

// 在 handleSendMessage 开始时重置计数
setWebSearchCount(0);

// 在工具调用时更新计数
if (toolCall.name === "web_search" && !toolResult.result.startsWith("Error")) {
  setWebSearchCount(prev => prev + 1);
}
```

#### 4.6.3 搜索限制检查

```typescript
case "web_search": {
  if (!options?.enableWebSearch) {
    return { toolName, result: "Error: Web search is not enabled. Please enable it first." };
  }
  if (options?.searchCount !== undefined && options?.searchLimit !== undefined && options.searchCount >= options.searchLimit) {
    return { toolName, result: `Error: Search limit reached (${options.searchLimit}). Please increase the limit in settings.` };
  }
  // ...
}
```

---

## 5. 国际化

### 5.1 翻译键结构

```typescript
interface TranslationDict {
  header: { ... };
  copilot: { ... };
  settings: { ... };
  editor: { ... };
  terminal: { ... };
  assets: { ... };
  reference: {
    title: string;
    lists: string;
    listName: string;
    key: string;
    value: string;
    keyPlaceholder: string;
    valuePlaceholder: string;
    addRow: string;
    save: string;
    export: string;
    import: string;
    deleteList: string;
    searchLists: string;
    noLists: string;
    createList: string;
    nameRequired: string;
    nameExists: string;
    saveSuccess: string;
    saveFailed: string;
    importSuccess: string;
    exportSuccess: string;
    deleteConfirm: string;
  };
}
```

### 5.2 使用方法

```typescript
import { useTranslation } from "../hooks/useTranslation";

const { t } = useTranslation();

// 使用
<h3>{t("reference.title")}</h3>
```

---

## 6. 文件清单

### 6.1 核心文件

| 文件 | 说明 |
|------|------|
| `src/types/ai.ts` | AI 相关类型定义 |
| `src/services/aiService.ts` | AI 服务 |
| `src/services/mcpService.ts` | 工具调用服务 |
| `src/services/fileSystemService.ts` | 文件系统服务 |
| `src/stores/fileStore.ts` | 文件状态管理 |
| `src/stores/settingsStore.ts` | 设置状态管理 |

### 6.2 UI 文件

| 文件 | 说明 |
|------|------|
| `src/components/CopilotPanel.tsx` | AI 对话面板 |
| `src/components/EditorPanel.tsx` | 编辑器面板 |
| `src/components/AssetsPanel.tsx` | 文件资源管理器 |
| `src/components/SettingsModal.tsx` | 设置弹窗 |

### 6.3 国际化文件

| 文件 | 说明 |
|------|------|
| `src/i18n/locales/zh-CN.ts` | 中文翻译 |
| `src/i18n/locales/en-US.ts` | 英文翻译 |
| `src/i18n/index.ts` | 国际化配置 |

### 6.4 Electron 文件

| 文件 | 说明 |
|------|------|
| `electron/main.cjs` | Electron 主进程 |
| `electron/preload.cjs` | 预加载脚本 |

---

## 7. 复刻步骤

### 7.1 安装依赖

```bash
npm install zustand @monaco-editor/react react-markdown remark-gfm lucide-react
```

### 7.2 创建目录结构

```
src/
├── types/
│   └── ai.ts
├── services/
│   ├── aiService.ts
│   ├── mcpService.ts
│   └── fileSystemService.ts
├── stores/
│   ├── fileStore.ts
│   └── settingsStore.ts
├── components/
│   ├── CopilotPanel.tsx
│   ├── EditorPanel.tsx
│   └── AssetsPanel.tsx
└── i18n/
    ├── locales/
    │   ├── zh-CN.ts
    │   └── en-US.ts
    └── index.ts
```

### 7.3 复制核心文件

从 NovelAssistance 项目中复制以下文件：
- `src/types/ai.ts`
- `src/services/aiService.ts`
- `src/services/mcpService.ts`
- `src/stores/fileStore.ts`
- `src/stores/settingsStore.ts`

### 7.4 修改配置

1. 修改 `electron/main.cjs`，添加 IPC 处理器
2. 修改 `electron/preload.cjs`，添加方法桥接
3. 修改 `src/i18n/locales/zh-CN.ts` 和 `en-US.ts`，添加翻译键

### 7.5 测试功能

1. 测试 Suggestion 功能
2. 测试参考列表管理
3. 测试工具调用系统
4. 测试搜索限制

---

## 8. 注意事项

### 8.1 性能优化

- 使用 `useMemo` 缓存 `referenceEntriesMap`
- 使用 `useCallback` 缓存 `handleEditorChange`
- 使用 `useRef` 同步存储文件缓存

### 8.2 安全性

- 限制文件读取大小（50KB）
- 限制工具调用次数（100 轮）
- 限制搜索次数（默认 15 次）

### 8.3 错误处理

- 工具调用失败时返回错误信息
- 文件读取失败时自动加载父目录
- 搜索限制达到时显示提示

---

## 9. 扩展建议

### 9.1 添加更多工具

- `write_file`：写入文件内容
- `create_file`：创建新文件
- `delete_file`：删除文件

### 9.2 支持更多文件格式

- `.md`：Markdown 文件
- `.json`：JSON 文件
- `.yaml`：YAML 文件

### 9.3 支持更多 AI 模型

- OpenAI GPT-4
- Anthropic Claude
- Google Gemini

---

## 10. 总结

本文档总结了 NovelAssistance 项目中的 AI 集成方法，包括：

1. **Suggestion 功能**：自动补全参考条目
2. **参考列表管理**：管理参考条目的 CRUD 操作
3. **工具调用系统**：AI 可以调用本地工具
4. **系统提示词设计**：告诉 AI 可以使用工具
5. **文件缓存机制**：确保 AI 可以看到最新的文件修改
6. **搜索限制**：限制每次请求的搜索次数

这些功能可以复刻到任何需要 AI 集成的项目中。
