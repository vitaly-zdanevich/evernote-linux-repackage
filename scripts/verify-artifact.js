#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const DIST_DIR = path.join(ROOT, "dist");

const REQUIRED_PATCH_MARKERS = [
  {
    name: "warm tab preload disabled",
    value: "preloadWarmTab(){return;",
  },
  {
    name: "auto-updater initialization disabled",
    value: "this._initialized=!0;return;",
  },
  {
    name: "auto-updater checks neutralized",
    value: "Promise.resolve({})",
  },
  {
    name: "missing pending update state tolerated",
    value: "if((0,i.isNullish)(t))return{};",
  },
  {
    name: "in-app force update neutralized",
    value: "return{feedbackLevel:m.InAppForceUpdateFeedbackLevel.none}",
  },
  {
    name: "main window close quits app",
    value: 'h.app.quit(),0}}),this.window.on("show"',
  },
  {
    name: "tab destroy state publish suppressed",
    value:
      "this.tabs.has(t)&&(this.tabs.delete(t),this.activeTabId===t&&(this.onActiveWebContentsChange?.(null,null),this.activeTabId=null))",
  },
];

const REQUIRED_LINUX_NATIVE_MODULES = [
  "node_modules/keytar/build/Release/keytar.node",
  "node_modules/better-sqlite3/build/Release/better_sqlite3.node",
  "node_modules/@ronomon/opened/binding.node",
  "node_modules/electron-native-auth/build/Release/electron_native_auth.node",
];

function readBuildInfoPortDir() {
  const buildInfoPath = path.join(DIST_DIR, "build-info.json");
  if (!fs.existsSync(buildInfoPath)) {
    return null;
  }
  const buildInfo = JSON.parse(fs.readFileSync(buildInfoPath, "utf8"));
  if (!buildInfo.portDir) {
    return null;
  }
  return path.isAbsolute(buildInfo.portDir)
    ? buildInfo.portDir
    : path.resolve(ROOT, buildInfo.portDir);
}

function parseArgs(argv) {
  const options = {
    portDir: process.env.EVERNOTE_PORT_DIR || readBuildInfoPortDir(),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--port-dir") {
      options.portDir = argv[++index];
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!options.portDir) {
    throw new Error("No port directory provided and dist/build-info.json is missing.");
  }

  return options;
}

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

function readAsarText(asarPath, filePath) {
  const { buffer, header, baseOffset } = parseAsarHeader(asarPath);
  const entry = asarEntry(header, filePath);
  if (entry.unpacked) {
    return fs.readFileSync(`${asarPath}.unpacked/${filePath}`, "utf8");
  }
  const offset = baseOffset + Number(entry.offset);
  return buffer.subarray(offset, offset + Number(entry.size)).toString();
}

function readAsarEntryText(asarPath, parsedAsar, filePath, entry) {
  if (entry.unpacked) {
    return fs.readFileSync(`${asarPath}.unpacked/${filePath}`, "utf8");
  }

  const offset = parsedAsar.baseOffset + Number(entry.offset);
  return parsedAsar.buffer.subarray(offset, offset + Number(entry.size)).toString();
}

function walkAsarEntries(entry, callback, filePath = "") {
  for (const [name, child] of Object.entries(entry.files || {})) {
    const childPath = filePath ? `${filePath}/${name}` : name;
    if (child.files) {
      walkAsarEntries(child, callback, childPath);
    } else {
      callback(childPath, child);
    }
  }
}

function listFiles(dir) {
  if (!fs.existsSync(dir)) {
    return [];
  }

  const result = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const filePath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      result.push(...listFiles(filePath));
    } else if (entry.isFile()) {
      result.push(filePath);
    }
  }
  return result;
}

function readMagic(filePath, length = 4) {
  const fd = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, 0);
    return buffer;
  } finally {
    fs.closeSync(fd);
  }
}

function isElf(filePath) {
  return readMagic(filePath).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
}

function isWindowsPe(filePath) {
  return readMagic(filePath, 2).equals(Buffer.from("MZ"));
}

