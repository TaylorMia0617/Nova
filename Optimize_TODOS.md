# 性能优化长期计划

## 问题根因

| 瓶颈 | 严重度 | 影响 |
|------|--------|------|
| 18+ TipTap 扩展同时初始化 | 高 | 首次加载 500-800ms |
| `onUpdate` 每次按键调用 `getMarkdown()` | 高 | 每次按键 50-100ms |
| EditorPanel 30+ useState 全组件重渲染 | 高 | 每次交互 16-32ms |
| `onSelectionUpdate` 频繁触发 | 中 | 每次光标移动 |
| CSS `:has()` 选择器 | 中 | 每帧样式计算 |
| FindReplacePanel 动态注册插件 | 低 | 打开搜索时 |

---

## P0: 立即优化 (已完成)

- [x] O.1 延迟 Markdown 序列化 — 500ms debounce
- [x] O.2 CSS 性能优化 — 移除 `:has()`, px 单位
- [x] O.3 FindReplacePanel 插件生命周期 — unregisterPlugin
- [x] O.4 工具栏按钮稳定引用 — 20+ useCallback

---

## P1: 深度优化 (预期 70-85% 改善)

### O.5 EditorPanel 状态管理重构

- [ ] 创建 `stores/editorUIStore.ts` — 通用 UI 状态
- [ ] 创建 `stores/toolbarStore.ts` — 工具栏状态
- [ ] 将 30+ 个 useState 拆分到对应 store
- **改动文件:** `EditorPanel.tsx`, 新增 2 个 store 文件
- **预期效果:** 减少重渲染范围

### O.6 拆分 EditorPanel 组件

- [ ] 提取 `EditorToolbar.tsx` — 工具栏容器
- [ ] 提取 `EditorStatusBar.tsx` — 状态栏
- [ ] 提取 `SelectionPopup.tsx` — 选中文本弹窗
- [ ] 提取 `ExportDialog.tsx` — 导出对话框
- [ ] 提取 `LinkDialog.tsx` — 链接对话框
- **改动文件:** `EditorPanel.tsx`, 新增 5+ 组件文件
- **预期效果:** 隔离重渲染

### O.7 onSelectionUpdate 优化

- [ ] 添加 debounce (100ms) 避免频繁触发
- [ ] 只在选区实际变化时调用 `onSelectionChange`
- **改动文件:** `TipTapEditor.tsx`
- **预期效果:** 减少光标移动开销

---

## P2: 架构优化 (可选)

- [ ] O.8 扩展懒加载
- [ ] O.9 大文档虚拟滚动
- [ ] O.10 内容增量更新

---

## P3: 高级优化 (可选)

- [ ] O.11 Web Worker Markdown 序列化
- [ ] O.12 协同编辑预留
- [ ] O.13 缓存策略
