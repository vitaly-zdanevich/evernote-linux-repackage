#!/usr/bin/env node
'use strict';

const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DIST_DIR = path.join(ROOT, 'dist');
const DEFAULT_TIMEOUT_MS = 45_000;
const REQUIRED_STARTUP_CHECKS = [
  {
    name: 'main process ready',
    pattern: /Main app ready/i,
  },
  {
    name: 'UI URL requested',
    pattern:
      /boron:WindowController trying to load the url app:\/\/evernote\/(?:boronNewLogin|boronMain)\.html/i,
  },
  {
    name: 'webcontents loaded',
    pattern: /boron:WindowController Done loading webcontents/i,
  },
];

const FORBIDDEN_LOG_CHECKS = [
  {
    name: 'disabled updater activity',
    pattern: /electron:autoUpdaterV2 .*Check for updates/i,
  },
  {
    name: 'disabled updater activity',
    pattern: /electron:autoUpdaterShared .*checking for updates/i,
  },
  {
    name: 'disabled updater activity',
    pattern: /IAFUElectronManager .*Check for updates/i,
  },
  {
    name: 'disabled updater endpoint',
    pattern: /ddl-updater/i,
  },
  {
    name: 'renderer process failure',
    pattern: /render-process-gone/i,
  },
  {
    name: 'renderer process failure',
    pattern: /renderer process (?:crashed|gone|killed)/i,
  },
  {
    name: 'app URL load failure',
    pattern: /did-fail-load/i,
  },
  {
    name: 'app URL load failure',
    pattern: /ERR_(?:FILE_NOT_FOUND|UNKNOWN_URL_SCHEME|INVALID_URL)/i,
  },
  {
    name: 'app protocol failure',
    pattern: /Failed to load URL app:\/\/evernote/i,
  },
  {
    name: 'main process JavaScript startup error',
    pattern: /A JavaScript error occurred in the main process/i,
  },
  {
    name: 'main process uncaught exception',
    pattern: /Uncaught Exception/i,
  },
  {
    name: 'missing native shared library',
    pattern: /cannot open shared object file/i,
  },
  {
    name: 'Chromium sandbox startup failure',
    pattern: /FATAL:content\/browser\/sandbox_host_linux\.cc/i,
  },
];

function log(message) {
  process.stdout.write(`${message}\n`);
}

