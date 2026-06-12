# Nova

Nova is a local-first desktop workspace for long-form fiction writing. It combines a file editor, reference database, version history, blueprint planning, and AI copilot roles designed for novel creation.

The project currently ships as an Electron app. The old `src-tauri/` directory is legacy exploration material, not the active runtime.

## Why Use Nova

Most AI writing tools are good at producing text, but weak at remembering the shape of a novel. Nova is built around the opposite assumption: a novel is not one prompt, it is a living workspace.

Nova helps with:

- Keeping worldbuilding, characters, chapter files, blueprints, reference entries, and history in one local workspace.
- Letting AI write with project memory instead of repeatedly pasting the whole novel into chat.
- Preserving character continuity through structured reference entries, especially current desire, fear, emotion, and bias.
- Separating roles: architect for diagnosis and planning, writer for prose, editor for review.
- Creating real files, including `.docx`, instead of leaving generated content trapped in chat.
- Working BYOK: you choose the OpenAI-compatible endpoint and model profile.

Your workspace remains local. Project conversations and memory live under `.novel-assistance/` inside the selected workspace.

## How To Use

1. Open a novel workspace.
2. Configure an AI model profile in settings.
3. Create or open your project files.
4. Use the Copilot panel with the role that matches the task:
   - `Architect`: diagnose, rebuild, plan, extract author voice, design worldbuilding and character systems.
   - `Writer`: write scenes, continue chapters, create files, update reference entries.
   - `Editor`: review prose for continuity, OOC behavior, dialogue density, pacing, and AI-like structure.
5. Use reference entries for characters and setting facts.
6. Let History and memory carry recent changes instead of constantly resending the whole chapter.

Nova uses several memory files inside `.novel-assistance/habits/`:

- `Importants.md`: cross-conversation project ledger, progress, confirmed decisions, major canon changes.
- `AuthorVoice.md`: author habits, disliked patterns, recurring quirks.
- `Obsessions.md`: durable themes and philosophical fixations.
- `Snapshot.md`: short-term project/session state.
- `Cache.md`: volatile runtime memory and summaries.

Character sheets should be stored in the reference database first, usually in the `人物` list, with a readable `.md` copy when useful.

## Recommended Workflow

### If Your Novel Starts From Zero

Use:

`Architect -> Writer -> Writer`

1. Start with Architect.
   Ask it to identify the intended novel type, author obsessions, themes, tone, worldbuilding direction, and character system. If the direction is unclear, Architect should ask questions before inventing the world.

2. Confirm the plan.
   The first useful output should be a change plan or creation plan, not immediate prose.

3. Move to Writer.
   Let Writer create the first structured files and reference entries: world notes, character database entries, readable character `.md` files, and chapter drafts.

4. Continue with Writer.
   Generate scenes in smaller blocks. Let character desire, fear, emotion, and bias shape action and dialogue.

### If You Already Have Draft Text

Use:

`Architect -> Editor -> Writer`

Architect can analyze existing prose for author voice and project direction. Editor can then check whether the current draft has characters who are too cooperative, dialogue that carries too much setting information, or conflicts that resolve too cleanly. Writer should make targeted changes after that.

### If You Only Need A Chapter

Use:

`Writer`

Ask for a scene or chapter file directly. Chapter prose defaults to `.docx` unless you specify another format.

## AI Roles

### Architect

Architect is for diagnosis, structure, and rebuilding. It should prioritize:

- Author profile.
- Theme and premise.
- Narrative texture.
- Worldbuilding principles.
- Character system.
- What to keep or discard.
- Memory candidates for project facts, author voice, and obsessions.

Architect should not write chapter prose unless explicitly asked.

### Writer

Writer is for drafting and file creation. It should:

- Write chapters and scenes.
- Create `.docx` chapter files.
- Create `.md` setting files.
- Upsert character entries into the reference database.
- Respect current desire, fear, emotion, and bias.
- Avoid template-like repetition and repeated sentence structures.

### Editor

Editor is for review. It should focus on:

- Character continuity.
- OOC behavior.
- Dialogue information density.
- Emotional transitions.
- Too-smooth conflict resolution.
- AI-like over-structure.

Editor should not treat unusual worldbuilding as an error by itself.

## Data And Security

- File operations are restricted to the opened workspace root.
- Conversations are stored per workspace in `.novel-assistance/conversations/`.
- Project memory is stored per workspace in `.novel-assistance/habits/`.
- Reference entries are stored in `.novel-assistance/data/`.
- API keys are session-only by default unless local persistence is enabled.
- Attachments are read locally and converted into text prompt context.

## AI Endpoint Setup

Nova supports OpenAI-compatible endpoints.

Examples:

- Responses API: `https://api.openai.com/v1/responses`
- Chat Completions API: `https://api.deepseek.com/v1/chat/completions`

The `AI Base URL` should be the full request endpoint, not only the service root.

Correct:

```text
https://api.openai.com/v1/responses
https://api.deepseek.com/v1/chat/completions
```

Incorrect:

```text
https://api.openai.com
https://api.deepseek.com
```

## Development Guide

### Requirements

- Node.js 18+
- npm

For reproducible local setup, prefer `npm ci` when `package-lock.json` is present. `npm install` is still widely supported by npm, but `npm ci` is better for clean installs from the lockfile.

### Install Dependencies

```bash
npm ci
```

If you intentionally need to update dependency versions and rewrite the lockfile, use:

```bash
npm install
```

### Run The Desktop App

```bash
npm run desktop:dev
```

This starts Vite and launches Electron against the local renderer.

### Build Renderer

```bash
npm run build
```

### Build Desktop Package

```bash
npm run desktop:build
```

## Project Structure

```text
electron/                 Electron main process and preload bridge
src/components/           React UI panels
src/services/             AI, local tools, filesystem, memory, MCP services
src/stores/               Workspace, settings, and blueprint state
src/types/                Shared TypeScript types
shared/                   Shared runtime helpers
docs/                     Design notes and migration research
```

## Development Notes

- Active desktop runtime is Electron.
- `src-tauri/` is not the current app runtime.
- Local tools must use workspace-relative paths.
- `.docx` creation uses real DOCX package writing.
- Character generation should write reference database entries first, then optional readable `.md` files.
- `Importants.md` is a project ledger, not a full character database.
- Large file reads should be summarized before entering later chat history.

## License

MIT
