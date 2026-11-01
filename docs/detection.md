# Automatic detection: compatibility and evidence

Automatic detection is **partial and experimental**. Prompt Idler watches Copilot's optional workspace debug JSONL logs for source-verified `turn_start` / `turn_end` pairs. It does not observe all Copilot requests and does not treat ordinary editor activity as evidence of a request.

## Coverage

| Activity | Coverage |
| --- | --- |
| Chat/agent work using `ToolCallingLoop.runOne` | Individual loop iterations, when debug file logging emits supported v1 boundaries |
| Tool execution, hooks, approval waits between loop iterations | Not guaranteed; use the manual timer for uninterrupted whole-task protection |
| Cancellation or exception before `turn_end` | May omit end marker; extension stale-request timeout releases wakefulness |
| Inline completions / next edit suggestions | Unavailable: no verified paired lifecycle adapter implemented |
| Other chat paths, CLI agents, remote workspaces | Unavailable |
| Requests already running when Prompt Idler activates | Not replayed; use manual mode |

The adapter was checked against public Copilot Chat source commit [`5863f5a7088958050792b5dccbe8b46c6e13eccc`](https://github.com/microsoft/vscode-copilot-chat/tree/5863f5a7088958050792b5dccbe8b46c6e13eccc), whose package version is `0.44.0` (development source). **No live Windows / VS Code / Copilot combination has been validated in this Linux build environment.** Source verification is not a guarantee of release compatibility.

## Enabling the optional logs

In a local Windows workspace, enable Copilot's **Agent Debug Log: File Logging: Enabled** user setting if available in your installed version:

```json
"github.copilot.chat.agentDebugLog.fileLogging.enabled": true
```

The inspected source migrates this legacy contributed setting toward `github.copilot.chat.chatDebug.fileLogging.enabled`; newer versions may expose the latter. Use the setting recognized by your installed Copilot version and reload the VS Code window. Prompt Idler never changes either setting automatically. Increasing the ordinary output-channel log level alone does not enable this adapter.

Copilot's debug files can contain prompts, responses, tool arguments, and workspace details. Enabling them is an explicit user choice. Prompt Idler reads JSONL lines transiently, extracts only timestamps and lifecycle IDs, and does not persist or transmit their contents. It does not read the companion system-prompt or tools JSON files.

Logs reside under the current workspace storage directory, in `GitHub.copilot-chat/debug-logs/<session-id>/*.jsonl` (Windows paths are case-insensitive). An untitled window without workspace storage cannot use this adapter. Files are polled once per second; Copilot normally flushes every four seconds, so detection is delayed. Very short requests can begin and end before the next poll and may not produce a sustained wake request. A pre-existing system idle deadline shorter than this latency may still cause sleep.

## Source references

- [`toolCallingLoop.ts`, lines 893–907](https://github.com/microsoft/vscode-copilot-chat/blob/5863f5a7088958050792b5dccbe8b46c6e13eccc/src/extension/intents/node/toolCallingLoop.ts#L893): boundaries surround `runOne`, not the whole user task; the end event is not in a `finally` block.
- [`chatDebugFileLoggerService.ts`, lines 758–782](https://github.com/microsoft/vscode-copilot-chat/blob/5863f5a7088958050792b5dccbe8b46c6e13eccc/src/extension/chat/vscode-node/chatDebugFileLoggerService.ts#L758): JSONL schema, IDs and turn attributes.
- [Same service, lines 183–195](https://github.com/microsoft/vscode-copilot-chat/blob/5863f5a7088958050792b5dccbe8b46c6e13eccc/src/extension/chat/vscode-node/chatDebugFileLoggerService.ts#L183): debug directory relative to workspace `storageUri`.
- [Same service, lines 946–950](https://github.com/microsoft/vscode-copilot-chat/blob/5863f5a7088958050792b5dccbe8b46c6e13eccc/src/extension/chat/vscode-node/chatDebugFileLoggerService.ts#L946): top-level agent completion spans are deliberately excluded; these cannot support reliable whole-task pairing.
- [`configurationService.ts`, lines 694–695](https://github.com/microsoft/vscode-copilot-chat/blob/5863f5a7088958050792b5dccbe8b46c6e13eccc/src/platform/configuration/common/configurationService.ts#L694): configuration migration and default flush interval.

## Failure behavior

Existing file contents are skipped at activation. New files are read from their beginning, but old timestamped records are ignored. The adapter handles partial lines, file replacement, truncation, duplicate boundaries, overlapping turns, and unknown schemas. Unrecognized or inaccessible sources report detection unavailable, leaving manual mode usable. Log rotation may lose an end event; stale-request expiry is the fallback. Tracking is bounded at 10,000 distinct turns per extension lifetime; reload the window if that limit is reached.

Fixtures in `tests/detection.test.ts` are synthetic lifecycle records matching the verified source schema, not captured user prompts.
