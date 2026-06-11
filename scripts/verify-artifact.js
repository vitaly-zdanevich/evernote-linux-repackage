#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DIST_DIR = path.join(ROOT, 'dist');

const REQUIRED_PATCH_MARKERS = [
  {
    name: 'warm tab preload disabled',
    value: 'preloadWarmTab(){return;',
  },
  {
    name: 'auto-updater initialization disabled',
    value: 'this._initialized=!0;return;',
  },
  {
    name: 'auto-updater checks neutralized',
    value: 'Promise.resolve({})',
  },
  {
    name: 'missing pending update state tolerated',
    value: 'if((0,i.isNullish)(t))return{};',
  },
  {
    name: 'in-app force update neutralized',
    value: 'return{feedbackLevel:m.InAppForceUpdateFeedbackLevel.none}',
  },
  {
    name: 'main window close quits app',
    value: 'h.app.quit(),0}}),this.window.on("show"',
  },
  {
    name: 'tab destroy state publish suppressed',
    value:
      'this.tabs.has(t)&&(this.tabs.delete(t),this.activeTabId===t&&(this.onActiveWebContentsChange?.(null,null),this.activeTabId=null))',
  },
  {
    name: 'browser window startup background is black',
    value: 'backgroundColor:"#000000"',
    isThematic: true,
  },
  {
    name: 'image resource copy writes native image clipboard data',
    value: 'n.isEmpty()?o?.writeFilePaths(a):l.clipboard.writeImage(n)',
  },
  {
    name: 'resource drag exposes the first native file path',
    value: 't?.startDrag({file:n[0]||"",files:n,icon:',
  },
  {
    name: 'sync-folder file import decisions enabled on Linux',
    value: 'let n=!0;return i.default.isMac?n=await U(t):i.default.isWin&&(n=await B(t)),n',
  },
  {
    name: 'sync-folder initial watcher scan ignored on Linux',
    value: 'ignoreInitial:!0',
  },
];

const REQUIRED_LINUX_NATIVE_MODULES = [
  'node_modules/keytar/build/Release/keytar.node',
  'node_modules/better-sqlite3/build/Release/better_sqlite3.node',
  'node_modules/@ronomon/opened/binding.node',
  'node_modules/electron-native-auth/build/Release/electron_native_auth.node',
];

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

function parseArgs(argv) {
  const options = {
    portDir: process.env.EVERNOTE_PORT_DIR || readBuildInfoPortDir(),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--port-dir') {
      options.portDir = argv[++index];
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!options.portDir) {
    throw new Error('No port directory provided and dist/build-info.json is missing.');
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
  for (const part of filePath.split('/')) {
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
    return fs.readFileSync(`${asarPath}.unpacked/${filePath}`, 'utf8');
  }
  const offset = baseOffset + Number(entry.offset);
  return buffer.subarray(offset, offset + Number(entry.size)).toString();
}

function webpackCssRuntimeText(text, filePath) {
  const startMarker = 'A.push([o.id,"';
  const startMarkerIndex = text.indexOf(startMarker);
  if (startMarkerIndex === -1) {
    throw new Error(`Unable to find Webpack CSS runtime string start in ${filePath}.`);
  }

  const start = startMarkerIndex + startMarker.length;
  const endMarker = '","",{version:3';
  const end = text.indexOf(endMarker, start);
  if (end === -1) {
    throw new Error(`Unable to find Webpack CSS runtime string end in ${filePath}.`);
  }

  return text.slice(start, end);
}

function readAsarEntryText(asarPath, parsedAsar, filePath, entry) {
  if (entry.unpacked) {
    return fs.readFileSync(`${asarPath}.unpacked/${filePath}`, 'utf8');
  }

  const offset = parsedAsar.baseOffset + Number(entry.offset);
  return parsedAsar.buffer.subarray(offset, offset + Number(entry.size)).toString();
}

function walkAsarEntries(entry, callback, filePath = '') {
  for (const [name, child] of Object.entries(entry.files || {})) {
    const childPath = filePath ? `${filePath}/${name}` : name;
    if (child.files) {
      walkAsarEntries(child, callback, childPath);
    } else {
      callback(childPath, child);
    }
  }
}

function readMatchingAsarTexts(asarPath, filePredicate) {
  const parsedAsar = parseAsarHeader(asarPath);
  const matches = [];

  walkAsarEntries(parsedAsar.header, (filePath, entry) => {
    if (entry.unpacked || !filePredicate(filePath)) {
      return;
    }

    matches.push({
      filePath,
      text: readAsarEntryText(asarPath, parsedAsar, filePath, entry),
    });
  });

  return matches;
}

function topLevelJavaScriptEntries(asarPath) {
  return readMatchingAsarTexts(asarPath, (filePath) => /^[^/]+\.js$/.test(filePath));
}

function matchingTextFiles(files, patternOrText) {
  return files
    .filter(({ text }) =>
      typeof patternOrText === 'string' ? text.includes(patternOrText) : patternOrText.test(text),
    )
    .map(({ filePath }) => filePath);
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
  const fd = fs.openSync(filePath, 'r');
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
  return readMagic(filePath, 2).equals(Buffer.from('MZ'));
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
    const hint = isWindowsPe(filePath) ? 'Windows PE file' : 'not an ELF file';
    throw new Error(`Expected Linux ELF binary, got ${hint}: ${filePath}`);
  }
}

