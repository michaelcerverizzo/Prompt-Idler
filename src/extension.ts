import * as vscode from 'vscode';
import * as path from 'node:path';
import { ActivityTracker } from './activity';
import { CopilotDetector } from './detection';
import { WakeController } from './wake';

let shutdown: (() => Promise<void>) | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('Prompt Idler');
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 10);
  status.name = 'Prompt Idler';
  status.command = 'promptIdler.showMenu';
  context.subscriptions.push(output, status);
  const tracker = new ActivityTracker();
  const supported = process.platform === 'win32';
  const local = !vscode.env.remoteName;
  let detector: CopilotDetector | undefined;
  let detectionStatus = 'Detection unavailable: no verified Copilot lifecycle observed yet.';
  let enabled = true;
  let keepDisplayOn = false;
  let staleMinutes = 60;
  let confirmedAwake = false;
  let confirmedDisplay = false;
  let helperError: string | undefined;
  let lastAttemptKey: string | undefined;
  let synchronizing = false;
  let disposed = false;
  let pendingSync: Promise<void> = Promise.resolve();
  const log = (message: string): void => output.appendLine(`${new Date().toISOString()} ${message}`);

  const helper = new WakeController(context.asAbsolutePath('scripts/wake-helper.ps1'), (message) => {
    confirmedAwake = false;
    helperError = message;
    log(`Wake helper error: ${message}`);
    render();
  });

  function render(): void {
    if (disposed) return;
    const state = tracker.snapshot(Date.now());
    const wanted = supported && enabled && state.awake;
    if (!supported) status.text = '$(warning) Prompt Idler: Windows only';
    else if (helperError) status.text = '$(error) Prompt Idler: helper error';
    else if (confirmedAwake && !wanted) status.text = '$(sync~spin) Prompt Idler: releasing';
    else if (!enabled) status.text = '$(circle-slash) Prompt Idler: disabled';
    else if (confirmedAwake) status.text = state.manual ? '$(watch) Prompt Idler: manually awake' : '$(zap) Prompt Idler: automatically awake';
    else if (wanted) status.text = '$(sync~spin) Prompt Idler: starting';
    else status.text = detectionStatus.startsWith('Detection available') ? '$(check) Prompt Idler: idle' : '$(warning) Prompt Idler: detection unavailable';
    status.tooltip = [
      'Prompt Idler — Windows idle sleep prevention',
      detectionStatus,
      `Active detected requests: ${state.automatic}`,
      state.manual ? `Manual timer ends: ${new Date(state.manualUntil).toLocaleTimeString()}` : 'Manual timer: off',
      `Wake request confirmed: ${confirmedAwake ? (confirmedDisplay ? 'system and display' : 'system only') : 'no'}`,
      ...(helperError ? [helperError, 'Use Enable or start a manual session to retry.'] : []),
      'Click for controls. Screen locking and explicit sleep remain controlled by Windows.'
    ].join('\n');
    status.show();
  }

  function sync(): void {
    render();
    if (synchronizing || disposed) return;
    synchronizing = true;
    pendingSync = (async () => {
      while (!disposed) {
        const awake = supported && enabled && tracker.snapshot(Date.now()).awake;
        const display = awake && keepDisplayOn;
        const key = `${awake}:${display}`;
        if (key === lastAttemptKey) break;
        lastAttemptKey = key;
        // No helper needs to be started just to report an initially idle extension.
        if (!awake && !confirmedAwake && !helperError) continue;
        try {
          await helper.setAwake(awake, display);
          confirmedAwake = awake;
          confirmedDisplay = display;
          helperError = undefined;
          log(awake ? `Wake request confirmed (${display ? 'system and display' : 'system only'}).` : 'Wake request released.');
        } catch (error) {
          confirmedAwake = false;
          helperError = error instanceof Error ? error.message : 'Wake helper failed.';
          log(`Wake request failed: ${helperError}`);
        }
        render();
      }
    })().finally(() => { synchronizing = false; render(); });
  }

  function stopDetection(): void {
    detector?.dispose();
    detector = undefined;
  }

  function startDetection(): void {
    if (disposed || detector || !enabled || !supported || !local) return;
    detector = new CopilotDetector(path.dirname(context.logUri.fsPath), {
      onStart: id => { if (!disposed && enabled) { tracker.start(id, Date.now()); sync(); } },
      onEnd: id => { if (!disposed) { tracker.end(id); sync(); } },
      onStatus: message => {
        if (disposed) return;
        if (detectionStatus !== message) log(message);
        detectionStatus = message;
        render();
      }
    }, context.storageUri ? path.join(path.dirname(context.storageUri.fsPath), 'GitHub.copilot-chat', 'debug-logs') : undefined);
    detector.start();
  }

  function configure(): void {
    if (disposed) return;
    const config = vscode.workspace.getConfiguration('promptIdler');
    enabled = config.get<boolean>('enabled', true);
    keepDisplayOn = config.get<boolean>('keepDisplayOn', false);
    const minutes = config.get<number>('staleRequestTimeoutMinutes', 60);
    staleMinutes = Number.isFinite(minutes) ? Math.max(1, Math.min(1440, minutes)) : 60;
    if (!enabled) { stopDetection(); tracker.clear(); }
    else startDetection();
    if (!supported) detectionStatus = 'Detection unavailable: this version supports Windows desktop only.';
    else if (!local) detectionStatus = 'Detection unavailable: remote workspaces are not supported. Manual mode keeps the local Windows client awake.';
    lastAttemptKey = undefined;
    tick();
  }

  function tick(): void {
    if (disposed) return;
    const expired = tracker.expire(Date.now(), staleMinutes * 60_000);
    if (expired) {
      log(`Released ${expired} unresolved request(s) after the ${staleMinutes}-minute timeout.`);
      void vscode.window.showWarningMessage(`Prompt Idler released ${expired} stale request(s). Copilot may still be working; use the manual timer or increase the stale-request timeout.`, 'Start Manual Timer')
        .then(action => { if (action && !disposed) void vscode.commands.executeCommand('promptIdler.startManual'); });
    }
    sync();
  }

  const register = (id: string, callback: (...args: unknown[]) => unknown): void => {
    context.subscriptions.push(vscode.commands.registerCommand(`promptIdler.${id}`, callback));
  };
  register('enable', async () => {
    await vscode.workspace.getConfiguration('promptIdler').update('enabled', true, vscode.ConfigurationTarget.Global);
    if (disposed) return;
    lastAttemptKey = undefined;
    configure();
  });
  register('disable', async () => {
    // Release immediately, even if persisting configuration subsequently fails.
    enabled = false; stopDetection(); tracker.clear(); sync();
    await vscode.workspace.getConfiguration('promptIdler').update('enabled', false, vscode.ConfigurationTarget.Global);
  });
  register('startManual', async () => {
    if (!supported) { void vscode.window.showInformationMessage('Prompt Idler currently supports Windows desktop only.'); return; }
    await vscode.workspace.getConfiguration('promptIdler').update('enabled', true, vscode.ConfigurationTarget.Global);
    if (disposed) return;
    configure();
    tracker.startManual(Date.now()); lastAttemptKey = undefined;
    log('Manual keep-awake timer started for 30 minutes.'); sync();
  });
  register('stopManual', () => { tracker.stopManual(); log('Manual timer stopped.'); sync(); });
  register('showDiagnostics', () => {
    log(`VS Code ${vscode.version}; platform ${process.platform}; local workspace: ${local}; enabled: ${enabled}; display wake: ${keepDisplayOn}.`);
    for (const id of ['GitHub.copilot', 'GitHub.copilot-chat']) {
      const extension = vscode.extensions.getExtension(id);
      log(`${id}: ${extension ? String(extension.packageJSON.version) : 'not installed'}.`);
    }
    log(detectionStatus);
    output.show(true);
  });
  register('showMenu', async () => {
    const items = [
      { label: 'Keep awake for 30 minutes', command: 'startManual' },
      { label: 'Stop manual keep awake', command: 'stopManual' },
      { label: enabled ? 'Disable and release all wake requests' : 'Enable', command: enabled ? 'disable' : 'enable' },
      { label: 'Show diagnostics', command: 'showDiagnostics' },
      { label: 'Open settings', command: 'settings' }
    ];
    const selected = await vscode.window.showQuickPick(items, { title: 'Prompt Idler' });
    if (!selected || disposed) return;
    if (selected.command === 'settings') await vscode.commands.executeCommand('workbench.action.openSettings', 'promptIdler');
    else await vscode.commands.executeCommand(`promptIdler.${selected.command}`);
  });
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
    if (event.affectsConfiguration('promptIdler')) configure();
  }));
  const timer = setInterval(tick, 1000);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });
  shutdown = async () => {
    disposed = true; clearInterval(timer); stopDetection(); tracker.clear();
    await pendingSync;
    await helper.dispose();
  };
  log('Prompt Idler activated. Detection is best-effort; see README for coverage and trace-log setup.');
  configure();
}

export async function deactivate(): Promise<void> {
  await shutdown?.();
  shutdown = undefined;
}
