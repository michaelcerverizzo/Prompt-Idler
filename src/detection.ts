import { promises as fs } from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

export interface DetectorCallbacks {
  onStart(id: string): void;
  onEnd(id: string): void;
  onStatus(message: string): void;
}

export interface ActivityMarker {
  kind: 'start' | 'end';
  id: string;
  timestamp: number;
}

/** Only the source-verified v1 Copilot debug-log turn boundaries are accepted. */
export function parseActivityMarker(line: string): ActivityMarker | undefined {
  if (line.length > 1024 * 1024 || !line.includes('"turn_')) return;
  let entry: Record<string, unknown>;
  try { entry = JSON.parse(line); } catch { return; }
  if (!entry || typeof entry !== 'object' || (entry.v !== undefined && entry.v !== 1)) return;
  if (entry.type !== 'turn_start' && entry.type !== 'turn_end') return;
  if (typeof entry.sid !== 'string' || !/^[\w.-]{1,200}$/.test(entry.sid)) return;
  if (typeof entry.spanId !== 'string' || typeof entry.ts !== 'number' || !Number.isFinite(entry.ts)) return;
  const attrs = entry.attrs as Record<string, unknown> | undefined;
  if (!attrs || typeof attrs.turnId !== 'string' || !/^\d{1,12}$/.test(attrs.turnId)) return;
  const prefix = `${entry.type}-`;
  const suffix = `-${attrs.turnId}`;
  if (!entry.spanId.startsWith(prefix) || !entry.spanId.endsWith(suffix)) return;
  const span = entry.spanId.slice(prefix.length, -suffix.length);
  if (!/^[a-zA-Z0-9-]{1,100}$/.test(span)) return;
  const run = entry.rIdx ?? 0;
  if (typeof run !== 'number' || !Number.isSafeInteger(run) || run < 0) return;
  return {
    kind: entry.type === 'turn_start' ? 'start' : 'end',
    id: `${entry.sid}:${run}:${span}:${attrs.turnId}`,
    timestamp: entry.ts,
  };
}

interface TailState {
  offset: number;
  identity: string;
  decoder: StringDecoder;
  pending: string;
  dropping: boolean;
}

const unavailable = 'Detection unavailable: waiting for supported Copilot debug-log turn markers. Inline completions are unavailable.';
const available = 'Detection available (partial): chat/agent loop turns only; tools between turns, inline completions, and other paths unavailable.';

/** Reads only this workspace's Copilot debug JSONL files, never prompt companion files. */
export class CopilotDetector {
  private readonly files = new Map<string, TailState>();
  private readonly starts = new Map<string, number>();
  private readonly ended = new Set<string>();
  private readonly startedAt = Date.now();
  private initialized = false;
  private disposed = false;
  private busy = false;
  private timer?: NodeJS.Timeout;
  private status = '';
  private supported = false;

  // logRoot is retained as the boundary for future verified output-log adapters.
  // The current adapter intentionally does not infer activity from ordinary logs.
  constructor(
    readonly logRoot: string,
    private readonly callbacks: DetectorCallbacks,
    private readonly debugLogRoot?: string,
  ) {}

  start(): void {
    if (this.timer || this.disposed) return;
    this.report(unavailable);
    void this.poll();
    this.timer = setInterval(() => { void this.poll(); }, 1000);
    this.timer.unref();
  }

  /** Also exposed for deterministic fixture tests. Polls never overlap. */
  async poll(): Promise<void> {
    if (this.disposed || this.busy) return;
    this.busy = true;
    try {
      if (!this.debugLogRoot) {
        this.report('Detection unavailable: this window has no workspace storage. Use manual mode.');
        return;
      }
      const candidates = await this.discover();
      let readFailed = false;
      for (const file of candidates) {
        if (this.disposed) return;
        try { await this.read(file); }
        catch { readFailed = true; }
      }
      // Forget removed tails; newly appearing files will still be timestamp-filtered.
      const present = new Set(candidates);
      for (const file of this.files.keys()) if (!present.has(file)) this.files.delete(file);
      this.initialized = true;
      if (readFailed) this.report('Detection unavailable: a Copilot debug log could not be read. Use manual mode.');
      else if (!this.supported || candidates.length === 0) this.report(unavailable);
      else if (this.starts.size + this.ended.size >= 10_000) this.report('Detection unavailable: marker tracking limit reached. Reload the window or use manual mode.');
      else this.report(available);
    } catch {
      this.report('Detection unavailable: Copilot debug logs cannot be accessed. Use manual mode.');
    } finally { this.busy = false; }
  }

