# 修复中文文件识别、Settings 初始化容错与 Monaco 依赖冗余

## Summary
- 强化 `settings` 初始化：已存在就跳过，只补缺失文件，任何创建/读取错误都进入可见错误状态，不让应用卡死。
- 强化中文文件识别：不再只做精确文件名匹配，支持中文文件名、大小写 `.TXT`、全角空格/不可见空白、轻微后缀变体。
- 清理 Monaco 打包冗余：保留实际使用的 `@monaco-editor/react`，移除不必要的 `monaco-editor` asar unpack 配置。

## Key Changes
- Reference/settings 文件匹配：
  - 在 `fileStore` 增加文件名规范化：`trim`、全角空格转普通空格、去除首尾空白、后缀大小写归一。
  - `findReferenceFilePath` 改为按“基础名 + 归一化 txt 后缀”匹配，例如 `人物列表.txt`、`人物列表.TXT`、`人物列表　.txt` 都识别为同一引用文件。
  - `findFolderPath` 对 `settings` 文件夹也做规范化匹配，避免 `settings ` 或全角空格导致重复创建。
- Settings 初始化逻辑：
  - `ensureProjectReferenceFiles` 改为“扫描已有 reference 文件 -> 确认 settings 文件夹 -> 只创建缺失文件”。
  - 文件夹存在时跳过创建；文件存在时不覆盖，重新扫描并使用已有文件。
  - 创建文件后写模板失败时，记录错误并继续处理其他缺失项；最终通过 `errorMessage` 给用户提示。
  - 如果扫描不到任何 txt/reference 文件，提示用户检查文件夹、文件名和 `.txt` 后缀。
- txt 合并导出：
  - `getFileExtension` 增强为归一化文件名后判断后缀，支持 `.TXT`、尾部空白、全角空格。
  - 找不到可合并 txt 时，提示改为更明确的“未找到 txt/md 文件，请检查当前文件夹和后缀”。
  - 保持排序使用现有中文章节排序逻辑。
- 路径处理：
  - Electron 主进程继续使用 Node `path` API。
  - 前端浏览器/虚拟路径侧集中使用现有 `joinPath/getParentPath` helper，不再在新增逻辑里散落手拼字符串。
- Monaco 依赖：
  - 保留 `@monaco-editor/react`，因为编辑器正在直接使用它。
  - 不删除 lockfile 中的 `monaco-editor`，它是编辑器 peer/安装结果。
  - 从 `package.json` 的 `build.asarUnpack` 移除 `node_modules/monaco-editor/**/*`，因为 Monaco 前端资源走 Vite 构建产物，不需要像 `node-pty` 这类 native 依赖一样 unpack。

## Test Plan
- `npm.cmd run build` 必须通过。
- 手动场景：
  - 工作区没有 `settings`：自动创建 `settings` 和缺失 reference txt。
  - 工作区已有 `settings`：不报错、不覆盖，只补缺失文件。
  - 工作区已有 `人物列表.TXT`、`人物列表　.txt`：能识别并读取，不重复创建 `人物列表.txt`。
  - 当前文件夹包含 `第一章.TXT`、`第二章.txt`、`第三章 .txt`：txt 合并能识别并按中文章节顺序合并。
  - 当前文件夹没有可合并 txt/md：显示可恢复错误提示，应用不未响应。
  - 模拟某个 reference 文件读取失败：应用显示错误消息，其余 UI 仍可响应。

## Assumptions
- `.txt`、`.md`、`.markdown` 都继续作为合并导出的文本源。
- Reference 文件只在缺失时创建；已有同名/等价名文件永不覆盖，也不自动备份。
- Monaco 不需要额外 unpack；如果后续发现 packaged Electron 中 Monaco 资源缺失，再改为显式 bundling 方案，而不是 unpack 整个 `monaco-editor`。
