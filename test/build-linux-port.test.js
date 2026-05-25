"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { launcherScript } = require("../scripts/build-linux-port");

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "evernote-launcher-test-"));
}

function writeFakeApp(appDir) {
  const fakeEvernote = path.join(appDir, "Evernote");
  fs.writeFileSync(
    fakeEvernote,
    [
      "#!/usr/bin/env sh",
      "set -eu",
      'test -f "$XDG_CONFIG_HOME/Evernote/localsettings.json"',
      'printf "%s\\n" "started"',
      "",
    ].join("\n"),
  );
  fs.chmodSync(fakeEvernote, 0o755);
}

function writeLauncher(appDir) {
  const launcher = path.join(appDir, "evernote");
  fs.writeFileSync(launcher, launcherScript());
  fs.chmodSync(launcher, 0o755);
  return launcher;
}

test("launcher initializes first-run local settings", () => {
  const tempDir = makeTempDir();
  try {
    const appDir = path.join(tempDir, "app");
    const configDir = path.join(tempDir, "config");
    fs.mkdirSync(appDir);
    writeFakeApp(appDir);

    const result = childProcess.spawnSync(writeLauncher(appDir), [], {
      env: {
        ...process.env,
        XDG_CONFIG_HOME: configDir,
        EVERNOTE_NO_SANDBOX: "0",
      },
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "started\n");
    assert.equal(
      fs.readFileSync(path.join(configDir, "Evernote", "localsettings.json"), "utf8"),
      "{}\n",
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("launcher preserves existing local settings", () => {
  const tempDir = makeTempDir();
  try {
    const appDir = path.join(tempDir, "app");
    const configDir = path.join(tempDir, "config");
    const settingsDir = path.join(configDir, "Evernote");
    const settingsPath = path.join(settingsDir, "localsettings.json");
    fs.mkdirSync(appDir);
    fs.mkdirSync(settingsDir, { recursive: true });
    fs.writeFileSync(settingsPath, '{"theme":"dark"}\n');
    writeFakeApp(appDir);

    const result = childProcess.spawnSync(writeLauncher(appDir), [], {
      env: {
        ...process.env,
        XDG_CONFIG_HOME: configDir,
        EVERNOTE_NO_SANDBOX: "0",
      },
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(settingsPath, "utf8"), '{"theme":"dark"}\n');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
