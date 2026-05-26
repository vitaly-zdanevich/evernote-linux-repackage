#!/usr/bin/env node
'use strict';

const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_LOG_LINES = 80;
const MAX_WALK_FILES = 50_000;
const LOG_TAIL_BYTES = 2_000_000;

const interestingLogPatterns = [
  {
    name: 'auth',
    pattern: /auth|NoAuth|currentUserID|login|token|keytar|secret/i,
  },
  {
    name: 'sync',
    pattern: /SyncManager|NSync|sync|conduit|GraphDB|websocket|RTE_SESS/i,
  },
  {
    name: 'error',
    pattern:
      /\b(ERROR|WARN)\b|failed|exception|unauth|forbidden|rate|timeout|ECONN|ENOTFOUND|401|403|429|500/i,
  },
];

function parseArgs(argv) {
  const options = {
    profileDir: '',
    logLines: DEFAULT_LOG_LINES,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--profile') {
      options.profileDir = argv[++index];
    } else if (arg === '--log-lines') {
      options.logLines = Number(argv[++index]);
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!Number.isInteger(options.logLines) || options.logLines < 0) {
    throw new Error('--log-lines must be a non-negative integer.');
  }

  return options;
}

function usage() {
  return [
    'Usage: npm run doctor -- [--profile /path/to/Evernote] [--log-lines 80]',
    '',
    'Checks the local Evernote profile, DBus Secret Service, recent database files,',
    'Evernote processes, and recent sync/auth/error log lines.',
    '',
    'The default profile is $XDG_CONFIG_HOME/Evernote or ~/.config/Evernote.',
    '',
  ].join('\n');
}

function defaultProfileDir(env = process.env) {
  if (env.XDG_CONFIG_HOME) {
    return path.join(env.XDG_CONFIG_HOME, 'Evernote');
  }
  const home = env.HOME || os.homedir();
  return path.join(home, '.config', 'Evernote');
}

function defaultCacheDir(env = process.env) {
  if (env.XDG_CACHE_HOME) {
    return path.join(env.XDG_CACHE_HOME, 'Evernote');
  }
  const home = env.HOME || os.homedir();
  return path.join(home, '.cache', 'Evernote');
}