function requireFile(filePath) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    throw new Error(`Required file missing: ${filePath}`);
  }
}

function requireExecutable(filePath) {
  requireFile(filePath);
  fs.accessSync(filePath, fs.constants.X_OK);
}

function verifyElf(filePath) {
  requireFile(filePath);
  if (!isElf(filePath)) {
    const hint = isWindowsPe(filePath) ? "Windows PE file" : "not an ELF file";
    throw new Error(`Expected Linux ELF binary, got ${hint}: ${filePath}`);
  }
}

function verifyNativeModules(portDir) {
  const unpackedDir = path.join(portDir, "resources", "app.asar.unpacked");
  const nodeFiles = listFiles(unpackedDir).filter((filePath) => filePath.endsWith(".node"));
  const requiredNodeFiles = REQUIRED_LINUX_NATIVE_MODULES.map((relativePath) =>
    path.join(unpackedDir, relativePath),
  );

  for (const filePath of requiredNodeFiles) {
    verifyElf(filePath);
  }

  const requiredSet = new Set(requiredNodeFiles.map((filePath) => path.resolve(filePath)));
  const extraNodeFiles = nodeFiles.filter((filePath) => !requiredSet.has(path.resolve(filePath)));
  for (const filePath of extraNodeFiles) {
    if (isElf(filePath)) {
      process.stdout.write(`Found extra Linux native module: ${path.relative(unpackedDir, filePath)}\n`);
    }
  }

  process.stdout.write(
    `Verified ${requiredNodeFiles.length} rebuilt native module(s) are Linux ELF binaries; ignored ${extraNodeFiles.length} packaged platform prebuild(s).\n`,
  );
}

function verifyBundlePatches(asarPath) {
  const mainJs = readAsarText(asarPath, "main.js");
  const missing = REQUIRED_PATCH_MARKERS.filter((marker) => !mainJs.includes(marker.value));
  if (missing.length > 0) {
    throw new Error(`Missing bundle patch marker(s): ${missing.map((marker) => marker.name).join(", ")}`);
  }
  new Function(mainJs);
  process.stdout.write("Verified app.asar patch markers and main.js syntax.\n");
}

function assertJavaScriptSyntax(filePath, text) {
  try {
    new Function(text);
  } catch (error) {
    throw new Error(`Invalid JavaScript in patched ASAR entry ${filePath}: ${error.message}`);
  }
}

function verifyPatchedJavaScriptSyntax(asarPath) {
  const parsedAsar = parseAsarHeader(asarPath);
  const checkedFiles = [];
  const requiredFiles = [
    "main.js",
    "172.js",
    "7839.js",
    "8634.js",
    "2002.js",
    "8453.js",
    "3014.js",
    "node_modules/en-conduit-electron/dist/MainResourceProxy.js",
  ];
  const syntaxCheckPatterns = [
    /^main\.js$/,
    /^172\.js$/,
    /^7839\.js$/,
    /^8634\.js$/,
    /^2002\.js$/,
    /^8453\.js$/,
    /^3014\.js$/,
    /^4701\.js$/,
    /^ce\/chunks\/9008\.[^/]+\.js$/,
    /^node_modules\/@evernote\/common-editor\/chunks\/9008\.[^/]+\.js$/,
    /^node_modules\/en-conduit-electron\/dist\/MainResourceProxy\.js$/,
  ];

  walkAsarEntries(parsedAsar.header, (filePath, entry) => {
    if (!syntaxCheckPatterns.some((pattern) => pattern.test(filePath))) {
      return;
    }

    assertJavaScriptSyntax(filePath, readAsarEntryText(asarPath, parsedAsar, filePath, entry));
    checkedFiles.push(filePath);
  });

  const missingRequiredFiles = requiredFiles.filter((filePath) => !checkedFiles.includes(filePath));
  if (missingRequiredFiles.length > 0) {
    throw new Error(`Required patched JavaScript entry missing: ${missingRequiredFiles.join(", ")}`);
  }

  process.stdout.write(`Verified patched JavaScript syntax in ${checkedFiles.length} ASAR entry(s).\n`);
}

