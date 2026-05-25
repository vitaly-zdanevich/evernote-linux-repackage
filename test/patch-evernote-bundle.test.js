"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { patches, patchEvernoteBundle } = require("../scripts/patch-evernote-bundle");

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "evernote-asar-test-"));
}

function writeMinimalAsar(asarPath, files) {
  let offset = 0;
  const header = { files: {} };
  const contents = [];

  function setHeaderEntry(fileName, entry) {
    const parts = fileName.split("/");
    let current = header;
    for (const part of parts.slice(0, -1)) {
      current.files[part] ||= { files: {} };
      current = current.files[part];
    }
    current.files[parts[parts.length - 1]] = entry;
  }

  for (const [name, content] of Object.entries(files)) {
    const contentBuffer = Buffer.from(content);
    setHeaderEntry(name, {
      size: contentBuffer.length,
      offset: String(offset),
    });
    contents.push(contentBuffer);
    offset += contentBuffer.length;
  }

  const headerBuffer = Buffer.from(JSON.stringify(header));
  const headerSize = 8 + headerBuffer.length;
  const asarBuffer = Buffer.alloc(16 + headerBuffer.length + offset);

  asarBuffer.writeUInt32LE(4, 0);
  asarBuffer.writeUInt32LE(headerSize, 4);
  asarBuffer.writeUInt32LE(headerBuffer.length, 8);
  asarBuffer.writeUInt32LE(headerBuffer.length, 12);
  headerBuffer.copy(asarBuffer, 16);

  let contentOffset = 8 + headerSize;
  for (const contentBuffer of contents) {
    contentBuffer.copy(asarBuffer, contentOffset);
    contentOffset += contentBuffer.length;
  }

  fs.writeFileSync(asarPath, asarBuffer);
}

function readMinimalAsarEntry(asarPath, fileName) {
  const buffer = fs.readFileSync(asarPath);
  const headerSize = buffer.readUInt32LE(4);
  const jsonSize = buffer.readUInt32LE(12);
  const header = JSON.parse(buffer.subarray(16, 16 + jsonSize).toString());
  let entry = header;
  for (const part of fileName.split("/")) {
    entry = entry.files && entry.files[part];
  }
  assert.ok(entry, `Missing ASAR test entry: ${fileName}`);
  const start = 8 + headerSize + Number(entry.offset);
  return buffer.subarray(start, start + Number(entry.size)).toString();
}

function makePatchableMainJs() {
  return [
    "const E={warn(){}};",
    'const f={info(){}};',
    'const m={InAppForceUpdateChannel:{public:"public"},InAppForceUpdateFeedbackLevel:{none:"none"}};',
    "class MainWindowTabManager {",
    "preloadWarmTab(){if(this.warmTab||this.isPreloadingWarmTab)return;this.isPreloadingWarmTab=!0;}",
    "}",
    "class S {",
    'init(t,a){if(this._initialized)return void E.warn("Trying to initialize the AutoUpdater the second time");this._initialized=!0,this.autoUpdater.logger=E,this.autoUpdater.autoDownload=!1}',
    "async _checkForUpdates(){try{let t=this._promiseCheckForUpdates;if(!t){let a=()=>{this._promiseCheckForUpdates=void 0};t=this.autoUpdater.checkForUpdates().then(()=>({updateAvailable:true}))}return t}catch(t){return {}}}",
    "}",
    'function pendingUpdatePatch(){let t=null;if((0,i.isNullish)(t))throw Error("no pending update");return t}',
    'const flacMime="audio/x-flac";',
    "class T {",
    'init(t=m.InAppForceUpdateChannel.public){if(this._initialized)return void f.info("Trying to init multiple times");this._initialized=!0;let{feedbackLevel:a}=this;this.currentChannel=t}',
    'async getRemoteUpdatedList(){let t=this.remoteCheckUrl;if(!t)throw Error("Empty url");let a="UNKNOWN",n="UNKNOWN";return {url:t,platform:a,release:n}}',
    "}",
    "const h={app:{quit(){}}};",
    "function mainWindowClosePatch(){this.window.on(\"close\",async t=>{if(true){this.hidden=!0,this.window.hide()}}),this.window.on(\"show\",()=>{})}",
    "function tabDestroyedPatch(t){this.tabs.has(t)&&(this.tabs.delete(t),this.activeTabId===t&&(this.onActiveWebContentsChange?.(null,null),this.activeTabId=null),this.publishState())}",
  ].join("");
}

function makePatchableMainResourceProxyJs() {
  return `function handleResourceRequest(request, callback) {
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
function extractMetadataFromHeaders(headers) {
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
`;
}

function makePatchableAudioPlayerChunkJs() {
  return `class o{audio;constructor(){this.audio=new Audio}canPlayType(e){return this.audio.canPlayType(i(e))}async load(e,t){const{audio:n}=this;function o(e){const o=document.createElement("source");return o.src=e,t&&(o.type=i(t)),new Promise((e=>{n.removeAttribute("src"),n.append(o),n.onloadedmetadata=()=>{n.duration===1/0||a.vU?(n.currentTime=Number.MAX_VALUE,n.ontimeupdate=()=>{n.onseeked=()=>{n.currentTime=.001,n.ontimeupdate=null,n.onseeked=null,e()}}):e()},n.load()}))}if("blob:"===new URL(e).protocol)return o(e);try{const t=await fetch(e,{credentials:"include"}),n=await t.blob(),a=URL.createObjectURL(n);return await o(a)}catch{return await o(e)}}play(){return this.audio.play()}pause(){return this.audio.pause()}stop(){const{audio:e}=this;for(;e.firstChild;){const{src:t}=e.firstChild;t&&t.startsWith("blob:")&&URL.revokeObjectURL(t),e.firstChild.remove()}e.src="",e.pause()}get duration(){return this.audio.duration}get paused(){return this.audio.paused}get currentTime(){return this.audio.currentTime}set currentTime(e){this.audio.currentTime=e}set onerror(e){this.audio.onerror=e}get error(){return this.audio.error}}const r={"audio/m4a":"audio/mp4","video/quicktime":"video/mp4"};function i(e){return r[e]||e}`;
}