function verifyNativeModules(portDir) {
  const unpackedDir = path.join(portDir, 'resources', 'app.asar.unpacked');
  const nodeFiles = listFiles(unpackedDir).filter((filePath) => filePath.endsWith('.node'));
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
      process.stdout.write(
        `Found extra Linux native module: ${path.relative(unpackedDir, filePath)}\n`,
      );
    }
  }

  process.stdout.write(
    `Verified ${requiredNodeFiles.length} rebuilt native module(s) are Linux ELF binaries; ignored ${extraNodeFiles.length} packaged platform prebuild(s).\n`,
  );
}

function verifyBundlePatches(asarPath, blackTheme = true) {
  const mainJs = readAsarText(asarPath, 'main.js');
  const missing = REQUIRED_PATCH_MARKERS.filter((marker) => {
    if (!blackTheme && marker.isThematic) {
      return false;
    }
    return !mainJs.includes(marker.value);
  });
  if (missing.length > 0) {
    throw new Error(
      `Missing bundle patch marker(s): ${missing.map((marker) => marker.name).join(', ')}`,
    );
  }
  new Function(mainJs);
  process.stdout.write('Verified app.asar patch markers and main.js syntax.\n');
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
    'main.js',
    '7839.js',
    '4701.js',
    '3645.js',
    '3014.js',
    'boronTabShell.js',
    'node_modules/en-conduit-electron/dist/MainResourceProxy.js',
  ];
  const syntaxCheckPatterns = [
    /^main\.js$/,
    /^7839\.js$/,
    /^3645\.js$/,
    /^3014\.js$/,
    /^4701\.js$/,
    /^boronTabShell\.js$/,
    /^ce\/chunks\/9008\.[^/]+\.js$/,
    /^node_modules\/@evernote\/common-editor\/chunks\/9008\.[^/]+\.js$/,
    /^node_modules\/en-conduit-electron\/dist\/MainResourceProxy\.js$/,
  ];
  const patchedMarkers = [
    String.raw`/^audio\/x-flac\b/i.test(e)?"audio/flac":r[e]||e`,
    'disclaimer:void 0',
    'background-color:#1f1f1f',
    '.U1xedhQgLIIyQkOT:hover,.brw4jmU4lkxuTAYR{background-color:#1f1f1f}',
    'box-shadow:0 0 0 1px #444,0 8px 24px #000;background:#1f1f1f;',
    'box-shadow:0 0 0 1px #000;flex-flow:column;flex-grow:1;',
    '--nav-collapsed-padding:var(--spacing-1-5)0;',
    '--nav-collapsed-width:30px;',
    'width:30px;transition:width .2s ease-in-out',
    'd=30,c=96',
    '[q,W]=ne.useState(Ua.WB)',
    'W(z),(0,pe.b)(H.NAV_DRAWER_WIDTH,z),(0,pe.b)(H.IS_NAV_EXPANDED,!1)',
    'we=(0,ne.useMemo)((()=>({width:z,height:"100%"})),[z])',
    'ke=(0,ne.useCallback)((()=>{le(z)}),[le,z])',
    'onResize:e=>{W(z)}',
  ];

  walkAsarEntries(parsedAsar.header, (filePath, entry) => {
    if (entry.unpacked || !filePath.endsWith('.js')) {
      return;
    }

    const text = readAsarEntryText(asarPath, parsedAsar, filePath, entry);
    if (
      !syntaxCheckPatterns.some((pattern) => pattern.test(filePath)) &&
      !patchedMarkers.some((marker) => text.includes(marker))
    ) {
      return;
    }

    assertJavaScriptSyntax(filePath, text);
    checkedFiles.push(filePath);
  });

  const missingRequiredFiles = requiredFiles.filter((filePath) => !checkedFiles.includes(filePath));
  if (missingRequiredFiles.length > 0) {
    throw new Error(
      `Required patched JavaScript entry missing: ${missingRequiredFiles.join(', ')}`,
    );
  }

  process.stdout.write(
    `Verified patched JavaScript syntax in ${checkedFiles.length} ASAR entry(s).\n`,
  );
}

function verifyFlacMimePatch(asarPath) {
  const { buffer, header, baseOffset } = parseAsarHeader(asarPath);
  const runtimeFilePattern = /\.(?:js|json|html)$/i;
  const oldMime = 'audio/x-flac';
  const newMime = 'audio/flac  ';
  const proxyMarker = String.raw`.replace(/^audio\/x-flac\b/i, "audio/flac")`;
  const cachedResourceMarker = 'normalizeFlacMime(resource.meta.mime)';
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
    throw new Error(`Unpatched FLAC MIME type remains in ASAR entries: ${oldMimeFiles.join(', ')}`);
  }
  if (newMimeCount === 0) {
    throw new Error('Missing normalized FLAC MIME type marker in ASAR runtime entries.');
  }
  const resourceProxyJs = readAsarText(
    asarPath,
    'node_modules/en-conduit-electron/dist/MainResourceProxy.js',
  );
  if (!resourceProxyJs.includes(proxyMarker)) {
    throw new Error('Missing FLAC MIME normalization in MainResourceProxy response metadata.');
  }
  if (!resourceProxyJs.includes(cachedResourceMarker)) {
    throw new Error('Missing FLAC MIME normalization when serving cached resources.');
  }
  const audioPlayerFiles = matchingTextFiles(
    topLevelJavaScriptEntries(asarPath),
    audioPlayerMarker,
  );
  if (audioPlayerFiles.length === 0) {
    throw new Error('Missing FLAC MIME normalization before renderer audio playback.');
  }

  process.stdout.write(
    `Verified FLAC MIME type normalization in ${newMimeCount} runtime entry occurrence(s).\n`,
  );
}

