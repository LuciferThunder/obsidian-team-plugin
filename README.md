# Team Collaboration

Shared vault documents, real-time co-editing, plugin sync, daily/monthly reports, and AI-powered summaries for Obsidian teams.

## Source code

TypeScript source lives in the [`src/`](src/) directory of this repository, with `package.json`, `tsconfig.json`, and `esbuild.config.mjs` at the repo root.

## Features

- **Shared documents**: Share vault documents to a team drive with collaborative editing
- **Real-time co-editing**: Multi-user editing powered by Yjs
- **Plugin sync**: Sync installed plugins and settings across team members
- **Reports**: Generate daily and monthly team reports
- **AI summaries**: Summarize documents using OpenAI or Claude

## Installation

### From Community Plugins (recommended)

Open **Settings → Community plugins → Browse**, search for **Team Collaboration**, and install.

### Manual installation

Copy these files into `your-vault/.obsidian/plugins/team-collaboration/`:

- `main.js`
- `manifest.json`
- `styles.css`

## Requirements

This plugin requires a **self-hosted or third-party backend server** for team features. The server must expose REST APIs and WebSocket endpoints for collaboration.

For AI summaries, configure an **OpenAI** or **Claude** API key in plugin settings. Requests are sent directly to the provider you configure.

## Configuration

| Setting | Description |
|---------|-------------|
| Server URL | Base URL of your team backend API (e.g. `https://your-server.com`) |
| WebSocket URL | WebSocket endpoint for co-editing (optional; derived from server URL if empty) |
| API key | Authentication token after login |
| AI settings | OpenAI / Claude API key for document summaries |

## Development

```bash
npm install
npm run dev     # watch mode
npm run build   # production build
```

## Network usage and privacy

To comply with Obsidian developer policies, this section describes network behavior.

### Network requests

1. **Team server (user-configured)**
   - Purpose: authentication, team management, document CRUD, collaboration sync
   - When: login, team switch, create/delete/rename documents, opening shared documents
   - Data: document content and paths in request bodies; user token in headers

2. **WebSocket**
   - Purpose: real-time co-editing (Yjs) and team events (document add/remove/rename)
   - When: opening the team view or a shared document
   - Data: document content, cursor positions, and collaboration updates

3. **AI services (OpenAI / Claude)**
   - Purpose: document summarization
   - When: user explicitly triggers a summary
   - Data: selected document content sent to the configured provider
   - Note: only used when an API key is configured; keys are stored locally in plugin settings

### Telemetry

- This plugin does **not** collect telemetry
- No usage analytics, crash reports, or behavioral tracking are sent to third parties
- All network traffic goes to servers explicitly configured by the user

### Privacy

- Daily reports, monthly reports, and the picker for sharing an existing note list Markdown file paths in the vault. Contents are read only for notes included in a report or shared to the team drive.
- If you check Remember account or Remember password, those values stay in this vault's plugin data. They are not uploaded by plugin sync.
- Document content is sent only to your configured team server and (optionally) AI providers
- Review your backend's data retention and privacy policies
- When using AI summaries, content is sent to OpenAI or Anthropic under their terms of service

## License

MIT
