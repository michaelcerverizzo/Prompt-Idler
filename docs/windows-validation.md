# Windows acceptance checklist

Record Windows version, VS Code version, both GitHub Copilot extension versions, and results. A Windows CI test passing verifies the helper protocol/native call, not actual hardware sleep behavior or Copilot compatibility.

1. Install the VSIX in desktop VS Code on Windows with a local workspace. Confirm detection is unavailable without supported Copilot logs; do not interpret this state as awake.
2. Start the 30-minute manual timer. Confirm the status changes to manually awake only after helper acknowledgment. Use `powercfg /requests` in an elevated diagnostic terminal if needed to inspect Windows' active request. Prompt Idler itself does not need elevation.
3. With the ordinary idle sleep timeout temporarily shortened, verify the machine continues running past that timeout. Restore the original timeout after testing. With display wake disabled, confirm the display can turn off; with it enabled, confirm the display remains on. Locking must continue to work normally.
4. Stop manual mode, disable the extension, reload the window, and close VS Code in separate trials. Confirm each releases this window's request. Test two VS Code windows; stopping one must not release the other's active request.
5. Enable Copilot debug-file logging as described in the README. Start a new chat/agent turn and verify supported turns transition to automatically awake, then idle. Try overlapping chat sessions and cancellation. A cancellation without an end marker must expire with a warning at the configured timeout (temporarily set to one minute).
6. Run an agent task with tools, hooks, or pauses between turns, and inline completions. These are not fully covered; use the manual timer and verify it stays active across detection gaps. Do not report these paths as fully supported based only on one successful turn.
7. Change the display setting while awake. Confirm the helper updates without leaving the old display request active. Simulate a helper failure and confirm the status reports an error. Enable or start a manual session to retry.
8. Terminate the extension host while awake and confirm the helper exits/releases within roughly 15 seconds. Run `npm test` on Windows to exercise real helper acknowledgments, EOF cleanup, and heartbeat expiry as well.
9. Open a remote workspace: automatic detection must report unavailable. Manual mode should affect the local Windows computer only.

Do not enable Marketplace publication or claim end-to-end validation until these checks have been run and their results recorded.