function verifyAiCopilotDisclaimerPatch(asarPath) {
  const runtimeEntries = topLevelJavaScriptEntries(asarPath);
  const staleFiles = matchingTextFiles(runtimeEntries, /disclaimer:\{text:[A-Za-z_$][\w$]*\(\)\}/);
  const patchedFiles = matchingTextFiles(runtimeEntries, 'disclaimer:void 0');

  if (staleFiles.length > 0) {
    throw new Error('Unpatched AI Assistant composer disclaimer config remains.');
  }
  if (patchedFiles.length === 0) {
    throw new Error('Missing disabled AI Assistant composer disclaimer marker.');
  }

  process.stdout.write('Verified AI Assistant composer disclaimer is disabled.\n');
}

function verifyFrozenCollapsedSidebarPatch(asarPath) {
  const runtimeEntries = topLevelJavaScriptEntries(asarPath);
  const staleMarkers = [
    'Z=j-(Dv+Pi.B),[q,W]=(0,ne.useState)(i)',
    'W(e),(0,pe.b)(H.NAV_DRAWER_WIDTH,e),(0,pe.b)(H.IS_NAV_EXPANDED,e>=Ua.g$)',
    'we=(0,ne.useMemo)((()=>({width:Q?Ua.Dl:z,height:"100%"})),[Q])',
    'ke=(0,ne.useCallback)((()=>{Q?(de(),le(Ua.Dl)):ge()}),[de,Q,le,ge])',
    'onResize:e=>{const t=e instanceof MouseEvent?e.pageX:e.changedTouches[0].pageX;W(me(t))}',
  ];
  const patchedMarkers = [
    'Z=j-(Dv+Pi.B),[q,W]=ne.useState(Ua.WB)',
    'W(z),(0,pe.b)(H.NAV_DRAWER_WIDTH,z),(0,pe.b)(H.IS_NAV_EXPANDED,!1)',
    'we=(0,ne.useMemo)((()=>({width:z,height:"100%"})),[z])',
    'ke=(0,ne.useCallback)((()=>{le(z)}),[le,z])',
    'onResize:e=>{W(z)}',
  ];
  const staleFiles = staleMarkers.flatMap((marker) => matchingTextFiles(runtimeEntries, marker));
  const patchedFiles = patchedMarkers.map((marker) => matchingTextFiles(runtimeEntries, marker));

  if (staleFiles.length > 0) {
    throw new Error('Unpatched expanding left sidebar path remains.');
  }
  const missingMarkers = patchedMarkers.filter((_, index) => patchedFiles[index].length === 0);
  if (missingMarkers.length > 0) {
    throw new Error(`Missing frozen left sidebar marker(s): ${missingMarkers.join(', ')}`);
  }

  process.stdout.write('Verified left sidebar is frozen to the collapsed rail.\n');
}

function verifyBlackBackgroundThemePatch(asarPath) {
  const { buffer, header, baseOffset } = parseAsarHeader(asarPath);
  const appThemeRuntime = webpackCssRuntimeText(readAsarText(asarPath, '7839.js'), '7839.js');
  if (!appThemeRuntime.includes('--color-background-base-fill-primary:#000')) {
    throw new Error('Missing black app background theme token patch.');
  }
  if (
    /--color-background-base-fill-primary:var\(--colors-grey-(?:100|8)\);/.test(appThemeRuntime)
  ) {
    throw new Error('Unpatched app background theme token remains.');
  }
  if (!appThemeRuntime.includes('--color-note_list-base-stroke-enabled:#000')) {
    throw new Error('Missing black note list stroke theme token patch.');
  }
  if (!appThemeRuntime.includes('--color-button-content-fill-primary-default:#fff')) {
    throw new Error('Missing white primary button text theme token patch.');
  }
  if (
    /--color-button-content-fill-primary-default:\s*var\(--colors-grey-8\);/.test(appThemeRuntime)
  ) {
    throw new Error('Unpatched dark primary button text theme token remains.');
  }

  let editorBackgroundTokenPatched = false;
  let editorDarkBackgroundPatched = false;
  let editorFormattingBackgroundPreserved = false;

  walkAsarEntries(header, (filePath, entry) => {
    if (
      entry.unpacked ||
      !/^(?:4701\.js|ce\/ce-[^/]+\.css|node_modules\/@evernote\/common-editor\/(?:ce|headless)\.css)$/.test(
        filePath,
      )
    ) {
      return;
    }

    const offset = baseOffset + Number(entry.offset);
    const text = buffer.subarray(offset, offset + Number(entry.size)).toString();
    editorBackgroundTokenPatched ||= text.includes('--color-background-fill-primary:#000');
    editorDarkBackgroundPatched ||= text.includes(
      'body.darkMode en-note.peso{background-color:#000',
    );
    editorFormattingBackgroundPreserved ||= text.includes(
      'background-color:var(--color-surface-fill-tertiary-enabled)',
    );
  });

  if (!editorBackgroundTokenPatched) {
    throw new Error('Missing black editor background theme token patch.');
  }
  if (!editorDarkBackgroundPatched) {
    throw new Error('Missing black dark-mode note background patch.');
  }
  if (!editorFormattingBackgroundPreserved) {
    throw new Error('Editor formatting background token was not preserved.');
  }

  process.stdout.write('Verified black background theme patches.\n');
}

