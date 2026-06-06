# Monaco → TipTap/ProseMirror 迁移计划

## 项目现状

- **当前编辑器**: Monaco Editor (`@monaco-editor/react` v4.6.0) 在 `EditorPanel.tsx` (1466行)
- **编辑模式**: Markdown 源码编辑，通过装饰器实现标题/对齐等视觉效果
- **TipTap 依赖**: 已安装 11 个包 (v3.25.0) 但**完全未使用**
- **集成点**: EditorBridge 模式连接 CopilotPanel，支持插入/替换文本
- **导出**: TXT/PDF/DOCX，基于 Markdown 源码解析

---

## Phase 0: 基础设施准备

- [x] 0.1 安装缺失的 TipTap 扩展: `@tiptap/extension-text-align`, `@tiptap/extension-underline`, `@tiptap/extension-font-family`, `@tiptap/extension-text-style`, `@tiptap/extension-color`, `@tiptap/extension-highlight`, `@tiptap/extension-task-list`, `@tiptap/extension-task-item`, `@tiptap/extension-horizontal-rule`, `@tiptap/extension-paragraph`
- [x] 0.2 更新 `vite.config.ts`: 移除 Monaco chunk 分割，添加 TipTap/ProseMirror chunk 分割策略
- [x] 0.3 创建 `src/components/TipTapEditor/` 目录: 新组件隔离开发，不影响现有 Monaco
- [x] 0.4 创建 `src/components/TipTapEditor/tiptap-extensions/`: 自定义扩展目录（小说引用、Markdown 快捷键等）

---

## Phase 1: 核心编辑器替换

- [x] 1.1 创建 `TipTapEditor.tsx` 基础组件: 使用 `@tiptap/react` + `useEditor`，配置 `StarterKit`，基础样式
- [x] 1.2 配置 ProseMirror Schema: 定义文档结构 heading(h1-h3)、paragraph、blockquote、codeBlock、bulletList、orderedList
- [x] 1.3 实现 Markdown 快捷输入: `#` → H1, `##` → H2, `**bold**`, `*italic*`, `- list` 等 Markdown 快捷转换
- [x] 1.4 实现 `tiptap-markdown` 集成: 用于 Markdown 内容的导入/导出，保持与现有 `.md` 文件的兼容性
- [x] 1.5 实现暗色主题 CSS: 将 Monaco 的 `novel-assistance-dark` 主题迁移为 TipTap 的 ProseMirror CSS 样式
- [x] 1.6 实现自动布局 `automaticLayout`: 编辑器容器 ResizeObserver，动态调整尺寸
- [x] 1.7 实现平滑滚动: ProseMirror 的 `scrollMargin`/`scrollThreshold` 配置

---

## Phase 2: EditorPanel 功能迁移

- [x] 2.1 迁移 Tab 系统: 保留现有 tab-bar 逻辑，将 `editorRef` 替换为 TipTap `Editor` 实例引用
- [x] 2.2 迁移 EditorBridge: 重写 `registerEditorBridge`，用 TipTap 的 `editor.commands` 替代 Monaco API (`getSelectionText`, `getContent`, `applyText`, `focus`)
- [x] 2.3 迁移格式工具栏: H1/H2/H3/Body 按钮 → `editor.chain().focus().toggleHeading().run()`；对齐按钮 → `setTextAlign`
- [x] 2.4 迁移字体大小控制: 使用 `@tiptap/extension-text-style` + 自定义 FontSize extension
- [x] 2.5 迁移自动保存: 保持 3s debounce 逻辑，`onUpdate` 回调替代 `onDidChangeModelContent`
- [x] 2.6 迁移光标/滚动状态保存: `editor.state.selection` + `editor.view.dom.scrollTop` 替代 Monaco 的 `getPosition/getScrollTop`
- [x] 2.7 迁移选中文本弹窗: 选中文本后显示 AI 操作弹窗，使用 ProseMirror `coordsAtPos` 计算弹窗位置
- [x] 2.8 迁移状态栏: 光标位置、字数统计、选中字符数等从 ProseMirror state 计算
- [x] 2.9 迁移自动换行切换: `editor.setOptions({ editorProps: { attributes: { style: "white-space: ..." } } })`
- [ ] 2.10 迁移引用补全 (`{{ref}}`): 创建自定义 TipTap Suggestion extension，使用 `@tiptap/suggestion` 实现 `{{` 触发的下拉补全

---

## Phase 3: WPS 风格富文本功能

- [x] 3.1 粗体/斜体/下划线/删除线: `Bold`, `Italic`, `Underline`, `Strike` 扩展 + 工具栏按钮
- [x] 3.2 文字颜色/高亮: `Color` + `Highlight` 扩展，颜色选择器 UI
- [x] 3.3 字体选择: `FontFamily` 扩展，字体下拉菜单
- [x] 3.4 段落对齐: `TextAlign` 扩展 (left/center/right/justify)
- [x] 3.5 行间距: 自定义 LineHeight extension
- [x] 3.6 首行缩进: 自定义 Indent extension
- [x] 3.7 表格编辑: `Table` + `TableRow` + `TableHeader` + `TableCell`（已安装），添加表格工具栏（插入/删除行列、合并单元格）
- [x] 3.8 图片插入: `Image` 扩展（已安装），支持拖拽插入、粘贴、URL 输入、本地文件选择
- [x] 3.9 链接管理: `Link` 扩展（已安装），插入/编辑/取消链接的 UI 对话框
- [x] 3.10 任务列表: `TaskList` + `TaskItem` 扩展
- [x] 3.11 引用块: `Blockquote`（StarterKit 内置）+ 工具栏按钮
- [x] 3.12 代码块: `CodeBlock`（StarterKit 内置）+ 语法高亮
- [x] 3.13 分割线: `HorizontalRule`（StarterKit 内置）
- [x] 3.14 撤销/重做: `History`（StarterKit 内置）+ Ctrl+Z/Ctrl+Y