function verifyFlacMimePatch(asarPath) {
  const { buffer, header, baseOffset } = parseAsarHeader(asarPath);
  const runtimeFilePattern = /\.(?:js|json|html)$/i;
  const oldMime = "audio/x-flac";
  const newMime = "audio/flac  ";
  const proxyMarker = String.raw`.replace(/^audio\/x-flac\b/i, "audio/flac")`;
  const cachedResourceMarker = "normalizeFlacMime(resource.meta.mime)";
  const audioPlayerMarker = String.raw`/^audio\/x-flac\b/i.test(e)?"audio/flac":r[e]||e`;
  const oldMimeFiles = [];
  let newMimeCount = 0;

  walkAsarEntries(header, (filePath, entry) => {
    if (entry.unpacked || !runtimeFilePattern.test(filePath)) {
      return;
    }

    const offset = baseOffset + Number(entry.offset);
    const text = buffer.subarray(offset, offset + Number(entry.size)).toString();
    if (text.includes(oldMime)) {
      oldMimeFiles.push(filePath);
    }
    if (text.includes(newMime)) {
      newMimeCount += 1;
    }
  });

  if (oldMimeFiles.length > 0) {
    throw new Error(`Unpatched FLAC MIME type remains in ASAR entries: ${oldMimeFiles.join(", ")}`);
  }
  if (newMimeCount === 0) {
    throw new Error("Missing normalized FLAC MIME type marker in ASAR runtime entries.");
  }
  const resourceProxyJs = readAsarText(
    asarPath,
    "node_modules/en-conduit-electron/dist/MainResourceProxy.js",
  );
  if (!resourceProxyJs.includes(proxyMarker)) {
    throw new Error("Missing FLAC MIME normalization in MainResourceProxy response metadata.");
  }
  if (!resourceProxyJs.includes(cachedResourceMarker)) {
    throw new Error("Missing FLAC MIME normalization when serving cached resources.");
  }
  if (!readAsarText(asarPath, "172.js").includes(audioPlayerMarker)) {
    throw new Error("Missing FLAC MIME normalization before renderer audio playback.");
  }

  process.stdout.write(`Verified FLAC MIME type normalization in ${newMimeCount} runtime entry occurrence(s).\n`);
}

function verifyAiCopilotDisclaimerPatch(asarPath) {
  const aiCopilotRuntime = readAsarText(asarPath, "172.js");
  if (aiCopilotRuntime.includes("disclaimer:{text:Ut()}")) {
    throw new Error("Unpatched AI Assistant composer disclaimer config remains.");
  }
  if (!aiCopilotRuntime.includes("disclaimer:void 0")) {
    throw new Error("Missing disabled AI Assistant composer disclaimer marker.");
  }

  process.stdout.write("Verified AI Assistant composer disclaimer is disabled.\n");
}