function commandPath(command) {
  const result = childProcess.spawnSync('sh', ['-c', 'command -v "$1"', 'sh', command], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return result.status === 0 ? result.stdout.trim() : '';
}

function run(command, args, options = {}) {
  const result = childProcess.spawnSync(command, args, {
    encoding: 'utf8',
    timeout: options.timeout || 5_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error || null,
  };
}

function statIfExists(filePath) {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) {
    return 'unknown';
  }
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${unitIndex === 0 ? value : value.toFixed(1)} ${units[unitIndex]}`;
}

function formatMtime(stats) {
  return stats ? stats.mtime.toISOString().replace(/\.\d{3}Z$/, 'Z') : 'missing';
}

function redact(value) {
  return String(value)
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '<email>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>')
    .replace(/\b[0-9a-f]{32,}\b/gi, '<hex>')
    .replace(
      /((?:auth|access|refresh)?token|password|secret)(["']?\s*[:=]\s*)["'][^"',\s]+["']/gi,
      '$1$2"<redacted>"',
    );
}

function walkFiles(root, limit = MAX_WALK_FILES) {
  const result = [];
  const stack = [root];

  while (stack.length > 0 && result.length < limit) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const filePath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(filePath);
      } else if (entry.isFile()) {
        const stats = statIfExists(filePath);
        if (stats) {
          result.push({ path: filePath, stats });
        }
      }
      if (result.length >= limit) {
        break;
      }
    }
  }

  return result;
}

function readTail(filePath, maxBytes = LOG_TAIL_BYTES) {
  const stats = statIfExists(filePath);
  if (!stats) {
    return '';
  }

  const fd = fs.openSync(filePath, 'r');
  try {
    const length = Math.min(stats.size, maxBytes);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, Math.max(0, stats.size - length));
    return buffer.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function isLogFile(filePath) {
  const normalized = filePath.split(path.sep).join('/');
  const lower = normalized.toLowerCase();
  const basename = path.basename(filePath).toLowerCase();
  return lower.includes('/logs/') || basename === 'evernote.log';
}

function isDatabaseFile(filePath) {
  return /\.(?:db|sqlite|sqlite3|sql)$/i.test(filePath);
}

function isEvernoteProcessLine(line) {
  const match = line.match(/^\s*(\d+)\s+(\S+)\s+(\S+)\s+(.*)$/);
  if (!match) {
    return false;
  }

  const commandName = match[3];
  const args = match[4];
  return (
    /^(Evernote|evernote)$/i.test(commandName) ||
    /(^|\s)(?:\.\/)?Evernote-v[\w.+-]+\.AppImage(\s|$)/.test(args) ||
    /\/\.mount_Evernote[^/\s]*\/usr\/lib\/evernote\/Evernote(\s|$)/.test(args) ||
    /\/Evernote(\s|$)/.test(args) ||
    /\/evernote(\s|$)/.test(args)
  );
}

function collectLogMatches(logFiles, maxLines = DEFAULT_LOG_LINES) {
  const matches = [];
  const counts = Object.fromEntries(interestingLogPatterns.map((item) => [item.name, 0]));

  for (const file of logFiles) {
    const text = readTail(file.path);
    const lines = text.split(/\r?\n/);
    for (const line of lines) {
      if (!line) {
        continue;
      }
      const matchedNames = interestingLogPatterns
        .filter((item) => item.pattern.test(line))
        .map((item) => item.name);
      if (matchedNames.length === 0) {
        continue;
      }
      for (const name of matchedNames) {
        counts[name] += 1;
      }
      matches.push({
        file: file.path,
        line: redact(line),
      });
    }
  }

  return {
    counts,
    matches: maxLines === 0 ? [] : matches.slice(-maxLines),
  };
}

function relativeOrAbsolute(root, filePath) {
  const relative = path.relative(root, filePath);
  return relative && !relative.startsWith('..') ? relative : filePath;
}

function printSection(title) {
  process.stdout.write(`\n## ${title}\n`);
}

function printCheck(label, ok, detail = '') {
  process.stdout.write(`${ok ? 'OK' : 'WARN'} ${label}${detail ? `: ${detail}` : ''}\n`);
}

function printFiles(root, files, count) {
  for (const file of files.slice(0, count)) {
    process.stdout.write(
      `${formatMtime(file.stats)}  ${formatBytes(file.stats.size).padStart(9)}  ${relativeOrAbsolute(root, file.path)}\n`,
    );
  }
}

function doctor(options) {
  const profileDir = path.resolve(options.profileDir || defaultProfileDir());
  const cacheDir = path.resolve(defaultCacheDir());
  const profileStats = statIfExists(profileDir);
  const cacheStats = statIfExists(cacheDir);

  printSection('Profile');
  process.stdout.write(`Profile: ${profileDir}\n`);
  process.stdout.write(`Cache:   ${cacheDir}\n`);
  printCheck('profile directory exists', Boolean(profileStats && profileStats.isDirectory()));
  printCheck('cache directory exists', Boolean(cacheStats && cacheStats.isDirectory()));
  printCheck(
    'DBUS_SESSION_BUS_ADDRESS set',
    Boolean(process.env.DBUS_SESSION_BUS_ADDRESS),
    process.env.DBUS_SESSION_BUS_ADDRESS ? 'present' : 'empty',
  );

  printSection('Secret Service');
  const busctl = commandPath('busctl');
  if (busctl) {
    const result = run(busctl, ['--user', 'status', 'org.freedesktop.secrets']);
    printCheck(
      'org.freedesktop.secrets',
      result.status === 0,
      result.status === 0
        ? 'available'
        : redact((result.stderr || result.stdout).trim() || 'not available'),
    );
  } else {
    printCheck('busctl', false, 'not installed; cannot check Secret Service over DBus');
  }
  printCheck(
    'secret-tool',
    Boolean(commandPath('secret-tool')),
    'optional command-line keyring test tool',
  );

  printSection('Processes');
  const ps = commandPath('ps');
  if (ps) {
    const result = run(ps, ['-eo', 'pid=,etime=,comm=,args=']);
    const lines = result.stdout.split(/\r?\n/).filter((line) => isEvernoteProcessLine(line));
    if (lines.length === 0) {
      printCheck('Evernote process', false, 'not currently running');
    } else {
      printCheck('Evernote process', true, `${lines.length} matching process(es)`);
      for (const line of lines.slice(0, 8)) {
        process.stdout.write(`${redact(line)}\n`);
      }
    }
  } else {
    printCheck('ps', false, 'not installed');
  }

  const profileFiles = profileStats && profileStats.isDirectory() ? walkFiles(profileDir) : [];
  const totalProfileBytes = profileFiles.reduce((sum, file) => sum + file.stats.size, 0);
  printSection('Profile Files');
  process.stdout.write(
    `Indexed files: ${profileFiles.length}${profileFiles.length >= MAX_WALK_FILES ? ' (limit reached)' : ''}\n`,
  );
  process.stdout.write(`Indexed size:  ${formatBytes(totalProfileBytes)}\n`);

  const databaseFiles = profileFiles
    .filter((file) => isDatabaseFile(file.path))
    .sort((a, b) => b.stats.mtimeMs - a.stats.mtimeMs);
  printSection('Recent Database Files');
  if (databaseFiles.length === 0) {
    printCheck('database files', false, 'no .db/.sqlite/.sql files found under profile');
  } else {
    printFiles(profileDir, databaseFiles, 20);
  }

  const recentFiles = [...profileFiles].sort((a, b) => b.stats.mtimeMs - a.stats.mtimeMs);
  printSection('Recently Modified Profile Files');
  if (recentFiles.length === 0) {
    printCheck('recent files', false, 'profile is empty or unreadable');
  } else {
    printFiles(profileDir, recentFiles, 20);
  }

  const logFiles = profileFiles
    .filter((file) => isLogFile(file.path))
    .sort((a, b) => b.stats.mtimeMs - a.stats.mtimeMs);
  printSection('Logs');
  if (logFiles.length === 0) {
    printCheck('log files', false, 'no logs found under profile');
  } else {
    printFiles(profileDir, logFiles, 12);
    const { counts, matches } = collectLogMatches(logFiles, options.logLines);
    process.stdout.write(
      `\nMatched recent log lines: auth=${counts.auth} sync=${counts.sync} error=${counts.error}\n`,
    );
    if (matches.length > 0) {
      process.stdout.write(
        'Review before sharing; log lines may still contain account or note metadata.\n',
      );
      for (const match of matches) {
        process.stdout.write(`${relativeOrAbsolute(profileDir, match.file)}: ${match.line}\n`);
      }
    }
  }

  printSection('Next Checks');
  process.stdout.write(
    [
      'If database files and logs do not change while Evernote is open, sync is likely stuck before local storage writes.',
      'If auth/keyring warnings appear, fix Secret Service first; sync may not start with an invalid or missing token.',
      'If sync logs show HTTP 401/403/429/5xx, keep the redacted lines and investigate that server/auth error.',
      'Evernote may lazy-download note bodies and attachments, but the note list and Conduit databases should still show activity after login.',
      '',
    ].join('\n'),
  );
}

if (require.main === module) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(usage());
    } else {
      doctor(options);
    }
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}

module.exports = {
  collectLogMatches,
  defaultCacheDir,
  defaultProfileDir,
  formatBytes,
  isDatabaseFile,
  isEvernoteProcessLine,
  isLogFile,
  parseArgs,
  redact,
};
