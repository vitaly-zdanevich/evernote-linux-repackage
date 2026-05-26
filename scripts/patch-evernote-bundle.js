#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

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

  if (filePath.endsWith('.js')) {
    const patchedFileBuffer = Buffer.from(fileBuffer);
    replacementBytes.copy(patchedFileBuffer, index);
    assertJavaScriptSyntax(filePath, patchedFileBuffer.toString());
  }

  replacementBytes.copy(buffer, start + index);
  fs.writeFileSync(asarPath, buffer);
  return true;
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

function replaceAllInAsarEntries(asarPath, filePattern, search, replacement) {
  const searchBytes = Buffer.from(search);
  const replacementBytes = Buffer.from(replacement);
  if (searchBytes.length !== replacementBytes.length) {
    throw new Error(
      `Replacement must preserve byte length: ${searchBytes.length} != ${replacementBytes.length}`,
    );
  }

  const { buffer, header, baseOffset } = parseAsarHeader(asarPath);
  let replacements = 0;
  let alreadyPatched = false;

  walkAsarEntries(header, (filePath, entry) => {
    if (entry.unpacked || !filePattern.test(filePath)) {
      return;
    }

    const start = baseOffset + Number(entry.offset);
    const end = start + Number(entry.size);
    const fileBuffer = buffer.subarray(start, end);
    let index = fileBuffer.indexOf(searchBytes);
    let fileReplacements = 0;

    if (index === -1) {
      alreadyPatched ||= fileBuffer.indexOf(replacementBytes) !== -1;
      return;
    }

    while (index !== -1) {
      replacementBytes.copy(buffer, start + index);
      replacements += 1;
      fileReplacements += 1;
      index = fileBuffer.indexOf(searchBytes, index + replacementBytes.length);
    }

    if (fileReplacements > 0 && filePath.endsWith('.js')) {
      assertJavaScriptSyntax(filePath, fileBuffer.toString());
    }
  });

  if (replacements === 0) {
    if (alreadyPatched) {
      return false;
    }
    throw new Error(`Patch target not found in ASAR entries: ${search}`);
  }

  fs.writeFileSync(asarPath, buffer);
  return true;
}

function replacePatternInAsarEntries(
  asarPath,
  filePattern,
  pattern,
  replacementForMatch,
  alreadyPatchedPattern,
  textRangeForPattern,
) {
  if (!pattern.global) {
    throw new Error('Pattern replacements must use a global regular expression.');
  }
  if (alreadyPatchedPattern && !alreadyPatchedPattern.global) {
    throw new Error('Already-patched checks must use a global regular expression.');
  }

  const { buffer, header, baseOffset } = parseAsarHeader(asarPath);
  let matches = 0;
  let replacements = 0;
  let alreadyPatched = false;
  const searchedFiles = [];

  walkAsarEntries(header, (filePath, entry) => {
    if (entry.unpacked || !filePattern.test(filePath)) {
      return;
    }
    searchedFiles.push(filePath);

    const start = baseOffset + Number(entry.offset);
    const end = start + Number(entry.size);
    const text = buffer.subarray(start, end).toString();
    const textRange = textRangeForPattern ? textRangeForPattern(text, filePath) : null;
    const targetText = textRange ? text.slice(textRange.start, textRange.end) : text;
    pattern.lastIndex = 0;
    if (alreadyPatchedPattern) {
      alreadyPatchedPattern.lastIndex = 0;
      alreadyPatched ||= alreadyPatchedPattern.test(targetText);
    }

    const patchedTargetText = targetText.replace(pattern, (...args) => {
      matches += 1;
      const match = args[0];
      const replacement = replacementForMatch(match, filePath);
      if (Buffer.byteLength(replacement) !== Buffer.byteLength(match)) {
        throw new Error(`Replacement for ${filePath} must preserve byte length.`);
      }
      if (replacement !== match) {
        replacements += 1;
      }
      return replacement;
    });
    const patchedText = textRange
      ? `${text.slice(0, textRange.start)}${patchedTargetText}${text.slice(textRange.end)}`
      : patchedTargetText;

    if (patchedText !== text) {
      if (Buffer.byteLength(patchedText) !== Number(entry.size)) {
        throw new Error(`Replacement for ${filePath} changed ASAR entry byte length.`);
      }
      assertJavaScriptSyntax(filePath, patchedText);
      Buffer.from(patchedText).copy(buffer, start);
    }
  });

  if (matches === 0) {
    if (alreadyPatched) {
      return false;
    }
    throw new Error(
      `Patch target pattern not found in ASAR entries: ${pattern} (searched ${searchedFiles.join(', ')})`,
    );
  }

  if (replacements === 0) {
    return false;
  }

  fs.writeFileSync(asarPath, buffer);
  return true;
}

function sameLengthReplacement(search, replacementPrefix) {
  if (replacementPrefix.length > search.length) {
    throw new Error('Replacement prefix is longer than search string.');
  }
  return replacementPrefix + ' '.repeat(search.length - replacementPrefix.length);
}

function replaceCssDeclarationValue(declaration, value) {
  const colonIndex = declaration.indexOf(':');
  if (colonIndex === -1 || !declaration.endsWith(';')) {
    throw new Error(`Unsupported CSS declaration shape: ${declaration}`);
  }

  const prefix = declaration.slice(0, colonIndex + 1);
  const available = declaration.length - prefix.length - 1;
  if (value.length > available) {
    throw new Error(`Replacement value is longer than declaration value: ${declaration}`);
  }

  return `${prefix}${value}${' '.repeat(available - value.length)};`;
}

