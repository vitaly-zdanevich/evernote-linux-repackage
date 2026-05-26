#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DIST_DIR = path.join(ROOT, 'dist');

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function findAppImages(dir) {
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.AppImage'))
    .sort()
    .map((name) => path.join(dir, name));
}

function writeChecksums({ dir = DIST_DIR, output = path.join(DIST_DIR, 'SHA256SUMS') } = {}) {
  const resolvedDir = path.resolve(dir);
  const appImages = findAppImages(resolvedDir);
  if (appImages.length === 0) {
    throw new Error(`No AppImage files found in ${resolvedDir}`);
  }

  const lines = appImages.map((filePath) => `${sha256File(filePath)}  ${path.basename(filePath)}`);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${lines.join('\n')}\n`);
  process.stdout.write(`Wrote ${output}\n`);
  return output;
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dir') {
      options.dir = argv[++index];
    } else if (arg === '--output') {
      options.output = argv[++index];
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

if (require.main === module) {
  try {
    writeChecksums(parseArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}

module.exports = {
  writeChecksums,
};
