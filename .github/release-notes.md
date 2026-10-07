A personal desktop app for Claude on Windows and Linux, powered by Claude Code and your own Claude Pro or Max subscription. See the [README](https://github.com/partham20/localclaude#readme) for everything it does.

## Downloads

| File | For |
|---|---|
| `LocalClaude-Setup-<version>.exe` | Windows 10/11 (x64). Run it and follow the installer |
| `LocalClaude-<version>.AppImage` | Any Linux desktop (x64, glibc). `chmod +x` it and run it; needs `libfuse2` |
| `localclaude_<version>_amd64.deb` | Debian and Ubuntu: `sudo apt install ./localclaude_<version>_amd64.deb` |
| Source code (zip / tar.gz) | Build it yourself: `npm install`, then `npm run dist:win` or `npm run dist:linux` |

The installers aren't code-signed, so Windows SmartScreen may say "Windows protected your PC": choose **More info → Run anyway**.

On first launch, click **Sign in with Claude**. Your chats are stored encrypted on that computer only.

**Personal use:** LocalClaude signs in with your own Claude subscription. Anthropic allows that for personal projects; offering it to other people to sign in with needs Anthropic's approval.