function verifyStartupBackgroundPatch(portDir, asarPath) {
  const mainJs = readAsarText(asarPath, 'main.js');
  const splashScreenPath = path.join(
    portDir,
    'resources',
    'static',
    'splashscreen',
    'splashscreen.html',
  );
  const splashScreen = fs.readFileSync(splashScreenPath, 'utf8');

  if (mainJs.includes('backgroundColor:"transparent"')) {
    throw new Error('Unpatched transparent Electron window startup background remains.');
  }
  if (!mainJs.includes('backgroundColor:"#000000"')) {
    throw new Error('Missing black Electron window startup background marker.');
  }
  if (!splashScreen.includes('background: #000')) {
    throw new Error('Missing black splash screen inline background marker.');
  }
  if (/background: rgb\(255 255 255\);|color: rgb\(26 26 26\);/.test(splashScreen)) {
    throw new Error('Unpatched light splash screen colors remain.');
  }
  if (!/background: rgb\(0 0 0\);/.test(splashScreen)) {
    throw new Error('Missing black splash screen media background marker.');
  }

  process.stdout.write('Verified startup window and splash backgrounds are black.\n');
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
    throw new Error('No editor selection CSS files found.');
  }
  if (staleFiles.length > 0) {
    throw new Error(`Unpatched editor text selection color remains in ${staleFiles.join(', ')}.`);
  }
  if (patchedFiles === 0) {
    throw new Error('Missing brightened editor text selection marker.');
  }

  process.stdout.write('Verified editor text selection overlays are brighter.\n');
}

function verifyEditorHorizontalPaddingPatch(asarPath) {
  const parsedAsar = parseAsarHeader(asarPath);
  const editorPaddingFilePattern =
    /^(?:4701\.js|ce\/ce-[^/]+\.css|node_modules\/@evernote\/common-editor\/(?:ce|headless)\.css)$/;
  const stalePaddingPattern = /padding-left:(?:48px|8px\s*);padding-right:(?:48px|8px\s*)/;
  const patchedPaddingPattern = /padding-left:0px\s*;padding-right:0px\s*/;
  const staleFiles = [];
  let checkedFiles = 0;
  let patchedFiles = 0;

  walkAsarEntries(parsedAsar.header, (filePath, entry) => {
    if (entry.unpacked || !editorPaddingFilePattern.test(filePath)) {
      return;
    }

    checkedFiles += 1;
    const text = readAsarEntryText(asarPath, parsedAsar, filePath, entry);
    if (stalePaddingPattern.test(text)) {
      staleFiles.push(filePath);
    }
    if (patchedPaddingPattern.test(text)) {
      patchedFiles += 1;
    }
  });

  if (checkedFiles === 0) {
    throw new Error('No editor padding CSS files found.');
  }
  if (staleFiles.length > 0) {
    throw new Error(`Unpatched editor horizontal padding remains in ${staleFiles.join(', ')}.`);
  }
  if (patchedFiles < 4) {
    throw new Error(`Missing compact editor horizontal padding marker; found ${patchedFiles}.`);
  }

  process.stdout.write('Verified note editor horizontal padding is compact.\n');
}

function verifyEditorNoteLayoutPatch(asarPath) {
  const parsedAsar = parseAsarHeader(asarPath);
  const editorLayoutFilePattern =
    /^(?:3407\.js|ce\/ce-[^/]+\.js|node_modules\/@evernote\/common-editor\/(?:ce|headless)\.js)$/;
  const staleLayoutPattern =
    /h=840,f=24,g=124,y=0,v=41,(?:b=56,E=56,_="center"|b=56,_=56,E="center"),T=!1,A=40/;
  const patchedLayoutPattern =
    /h=840,f=24,g=124,y=0,v=41,(?:b=0\s,E=0\s,_="left",T=!1\s\s|b=0\s,_=0\s,E="left",T=!1\s\s),A=40/;
  const staleFiles = [];
  let checkedFiles = 0;
  let patchedFiles = 0;

  walkAsarEntries(parsedAsar.header, (filePath, entry) => {
    if (entry.unpacked || !editorLayoutFilePattern.test(filePath)) {
      return;
    }

    checkedFiles += 1;
    const text = readAsarEntryText(asarPath, parsedAsar, filePath, entry);
    if (staleLayoutPattern.test(text)) {
      staleFiles.push(filePath);
    }
    if (patchedLayoutPattern.test(text)) {
      patchedFiles += 1;
    }
  });

  if (checkedFiles === 0) {
    throw new Error('No editor note layout JS files found.');
  }
  if (staleFiles.length > 0) {
    throw new Error(`Unpatched editor note layout margin remains in ${staleFiles.join(', ')}.`);
  }
  if (patchedFiles < 4) {
    throw new Error(`Missing left-aligned editor note layout marker; found ${patchedFiles}.`);
  }

  process.stdout.write('Verified note editor layout is left-aligned with no side margin.\n');
}