function verifyBlackBackgroundThemePatch(asarPath) {
  const { buffer, header, baseOffset } = parseAsarHeader(asarPath);
  const appTheme = readAsarText(asarPath, "7839.js");
  if (!appTheme.includes("--color-background-base-fill-primary:#000")) {
    throw new Error("Missing black app background theme token patch.");
  }
  if (/--color-background-base-fill-primary:var\(--colors-grey-(?:100|8)\);/.test(appTheme)) {
    throw new Error("Unpatched app background theme token remains.");
  }
  if (!appTheme.includes("--color-note_list-base-stroke-enabled:#000")) {
    throw new Error("Missing black note list stroke theme token patch.");
  }

  let editorBackgroundTokenPatched = false;
  let editorDarkBackgroundPatched = false;
  let editorFormattingBackgroundPreserved = false;

  walkAsarEntries(header, (filePath, entry) => {
    if (
      entry.unpacked ||
      !/^(?:4701\.js|ce\/ce-[^/]+\.css|node_modules\/@evernote\/common-editor\/(?:ce|headless)\.css)$/.test(filePath)
    ) {
      return;
    }

    const offset = baseOffset + Number(entry.offset);
    const text = buffer.subarray(offset, offset + Number(entry.size)).toString();
    editorBackgroundTokenPatched ||= text.includes("--color-background-fill-primary:#000");
    editorDarkBackgroundPatched ||= text.includes("body.darkMode en-note.peso{background-color:#000");
    editorFormattingBackgroundPreserved ||= text.includes("background-color:var(--color-surface-fill-tertiary-enabled)");
  });

  if (!editorBackgroundTokenPatched) {
    throw new Error("Missing black editor background theme token patch.");
  }
  if (!editorDarkBackgroundPatched) {
    throw new Error("Missing black dark-mode note background patch.");
  }
  if (!editorFormattingBackgroundPreserved) {
    throw new Error("Editor formatting background token was not preserved.");
  }

  process.stdout.write("Verified black background theme patches.\n");
}

function verifyEditorTextSelectionPatch(asarPath) {
  const parsedAsar = parseAsarHeader(asarPath);
  const selectionFilePattern =
    /^(?:ce\/ce-[^/]+\.css|node_modules\/@evernote\/common-editor\/(?:ce|headless)\.css)$/;
  const staleSelectionPattern = /rgba\(33,133,231,\.(?:25|3)\)/;
  const patchedSelectionPattern = /rgba\(33,133,231,\.4\)\s*/;
  const staleFiles = [];
  let checkedFiles = 0;
  let patchedFiles = 0;

  walkAsarEntries(parsedAsar.header, (filePath, entry) => {
    if (entry.unpacked || !selectionFilePattern.test(filePath)) {
      return;
    }

    checkedFiles += 1;
    const text = readAsarEntryText(asarPath, parsedAsar, filePath, entry);
    if (staleSelectionPattern.test(text)) {
      staleFiles.push(filePath);
    }
    if (patchedSelectionPattern.test(text)) {
      patchedFiles += 1;
    }
  });

  if (checkedFiles === 0) {
    throw new Error("No editor selection CSS files found.");
  }
  if (staleFiles.length > 0) {
    throw new Error(`Unpatched editor text selection color remains in ${staleFiles.join(", ")}.`);
  }
  if (patchedFiles === 0) {
    throw new Error("Missing brightened editor text selection marker.");
  }

  process.stdout.write("Verified editor text selection overlays are brighter.\n");
}

function verifyCollapsedNavWidthPatch(asarPath) {
  const navRuntime = readAsarText(asarPath, "8634.js");
  if (navRuntime.includes("Q=Ia.V0,X=Math.max(Math.min(Ia.af,q),Q)")) {
    throw new Error("Unpatched collapsed sidebar width remains.");
  }
  if (!navRuntime.includes("Q=Ia.WB,X=Math.max(Math.min(Ia.af,q),Q)")) {
    throw new Error("Missing minimized collapsed sidebar width marker.");
  }

  process.stdout.write("Verified collapsed sidebar uses minimum icon rail width.\n");
}

function verifyCollapsedNavSpacingPatch(asarPath) {
  const navStylesRuntime = readAsarText(asarPath, "2002.js");
  const oldPaddingToken = "--nav-collapsed-padding:var(--spacing-0-5)var(--spacing-2);";
  const intermediatePaddingToken = "--nav-collapsed-padding:var(--spacing-1-5)var(--spacing-2);";
  const newPaddingToken = "--nav-collapsed-padding:var(--spacing-1-5)0;";
  const oldItemPadding = "padding:var(--spacing-0-5)var(--spacing-2);justify-content:center;";
  const intermediateItemPadding = "padding:var(--spacing-1-5)var(--spacing-2);justify-content:center;";
  const newItemPadding = "padding:var(--spacing-1-5)0;justify-content:center;";

  if (
    navStylesRuntime.includes(oldPaddingToken) ||
    navStylesRuntime.includes(intermediatePaddingToken) ||
    navStylesRuntime.includes(oldItemPadding) ||
    navStylesRuntime.includes(intermediateItemPadding)
  ) {
    throw new Error("Unpatched collapsed sidebar icon spacing remains.");
  }
  if (!navStylesRuntime.includes(newPaddingToken) || !navStylesRuntime.includes(newItemPadding)) {
    throw new Error("Missing increased collapsed sidebar icon spacing marker.");
  }

  process.stdout.write("Verified collapsed sidebar icon rail vertical spacing.\n");
}

