const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { launcherScript, patchStaticResources } = require('../scripts/build-linux-port');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'evernote-launcher-test-'));
}

function writeFakeApp(appDir) {
  const fakeEvernote = path.join(appDir, 'Evernote');
  fs.writeFileSync(
    fakeEvernote,
    [
      '#!/usr/bin/env sh',
      'set -eu',
      'test -f "$XDG_CONFIG_HOME/Evernote/localsettings.json"',
      'printf "%s\\n" "started"',
      '',
    ].join('\n'),
  );
  fs.chmodSync(fakeEvernote, 0o755);
}

function writeLauncher(appDir) {
  const launcher = path.join(appDir, 'evernote');
  fs.writeFileSync(launcher, launcherScript());
  fs.chmodSync(launcher, 0o755);
  return launcher;
}

test('launcher initializes first-run local settings', () => {
  const tempDir = makeTempDir();
  try {
    const appDir = path.join(tempDir, 'app');
    const configDir = path.join(tempDir, 'config');
    fs.mkdirSync(appDir);
    writeFakeApp(appDir);

    const result = childProcess.spawnSync(writeLauncher(appDir), [], {
      env: {
        ...process.env,
        XDG_CONFIG_HOME: configDir,
        EVERNOTE_NO_SANDBOX: '0',
      },
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'started\n');
    assert.equal(
      fs.readFileSync(path.join(configDir, 'Evernote', 'localsettings.json'), 'utf8'),
      '{}\n',
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('launcher preserves existing local settings', () => {
  const tempDir = makeTempDir();
  try {
    const appDir = path.join(tempDir, 'app');
    const configDir = path.join(tempDir, 'config');
    const settingsDir = path.join(configDir, 'Evernote');
    const settingsPath = path.join(settingsDir, 'localsettings.json');
    fs.mkdirSync(appDir);
    fs.mkdirSync(settingsDir, { recursive: true });
    fs.writeFileSync(settingsPath, '{"theme":"dark"}\n');
    writeFakeApp(appDir);

    const result = childProcess.spawnSync(writeLauncher(appDir), [], {
      env: {
        ...process.env,
        XDG_CONFIG_HOME: configDir,
        EVERNOTE_NO_SANDBOX: '0',
      },
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(settingsPath, 'utf8'), '{"theme":"dark"}\n');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('static splash screen starts with black backgrounds', () => {
  const tempDir = makeTempDir();
  try {
    const resourcesDir = path.join(tempDir, 'resources');
    const splashDir = path.join(resourcesDir, 'static', 'splashscreen');
    const logoDir = path.join(resourcesDir, 'static', 'gen', 'aboutWindow');
    const splashPath = path.join(splashDir, 'splashscreen.html');
    fs.mkdirSync(splashDir, { recursive: true });
    fs.mkdirSync(logoDir, { recursive: true });
    fs.writeFileSync(
      path.join(logoDir, 'aboutLogo.svg'),
      '<svg><path fill="black" /><path fill="#00A82D" /></svg>\n',
    );
    fs.writeFileSync(
      splashPath,
      [
        '<!doctype html>',
        '<html style="height: 100%; width: 100%; overflow: hidden">',
        '  <head>',
        '    <style>',
        '      @media (prefers-color-scheme: dark) {',
        '        body {',
        '          background: rgb(26 26 26);',
        '          color: rgb(255 255 255);',
        '        }',
        '      }',
        '      @media (prefers-color-scheme: light) {',
        '        body {',
        '          background: rgb(255 255 255);',
        '          color: rgb(26 26 26);',
        '        }',
        '      }',
        '    </style>',
        '  </head>',
        '  <body style="height: 100%; width: 100%">',
        '  </body>',
        '</html>',
        '',
      ].join('\n'),
    );

    patchStaticResources(resourcesDir);

    const patched = fs.readFileSync(splashPath, 'utf8');
    const splashLogo = fs.readFileSync(path.join(splashDir, 'splashLogo.svg'), 'utf8');

    assert.match(patched, /<html style="[^"]*background: #000"/);
    assert.match(patched, /<body style="[^"]*background: #000; color: #fff"/);
    assert.match(patched, /class="evernote-splash"/);
    assert.match(patched, /class="evernote-splash__logo"/);
    assert.match(patched, /src="\.\/splashLogo\.svg"/);
    assert.match(patched, /@keyframes evernote-splash-logo/);
    assert.match(patched, /@keyframes evernote-splash-scan/);
    assert.match(patched, /background: rgb\(0 0 0\);/);
    assert.doesNotMatch(patched, /background: rgb\(255 255 255\);/);
    assert.doesNotMatch(patched, /color: rgb\(26 26 26\);/);
    assert.match(splashLogo, /fill="white"/);
    assert.match(splashLogo, /fill="#00A82D"/);
    assert.doesNotMatch(splashLogo, /fill="black"/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
