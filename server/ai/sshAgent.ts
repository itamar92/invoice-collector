/**
 * AI over SSH: the prompt goes down stdin to a fixed remote command; the remote forced command
 * decides what actually runs. The host key is pinned (sha256, as `ssh-keygen -lf` prints it);
 * nothing is exec'd or written until the key has been verified.
 * Ported from account-manager/app/server/agentClient.ts (the pin there is the raw key; here it is a sha256 fingerprint).
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { EventEmitter } from 'node:events';
import ssh2 from 'ssh2';
import {
  AiUnavailableError, parseJsonReply, type AiProvider, type AiRequest,
} from './provider.js';

/** Fixed remote command. Never built from any input. */
export const SSH_COMMAND = 'claude -p';
const SSH_VERSION_COMMAND = 'claude --version';
export const SSH_TIMEOUT_MS = 120_000;
const READY_TIMEOUT_MS = 15_000;

export interface SshConfig { host: string; port: number; user: string; hostKeySha256: string }

/** The slice of ssh2's Client we use; tests supply a fake. */
export interface SshStreamLike extends EventEmitter {
  stderr: EventEmitter;
  end(data?: string): void;
}
export interface SshClientLike extends EventEmitter {
  connect(cfg: Record<string, unknown>): void;
  exec(cmd: string, cb: (err: Error | undefined, stream: SshStreamLike) => void): void;
  end(): void;
  destroy?(): void;
}
export type SshClientFactory = () => SshClientLike;

const defaultFactory: SshClientFactory = () => new ssh2.Client() as unknown as SshClientLike;

/** True when sha256(key) in base64 equals the pin (with or without a "SHA256:" prefix, padding ignored). */
export function hostKeyMatches(key: Buffer, pin: string): boolean {
  const want = pin.trim().replace(/^SHA256:/i, '').replace(/=+$/, '');
  const got = createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
  const a = Buffer.from(got);
  const b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface SshRun { stdout: string; stderr: string; code: number }

/**
 * Connects, verifies the host key, and only then execs `command` and writes `prompt` to stdin.
 * Rejects with AiUnavailableError on mismatch, connect failure or timeout.
 */
export function runOverSsh(opts: {
  client: SshClientLike;
  config: SshConfig;
  privateKey: string;
  command: string;
  prompt: string;
  timeoutMs?: number;
}): Promise<SshRun> {
  const { client, config, command, prompt } = opts;
  const limit = opts.timeoutMs ?? SSH_TIMEOUT_MS;
  return new Promise<SshRun>((resolve, reject) => {
    let verified = false;
    let settled = false;
    let stdout = '';
    let stderr = '';
    const finish = (err: Error | null, run?: SshRun) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { client.end(); client.destroy?.(); } catch { /* already closed */ }
      if (err) reject(err); else resolve(run as SshRun);
    };
    const timer = setTimeout(
      () => finish(new AiUnavailableError(`ssh agent timed out after ${Math.round(limit / 1000)}s`)),
      limit,
    );

    client.on('ready', () => {
      if (!verified) return finish(new AiUnavailableError('ssh host key was not verified'));
      client.exec(command, (err, stream) => {
        if (err) return finish(new AiUnavailableError(`ssh exec failed: ${err.message}`));
        stream
          .on('data', (c: Buffer) => { stdout += c.toString('utf8'); })
          .on('close', (code: number | null) => finish(null, { stdout, stderr, code: Number(code) || 0 }));
        stream.stderr.on('data', (c: Buffer) => { stderr += c.toString('utf8'); });
        stream.end(prompt); // whole prompt, then EOF
      });
    });
    client.on('error', (err: Error) => finish(new AiUnavailableError(`ssh connection failed: ${err.message}`)));

    client.connect({
      host: config.host,
      port: config.port,
      username: config.user,
      privateKey: opts.privateKey,
      readyTimeout: READY_TIMEOUT_MS,
      hostVerifier: (key: Buffer) => {
        if (hostKeyMatches(key, config.hostKeySha256)) { verified = true; return true; }
        finish(new AiUnavailableError('ssh host key mismatch: not the pinned host'));
        return false;
      },
    });
  });
}

export class SshAgentProvider implements AiProvider {
  name = 'ssh';
  supportsPdf = false; // text only
  constructor(
    private config: SshConfig,
    private privateKey: string,
    private factory: SshClientFactory = defaultFactory,
  ) {}

  private run(command: string, prompt: string, timeoutMs?: number): Promise<SshRun> {
    return runOverSsh({
      client: this.factory(), config: this.config, privateKey: this.privateKey, command, prompt, timeoutMs,
    });
  }

  async completeJson(req: AiRequest): Promise<unknown> {
    const prompt = `${req.system}\n\n${req.user}\n\nReply with a single JSON object only.`;
    const r = await this.run(SSH_COMMAND, prompt);
    if (r.code !== 0) throw new AiUnavailableError(`ssh agent exited ${r.code}: ${r.stderr.trim().slice(0, 200)}`);
    return parseJsonReply(r.stdout);
  }

  async ping(): Promise<void> {
    const r = await this.run(SSH_VERSION_COMMAND, '', 30_000);
    if (r.code !== 0) throw new AiUnavailableError(`ssh "${SSH_VERSION_COMMAND}" failed: ${r.stderr.trim().slice(0, 200)}`);
  }
}