function replaceCssDeclarationValueWithBoundary(match, value) {
  if (match.startsWith('--')) {
    return replaceCssDeclarationValue(match, value);
  }

  return match[0] + replaceCssDeclarationValue(match.slice(1), value);
}

function assertJavaScriptSyntax(filePath, text) {
  if (!filePath.endsWith('.js')) {
    return;
  }

  try {
    new Function(text);
  } catch (error) {
    throw new Error(`Patched JavaScript syntax check failed for ${filePath}: ${error.message}`);
  }
}

function webpackCssRuntimeStringRange(text, filePath) {
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

  return { start, end };
}

const BLACK_APP_BACKGROUND_FILE_PATTERN = /^7839\.js$/;
const BLACK_APP_BACKGROUND_VARIABLE_PATTERN =
  /(?:(?<=^)|(?<=[;{]))--color-(?:background-[-a-z0-9]*|surface-fill-[-a-z0-9]*|card-base-fill-[-a-z0-9]*|input-base-fill-[-a-z0-9]*|button-base-fill-[-a-z0-9]*|textbutton-base-fill-[-a-z0-9]*|iconbutton-base-fill-[-a-z0-9]*|feedback-base-fill-[-a-z0-9]*|filterpill-base-fill-[-a-z0-9]*|tooltip-base-fill-[-a-z0-9]*|toast-base-fill-[-a-z0-9]*|toast-button-base-fill-[-a-z0-9]*|descriptivetooltip-base-fill-[-a-z0-9]*|descriptivetooltip-button-base-fill-[-a-z0-9]*|calendar_block-highlight-fill-[-a-z0-9]*|note_list-base-stroke-[-a-z0-9]*):[^;"]+;/gi;
const BLACK_APP_BACKGROUND_ALREADY_PATCHED_PATTERN =
  /(?:(?<=^)|(?<=[;{]))--color-(?:background-[-a-z0-9]*|surface-fill-[-a-z0-9]*|card-base-fill-[-a-z0-9]*|input-base-fill-[-a-z0-9]*|button-base-fill-[-a-z0-9]*|textbutton-base-fill-[-a-z0-9]*|iconbutton-base-fill-[-a-z0-9]*|feedback-base-fill-[-a-z0-9]*|filterpill-base-fill-[-a-z0-9]*|tooltip-base-fill-[-a-z0-9]*|toast-base-fill-[-a-z0-9]*|toast-button-base-fill-[-a-z0-9]*|descriptivetooltip-base-fill-[-a-z0-9]*|descriptivetooltip-button-base-fill-[-a-z0-9]*|calendar_block-highlight-fill-[-a-z0-9]*|note_list-base-stroke-[-a-z0-9]*):#000\s*;/gi;

const BLACK_EDITOR_BACKGROUND_FILE_PATTERN =
  /^(?:4701\.js|ce\/(?:ce-[^/]+\.css|TextViewer\.[^/]+\.css|PdfViewer\.[^/]+\.css|SpreadsheetViewer\.[^/]+\.css|VideoViewer\.[^/]+\.css)|ce\/chunks\/9008\.[^/]+\.js|node_modules\/@evernote\/common-editor\/(?:ce|headless|TextViewer\.[^/]+|PdfViewer\.[^/]+|SpreadsheetViewer\.[^/]+|VideoViewer\.[^/]+)\.css|node_modules\/@evernote\/common-editor\/chunks\/9008\.[^/]+\.js)$/;
const BLACK_EDITOR_BACKGROUND_VARIABLE_PATTERN =
  /(?:(?<=^)|(?<=[;{]))--color-background(?:-base)?-fill-[-a-z0-9]+:[^;"]+;/g;
const BLACK_EDITOR_BACKGROUND_ALREADY_PATCHED_PATTERN =
  /(?:(?<=^)|(?<=[;{]))--color-background(?:-base)?-fill-[-a-z0-9]+:#000\s*;/g;
const BLACK_EDITOR_HARDCODED_BACKGROUND_PATTERN = /background(?:-color)?:#262626/g;
const BLACK_EDITOR_HARDCODED_ALREADY_PATCHED_PATTERN = /background(?:-color)?:#000\s*(?=;)/g;
const EDITOR_SELECTION_BACKGROUND_FILE_PATTERN =
  /^(?:ce\/ce-[^/]+\.css|node_modules\/@evernote\/common-editor\/(?:ce|headless)\.css)$/;
const EDITOR_SELECTION_BACKGROUND_PATTERN = /rgba\(33,133,231,\.(?:25|3)\)/g;
const EDITOR_SELECTION_BACKGROUND_ALREADY_PATCHED_PATTERN = /rgba\(33,133,231,\.4\)\s*/g;
const EDITOR_HORIZONTAL_PADDING_FILE_PATTERN =
  /^(?:4701\.js|ce\/ce-[^/]+\.css|node_modules\/@evernote\/common-editor\/(?:ce|headless)\.css)$/;
const EDITOR_HORIZONTAL_PADDING_PATTERN =
  /padding-left:(?:48px|8px\s);padding-right:(?:48px|8px\s)/g;
const EDITOR_HORIZONTAL_PADDING_ALREADY_PATCHED_PATTERN =
  /padding-left:0px\s*;padding-right:0px\s*/g;
const EDITOR_NOTE_LAYOUT_FILE_PATTERN =
  /^(?:3407\.js|ce\/ce-[^/]+\.js|node_modules\/@evernote\/common-editor\/(?:ce|headless)\.js)$/;
const EDITOR_NOTE_LAYOUT_MARGIN_PATTERN =
  /h=840,f=24,g=124,y=0,v=41,(?:b=56,E=56,_="center"|b=56,_=56,E="center"),T=!1,A=40/g;
const EDITOR_NOTE_LAYOUT_MARGIN_ALREADY_PATCHED_PATTERN =
  /h=840,f=24,g=124,y=0,v=41,(?:b=0\s,E=0\s,_="left",T=!1\s\s|b=0\s,_=0\s,E="left",T=!1\s\s),A=40/g;
const TAG_SUGGESTION_HOVER_STYLES =
  'background-color:var(--color-surface-fill-primary-hover);color:var(--color-text-fill-tertiary-enabled);cursor:pointer;transition-property:background-color;transition-duration:.1s;transition-timing-function:ease-in-out';
const TAG_SUGGESTION_HOVER_REPLACEMENT =
  'background-color:#1f1f1f;color:var(--color-text-fill-tertiary-enabled);cursor:pointer;transition-property:background-color;transition-duration:0s ;transition-timing-function:ease-in-out';
const DROPDOWN_ITEM_HOVER_PATTERN =
  /flex-direction:column;align-self:stretch;transition:scale \.15s;display:flex\}(\.[A-Za-z0-9_-]+):hover\{background-color:var\(--color-surface-fill-primary-hover\)\}\1:active\{scale:\.99\}/g;
const DROPDOWN_ITEM_HOVER_ALREADY_PATCHED_PATTERN =
  /flex-direction:column;align-self:stretch;transition:scale \.15s;display:flex\}(\.[A-Za-z0-9_-]+):hover\{background-color:#1f1f1f\s*\}\1:active\{scale:\.99\}/g;
const SOURCE_URL_PILL_WIDTH_FILE_PATTERN =
  /^(?:4701\.js|ce\/ce-[^/]+\.css|node_modules\/@evernote\/common-editor\/(?:ce|headless)\.css)$/;
const SOURCE_URL_PILL_CONTAINER_MAX_WIDTH_PATTERN =
  /(\.SiiOu\{[^}]*?)max-width:375px([^}]*\}\.SiiOu,body\.neutron \.SiiOu\{[^}]*\}(?:body\.neutron \.SiiOu\{[^}]*\})?body\.neutron \.SiiOu\{[^}]*?)max-width:165px/g;
const SOURCE_URL_PILL_CONTAINER_MAX_WIDTH_ALREADY_PATCHED_PATTERN =
  /\.SiiOu\{[^}]*?max-width:none\s*;[^}]*\}\.SiiOu,body\.neutron \.SiiOu\{[^}]*\}(?:body\.neutron \.SiiOu\{[^}]*\})?body\.neutron \.SiiOu\{[^}]*?max-width:none\s*;/g;
