# LocalClaude

A personal desktop app for Claude on **Windows and Linux**, powered by **Claude Code** through the official Claude Agent SDK, running on **your Claude subscription** (Pro / Max). No API key, no pay-per-token billing.

Everything runs and is stored **on this machine only**. Chats, settings and MCP config are encrypted with a key bound to this computer's machine ID, so copying the data folder to another PC won't open it, and nothing syncs to claude.ai.

## What it can do

| Feature | Notes |
|---|---|
| Chat with streaming replies | Markdown, tables, code with copy button, collapsible thinking |
| Full Claude Code toolset | Read/edit/create files, run shell commands, search the web, fetch pages, subagents, to-do lists |
| Permission prompts | Allow once / Always allow / Deny with a note, like the Claude app |
| 4 permission modes | Ask permissions · Auto-accept edits · Plan mode (approve the plan card) · Full access |
| Claude's questions | AskUserQuestion shows as clickable option cards |
| Working folders | Pick a folder per chat, add extra folders anytime |
| Attachments | Images (paste, drag-drop, 📎) go to Claude; other files are attached as `@path` mentions |
| Slash commands & skills | Type `/` for your commands and skills (from `~/.claude` and the project's `.claude/`) |
| Browser | Toggle "Use my Chrome browser" (Claude in Chrome extension), or add the Playwright MCP preset |
| MCP servers | JSON editor in Settings → Tools; your `~/.claude.json` servers load too |
| Chat history | Searchable sidebar, rename, delete, resume any chat later |
| Model & effort | Opus / Sonnet / Haiku (or whatever your plan lists), effort level |
| Usage | Status line shows your plan's 5-hour window usage and reset time |
| Personal instructions | Settings → General, appended to every chat |
| Light / dark theme | Follows system or forced |

## Requirements

- **Node.js 20+** and npm (only to build it)
- A **Claude Pro or Max** subscription
- Windows 10/11 x64, or a Linux desktop (glibc, x64)

Claude Code itself is bundled; `npm install` downloads the right native binary for your OS.

## Run it

```bash
npm install
npm run dev
```

On first launch, click **Sign in with Claude**. A browser opens to the Claude sign-in page; approve it (if the page shows a code, paste it into the app). If you already use `claude` in a terminal, you're already signed in; the login is shared.

## Build an installer

Build on the OS you're targeting:

```bash
# Windows → release/LocalClaude Setup 1.0.0.exe
npm run dist:win

# Linux → release/LocalClaude-1.0.0.AppImage and .deb
npm run dist:linux
```

The installer is about 250 MB because it carries the native Claude Code binary.

## How "subscription only" is enforced

LocalClaude removes `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL` and the Bedrock/Vertex/Foundry switches from the environment of every Claude Code process it starts. Requests always go through your Claude.ai login. The status line warns if Claude Code ever reports an API-key source.

Anthropic currently lets the Agent SDK use your subscription's normal usage limits for personal projects like this. They announced, then paused, a plan to move SDK usage to a separate monthly credit; if that returns, this app would draw from that credit instead. Don't distribute builds for other people to sign in with; that needs Anthropic's approval.

## How "this machine only" works

- **Storage:** `vault/` in the app-data folder (Settings → About shows it). Every file is AES-256-GCM encrypted with a key derived (scrypt) from the OS machine ID (Windows `MachineGuid`, Linux `/etc/machine-id`). On top of that, Electron safeStorage adds Windows DPAPI or the Linux keyring.
- **Another PC:** the data refuses to open and shows a lock screen. The only option there is to erase it and start fresh.
- **Your Claude account elsewhere:** these chats never reach claude.ai, so the Claude app on other devices can't see them.
- **Claude Code transcripts:** Claude Code also keeps its own plain-text session transcripts under `~/.claude/projects`, which is how chats resume. They're on this machine only, but they are not encrypted.
- **Reinstalling the OS** changes the machine ID. The app then treats the PC as a new machine, so old chats are lost by design.

## Tips

- **Ctrl+N** new chat · **Ctrl+,** settings · **Enter** send · **Shift+Enter** newline · **Esc** stop
- The working folder is fixed once a chat starts, because Claude Code ties the transcript to it. Use "＋ folder" to give access to more folders.
- **Full access** mode can't be used if you run the app as root on Linux; Claude Code refuses that for safety.
- **Windows:** if Claude's shell commands fail, install [Git for Windows](https://git-scm.com/download/win). Claude Code uses Git Bash for its Bash tool.
- **Linux:** no keyring (no gnome-keyring or KWallet) means only the machine-bound encryption layer is active. Settings → Account shows which layers are active.
- **Debug:** `LOCALCLAUDE_DEBUG=1 npm run dev` prints Claude Code's stderr.

## Project layout

```
src/main/agent.ts     Agent SDK sessions → UI events, permissions, interrupt, resume
src/main/claude.ts    bundled binary lookup, subscription-only env, sign-in
src/main/store.ts     encrypted, machine-bound storage
src/main/index.ts     window + IPC
src/preload/          safe bridge (contextIsolation + sandbox)
src/shared/           types + the chat reducer used by both processes
src/renderer/         React UI
test/                 bridge tests (npm test; LOCALCLAUDE_E2E=1 for a live turn)
```
