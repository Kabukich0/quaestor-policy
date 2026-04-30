#!/usr/bin/env node
/**
 * quaestor-policy CLI — minimal surface, no oclif dependency.
 *
 *   quaestor-policy install   download + verify the GGUF
 *   quaestor-policy health    print model + dir status
 *   quaestor-policy version
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(path.join(here, '..', 'package.json'), 'utf8'));

const cmd = process.argv[2];

async function main() {
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    process.stdout.write(
      `quaestor-policy ${pkg.version}\n` +
        '\n' +
        'usage: quaestor-policy <command>\n' +
        '\n' +
        'commands:\n' +
        '  install    download + sha256-verify the policy model\n' +
        '  health     print model availability + directory\n' +
        '  version    print package version\n',
    );
    return 0;
  }
  if (cmd === 'version' || cmd === '--version' || cmd === '-v') {
    process.stdout.write(`${pkg.version}\n`);
    return 0;
  }
  // Lazy-load so `version`/`help` work without requiring the build.
  const dist = path.join(here, '..', 'dist', 'src');
  if (cmd === 'install') {
    const { downloadModel } = await import(path.join(dist, 'model.js'));
    await downloadModel();
    return 0;
  }
  if (cmd === 'health') {
    const { healthCheck } = await import(path.join(dist, 'index.js'));
    const h = await healthCheck();
    process.stdout.write(`${JSON.stringify(h, null, 2)}\n`);
    return h.ok ? 0 : 1;
  }
  process.stderr.write(`unknown command: ${cmd}\n`);
  return 2;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`error: ${err.message ?? err}\n`);
    process.exit(1);
  },
);
