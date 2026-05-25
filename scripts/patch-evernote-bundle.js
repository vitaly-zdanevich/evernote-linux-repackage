#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

function parseAsarHeader(asarPath) {
  const buffer = fs.readFileSync(asarPath);
  const headerSize = buffer.readUInt32LE(4);
  const jsonSize = buffer.readUInt32LE(12);
  const header = JSON.parse(buffer.subarray(16, 16 + jsonSize).toString());
  return {
    buffer,
    header,
    baseOffset: 8 + headerSize,
  };
}

function asarEntry(header, filePath) {
  let entry = header;
  for (const part of filePath.split("/")) {
    entry = entry.files && entry.files[part];
    if (!entry) {
      throw new Error(`ASAR entry not found: ${filePath}`);
    }
  }
  return entry;
}

function replaceInAsarEntry(asarPath, filePath, search, replacement) {
  const searchBytes = Buffer.from(search);
  const replacementBytes = Buffer.from(replacement);
  if (searchBytes.length !== replacementBytes.length) {
    throw new Error(
      `Replacement for ${filePath} must preserve byte length: ${searchBytes.length} != ${replacementBytes.length}`,
    );
  }

  const { buffer, header, baseOffset } = parseAsarHeader(asarPath);
  const entry = asarEntry(header, filePath);
  if (entry.unpacked) {
    throw new Error(`Cannot patch unpacked ASAR entry in-place: ${filePath}`);
  }

  const start = baseOffset + Number(entry.offset);
  const end = start + Number(entry.size);
  const fileBuffer = buffer.subarray(start, end);
  const index = fileBuffer.indexOf(searchBytes);
  if (index === -1) {
    if (fileBuffer.indexOf(replacementBytes) !== -1) {
      return false;
    }
    throw new Error(`Patch target not found in ${filePath}: ${search}`);
  }

  replacementBytes.copy(buffer, start + index);
  fs.writeFileSync(asarPath, buffer);
  return true;
}

function sameLengthReplacement(search, replacementPrefix) {
  if (replacementPrefix.length > search.length) {
    throw new Error("Replacement prefix is longer than search string.");
  }
  return replacementPrefix + " ".repeat(search.length - replacementPrefix.length);
}

const patches = [
  {
    resultKey: "disabledWarmTabPreload",
    description: "disabled warm tab preload",
    filePath: "main.js",
    search:
      "preloadWarmTab(){if(this.warmTab||this.isPreloadingWarmTab)return;",
    replacementPrefix: "preloadWarmTab(){return;",
  },
  {
    resultKey: "disabledAutoUpdaterInit",
    description: "disabled Electron auto-updater init",
    filePath: "main.js",
    search:
      'init(t,a){if(this._initialized)return void E.warn("Trying to initialize the AutoUpdater the second time");this._initialized=!0,this.autoUpdater.logger=E,',
    replacementPrefix:
      'init(t,a){if(this._initialized)return void E.warn("Trying to initialize the AutoUpdater the second time");this._initialized=!0;return;',
  },
  {
    resultKey: "neutralizedAutoUpdaterNetwork",
    description: "neutralized Electron auto-updater network request",
    filePath: "main.js",
    search: "this.autoUpdater.checkForUpdates()",
    replacementPrefix: "Promise.resolve({})",
  },
  {
    resultKey: "toleratedMissingPendingUpdate",
    description: "treated missing pending update state as normal",
    filePath: "main.js",
    search: 'if((0,i.isNullish)(t))throw Error("no pending update");',
    replacementPrefix: "if((0,i.isNullish)(t))return{};",
  },
  {
    resultKey: "disabledInAppForceUpdateInit",
    description: "disabled in-app force-update init",
    filePath: "main.js",
    search:
      'init(t=m.InAppForceUpdateChannel.public){if(this._initialized)return void f.info("Trying to init multiple times");this._initialized=!0;let{feedbackLevel:a}=this;',
    replacementPrefix:
      'init(t=m.InAppForceUpdateChannel.public){if(this._initialized)return void f.info("Trying to init multiple times");this._initialized=!0;return;',
  },
  {
    resultKey: "disabledInAppForceUpdateChecks",
    description: "disabled in-app force-update checks",
    filePath: "main.js",
    search:
      'async getRemoteUpdatedList(){let t=this.remoteCheckUrl;if(!t)throw Error("Empty url");let a="UNKNOWN",n="UNKNOWN";',
    replacementPrefix:
      "async getRemoteUpdatedList(){return{feedbackLevel:m.InAppForceUpdateFeedbackLevel.none};let t=this.remoteCheckUrl;",
  },
  {
    resultKey: "quitOnMainWindowClose",
    description: "quit app when the main window is closed",
    filePath: "main.js",
    search:
      'this.hidden=!0,this.window.hide()}}),this.window.on("show"',
    replacementPrefix:
      'h.app.quit(),0}}),this.window.on("show"',
  },
  {
    resultKey: "suppressTabStatePublishAfterDestroy",
    description: "suppress tab state publish after tab webContents destruction",
    filePath: "main.js",
    search:
      "this.tabs.has(t)&&(this.tabs.delete(t),this.activeTabId===t&&(this.onActiveWebContentsChange?.(null,null),this.activeTabId=null),this.publishState())",
    replacementPrefix:
      "this.tabs.has(t)&&(this.tabs.delete(t),this.activeTabId===t&&(this.onActiveWebContentsChange?.(null,null),this.activeTabId=null))",
  },
];

function patchEvernoteBundle(asarPath) {
  const resolvedAsarPath = path.resolve(asarPath);
  const result = {
    asarPath: resolvedAsarPath,
  };

  for (const patch of patches) {
    result[patch.resultKey] = replaceInAsarEntry(
      resolvedAsarPath,
      patch.filePath,
      patch.search,
      sameLengthReplacement(patch.search, patch.replacementPrefix),
    );
  }

  return result;
}

if (require.main === module) {
  const asarPath = process.argv[2];
  if (!asarPath) {
    console.error("Usage: node scripts/patch-evernote-bundle.js <app.asar>");
    process.exit(2);
  }
  try {
    const result = patchEvernoteBundle(asarPath);
    for (const patch of patches) {
      console.log(
        result[patch.resultKey]
          ? `Patched ${result.asarPath}: ${patch.description}`
          : `Already patched ${result.asarPath}: ${patch.description}`,
      );
    }
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}

module.exports = {
  patches,
  patchEvernoteBundle,
};
