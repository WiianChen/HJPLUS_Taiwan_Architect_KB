import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
type Entry = { name: string; kind: string; size: number; mtimeMs: number; sha256?: string };
export type Decision = { fileName: string; category?: string; expectedFingerprint?: string; reason: string; evidence?: string; action?: 'move' | 'hold' };
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const temporary = (name: string) => /^(\.|~\$)|\.(tmp|part|crdownload|download|lock)$/i.test(name);
function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
export class Archive {
  readonly root: string;
  readonly raw: string;
  readonly pending: string;
  readonly state: string;
  constructor(root = path.resolve(__dirname, '..', '..'), state?: string) {
    this.root = path.resolve(root);
    this.raw = path.join(this.root, 'raw');
    this.pending = path.join(this.raw, '!待整理');
    this.state = state ?? path.join(this.root, 'mcp', '.archive-state');
  }
  private safe(relative: string, base: string): string {
    check(typeof relative === 'string' && relative.length > 0 && !path.isAbsolute(relative), 'Relative path required');
    const parts = relative.split(/[\\/]/);
    check(parts.every(p => p && p !== '..' && p !== '.' && !/[<>:"|?*\x00-\x1f]/.test(p) && !/[. ]$/.test(p)), 'Unsafe path');
    const resolved = path.resolve(base, ...parts);
    check(resolved.toLowerCase().startsWith(base.toLowerCase() + path.sep), 'Path escapes scope');
    this.checkLinks(resolved);
    return resolved;
  }
  private checkLinks(target: string) {
    const chain: string[] = [];
    for (let p = path.resolve(target); ; p = path.dirname(p)) { chain.push(p); if (p === path.dirname(p)) break; }
    for (const p of chain.reverse()) {
      try { check(!fs.lstatSync(p).isSymbolicLink(), 'Symbolic links/junctions prohibited: ' + p); }
      catch (e: any) { if (e.code !== 'ENOENT') throw e; }
    }
  }
  snapshot(target: string) {
    const entries: Entry[] = [];
    const walk = (p: string, name: string) => {
      this.checkLinks(p);
      const before = fs.lstatSync(p);
      check(!temporary(path.basename(p)), 'Temporary item');
      check(Date.now() - before.mtimeMs >= 600000, 'Modified within 10 minutes');
      if (before.isDirectory()) {
        entries.push({ name, kind: 'directory', size: 0, mtimeMs: before.mtimeMs });
        for (const child of fs.readdirSync(p).sort()) walk(path.join(p, child), name ? name + '/' + child : child);
      } else {
        check(before.isFile(), 'Unsupported filesystem item');
        const sha256 = digest(fs.readFileSync(p));
        const after = fs.lstatSync(p);
        check(before.size === after.size && before.mtimeMs === after.mtimeMs, 'File changed while reading');
        entries.push({ name, kind: 'file', size: before.size, mtimeMs: before.mtimeMs, sha256 });
      }
    };
    walk(target, '');
    return { entries, fingerprint: digest(JSON.stringify(entries)) };
  }
  list() {
    this.checkLinks(this.pending);
    check(fs.statSync(this.pending).isDirectory(), 'Pending directory unavailable');
    const oldFile = path.join(this.state, 'last-results.json');
    const priorHolds = new Map<string, any>();
    if (fs.existsSync(oldFile)) {
      const prior = JSON.parse(fs.readFileSync(oldFile, 'utf8'));
      if (Array.isArray(prior)) for (const row of prior) if (row?.status === 'hold' && typeof row.fileName === 'string') priorHolds.set(row.fileName, row);
    }
    const items = fs.readdirSync(this.pending).sort().map(fileName => {
      try {
        const snapshot = this.snapshot(this.safe(fileName, this.pending));
        const prior = priorHolds.get(fileName);
        if (prior?.expectedFingerprint === snapshot.fingerprint) return { fileName, status: 'waiting_confirmation', reason: prior.reason, evidence: prior.evidence, ...snapshot };
        return { fileName, status: 'ready', ...snapshot };
      }
      catch (e: any) { return { fileName, status: 'hold', reason: e.message }; }
    });
    return { databaseRoot: this.root, pendingDirectory: this.pending, stateDirectory: this.state, items };
  }
  private append(event: object) {
    const fd = fs.openSync(path.join(this.state, 'journal.jsonl'), 'a');
    try { fs.writeSync(fd, JSON.stringify({ ...event, time: new Date().toISOString() }) + '\n'); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
  }
  private lock() {
    fs.mkdirSync(this.state, { recursive: true });
    const lockFile = path.join(this.state, 'run.lock');
    const fd = fs.openSync(lockFile, 'wx');
    fs.writeSync(fd, JSON.stringify({ pid: process.pid, host: os.hostname(), started: new Date().toISOString() }));
    fs.fsyncSync(fd);
    return () => { fs.closeSync(fd); fs.unlinkSync(lockFile); };
  }
  private recover() {
    const journal = path.join(this.state, 'journal.jsonl');
    const open = new Map<string, any>();
    if (!fs.existsSync(journal)) return;
    for (const line of fs.readFileSync(journal, 'utf8').split('\n').filter(Boolean)) {
      const row = JSON.parse(line);
      if (row.status === 'prepared') open.set(row.id, row);
      if (['success', 'recovered', 'aborted'].includes(row.status)) open.delete(row.id);
    }
    for (const row of open.values()) {
      const source = this.safe(row.fileName, this.pending);
      const category = this.safe(row.category, this.raw);
      check(row.category.split(/[\\/]/)[0].toLowerCase() !== '!待整理', 'Invalid recovery destination');
      const destination = this.safe(row.fileName, category);
      const a = fs.existsSync(source), b = fs.existsSync(destination);
      if (!a && b && this.snapshot(destination).fingerprint === row.expectedFingerprint) this.append({ ...row, status: 'recovered' });
      else if (a && !b && this.snapshot(source).fingerprint === row.expectedFingerprint) this.append({ ...row, status: 'aborted' });
      else throw new Error('Unresolved interrupted move: ' + row.id + '; inspect journal and both paths');
    }
  }
  private move(source: string, destination: string, directory: boolean) {
    check(process.platform === 'win32', 'This no-overwrite mover requires Windows');
    const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    execFileSync(ps, ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference='Stop'; [System.IO.${directory ? 'Directory' : 'File'}]::Move($env:SOP_MOVE_SOURCE,$env:SOP_MOVE_DESTINATION)`], {
      windowsHide: true, env: { ...process.env, SOP_MOVE_SOURCE: source, SOP_MOVE_DESTINATION: destination }, encoding: 'utf8'
    });
  }
  batch(decisions: Decision[], dryRun = false) {
    check(Array.isArray(decisions), 'Decisions must be an array');
    const release = this.lock();
    try {
      this.recover();
      const oldFile = path.join(this.state, 'last-results.json');
      const previous = fs.existsSync(oldFile) ? JSON.parse(fs.readFileSync(oldFile, 'utf8')) : [];
      const results = decisions.map(d => {
        const id = randomUUID();
        try {
          check(typeof d.fileName === 'string' && !/[\\/]/.test(d.fileName), 'Only direct pending items may be moved');
          const source = this.safe(d.fileName, this.pending);
          check(typeof d.reason === 'string' && d.reason.trim(), 'Classification reason required');
          if (d.action === 'hold') return { ...d, id, status: 'hold' };
          check(d.evidence?.trim(), 'Content evidence required');
          const before = this.snapshot(source);
          check(d.expectedFingerprint === before.fingerprint, 'Expected fingerprint missing or stale; list and read content again');
          const category = this.safe(d.category || '', this.raw);
          check((d.category || '').split(/[\\/]/)[0].toLowerCase() !== '!待整理', 'Cannot archive into pending');
          check(fs.statSync(category).isDirectory(), 'Existing category directory required');
          const destination = this.safe(d.fileName, category);
          check(!fs.existsSync(destination), 'Destination already exists; source retained');
          const record = { ...d, id, source, destination, entries: before.entries };
          if (dryRun) return { ...record, status: 'preview' };
          this.append({ ...record, status: 'prepared' });
          check(this.snapshot(source).fingerprint === before.fingerprint, 'Source changed before move');
          this.checkLinks(category);
          this.move(source, destination, before.entries[0].kind === 'directory');
          check(!fs.existsSync(source) && this.snapshot(destination).fingerprint === before.fingerprint, 'Post-move verification failed; inspect journal');
          this.append({ ...record, status: 'success' });
          return { ...record, status: 'success' };
        } catch (e: any) { return { ...d, id, status: 'error', error: e.message }; }
      });
      if (!dryRun) {
        for (const row of results.filter(r => r.status !== 'success')) this.append(row);
        const signature = (rows: any[]) => JSON.stringify(rows.map(({ id, ...row }) => row));
        const changed = signature(previous) !== signature(results);
        const next = oldFile + '.next';
        fs.writeFileSync(next, JSON.stringify(results, null, 2));
        fs.renameSync(next, oldFile);
        return { databaseRoot: this.root, stateDirectory: this.state, changed, results };
      }
      return { databaseRoot: this.root, stateDirectory: this.state, changed: false, results };
    } finally { release(); }
  }
}
