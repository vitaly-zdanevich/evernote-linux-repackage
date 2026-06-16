const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { patches, patchEvernoteBundle } = require('../scripts/patch-evernote-bundle');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'evernote-asar-test-'));
}

function writeMinimalAsar(asarPath, files) {
  let offset = 0;
  const header = { files: {} };
  const contents = [];

  function setHeaderEntry(fileName, entry) {
    const parts = fileName.split('/');
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
  for (const part of fileName.split('/')) {
    entry = entry.files && entry.files[part];
  }
  assert.ok(entry, `Missing ASAR test entry: ${fileName}`);
  const start = 8 + headerSize + Number(entry.offset);
  return buffer.subarray(start, start + Number(entry.size)).toString();
}

function makePatchableMainJs() {
  return [
    'const E={warn(){}};',
    'const f={info(){}};',
    'const m={InAppForceUpdateChannel:{public:"public"},InAppForceUpdateFeedbackLevel:{none:"none"}};',
    'class MainWindowTabManager {',
    'preloadWarmTab(){if(this.warmTab||this.isPreloadingWarmTab)return;this.isPreloadingWarmTab=!0;}',
    '}',
    'class AutoUpdaterPatch {',
    'init(t,a){if(this._initialized)return void E.warn("Trying to initialize the AutoUpdater the second time");this._initialized=!0,this.autoUpdater.logger=E,this.autoUpdater.autoDownload=!1}',
    'async _checkForUpdates(){try{let t=this._promiseCheckForUpdates;if(!t){let a=()=>{this._promiseCheckForUpdates=void 0};t=this.autoUpdater.checkForUpdates().then(()=>({updateAvailable:true}))}return t}catch(t){return {}}}',
    '}',
    'function pendingUpdatePatch(){let t=null;if((0,i.isNullish)(t))throw Error("no pending update");return t}',
    'const flacMime="audio/x-flac";',
    'class T {',
    'init(t=m.InAppForceUpdateChannel.public){if(this._initialized)return void f.info("Trying to init multiple times");this._initialized=!0;let{feedbackLevel:a}=this;this.currentChannel=t}',
    'async getRemoteUpdatedList(){let t=this.remoteCheckUrl;if(!t)throw Error("Empty url");let a="UNKNOWN",n="UNKNOWN";return {url:t,platform:a,release:n}}',
    '}',
    'const h={app:{quit(){}}};',
    'function baseWindowOpts(t){return new BrowserWindow({webPreferences:{...t},backgroundColor:"transparent",backgroundMaterial:"none",vibrancy:"fullscreen-ui",frame:true})}',
    'let S=async(t,a)=>{let n=await A(a);await (0,s.sleep)(100);try{t?.startDrag({file:"",files:n,icon:l.nativeImage.createFromDataURL(p.default)})}catch(t){b.error("setNativeFilesForDrag error",t.message)}},N=async t=>{let a=await A(t);o?.writeFilePaths(a)},M=t=>{l.clipboard.write({text:t,html:t})};function w(){return{plain:l.clipboard.readText(),html:l.clipboard.readHTML()}}',
    'const I=/(^|[\\/\\\\])\\./,i={default:{isMac:false,isWin:false}},R={ignored:[t=>L(t),I],depth:0,ignoreInitial:!1,followSymlinks:!1};async function U(t){return false}async function B(t){return false}async function shouldImportFolderFile(t){let n=!1;return i.default.isMac?n=await U(t):i.default.isWin&&(n=await B(t)),n}',
    'function mainWindowClosePatch(){this.window.on("close",async t=>{if(true){this.hidden=!0,this.window.hide()}}),this.window.on("show",()=>{})}',
    'function tabDestroyedPatch(t){this.tabs.has(t)&&(this.tabs.delete(t),this.activeTabId===t&&(this.onActiveWebContentsChange?.(null,null),this.activeTabId=null),this.publishState())}',
  ].join('');
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
  return `class o{audio;constructor(){this.audio=new Audio}canPlayType(e){return this.audio.canPlayType(i(e))}async load(e,t){const{audio:n}=this;function o(e){const o=document.createElement("source");return o.src=e,t&&(o.type=i(t)),new Promise((e=>{n.removeAttribute("src"),n.append(o),n.onloadedmetadata=()=>{n.duration===1/0||a.vU?(n.currentTime=Number.MAX_VALUE,n.ontimeupdate=()=>{n.onseeked=()=>{n.currentTime=.001,n.ontimeupdate=null,n.onseeked=null,e()}}):e()},n.load()}))}if("blob:"===new URL(e).protocol)return o(e);try{const t=await fetch(e,{credentials:"include"}),n=await t.blob(),a=URL.createObjectURL(n);return await o(a)}catch{return await o(e)}}play(){return this.audio.play()}pause(){return this.audio.pause()}stop(){const{audio:e}=this;for(;e.firstChild;){const{src:t}=e.firstChild;t&&t.startsWith("blob:")&&URL.revokeObjectURL(t),e.firstChild.remove()}e.src="",e.pause()}get duration(){return this.audio.duration}get paused(){return this.audio.paused}get currentTime(){return this.audio.currentTime}set currentTime(e){this.audio.currentTime=e}set onerror(e){this.audio.onerror=e}get error(){return this.audio.error}}const r={"audio/m4a":"audio/mp4","video/quicktime":"video/mp4"};function i(e){return r[e]||e};function Kt(){return"Evernote AI Assistant can make mistakes."}const R={api:{},disclaimer:{text:Kt()},initialThread:null};`;
}

function makePatchableAppThemeChunkJs() {
  const runtimeCss = [
    ':root,[data-color-theme=light]{',
    '--color-background-base-fill-primary:var(--colors-grey-100);',
    '--color-background-base-fill-secondary:var(--colors-grey-99);',
    '--color-surface-fill-primary-enabled:var(--colors-grey-100);',
    '--color-card-base-fill-enabled:var(--colors-grey-100);',
    '--color-button-base-fill-primary-default:var(--colors-secondary-blue-400);',
    '--color-button-content-fill-primary-default:var(--colors-grey-100);',
    '--color-note_list-base-stroke-enabled:var(--colors-grey-90);',
    '--color-text-fill-primary-enabled:var(--colors-grey-8);',
    '--home-widget-pp-background-z-index:-1;',
    '}[data-color-theme=dark]{',
    '--color-background-base-fill-primary:var(--colors-grey-8);',
    '--color-surface-fill-primary-enabled:var(--colors-grey-8);',
    '--color-iconbutton-base-fill-primary-hover:var(--colors-grey-opacitywhite08);',
    '--color-button-content-fill-primary-default:var(--colors-grey-8);',
    '--color-text-fill-primary-enabled:var(--colors-grey-100);',
    '}',
  ].join('');
  const sourceContent = [
    '.source-theme{',
    '--color-calendar_block-highlight-fill-task-enabled:var(--colors-secondary-purple-300);',
    '}',
  ].join('');

  return [
    '(()=>{',
    'const A={push(){},locals:{}};',
    'const o={id:7839};',
    `A.push([o.id,${JSON.stringify(runtimeCss)},"",{version:3,sources:["webpack://theme.css"],sourcesContent:[${JSON.stringify(sourceContent)}],sourceRoot:""}]);`,
    '})();',
  ].join('');
}

function makePatchableEditorCss() {
  return [
    'body{',
    '--color-background-fill-primary:var(--colors-grey-100);',
    '--color-background-fill-secondary:var(--colors-grey-97);',
    '--color-surface-fill-tertiary-enabled:var(--colors-grey-95);',
    '}',
    'body ::selection{background:rgba(33,133,231,.3)}',
    'body.darkMode ::selection{background:rgba(33,133,231,.25)}',
    '.linkEditSelection{background:rgba(33,133,231,.3)}',
    'body.darkMode .linkEditSelection{background:rgba(33,133,231,.25)}',
    'en-note{padding-left:48px;padding-right:48px}',
    '.title-editor{padding-left:48px;padding-right:48px}',
    'en-note.peso{background-color:var(--color-background-fill-primary)}',
    'body.darkMode en-note.peso{background-color:#262626;color:#e6e6e6}',
    '.formatted-highlight{background-color:#ff0}',
  ].join('');
}

function makePatchableEditorNoteLayoutJs({ swappedNames = false } = {}) {
  const layoutConstants = swappedNames
    ? 'h=840,f=24,g=124,y=0,v=41,b=56,_=56,E="center",T=!1,A=40'
    : 'h=840,f=24,g=124,y=0,v=41,b=56,E=56,_="center",T=!1,A=40';
  return `function noteLayout(){const ${layoutConstants};return b;}`;
}

function makePatchableTagSuggestionChunkJs() {
  return [
    '(()=>{',
    'const css=".tagSuggestion{background-color:var(--color-surface-fill-primary-hover);color:var(--color-text-fill-tertiary-enabled);cursor:pointer;transition-property:background-color;transition-duration:.1s;transition-timing-function:ease-in-out}";',
    'const noteDetailCss=".eFghltw7oGwowX2A{background-color:var(--pesoNoteDetail-bg);min-width:450px;border-radius:var(--radius-sm);margin:var(--viewpane-padding)var(--viewpane-padding)var(--viewpane-padding)var(--spacing-0-5);box-shadow:var(--shadow-app-components-background-base);flex-flow:column;flex-grow:1;display:flex;position:relative;overflow:hidden}";',
    'function boronDragPatch(){if(e.isBoron&&n.boronEnv.isMac)t.payload.event.preventDefault(),n.broker.call("boron.actions.setNativeFilesForDrag",o.resources.map((e=>({url:e.url,filename:e.filename??"",mime:e.mime}))));else{const e=o.resources[0];if(e){const{filename:t=`${n.now()}`,mime:o,url:a}=e;a&&r.setData("DownloadURL",`${o}:${t}:${a}`)}}}',
    'void css;',
    'void noteDetailCss;',
    'void boronDragPatch;',
    '})();',
  ].join('');
}

function makePatchableCommonEditorDragChunkJs() {
  return [
    '(()=>{',
    'function commonEditorDragPatch(){if((0,F.Ld)()&&x.Z.isMac)n.preventDefault(),(0,U.HH)(t.resources.map((e=>({url:e.url,filename:e.filename,mime:e.mime}))));else{const{filename:e=`${Date.now()}`,mime:o,url:a}=t.resources[0];a&&n.dataTransfer.setData("DownloadURL",`${o}:${e}:${a}`)}}',
    'void commonEditorDragPatch;',
    '})();',
  ].join('');
}

function makePatchableDropdownItemChunkJs() {
  return [
    '(()=>{',
    'const css=".dropItem{padding:var(--spacing-0);align-items:flex-start;gap:var(--spacing-0-25);border-radius:var(--radius-s);flex-direction:column;align-self:stretch;transition:scale .15s;display:flex}.dropItem:hover{background-color:var(--color-surface-fill-primary-hover)}.dropItem:active{scale:.99}.dropTitle{cursor:pointer;color:var(--color-text-fill-tertiary-enabled)}";',
    'void css;',
    '})();',
  ].join('');
}

function makePatchableSearchDropdownItemChunkJs() {
  return [
    '(()=>{',
    'const css=".U1xedhQgLIIyQkOT{width:100%;display:flex}.U1xedhQgLIIyQkOT:hover{cursor:pointer}.brw4jmU4lkxuTAYR{background-color:var(--color-surface-fill-primary-hover)}";',
    'void css;',
    '})();',
  ].join('');
}

function makePatchableFilterPillChunkJs() {
  return [
    '(()=>{',
    'const css=".jqbSVmnUH2EfY3lr{border-radius:var(--radius-sm);width:fit-content;max-width:240px;height:28px;color:var(--color-text-fill-secondary-enabled);background:var(--color-filterpill-base-fill-default);border:1px solid var(--color-filterpill-base-fill-default);white-space:nowrap;align-items:center;margin:8px 8px 0 0;padding-left:12px;padding-right:5px;display:inline-flex}.wqCWqnEkjWkpztCx{background-color:var(--color-filterpill-base-fill-default);color:var(--color-text-fill-secondary-enabled)}.z_id2ah139EuqFwM{background-color:var(--color-filterpill-base-fill-active);color:var(--color-text-fill-inverted-enabled)}.z_id2ah139EuqFwM .r67eM9WcqAoAhwof,.z_id2ah139EuqFwM .vtNwiuQWjQUa3F8C{color:var(--color-filterpill-icons-fill-active)}.z_id2ah139EuqFwM .a7xnz3aZQokmX7q8{color:var(--color-filterpill-closeicon-fill-active)}.z_id2ah139EuqFwM .a7xnz3aZQokmX7q8:hover{color:var(--color-filterpill-closeicon-fill-activehover)}";',
    'void css;',
    '})();',
  ].join('');
}

function makePatchableSourceUrlPillChunkJs() {
  const css = [
    '.SiiOu{align-items:center;background-color:var(--color-filterpill-base-fill-default);border:2px solid transparent;border-radius:var(--radius-sm);cursor:pointer;display:inline-flex;font-weight:400;max-width:375px;padding:0 6px;text-align:center}',
    '.SiiOu,body.neutron .SiiOu{font-size:14px;line-height:18px}',
    'body.neutron .SiiOu{font-size:13px;height:28px;line-height:30px}',
    'body.neutron .SiiOu{border-radius:var(--radius-sm);margin:0 6px 0 0;max-width:165px;padding:0 5px 0 2px}',
    '.klJtG{background-color:#f2f2f2;color:#4d4d4d}',
    'body.neutron .klJtG{padding:var(--spacing-0)}',
    'body.darkMode .klJtG{background-color:#404040;color:#d9d9d9}',
    '.yjBnv{line-height:18px;max-width:187.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    'body.neutron .yjBnv{max-width:106.5px}',
  ].join('');

  return ['(()=>{', `const css=${JSON.stringify(css)};`, 'void css;', '})();'].join('');
}

function makePatchableMainNavChunkJs() {
  return [
    'function navWidth(){const Ia={V0:96,WB:60,af:400};let q=300,Q=Ia.V0,X=Math.max(Math.min(Ia.af,q),Q);return Q+X}',
    'const multiSelectFloatingMenuCss=".cSX4Fc7FHQb632Sg{z-index:var(--floating-menu-z-index);box-shadow:var(--shadow-xl);width:420px;padding:var(--spacing-0-75)var(--spacing-1-5);align-items:center;gap:var(--spacing-0-5);pointer-events:all;border-radius:var(--radius-sm-md);background:var(--color-surface-fill-secondarybrand-enabled);flex-shrink:0;justify-content:space-between;animation:.3s cG8p5qfvk3wGbIUX;display:flex;position:absolute;bottom:32px;left:50%;translate:-50%}.UBpdhKOC1XkODEHP{min-width:0;color:var(--color-text-fill-inverted-enabled);font:var(--typography-m14);padding-left:var(--spacing-0-75)}.smD3K8Nh5kcQyNGr{align-items:center;gap:var(--spacing-0-75);display:flex}._BcxFGjeF0UUj5Z_{padding:var(--spacing-0);justify-content:flex-end;align-items:center;gap:var(--spacing-0-5);display:flex}.a9h8bbz8LYMfS910{background-color:var(--color-surface-stroke-tertiary-enabled);align-items:flex-start;width:1px;height:20px;display:flex}";',
    'void multiSelectFloatingMenuCss;',
  ].join('');
}

function makePatchableTabShellJs() {
  return [
    '(()=>{',
    'const css=".guV7KlaE1WwDAqBe,.GKwwIN39E1caVAFH,.gzvhLiD0v_o9RDyf,.OIVeVYl42Uq2kEtS{letter-spacing:-.12px;cursor:pointer;-webkit-app-region:no-drag;background:0 0;border:none;flex:1 1 0;justify-content:center;align-items:center;min-width:0;max-width:200px;height:38px;padding:0 2px;font-size:13px;line-height:20px;display:inline-flex}.tBikuT2URawkHF8k,.gger9Drdmhogq7zI{width:100%;max-width:200px;color:var(--color-text-fill-quaternary-enabled);border-radius:8px;align-items:center;gap:6px;padding:5px 10px}.gger9Drdmhogq7zI{background:var(--color-surface-fill-primary-enabled);color:var(--color-text-fill-tertiary-enabled);border-radius:24px}.Iai8mBXIdZQJna_3{white-space:nowrap;text-overflow:ellipsis;text-align:left;pointer-events:none;flex:1;min-width:0;overflow:hidden}";',
    'void css;',
    '})();',
  ].join('');
}

function makePatchableNavStylesChunkJs() {
  return [
    '(()=>{',
    'const css=":root{--nav-collapsed-width:60px;--nav-collapsed-padding:var(--spacing-0-5)var(--spacing-2);}',
    '.collapsedRail{width:60px;transition:width .2s ease-in-out}',
    '.collapsedItem{padding:var(--spacing-0-5)var(--spacing-2);justify-content:center;}";',
    'void css;',
    '})();',
  ].join('');
}

function makePatchableNavConstantsChunkJs() {
  return 'function navConstants(){const n=244,r=400,i=244,s=205,l=244,d=60,c=96;return d+c}';
}

function makePatchableNoteListStylesChunkJs() {
  return [
    '(()=>{',
    'const css=":root{--noteSnippet-border-bottom:1px solid var(--color-snippet-base-stroke-enabled);}',
    '.NoteSnippet{border-bottom:var(--noteSnippet-border-bottom);}";',
    'void css;',
    '})();',
  ].join('');
}

function makePatchableFrozenNavChunkJs() {
  return [
    'function frozenNav(){',
    'let Z,j,Dv,Pi,q,W,K,la,V,Ua,G,i,ne,l,pe,H,Q,z,we,ke,de,le,ge,me;',
    'Z=j-(Dv+Pi.B),[q,W]=(0,ne.useState)(i),K=(0,ne.useRef)(!0),{show_download_app_button:V}=(0,la.N)(),z=Ua.V0,G=Math.max(Math.min(Ua.af,Z),z);',
    'le=(0,ne.useCallback)((e=>{l(q),W(e),(0,pe.b)(H.NAV_DRAWER_WIDTH,e),(0,pe.b)(H.IS_NAV_EXPANDED,e>=Ua.g$)}),[q]);',
    'we=(0,ne.useMemo)((()=>({width:Q?Ua.Dl:z,height:"100%"})),[Q]);',
    'ke=(0,ne.useCallback)((()=>{Q?(de(),le(Ua.Dl)):ge()}),[de,Q,le,ge]);',
    'return {onResize:e=>{const t=e instanceof MouseEvent?e.pageX:e.changedTouches[0].pageX;W(me(t))}};',
    '}',
  ].join('');
}

test('patchEvernoteBundle applies Linux port patches in-place', () => {
  const tempDir = makeTempDir();
  try {
    const asarPath = path.join(tempDir, 'app.asar');
    const mainJs = makePatchableMainJs();

    writeMinimalAsar(asarPath, {
      'main.js': mainJs,
      '172.js': makePatchableAudioPlayerChunkJs(),
      '7839.js': makePatchableAppThemeChunkJs(),
      '4701.js': makePatchableSourceUrlPillChunkJs(),
      '8078.js': makePatchableTagSuggestionChunkJs(),
      '9505.js': makePatchableTagSuggestionChunkJs(),
      '3645.js': makePatchableCommonEditorDragChunkJs(),
      '1957.js': makePatchableDropdownItemChunkJs(),
      '9911.js': makePatchableSearchDropdownItemChunkJs(),
      '6431.js': makePatchableFilterPillChunkJs(),
      '8823.js': makePatchableFilterPillChunkJs(),
      '8634.js': makePatchableMainNavChunkJs(),
      'boronTabShell.js': makePatchableTabShellJs(),
      '2002.js': makePatchableNavStylesChunkJs(),
      '8453.js': makePatchableNavConstantsChunkJs(),
      '3014.js': makePatchableNoteListStylesChunkJs(),
      '4932.js': makePatchableFrozenNavChunkJs(),
      '3407.js': makePatchableEditorNoteLayoutJs({ swappedNames: true }),
      'ce/ce-test.js': makePatchableEditorNoteLayoutJs(),
      'node_modules/@evernote/common-editor/ce.js': makePatchableEditorNoteLayoutJs(),
      'ce/ce-test.css': makePatchableEditorCss(),
      'node_modules/@evernote/common-editor/headless.css': makePatchableEditorCss(),
      'node_modules/en-conduit-electron/dist/MainResourceProxy.js':
        makePatchableMainResourceProxyJs(),
    });

    const firstPatch = patchEvernoteBundle(asarPath);
    for (const patch of patches) {
      assert.equal(firstPatch[patch.resultKey], true, patch.resultKey);
    }

    const patchedMainJs = readMinimalAsarEntry(asarPath, 'main.js');
    const patchedMainResourceProxyJs = readMinimalAsarEntry(
      asarPath,
      'node_modules/en-conduit-electron/dist/MainResourceProxy.js',
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
    assert.match(patchedMainJs, /if\(\(0,i\.isNullish\)\(t\)\)return\{\};\s+return t/);
    assert.match(patchedMainJs, /const flacMime="audio\/flac\s\s";/);
    assert.match(
      patchedMainJs,
      /Trying to init multiple times"\);this\._initialized=!0;return;\s+this\.currentChannel=t/,
    );
    assert.match(
      patchedMainJs,
      /async getRemoteUpdatedList\(\)\{return\{feedbackLevel:m\.InAppForceUpdateFeedbackLevel\.none\};let t=this\.remoteCheckUrl;/,
    );
    assert.match(patchedMainJs, /h\.app\.quit\(\),0\}\}\),this\.window\.on\("show"/);
    assert.match(
      patchedMainJs,
      /this\.tabs\.has\(t\)&&\(this\.tabs\.delete\(t\),this\.activeTabId===t&&\(this\.onActiveWebContentsChange\?\.\(null,null\),this\.activeTabId=null\)\)/,
    );
    assert.match(
      patchedMainJs,
      /backgroundColor:"#000000"\s+,backgroundMaterial:"none",vibrancy:"fullscreen-ui"/,
    );
    assert.match(
      patchedMainJs,
      /n\.isEmpty\(\)\?o\?\.writeFilePaths\(a\):l\.clipboard\.writeImage\(n\)/,
    );
    assert.match(
      patchedMainJs,
      /N=async t=>\{let a=await A\(t\),n=l\.nativeImage\.createFromPath\(a\[0\]\|\|""\);/,
    );
    assert.match(patchedMainJs, /ignoreInitial:!0/);
    assert.match(
      patchedMainJs,
      /let n=!0;return i\.default\.isMac\?n=await U\(t\):i\.default\.isWin&&\(n=await B\(t\)\),n/,
    );
    assert.match(patchedMainJs, /t\?\.startDrag\(\{file:n\[0\]\|\|"",files:n,icon:/);
    assert.doesNotMatch(patchedMainJs, /if\(this\.warmTab\|\|this\.isPreloadingWarmTab\)return/);
    assert.doesNotMatch(patchedMainJs, /backgroundColor:"transparent"/);
    assert.doesNotMatch(patchedMainJs, /ignoreInitial:!1/);
    assert.doesNotMatch(
      patchedMainJs,
      /let n=!1;return i\.default\.isMac\?n=await U\(t\):i\.default\.isWin&&\(n=await B\(t\)\),n/,
    );
    assert.doesNotMatch(
      patchedMainJs,
      /N=async t=>\{let a=await A\(t\);o\?\.writeFilePaths\(a\)\}/,
    );
    assert.doesNotMatch(
      patchedMainJs,
      /this\.hidden=!0,this\.window\.hide\(\)\}\}\),this\.window\.on\("show"/,
    );
    assert.doesNotMatch(patchedMainJs, /this\.activeTabId=null\),this\.publishState\(\)\)/);
    assert.doesNotMatch(patchedMainJs, /audio\/x-flac/);
    assert.doesNotThrow(() => new Function(patchedMainJs));
    assert.ok(
      patchedMainResourceProxyJs.includes(String.raw`.replace(/^audio\/x-flac\b/i, "audio/flac")`),
    );
    assert.match(patchedMainResourceProxyJs, /function normalizeFlacMime/);
    assert.match(
      patchedMainResourceProxyJs,
      /"Content-Type":normalizeFlacMime\(resource\.meta\.mime\)/,
    );
    const patchedAudioPlayerChunkJs = readMinimalAsarEntry(asarPath, '172.js');
    assert.match(
      patchedAudioPlayerChunkJs,
      /\/\^audio\\\/x-flac\\b\/i\.test\(e\)\?"audio\/flac":r\[e\]\|\|e/,
    );
    assert.match(patchedAudioPlayerChunkJs, /n\.onerror=r/);
    assert.doesNotMatch(patchedAudioPlayerChunkJs, /return r\[e\]\|\|e/);
    assert.match(patchedAudioPlayerChunkJs, /disclaimer:void 0\s+,initialThread:null/);
    assert.doesNotMatch(patchedAudioPlayerChunkJs, /disclaimer:\{text:[A-Za-z_$][\w$]*\(\)\}/);
    assert.doesNotMatch(patchedMainResourceProxyJs, /headers\['content-type'\]\) !== null/);
    assert.doesNotMatch(patchedMainResourceProxyJs, /'Content-Type': resource\.meta\.mime/);
    assert.doesNotThrow(() => new Function(patchedMainResourceProxyJs));
    assert.doesNotThrow(() => new Function(patchedAudioPlayerChunkJs));
    const patchedAppThemeChunkJs = readMinimalAsarEntry(asarPath, '7839.js');
    assert.match(patchedAppThemeChunkJs, /--color-background-base-fill-primary:#000\s+;/);
    assert.match(patchedAppThemeChunkJs, /--color-surface-fill-primary-enabled:#000\s+;/);
    assert.match(patchedAppThemeChunkJs, /--color-button-base-fill-primary-default:#000\s+;/);
    assert.match(patchedAppThemeChunkJs, /--color-button-content-fill-primary-default:#fff\s+;/);
    assert.match(patchedAppThemeChunkJs, /--color-note_list-base-stroke-enabled:#000\s+;/);
    assert.match(
      patchedAppThemeChunkJs,
      /--color-text-fill-primary-enabled:var\(--colors-grey-8\);/,
    );
    assert.match(patchedAppThemeChunkJs, /--home-widget-pp-background-z-index:-1;/);
    assert.match(
      patchedAppThemeChunkJs,
      /sourcesContent:\["\.source-theme\{--color-calendar_block-highlight-fill-task-enabled:var\(--colors-secondary-purple-300\);\}"\]/,
    );
    assert.doesNotMatch(
      patchedAppThemeChunkJs,
      /--color-background-base-fill-primary:var\(--colors-grey-(?:100|8)\);/,
    );
    assert.doesNotMatch(
      patchedAppThemeChunkJs,
      /--color-button-content-fill-primary-default:var\(--colors-grey-8\);/,
    );
    assert.doesNotThrow(() => new Function(patchedAppThemeChunkJs));
    const patchedEditorCss = readMinimalAsarEntry(asarPath, 'ce/ce-test.css');
    assert.match(patchedEditorCss, /--color-background-fill-primary:#000\s+;/);
    assert.match(patchedEditorCss, /body ::selection\{background:rgba\(33,133,231,\.4\)\}/);
    assert.match(
      patchedEditorCss,
      /body\.darkMode ::selection\{background:rgba\(33,133,231,\.4\)\s+\}/,
    );
    assert.match(patchedEditorCss, /\.linkEditSelection\{background:rgba\(33,133,231,\.4\)\}/);
    assert.match(
      patchedEditorCss,
      /body\.darkMode \.linkEditSelection\{background:rgba\(33,133,231,\.4\)\s+\}/,
    );
    assert.doesNotMatch(patchedEditorCss, /rgba\(33,133,231,\.(?:25|3)\)/);
    assert.match(patchedEditorCss, /en-note\{padding-left:0px\s*;padding-right:0px\s*\}/);
    assert.match(patchedEditorCss, /\.title-editor\{padding-left:0px\s*;padding-right:0px\s*\}/);
    assert.doesNotMatch(
      patchedEditorCss,
      /padding-left:(?:48px|8px\s*);padding-right:(?:48px|8px\s*)/,
    );
    const patchedEditorNoteLayoutChunkJs = readMinimalAsarEntry(asarPath, 'ce/ce-test.js');
    assert.match(
      patchedEditorNoteLayoutChunkJs,
      /h=840,f=24,g=124,y=0,v=41,b=0\s,E=0\s,_="left",T=!1\s\s,A=40/,
    );
    assert.doesNotMatch(patchedEditorNoteLayoutChunkJs, /b=56,E=56,_="center"/);
    const patchedEditorSwappedNoteLayoutChunkJs = readMinimalAsarEntry(asarPath, '3407.js');
    assert.match(
      patchedEditorSwappedNoteLayoutChunkJs,
      /h=840,f=24,g=124,y=0,v=41,b=0\s,_=0\s,E="left",T=!1\s\s,A=40/,
    );
    assert.doesNotMatch(patchedEditorSwappedNoteLayoutChunkJs, /b=56,_=56,E="center"/);
    assert.match(
      patchedEditorCss,
      /body\.darkMode en-note\.peso\{background-color:#000\s+;color:#e6e6e6\}/,
    );
    assert.match(
      patchedEditorCss,
      /--color-surface-fill-tertiary-enabled:var\(--colors-grey-95\);/,
    );
    assert.match(patchedEditorCss, /\.formatted-highlight\{background-color:#ff0\}/);
    const patchedTagSuggestionChunkJs = readMinimalAsarEntry(asarPath, '8078.js');
    const patchedSecondTagSuggestionChunkJs = readMinimalAsarEntry(asarPath, '9505.js');
    assert.match(
      patchedTagSuggestionChunkJs,
      /background-color:#1f1f1f\s*;color:var\(--color-text-fill-tertiary-enabled\);cursor:pointer;transition-property:background-color;/,
    );
    assert.match(
      patchedTagSuggestionChunkJs,
      /transition-duration:0s\s*;transition-timing-function:ease-in-out/,
    );
    assert.match(
      patchedTagSuggestionChunkJs,
      /box-shadow:0 0 0 1px #000\s*;flex-flow:column;flex-grow:1;display:flex;position:relative;overflow:hidden/,
    );
    assert.match(
      patchedTagSuggestionChunkJs,
      /if\(e\.isBoron\)t\.payload\.event\.preventDefault\(\),n\.broker\.call\("boron\.actions\.setNativeFilesForDrag"/,
    );
    assert.doesNotMatch(
      patchedTagSuggestionChunkJs,
      /background-color:var\(--color-surface-fill-primary-hover\);color:var\(--color-text-fill-tertiary-enabled\);cursor:pointer;transition-property:background-color;/,
    );
    assert.doesNotMatch(patchedTagSuggestionChunkJs, /transition-duration:\.1s/);
    assert.doesNotMatch(
      patchedTagSuggestionChunkJs,
      /box-shadow:var\(--shadow-app-components-background-base\);flex-flow:column;flex-grow:1;display:flex;position:relative;overflow:hidden/,
    );
    assert.doesNotMatch(patchedTagSuggestionChunkJs, /e\.isBoron&&n\.boronEnv\.isMac/);
    assert.doesNotThrow(() => new Function(patchedTagSuggestionChunkJs));
    assert.match(
      patchedSecondTagSuggestionChunkJs,
      /background-color:#1f1f1f\s*;color:var\(--color-text-fill-tertiary-enabled\);cursor:pointer;transition-property:background-color;/,
    );
    assert.doesNotMatch(
      patchedSecondTagSuggestionChunkJs,
      /background-color:var\(--color-surface-fill-primary-hover\)/,
    );
    assert.match(
      patchedSecondTagSuggestionChunkJs,
      /transition-duration:0s\s*;transition-timing-function:ease-in-out/,
    );
    assert.doesNotMatch(patchedSecondTagSuggestionChunkJs, /transition-duration:\.1s/);
    assert.doesNotThrow(() => new Function(patchedSecondTagSuggestionChunkJs));
    const patchedCommonEditorDragChunkJs = readMinimalAsarEntry(asarPath, '3645.js');
    assert.match(
      patchedCommonEditorDragChunkJs,
      /if\(\(0,F\.Ld\)\(\)\)n\.preventDefault\(\),\(0,U\.HH\)\(t\.resources\.map/,
    );
    assert.doesNotMatch(patchedCommonEditorDragChunkJs, /&&x\.Z\.isMac/);
    assert.doesNotThrow(() => new Function(patchedCommonEditorDragChunkJs));
    const patchedDropdownItemChunkJs = readMinimalAsarEntry(asarPath, '1957.js');
    assert.match(
      patchedDropdownItemChunkJs,
      /flex-direction:column;align-self:stretch;transition:scale \.15s;display:flex\}\.dropItem:hover\{background-color:#1f1f1f\s*\}\.dropItem:active\{scale:\.99\}/,
    );
    assert.doesNotMatch(
      patchedDropdownItemChunkJs,
      /\.dropItem:hover\{background-color:var\(--color-surface-fill-primary-hover\)\}/,
    );
    assert.doesNotThrow(() => new Function(patchedDropdownItemChunkJs));
    const patchedSearchDropdownItemChunkJs = readMinimalAsarEntry(asarPath, '9911.js');
    assert.match(
      patchedSearchDropdownItemChunkJs,
      /\.U1xedhQgLIIyQkOT:hover,.brw4jmU4lkxuTAYR\{background-color:#1f1f1f\s*\}/,
    );
    assert.doesNotMatch(
      patchedSearchDropdownItemChunkJs,
      /\.brw4jmU4lkxuTAYR\{background-color:var\(--color-surface-fill-primary-hover\)\}/,
    );
    assert.doesNotThrow(() => new Function(patchedSearchDropdownItemChunkJs));
    const patchedFilterPillChunkJs = readMinimalAsarEntry(asarPath, '6431.js');
    const patchedSecondFilterPillChunkJs = readMinimalAsarEntry(asarPath, '8823.js');
    assert.match(
      patchedFilterPillChunkJs,
      /color:#d9d9d9\s*;background:var\(--color-filterpill-base-fill-default\)/,
    );
    assert.match(
      patchedFilterPillChunkJs,
      /background-color:var\(--color-filterpill-base-fill-default\);color:#d9d9d9\s*/,
    );
    assert.doesNotMatch(
      patchedFilterPillChunkJs,
      /color:var\(--color-text-fill-secondary-enabled\);background(?:-color)?:var\(--color-filterpill-base-fill-default\)|background(?:-color)?:var\(--color-filterpill-base-fill-default\);color:var\(--color-text-fill-secondary-enabled\)/,
    );
    assert.match(
      patchedFilterPillChunkJs,
      /background-color:var\(--color-filterpill-base-fill-active\);color:#fff\s*/,
    );
    assert.doesNotMatch(
      patchedFilterPillChunkJs,
      /background-color:var\(--color-filterpill-base-fill-active\);color:var\(--color-text-fill-inverted-enabled\)/,
    );
    assert.match(
      patchedFilterPillChunkJs,
      /\.z_id2ah139EuqFwM \.r67eM9WcqAoAhwof,\.z_id2ah139EuqFwM \.vtNwiuQWjQUa3F8C\{color:#fff\s*\}/,
    );
    assert.doesNotMatch(
      patchedFilterPillChunkJs,
      /\.z_id2ah139EuqFwM \.r67eM9WcqAoAhwof,\.z_id2ah139EuqFwM \.vtNwiuQWjQUa3F8C\{color:var\(--color-filterpill-icons-fill-active\)\}/,
    );
    assert.match(
      patchedFilterPillChunkJs,
      /\.z_id2ah139EuqFwM \.a7xnz3aZQokmX7q8\{color:#000\s*\}/,
    );
    assert.match(
      patchedFilterPillChunkJs,
      /\.z_id2ah139EuqFwM \.a7xnz3aZQokmX7q8:hover\{color:#000\s*\}/,
    );
    assert.doesNotMatch(
      patchedFilterPillChunkJs,
      /color:var\(--color-filterpill-closeicon-fill-active(?:hover)?\)/,
    );
    assert.doesNotThrow(() => new Function(patchedFilterPillChunkJs));
    assert.match(
      patchedSecondFilterPillChunkJs,
      /background-color:var\(--color-filterpill-base-fill-default\);color:#d9d9d9\s*/,
    );
    assert.match(
      patchedSecondFilterPillChunkJs,
      /background-color:var\(--color-filterpill-base-fill-active\);color:#fff\s*/,
    );
    assert.match(
      patchedSecondFilterPillChunkJs,
      /\.z_id2ah139EuqFwM \.r67eM9WcqAoAhwof,\.z_id2ah139EuqFwM \.vtNwiuQWjQUa3F8C\{color:#fff\s*\}/,
    );
    assert.match(
      patchedSecondFilterPillChunkJs,
      /\.z_id2ah139EuqFwM \.a7xnz3aZQokmX7q8\{color:#000\s*\}/,
    );
    assert.match(
      patchedSecondFilterPillChunkJs,
      /\.z_id2ah139EuqFwM \.a7xnz3aZQokmX7q8:hover\{color:#000\s*\}/,
    );
    assert.doesNotThrow(() => new Function(patchedSecondFilterPillChunkJs));
    const patchedSourceUrlPillChunkJs = readMinimalAsarEntry(asarPath, '4701.js');
    assert.match(patchedSourceUrlPillChunkJs, /max-width:none\s*;padding:0 6px/);
    assert.match(patchedSourceUrlPillChunkJs, /max-width:none\s*;padding:0 5px 0 2px/);
    assert.match(
      patchedSourceUrlPillChunkJs,
      /\.yjBnv\{line-height:18px;max-width:none\s*;overflow:hidden;text-overflow:ellipsis;white-space:nowrap\}/,
    );
    assert.match(patchedSourceUrlPillChunkJs, /body\.neutron \.yjBnv\{max-width:none\s*\}/);
    assert.doesNotMatch(patchedSourceUrlPillChunkJs, /max-width:375px|max-width:165px/);
    assert.doesNotMatch(patchedSourceUrlPillChunkJs, /max-width:187\.5px|max-width:106\.5px/);
    assert.doesNotThrow(() => new Function(patchedSourceUrlPillChunkJs));
    const patchedMainNavChunkJs = readMinimalAsarEntry(asarPath, '8634.js');
    assert.match(patchedMainNavChunkJs, /Q=Ia\.WB,X=Math\.max\(Math\.min\(Ia\.af,q\),Q\)/);
    assert.match(patchedMainNavChunkJs, /box-shadow:0 0 0 1px #444,0 8px 24px #000;width:420px/);
    assert.match(patchedMainNavChunkJs, /background:#1f1f1f/);
    assert.match(
      patchedMainNavChunkJs,
      /\.UBpdhKOC1XkODEHP\{min-width:0;color:#fff;font:var\(--typography-m14\);/,
    );
    assert.match(
      patchedMainNavChunkJs,
      /\.smD3K8Nh5kcQyNGr,\.smD3K8Nh5kcQyNGr \*\{color:#fff!important;fill:#fff!important;stroke:#fff!important\}/,
    );
    assert.match(patchedMainNavChunkJs, /\.a9h8bbz8LYMfS910\{background-color:#555;/);
    assert.doesNotMatch(patchedMainNavChunkJs, /Q=Ia\.V0,X=Math\.max\(Math\.min\(Ia\.af,q\),Q\)/);
    assert.doesNotMatch(
      patchedMainNavChunkJs,
      /background:var\(--color-surface-fill-secondarybrand-enabled\)/,
    );
    assert.doesNotMatch(patchedMainNavChunkJs, /color:var\(--color-text-fill-inverted-enabled\)/);
    assert.doesNotThrow(() => new Function(patchedMainNavChunkJs));
    const patchedTabShellJs = readMinimalAsarEntry(asarPath, 'boronTabShell.js');
    assert.match(
      patchedTabShellJs,
      /\.gger9Drdmhogq7zI\{background:var\(--color-surface-fill-primary-enabled\);color:#fff;font-weight:700;border-radius:24px\}/,
    );
    assert.doesNotMatch(
      patchedTabShellJs,
      /\.gger9Drdmhogq7zI\{background:var\(--color-surface-fill-primary-enabled\);color:var\(--color-text-fill-tertiary-enabled\);border-radius:24px\}/,
    );
    assert.match(
      patchedTabShellJs,
      /\.guV7KlaE1WwDAqBe,\.GKwwIN39E1caVAFH,\.gzvhLiD0v_o9RDyf,\.OIVeVYl42Uq2kEtS\{[^}]*height:40px;/,
    );
    assert.doesNotMatch(
      patchedTabShellJs,
      /\.guV7KlaE1WwDAqBe,\.GKwwIN39E1caVAFH,\.gzvhLiD0v_o9RDyf,\.OIVeVYl42Uq2kEtS\{[^}]*height:38px;/,
    );
    assert.doesNotThrow(() => new Function(patchedTabShellJs));
    const patchedNavStylesChunkJs = readMinimalAsarEntry(asarPath, '2002.js');
    assert.match(patchedNavStylesChunkJs, /--nav-collapsed-width:30px;/);
    assert.match(patchedNavStylesChunkJs, /width:30px;transition:width \.2s ease-in-out/);
    assert.match(patchedNavStylesChunkJs, /--nav-collapsed-padding:var\(--spacing-1-5\)0;\s+/);
    assert.match(
      patchedNavStylesChunkJs,
      /padding:var\(--spacing-1-5\)0;justify-content:center;\s+/,
    );
    assert.doesNotMatch(patchedNavStylesChunkJs, /--nav-collapsed-width:60px/);
    assert.doesNotMatch(patchedNavStylesChunkJs, /width:60px;transition:width \.2s ease-in-out/);
    assert.doesNotMatch(patchedNavStylesChunkJs, /spacing-0-5/);
    assert.doesNotThrow(() => new Function(patchedNavStylesChunkJs));
    const patchedNavConstantsChunkJs = readMinimalAsarEntry(asarPath, '8453.js');
    assert.match(patchedNavConstantsChunkJs, /d=30,c=96/);
    assert.doesNotMatch(patchedNavConstantsChunkJs, /d=60,c=96/);
    assert.doesNotThrow(() => new Function(patchedNavConstantsChunkJs));
    const patchedNoteListStylesChunkJs = readMinimalAsarEntry(asarPath, '3014.js');
    assert.match(
      patchedNoteListStylesChunkJs,
      /--noteSnippet-border-bottom:0px solid transparent;\s+/,
    );
    assert.doesNotMatch(
      patchedNoteListStylesChunkJs,
      /--noteSnippet-border-bottom:1px solid var\(--color-snippet-base-stroke-enabled\);/,
    );
    assert.doesNotThrow(() => new Function(patchedNoteListStylesChunkJs));
    const patchedFrozenNavChunkJs = readMinimalAsarEntry(asarPath, '4932.js');
    assert.match(patchedFrozenNavChunkJs, /\[q,W\]=ne\.useState\(Ua\.WB\)/);
    assert.match(
      patchedFrozenNavChunkJs,
      /W\(z\),\(0,pe\.b\)\(H\.NAV_DRAWER_WIDTH,z\),\(0,pe\.b\)\(H\.IS_NAV_EXPANDED,!1\)/,
    );
    assert.match(
      patchedFrozenNavChunkJs,
      /we=\(0,ne\.useMemo\)\(\(\(\)=>\(\{width:z,height:"100%"\}\)\),\[z\]\)/,
    );
    assert.match(
      patchedFrozenNavChunkJs,
      /ke=\(0,ne\.useCallback\)\(\(\(\)=>\{le\(z\)\}\),\[le,z\]\)/,
    );
    assert.match(patchedFrozenNavChunkJs, /onResize:e=>\{W\(z\)\}/);
    assert.doesNotMatch(patchedFrozenNavChunkJs, /\[q,W\]=\(0,ne\.useState\)\(i\)/);
    assert.doesNotMatch(
      patchedFrozenNavChunkJs,
      /W\(e\),\(0,pe\.b\)\(H\.NAV_DRAWER_WIDTH,e\),\(0,pe\.b\)\(H\.IS_NAV_EXPANDED,e>=Ua\.g\$\)/,
    );
    assert.doesNotMatch(patchedFrozenNavChunkJs, /width:Q\?Ua\.Dl:z/);
    assert.doesNotMatch(patchedFrozenNavChunkJs, /Q\?\(de\(\),le\(Ua\.Dl\)\):ge\(\)/);
    assert.doesNotMatch(patchedFrozenNavChunkJs, /W\(me\(t\)\)/);
    assert.doesNotThrow(() => new Function(patchedFrozenNavChunkJs));

    const secondPatch = patchEvernoteBundle(asarPath);
    for (const patch of patches) {
      assert.equal(secondPatch[patch.resultKey], false, patch.resultKey);
    }
    assert.equal(readMinimalAsarEntry(asarPath, 'main.js'), patchedMainJs);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('patchEvernoteBundle fails when expected bundle code is absent', () => {
  const tempDir = makeTempDir();
  try {
    const asarPath = path.join(tempDir, 'app.asar');
    writeMinimalAsar(asarPath, {
      'main.js': 'class MainWindowTabManager { preloadWarmTab(){return this.warmTab;} }',
    });

    assert.throws(() => patchEvernoteBundle(asarPath), /Patch target not found in main\.js/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
