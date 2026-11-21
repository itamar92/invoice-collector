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
import { INBOX_FILE, checkInbox, withInboxFile } from './inbox.js';

/** Fixed remote command. Never built from any input. */
export const SSH_COMMAND = 'claude -p';
/** Analysis of a document in the shared inbox; the only variable part is the id the app generated itself. */
export const sshDocumentCommand = (id: string) => `claude -p --document ${id}`;
const SSH_VERSION_COMMAND = 'claude --version';
export const SSH_TIMEOUT_MS = 120_000;
/** Key the agent replies with, instead of fields, when it cannot open the document. */
export const UNREADABLE_KEY = 'documentUnreadable';
/** Reading a scan takes longer; the wrapper stops at 170 s so its own message arrives first. */
export const SSH_DOCUMENT_TIMEOUT_MS = 180_000;
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

    try {
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
    } catch (e) { // e.g. an unparsable private key: ssh2 throws before connecting
      finish(new AiUnavailableError(`ssh connection failed: ${(e as Error).message}`));
    }
  });
}

/**
 * Text goes down stdin. With a shared inbox folder (AI_INBOX_DIR) the agent can also read a document: the PDF is
 * written there for the length of one request (server/ai/inbox.ts). That is slow, so only scans are sent that way.
 */
export class SshAgentProvider implements AiProvider {
  name = 'ssh';
  supportsPdf: boolean;
  pdfOnlyForScans = true;
  constructor(
    private config: SshConfig,
    private privateKey: string,
    private factory: SshClientFactory = defaultFactory,
    private inbox: string | null = null,
  ) {
    this.supportsPdf = inbox !== null;
  }

  private run(command: string, prompt: string, timeoutMs?: number): Promise<SshRun> {
    return runOverSsh({
      client: this.factory(), config: this.config, privateKey: this.privateKey, command, prompt, timeoutMs,
    });
  }

  async completeJson(req: AiRequest): Promise<unknown> {
    const prompt = `${req.system}\n\n${req.user}\n\nReply with a single JSON object only.`;
    const r = req.pdf && this.inbox
      ? await withInboxFile(this.inbox, req.pdf, (id) => this.run(
        sshDocumentCommand(id),
        `The invoice is the file ${INBOX_FILE} in your working directory. Read it with the Read tool `
          + `(it may be a scan or a photo), then answer from what you see in it. If the Read tool fails or the file `
          + `cannot be read, do not guess and do not answer with empty fields: reply with exactly `
          + `{"${UNREADABLE_KEY}": "<the exact error>"} instead.\n\n${prompt}`,
        SSH_DOCUMENT_TIMEOUT_MS,
      ))
      : await this.run(SSH_COMMAND, prompt);
    if (r.code !== 0) throw new AiUnavailableError(`ssh agent exited ${r.code}: ${r.stderr.trim().slice(0, 200)}`);
    req.onUsage?.(null); // the agent's CLI does not report tokens; the call is still counted
    const reply = parseJsonReply(r.stdout);
    const unreadable = (reply as Record<string, unknown> | null)?.[UNREADABLE_KEY];
    if (req.pdf && this.inbox && unreadable !== undefined) {
      // Usually setup (folder permissions, pdftoppm missing on the agent host): the item waits and retries, and
      // gives up after a few tries while other documents get through.
      throw new AiUnavailableError(`ssh agent could not read the document: ${String(unreadable).slice(0, 200)}`);
    }
    return reply;
  }

  async ping(): Promise<void> {
    if (this.inbox) checkInbox(this.inbox);
    const r = await this.run(SSH_VERSION_COMMAND, '', 30_000);
    if (r.code !== 0) throw new AiUnavailableError(`ssh "${SSH_VERSION_COMMAND}" failed: ${r.stderr.trim().slice(0, 200)}`);
  }
}