function verifyCollapsedNavThinWidthPatch(asarPath) {
  const navStylesRuntime = readAsarText(asarPath, "2002.js");
  const navConstantsRuntime = readAsarText(asarPath, "8453.js");
  const oldCompiledContainerWidth = "width:60px;transition:width .2s ease-in-out";
  const newCompiledContainerWidth = "width:30px;transition:width .2s ease-in-out";

  if (navStylesRuntime.includes("--nav-collapsed-width:60px;")) {
    throw new Error("Unpatched collapsed sidebar CSS rail width remains.");
  }
  if (!navStylesRuntime.includes("--nav-collapsed-width:30px;")) {
    throw new Error("Missing halved collapsed sidebar CSS rail width marker.");
  }
  if (navStylesRuntime.includes(oldCompiledContainerWidth)) {
    throw new Error("Unpatched collapsed sidebar active container width remains.");
  }
  if (!navStylesRuntime.includes(newCompiledContainerWidth)) {
    throw new Error("Missing halved collapsed sidebar active container width marker.");
  }
  if (navConstantsRuntime.includes("d=60,c=96")) {
    throw new Error("Unpatched collapsed sidebar runtime rail width remains.");
  }
  if (!navConstantsRuntime.includes("d=30,c=96")) {
    throw new Error("Missing halved collapsed sidebar runtime rail width marker.");
  }

  process.stdout.write("Verified collapsed sidebar rail width is halved.\n");
}

function verifyNoteSnippetSeparatorsPatch(asarPath) {
  const noteListRuntime = readAsarText(asarPath, "3014.js");
  const oldSeparator = "--noteSnippet-border-bottom:1px solid var(--color-snippet-base-stroke-enabled);";
  const newSeparator = "--noteSnippet-border-bottom:0px solid transparent";

  if (noteListRuntime.includes(oldSeparator)) {
    throw new Error("Unpatched note snippet separator line remains.");
  }
  if (!noteListRuntime.includes(newSeparator)) {
    throw new Error("Missing removed note snippet separator marker.");
  }

  process.stdout.write("Verified note snippet separator lines are removed.\n");
}

function verifyArtifact(options) {
  const portDir = path.resolve(options.portDir);
  const asarPath = path.join(portDir, "resources", "app.asar");

  requireExecutable(path.join(portDir, "evernote"));
  verifyElf(path.join(portDir, "Evernote"));
  verifyElf(path.join(portDir, "chrome-sandbox"));
  requireFile(asarPath);
  requireFile(path.join(portDir, "resources", "app-update.yml"));

  verifyNativeModules(portDir);
  verifyBundlePatches(asarPath);
  verifyPatchedJavaScriptSyntax(asarPath);
  verifyFlacMimePatch(asarPath);
  verifyAiCopilotDisclaimerPatch(asarPath);
  verifyBlackBackgroundThemePatch(asarPath);
  verifyEditorTextSelectionPatch(asarPath);
  verifyCollapsedNavWidthPatch(asarPath);
  verifyCollapsedNavSpacingPatch(asarPath);
  verifyCollapsedNavThinWidthPatch(asarPath);
  verifyNoteSnippetSeparatorsPatch(asarPath);

  process.stdout.write(`Artifact verification passed: ${portDir}\n`);
}

if (require.main === module) {
  try {
    verifyArtifact(parseArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}

module.exports = {
  isElf,
  isWindowsPe,
  verifyArtifact,
};