function verifyTagSuggestionHoverPatch(asarPath) {
  const parsedAsar = parseAsarHeader(asarPath);
  const stalePattern =
    /background-color:var\(--color-surface-fill-primary-hover\);color:var\(--color-text-fill-tertiary-enabled\);cursor:pointer;transition-property:background-color;/;
  const patchedPattern =
    /background-color:#1f1f1f\s*;color:var\(--color-text-fill-tertiary-enabled\);cursor:pointer;transition-property:background-color;/;
  const staleTransitionPattern =
    /background-color:#1f1f1f\s*;color:var\(--color-text-fill-tertiary-enabled\);cursor:pointer;transition-property:background-color;\s*transition-duration:\.1s;transition-timing-function:ease-in-out/;
  const instantTransitionPattern =
    /background-color:#1f1f1f\s*;color:var\(--color-text-fill-tertiary-enabled\);cursor:pointer;transition-property:background-color;\s*transition-duration:0s\s*;transition-timing-function:ease-in-out/;
  const staleFiles = [];
  const patchedFiles = [];
  const staleTransitionFiles = [];
  const instantTransitionFiles = [];

  walkAsarEntries(parsedAsar.header, (filePath, entry) => {
    if (entry.unpacked || !filePath.endsWith('.js')) {
      return;
    }

    const text = readAsarEntryText(asarPath, parsedAsar, filePath, entry);
    if (stalePattern.test(text)) {
      staleFiles.push(filePath);
    }
    if (patchedPattern.test(text)) {
      patchedFiles.push(filePath);
      assertJavaScriptSyntax(filePath, text);
    }
    if (staleTransitionPattern.test(text)) {
      staleTransitionFiles.push(filePath);
    }
    if (instantTransitionPattern.test(text)) {
      instantTransitionFiles.push(filePath);
    }
  });

  if (staleFiles.length > 0) {
    throw new Error(
      `Unpatched tag suggestion hover background remains in ${staleFiles.join(', ')}.`,
    );
  }
  if (patchedFiles.length < 2) {
    throw new Error(`Missing visible tag suggestion hover marker; found ${patchedFiles.length}.`);
  }
  if (staleTransitionFiles.length > 0) {
    throw new Error(
      `Animated tag suggestion hover transition remains in ${staleTransitionFiles.join(', ')}.`,
    );
  }
  if (instantTransitionFiles.length < 2) {
    throw new Error(
      `Missing instant tag suggestion hover transition marker; found ${instantTransitionFiles.length}.`,
    );
  }

  process.stdout.write(
    'Verified tag suggestion hover background is visible and instant on black theme.\n',
  );
}

function verifyDropdownItemHoverPatch(asarPath) {
  const parsedAsar = parseAsarHeader(asarPath);
  const stalePattern =
    /flex-direction:column;align-self:stretch;transition:scale \.15s;display:flex\}(\.[A-Za-z0-9_-]+):hover\{background-color:var\(--color-surface-fill-primary-hover\)\}\1:active\{scale:\.99\}/;
  const patchedPattern =
    /flex-direction:column;align-self:stretch;transition:scale \.15s;display:flex\}(\.[A-Za-z0-9_-]+):hover\{background-color:#1f1f1f\s*\}\1:active\{scale:\.99\}/;
  const staleFiles = [];
  const patchedFiles = [];
  const dropdownStyleFiles = [];

  walkAsarEntries(parsedAsar.header, (filePath, entry) => {
    if (entry.unpacked || !filePath.endsWith('.js')) {
      return;
    }

    const text = readAsarEntryText(asarPath, parsedAsar, filePath, entry);
    if (stalePattern.test(text)) {
      staleFiles.push(filePath);
    }
    if (patchedPattern.test(text)) {
      patchedFiles.push(filePath);
      assertJavaScriptSyntax(filePath, text);
    }
    if (text.includes('components/DropdownItem/styles.css')) {
      dropdownStyleFiles.push(filePath);
    }
  });

  if (staleFiles.length > 0) {
    throw new Error(
      `Unpatched dropdown menu item hover background remains in ${staleFiles.join(', ')}.`,
    );
  }
  if (patchedFiles.length < 1) {
    throw new Error('Missing visible dropdown menu item hover background marker.');
  }
  if (dropdownStyleFiles.length < 1) {
    throw new Error('DropdownItem stylesheet marker is missing.');
  }
  const noteActionFiles = matchingTextFiles(
    topLevelJavaScriptEntries(asarPath),
    'Action.note.openInLiteEditor',
  );
  if (noteActionFiles.length < 1) {
    throw new Error('Note actions dropdown marker is missing.');
  }

  process.stdout.write('Verified dropdown menu item hover background is visible on black theme.\n');
}

function verifySearchDropdownItemHoverPatch(asarPath) {
  const runtimeEntries = topLevelJavaScriptEntries(asarPath);
  const staleMarker = '.brw4jmU4lkxuTAYR{background-color:var(--color-surface-fill-primary-hover)}';
  const patchedMarker = '.U1xedhQgLIIyQkOT:hover,.brw4jmU4lkxuTAYR{background-color:#1f1f1f}';
  const staleFiles = matchingTextFiles(runtimeEntries, staleMarker);
  const patchedFiles = matchingTextFiles(runtimeEntries, patchedMarker);

  if (staleFiles.length > 0) {
    throw new Error('Unpatched search result item selected-only background remains.');
  }
  if (patchedFiles.length === 0) {
    throw new Error('Missing visible search result item hover background marker.');
  }

  process.stdout.write('Verified search result item hover background is visible on black theme.\n');
}