const SOURCE_URL_PILL_TEXT_MAX_WIDTH_PATTERN =
  /(\.yjBnv\{line-height:18px;)max-width:187\.5px(;overflow:hidden;text-overflow:ellipsis;white-space:nowrap\}body\.neutron \.yjBnv\{)max-width:106\.5px(\})/g;
const SOURCE_URL_PILL_TEXT_MAX_WIDTH_ALREADY_PATCHED_PATTERN =
  /\.yjBnv\{line-height:18px;max-width:none\s*;overflow:hidden;text-overflow:ellipsis;white-space:nowrap\}body\.neutron \.yjBnv\{max-width:none\s*\}/g;
const MULTI_SELECT_FLOATING_MENU_STYLES =
  '.cSX4Fc7FHQb632Sg{z-index:var(--floating-menu-z-index);box-shadow:var(--shadow-xl);width:420px;padding:var(--spacing-0-75)var(--spacing-1-5);align-items:center;gap:var(--spacing-0-5);pointer-events:all;border-radius:var(--radius-sm-md);background:var(--color-surface-fill-secondarybrand-enabled);flex-shrink:0;justify-content:space-between;animation:.3s cG8p5qfvk3wGbIUX;display:flex;position:absolute;bottom:32px;left:50%;translate:-50%}.UBpdhKOC1XkODEHP{min-width:0;color:var(--color-text-fill-inverted-enabled);font:var(--typography-m14);padding-left:var(--spacing-0-75)}.smD3K8Nh5kcQyNGr{align-items:center;gap:var(--spacing-0-75);display:flex}._BcxFGjeF0UUj5Z_{padding:var(--spacing-0);justify-content:flex-end;align-items:center;gap:var(--spacing-0-5);display:flex}.a9h8bbz8LYMfS910{background-color:var(--color-surface-stroke-tertiary-enabled);align-items:flex-start;width:1px;height:20px;display:flex}';
