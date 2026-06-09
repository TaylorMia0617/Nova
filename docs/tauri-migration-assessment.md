# Tauri Migration Assessment

## Summary

Nova still runs on Electron today. The existing `src-tauri/` folder is an incomplete prototype: it covers a small subset of file operations and legacy API config, but it does not yet match the full `window.novelHost` surface used by the app.

Migration difficulty is **medium-high**. The React app is not the main blocker; the real work is preserving local desktop capabilities, workspace data behavior, and binary/document workflows across a new native bridge.

## Runtime Capability Matrix

| Area | Electron today | Tauri prototype today | Migration gap |
| --- | --- | --- | --- |
| Window controls | minimize, maximize, close, new window, maximize state | default window only | Need matching commands/events |
| Workspace files | pick workspace, load tree, lazy directory reads, text/binary read/write, create, rename, delete, duplicate, move | basic pick/load/read/write/create/rename/delete/duplicate/move | Need lazy loading parity, binary read/write, skip rules, sorting parity |
| Global settings | app userData JSON settings | not implemented | Need app data directory settings commands |
| Legacy API config | read/write `~/.config/nova/NovaApi.json` | read/write exists | Need read-only import policy parity with current app behavior |
| Conversations | per-workspace `.novel-assistance/conversations` | not implemented | Need workspace app-data commands |
| History | per-workspace 48-hour snapshots | not implemented | Need snapshot list/append/update/prune commands |
| Blueprints | per-workspace blueprints and templates | not implemented | Need list/save/delete/rename/template commands |
| Reference database | per-workspace reference lists | not implemented | Need index/list read/write/delete commands |
| Attachments | native file picker and text extraction | not implemented | Need picker and text extraction commands |
| Workspace watch | `fs.watch` with throttled frontend refresh | not implemented | Need watcher plugin or custom event bridge |
| PDF export | hidden Electron window `printToPDF` | not implemented | Need Tauri/WebView print/export replacement |
| Integrated terminal | removed | intentionally out of scope | No migration required |

## Recommended Migration Route

1. **Stabilize the host API**
   - Keep `window.novelHost` as the frontend boundary.
   - Define a runtime-neutral adapter so Electron and Tauri expose the same method names and payload shapes.
   - Keep file paths, workspace app-data layout, and JSON formats unchanged.

2. **Bring Tauri to parity behind the adapter**
   - Implement commands for settings, conversations, history, blueprints, references, attachments, workspace watch, binary file IO, and window controls.
   - Match Electron error messages where the frontend depends on them.
   - Keep terminal out of scope.

3. **Switch build/runtime only after parity**
   - Add `tauri:dev` and `tauri:build` scripts.
   - Validate core flows against both runtimes during transition.
   - Remove Electron dependencies and packaging only after Tauri passes the same smoke tests.

## Cold Start Notes

The integrated terminal previously added a native dependency (`node-pty`) plus xterm frontend chunks and Electron-side terminal helpers. Removing it reduces desktop startup work, package complexity, native rebuild risk, and Tauri migration scope.

Further startup wins should focus on keeping heavy panels lazy:

- Do not render History until the user opens the bottom panel.
- Keep Copilot and editor split code lazy where practical.
- Avoid loading workspace-heavy data until the relevant panel or active file needs it.

## Acceptance Checklist For Future Tauri Migration

- Open workspace, load tree, lazy-open folders.
- Open/save text and DOCX without data corruption.
- Create/rename/duplicate/move/delete files and folders.
- Persist global settings without touching unknown legacy API config fields.
- Record and restore history snapshots.
- Load/save blueprints, templates, and reference lists.
- Pick and read text attachments.
- Refresh workspace after external file changes.
- Export PDF or provide an equivalent supported export path.
- Package Windows builds without Electron or node native terminal dependencies.