function commandPath(command) {
  const result = childProcess.spawnSync('sh', ['-c', 'command -v "$1"', 'sh', command], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

function readBuildInfoPortDir() {
  const buildInfoPath = path.join(DIST_DIR, 'build-info.json');
  if (!fs.existsSync(buildInfoPath)) {
    return null;
  }
  const buildInfo = JSON.parse(fs.readFileSync(buildInfoPath, 'utf8'));
  if (!buildInfo.portDir) {
    return null;
  }
  return path.isAbsolute(buildInfo.portDir)
    ? buildInfo.portDir
    : path.resolve(ROOT, buildInfo.portDir);
}

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

function defaultPortDir() {
  const buildInfoPortDir = readBuildInfoPortDir();
  if (buildInfoPortDir && fs.existsSync(buildInfoPortDir)) {
    return buildInfoPortDir;
  }
  const targetArch = normalizeTargetArch(
    process.env.EVERNOTE_TARGET_ARCH || process.env.TARGET_ARCH || process.arch,
  );
  return path.join(DIST_DIR, `Evernote-linux-${targetArch}`);
}

function parseArgs(argv) {
  const options = {
    portDir: process.env.EVERNOTE_PORT_DIR || defaultPortDir(),
    executable: process.env.EVERNOTE_SMOKE_EXECUTABLE || '',
    timeoutMs: Number(process.env.SMOKE_TIMEOUT_MS || DEFAULT_TIMEOUT_MS),
    useXvfb: process.env.SMOKE_USE_XVFB !== '0',
    keepHome: process.env.SMOKE_KEEP_HOME === '1',
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--port-dir') {
      options.portDir = argv[++index];
    } else if (arg === '--executable') {
      options.executable = argv[++index];
    } else if (arg === '--timeout-ms') {
      options.timeoutMs = Number(argv[++index]);
    } else if (arg === '--no-xvfb') {
      options.useXvfb = false;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readIfExists(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function tail(text, maxLength = 12_000) {
  return text.length > maxLength ? text.slice(text.length - maxLength) : text;
}

function missingRequiredStartupChecks(combinedLogs) {
  return REQUIRED_STARTUP_CHECKS.filter((check) => !check.pattern.test(combinedLogs)).map(
    (check) => check.name,
  );
}

function hasRequiredStartupEvents(combinedLogs) {
  return missingRequiredStartupChecks(combinedLogs).length === 0;
}

function firstForbiddenLogCheck(combinedLogs) {
  for (const check of FORBIDDEN_LOG_CHECKS) {
    if (check.pattern.test(combinedLogs)) {
      return check;
    }
  }
  return null;
}

function throwIfForbiddenSmokeLogs(combinedLogs) {
  const check = firstForbiddenLogCheck(combinedLogs);
  if (check) {
    throw new Error(`Smoke test saw ${check.name}: ${check.pattern}\n${tail(combinedLogs)}`);
  }
}

function evaluateSmokeLogs(combinedLogs) {
  throwIfForbiddenSmokeLogs(combinedLogs);

  const missing = missingRequiredStartupChecks(combinedLogs);
  if (missing.length > 0) {
    throw new Error(
      `Smoke test missing required startup events: ${missing.join(', ')}\n${tail(combinedLogs)}`,
    );
  }
}

function makeSmokeHome() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evernote-smoke-'));
  const home = path.join(root, 'home');
  const config = path.join(root, 'config');
  const cache = path.join(root, 'cache');
  const runtime = path.join(root, 'runtime');
  for (const dir of [home, config, cache, runtime]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.chmodSync(runtime, 0o700);
  return { root, home, config, cache, runtime };
}

function stopProcess(child) {
  if (!child.pid) {
    return;
  }
  try {
    child.kill('SIGTERM');
  } catch {
    return;
  }
}

async function runSmokeTest(options) {
  const launcher = options.executable
    ? path.resolve(options.executable)
    : path.join(path.resolve(options.portDir), 'evernote');
  if (!fs.existsSync(launcher)) {
    throw new Error(`Evernote smoke executable not found: ${launcher}`);
  }
  if (fs.statSync(launcher).isDirectory()) {
    throw new Error(`Evernote smoke executable is a directory: ${launcher}`);
  }

  const xvfbRun = commandPath('xvfb-run');
  if (options.useXvfb && !xvfbRun) {
    throw new Error(
      'xvfb-run not found. Install Xvfb or run with --no-xvfb under a real X display.',
    );
  }

  const smokeHome = makeSmokeHome();
  const stdoutPath = path.join(smokeHome.root, 'stdout.log');
  const stderrPath = path.join(smokeHome.root, 'stderr.log');
  const stdout = fs.openSync(stdoutPath, 'w');
  const stderr = fs.openSync(stderrPath, 'w');
  const evernoteLog = path.join(smokeHome.config, 'Evernote', 'logs', 'evernote.log');
  const command = options.useXvfb ? xvfbRun : launcher;
  const args = options.useXvfb ? ['-a', launcher] : [];

  log(`Smoke profile: ${smokeHome.root}`);
  log(`Launching: ${[command, ...args].join(' ')}`);

  const child = childProcess.spawn(command, args, {
    cwd: ROOT,
    env: {
      ...process.env,
      HOME: smokeHome.home,
      XDG_CONFIG_HOME: smokeHome.config,
      XDG_CACHE_HOME: smokeHome.cache,
      XDG_RUNTIME_DIR: smokeHome.runtime,
      EVERNOTE_NO_SANDBOX: '1',
      ELECTRON_DISABLE_SANDBOX: '1',
      LIBGL_ALWAYS_SOFTWARE: '1',
      NO_AT_BRIDGE: '1',
    },
    stdio: ['ignore', stdout, stderr],
  });

  let exitInfo = null;
  child.once('exit', (code, signal) => {
    exitInfo = { code, signal };
  });

  const deadline = Date.now() + options.timeoutMs;
  let ready = false;
  let combinedLogs = '';
  try {
    while (Date.now() < deadline) {
      await sleep(500);
      combinedLogs = [
        readIfExists(stdoutPath),
        readIfExists(stderrPath),
        readIfExists(evernoteLog),
      ].join('\n');
      if (hasRequiredStartupEvents(combinedLogs)) {
        ready = true;
        break;
      }
      if (exitInfo) {
        break;
      }
    }

    if (ready) {
      await sleep(1_500);
      combinedLogs = [
        readIfExists(stdoutPath),
        readIfExists(stderrPath),
        readIfExists(evernoteLog),
      ].join('\n');
    }

    if (!ready) {
      throwIfForbiddenSmokeLogs(combinedLogs);
      const missing = missingRequiredStartupChecks(combinedLogs);
      throw new Error(
        `Evernote did not complete smoke startup checks within ${options.timeoutMs}ms. Missing: ${missing.join(', ')}. Exit: ${JSON.stringify(exitInfo)}\n${tail(combinedLogs)}`,
      );
    }

    evaluateSmokeLogs(combinedLogs);

    log(
      'Smoke test passed: Evernote loaded webcontents without updater activity or renderer failures.',
    );
  } finally {
    fs.closeSync(stdout);
    fs.closeSync(stderr);
    stopProcess(child);
    await sleep(500);
    if (!options.keepHome) {
      fs.rmSync(smokeHome.root, { recursive: true, force: true });
    } else {
      log(`Kept smoke profile: ${smokeHome.root}`);
    }
  }
}

if (require.main === module) {
  runSmokeTest(parseArgs(process.argv.slice(2))).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = {
  evaluateSmokeLogs,
  hasRequiredStartupEvents,
  missingRequiredStartupChecks,
  runSmokeTest,
};