const MULTI_SELECT_FLOATING_MENU_REPLACEMENT =
  '.cSX4Fc7FHQb632Sg{z-index:var(--floating-menu-z-index);box-shadow:0 0 0 1px #444,0 8px 24px #000;width:420px;padding:var(--spacing-0-75)var(--spacing-1-5);align-items:center;gap:var(--spacing-0-5);pointer-events:all;border-radius:var(--radius-sm-md);background:#1f1f1f;flex-shrink:0;justify-content:space-between;animation:.3s cG8p5qfvk3wGbIUX;display:flex;position:absolute;bottom:32px;left:50%;translate:-50%}.UBpdhKOC1XkODEHP{min-width:0;color:#fff;font:var(--typography-m14);padding-left:var(--spacing-0-75)}.smD3K8Nh5kcQyNGr{align-items:center;gap:var(--spacing-0-75);display:flex}._BcxFGjeF0UUj5Z_{padding:var(--spacing-0);justify-content:flex-end;align-items:center;gap:var(--spacing-0-5);display:flex}.smD3K8Nh5kcQyNGr,.smD3K8Nh5kcQyNGr *{color:#fff!important;fill:#fff!important;stroke:#fff!important}.a9h8bbz8LYMfS910{background-color:#555;align-items:flex-start;width:1px;height:20px;display:flex}';
const NOTE_DETAIL_FRAME_SHADOW_STYLES =
  'box-shadow:var(--shadow-app-components-background-base);flex-flow:column;flex-grow:1;display:flex;position:relative;overflow:hidden';
const NOTE_DETAIL_FRAME_SHADOW_REPLACEMENT =
  'box-shadow:0 0 0 1px #000;flex-flow:column;flex-grow:1;display:flex;position:relative;overflow:hidden';
const NATIVE_IMAGE_RESOURCE_CLIPBOARD_STYLES =
  'let A=async(t,a)=>{let n=await S(a);await (0,s.sleep)(100);try{t?.startDrag({file:"",files:n,icon:l.nativeImage.createFromDataURL(p.default)})}catch(t){b.error("setNativeFilesForDrag error",t.message)}},N=async t=>{let a=await S(t);o?.writeFilePaths(a)},M=t=>{l.clipboard.write({text:t,html:t})};function w(){return{plain:l.clipboard.readText(),html:l.clipboard.readHTML()}}';
const NATIVE_IMAGE_RESOURCE_CLIPBOARD_REPLACEMENT =
  'let A=async(t,a)=>{await(0,s.sleep)(100),t?.startDrag({files:await S(a),icon:l.nativeImage.createFromDataURL(p.default)})},N=async t=>{let a=await S(t),n=l.nativeImage.createFromPath(a[0]||"");n.isEmpty()?o?.writeFilePaths(a):l.clipboard.writeImage(n)},M=t=>l.clipboard.write({text:t,html:t});function w(){return{plain:l.clipboard.readText(),html:l.clipboard.readHTML()}}';
const ACTIVE_TAB_INNER_STYLES =
  '.gger9Drdmhogq7zI{background:var(--color-surface-fill-primary-enabled);color:var(--color-text-fill-tertiary-enabled);border-radius:24px}';
const ACTIVE_TAB_INNER_REPLACEMENT =
  '.gger9Drdmhogq7zI{background:var(--color-surface-fill-primary-enabled);color:#fff;font-weight:700;border-radius:24px}';
const TAB_BUTTON_HEIGHT_STYLES =
  '.guV7KlaE1WwDAqBe,.GKwwIN39E1caVAFH,.gzvhLiD0v_o9RDyf,.OIVeVYl42Uq2kEtS{letter-spacing:-.12px;cursor:pointer;-webkit-app-region:no-drag;background:0 0;border:none;flex:1 1 0;justify-content:center;align-items:center;min-width:0;max-width:200px;height:38px;padding:0 2px;font-size:13px;line-height:20px;display:inline-flex}';
const TAB_BUTTON_HEIGHT_REPLACEMENT =
  '.guV7KlaE1WwDAqBe,.GKwwIN39E1caVAFH,.gzvhLiD0v_o9RDyf,.OIVeVYl42Uq2kEtS{letter-spacing:-.12px;cursor:pointer;-webkit-app-region:no-drag;background:0 0;border:none;flex:1 1 0;justify-content:center;align-items:center;min-width:0;max-width:200px;height:40px;padding:0 2px;font-size:13px;line-height:20px;display:inline-flex}';
const COLLAPSED_NAV_PADDING_TOKEN_STYLES =
  '--nav-collapsed-padding:var(--spacing-0-5)var(--spacing-2);';
const COLLAPSED_NAV_PADDING_TOKEN_REPLACEMENT = '--nav-collapsed-padding:var(--spacing-1-5)0;';
const COLLAPSED_NAV_ITEM_PADDING_STYLES =
  'padding:var(--spacing-0-5)var(--spacing-2);justify-content:center;';
const COLLAPSED_NAV_ITEM_PADDING_REPLACEMENT =
  'padding:var(--spacing-1-5)0;justify-content:center;';

