#!/usr/bin/env node
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const MIME_TYPES = [
  'audio/flac',
  'audio/flac  ',
  'audio/flac ;',
  'audio/x-flac',
  'audio/ogg; codecs=flac',
  'audio/mpeg',
  'audio/mp4',
  'audio/wav',
  'audio/x-wav',
  'audio/ogg',
];

function defaultElectronPath() {
  const buildElectron = path.join(ROOT, '.cache', 'work', 'electron', 'electron');
  if (fs.existsSync(buildElectron)) {
    return buildElectron;
  }

  return '';
}

function commandPath(command) {
  const result = childProcess.spawnSync('sh', ['-c', 'command -v "$1"', 'sh', command], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return result.status === 0 ? result.stdout.trim() : '';
}

function parseArgs(argv) {
  const options = {
    electron: process.env.EVERNOTE_ELECTRON || defaultElectronPath(),
    useXvfb: process.env.SMOKE_USE_XVFB !== '0',
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--electron') {
      options.electron = argv[++index];
    } else if (arg === '--no-xvfb') {
      options.useXvfb = false;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function writeProbeScript(filePath) {
  fs.writeFileSync(
    filePath,
    [
      '"use strict";',
      'const { app, BrowserWindow } = require("electron");',
      "app.commandLine.appendSwitch('no-sandbox');",
      'app.whenReady().then(async () => {',
      '  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: false } });',
      "  await win.loadURL('data:text/html,<html><body></body></html>');",
      `  const result = await win.webContents.executeJavaScript(\`(() => {`,
      `    const mimeTypes = ${JSON.stringify(MIME_TYPES)};`,
      "    const audio = document.createElement('audio');",
      "    const video = document.createElement('video');",
      '    return Object.fromEntries(',
      '      mimeTypes.map((type) => [type, { audio: audio.canPlayType(type), video: video.canPlayType(type) }]),',
      '    );',
      '  })()`);',
      '  process.stdout.write(`${JSON.stringify(result, null, 2)}\\n`);',
      '  app.exit(0);',
      '}).catch((error) => {',
      '  console.error(error);',
      '  app.exit(1);',
      '});',
      '',
    ].join('\n'),
  );
}

function checkMediaSupport(options) {
  const electron = path.resolve(options.electron);
  if (!options.electron) {
    throw new Error(
      'Plain Electron runtime not found. Run npm run build first, or pass --electron /path/to/extracted/electron.',
    );
  }
  if (!fs.existsSync(electron)) {
    throw new Error(`Electron binary not found: ${electron}`);
  }
  if (fs.existsSync(path.join(path.dirname(electron), 'resources', 'app.asar'))) {
    throw new Error(
      'Media support probe needs a plain Electron runtime, not the packaged Evernote binary. Pass --electron /path/to/extracted/electron.',
    );
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evernote-media-support-'));
  const probeScript = path.join(tempDir, 'probe.js');
  const xvfbRun = commandPath('xvfb-run');
  try {
    writeProbeScript(probeScript);
    const electronArgs = ['--no-sandbox', probeScript];
    const command = options.useXvfb && xvfbRun ? xvfbRun : electron;
    const args = options.useXvfb && xvfbRun ? ['-a', electron, ...electronArgs] : electronArgs;
    const result = childProcess.spawnSync(command, args, {
      cwd: ROOT,
      env: {
        ...process.env,
        ELECTRON_DISABLE_SANDBOX: '1',
        LIBGL_ALWAYS_SOFTWARE: '1',
        NO_AT_BRIDGE: '1',
      },
      encoding: 'utf8',
    });
    process.stdout.write(result.stdout || '');
    process.stderr.write(result.stderr || '');
    if (result.error) {
      throw result.error;
    }
    if (result.status !== 0) {
      throw new Error(`${command} exited with status ${result.status}`);
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

if (require.main === module) {
  try {
    checkMediaSupport(parseArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}

module.exports = {
  MIME_TYPES,
  parseArgs,
};
