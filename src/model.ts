/**
 * Model management — download + sha256 verify the local Qwen 2.5 3B GGUF.
 *
 * Trust posture:
 *   - One model, one digest, pinned. We do not auto-resolve "latest".
 *   - SHA-256 verification is mandatory; a corrupt download fails closed.
 *   - Weights live under ~/.quaestor/models, NEVER inside the repo or
 *     node_modules — package size stays small and uninstalls don't waste 2GB.
 */
import { createHash } from 'node:crypto';
import { mkdir, rename, stat, unlink } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export interface ModelSpec {
  /** Logical id surfaced to consumers + audit trail. Stable across patch downloads. */
  id: string;
  /** Filename inside the model dir. */
  filename: string;
  /** Hugging Face download URL. */
  url: string;
  /** Pinned sha256 of the .gguf bytes. */
  sha256: string;
  /** Approximate size for progress reporting. */
  approx_bytes: number;
}

export const QWEN_2_5_3B_Q4KM: ModelSpec = {
  id: 'qwen2.5-3b-instruct-q4_k_m',
  filename: 'qwen2.5-3b-instruct-q4km.gguf',
  url: 'https://huggingface.co/bartowski/Qwen2.5-3B-Instruct-GGUF/resolve/main/Qwen2.5-3B-Instruct-Q4_K_M.gguf',
  // Pinned digest of the upstream Q4_K_M GGUF as published by bartowski.
  // Verified at first install; do not bump without re-running the eval.
  sha256: '9c9f56a391a3abbd5b89d0245bf6106081bcc3173119d4229235dd9d23253f94',
  approx_bytes: 2_019_377_088,
};

export function modelDir(): string {
  return path.join(homedir(), '.quaestor', 'models');
}

export function modelPath(spec: ModelSpec = QWEN_2_5_3B_Q4KM): string {
  return path.join(modelDir(), spec.filename);
}

export async function modelExists(spec: ModelSpec = QWEN_2_5_3B_Q4KM): Promise<boolean> {
  try {
    const s = await stat(modelPath(spec));
    return s.isFile() && s.size > 0;
  } catch {
    return false;
  }
}

/** Stream-hash a file without loading it into memory. */
export async function sha256OfFile(file: string): Promise<string> {
  const hasher = createHash('sha256');
  await pipeline(createReadStream(file), hasher);
  return hasher.digest('hex');
}

export interface DownloadOptions {
  /** Override default model spec (testing only). */
  spec?: ModelSpec;
  /** Skip sha256 verification. ONLY for local development; never default true. */
  skipVerify?: boolean;
  /** Force re-download even if file exists. */
  force?: boolean;
  /** Progress callback (bytes_downloaded, total_bytes). */
  onProgress?: (downloaded: number, total: number) => void;
}

/**
 * Download the model GGUF if not present. Verifies sha256 against the pinned
 * digest. Writes atomically via .partial → rename.
 *
 * Returns the absolute path to the verified model file.
 */
export async function downloadModel(opts: DownloadOptions = {}): Promise<string> {
  const spec = opts.spec ?? QWEN_2_5_3B_Q4KM;
  const dir = modelDir();
  const final = modelPath(spec);
  const tmp = `${final}.partial`;

  await mkdir(dir, { recursive: true });

  if (!opts.force && (await modelExists(spec))) {
    if (opts.skipVerify) return final;
    const digest = await sha256OfFile(final);
    if (digest === spec.sha256) return final;
    process.stderr.write(
      `[quaestor-policy] existing model digest mismatch (got ${digest.slice(0, 16)}…), re-downloading\n`,
    );
    await unlink(final);
  }

  process.stderr.write(`[quaestor-policy] downloading ${spec.id} (~${formatGB(spec.approx_bytes)})\n`);
  process.stderr.write(`[quaestor-policy] source: ${spec.url}\n`);

  const res = await fetch(spec.url);
  if (!res.ok || !res.body) {
    throw new Error(`download_failed: HTTP ${res.status} ${res.statusText}`);
  }
  const total = Number(res.headers.get('content-length') ?? spec.approx_bytes);

  let downloaded = 0;
  let lastTick = Date.now();
  const reader = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
  const sink = createWriteStream(tmp);

  reader.on('data', (chunk: Buffer) => {
    downloaded += chunk.length;
    if (opts.onProgress) opts.onProgress(downloaded, total);
    const now = Date.now();
    if (now - lastTick > 1000) {
      lastTick = now;
      const pct = total > 0 ? ((downloaded / total) * 100).toFixed(1) : '?';
      process.stderr.write(`[quaestor-policy] ${pct}% (${formatGB(downloaded)} / ${formatGB(total)})\r`);
    }
  });

  await pipeline(reader, sink);
  process.stderr.write('\n');

  if (!opts.skipVerify) {
    process.stderr.write('[quaestor-policy] verifying sha256…\n');
    const digest = await sha256OfFile(tmp);
    if (digest !== spec.sha256) {
      await unlink(tmp);
      throw new Error(
        `sha256_mismatch: expected ${spec.sha256} got ${digest}. ` +
          'Refusing to install an unverified model.',
      );
    }
  }

  await rename(tmp, final);
  process.stderr.write(`[quaestor-policy] ready: ${final}\n`);
  return final;
}

function formatGB(bytes: number): string {
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return `${gb.toFixed(2)} GB`;
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(0)} MB`;
}

export class ModelMissingError extends Error {
  readonly code = 'MODEL_MISSING' as const;
  readonly install_hint = 'run: pnpm exec quaestor-policy install';
  constructor(spec: ModelSpec = QWEN_2_5_3B_Q4KM) {
    super(`model not installed: ${spec.id} (${modelPath(spec)})`);
    this.name = 'ModelMissingError';
  }
}