function verifySourceUrlPillWidthPatch(asarPath) {
  const parsedAsar = parseAsarHeader(asarPath);
  const sourceUrlFilePattern =
    /^(?:4701\.js|ce\/ce-[^/]+\.css|node_modules\/@evernote\/common-editor\/(?:ce|headless)\.css)$/;
  const staleContainerPattern =
    /\.SiiOu\{[^}]*?max-width:375px|body\.neutron \.SiiOu\{[^}]*?max-width:165px/;
  const staleTextPattern =
    /\.yjBnv\{line-height:18px;max-width:187\.5px|body\.neutron \.yjBnv\{max-width:106\.5px\}/;
  const patchedContainerPattern =
    /\.SiiOu\{[^}]*?max-width:none\s*;[^}]*\}\.SiiOu,body\.neutron \.SiiOu\{[^}]*\}(?:body\.neutron \.SiiOu\{[^}]*\})?body\.neutron \.SiiOu\{[^}]*?max-width:none\s*;/;
  const patchedTextPattern =
    /\.yjBnv\{line-height:18px;max-width:none\s*;overflow:hidden;text-overflow:ellipsis;white-space:nowrap\}body\.neutron \.yjBnv\{max-width:none\s*\}/;
  const staleFiles = [];
  const patchedContainerFiles = [];
  const patchedTextFiles = [];

  walkAsarEntries(parsedAsar.header, (filePath, entry) => {
    if (entry.unpacked || !sourceUrlFilePattern.test(filePath)) {
      return;
    }

    const text = readAsarEntryText(asarPath, parsedAsar, filePath, entry);
    if (staleContainerPattern.test(text) || staleTextPattern.test(text)) {
      staleFiles.push(filePath);
    }
    if (patchedContainerPattern.test(text)) {
      patchedContainerFiles.push(filePath);
    }
    if (patchedTextPattern.test(text)) {
      patchedTextFiles.push(filePath);
    }
  });

  if (staleFiles.length > 0) {
    throw new Error(`Unpatched source URL pill width limit remains in ${staleFiles.join(', ')}.`);
  }
  if (patchedContainerFiles.length < 4) {
    throw new Error(
      `Missing source URL chip container width marker; found ${patchedContainerFiles.length}.`,
    );
  }
  if (patchedTextFiles.length < 4) {
    throw new Error(`Missing source URL text width marker; found ${patchedTextFiles.length}.`);
  }

  process.stdout.write('Verified source URL pill can use the available note header width.\n');
}

function verifyMultiSelectFloatingMenuPatch(asarPath) {
  const runtimeEntries = topLevelJavaScriptEntries(asarPath);
  const stalePattern =
    /\.cSX4Fc7FHQb632Sg\{[^}]*background:var\(--color-surface-fill-secondarybrand-enabled\)[^}]*\}\.UBpdhKOC1XkODEHP\{[^}]*color:var\(--color-text-fill-inverted-enabled\)/;
  const patchedPattern =
    /\.cSX4Fc7FHQb632Sg\{[^}]*box-shadow:0 0 0 1px #444,0 8px 24px #000;[^}]*background:#1f1f1f;[^}]*\}\.UBpdhKOC1XkODEHP\{[^}]*color:#fff;[^}]*\}\.smD3K8Nh5kcQyNGr\{[^}]*\}\._BcxFGjeF0UUj5Z_\{[^}]*\}\.smD3K8Nh5kcQyNGr,\.smD3K8Nh5kcQyNGr \*\{color:#fff!important;fill:#fff!important;stroke:#fff!important\}\.a9h8bbz8LYMfS910\{background-color:#555;/;
  const staleFiles = matchingTextFiles(runtimeEntries, stalePattern);
  const patchedFiles = matchingTextFiles(runtimeEntries, patchedPattern);

  if (staleFiles.length > 0) {
    throw new Error('Unpatched multi-select floating menu contrast remains.');
  }
  if (patchedFiles.length === 0) {
    throw new Error('Missing visible multi-select floating menu marker.');
  }

  process.stdout.write('Verified multi-select floating menu is visible on black theme.\n');
}

function verifyNoteDetailFrameLinePatch(asarPath) {
  const runtimeEntries = topLevelJavaScriptEntries(asarPath);
  const staleMarker =
    'box-shadow:var(--shadow-app-components-background-base);flex-flow:column;flex-grow:1;display:flex;position:relative;overflow:hidden';
  const patchedMarker =
    'box-shadow:0 0 0 1px #000;flex-flow:column;flex-grow:1;display:flex;position:relative;overflow:hidden';
  const staleFiles = matchingTextFiles(runtimeEntries, staleMarker);
  const patchedFiles = matchingTextFiles(runtimeEntries, patchedMarker);

  if (staleFiles.length > 0) {
    throw new Error('Unpatched note detail frame line between notes list and editor remains.');
  }
  if (patchedFiles.length === 0) {
    throw new Error('Missing hidden note detail frame line marker.');
  }

  process.stdout.write('Verified note detail frame line between notes list and editor is black.\n');
}

