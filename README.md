# NovelAssistance - AI Writing Assistant

A local-first, privacy-focused AI-powered writing assistant for novelists and creative writers.

## Features

### Phase 1 (MVP) - Current Implementation

- **Three-Column Immersive Layout**
  - Left: Assets Manager with file system support
  - Center: Monaco Editor for Markdown editing
  - Right: AI Copilot for real-time assistance

- **File System Management**
  - Create and manage multiple files and folders
  - Organize chapters, outlines, and drafts
  - Persistent storage using Zustand

- **AI Integration**
  - Support for OpenAI (GPT-4o-mini) and Google Gemini APIs
  - BYOK (Bring Your Own Key) model - API keys stored locally
  - Context-aware AI assistance with document content
  - AI text expansion functionality
  - Chat interface with conversation history

- **Privacy & Security**
  - All data stored locally on your machine
  - API keys stored in browser localStorage
  - No server intermediation

## Tech Stack

- **Frontend**: React 19 + TypeScript
- **Desktop Framework**: Tauri 2.0
- **State Management**: Zustand with persistence
- **Editor**: Monaco Editor (VS Code's editor)
- **Icons**: Lucide React
- **Build Tool**: Vite

## Getting Started

### Prerequisites

- Node.js (v18 or higher)
- npm or yarn
- Rust toolchain (for Tauri)

### Installation

1. Clone the repository:
```bash
git clone <repository-url>
cd NovelAssistance
```

2. Install dependencies:
```bash
npm install
```

3. Run the development server:
```bash
npm run tauri dev
```

### Building for Production

```bash
npm run tauri build
```

## Usage

1. **Enter API Key**: Add your OpenAI or Gemini API key in the header
2. **Select File**: Click on a file in the Assets panel to start editing
3. **Write**: Use the Monaco Editor to write your novel
4. **AI Assistance**: 
   - Type questions in the Copilot panel for writing help
   - Click the sparkle icon to expand your current text
   - Use "Insert to Editor" to add AI-generated content

## Project Structure

```
NovelAssistance/
├── src/
│   ├── components/          # React components
│   │   ├── AssetsPanel.tsx  # File system manager
│   │   ├── EditorPanel.tsx  # Monaco editor
│   │   ├── CopilotPanel.tsx # AI chat interface
│   │   └── Header.tsx      # App header with API key input
│   ├── stores/             # Zustand state management
│   │   ├── fileStore.ts    # File system state
│   │   └── settingsStore.ts # Settings (API keys, etc.)
│   ├── services/           # API services
│   │   └── aiService.ts    # AI API integration
│   ├── App.tsx             # Main app component
│   ├── main.tsx            # Entry point
│   └── styles.css          # Global styles
├── src-tauri/              # Tauri backend (Rust)
│   ├── src/
│   │   └── main.rs         # Tauri entry point
│   └── tauri.conf.json     # Tauri configuration
└── package.json            # Node dependencies
```

## Roadmap

- [x] Phase 1 (MVP): Three-column layout with basic AI expansion
- [ ] Phase 2 (Logic): World-building and character management pages
- [ ] Phase 3 (Optimization): Gemini Context Caching for long novels
- [ ] Phase 4 (Advanced): Timeline logic conflict detection

## License

MIT License - feel free to use this project for your creative writing needs!

## Contributing

Contributions are welcome! Please feel free to submit issues or pull requests.