  private async discover(): Promise<string[]> {
    let entries;
    try { entries = await fs.readdir(this.debugLogRoot!, { withFileTypes: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const result: string[] = [];
    // No recursive traversal, symlinks, or workspace-controlled arbitrary paths.
    for (const directory of entries) {
      if (!directory.isDirectory()) continue;
      const root = path.join(this.debugLogRoot!, directory.name);
      try {
        for (const entry of await fs.readdir(root, { withFileTypes: true })) {
          if (entry.isFile() && entry.name.endsWith('.jsonl')) result.push(path.join(root, entry.name));
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    return result;
  }

  private async read(file: string): Promise<void> {
    const handle = await fs.open(file, 'r');
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) return;
      const identity = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
      let state = this.files.get(file);
      if (!state) {
        state = { offset: this.initialized ? 0 : stat.size, identity, decoder: new StringDecoder('utf8'), pending: '', dropping: false };
        this.files.set(file, state);
        // Avoid joining an existing partial historical line onto new data.
        if (!this.initialized && stat.size > 0) {
          const byte = Buffer.alloc(1);
          await handle.read(byte, 0, 1, stat.size - 1);
          state.dropping = byte[0] !== 10;
        }
      } else if (state.identity !== identity || stat.size < state.offset) {
        this.supported = false;
        state.offset = 0;
        state.identity = identity;
        state.decoder = new StringDecoder('utf8');
        state.pending = '';
        state.dropping = false;
      }
      if (stat.size <= state.offset) return;
      const buffer = Buffer.alloc(Math.min(stat.size - state.offset, 256 * 1024));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, state.offset);
      state.offset += bytesRead;
      if (this.disposed) return;
      const text = state.decoder.write(buffer.subarray(0, bytesRead));
      for (const [index, fragment] of text.split('\n').entries()) {
        if (index > 0) {
          if (!state.dropping) this.consume(state.pending.replace(/\r$/, ''));
          state.pending = '';
          state.dropping = false;
        }
        if (!state.dropping) {
          state.pending += fragment;
          if (state.pending.length > 1024 * 1024) { state.pending = ''; state.dropping = true; }
        }
      }
    } finally { await handle.close(); }
  }

  private consume(line: string): void {
    const marker = parseActivityMarker(line);
    if (!marker) {
      // Do not keep claiming compatibility after an observed lifecycle schema change.
      if (line.length <= 1024 * 1024 && line.includes('"turn_')) {
        try {
          const candidate = JSON.parse(line);
          if (candidate?.type === 'turn_start' || candidate?.type === 'turn_end') this.supported = false;
        } catch { /* Partial/malformed unrelated entries do not establish compatibility. */ }
      }
      return;
    }
    if (marker.timestamp < this.startedAt || marker.timestamp > Date.now() + 60_000) return;
    if (marker.kind === 'start') {
      this.supported = true;
      if (this.starts.has(marker.id) || this.ended.has(marker.id)) return;
      // Bound memory; never silently reactivate an evicted request.
      if (this.starts.size + this.ended.size >= 10_000) {
        this.report('Detection unavailable: marker tracking limit reached. Reload the window or use manual mode.');
        return;
      }
      this.starts.set(marker.id, marker.timestamp);
      this.callbacks.onStart(marker.id);
    } else if (this.starts.has(marker.id)) {
      if (marker.timestamp < this.starts.get(marker.id)!) return;
      this.starts.delete(marker.id);
      this.ended.add(marker.id);
      this.callbacks.onEnd(marker.id);
    }
  }

  private report(message: string): void {
    if (this.disposed || message === this.status) return;
    this.status = message;
    this.callbacks.onStatus(message);
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    this.files.clear();
    this.starts.clear();
    this.ended.clear();
  }
}
