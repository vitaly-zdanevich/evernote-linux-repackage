#!/usr/bin/env node
const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function normalizeTargetArch(value) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase();
  if (['x64', 'x86_64', 'amd64'].includes(normalized)) {
    return 'x64';
  }
  if (['arm64', 'aarch64'].includes(normalized)) {
    return 'arm64';
  }
  return normalized;
}

const targetArch = normalizeTargetArch(
  process.env.EVERNOTE_TARGET_ARCH || process.env.TARGET_ARCH || process.arch,
);
const launcher = path.join(ROOT, 'dist', `Evernote-linux-${targetArch}`, 'evernote');

if (!fs.existsSync(launcher)) {
  console.error(`Built Evernote launcher not found: ${launcher}`);
  console.error('Run npm run build first, or set TARGET_ARCH to the built architecture.');
  process.exit(1);
}

const result = childProcess.spawnSync(launcher, process.argv.slice(2), {
  stdio: 'inherit',
});
if (result.error) {
  throw result.error;
}
process.exit(result.status === null ? 1 : result.status);
