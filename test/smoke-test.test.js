"use strict";

const assert = require("assert");
const test = require("node:test");
const {
  evaluateSmokeLogs,
  hasRequiredStartupEvents,
  missingRequiredStartupChecks,
} = require("../scripts/smoke-test");

const successfulStartupLogs = [
  "[INFO] Main app ready {}",
  "boron:WindowController trying to load the url app://evernote/boronNewLogin.html",
  "boron:WindowController Done loading webcontents",
].join("\n");

test("smoke log evaluation accepts a complete login-window startup", () => {
  assert.equal(hasRequiredStartupEvents(successfulStartupLogs), true);
  assert.deepEqual(missingRequiredStartupChecks(successfulStartupLogs), []);
  assert.doesNotThrow(() => evaluateSmokeLogs(successfulStartupLogs));
});

test("smoke log evaluation accepts a complete main-window startup", () => {
  const logs = [
    "[INFO] Main app ready {}",
    "boron:WindowController trying to load the url app://evernote/boronMain.html",
    "boron:WindowController Done loading webcontents",
  ].join("\n");

  assert.equal(hasRequiredStartupEvents(logs), true);
  assert.deepEqual(missingRequiredStartupChecks(logs), []);
  assert.doesNotThrow(() => evaluateSmokeLogs(logs));
});

test("smoke log evaluation requires a known Evernote UI URL", () => {
  const logs = [
    "[INFO] Main app ready {}",
    "boron:WindowController trying to load the url app://evernote/somethingElse.html",
    "boron:WindowController Done loading webcontents",
  ].join("\n");

  assert.equal(hasRequiredStartupEvents(logs), false);
  assert.deepEqual(missingRequiredStartupChecks(logs), ["UI URL requested"]);
  assert.throws(() => evaluateSmokeLogs(logs), /UI URL requested/);
});

test("smoke log evaluation requires webcontents to load", () => {
  const logs = [
    "[INFO] Main app ready {}",
    "boron:WindowController trying to load the url app://evernote/boronNewLogin.html",
  ].join("\n");

  assert.equal(hasRequiredStartupEvents(logs), false);
  assert.deepEqual(missingRequiredStartupChecks(logs), ["webcontents loaded"]);
  assert.throws(() => evaluateSmokeLogs(logs), /webcontents loaded/);
});

test("smoke log evaluation rejects updater activity", () => {
  const logs = `${successfulStartupLogs}\nelectron:autoUpdaterV2 Check for updates on: {"url":"https://public.evernote.com/ddl-updater/updater/linux/public"}`;

  assert.throws(() => evaluateSmokeLogs(logs), /disabled updater activity/);
});

test("smoke log evaluation rejects renderer failures", () => {
  const logs = `${successfulStartupLogs}\nrender-process-gone: crashed`;

  assert.throws(() => evaluateSmokeLogs(logs), /renderer process failure/);
});

test("smoke log evaluation rejects app protocol load failures", () => {
  const logs = `${successfulStartupLogs}\ndid-fail-load ERR_UNKNOWN_URL_SCHEME app://evernote/boronMain.html`;

  assert.throws(() => evaluateSmokeLogs(logs), /app URL load failure/);
});