function verifyNativeResourceDragPatch(asarPath) {
  const commonEditorRuntime = readAsarText(asarPath, '3645.js');
  const runtimeEntries = topLevelJavaScriptEntries(asarPath);

  if (commonEditorRuntime.includes('(0,F.Ld)()&&x.Z.isMac')) {
    throw new Error('Common editor resource drag still uses macOS-only native drag.');
  }
  const staleBoronFiles = matchingTextFiles(runtimeEntries, 'if(e.isBoron&&n.boronEnv.isMac)');
  if (staleBoronFiles.length > 0) {
    throw new Error('Boron resource drag still uses macOS-only native drag.');
  }
  if (!commonEditorRuntime.includes('if((0,F.Ld)())n.preventDefault(),(0,U.HH)')) {
    throw new Error('Missing native common editor resource drag marker.');
  }
  const patchedBoronFiles = matchingTextFiles(
    runtimeEntries,
    'if(e.isBoron)t.payload.event.preventDefault(),n.broker.call("boron.actions.setNativeFilesForDrag"',
  );
  if (patchedBoronFiles.length === 0) {
    throw new Error('Missing native Boron resource drag marker.');
  }

  process.stdout.write('Verified resource drag uses native file dragging on Linux.\n');
}

function verifyActiveTabTitlePatch(asarPath) {
  const runtime = readAsarText(asarPath, 'boronTabShell.js');
  const staleMarker =
    '.gger9Drdmhogq7zI{background:var(--color-surface-fill-primary-enabled);color:var(--color-text-fill-tertiary-enabled);border-radius:24px}';
  const patchedMarker =
    '.gger9Drdmhogq7zI{background:var(--color-surface-fill-primary-enabled);color:#fff;font-weight:700;border-radius:24px}';

  if (runtime.includes(staleMarker)) {
    throw new Error('Unpatched active tab title color remains.');
  }
  if (!runtime.includes(patchedMarker)) {
    throw new Error('Missing emphasized active tab title marker.');
  }

  process.stdout.write('Verified active tab title is white and bold.\n');
}

function verifyTabButtonHitTargetPatch(asarPath) {
  const runtime = readAsarText(asarPath, 'boronTabShell.js');
  const staleMarker =
    '.guV7KlaE1WwDAqBe,.GKwwIN39E1caVAFH,.gzvhLiD0v_o9RDyf,.OIVeVYl42Uq2kEtS{letter-spacing:-.12px;cursor:pointer;-webkit-app-region:no-drag;background:0 0;border:none;flex:1 1 0;justify-content:center;align-items:center;min-width:0;max-width:200px;height:38px;padding:0 2px;font-size:13px;line-height:20px;display:inline-flex}';
  const patchedMarker =
    '.guV7KlaE1WwDAqBe,.GKwwIN39E1caVAFH,.gzvhLiD0v_o9RDyf,.OIVeVYl42Uq2kEtS{letter-spacing:-.12px;cursor:pointer;-webkit-app-region:no-drag;background:0 0;border:none;flex:1 1 0;justify-content:center;align-items:center;min-width:0;max-width:200px;height:40px;padding:0 2px;font-size:13px;line-height:20px;display:inline-flex}';

  if (runtime.includes(staleMarker)) {
    throw new Error('Unpatched tab button top-edge hit target remains.');
  }
  if (!runtime.includes(patchedMarker)) {
    throw new Error('Missing full-height tab button marker.');
  }

  process.stdout.write('Verified tab buttons reach the top edge of the tab shell.\n');
}

function verifyCollapsedNavWidthPatch(asarPath) {
  const runtimeEntries = topLevelJavaScriptEntries(asarPath);
  const stalePattern =
    /[A-Za-z_$][\w$]*=[A-Za-z_$][\w$]*\.V0,[A-Za-z_$][\w$]*=Math\.max\(Math\.min\([A-Za-z_$][\w$]*\.af,[A-Za-z_$][\w$]*\),[A-Za-z_$][\w$]*\)/;
  const patchedPattern =
    /[A-Za-z_$][\w$]*=[A-Za-z_$][\w$]*\.WB,[A-Za-z_$][\w$]*=Math\.max\(Math\.min\([A-Za-z_$][\w$]*\.af,[A-Za-z_$][\w$]*\),[A-Za-z_$][\w$]*\)/;
  const staleFiles = matchingTextFiles(runtimeEntries, stalePattern);
  const patchedFiles = matchingTextFiles(runtimeEntries, patchedPattern);

  if (staleFiles.length > 0) {
    throw new Error('Unpatched collapsed sidebar width remains.');
  }
  if (patchedFiles.length === 0) {
    throw new Error('Missing minimized collapsed sidebar width marker.');
  }

  process.stdout.write('Verified collapsed sidebar uses minimum icon rail width.\n');
}