test("patchEvernoteBundle applies Linux port patches in-place", () => {
  const tempDir = makeTempDir();
  try {
    const asarPath = path.join(tempDir, "app.asar");
    const mainJs = makePatchableMainJs();

    writeMinimalAsar(asarPath, {
      "main.js": mainJs,
      "172.js": makePatchableAudioPlayerChunkJs(),
      "node_modules/en-conduit-electron/dist/MainResourceProxy.js":
        makePatchableMainResourceProxyJs(),
    });

    const firstPatch = patchEvernoteBundle(asarPath);
    for (const patch of patches) {
      assert.equal(firstPatch[patch.resultKey], true, patch.resultKey);
    }

    const patchedMainJs = readMinimalAsarEntry(asarPath, "main.js");
    const patchedMainResourceProxyJs = readMinimalAsarEntry(
      asarPath,
      "node_modules/en-conduit-electron/dist/MainResourceProxy.js",
    );
    assert.match(patchedMainJs, /preloadWarmTab\(\)\{return;\s+this\.isPreloadingWarmTab=!0/);
    assert.match(
      patchedMainJs,
      /Trying to initialize the AutoUpdater the second time"\);this\._initialized=!0;return;\s+this\.autoUpdater\.autoDownload/,
    );
    assert.match(
      patchedMainJs,
      /Promise\.resolve\(\{\}\)\s+\.then\(\(\)=>\(\{updateAvailable:true\}\)\)/,
    );
    assert.match(
      patchedMainJs,
      /if\(\(0,i\.isNullish\)\(t\)\)return\{\};\s+return t/,
    );
    assert.match(patchedMainJs, /const flacMime="audio\/flac\s\s";/);
    assert.match(
      patchedMainJs,
      /Trying to init multiple times"\);this\._initialized=!0;return;\s+this\.currentChannel=t/,
    );
    assert.match(
      patchedMainJs,
      /async getRemoteUpdatedList\(\)\{return\{feedbackLevel:m\.InAppForceUpdateFeedbackLevel\.none\};let t=this\.remoteCheckUrl;/,
    );
    assert.match(
      patchedMainJs,
      /h\.app\.quit\(\),0\}\}\),this\.window\.on\("show"/,
    );
    assert.match(
      patchedMainJs,
      /this\.tabs\.has\(t\)&&\(this\.tabs\.delete\(t\),this\.activeTabId===t&&\(this\.onActiveWebContentsChange\?\.\(null,null\),this\.activeTabId=null\)\)/,
    );
    assert.doesNotMatch(
      patchedMainJs,
      /if\(this\.warmTab\|\|this\.isPreloadingWarmTab\)return/,
    );
    assert.doesNotMatch(patchedMainJs, /this\.hidden=!0,this\.window\.hide\(\)\}\}\),this\.window\.on\("show"/);
    assert.doesNotMatch(patchedMainJs, /this\.activeTabId=null\),this\.publishState\(\)\)/);
    assert.doesNotMatch(patchedMainJs, /audio\/x-flac/);
    assert.doesNotThrow(() => new Function(patchedMainJs));
    assert.ok(
      patchedMainResourceProxyJs.includes(
        String.raw`.replace(/^audio\/x-flac\b/i, "audio/flac")`,
      ),
    );
    assert.match(patchedMainResourceProxyJs, /function normalizeFlacMime/);
    assert.match(
      patchedMainResourceProxyJs,
      /"Content-Type":normalizeFlacMime\(resource\.meta\.mime\)/,
    );
    const patchedAudioPlayerChunkJs = readMinimalAsarEntry(asarPath, "172.js");
    assert.match(
      patchedAudioPlayerChunkJs,
      /\/\^audio\\\/x-flac\\b\/i\.test\(e\)\?"audio\/flac":r\[e\]\|\|e/,
    );
    assert.match(patchedAudioPlayerChunkJs, /n\.onerror=r/);
    assert.doesNotMatch(patchedAudioPlayerChunkJs, /return r\[e\]\|\|e/);
    assert.doesNotMatch(patchedMainResourceProxyJs, /headers\['content-type'\]\) !== null/);
    assert.doesNotMatch(patchedMainResourceProxyJs, /'Content-Type': resource\.meta\.mime/);
    assert.doesNotThrow(() => new Function(patchedMainResourceProxyJs));
    assert.doesNotThrow(() => new Function(patchedAudioPlayerChunkJs));

    const secondPatch = patchEvernoteBundle(asarPath);
    for (const patch of patches) {
      assert.equal(secondPatch[patch.resultKey], false, patch.resultKey);
    }
    assert.equal(readMinimalAsarEntry(asarPath, "main.js"), patchedMainJs);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("patchEvernoteBundle fails when expected bundle code is absent", () => {
  const tempDir = makeTempDir();
  try {
    const asarPath = path.join(tempDir, "app.asar");
    writeMinimalAsar(asarPath, {
      "main.js": "class MainWindowTabManager { preloadWarmTab(){return this.warmTab;} }",
    });

    assert.throws(
      () => patchEvernoteBundle(asarPath),
      /Patch target not found in main\.js/,
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
