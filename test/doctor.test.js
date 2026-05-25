"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  collectLogMatches,
  defaultCacheDir,
  defaultProfileDir,
  formatBytes,
  isDatabaseFile,
  isEvernoteProcessLine,
  isLogFile,
  parseArgs,
  redact,
} = require("../scripts/doctor");

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "evernote-doctor-test-"));
}

test("defaultProfileDir and defaultCacheDir honor XDG paths", () => {
  assert.equal(
    defaultProfileDir({ XDG_CONFIG_HOME: "/tmp/config", HOME: "/tmp/home" }),
    "/tmp/config/Evernote",
  );
  assert.equal(
    defaultProfileDir({ HOME: "/tmp/home" }),
    "/tmp/home/.config/Evernote",
  );
  assert.equal(
    defaultCacheDir({ XDG_CACHE_HOME: "/tmp/cache", HOME: "/tmp/home" }),
    "/tmp/cache/Evernote",
  );
  assert.equal(defaultCacheDir({ HOME: "/tmp/home" }), "/tmp/home/.cache/Evernote");
});

test("redact removes common account and token identifiers", () => {
  const line =
    'user test@example.com note 77b535b8-8b1d-4868-8f9a-306166b5cdbd token="abcdef1234567890abcdef1234567890" id 536449067b0617c5b330761061d9031f';

  assert.equal(
    redact(line),
    'user <email> note <uuid> token="<redacted>" id <hex>',
  );
});

test("formatBytes formats byte counts", () => {
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(2048), "2.0 KiB");
  assert.equal(formatBytes(3 * 1024 * 1024), "3.0 MiB");
});

test("file classifiers match Evernote profile files", () => {
  assert.equal(isLogFile("/home/user/.config/Evernote/logs/evernote.log"), true);
  assert.equal(isLogFile("/home/user/.config/Evernote/Partitions/x/Local Storage/leveldb/000003.log"), false);
  assert.equal(isLogFile("/home/user/.config/Evernote/LocalSettingsDB.sql"), false);
  assert.equal(isDatabaseFile("/home/user/.config/Evernote/LocalSettingsDB.sql"), true);
  assert.equal(isDatabaseFile("/home/user/.config/Evernote/conduit.sqlite"), true);
});

test("isEvernoteProcessLine avoids matching unrelated paths", () => {
  assert.equal(
    isEvernoteProcessLine(" 123 00:01:02 Evernote /tmp/.mount_Evernote/usr/lib/evernote/Evernote --no-sandbox"),
    true,
  );
  assert.equal(
    isEvernoteProcessLine(" 124 00:01:02 sh ./Evernote-v11.17.3-8-x86_64.AppImage"),
    true,
  );
  assert.equal(
    isEvernoteProcessLine(" 125 00:01:02 bwrap /home/user/p/evernote-linux-repackage"),
    false,
  );
});

test("parseArgs reads profile and log line options", () => {
  assert.deepEqual(parseArgs(["--profile", "/tmp/Evernote", "--log-lines", "10"]), {
    profileDir: "/tmp/Evernote",
    logLines: 10,
  });
  assert.throws(() => parseArgs(["--log-lines", "-1"]), /--log-lines/);
});

test("collectLogMatches summarizes and redacts interesting log lines", () => {
  const tempDir = makeTempDir();
  try {
    const logPath = path.join(tempDir, "evernote.log");
    fs.writeFileSync(
      logPath,
      [
        "INFO normal startup",
        "ERROR SyncManager failed for user test@example.com with 401",
        "INFO NSync event source destroyed for note 77b535b8-8b1d-4868-8f9a-306166b5cdbd",
        "INFO auth token=\"abcdef1234567890abcdef1234567890\"",
        "",
      ].join("\n"),
    );

    const result = collectLogMatches([{ path: logPath }], 10);
    assert.equal(result.counts.error, 1);
    assert.equal(result.counts.sync, 2);
    assert.equal(result.counts.auth, 1);
    assert.match(result.matches.map((item) => item.line).join("\n"), /<email>/);
    assert.match(result.matches.map((item) => item.line).join("\n"), /<uuid>/);
    assert.match(result.matches.map((item) => item.line).join("\n"), /<redacted>/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