const patches = [
  {
    resultKey: 'disabledWarmTabPreload',
    description: 'disabled warm tab preload',
    filePath: 'main.js',
    search: 'preloadWarmTab(){if(this.warmTab||this.isPreloadingWarmTab)return;',
    replacementPrefix: 'preloadWarmTab(){return;',
  },
  {
    resultKey: 'disabledAutoUpdaterInit',
    description: 'disabled Electron auto-updater init',
    filePath: 'main.js',
    search:
      'init(t,a){if(this._initialized)return void E.warn("Trying to initialize the AutoUpdater the second time");this._initialized=!0,this.autoUpdater.logger=E,',
    replacementPrefix:
      'init(t,a){if(this._initialized)return void E.warn("Trying to initialize the AutoUpdater the second time");this._initialized=!0;return;',
  },
  {
    resultKey: 'neutralizedAutoUpdaterNetwork',
    description: 'neutralized Electron auto-updater network request',
    filePath: 'main.js',
    search: 'this.autoUpdater.checkForUpdates()',
    replacementPrefix: 'Promise.resolve({})',
  },
  {
    resultKey: 'toleratedMissingPendingUpdate',
    description: 'treated missing pending update state as normal',
    filePath: 'main.js',
    search: 'if((0,i.isNullish)(t))throw Error("no pending update");',
    replacementPrefix: 'if((0,i.isNullish)(t))return{};',
  },
  {
    resultKey: 'normalizedFlacMimeType',
    description: 'normalized FLAC MIME type for Chromium media playback',
    filePattern: /\.(?:js|json|html)$/i,
    search: 'audio/x-flac',
    replacementPrefix: 'audio/flac  ',
    replaceAll: true,
  },
  {
    resultKey: 'normalizedResourceProxyFlacMimeType',
    description: 'normalized FLAC MIME type from resource proxy response headers',
    filePath: 'node_modules/en-conduit-electron/dist/MainResourceProxy.js',
    search: `function extractMetadataFromHeaders(headers) {
    var _a, _b, _c, _d;
    // Ref https://nodejs.org/api/http.html#http_message_headers certain headers are type \`string[]\` while others are \`string\`
    const mime = ((_a = headers['content-type']) !== null && _a !== void 0 ? _a : '');
    const rawExpires = Date.parse(((_b = headers.expires) !== null && _b !== void 0 ? _b : ''));
    const expires = Number.isNaN(rawExpires) ? 0 : rawExpires;
    const rawDate = Date.parse(((_c = headers.date) !== null && _c !== void 0 ? _c : ''));
    const date = Number.isNaN(rawDate) ? 0 : rawDate;
    const etag = ((_d = headers.etag) !== null && _d !== void 0 ? _d : '');
    return { mime, expires, etag, ttl: expires > 0 && date > 0 ? expires - date : 0, isValid: true };
}
`,
    replacementPrefix: `function extractMetadataFromHeaders(headers) {
    const headerMime = headers["content-type"] ?? "";
    const mime = String(Array.isArray(headerMime) ? headerMime[0] ?? "" : headerMime).replace(/^audio\\/x-flac\\b/i, "audio/flac");
    const rawExpires = Date.parse(headers.expires ?? "");
    const expires = Number.isNaN(rawExpires) ? 0 : rawExpires;
    const rawDate = Date.parse(headers.date ?? "");
    const date = Number.isNaN(rawDate) ? 0 : rawDate;
    const etag = String(headers.etag ?? "");
    return { mime, expires, etag, ttl: expires > 0 && date > 0 ? expires - date : 0, isValid: true };
}
`,
  },
  {
    resultKey: 'normalizedCachedResourceFlacMimeType',
    description: 'normalized cached FLAC MIME type when serving local resources',
    filePath: 'node_modules/en-conduit-electron/dist/MainResourceProxy.js',
    search: `function handleResourceRequest(request, callback) {
    getResource(request.url)
        .then(resource => {
        callback({
            statusCode: 200,
            headers: {
                'Content-Type': resource.meta.mime,
            },
            data: resource.stream,
        });
    })
        .catch(err => {
        var _a, _b;
        conduit_utils_1.logger.warn('ResourceProxy request failure', { url: request.url, err });
        const data = new stream_1.Readable();
        data._read = () => undefined;
        data.push((_b = (_a = err.stack) !== null && _a !== void 0 ? _a : err.message) !== null && _b !== void 0 ? _b : (0, conduit_utils_1.safeStringify)(err));
        data.push(null);
        callback({
            statusCode: typeof err === 'number' ? err : 500,
            headers: {},
            data,
        });
    });
}
`,
    replacementPrefix: `function normalizeFlacMime(t){return String(t??"").replace(/^audio\\/x-flac\\b/i,"audio/flac")}
function handleResourceRequest(request,callback){getResource(request.url).then(resource=>{callback({statusCode:200,headers:{"Content-Type":normalizeFlacMime(resource.meta.mime)},data:resource.stream})}).catch(err=>{var _a,_b;conduit_utils_1.logger.warn("ResourceProxy request failure",{url:request.url,err});const data=new stream_1.Readable;data._read=()=>undefined;data.push((_b=(_a=err.stack)!==null&&_a!==void 0?_a:err.message)!==null&&_b!==void 0?_b:(0,conduit_utils_1.safeStringify)(err));data.push(null);callback({statusCode:typeof err==="number"?err:500,headers:{},data})})}
`,
  },
  {
    resultKey: 'normalizedAudioPlayerFlacMimeType',
    description: 'normalized FLAC MIME type before renderer audio playback',
    filePath: '172.js',
    search: `class o{audio;constructor(){this.audio=new Audio}canPlayType(e){return this.audio.canPlayType(i(e))}async load(e,t){const{audio:n}=this;function o(e){const o=document.createElement("source");return o.src=e,t&&(o.type=i(t)),new Promise((e=>{n.removeAttribute("src"),n.append(o),n.onloadedmetadata=()=>{n.duration===1/0||a.vU?(n.currentTime=Number.MAX_VALUE,n.ontimeupdate=()=>{n.onseeked=()=>{n.currentTime=.001,n.ontimeupdate=null,n.onseeked=null,e()}}):e()},n.load()}))}if("blob:"===new URL(e).protocol)return o(e);try{const t=await fetch(e,{credentials:"include"}),n=await t.blob(),a=URL.createObjectURL(n);return await o(a)}catch{return await o(e)}}play(){return this.audio.play()}pause(){return this.audio.pause()}stop(){const{audio:e}=this;for(;e.firstChild;){const{src:t}=e.firstChild;t&&t.startsWith("blob:")&&URL.revokeObjectURL(t),e.firstChild.remove()}e.src="",e.pause()}get duration(){return this.audio.duration}get paused(){return this.audio.paused}get currentTime(){return this.audio.currentTime}set currentTime(e){this.audio.currentTime=e}set onerror(e){this.audio.onerror=e}get error(){return this.audio.error}}const r={"audio/m4a":"audio/mp4","video/quicktime":"video/mp4"};function i(e){return r[e]||e}`,
    replacementPrefix: `class o{constructor(){this.audio=new Audio}canPlayType(e){return this.audio.canPlayType(i(e))}async load(e,t){let n=this.audio,o=async e=>new Promise(r=>{let o=document.createElement("source");o.src=e,t&&(o.type=i(t)),n.removeAttribute("src"),n.append(o),n.onerror=r,n.onloadedmetadata=()=>{n.duration===1/0||a.vU?(n.currentTime=1/0,n.ontimeupdate=()=>{n.onseeked=()=>{n.currentTime=.001,n.ontimeupdate=n.onseeked=null,r()}}):r()},n.load()});if("blob:"===new URL(e).protocol)return o(e);try{let t=await fetch(e,{credentials:"include"}),n=URL.createObjectURL(await t.blob());return await o(n)}catch{return o(e)}}play(){return this.audio.play()}pause(){return this.audio.pause()}stop(){let e=this.audio;for(;e.firstChild;){let t=e.firstChild.src;t&&t.startsWith("blob:")&&URL.revokeObjectURL(t),e.firstChild.remove()}e.src="",e.pause()}get duration(){return this.audio.duration}get paused(){return this.audio.paused}get currentTime(){return this.audio.currentTime}set currentTime(e){this.audio.currentTime=e}set onerror(e){this.audio.onerror=e}get error(){return this.audio.error}}const r={"audio/m4a":"audio/mp4","video/quicktime":"video/mp4"};function i(e){return /^audio\\/x-flac\\b/i.test(e)?"audio/flac":r[e]||e}`,
  },
  {
    resultKey: 'disabledAiCopilotComposerDisclaimer',
    description: 'disabled AI Assistant composer disclaimer',
    filePath: '172.js',
    search: 'disclaimer:{text:Ut()}',
    replacementPrefix: 'disclaimer:void 0',
  },
  {
    resultKey: 'blackBrowserWindowBackground',
    description: 'forced Electron window startup background to black',
    filePath: 'main.js',
    search: 'backgroundColor:"transparent",backgroundMaterial:"none",vibrancy:"fullscreen-ui"',
    replacementPrefix:
      'backgroundColor:"#000000"    ,backgroundMaterial:"none",vibrancy:"fullscreen-ui"',
  },
  {
    resultKey: 'blackAppBackgroundThemeVariables',
    description: 'forced app chrome background theme tokens to black',
    filePattern: BLACK_APP_BACKGROUND_FILE_PATTERN,
    pattern: BLACK_APP_BACKGROUND_VARIABLE_PATTERN,
    replacementForMatch: (match) => replaceCssDeclarationValueWithBoundary(match, '#000'),
    alreadyPatchedPattern: BLACK_APP_BACKGROUND_ALREADY_PATCHED_PATTERN,
    textRangeForPattern: webpackCssRuntimeStringRange,
    replacePattern: true,
  },
  {
    resultKey: 'blackEditorBackgroundThemeVariables',
    description: 'forced note/editor background theme tokens to black',
    filePattern: BLACK_EDITOR_BACKGROUND_FILE_PATTERN,
    pattern: BLACK_EDITOR_BACKGROUND_VARIABLE_PATTERN,
    replacementForMatch: (match) => replaceCssDeclarationValueWithBoundary(match, '#000'),
    alreadyPatchedPattern: BLACK_EDITOR_BACKGROUND_ALREADY_PATCHED_PATTERN,
    replacePattern: true,
  },
  {
    resultKey: 'blackEditorDarkBackgrounds',
    description: 'forced hardcoded dark note/editor backgrounds to black',
    filePattern: BLACK_EDITOR_BACKGROUND_FILE_PATTERN,
    pattern: BLACK_EDITOR_HARDCODED_BACKGROUND_PATTERN,
    replacementForMatch: (match) => {
      const prefix = match.slice(0, match.indexOf(':') + 1);
      return `${prefix}#000${' '.repeat(match.length - prefix.length - 4)}`;
    },
    alreadyPatchedPattern: BLACK_EDITOR_HARDCODED_ALREADY_PATCHED_PATTERN,
    replacePattern: true,
  },
  {
    resultKey: 'brighterEditorTextSelection',
    description: 'brightened note editor text selection overlays',
    filePattern: EDITOR_SELECTION_BACKGROUND_FILE_PATTERN,
    pattern: EDITOR_SELECTION_BACKGROUND_PATTERN,
    replacementForMatch: (match) => sameLengthReplacement(match, 'rgba(33,133,231,.4)'),
    alreadyPatchedPattern: EDITOR_SELECTION_BACKGROUND_ALREADY_PATCHED_PATTERN,
    replacePattern: true,
  },
  {
    resultKey: 'compactEditorHorizontalPadding',
    description: 'reduced note editor horizontal padding',
    filePattern: EDITOR_HORIZONTAL_PADDING_FILE_PATTERN,
    pattern: EDITOR_HORIZONTAL_PADDING_PATTERN,
    replacementForMatch: (match) =>
      match
        .replace(/padding-left:(?:48px|8px\s)/, 'padding-left:0px ')
        .replace(/padding-right:(?:48px|8px\s)/, 'padding-right:0px '),
    alreadyPatchedPattern: EDITOR_HORIZONTAL_PADDING_ALREADY_PATCHED_PATTERN,
    replacePattern: true,
  },
  {
    resultKey: 'leftAlignedEditorNoteLayout',
    description: 'left-aligned note editor layout with no side margin',
    filePattern: EDITOR_NOTE_LAYOUT_FILE_PATTERN,
    pattern: EDITOR_NOTE_LAYOUT_MARGIN_PATTERN,
    replacementForMatch: (match) =>
      match.includes('E=56,_="center"')
        ? 'h=840,f=24,g=124,y=0,v=41,b=0 ,E=0 ,_="left",T=!1  ,A=40'
        : 'h=840,f=24,g=124,y=0,v=41,b=0 ,_=0 ,E="left",T=!1  ,A=40',
    alreadyPatchedPattern: EDITOR_NOTE_LAYOUT_MARGIN_ALREADY_PATCHED_PATTERN,
    replacePattern: true,
  },
  {
    resultKey: 'visibleTagSuggestionHover',
    description: 'made tag suggestion hover background visible on black theme',
    filePattern: /\.js$/,
    search: TAG_SUGGESTION_HOVER_STYLES,
    replacementPrefix: TAG_SUGGESTION_HOVER_REPLACEMENT,
    replaceAll: true,
  },
  {
    resultKey: 'visibleDropdownItemHover',
    description: 'made dropdown menu item hover background visible on black theme',
    filePattern: /^1957\.js$/,
    pattern: DROPDOWN_ITEM_HOVER_PATTERN,
    replacementForMatch: (match) =>
      sameLengthReplacement(
        match,
        match.replace(
          'background-color:var(--color-surface-fill-primary-hover)',
          'background-color:#1f1f1f',
        ),
      ),
    alreadyPatchedPattern: DROPDOWN_ITEM_HOVER_ALREADY_PATCHED_PATTERN,
    replacePattern: true,
  },
  {
    resultKey: 'expandedSourceUrlPillContainerWidth',
    description: 'removed source URL chip container width limit',
    filePattern: SOURCE_URL_PILL_WIDTH_FILE_PATTERN,
    pattern: SOURCE_URL_PILL_CONTAINER_MAX_WIDTH_PATTERN,
    replacementForMatch: (match) =>
      sameLengthReplacement(
        match,
        match
          .replace('max-width:375px', 'max-width:none ')
          .replace('max-width:165px', 'max-width:none '),
      ),
    alreadyPatchedPattern: SOURCE_URL_PILL_CONTAINER_MAX_WIDTH_ALREADY_PATCHED_PATTERN,
    replacePattern: true,
  },
  {
    resultKey: 'expandedSourceUrlTextWidth',
    description: 'removed source URL text width limit',
    filePattern: SOURCE_URL_PILL_WIDTH_FILE_PATTERN,
    pattern: SOURCE_URL_PILL_TEXT_MAX_WIDTH_PATTERN,
    replacementForMatch: (match) =>
      sameLengthReplacement(
        match,
        match
          .replace('max-width:187.5px', 'max-width:none   ')
          .replace('max-width:106.5px', 'max-width:none   '),
      ),
    alreadyPatchedPattern: SOURCE_URL_PILL_TEXT_MAX_WIDTH_ALREADY_PATCHED_PATTERN,
    replacePattern: true,
  },
  {
    resultKey: 'visibleMultiSelectFloatingMenu',
    description: 'made multi-select floating menu visible on black theme',
    filePath: '8634.js',
    search: MULTI_SELECT_FLOATING_MENU_STYLES,
    replacementPrefix: MULTI_SELECT_FLOATING_MENU_REPLACEMENT,
  },
  {
    resultKey: 'hiddenNoteDetailFrameLine',
    description: 'hid note detail frame line between notes list and editor',
    filePath: '8078.js',
    search: NOTE_DETAIL_FRAME_SHADOW_STYLES,
    replacementPrefix: NOTE_DETAIL_FRAME_SHADOW_REPLACEMENT,
  },
  {
    resultKey: 'nativeImageResourceClipboard',
    description:
      'copied image resources as native image clipboard data because image copy does not work on Linux without it',
    filePath: 'main.js',
    search: NATIVE_IMAGE_RESOURCE_CLIPBOARD_STYLES,
    replacementPrefix: NATIVE_IMAGE_RESOURCE_CLIPBOARD_REPLACEMENT,
  },
  {
    resultKey: 'emphasizedActiveTabTitle',
    description: 'made active tab title white and bold',
    filePath: 'boronTabShell.js',
    search: ACTIVE_TAB_INNER_STYLES,
    replacementPrefix: ACTIVE_TAB_INNER_REPLACEMENT,
  },
  {
    resultKey: 'fullHeightTabButtons',
    description: 'extended tab buttons to top edge of tab shell',
    filePath: 'boronTabShell.js',
    search: TAB_BUTTON_HEIGHT_STYLES,
    replacementPrefix: TAB_BUTTON_HEIGHT_REPLACEMENT,
  },
  {
    resultKey: 'minimizedCollapsedNavWidth',
    description: 'used minimum icon rail width for collapsed sidebar',
    filePath: '8634.js',
    search: 'Q=Ia.V0,X=Math.max(Math.min(Ia.af,q),Q)',
    replacementPrefix: 'Q=Ia.WB,X=Math.max(Math.min(Ia.af,q),Q)',
  },
  {
    resultKey: 'expandedCollapsedNavPaddingToken',
    description:
      'increased collapsed sidebar icon rail vertical padding token and removed horizontal padding',
    filePath: '2002.js',
    search: COLLAPSED_NAV_PADDING_TOKEN_STYLES,
    replacementPrefix: COLLAPSED_NAV_PADDING_TOKEN_REPLACEMENT,
  },
  {
    resultKey: 'expandedCollapsedNavItemPadding',
    description:
      'increased collapsed sidebar icon rail item vertical padding and removed horizontal padding',
    filePath: '2002.js',
    search: COLLAPSED_NAV_ITEM_PADDING_STYLES,
    replacementPrefix: COLLAPSED_NAV_ITEM_PADDING_REPLACEMENT,
  },
  {
    resultKey: 'thinnedCollapsedNavCssWidth',
    description: 'halved collapsed sidebar CSS rail width token',
    filePath: '2002.js',
    search: '--nav-collapsed-width:60px;',
    replacementPrefix: '--nav-collapsed-width:30px;',
  },
  {
    resultKey: 'thinnedCollapsedNavContainerWidth',
    description: 'halved collapsed sidebar active container width',
    filePath: '2002.js',
    search: 'width:60px;transition:width .2s ease-in-out',
    replacementPrefix: 'width:30px;transition:width .2s ease-in-out',
  },
  {
    resultKey: 'thinnedCollapsedNavWidthConstant',
    description: 'halved collapsed sidebar runtime rail width',
    filePath: '8453.js',
    search: 'd=60,c=96',
    replacementPrefix: 'd=30,c=96',
  },
  {
    resultKey: 'removedNoteSnippetSeparators',
    description: 'removed note snippet list separator lines',
    filePath: '3014.js',
    search: '--noteSnippet-border-bottom:1px solid var(--color-snippet-base-stroke-enabled);',
    replacementPrefix: '--noteSnippet-border-bottom:0px solid transparent;',
  },
  {
    resultKey: 'disabledInAppForceUpdateInit',
    description: 'disabled in-app force-update init',
    filePath: 'main.js',
    search:
      'init(t=m.InAppForceUpdateChannel.public){if(this._initialized)return void f.info("Trying to init multiple times");this._initialized=!0;let{feedbackLevel:a}=this;',
    replacementPrefix:
      'init(t=m.InAppForceUpdateChannel.public){if(this._initialized)return void f.info("Trying to init multiple times");this._initialized=!0;return;',
  },
  {
    resultKey: 'disabledInAppForceUpdateChecks',
    description: 'disabled in-app force-update checks',
    filePath: 'main.js',
    search:
      'async getRemoteUpdatedList(){let t=this.remoteCheckUrl;if(!t)throw Error("Empty url");let a="UNKNOWN",n="UNKNOWN";',
    replacementPrefix:
      'async getRemoteUpdatedList(){return{feedbackLevel:m.InAppForceUpdateFeedbackLevel.none};let t=this.remoteCheckUrl;',
  },
  {
    resultKey: 'quitOnMainWindowClose',
    description: 'quit app when the main window is closed',
    filePath: 'main.js',
    search: 'this.hidden=!0,this.window.hide()}}),this.window.on("show"',
    replacementPrefix: 'h.app.quit(),0}}),this.window.on("show"',
  },
  {
    resultKey: 'suppressTabStatePublishAfterDestroy',
    description: 'suppress tab state publish after tab webContents destruction',
    filePath: 'main.js',
    search:
      'this.tabs.has(t)&&(this.tabs.delete(t),this.activeTabId===t&&(this.onActiveWebContentsChange?.(null,null),this.activeTabId=null),this.publishState())',
    replacementPrefix:
      'this.tabs.has(t)&&(this.tabs.delete(t),this.activeTabId===t&&(this.onActiveWebContentsChange?.(null,null),this.activeTabId=null))',
  },
];

function patchEvernoteBundle(asarPath) {
  const resolvedAsarPath = path.resolve(asarPath);
  const result = {
    asarPath: resolvedAsarPath,
  };

  for (const patch of patches) {
    if (patch.replacePattern) {
      result[patch.resultKey] = replacePatternInAsarEntries(
        resolvedAsarPath,
        patch.filePattern,
        patch.pattern,
        patch.replacementForMatch,
        patch.alreadyPatchedPattern,
        patch.textRangeForPattern,
      );
    } else if (patch.replaceAll) {
      result[patch.resultKey] = replaceAllInAsarEntries(
        resolvedAsarPath,
        patch.filePattern,
        patch.search,
        sameLengthReplacement(patch.search, patch.replacementPrefix),
      );
    } else {
      result[patch.resultKey] = replaceInAsarEntry(
        resolvedAsarPath,
        patch.filePath,
        patch.search,
        sameLengthReplacement(patch.search, patch.replacementPrefix),
      );
    }
  }

  return result;
}

if (require.main === module) {
  const asarPath = process.argv[2];
  if (!asarPath) {
    console.error('Usage: node scripts/patch-evernote-bundle.js <app.asar>');
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