---

## Phase 4: 高级编辑功能

- [x] 4.1 页面视图模式: 类似 WPS 的"页面视图"，模拟 A4 纸张宽度、页边距、分页线
- [x] 4.2 大纲/导航面板: 从文档标题自动生成大纲树，点击跳转（替代 Monaco 的 markdown folding）
- [x] 4.3 查找和替换: ProseMirror 的 `search` 插件或自定义实现，支持正则表达式
- [x] 4.4 全文搜索高亮: 搜索结果在文档中高亮标记
- [x] 4.5 目录自动生成: 从 H1-H3 标题自动生成可点击目录（由 4.2 大纲面板覆盖）
- [ ] 4.6 批注/评论: 使用 ProseMirror Decoration 实现文本批注功能
- [x] 4.7 字数统计增强: 实时统计字符数、字数、段落数、预计阅读时间
- [x] 4.8 专注模式: 高亮当前段落，淡化其余内容

---

## Phase 5: 导出系统适配

- [x] 5.1 重写 `parseDocumentStructure`: 从 ProseMirror JSON doc 结构解析 `DocumentBlock[]`，替代 Markdown 文本解析
- [x] 5.2 PDF 导出适配: 从 ProseMirror JSON 直接生成带格式的 HTML，传给 Electron `printToPDF`
- [x] 5.3 DOCX 导出适配: 使用 `docx` 库从 ProseMirror JSON 生成富文本文档（保留粗体、斜体、标题、表格等格式）
- [x] 5.4 TXT 导出适配: `editor.state.doc.textContent` 获取纯文本
- [x] 5.5 Markdown 导出: 使用 `tiptap-markdown` 的 `getMarkdown()` 导出 Markdown 格式
- [x] 5.6 保留导出模板系统: 模板配置继续工作，但数据源改为 ProseMirror 结构

---

## Phase 6: 集成与性能优化

- [x] 6.1 CopilotPanel 集成测试: 验证 EditorBridge 在 TipTap 下正常工作（插入文本、获取选区、获取内容）
- [x] 6.2 AI 选中文本处理: 验证 polish/correct/stylize 功能在富文本模式下的行为（替换选区、插入结果）
- [x] 6.3 分屏编辑器组: 多个 TipTap Editor 实例的 split group 支持
- [ ] 6.4 大文档性能优化: ProseMirror 的虚拟滚动或文档分块加载策略
- [ ] 6.5 协同编辑预留: ProseMirror 原生支持协同编辑，预留 Yjs 集成接口
- [x] 6.6 快捷键系统完善: 对齐所有 Monaco 快捷键到 TipTap（Ctrl+B, Ctrl+I, Ctrl+U, Tab 缩进等）
- [x] 6.7 右键菜单适配: 上下文菜单从 Monaco API 迁移到 TipTap/ProseMirror

---

## Phase 7: 清理与收尾

- [x] 7.1 移除 Monaco 依赖: 从 `package.json` 移除 `@monaco-editor/react`
- [x] 7.2 移除 Monaco CSS: 清理 `EditorPanel.css` 和 `styles.css` 中的 `.monaco-editor` 样式
- [x] 7.3 移除 Monaco chunk 配置: 清理 `vite.config.ts` 中的 Monaco 分包
- [ ] 7.4 移除 `tiptap-markdown` 如果不需 Markdown 兼容: 根据实际需求决定是否保留
- [ ] 7.5 文档更新: 更新 README/AGENTS.md 说明新的编辑器架构
- [ ] 7.6 E2E 测试: 编辑器核心流程的端到端测试

---

## 关键技术决策点

1. **内容存储格式**: ProseMirror JSON vs Markdown？建议默认用 ProseMirror JSON（保留完整格式），同时支持 Markdown 导入/导出
2. **向后兼容**: 现有 `.md` 文件如何处理？`tiptap-markdown` 可以在打开时自动转换
3. **EditorBridge 接口**: 需要扩展以支持富文本操作（插入格式化文本而非纯文本）
4. **PDF 导出**: 是否继续用 Electron `printToPDF`？TipTap 的 HTML 输出更丰富，可能需要调整模板

---

## 预估工作量

| Phase | 估时 | 优先级 |
|-------|------|--------|
| Phase 0: 基础设施 | 1-2 天 | P0 |
| Phase 1: 核心替换 | 3-5 天 | P0 |
| Phase 2: 功能迁移 | 5-7 天 | P0 |
| Phase 3: WPS 富文本 | 5-7 天 | P1 |
| Phase 4: 高级功能 | 5-8 天 | P2 |
| Phase 5: 导出适配 | 2-3 天 | P1 |
| Phase 6: 集成优化 | 3-5 天 | P1 |
| Phase 7: 清理收尾 | 1-2 天 | P1 |

**总计**: 约 25-39 天（可根据优先级分批实施）