function verifyCollapsedNavSpacingPatch(asarPath) {
  const runtimeEntries = topLevelJavaScriptEntries(asarPath);
  const oldPaddingToken = '--nav-collapsed-padding:var(--spacing-0-5)var(--spacing-2);';
  const intermediatePaddingToken = '--nav-collapsed-padding:var(--spacing-1-5)var(--spacing-2);';
  const newPaddingToken = '--nav-collapsed-padding:var(--spacing-1-5)0;';
  const oldItemPadding = 'padding:var(--spacing-0-5)var(--spacing-2);justify-content:center;';
  const intermediateItemPadding =
    'padding:var(--spacing-1-5)var(--spacing-2);justify-content:center;';
  const newItemPadding = 'padding:var(--spacing-1-5)0;justify-content:center;';
  const staleFiles = matchingTextFiles(
    runtimeEntries,
    new RegExp(
      [oldPaddingToken, intermediatePaddingToken, oldItemPadding, intermediateItemPadding]
        .map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('|'),
    ),
  );

  if (staleFiles.length > 0) {
    throw new Error('Unpatched collapsed sidebar icon spacing remains.');
  }
  if (
    matchingTextFiles(runtimeEntries, newPaddingToken).length === 0 ||
    matchingTextFiles(runtimeEntries, newItemPadding).length === 0
  ) {
    throw new Error('Missing increased collapsed sidebar icon spacing marker.');
  }

  process.stdout.write('Verified collapsed sidebar icon rail vertical spacing.\n');
}

function verifyCollapsedNavThinWidthPatch(asarPath) {
  const runtimeEntries = topLevelJavaScriptEntries(asarPath);
  const oldCompiledContainerWidth = 'width:60px;transition:width .2s ease-in-out';
  const newCompiledContainerWidth = 'width:30px;transition:width .2s ease-in-out';

  if (matchingTextFiles(runtimeEntries, '--nav-collapsed-width:60px;').length > 0) {
    throw new Error('Unpatched collapsed sidebar CSS rail width remains.');
  }
  if (matchingTextFiles(runtimeEntries, '--nav-collapsed-width:30px;').length === 0) {
    throw new Error('Missing halved collapsed sidebar CSS rail width marker.');
  }
  if (matchingTextFiles(runtimeEntries, oldCompiledContainerWidth).length > 0) {
    throw new Error('Unpatched collapsed sidebar active container width remains.');
  }
  if (matchingTextFiles(runtimeEntries, newCompiledContainerWidth).length === 0) {
    throw new Error('Missing halved collapsed sidebar active container width marker.');
  }
  if (matchingTextFiles(runtimeEntries, 'd=60,c=96').length > 0) {
    throw new Error('Unpatched collapsed sidebar runtime rail width remains.');
  }
  if (matchingTextFiles(runtimeEntries, 'd=30,c=96').length === 0) {
    throw new Error('Missing halved collapsed sidebar runtime rail width marker.');
  }

  process.stdout.write('Verified collapsed sidebar rail width is halved.\n');
}

function verifyNoteSnippetSeparatorsPatch(asarPath) {
  const noteListRuntime = readAsarText(asarPath, '3014.js');
  const oldSeparator =
    '--noteSnippet-border-bottom:1px solid var(--color-snippet-base-stroke-enabled);';
  const newSeparator = '--noteSnippet-border-bottom:0px solid transparent';

  if (noteListRuntime.includes(oldSeparator)) {
    throw new Error('Unpatched note snippet separator line remains.');
  }
  if (!noteListRuntime.includes(newSeparator)) {
    throw new Error('Missing removed note snippet separator marker.');
  }

  process.stdout.write('Verified note snippet separator lines are removed.\n');
}

function verifyArtifact(options) {
  const portDir = path.resolve(options.portDir);
  const asarPath = path.join(portDir, 'resources', 'app.asar');

  const buildInfoPath = path.join(DIST_DIR, 'build-info.json');
  const buildInfo = fs.existsSync(buildInfoPath)
    ? JSON.parse(fs.readFileSync(buildInfoPath, 'utf8'))
    : {};
  const blackTheme = buildInfo.blackTheme !== false;

  requireExecutable(path.join(portDir, 'evernote'));
  verifyElf(path.join(portDir, 'Evernote'));
  verifyElf(path.join(portDir, 'chrome-sandbox'));
  requireFile(asarPath);
  requireFile(path.join(portDir, 'resources', 'app-update.yml'));

  verifyNativeModules(portDir);
  verifyBundlePatches(asarPath, blackTheme);
  verifyPatchedJavaScriptSyntax(asarPath);
  verifyFlacMimePatch(asarPath);
  verifyAiCopilotDisclaimerPatch(asarPath);

  if (blackTheme) {
    verifyBlackBackgroundThemePatch(asarPath);
    verifyStartupBackgroundPatch(portDir, asarPath);
    verifyEditorTextSelectionPatch(asarPath);
    verifyEditorHorizontalPaddingPatch(asarPath);
    verifyEditorNoteLayoutPatch(asarPath);
    verifyTagSuggestionHoverPatch(asarPath);
    verifyDropdownItemHoverPatch(asarPath);
    verifySearchDropdownItemHoverPatch(asarPath);
    verifySourceUrlPillWidthPatch(asarPath);
    verifyMultiSelectFloatingMenuPatch(asarPath);
    verifyNoteDetailFrameLinePatch(asarPath);
    verifyActiveTabTitlePatch(asarPath);
    verifyTabButtonHitTargetPatch(asarPath);
    verifyCollapsedNavWidthPatch(asarPath);
    verifyCollapsedNavSpacingPatch(asarPath);
    verifyCollapsedNavThinWidthPatch(asarPath);
    verifyNoteSnippetSeparatorsPatch(asarPath);
    verifyFrozenCollapsedSidebarPatch(asarPath);
  }

  verifyNativeResourceDragPatch(asarPath);

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
