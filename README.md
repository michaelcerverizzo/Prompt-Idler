# Prompt Idler

A Windows desktop VS Code extension that prevents idle sleep during **detected Copilot Chat turns**, with a **30-minute manual timer** for work that cannot be detected. System sleep prevention is the default; keeping the display on is optional.

**Automatic coverage is partial and experimental.** VS Code has no general public API for observing every Copilot request. Prompt Idler reads verified start/end records from Copilot Chat's optional debug files. It cannot promise to keep Windows awake for an entire agent task, every tool execution, or inline completions. For those cases, start the manual timer.

## Install

1. Download or build `prompt-idler-0.1.0.vsix`.
2. In desktop VS Code on Windows, run **Extensions: Install from VSIX...** and select it.
3. Click **Prompt Idler** in the status bar for controls, or run **Prompt Idler: Keep Awake for 30 Minutes** from the Command Palette.

The extension uses Windows PowerShell 5.1 and the Windows `SetThreadExecutionState` API. No administrator access, mouse movement, or simulated keystrokes are required. Application-control policies that block PowerShell or `Add-Type` will show a helper error instead of claiming that Windows is awake.

## Automatic detection setup

Use a local folder/workspace with a recent GitHub Copilot Chat version that supports debug-file logging. In **User Settings (JSON)**, opt in to:

```json
{
  "github.copilot.chat.agentDebugLog.fileLogging.enabled": true
}
```

This is a **Copilot setting**, not a Prompt Idler setting. Newer versions may expose the migrated name `github.copilot.chat.chatDebug.fileLogging.enabled`; use the name recognized by your installed version and reload the window. If neither is recognized, that build is unsupported by this detector. Copilot's debug files can contain prompts, responses, and code; enable them only if you want Copilot to write that data locally. Prompt Idler does not enable this setting, change Copilot, send telemetry, or copy prompt contents to its diagnostics.

Open a local workspace, enable logging, and start a new Copilot chat/agent turn. Prompt Idler begins watching from its activation point, so an already running request may not be detected. Until a supported start record is observed, the status bar says **detection unavailable**. The tooltip and **Show Diagnostics** command explain coverage. No trace log-level change is required.

| Activity | Automatic coverage in 0.1.0 |
| --- | --- |
| Copilot Chat/agent loop turns with paired debug markers | Partial; starts after Copilot flushes the record and Prompt Idler reads it |
| Complete multi-step agent task, hooks, tools between turns | Not guaranteed; use manual timer |
| Inline completions, next-edit suggestions, other request paths | Unavailable; use manual timer |
| WSL, SSH, Dev Containers, Codespaces | Automatic detection unavailable; manual mode affects the local Windows client only |
| Empty VS Code window without workspace storage | Automatic detection unavailable |
| macOS, Linux, VS Code for Web | Not supported |

Overlapping detected turns keep the wake request active until the last observed turn finishes. Failed/canceled turns without an end marker expire after the configured stale-request timeout. Log rotation and format changes may interrupt detection. See [detection notes](docs/detection.md) for source references and limitations.

## Controls and settings

All settings apply to the current machine through user settings; workspace files cannot configure the wake helper.

| Setting | Default | Behavior |
| --- | --- | --- |
| `promptIdler.enabled` | `true` | Enable detection and controls; disabling clears automatic and manual requests |
| `promptIdler.keepDisplayOn` | `false` | Also request that the display stay on while awake |
| `promptIdler.staleRequestTimeoutMinutes` | `60` | Release unresolved detected turns after 1–1440 minutes; show a warning |

- **Enable** retries the helper after an error.
- **Disable and Release Wake Requests** releases all requests in this window.
- **Keep Awake for 30 Minutes** enables Prompt Idler and starts/restarts the manual timer.
- **Stop Manual Keep Awake** stops only the manual timer; detected turns still keep Windows awake.
- **Show Diagnostics** shows state, coverage, and extension versions, without prompt text.

The status bar reports awake only after the helper acknowledges success. Windows combines wake requests from multiple VS Code windows; stopping one window does not release another window's request. Closing VS Code releases the request; if the extension host hangs or crashes, a helper watchdog exits after roughly 15 seconds without heartbeats. Explicit sleep, closing the lid, screen locking, and organizational power policies remain controlled by Windows.

## Build and develop

Use Node.js 22 or newer:

```sh
npm ci --ignore-scripts
npm run validate
npm run package
```

The VSIX is written to the repository root. Open this folder in VS Code and press **F5** to launch an Extension Development Host. The GitHub Actions workflow validates and packages on Windows and Linux, and retains the VSIX as an artifact. It does not publish to the Marketplace.

## Validation status

The TypeScript build and automated tests can run on Linux. Tests cover request tracking, log parsing/tailing, helper acknowledgments, failures, and cleanup. Native helper tests run only on Windows. Source inspection verifies the detector's expected marker format; this is not a claim of compatibility testing against an installed Copilot release.

Before relying on this version, run the [Windows acceptance checklist](docs/windows-validation.md) on your machine. This development environment does not provide Windows, a desktop VS Code session, or an authenticated Copilot session, so actual idle-sleep behavior and live Copilot detection remain unverified here.
