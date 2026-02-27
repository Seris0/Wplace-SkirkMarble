/** @file The main file. Everything in the userscript is executed from here.
 * @since 0.0.0
 */

import Overlay from './Overlay.js';
import Observers from './observers.js';
import ApiManager from './apiManager.js';
import TemplateManager from './templateManager.js';
import { debugLog, canvasPosToLatLng, getDebugLoggingEnabled, saveDebugLoggingEnabled } from './utils.js';

// Ensure debugLog is globally available to prevent ReferenceError - set it immediately
if (typeof window !== 'undefined') {
  window.debugLog = debugLog;
  window.getDebugLoggingEnabled = getDebugLoggingEnabled;
}
import * as icons from './icons.js';
import { initializeTileRefreshPause, toggleTileRefreshPause, isTileRefreshPaused, getCachedTileCount, getSmartCacheStats, toggleSmartTileCache, notifyCanvasChange } from './tileManager.js';
import * as Settings from './settingsManager.js';
import { getDragModeEnabled, saveDragModeEnabled } from './settingsManager.js';
import {
    getTemplateColorSort,
    saveTemplateColorSort,
    getCompactSort,
    saveCompactSort
} from './settingsManager.js';

const name = GM_info.script.name.toString(); // Name of userscript
const version = GM_info.script.version.toString(); // Version of userscript
const consoleStyle = 'color: cornflowerblue;'; // The styling for the console logs

/** Injects code into the client
 * This code will execute outside of TamperMonkey's sandbox
 * @param {*} callback - The code to execute
 * @since 0.11.15
 */
function inject(callback) {
    const script = document.createElement('script');
    script.setAttribute('bm-name', name); // Passes in the name value
    script.setAttribute('bm-cStyle', consoleStyle); // Passes in the console style value
    script.textContent = `(${callback})();`;
    document.documentElement?.appendChild(script);
    script.remove();
}

function flyToLatLng(lat, lng, zoom = 16) {
  unsafeWindow.bmmap.flyTo({
      'center': [lng, lat],
      'zoom': zoom,
  })
}

/** What code to execute instantly in the client (webpage) to spy on fetch calls.
 * This code will execute outside of TamperMonkey's sandbox.
 * @since 0.11.15
 */
inject(() => {

  const script = document.currentScript; // Gets the current script HTML Script Element
  const name = script?.getAttribute('bm-name') || 'Blue Marble'; // Gets the name value that was passed in. Defaults to "Blue Marble" if nothing was found
  const consoleStyle = script?.getAttribute('bm-cStyle') || ''; // Gets the console style value that was passed in. Defaults to no styling if nothing was found
  const fetchedBlobQueue = new Map(); // Blobs being processed

  // Observer to wait for the map to be ready and set window.bmmap
  const observer = new MutationObserver(mutations => {
    try {
      const original = Map.prototype.values;
      Map.prototype.values = function () {
        if (Array.from(this).some(arr => arr.some(x => x && x.color))) {
          return original.call(this);
        }
        const temp = original.call(this);
        const entries = Array.from(temp);
        
        if(entries && entries.filter(x=>x['maps'] instanceof Set).length == 0) {
          return temp;
        }
        entries.forEach((x, index) => {
            if (x && x['maps'] instanceof Set) {
                Array.from(x['maps']).forEach((y, mapIndex) => {
                    if(y){
                      var flyTo = y.flyTo || y['flyTo'];
                      if (flyTo) {
                          window.bmmap = y;
                          Map.prototype.values = original;
                          observer.disconnect();
                      }
                    }
                });
            }
            else {
              return temp;
            }
        });
        
        return temp;
      };
    }
    catch (e){
    }
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true
  });

  window.addEventListener('message', (event) => {
    const { source, endpoint, blobID, blobData, blink } = event.data;

    const elapsed = Date.now() - blink;

    // Since this code does not run in the userscript, we can't use debugLog().
    // console.groupCollapsed(`%c${name}%c: ${fetchedBlobQueue.size} Recieved IMAGE message about blob "${blobID}"`, consoleStyle, '');
    // console.log(`Blob fetch took %c${String(Math.floor(elapsed/60000)).padStart(2,'0')}:${String(Math.floor(elapsed/1000) % 60).padStart(2,'0')}.${String(elapsed % 1000).padStart(3,'0')}%c MM:SS.mmm`, consoleStyle, '');
    // console.log(fetchedBlobQueue);
    console.groupEnd();

    // The modified blob won't have an endpoint, so we ignore any message without one.
    if ((source == 'blue-marble') && !!blobID && !!blobData && !endpoint) {

      const callback = fetchedBlobQueue.get(blobID); // Retrieves the blob based on the UUID

      // If the blobID is a valid function...
      if (typeof callback === 'function') {

        callback(blobData); // ...Retrieve the blob data from the blobID function
      } else {
        // ...else the blobID is unexpected. We don't know what it is, but we know for sure it is not a blob. This means we ignore it.

        console.warn(`%c${name}%c: Attempted to retrieve a blob (%s) from queue, but the blobID was not a function! Skipping...`, consoleStyle, '', blobID);
      }

      fetchedBlobQueue.delete(blobID); // Delete the blob from the queue, because we don't need to process it again
    }
  });

  // Spys on "spontaneous" fetch requests made by the client
  const originalFetch = window.fetch; // Saves a copy of the original fetch

  // Overrides fetch
  window.fetch = async function(...args) {

    const response = await originalFetch.apply(this, args); // Sends a fetch
    const cloned = response.clone(); // Makes a copy of the response

    // Retrieves the endpoint name. Unknown endpoint = "ignore"
    const endpointName = ((args[0] instanceof Request) ? args[0]?.url : args[0]) || 'ignore';

    // Check for pixel placement requests (PUT/POST methods that might indicate canvas changes)
    const method = (args[1]?.method || 'GET').toUpperCase();
    if (method === 'PUT' || method === 'POST') {
      // Notify that canvas might have changed (pixel placement)
      window.postMessage({
        source: 'blue-marble-canvas-change',
        method: method,
        endpoint: endpointName
      }, '*');
    }

    // Check Content-Type to only process JSON
    const contentType = cloned.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {


      // Since this code does not run in the userscript, we can't use debugLog().
      // console.log(`%c${name}%c: Sending JSON message about endpoint "${endpointName}"`, consoleStyle, '');

      // Sends a message about the endpoint it spied on
      cloned.json()
        .then(jsonData => {
          window.postMessage({
            source: 'blue-marble',
            endpoint: endpointName,
            jsonData: jsonData
          }, '*');
        })
        .catch(err => {
          console.error(`%c${name}%c: Failed to parse JSON: `, consoleStyle, '', err);
        });
    } else if (contentType.includes('image/') && (!endpointName.includes('openfreemap') && !endpointName.includes('maps'))) {
      // Fetch custom for all images but opensourcemap

      const blink = Date.now(); // Current time

      const blob = await cloned.blob(); // The original blob

      // Since this code does not run in the userscript, we can't use debugLog().
      // console.log(`%c${name}%c: ${fetchedBlobQueue.size} Sending IMAGE message about endpoint "${endpointName}"`, consoleStyle, '');

      // Returns the manipulated blob
      return new Promise((resolve) => {
        const blobUUID = crypto.randomUUID(); // Generates a random UUID

        // Store the blob while we wait for processing
        fetchedBlobQueue.set(blobUUID, (blobProcessed) => {
          // The response that triggers when the blob is finished processing

          // Creates a new response
          resolve(new Response(blobProcessed, {
            headers: cloned.headers,
            status: cloned.status,
            statusText: cloned.statusText
          }));

          // Since this code does not run in the userscript, we can't use debugLog().
          // debugLog(`%c${name}%c: ${fetchedBlobQueue.size} Processed blob "${blobUUID}"`, consoleStyle, '');
        });

        window.postMessage({
          source: 'blue-marble',
          endpoint: endpointName,
          blobID: blobUUID,
          blobData: blob,
          blink: blink
        });
      }).catch(exception => {
        const elapsed = Date.now();
        console.error(`%c${name}%c: Failed to Promise blob!`, consoleStyle, '');
        console.groupCollapsed(`%c${name}%c: Details of failed blob Promise:`, consoleStyle, '');
        // debugLog(`Endpoint: ${endpointName}\nThere are ${fetchedBlobQueue.size} blobs processing...\nBlink: ${blink.toLocaleString()}\nTime Since Blink: ${String(Math.floor(elapsed/60000)).padStart(2,'0')}:${String(Math.floor(elapsed/1000) % 60).padStart(2,'0')}.${String(elapsed % 1000).padStart(3,'0')} MM:SS.mmm`);
        console.error(`Exception stack:`, exception);
        console.groupEnd();
      });

      // cloned.blob().then(blob => {
      //   window.postMessage({
      //     source: 'blue-marble',
      //     endpoint: endpointName,
      //     blobData: blob
      //   }, '*');
      // });
    }

    return response; // Returns the original response
  };
});

// Imports the CSS file from dist folder on github
const cssOverlay = GM_getResourceText("CSS-BM-File");
GM_addStyle(cssOverlay);

// Add Search Window CSS with Slate Theme (refined UI + centered spawn)
const searchWindowCSS = `
#skirk-search-draggable {
  position: fixed; z-index: 2147483646;
  top: 50%; left: 50%; transform: translate(-50%, -50%);
  width: min(480px,94vw); max-height: min(70vh, 600px);
  background: rgba(30, 41, 59, 0.92); color: #f1f5f9; border-radius: 14px;
  box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.7), 0 0 0 1px rgba(255, 255, 255, 0.05);
  border: 1px solid #334155;
  backdrop-filter: blur(14px);
  font: 14px/1.5 Roboto Mono, monospace, Arial;
  display: none;
  flex-direction: column;
  min-width: 300px;
  will-change: transform;
  overflow: hidden;
}
#skirk-search-draggable .drag-handle {
  margin-bottom: 0.4em;
  background: linear-gradient(135deg, rgba(71,85,105,0.6), rgba(100,116,139,0.55));
  cursor: grab;
  width: 100%;
  height: 28px;
  border-radius: 14px 14px 0 0;
  opacity: 0.95;
  display: flex;
  align-items: center;
  justify-content: center;
}
#skirk-search-draggable.dragging .drag-handle {
  cursor: grabbing;
}
#skirk-search-draggable .drag-handle::before {
  content: '';
  width: 56px;
  height: 6px;
  border-radius: 6px;
  background: linear-gradient(90deg, #94a3b8, #cbd5e1);
  opacity: 0.7;
}
#skirk-search-draggable .hdr {
  display: flex; align-items: center; justify-content: space-between;
  padding: 12px 16px 0 16px;
}
#skirk-search-draggable .hdr h3 {
  margin: 0; font-size: 18px; font-weight: 800; letter-spacing: 0.04em;
  display: flex; align-items: center; gap: 0.6em;
  color: #f8fafc;
}
#skirk-search-draggable .hdr .actions {
  display: flex; gap: 8px;
}
#skirk-search-draggable .hdr button {
  border: 1px solid #475569; padding: 8px 10px; border-radius: 8px;
  background: #334155; color: #f1f5f9; font: 13px monospace;
  cursor: pointer;
  transition: all 0.18s ease;
}
#skirk-search-draggable .hdr button:hover { 
  background: #475569; 
  transform: translateY(-1px);
}
#skirk-search-draggable .hdr button:active { 
  background: #334155; 
  transform: translateY(0px);
}
#skirk-search-draggable .body {
  padding: 12px 16px 16px 16px; overflow: hidden;
}
#skirk-search-input {
  width: 100%; padding: 12px 14px; border-radius: 10px;
  border: 1px solid #475569; background: #0b1222;
  color: #f1f5f9; font: 14px monospace;
  margin-bottom: 12px;
  transition: all 0.2s ease;
}
#skirk-search-input:focus { 
  outline: none;
  border-color: #3b82f6;
  box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.18);
}
#skirk-search-input::placeholder { color: #64748b; }
#skirk-search-results {
  max-height: 360px; overflow-y: auto; overflow-x: hidden;
}
#skirk-search-results::-webkit-scrollbar {
  width: 6px;
}
#skirk-search-results::-webkit-scrollbar-track {
  background: #0f172a;
  border-radius: 3px;
}
#skirk-search-results::-webkit-scrollbar-thumb {
  background: #475569;
  border-radius: 3px;
}
#skirk-search-results::-webkit-scrollbar-thumb:hover {
  background: #64748b;
}
.skirk-search-result {
  padding: 12px; cursor: pointer;
  border: 1px solid transparent;
  border-radius: 10px;
  transition: all 0.2s ease;
  position: relative;
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 8px;
  overflow: hidden;
}
.skirk-search-result:hover {
  background-color: rgba(51, 65, 85, 0.55);
  border-color: #334155;
  transform: translateX(2px);
}
.skirk-result-content {
  flex: 1; min-width: 0; overflow: hidden;
}
.skirk-result-name {
  font-size: 15px;
  color: #f1f5f9;
  margin-bottom: 4px;
  font-weight: 700;
}
.skirk-result-address {
  font-size: 12px;
  color: #94a3b8;
  line-height: 1.3; overflow-wrap: anywhere; word-break: break-word;
}
.skirk-result-address.secondary {
  color: #cbd5e1;
  font-weight: 500;
}
.skirk-favorite-star {
  color: #64748b;
  font-size: 18px;
  cursor: pointer;
  padding: 6px;
  border-radius: 6px;
  transition: all 0.2s ease;
  user-select: none;
  margin-left: 8px;
}
.skirk-favorite-star:hover {
  color: #fbbf24;
  background: rgba(251, 191, 36, 0.1);
  transform: scale(1.1);
}
.skirk-favorite-star.favorited {
  color: #fbbf24;
}
.skirk-loading, .skirk-no-results {
  padding: 20px;
  text-align: center;
  color: #64748b;
  font-size: 14px;
}
.skirk-icon {
  display: inline-block; height: 2em; margin-right: 1ch; vertical-align: middle;
}

/* Favorites Menu */
#skirk-favorites-menu {
  border-top: 1px solid #334155;
  margin-top: 12px;
  padding-top: 12px;
}
#skirk-favorites-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
  padding: 0 2px;
}
#skirk-favorites-title {
  font-size: 13px;
  font-weight: 700;
  color: #cbd5e1;
  display: flex;
  align-items: center;
  gap: 6px;
  transition: color 0.2s;
}
#skirk-favorites-title:hover {
  color: #f1f5f9;
}
#skirk-favorites-toggle {
  font-size: 10px;
  transition: transform 0.2s;
}
#skirk-favorites-toggle.collapsed {
  transform: rotate(-90deg);
}
#skirk-favorites-count {
  background: #475569;
  color: #f1f5f9;
  border-radius: 10px;
  padding: 2px 6px;
  font-size: 11px;
  font-weight: 500;
}
#skirk-clear-favorites {
  background: none;
  border: 1px solid #475569;
  color: #cbd5e1;
  cursor: pointer;
  font-size: 11px;
  padding: 4px 8px;
  border-radius: 6px;
  transition: all 0.2s ease;
}
#skirk-clear-favorites:hover {
  color: #ef4444;
  background: rgba(239, 68, 68, 0.1);
}
#skirk-favorites-list {
  max-height: 200px;
  overflow-y: auto;
}
.skirk-favorites-filter {
  width: 100%;
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid #475569;
  background: #0b1222;
  color: #f1f5f9;
  font: 12px monospace;
  margin: 8px 0 6px 0;
  transition: all 0.2s ease;
}
.skirk-favorites-filter:focus {
  outline: none;
  border-color: #3b82f6;
  box-shadow: 0 0 0 3px rgba(59,130,246,0.12);
}
.skirk-favorite-item {
  padding: 10px;
  cursor: pointer;
  border-radius: 8px;
  margin-bottom: 4px;
  transition: all 0.2s ease;
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.skirk-favorite-item:hover {
  background: rgba(51, 65, 85, 0.55);
}
.skirk-favorite-item .skirk-result-content {
  flex: 1;
}
.skirk-favorite-item .skirk-result-name {
  font-size: 13px;
  margin-bottom: 2px;
}
.skirk-favorite-item .skirk-result-address {
  font-size: 11px;
}
.skirk-favorite-remove {
  color: #94a3b8;
  font-size: 14px;
  cursor: pointer;
  padding: 4px 6px;
  border-radius: 6px;
  transition: all 0.2s ease;
}
.skirk-favorite-remove:hover {
  color: #ef4444;
  background: rgba(239, 68, 68, 0.1);
}

/* Custom Location Modal */
#skirk-location-modal {
  position: fixed;
  top: 0; left: 0; right: 0; bottom: 0;
  background: rgba(0, 0, 0, 0.7);
  z-index: 2147483647;
  display: none;
  align-items: center;
  justify-content: center;
}
#skirk-location-dialog {
  background: rgba(30,41,59,0.96);
  color: #f1f5f9;
  border-radius: 14px;
  border: 1px solid #334155;
  padding: 20px;
  min-width: 420px;
  max-width: 90vw;
  box-shadow: 0 25px 50px -12px rgba(0,0,0,0.7), 0 0 0 1px rgba(255,255,255,0.05);
  backdrop-filter: blur(12px);
}
#skirk-location-dialog h3 {
  margin: 0 0 16px 0;
  color: #f1f5f9;
  font-size: 18px;
}
#skirk-location-dialog .form-group {
  margin-bottom: 16px;
}
#skirk-location-dialog label {
  display: block;
  margin-bottom: 4px;
  color: #cbd5e1;
  font-size: 14px;
  font-weight: 500;
}
#skirk-location-dialog input {
  width: 100%;
  padding: 10px 12px;
  border: 1px solid #475569;
  background: #0b1222;
  color: #f1f5f9;
  border-radius: 10px;
  font: 14px monospace;
  transition: all 0.2s ease;
}
#skirk-location-dialog input:focus {
  outline: none;
  border-color: #3b82f6;
  box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.18);
}
#skirk-location-dialog input[readonly] {
  background: #0a0e1a;
  border-color: #374151;
  color: #9ca3af;
  cursor: not-allowed;
}
#skirk-location-dialog input[readonly]:focus {
  border-color: #374151;
  box-shadow: none;
}
#skirk-location-dialog .button-group {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  margin-top: 20px;
}
#skirk-location-dialog button {
  padding: 10px 16px;
  border: 1px solid #475569;
  border-radius: 8px;
  font: 14px monospace;
  cursor: pointer;
  transition: all 0.2s ease;
}
#skirk-location-dialog .btn-primary {
  background: #3b82f6;
  color: #fff;
}
#skirk-location-dialog .btn-primary:hover {
  background: #2563eb;
}
#skirk-location-dialog .btn-secondary {
  background: #334155;
  color: #f1f5f9;
}
#skirk-location-dialog .btn-secondary:hover {
  background: #475569;
}


`;

GM_addStyle(searchWindowCSS);

// Imports the Roboto Mono font family
let robotoStylesheetLink = document.createElement('link');
robotoStylesheetLink.href = 'https://fonts.googleapis.com/css2?family=Roboto+Mono:ital,wght@0,100..700;1,100..700&display=swap';
robotoStylesheetLink.rel = 'preload';
robotoStylesheetLink.as = 'style';
robotoStylesheetLink.onload = function () {
  this.onload = null;
  this.rel = 'stylesheet';
};
document.head?.appendChild(robotoStylesheetLink);

// Imports the Outfit font family
let outfitStylesheetLink = document.createElement('link');
outfitStylesheetLink.href = 'https://fonts.googleapis.com/css2?family=Outfit:wght@100..900&display=swap';
outfitStylesheetLink.rel = 'preload';
outfitStylesheetLink.as = 'style';
outfitStylesheetLink.onload = function () {
  this.onload = null;
  this.rel = 'stylesheet';
};
document.head?.appendChild(outfitStylesheetLink);

// CONSTRUCTORS
const observers = new Observers(); // Constructs a new Observers object
const overlayMain = new Overlay(name, version); // Constructs a new Overlay object for the main overlay
const overlayTabTemplate = new Overlay(name, version); // Constructs a Overlay object for the template tab
const templateManager = new TemplateManager(name, version, overlayMain); // Constructs a new TemplateManager object

// Initialize error map mode from storage
templateManager.setErrorMapMode(getErrorMapEnabled());
const apiManager = new ApiManager(templateManager); // Constructs a new ApiManager object

overlayMain.setApiManager(apiManager); // Sets the API manager

// Load wrong color settings
templateManager.loadWrongColorSettings();

// Load smart detection settings
import { getSmartDetectionEnabled } from './settingsManager.js';
templateManager.setSmartDetectionEnabled(getSmartDetectionEnabled());

// Load templates with fallback system - FIXED CRITICAL BUG
async function loadTemplates() {
  let storageTemplates = {};
  let storageSource = 'none';
  
  debugLog('Loading templates from storage...');
  
  // Try TamperMonkey storage first with enhanced error handling
  try {
    if (typeof GM !== 'undefined' && GM.getValue) {
      // Check if data is chunked
      const chunkCount = await GM.getValue('bmTemplates_chunkCount', 0);
      let data;
      
      if (chunkCount > 0) {
        debugLog(`Loading ${chunkCount} TM chunks...`);
        // Load chunked data with validation
        let combinedData = '';
        let corruptedChunks = 0;
        
        for (let i = 0; i < chunkCount; i++) {
          const chunk = await GM.getValue(`bmTemplates_part_${i}`, '');
          if (!chunk) {
            corruptedChunks++;
            console.error(`❌ Missing TM chunk ${i}/${chunkCount}`);
          } else {
            combinedData += chunk;
          }
        }
        
        if (corruptedChunks > 0) {
          throw new Error(`TM data corrupted: ${corruptedChunks}/${chunkCount} chunks missing`);
        }
        
        data = combinedData;
        debugLog(`TM chunked data loaded: ${data.length} chars`);
      } else {
        // Load regular single data
        data = await GM.getValue('bmTemplates', '{}');
        debugLog(`TM single data loaded: ${data.length} chars`);
      }
      
      // Validate JSON before parsing
      if (!data || data === '{}' || data === '') {
        storageTemplates = {};
        storageSource = 'TamperMonkey (empty)';
      } else {
        try {
          storageTemplates = JSON.parse(data);
          // Validate structure
          if (!storageTemplates || typeof storageTemplates !== 'object') {
            throw new Error('Invalid template structure');
          }
          if (!storageTemplates.templates) {
            storageTemplates.templates = {};
          }
          storageSource = 'TamperMonkey (async)';
          debugLog(`TM templates loaded: ${Object.keys(storageTemplates.templates || {}).length} templates`);
        } catch (parseError) {
          console.error('❌ TM JSON parse failed:', parseError);
          throw parseError;
        }
      }
    } else if (typeof GM_getValue !== 'undefined') {
      // Check if data is chunked (legacy)
      const chunkCount = GM_getValue('bmTemplates_chunkCount', 0);
      let data;
      
      if (chunkCount > 0) {
        debugLog(`Loading ${chunkCount} TM legacy chunks...`);
        // Load chunked data with validation
        let combinedData = '';
        let corruptedChunks = 0;
        
        for (let i = 0; i < chunkCount; i++) {
          const chunk = GM_getValue(`bmTemplates_part_${i}`, '');
          if (!chunk) {
            corruptedChunks++;
            console.error(`❌ Missing TM legacy chunk ${i}/${chunkCount}`);
          } else {
            combinedData += chunk;
          }
        }
        
        if (corruptedChunks > 0) {
          throw new Error(`TM legacy data corrupted: ${corruptedChunks}/${chunkCount} chunks missing`);
        }
        
        data = combinedData;
        debugLog(`TM legacy chunked data loaded: ${data.length} chars`);
      } else {
        // Load regular single data
        data = GM_getValue('bmTemplates', '{}');
        debugLog(`TM legacy single data loaded: ${data.length} chars`);
      }
      
      // Validate JSON before parsing
      if (!data || data === '{}' || data === '') {
        storageTemplates = {};
        storageSource = 'TamperMonkey (legacy, empty)';
      } else {
        try {
          storageTemplates = JSON.parse(data);
          // Validate structure
          if (!storageTemplates || typeof storageTemplates !== 'object') {
            throw new Error('Invalid template structure');
          }
          if (!storageTemplates.templates) {
            storageTemplates.templates = {};
          }
          storageSource = 'TamperMonkey (legacy)';
          debugLog(`TM legacy templates loaded: ${Object.keys(storageTemplates.templates || {}).length} templates`);
        } catch (parseError) {
          console.error('❌ TM legacy JSON parse failed:', parseError);
          throw parseError;
        }
      }
    }
  } catch (error) {
    console.error('❌ TamperMonkey storage load failed:', error);
    
    // Fallback to localStorage with enhanced error handling
    try {
      debugLog('Falling back to localStorage...');
      const lsChunkCount = parseInt(localStorage.getItem('bmTemplates_chunkCount') || '0');
      let data;
      
      if (lsChunkCount > 0) {
        debugLog(`Loading ${lsChunkCount} LS chunks...`);
        // Load chunked data with validation
        let combinedData = '';
        let corruptedChunks = 0;
        
        for (let i = 0; i < lsChunkCount; i++) {
          const chunk = localStorage.getItem(`bmTemplates_part_${i}`) || '';
          if (!chunk) {
            corruptedChunks++;
            console.error(`❌ Missing LS chunk ${i}/${lsChunkCount}`);
          } else {
            combinedData += chunk;
          }
        }
        
        if (corruptedChunks > 0) {
          throw new Error(`LS data corrupted: ${corruptedChunks}/${lsChunkCount} chunks missing`);
        }
        
        data = combinedData;
        debugLog(`LS chunked data loaded: ${data.length} chars`);
      } else {
        data = localStorage.getItem('bmTemplates') || '{}';
        debugLog(`LS single data loaded: ${data.length} chars`);
      }
      
      // Validate JSON before parsing
      if (!data || data === '{}' || data === '') {
        storageTemplates = {};
        storageSource = 'localStorage (empty)';
      } else {
        try {
          storageTemplates = JSON.parse(data);
          // Validate structure
          if (!storageTemplates || typeof storageTemplates !== 'object') {
            throw new Error('Invalid template structure');
          }
          if (!storageTemplates.templates) {
            storageTemplates.templates = {};
          }
          storageSource = 'localStorage (fallback)';
          debugLog(`LS templates loaded: ${Object.keys(storageTemplates.templates || {}).length} templates`);
        } catch (parseError) {
          console.error('❌ LS JSON parse failed:', parseError);
          throw parseError;
        }
      }
    } catch (fallbackError) {
      console.error('❌ All storage methods failed:', fallbackError);
      
      // Last resort: try to salvage any valid data
      debugLog('Attempting emergency data recovery...');
      try {
        await attemptEmergencyRecovery();
        storageTemplates = {};
        storageSource = 'emergency recovery (empty)';
      } catch (recoveryError) {
        console.error('❌ Emergency recovery failed:', recoveryError);
        storageTemplates = {};
        storageSource = 'empty (all failed)';
      }
    }
  }
  
  // Minimal debug logging for performance
  const templateCount = Object.keys(storageTemplates?.templates || {}).length;
  
  if (templateCount === 0 && storageSource !== 'empty (all failed)') {
    console.warn('⚠️ No templates found but storage source was available');
    
    // Try to recover from backup or alternative storage
    try {
      // Check if there's a backup in the other storage system
      let backupData = {};
      
      if (storageSource.includes('TamperMonkey')) {
        // Try localStorage as backup
        const lsBackup = localStorage.getItem('bmTemplates');
        if (lsBackup) {
          backupData = JSON.parse(lsBackup);
        }
      } else {
        // Try TamperMonkey as backup
        let tmBackup = null;
        if (typeof GM_getValue !== 'undefined') {
          tmBackup = GM_getValue('bmTemplates', null);
        }
        if (tmBackup) {
          backupData = JSON.parse(tmBackup);
        }
      }
      
      const backupCount = Object.keys(backupData?.templates || {}).length;
      if (backupCount > 0) {
        storageTemplates = backupData;
        // Save recovered data to both storages (removed setTimeout for performance)
        templateManager.updateTemplateWithColorFilter().catch(e => console.warn('Template color filter update failed:', e));
      }
    } catch (recoveryError) {
      console.error('Recovery failed:', recoveryError);
    }
  }
  
  // Enhanced template loading with recovery
  try {
    templateManager.importJSON(storageTemplates); // Loads the templates
    debugLog(`Templates imported successfully from ${storageSource}`);
    
    if (templateCount === 0) {
      debugLog('ℹ️ No templates loaded - start by creating a new template');
    } else {
      debugLog(`Loaded ${templateCount} templates from ${storageSource}`);
    }
    
    // Update Color Menu after templates are loaded
    setTimeout(() => {
      if (typeof clearColorMenuCache === 'function') {
        clearColorMenuCache();
      }
      if (typeof updateColorMenuDisplay === 'function') {
        updateColorMenuDisplay(true, true);
        debugLog('Color Menu initialized after template load');
      }
    }, 500);
    
  } catch (importError) {
    console.error('Template import failed:', importError);
    
    // Try to recover by creating fresh template structure
    try {
      debugLog('Attempting template recovery...');
      const freshTemplates = {
        whoami: 'BlueMarble',
        scriptVersion: '0.89.6',
        schemaVersion: '2.1.0',
        templates: {},
        lastModified: new Date().toISOString(),
        templateCount: 0,
        totalPixels: 0
      };
      
      templateManager.importJSON(freshTemplates);
      debugLog('Template recovery successful - fresh start');
    } catch (recoveryError) {
      console.error('❌ Template recovery failed:', recoveryError);
      throw recoveryError;
    }
  }
}

// Emergency data recovery function
async function attemptEmergencyRecovery() {
  debugLog('Starting emergency data recovery...');
  
  // Clean up any corrupted storage keys
  try {
    // Clear TamperMonkey
    if (typeof GM !== 'undefined' && GM.deleteValue) {
      const tmKeys = ['bmTemplates', 'bmTemplates_timestamp', 'bmTemplates_chunkCount'];
      for (const key of tmKeys) {
        try { await GM.deleteValue(key); } catch (_) {}
      }
      
      // Clear potential chunks (up to 50)
      for (let i = 0; i < 50; i++) {
        try { await GM.deleteValue(`bmTemplates_part_${i}`); } catch (_) {}
      }
    }
    
    // Clear localStorage
    const lsKeys = ['bmTemplates', 'bmTemplates_timestamp', 'bmTemplates_chunkCount'];
    for (const key of lsKeys) {
      try { localStorage.removeItem(key); } catch (_) {}
    }
    
    // Clear potential chunks (up to 50)
    for (let i = 0; i < 50; i++) {
      try { localStorage.removeItem(`bmTemplates_part_${i}`); } catch (_) {}
    }
    
    debugLog('Emergency cleanup completed');
    
  } catch (e) {
    console.error('❌ Emergency cleanup failed:', e);
    throw e;
  }
}

// Storage migration and validation - FIXED CRITICAL BUG
async function migrateAndValidateStorage() {
  try {
    debugLog('Starting storage migration and validation...');
    
    // Check if we have data in both storages
    let tmData = null;
    let lsData = null;
    let tmTimestamp = 0;
    let lsTimestamp = 0;
    let tmChunked = false;
    let lsChunked = false;
    
    // Get TamperMonkey data with validation
    try {
      if (typeof GM !== 'undefined' && GM.getValue) {
        // Check if data is chunked
        const chunkCount = await GM.getValue('bmTemplates_chunkCount', 0);
        if (chunkCount > 0) {
          debugLog(`Loading ${chunkCount} TM chunks...`);
          // Load chunked data with validation
          let combinedData = '';
          let missingChunks = 0;
          
          for (let i = 0; i < chunkCount; i++) {
            const chunk = await GM.getValue(`bmTemplates_part_${i}`, '');
            if (!chunk) {
              missingChunks++;
              console.warn(`⚠️ Missing TM chunk ${i}/${chunkCount}`);
            } else {
              combinedData += chunk;
            }
          }
          
          if (missingChunks > 0) {
            console.error(`❌ TM data corruption: ${missingChunks}/${chunkCount} chunks missing`);
            tmData = null; // Mark as corrupted
          } else {
            tmData = combinedData;
            tmChunked = true;
            debugLog(`TM chunked data loaded: ${combinedData.length} chars`);
          }
        } else {
          tmData = await GM.getValue('bmTemplates', null);
          debugLog(`TM single data loaded: ${tmData ? tmData.length : 0} chars`);
        }
        tmTimestamp = await GM.getValue('bmTemplates_timestamp', 0);
      } else if (typeof GM_getValue !== 'undefined') {
        // Check if data is chunked (legacy)
        const chunkCount = GM_getValue('bmTemplates_chunkCount', 0);
        if (chunkCount > 0) {
          debugLog(`Loading ${chunkCount} TM legacy chunks...`);
          // Load chunked data with validation
          let combinedData = '';
          let missingChunks = 0;
          
          for (let i = 0; i < chunkCount; i++) {
            const chunk = GM_getValue(`bmTemplates_part_${i}`, '');
            if (!chunk) {
              missingChunks++;
              console.warn(`⚠️ Missing TM legacy chunk ${i}/${chunkCount}`);
            } else {
              combinedData += chunk;
            }
          }
          
          if (missingChunks > 0) {
            console.error(`❌ TM legacy data corruption: ${missingChunks}/${chunkCount} chunks missing`);
            tmData = null; // Mark as corrupted
          } else {
            tmData = combinedData;
            tmChunked = true;
            debugLog(`TM legacy chunked data loaded: ${combinedData.length} chars`);
          }
        } else {
          tmData = GM_getValue('bmTemplates', null);
          debugLog(`TM legacy single data loaded: ${tmData ? tmData.length : 0} chars`);
        }
        tmTimestamp = GM_getValue('bmTemplates_timestamp', 0);
      }
    } catch (e) { 
      console.error('❌ TM check failed:', e);
      tmData = null;
    }
    
    // Get localStorage data with validation
    try {
      const lsChunkCount = parseInt(localStorage.getItem('bmTemplates_chunkCount') || '0');
      if (lsChunkCount > 0) {
        debugLog(`Loading ${lsChunkCount} LS chunks...`);
        // Load chunked data with validation
        let combinedData = '';
        let missingChunks = 0;
        
        for (let i = 0; i < lsChunkCount; i++) {
          const chunk = localStorage.getItem(`bmTemplates_part_${i}`) || '';
          if (!chunk) {
            missingChunks++;
            console.warn(`⚠️ Missing LS chunk ${i}/${lsChunkCount}`);
          } else {
            combinedData += chunk;
          }
        }
        
        if (missingChunks > 0) {
          console.error(`❌ LS data corruption: ${missingChunks}/${lsChunkCount} chunks missing`);
          lsData = null; // Mark as corrupted
        } else {
          lsData = combinedData;
          lsChunked = true;
          debugLog(`LS chunked data loaded: ${combinedData.length} chars`);
        }
      } else {
        lsData = localStorage.getItem('bmTemplates');
        debugLog(`LS single data loaded: ${lsData ? lsData.length : 0} chars`);
      }
      lsTimestamp = parseInt(localStorage.getItem('bmTemplates_timestamp') || '0');
    } catch (e) { 
      console.error('❌ LS check failed:', e);
      lsData = null;
    }
    
    // Validate JSON data before proceeding
    let tmValid = false;
    let lsValid = false;
    
    if (tmData) {
      try {
        const parsed = JSON.parse(tmData);
        if (parsed && typeof parsed === 'object' && parsed.templates) {
          tmValid = true;
          debugLog(`TM data is valid JSON with ${Object.keys(parsed.templates).length} templates`);
        } else {
          console.warn('⚠️ TM data is not a valid template structure');
        }
      } catch (e) {
        console.error('❌ TM data is not valid JSON:', e);
        tmData = null;
      }
    }
    
    if (lsData) {
      try {
        const parsed = JSON.parse(lsData);
        if (parsed && typeof parsed === 'object' && parsed.templates) {
          lsValid = true;
          debugLog(`LS data is valid JSON with ${Object.keys(parsed.templates).length} templates`);
        } else {
          console.warn('⚠️ LS data is not a valid template structure');
        }
      } catch (e) {
        console.error('❌ LS data is not valid JSON:', e);
        lsData = null;
      }
    }
    
    // Clean up corrupted data
    if (!tmValid && tmData) {
      console.warn('🧹 Cleaning up corrupted TM data...');
      await cleanupCorruptedStorage('tm');
      tmData = null;
      tmTimestamp = 0;
    }
    
    if (!lsValid && lsData) {
      console.warn('🧹 Cleaning up corrupted LS data...');
      await cleanupCorruptedStorage('ls');
      lsData = null;
      lsTimestamp = 0;
    }
    
    // If we have valid data in both, use the most recent
    if (tmValid && lsValid && tmTimestamp !== lsTimestamp) {
      debugLog(`Data sync: TM(${new Date(tmTimestamp).toLocaleString()}) vs LS(${new Date(lsTimestamp).toLocaleString()})`);
      
      if (tmTimestamp > lsTimestamp) {
        // TamperMonkey is newer, update localStorage
        debugLog('Syncing TM → LS...');
        try {
          if (tmData.length > 900000) {
            // Store as chunks in LS
            await storeDataChunked('ls', tmData, tmTimestamp);
          } else {
            localStorage.setItem('bmTemplates', tmData);
            localStorage.setItem('bmTemplates_timestamp', tmTimestamp.toString());
            // Clean up any existing chunks
            const oldChunkCount = parseInt(localStorage.getItem('bmTemplates_chunkCount') || '0');
            for (let i = 0; i < oldChunkCount; i++) {
              localStorage.removeItem(`bmTemplates_part_${i}`);
            }
            localStorage.removeItem('bmTemplates_chunkCount');
          }
          debugLog('LS updated from TM');
        } catch (e) {
          console.error('❌ Failed to sync TM → LS:', e);
        }
      } else if (lsTimestamp > tmTimestamp) {
        // localStorage is newer, update TamperMonkey
        debugLog('Syncing LS → TM...');
        try {
          if (typeof GM !== 'undefined' && GM.setValue) {
            if (lsData.length > 900000) {
              // Store as chunks in TM
              await storeDataChunked('tm', lsData, lsTimestamp);
            } else {
              await GM.setValue('bmTemplates', lsData);
              await GM.setValue('bmTemplates_timestamp', lsTimestamp);
              // Clean up any existing chunks
              const oldChunkCount = await GM.getValue('bmTemplates_chunkCount', 0);
              for (let i = 0; i < oldChunkCount; i++) {
                try { await GM.deleteValue(`bmTemplates_part_${i}`); } catch (_) {}
              }
              try { await GM.deleteValue('bmTemplates_chunkCount'); } catch (_) {}
            }
          } else if (typeof GM_setValue !== 'undefined') {
            GM_setValue('bmTemplates', lsData);
            GM_setValue('bmTemplates_timestamp', lsTimestamp);
          }
          debugLog('TM updated from LS');
        } catch (e) {
          console.error('❌ Failed to sync LS → TM:', e);
        }
      }
    }
    
    debugLog('Storage migration completed');
    
  } catch (error) {
    console.error('❌ Storage migration failed:', error);
  }
}

// Helper function to clean up corrupted storage
async function cleanupCorruptedStorage(storageType) {
  try {
    if (storageType === 'tm') {
      if (typeof GM !== 'undefined' && GM.deleteValue) {
        try { await GM.deleteValue('bmTemplates'); } catch (_) {}
        try { await GM.deleteValue('bmTemplates_timestamp'); } catch (_) {}
        const chunkCount = await GM.getValue('bmTemplates_chunkCount', 0);
        for (let i = 0; i < chunkCount; i++) {
          try { await GM.deleteValue(`bmTemplates_part_${i}`); } catch (_) {}
        }
        try { await GM.deleteValue('bmTemplates_chunkCount'); } catch (_) {}
      }
    } else if (storageType === 'ls') {
      try { localStorage.removeItem('bmTemplates'); } catch (_) {}
      try { localStorage.removeItem('bmTemplates_timestamp'); } catch (_) {}
      const chunkCount = parseInt(localStorage.getItem('bmTemplates_chunkCount') || '0');
      for (let i = 0; i < chunkCount; i++) {
        try { localStorage.removeItem(`bmTemplates_part_${i}`); } catch (_) {}
      }
      try { localStorage.removeItem('bmTemplates_chunkCount'); } catch (_) {}
    }
    debugLog(`Cleaned up corrupted ${storageType.toUpperCase()} storage`);
  } catch (e) {
    console.error(`❌ Failed to cleanup ${storageType.toUpperCase()} storage:`, e);
  }
}

// Helper function to store data in chunks
async function storeDataChunked(storageType, data, timestamp) {
  const CHUNK_SIZE = 900000;
  const parts = Math.ceil(data.length / CHUNK_SIZE);
  
  if (storageType === 'tm') {
    if (typeof GM !== 'undefined' && GM.setValue) {
      // Clear single key first
      try { await GM.deleteValue('bmTemplates'); } catch (_) {}
      await GM.setValue('bmTemplates_chunkCount', parts);
      for (let i = 0; i < parts; i++) {
        const slice = data.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
        await GM.setValue(`bmTemplates_part_${i}`, slice);
      }
      await GM.setValue('bmTemplates_timestamp', timestamp);
    }
  } else if (storageType === 'ls') {
    // Clear single key first
    try { localStorage.removeItem('bmTemplates'); } catch (_) {}
    localStorage.setItem('bmTemplates_chunkCount', String(parts));
    for (let i = 0; i < parts; i++) {
      const slice = data.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
      localStorage.setItem(`bmTemplates_part_${i}`, slice);
    }
    localStorage.setItem('bmTemplates_timestamp', timestamp.toString());
  }
}



// Load templates on startup - run migration first to ensure data consistency, then load
migrateAndValidateStorage()
  .then(() => loadTemplates())
  .catch(error => console.error('Template loading failed:', error));

buildOverlayMain(); // Builds the main overlay

// Pause tiles functionality is now integrated into the main UI through buildOverlayMain()

// Initialize tile refresh pause system
initializeTileRefreshPause(templateManager);

// Initialize mini tracker after a short delay to ensure DOM is ready
setTimeout(() => {
  updateMiniTracker();
}, 100);

// Function to apply drag mode based on user setting
function applyDragMode(fullOverlayDrag = true) {
  // Remove any existing drag handlers by creating a new overlay instance if needed
  // The overlay class doesn't have a method to remove handlers, so we'll just set up the correct one
  if (fullOverlayDrag) {
    overlayMain.handleDrag('#bm-overlay', '#bm-overlay'); // Full overlay drag
  } else {
    overlayMain.handleDrag('#bm-overlay', '#bm-bar-drag'); // Drag bar only
  }
}

// Initialize drag mode based on saved setting
const dragModeEnabled = getDragModeEnabled();
applyDragMode(dragModeEnabled);

apiManager.spontaneousResponseListener(overlayMain); // Reads spontaneous fetch responces

observeBlack(); // Observes the black palette color
observeOpacityButton(); // Observes and adds the Map button above opacity button

// Initialize keyboard shortcuts
initializeKeyboardShortcuts();

// Add styles for full charge element
if (!document.getElementById('bm-fullcharge-styles')) {
  const style = document.createElement('style');
  style.id = 'bm-fullcharge-styles';
  style.textContent = `
    #bm-user-fullcharge {
      display: flex;
      align-items: center;
    }
    #bm-user-fullcharge-icon {
      margin-right: 0px;
    }
    #bm-user-fullcharge-content {
      margin: 0;
      flex: 1;
    }
  `;
  document.head.appendChild(style);
}

debugLog(`%c${name}%c (${version}) userscript has loaded!`, 'color: cornflowerblue;', '');

/** Observe the black color, and add the "Move" button.
 * @since 0.66.3
 */
function observeBlack() {
  const observer = new MutationObserver((mutations, observer) => {

    const black = document.querySelector('#color-1'); // Attempt to retrieve the black color element for anchoring

    if (!black) {return;} // Black color does not exist yet. Kills iteself

    let move = document.querySelector('#bm-button-move'); // Tries to find the move button

    // If the move button does not exist, we make a new one
    if (!move) {
      move = document.createElement('button');
      move.id = 'bm-button-move';
      move.textContent = 'Move ↑';
      move.className = 'btn btn-soft';
      move.onclick = function() {
        const roundedBox = this.parentNode.parentNode.parentNode.parentNode; // Obtains the rounded box
        const shouldMoveUp = (this.textContent == 'Move ↑');
        roundedBox.parentNode.className = roundedBox.parentNode.className.replace(shouldMoveUp ? 'bottom' : 'top', shouldMoveUp ? 'top' : 'bottom'); // Moves the rounded box to the top
        roundedBox.style.borderTopLeftRadius = shouldMoveUp ? '0px' : 'var(--radius-box)';
        roundedBox.style.borderTopRightRadius = shouldMoveUp ? '0px' : 'var(--radius-box)';
        roundedBox.style.borderBottomLeftRadius = shouldMoveUp ? 'var(--radius-box)' : '0px';
        roundedBox.style.borderBottomRightRadius = shouldMoveUp ? 'var(--radius-box)' : '0px';
        this.textContent = shouldMoveUp ? 'Move ↓' : 'Move ↑';
      }

      // Attempts to find the "Paint Pixel" element for anchoring
      const paintPixel = black.parentNode.parentNode.parentNode.parentNode.querySelector('h2');

      paintPixel.parentNode?.appendChild(move); // Adds the move button
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });
}

/** Observes and adds the Map button above the opacity button
 * @since 1.0.0
 */
function observeOpacityButton() {
  const observer = new MutationObserver(() => {
    // Look for the opacity button (supports both languages)
    const opacityButton = document.querySelector('button[title="Toggle art opacity"], button[title="Alterar opacidade"]');
    if (!opacityButton) return;
    
    // Check if we already added our Map button container
    let mapButtonContainer = document.querySelector('#bm-map-button-container');
    if (mapButtonContainer) return;
    
    // Get the container div (absolute bottom-3 left-3 z-30)
    const opacityContainer = opacityButton.closest('.absolute.bottom-3.left-3.z-30');
    if (!opacityContainer) return;
    
    // Create a new container for the Map button positioned above the opacity button
    mapButtonContainer = document.createElement('div');
    mapButtonContainer.id = 'bm-map-button-container';
    mapButtonContainer.className = 'fixed z-30';
    mapButtonContainer.style.cssText = `
      display: flex;
      flex-direction: column;
      gap: 8px;
      bottom: 230px;
      left: 12px;
    `;
    
    // Create the Wrong Pixels button (above Error Map button)
    const wrongPixelsButton = document.createElement('button');
    wrongPixelsButton.id = 'bm-button-wrong-pixels';
    wrongPixelsButton.innerHTML = '❌';
    wrongPixelsButton.className = 'btn btn-lg btn-square sm:btn-xl z-30 shadow-md text-base-content/80';
    wrongPixelsButton.title = 'View Wrong Pixels Coordinates';
    
    wrongPixelsButton.onclick = function() {
      showWrongPixelsDialog(overlayMain);
    };
    
    // Create the Map button
    const mapButton = document.createElement('button');
    mapButton.id = 'bm-button-map-positioned';
    mapButton.innerHTML = '🗺️';
    mapButton.className = 'btn btn-lg btn-square sm:btn-xl z-30 shadow-md text-base-content/80';
    mapButton.title = 'Error Map View';
    
    // Initialize button appearance based on saved state
    const initialState = getErrorMapEnabled();
    if (initialState) {
      mapButton.style.background = 'linear-gradient(135deg, #10b981, #059669)';
      mapButton.style.color = 'white';
    }
    
    mapButton.onclick = function() {
      toggleErrorMapMode();
      const isEnabled = getErrorMapEnabled();
      if (isEnabled) {
        this.style.background = 'linear-gradient(135deg, #10b981, #059669)';
        this.style.color = 'white';
      } else {
        this.style.background = '';
        this.style.color = '';
      }
      overlayMain.handleDisplayStatus(`Error Map ${isEnabled ? 'enabled' : 'disabled'}! ${isEnabled ? 'Green=correct, Red=wrong pixels' : 'Back to normal view'}`);
    };
    
    // Add the buttons to our container
    mapButtonContainer.appendChild(wrongPixelsButton);
    mapButtonContainer.appendChild(mapButton);
    
    // Insert the Map button container directly into the body with fixed positioning
    document.body.appendChild(mapButtonContainer);
  });

  observer.observe(document.body, { childList: true, subtree: true });
}

/** Deletes all templates from storage with confirmation dialog
 * @param {Object} instance - The overlay instance
 * @since 1.0.0
 */
function deleteAllTemplates(instance) {
  // Get current template count for confirmation message
  const templateCount = templateManager?.templatesArray?.length || 0;
  const templateText = templateCount === 1 ? 'template' : 'templates';
  
  // Show confirmation dialog
  const confirmMessage = templateCount > 0 
    ? `Are you sure you want to delete all ${templateCount} ${templateText}?\n\nThis action cannot be undone!`
    : 'No templates found to delete.';
  
  if (templateCount === 0) {
    showCustomConfirmDialog(
      'No Templates Found',
      'No templates found to delete.',
      null, // No confirm action needed
      () => {
        instance.handleDisplayStatus('No templates to delete');
      }
    );
    return;
  }
  
  // Use custom confirmation dialog instead of native confirm
  showCustomConfirmDialog(
    'Delete All Templates?',
    confirmMessage,
    () => {
      // This is the confirmation callback - execute the deletion logic
      performDeleteAllTemplates(instance, templateCount, templateText);
    },
    () => {
      // This is the cancel callback
      instance.handleDisplayStatus('Template deletion cancelled');
    }
  );
}

/** Performs the actual deletion of all templates (extracted from deleteAllTemplates)
 * @param {Object} instance - The overlay instance
 * @param {number} templateCount - Number of templates to delete
 * @param {string} templateText - Singular/plural text for templates
 * @since 1.0.0
 */
function performDeleteAllTemplates(instance, templateCount, templateText) {
  try {
    // Clear templates from memory
    if (templateManager) {
      templateManager.templatesArray = [];
      templateManager.templatesJSON = {
        whoami: templateManager.templatesJSON?.whoami || null,
        templates: {}
      };
    }
    
    // Clear from TamperMonkey storage
    try {
      if (typeof GM !== 'undefined' && GM.deleteValue) {
        GM.deleteValue('bmTemplates');
        GM.deleteValue('bmTemplates_timestamp');
      } else if (typeof GM_deleteValue !== 'undefined') {
        GM_deleteValue('bmTemplates');
        GM_deleteValue('bmTemplates_timestamp');
      }
    } catch (error) {
      console.warn('⚠️ Failed to clear TamperMonkey storage:', error);
    }
    
    // Clear from localStorage
    try {
      localStorage.removeItem('bmTemplates');
      localStorage.removeItem('bmTemplates_timestamp');
    } catch (error) {
      console.warn('⚠️ Failed to clear localStorage:', error);
    }
    
    // Force refresh template display to clear any visual templates
    if (typeof refreshTemplateDisplay === 'function') {
      refreshTemplateDisplay().catch(error => {
        console.warn('Warning: Failed to refresh template display:', error);
      });
    }
    
    // Update mini tracker to reflect empty state
    if (typeof updateMiniTracker === 'function') {
      updateMiniTracker();
    }
    
    // Close Color Filter overlay if open
    const existingColorFilterOverlay = document.getElementById('bm-color-filter-overlay');
    if (existingColorFilterOverlay) {
      existingColorFilterOverlay.remove();
    }
    
    instance.handleDisplayStatus(`Successfully deleted all ${templateCount} ${templateText}!`);
    debugLog(`🗑️ Deleted all ${templateCount} templates from storage`);
    
  } catch (error) {
    console.error('❌ Failed to delete templates:', error);
    instance.handleDisplayError('Failed to delete templates. Check console for details.');
  }
}

/** Clears all Blue Marble related storage data with confirmation
 * @param {Object} instance - The overlay instance
 * @since 1.0.0
 */
function clearAllStorage(instance) {
  showCustomConfirmDialog(
    'Clear All Storage?',
    `This will delete ALL Blue Marble data including:\n\n• Templates\n• Settings\n• Color filters\n• Crosshair preferences\n• All cached data\n\nThis action cannot be undone!\n\nAre you sure?`,
    () => {
      try {
        // List of all Blue Marble storage keys
        const bmStorageKeys = [
          // Templates
          'bmTemplates',
          'bmTemplates_timestamp',
          
          // Settings
          'bmErrorMap',
          'bmCrosshairColor',
          'bmCrosshairBorder',
          'bmCrosshairEnhancedSize',
          'bmCrosshairRadius',
          'bmCrosshairThickness',
          'bmMiniTracker',
          'bmCollapseMin',
          'bmMobileMode',
          'bmTileRefreshPaused',
          'bmShowLeftOnColor',
          'bmShowWrongOnColor',
          'bmQuickfillEnabled',
          'bmQuickfillPixels',
          'bmQuickfillSelectedColor',
          
          // Color filters
          'bmcf-excluded-colors',
          'bmcf-excluded-colors-pending',
          'bmcf-view-preference',
          
          // Enhanced mode
          'bmEnhanceWrongColors'
        ];
        
        let deletedCount = 0;
        
        // Clear localStorage
        bmStorageKeys.forEach(key => {
          if (localStorage.getItem(key) !== null) {
            localStorage.removeItem(key);
            deletedCount++;
          }
        });
        
        // Clear TamperMonkey storage (if available)
        if (typeof GM_deleteValue !== 'undefined') {
          bmStorageKeys.forEach(key => {
            try {
              GM_deleteValue(key);
            } catch (e) {
              // Key might not exist, ignore
            }
          });
        }
        
        // Clear async GM storage (if available)
        if (typeof GM !== 'undefined' && GM.deleteValue) {
          bmStorageKeys.forEach(async (key) => {
            try {
              await GM.deleteValue(key);
            } catch (e) {
              // Key might not exist, ignore
            }
          });
        }
        
        // Clear template manager data
        if (templateManager) {
          templateManager.templatesJSON = null;
          templateManager.templatesArray = [];
          templateManager.templatesShouldBeDrawn = false;
        }
        
        // Clear any remaining Blue Marble related session storage
        try {
          Object.keys(sessionStorage).forEach(key => {
            if (key.toLowerCase().includes('bm') || key.toLowerCase().includes('bluemarble')) {
              sessionStorage.removeItem(key);
            }
          });
        } catch (e) {
          console.warn('Could not clear session storage:', e);
        }
        
        instance.handleDisplayStatus(`🧹 Storage cleared! Deleted ${deletedCount} keys. Please refresh the page.`);
        
        // Suggest page refresh
        setTimeout(() => {
          if (confirm('Storage cleared successfully!\n\nRefresh the page to complete the reset?')) {
            window.location.reload();
          }
        }, 2000);
        
      } catch (error) {
        console.error('❌ Error clearing storage:', error);
        instance.handleDisplayError('Failed to clear storage. Check console for details.');
      }
    },
    () => {
      // Cancel callback
      instance.handleDisplayStatus('Storage clearing cancelled');
    }
  );
}

/** Shows a custom confirmation dialog with slate theme
 * @param {string} title - The title of the confirmation dialog
 * @param {string} message - The message to display
 * @param {Function} onConfirm - Callback function to execute when confirmed
 * @param {Function} onCancel - Optional callback function to execute when cancelled
 * @since 1.0.0
 */
function showCustomConfirmDialog(title, message, onConfirm, onCancel = null) {
  // Inject confirm dialog styles if not already present
  if (!document.getElementById('bm-confirm-dialog-styles')) {
    const styleSheet = document.createElement('style');
    styleSheet.id = 'bm-confirm-dialog-styles';
    styleSheet.textContent = `
      .bmcd-overlay-backdrop { 
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background: rgba(0, 0, 0, 0.9);
        backdrop-filter: blur(12px);
        display: flex;
        justify-content: center;
        align-items: center;
        z-index: 15000;
        font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        animation: bmcd-fadeIn 0.2s ease-out;
      }
      
      @keyframes bmcd-fadeIn {
        from { opacity: 0; }
        to { opacity: 1; }
      }
      
      @keyframes bmcd-slideIn {
        from { 
          opacity: 0;
          transform: translate(-50%, -50%) scale(0.9) translateY(20px);
        }
        to { 
          opacity: 1;
          transform: translate(-50%, -50%) scale(1) translateY(0);
        }
      }
      
      .bmcd-container { 
        position: fixed;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        background: var(--slate-900, #0f172a);
        color: var(--slate-100, #f1f5f9);
        border-radius: 16px;
        border: 1px solid var(--slate-700, #334155);
        box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.8), 0 0 0 1px rgba(255, 255, 255, 0.1);
        backdrop-filter: blur(16px);
        max-width: 400px;
        width: 90%;
        overflow: hidden;
        animation: bmcd-slideIn 0.3s cubic-bezier(0.4, 0, 0.2, 1);
      }
      
      .bmcd-container::before {
        content: '';
        position: absolute;
        inset: 0;
        border-radius: 16px;
        background: linear-gradient(135deg, rgba(239, 68, 68, 0.1), rgba(220, 38, 38, 0.05));
        pointer-events: none;
      }
      
      .bmcd-header { 
        padding: 20px 24px 16px 24px;
        border-bottom: 1px solid var(--slate-700, #334155);
        background: linear-gradient(135deg, var(--slate-800, #1e293b), var(--slate-750, #293548));
        position: relative;
        z-index: 1;
      }
      
      .bmcd-title {
        margin: 0;
        font-size: 1.25em;
        font-weight: 700;
        text-align: center;
        letter-spacing: -0.025em;
        background: linear-gradient(135deg, var(--red-400, #f87171), var(--red-500, #ef4444));
        -webkit-background-clip: text;
        -webkit-text-fill-color: transparent;
        background-clip: text;
      }
      
      .bmcd-content { 
        padding: 20px 24px;
        position: relative;
        z-index: 1;
        text-align: center;
      }
      
      .bmcd-message {
        color: var(--slate-300, #cbd5e1);
        line-height: 1.6;
        white-space: pre-line;
        font-size: 0.95em;
      }
      
      .bmcd-footer { 
        display: flex;
        gap: 12px;
        justify-content: center;
        align-items: center;
        padding: 16px 24px 20px 24px;
        border-top: 1px solid var(--slate-700, #334155);
        background: linear-gradient(135deg, var(--slate-800, #1e293b), var(--slate-750, #293548));
        position: relative;
        z-index: 1;
      }
      
      .bmcd-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        height: 40px;
        padding: 0 20px;
        min-width: 100px;
        border-radius: 10px;
        border: 1px solid;
        font-size: 0.9em;
        font-weight: 600;
        white-space: nowrap;
        cursor: pointer;
        transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
        position: relative;
        overflow: hidden;
        flex: 1;
      }
      
      .bmcd-btn::before {
        content: '';
        position: absolute;
        inset: 0;
        border-radius: 10px;
        background: linear-gradient(135deg, rgba(255,255,255,0.1), rgba(255,255,255,0.05));
        opacity: 0;
        transition: opacity 0.2s ease;
      }
      
      .bmcd-btn:hover::before {
        opacity: 1;
      }
      
      .bmcd-btn:hover {
        transform: translateY(-2px);
        box-shadow: 0 8px 25px rgba(0,0,0,0.4);
      }
      
      .bmcd-btn:active {
        transform: translateY(0);
      }
      
      .bmcd-btn-danger {
        background: linear-gradient(135deg, var(--red-500, #ef4444), var(--red-600, #dc2626));
        color: white;
        border-color: var(--red-600, #dc2626);
      }
      
      .bmcd-btn-danger:hover {
        background: linear-gradient(135deg, var(--red-600, #dc2626), var(--red-700, #b91c1c));
        box-shadow: 0 8px 25px rgba(239, 68, 68, 0.5);
      }
      
      .bmcd-btn-secondary {
        background: var(--slate-700, #334155);
        color: var(--slate-100, #f1f5f9);
        border-color: var(--slate-600, #475569);
      }
      
      .bmcd-btn-secondary:hover {
        background: var(--slate-600, #475569);
      }
      
      @media (max-width: 520px) {
        .bmcd-container {
          width: 95%;
        }
        
        .bmcd-btn {
          min-width: 80px;
          height: 36px;
          font-size: 0.85em;
        }
        
        .bmcd-header, .bmcd-content, .bmcd-footer {
          padding-left: 20px;
          padding-right: 20px;
        }
      }
    `;
    document.head.appendChild(styleSheet);
  }
  
  // Create overlay backdrop
  const overlay = document.createElement('div');
  overlay.className = 'bmcd-overlay-backdrop';
  
  // Create main container
  const container = document.createElement('div');
  container.className = 'bmcd-container';
  
  // Header
  const header = document.createElement('div');
  header.className = 'bmcd-header';
  
  const titleElement = document.createElement('h3');
  titleElement.className = 'bmcd-title';
  titleElement.textContent = title;
  
  header.appendChild(titleElement);
  
  // Content
  const content = document.createElement('div');
  content.className = 'bmcd-content';
  
  const messageElement = document.createElement('p');
  messageElement.className = 'bmcd-message';
  messageElement.textContent = message;
  
  content.appendChild(messageElement);
  
  // Footer with buttons
  const footer = document.createElement('div');
  footer.className = 'bmcd-footer';
  
  // Create buttons based on whether there's a confirm action
  if (onConfirm) {
    // Confirm button
    const confirmBtn = document.createElement('button');
    confirmBtn.className = 'bmcd-btn bmcd-btn-danger';
    confirmBtn.textContent = 'Delete';
    
    confirmBtn.addEventListener('click', () => {
      document.body.removeChild(overlay);
      onConfirm();
    });
    
    // Cancel button
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'bmcd-btn bmcd-btn-secondary';
    cancelBtn.textContent = 'Cancel';
    
    cancelBtn.addEventListener('click', () => {
      document.body.removeChild(overlay);
      if (onCancel) onCancel();
    });
    
    footer.appendChild(cancelBtn);
    footer.appendChild(confirmBtn);
  } else {
    // Only OK button for info dialogs
    const okBtn = document.createElement('button');
    okBtn.className = 'bmcd-btn bmcd-btn-secondary';
    okBtn.textContent = 'OK';
    okBtn.style.flex = 'none';
    okBtn.style.minWidth = '120px';
    
    okBtn.addEventListener('click', () => {
      document.body.removeChild(overlay);
      if (onCancel) onCancel();
    });
    
    footer.appendChild(okBtn);
    
    // Focus the OK button for info dialogs
    setTimeout(() => okBtn.focus(), 100);
  }
  
  // Assemble the dialog
  container.appendChild(header);
  container.appendChild(content);
  container.appendChild(footer);
  overlay.appendChild(container);
  
  // Close dialog when clicking outside (but not when clicking the container)
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) {
      document.body.removeChild(overlay);
      if (onCancel) onCancel();
    }
  });
  
  // ESC key support
  const handleKeyDown = (e) => {
    if (e.key === 'Escape') {
      document.body.removeChild(overlay);
      document.removeEventListener('keydown', handleKeyDown);
      if (onCancel) onCancel();
    }
  };
  document.addEventListener('keydown', handleKeyDown);
  
  // Add to page
  document.body.appendChild(overlay);
  
  // Focus the cancel button by default for better UX (only if it exists)
  if (onConfirm) {
    setTimeout(() => {
      const cancelButton = footer.querySelector('.bmcd-btn-secondary');
      if (cancelButton) cancelButton.focus();
    }, 100);
  }
}

/** Deletes a selected template with a dropdown selection interface
 * @param {Object} instance - The overlay instance
 * @since 1.0.0
 */
function deleteSelectedTemplate(instance) {
  // Get available templates
  const templates = templateManager?.templatesJSON?.templates || {};
  const templateKeys = Object.keys(templates);
  
  if (templateKeys.length === 0) {
    instance.handleDisplayStatus('No templates found to delete');
    return;
  }
  
  // Inject slate theme styles if not already present
  if (!document.getElementById('bm-delete-template-styles')) {
    const styleSheet = document.createElement('style');
    styleSheet.id = 'bm-delete-template-styles';
    styleSheet.textContent = `
      :root { 
        --slate-50: #f8fafc; --slate-100: #f1f5f9; --slate-200: #e2e8f0; --slate-300: #cbd5e1; 
        --slate-400: #94a3b8; --slate-500: #64748b; --slate-600: #475569; --slate-700: #334155; 
        --slate-750: #293548; --slate-800: #1e293b; --slate-900: #0f172a; --slate-950: #020617;
        --blue-400: #60a5fa; --blue-500: #3b82f6; --blue-600: #2563eb; --blue-700: #1d4ed8;
        --emerald-400: #34d399; --emerald-500: #10b981; --emerald-600: #059669; --emerald-700: #047857;
        --red-400: #f87171; --red-500: #ef4444; --red-600: #dc2626; --red-700: #b91c1c;
        --bmdt-bg: var(--slate-900); --bmdt-card: var(--slate-800); --bmdt-border: var(--slate-700); 
        --bmdt-muted: var(--slate-400); --bmdt-text: var(--slate-100); --bmdt-text-muted: var(--slate-300);
      }
      
      .bmdt-overlay-backdrop { 
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background: rgba(0, 0, 0, 0.8);
        backdrop-filter: blur(8px);
        display: flex;
        justify-content: center;
        align-items: center;
        z-index: 10000;
        font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      }
      
      .bmdt-container { 
        background: var(--bmdt-bg);
        color: var(--bmdt-text);
        border-radius: 20px;
        border: 1px solid var(--bmdt-border);
        box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.7), 0 0 0 1px rgba(255, 255, 255, 0.05);
        backdrop-filter: blur(16px);
        max-width: 500px;
        width: 90%;
        max-height: 85vh;
        overflow: hidden;
        display: flex;
        flex-direction: column;
        position: relative;
      }
      
      .bmdt-container::before {
        content: '';
        position: absolute;
        inset: 0;
        border-radius: 20px;
        background: linear-gradient(135deg, rgba(59, 130, 246, 0.1), rgba(16, 185, 129, 0.05));
        pointer-events: none;
      }
      
      .bmdt-header { 
        display: flex;
        flex-direction: column;
        padding: 20px 24px 16px 24px;
        border-bottom: 1px solid var(--bmdt-border);
        background: linear-gradient(135deg, var(--slate-800), var(--slate-750));
        position: relative;
        z-index: 1;
      }
      
      .bmdt-title {
        margin: 0;
        font-size: 1.5em;
        font-weight: 700;
        text-align: center;
        letter-spacing: -0.025em;
        background: linear-gradient(135deg, var(--slate-100), var(--slate-300));
        -webkit-background-clip: text;
        -webkit-text-fill-color: transparent;
        background-clip: text;
      }
      
      .bmdt-content { 
        padding: 20px 24px;
        overflow-y: auto;
        position: relative;
        z-index: 1;
        flex: 1;
      }
      
      .bmdt-template-list {
        margin: 0;
        max-height: 350px;
        overflow-y: auto;
        border: 1px solid var(--bmdt-border);
        border-radius: 12px;
        background: var(--bmdt-card);
      }
      
      .bmdt-template-item {
        padding: 16px;
        border-bottom: 1px solid var(--bmdt-border);
        cursor: pointer;
        transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
        display: flex;
        justify-content: space-between;
        align-items: center;
        position: relative;
        min-height: 60px;
        box-sizing: border-box;
      }
      
      .bmdt-template-item:last-child {
        border-bottom: none;
      }
      
      .bmdt-template-item:hover {
        background: linear-gradient(135deg, rgba(59, 130, 246, 0.1), rgba(16, 185, 129, 0.05));
      }
      
      .bmdt-template-info {
        display: flex;
        flex-direction: column;
        gap: 4px;
        flex: 1;
        min-width: 0;
        margin-right: 12px;
      }
      
      .bmdt-template-name {
        font-weight: 600;
        font-size: 1em;
        color: var(--bmdt-text);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      
      .bmdt-template-key {
        font-size: 0.8em;
        color: var(--bmdt-text-muted);
        font-family: 'Courier New', monospace;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      
      .bmdt-template-coords {
        font-size: 0.75em;
        color: var(--blue-400);
        font-weight: 500;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        margin-top: 2px;
      }
      
      .bmdt-delete-btn {
        background: linear-gradient(135deg, var(--red-500), var(--red-600));
        color: white;
        border: none;
        padding: 8px 16px;
        border-radius: 8px;
        cursor: pointer;
        font-size: 0.85em;
        font-weight: 600;
        transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
        position: relative;
        overflow: hidden;
      }
      
      .bmdt-delete-btn::before {
        content: '';
        position: absolute;
        inset: 0;
        border-radius: 8px;
        background: linear-gradient(135deg, rgba(255,255,255,0.1), rgba(255,255,255,0.05));
        opacity: 0;
        transition: opacity 0.2s ease;
      }
      
      .bmdt-delete-btn:hover {
        background: linear-gradient(135deg, var(--red-600), var(--red-700));
        transform: translateY(-2px);
        box-shadow: 0 8px 25px rgba(239, 68, 68, 0.4);
      }
      
      .bmdt-delete-btn:hover::before {
        opacity: 1;
      }
      
      .bmdt-footer { 
        display: flex;
        gap: 12px;
        justify-content: center;
        align-items: center;
        padding: 20px 24px;
        border-top: 1px solid var(--bmdt-border);
        background: linear-gradient(135deg, var(--slate-800), var(--slate-750));
        position: relative;
        z-index: 1;
      }
      
      .bmdt-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        height: 44px;
        padding: 0 20px;
        min-width: 140px;
        border-radius: 12px;
        border: 1px solid var(--bmdt-border);
        font-size: 0.9em;
        font-weight: 600;
        white-space: nowrap;
        cursor: pointer;
        transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
        position: relative;
        overflow: hidden;
        flex: 1;
      }
      
      .bmdt-btn::before {
        content: '';
        position: absolute;
        inset: 0;
        border-radius: 12px;
        background: linear-gradient(135deg, rgba(255,255,255,0.1), rgba(255,255,255,0.05));
        opacity: 0;
        transition: opacity 0.2s ease;
      }
      
      .bmdt-btn:hover::before {
        opacity: 1;
      }
      
      .bmdt-btn:hover {
        transform: translateY(-2px);
        box-shadow: 0 8px 25px rgba(0,0,0,0.3);
      }
      
      .bmdt-btn-danger {
        background: linear-gradient(135deg, var(--red-500), var(--red-600));
        color: white;
        border-color: var(--red-600);
      }
      
      .bmdt-btn-danger:hover {
        background: linear-gradient(135deg, var(--red-600), var(--red-700));
        box-shadow: 0 8px 25px rgba(239, 68, 68, 0.4);
      }
      
      .bmdt-btn-secondary {
        background: var(--slate-700);
        color: var(--bmdt-text);
        border-color: var(--bmdt-border);
      }
      
      .bmdt-btn-secondary:hover {
        background: var(--slate-600);
      }
      
      /* Custom scrollbar for template list */
      .bmdt-template-list::-webkit-scrollbar {
        width: 8px;
      }
      
      .bmdt-template-list::-webkit-scrollbar-track {
        background: var(--slate-800);
        border-radius: 4px;
      }
      
      .bmdt-template-list::-webkit-scrollbar-thumb {
        background: var(--slate-600);
        border-radius: 4px;
      }
      
      .bmdt-template-list::-webkit-scrollbar-thumb:hover {
        background: var(--slate-500);
      }
      
      @media (max-width: 520px) {
        .bmdt-container {
          width: 95%;
          max-height: 90vh;
        }
        
        .bmdt-btn {
          min-width: 120px;
          height: 40px;
          font-size: 0.85em;
        }
        
        .bmdt-template-item {
          padding: 12px;
        }
      }
    `;
    document.head.appendChild(styleSheet);
  }
  
  // Create overlay backdrop
  const overlay = document.createElement('div');
  overlay.id = 'bm-delete-template-overlay';
  overlay.className = 'bmdt-overlay-backdrop';
  
  // Create main container
  const container = document.createElement('div');
  container.className = 'bmdt-container';
  
  // Header
  const header = document.createElement('div');
  header.className = 'bmdt-header';
  
  const title = document.createElement('h3');
  title.className = 'bmdt-title';
  title.textContent = 'Select Template to Delete';
  
  header.appendChild(title);
  
  // Content
  const content = document.createElement('div');
  content.className = 'bmdt-content';
  
  // Template list
  const templateList = document.createElement('div');
  templateList.className = 'bmdt-template-list';
  
  templateKeys.forEach(templateKey => {
    const template = templates[templateKey];
    const templateName = template.name || `Template ${templateKey}`;
    const templateCoords = template.coords || 'Unknown location';
    
    const templateItem = document.createElement('div');
    templateItem.className = 'bmdt-template-item';
    
    const templateInfo = document.createElement('div');
    templateInfo.className = 'bmdt-template-info';
    
    const nameSpan = document.createElement('div');
    nameSpan.className = 'bmdt-template-name';
    nameSpan.textContent = templateName;
    
    // Extract sortID from template key for more user-friendly display
    const keySpan = document.createElement('div');
    keySpan.className = 'bmdt-template-key';
    const sortID = templateKey.split(' ')[0];
    keySpan.textContent = `Template ID: ${sortID}`;
    
    const coordsSpan = document.createElement('div');
    coordsSpan.className = 'bmdt-template-coords';
    
    // Parse and format coordinates for better readability
    if (templateCoords && templateCoords !== 'Unknown location') {
      const coords = templateCoords.split(', ');
      if (coords.length === 4) {
        const [tileX, tileY, pX, pY] = coords;
        coordsSpan.textContent = `📍 Tile ${tileX},${tileY} • Pixel ${pX},${pY}`;
      } else {
        coordsSpan.textContent = `📍 ${templateCoords}`;
      }
    } else {
      coordsSpan.textContent = '📍 Unknown location';
    }
    
    templateInfo.appendChild(nameSpan);
    templateInfo.appendChild(keySpan);
    templateInfo.appendChild(coordsSpan);
    
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'bmdt-delete-btn';
    deleteBtn.textContent = 'Delete';
    
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      
      showCustomConfirmDialog(
        `Delete "${templateName}"?`,
        `Are you sure you want to delete this template?\n\nThis action cannot be undone!`,
        async () => {
          try {
            // Delete from templateManager (now async)
            const success = await templateManager.deleteTemplate(templateKey);
            
            if (success) {
            // Invalidate cache after template deletion
            invalidateTemplateCache();
            
            // Remove overlay
            document.body.removeChild(overlay);
            
            instance.handleDisplayStatus(`Successfully deleted template "${templateName}"!`);
            debugLog(`🗑️ Deleted template: ${templateName} (${templateKey})`);
            } else {
              throw new Error('Delete operation returned false');
            }
            
          } catch (error) {
            console.error('❌ Failed to delete template:', error);
            instance.handleDisplayError('Failed to delete template. Check console for details.');
          }
        }
      );
    });
    
    templateItem.appendChild(templateInfo);
    templateItem.appendChild(deleteBtn);
    templateList.appendChild(templateItem);
  });
  
  content.appendChild(templateList);
  
  // Footer with buttons
  const footer = document.createElement('div');
  footer.className = 'bmdt-footer';
  
  // Delete All button
  const deleteAllBtn = document.createElement('button');
  deleteAllBtn.className = 'bmdt-btn bmdt-btn-danger';
  deleteAllBtn.textContent = 'Delete All Templates';
  
  deleteAllBtn.addEventListener('click', () => {
    document.body.removeChild(overlay);
    
    showCustomConfirmDialog(
      'Delete All Templates?',
      `Are you sure you want to delete all ${templateKeys.length} templates?\n\nThis action cannot be undone!`,
      () => {
        // Call the actual deletion logic directly, not the wrapper function
        const templateCount = templateKeys.length;
        const templateText = templateCount === 1 ? 'template' : 'templates';
        performDeleteAllTemplates(instance, templateCount, templateText);
      }
    );
  });
  
  // Cancel button
  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'bmdt-btn bmdt-btn-secondary';
  cancelBtn.textContent = 'Cancel';
  
  cancelBtn.addEventListener('click', () => {
    document.body.removeChild(overlay);
    instance.handleDisplayStatus('Template deletion cancelled');
  });
  
  footer.appendChild(deleteAllBtn);
  footer.appendChild(cancelBtn);
  
  // Assemble the interface
  container.appendChild(header);
  container.appendChild(content);
  container.appendChild(footer);
  overlay.appendChild(container);
  
  // Close overlay when clicking outside
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) {
      document.body.removeChild(overlay);
      instance.handleDisplayStatus('Template deletion cancelled');
    }
  });
  
  // Add to page
  document.body.appendChild(overlay);
}

/** Shows a drag and drop import dialog
 * @param {Object} instance - The overlay instance
 * @since 1.0.0
 */
function showImportDialog(instance) {
  // Create import dialog overlay
  const overlay = document.createElement('div');
  overlay.id = 'bm-import-overlay';
  overlay.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background: rgba(0, 0, 0, 0.8);
    backdrop-filter: blur(8px);
    display: flex;
    justify-content: center;
    align-items: center;
    z-index: 10001;
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  `;

  const container = document.createElement('div');
  container.style.cssText = `
    background: #1e293b;
    color: #f1f5f9;
    border-radius: 20px;
    border: 1px solid #334155;
    box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.7);
    backdrop-filter: blur(16px);
    max-width: 500px;
    width: 90%;
    padding: 40px;
    text-align: center;
    position: relative;
  `;

  // Header
  const title = document.createElement('h3');
  title.textContent = 'Import Templates';
  title.style.cssText = `
    margin: 0 0 20px 0;
    font-size: 1.5em;
    font-weight: 700;
    background: linear-gradient(135deg, #f1f5f9, #cbd5e1);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;
  `;

  // Drop zone
  const dropZone = document.createElement('div');
  dropZone.style.cssText = `
    border: 2px dashed #475569;
    border-radius: 12px;
    padding: 60px 20px;
    margin: 20px 0;
    background: rgba(71, 85, 105, 0.1);
    transition: all 0.2s ease;
    cursor: pointer;
  `;

  const dropIcon = document.createElement('div');
  dropIcon.innerHTML = icons.uploadIcon;
  dropIcon.style.cssText = `
    font-size: 48px;
    margin-bottom: 16px;
    color: #64748b;
    display: flex;
    justify-content: center;
    align-items: center;
  `;
  
  // Style the SVG inside the dropIcon
  const svg = dropIcon.querySelector('svg');
  if (svg) {
    svg.style.cssText = `
      width: 48px;
      height: 48px;
      margin: 0 auto;
    `;
  }

  const dropText = document.createElement('p');
  dropText.innerHTML = 'Drag & drop your JSON file here<br>or <strong>click to browse</strong>';
  dropText.style.cssText = `
    margin: 0;
    color: #94a3b8;
    font-size: 1.1em;
    line-height: 1.5;
  `;

  dropZone.appendChild(dropIcon);
  dropZone.appendChild(dropText);

  // Hidden file input
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = '.json,application/json';
  fileInput.style.display = 'none';

  // Close button
  const closeBtn = document.createElement('button');
  closeBtn.innerHTML = '×';
  closeBtn.style.cssText = `
    position: absolute;
    top: 15px;
    right: 20px;
    background: transparent;
    border: none;
    color: #94a3b8;
    font-size: 24px;
    cursor: pointer;
    width: 30px;
    height: 30px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 50%;
    transition: all 0.2s ease;
  `;

  closeBtn.onmouseover = () => {
    closeBtn.style.background = 'rgba(255, 255, 255, 0.1)';
    closeBtn.style.color = '#f1f5f9';
  };
  closeBtn.onmouseout = () => {
    closeBtn.style.background = 'transparent';
    closeBtn.style.color = '#94a3b8';
  };

  closeBtn.onclick = () => document.body.removeChild(overlay);

  // File processing function
  const processFile = async (file) => {
    if (!file) return;
    
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      await templateManager.importFromObject(data, { merge: true });
      document.body.removeChild(overlay);
      instance.handleDisplayStatus(`Imported templates from ${file.name}!`);
    } catch (e) {
      console.error(e);
      instance.handleDisplayStatus('Failed to import JSON - please check the file format');
    }
  };

  // Event handlers
  fileInput.onchange = () => processFile(fileInput.files?.[0]);
  
  dropZone.onclick = () => fileInput.click();

  // Drag and drop handlers
  dropZone.ondragover = (e) => {
    e.preventDefault();
    dropZone.style.borderColor = '#3b82f6';
    dropZone.style.background = 'rgba(59, 130, 246, 0.1)';
  };

  dropZone.ondragleave = () => {
    dropZone.style.borderColor = '#475569';
    dropZone.style.background = 'rgba(71, 85, 105, 0.1)';
  };

  dropZone.ondrop = (e) => {
    e.preventDefault();
    dropZone.style.borderColor = '#475569';
    dropZone.style.background = 'rgba(71, 85, 105, 0.1)';
    
    const file = e.dataTransfer.files?.[0];
    if (file && file.type === 'application/json') {
      processFile(file);
    } else {
      instance.handleDisplayStatus('Please drop a valid JSON file');
    }
  };

  // Assemble the interface
  container.appendChild(closeBtn);
  container.appendChild(title);
  container.appendChild(dropZone);
  container.appendChild(fileInput);
  overlay.appendChild(container);

  // Close overlay when clicking outside
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) {
      document.body.removeChild(overlay);
    }
  });

  // Add to page
  document.body.appendChild(overlay);
}

/** Shows wrong pixels coordinates dialog with fly-to functionality
 * @param {Object} instance - The overlay instance
 * @since 1.0.0
 */
function showWrongPixelsDialog(instance) {
  const wrongPixelsList = [];
  
  if (!templateManager || !templateManager.tileProgress || templateManager.tileProgress.size === 0) {
    instance.handleDisplayError('No tile data available. Please load a template first!');
    return;
  }
  
  for (const [tileCoords, tileData] of templateManager.tileProgress.entries()) {
    if (tileData.wrong > 0 && tileData.colorBreakdown) {
      const [tileX, tileY] = tileCoords.split(',').map(Number);
      
      for (const [colorKey, colorStats] of Object.entries(tileData.colorBreakdown)) {
        if (colorStats.wrong > 0 && colorStats.firstWrongPixel) {
          wrongPixelsList.push({
            tileX,
            tileY,
            colorKey,
            wrongCount: colorStats.wrong,
            tileCoords: `${tileX}, ${tileY}`,
            pixelX: colorStats.firstWrongPixel[0],
            pixelY: colorStats.firstWrongPixel[1]
          });
        }
      }
    }
  }
  
  if (wrongPixelsList.length === 0) {
    instance.handleDisplayStatus('🎉 No wrong pixels found! All pixels match the template!');
    return;
  }
  
  wrongPixelsList.sort((a, b) => b.wrongCount - a.wrongCount);
  
  const overlay = document.createElement('div');
  overlay.id = 'bm-wrong-pixels-overlay';
  overlay.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background: rgba(0, 0, 0, 0.8);
    backdrop-filter: blur(8px);
    display: flex;
    justify-content: center;
    align-items: center;
    z-index: 10000;
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  `;
  
  const container = document.createElement('div');
  container.style.cssText = `
    background: #1e293b;
    color: #f1f5f9;
    border-radius: 20px;
    border: 1px solid #334155;
    box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.7);
    backdrop-filter: blur(16px);
    max-width: 390px;
    width: 90%;
    max-height: 85vh;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    position: relative;
  `;
  
  // Header
  const header = document.createElement('div');
  header.style.cssText = `
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 14px 16px 12px 16px;
    border-bottom: 1px solid #334155;
    background: linear-gradient(135deg, #1e293b, #293548);
  `;
  
  const title = document.createElement('h3');
  title.textContent = `Wrong Pixels (${wrongPixelsList.length} locations)`;
  title.style.cssText = `
    margin: 0;
    font-size: 1.2em;
    font-weight: 700;
    background: linear-gradient(135deg, #f87171, #ef4444);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;
  `;
  
  const closeBtn = document.createElement('button');
  closeBtn.textContent = '×';
  closeBtn.className = 'bm-close-btn';
  closeBtn.style.cssText = `
    background: none;
    border: none;
    color: #94a3b8;
    font-size: 20px;
    cursor: pointer;
    padding: 0;
    width: 26px;
    height: 26px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 6px;
  `;
  closeBtn.onclick = () => document.body.removeChild(overlay);
  
  header.appendChild(title);
  header.appendChild(closeBtn);
  
  const content = document.createElement('div');
  content.style.cssText = `
    padding: 14px 16px;
    overflow-y: auto;
    flex: 1;
  `;
  
  const pixelsList = document.createElement('div');
  pixelsList.style.cssText = `
    display: flex;
    flex-direction: column;
    gap: 6px;
  `;
  
  const loadingDiv = document.createElement('div');
  loadingDiv.style.cssText = `
    text-align: center;
    padding: 40px;
    color: #94a3b8;
    font-size: 14px;
  `;
  loadingDiv.textContent = 'Loading wrong pixels...';
  pixelsList.appendChild(loadingDiv);
  
  content.appendChild(pixelsList);
  container.appendChild(header);
  container.appendChild(content);
  overlay.appendChild(container);
  
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) {
      document.body.removeChild(overlay);
    }
  });
  
  document.body.appendChild(overlay);
  
  requestAnimationFrame(() => {
    pixelsList.innerHTML = '';
    
    wrongPixelsList.forEach((wrongPixel, index) => {
      const pixelItem = document.createElement('div');
      pixelItem.style.cssText = `
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 8px 10px;
        background: #334155;
        border-radius: 6px;
        border: 1px solid #475569;
        gap: 8px;
      `;
      
      // Color swatch
      const [r, g, b] = wrongPixel.colorKey.split(',').map(Number);
      const swatch = document.createElement('div');
      swatch.style.cssText = `
        width: 16px;
        height: 16px;
        border-radius: 3px;
        background: rgb(${r}, ${g}, ${b});
        border: 1px solid rgba(255, 255, 255, 0.3);
        flex-shrink: 0;
      `;
      
      // Info section
      const info = document.createElement('div');
      info.style.cssText = 'flex: 1; min-width: 0;';
      info.innerHTML = `
        <div style="font-weight: 600; color: #f1f5f9; margin-bottom: -5px; font-size: 0.9em;">
          Tile ${wrongPixel.tileX}, ${wrongPixel.tileY}
        </div>
        <div style="font-size: 0.8em; color: #94a3b8;">
          ${wrongPixel.wrongCount} wrong pixel${wrongPixel.wrongCount > 1 ? 's' : ''} • RGB(${r}, ${g}, ${b})
        </div>
      `;
      
      // Fly button
      const flyBtn = document.createElement('button');
      flyBtn.innerHTML = icons.pinIcon;
      flyBtn.title = 'Fly to this tile';
      flyBtn.style.cssText = `
        padding: 6px;
        border: none;
        border-radius: 6px;
        cursor: pointer;
        min-width: 32px;
        height: 32px;
        display: flex;
        align-items: center;
        justify-content: center;
        background: linear-gradient(135deg, #3b82f6, #2563eb);
        color: white;
        flex-shrink: 0;
      `;
      
      flyBtn.onclick = () => {
        const pX = wrongPixel.pixelX;
        const pY = wrongPixel.pixelY;
        const coordinates = [wrongPixel.tileX, wrongPixel.tileY, pX, pY];
        
        const coordTxInput = document.querySelector('#bm-input-tx');
        const coordTyInput = document.querySelector('#bm-input-ty');
        const coordPxInput = document.querySelector('#bm-input-px');
        const coordPyInput = document.querySelector('#bm-input-py');
        
        if (coordTxInput) coordTxInput.value = wrongPixel.tileX;
        if (coordTyInput) coordTyInput.value = wrongPixel.tileY;
        if (coordPxInput) coordPxInput.value = pX;
        if (coordPyInput) coordPyInput.value = pY;
        
        const latLng = canvasPosToLatLng(coordinates);
        
        if (latLng) {
          const navigationMethod = Settings.getNavigationMethod();
          const zoom = 19.5;
          
          if (navigationMethod === 'openurl') {
            const url = `https://wplace.live/?lat=${latLng.lat}&lng=${latLng.lng}&zoom=${zoom}`;
            window.location.href = url;
          } else {
            flyToLatLng(latLng.lat, latLng.lng, zoom);
          }
          
          document.body.removeChild(overlay);
          instance.handleDisplayStatus(`🧭 ${navigationMethod === 'openurl' ? 'Navigating' : 'Flying'} to wrong pixel at Tile ${wrongPixel.tileX},${wrongPixel.tileY} (${pX}, ${pY})!`);
        } else {
          instance.handleDisplayError('❌ Unable to convert coordinates!');
        }
      };
      
      pixelItem.appendChild(swatch);
      pixelItem.appendChild(info);
      pixelItem.appendChild(flyBtn);
      pixelsList.appendChild(pixelItem);
    });
  });
}

/** Shows a comprehensive template management dialog
 * @param {Object} instance - The overlay instance
 * @since 1.0.0
 */
function showTemplateManageDialog(instance) {
  const templates = templateManager?.templatesJSON?.templates || {};
  const templateKeys = Object.keys(templates);
  
  // Create management dialog
  const overlay = document.createElement('div');
  overlay.id = 'bm-template-manage-overlay';
  overlay.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background: rgba(0, 0, 0, 0.8);
    backdrop-filter: blur(8px);
    display: flex;
    justify-content: center;
    align-items: center;
    z-index: 10000;
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  `;
  
  const container = document.createElement('div');
  container.style.cssText = `
    background: #1e293b;
    color: #f1f5f9;
    border-radius: 20px;
    border: 1px solid #334155;
    box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.7);
    backdrop-filter: blur(16px);
    max-width: 500px;
    width: 90%;
    max-height: 85vh;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    position: relative;
  `;
  
  // Add mobile-specific styles for the manage dialog
  if (!document.getElementById('bm-manage-mobile-styles')) {
    const mobileStyles = document.createElement('style');
    mobileStyles.id = 'bm-manage-mobile-styles';
    mobileStyles.textContent = `
      /* Template manager styles with hardware acceleration */
      #bm-template-manage-overlay .bm-close-btn {
        transition: background 0.15s ease, color 0.15s ease;
      }
      #bm-template-manage-overlay .bm-close-btn:hover {
        background: rgba(239, 68, 68, 0.1) !important;
        color: #ef4444 !important;
      }
      #bm-template-manage-overlay .bm-template-item {
        will-change: transform, background;
        transition: transform 0.15s ease, background 0.15s ease;
      }
      #bm-template-manage-overlay .bm-template-item:hover {
        background: #3f4b5f !important;
        transform: translateY(-1px) translateZ(0);
      }
      #bm-template-manage-overlay button {
        will-change: transform, background;
        transition: transform 0.15s ease, background 0.15s ease;
      }
      #bm-template-manage-overlay button:hover {
        transform: translateY(-1px) translateZ(0);
      }
      
      /* Template manager mobile styles */
      @media screen and (max-width: 500px) {
        /* Make ONLY template items stack vertically - not header */
        #bm-template-manage-overlay div[style*="justify-content: space-between"][style*="padding: 16px"] {
          flex-direction: column !important;
          align-items: stretch !important;
          gap: 12px !important;
        }
        
        /* Template info section takes full width at top */
        #bm-template-manage-overlay div[style*="flex: 1"][style*="min-width: 0"][style*="margin-right: 16px"] {
          margin-bottom: 0 !important;
          margin-right: 0 !important;
          width: 100% !important;
        }
        
        /* Button container - 4x1 grid layout (linha horizontal) */
        #bm-template-manage-overlay .templateInfoControls {
          max-width: 100% !important;
          display: grid !important;
          grid-template-columns: repeat(4, 1fr) !important;
          gap: 6px !important;
          justify-items: stretch !important;
          margin-top: 8px !important;
        }
        
        /* Buttons - touch-friendly em linha horizontal */
        #bm-template-manage-overlay .templateInfoControls button {
          width: 100% !important;
          min-width: unset !important;
          height: 40px !important;
          padding: 6px 4px !important;
          font-size: 12px !important;
          display: flex !important;
          align-items: center !important;
          justify-content: center !important;
        }
        
        /* Toggle button com fonte menor para caber */
        #bm-template-manage-overlay .templateInfoControls button[style*="min-width: 80px"] {
          font-size: 11px !important;
          padding: 6px 2px !important;
        }
      }
      
      /* Small screens (380px) - começar compactação gradual */
      @media screen and (max-width: 380px) {
        /* Template item com padding reduzido gradualmente */
        #bm-template-manage-overlay div[style*="justify-content: space-between"][style*="padding: 16px"] {
          padding: 14px !important;
          gap: 10px !important;
        }
        
        /* Template info mais compacta */
        #bm-template-manage-overlay div[style*="flex: 1"][style*="min-width: 0"][style*="margin-right: 16px"] {
          line-height: 1.3 !important;
        }
        
        /* Nome do template */
        #bm-template-manage-overlay div[style*="display:flex"][style*="align-items:center"][style*="gap:8px"] {
          margin-bottom: 5px !important;
        }
        
        /* Informações de pixels */
        #bm-template-manage-overlay div[style*="font-size: 0.85em"][style*="color: #94a3b8"] {
          font-size: 0.82em !important;
          margin-bottom: 3px !important;
        }
        
        /* Coordenadas */
        #bm-template-manage-overlay div[style*="font-size: 0.75em"][style*="color: #60a5fa"] {
          font-size: 0.72em !important;
          margin-top: 2px !important;
        }
        
        /* Botões */
        #bm-template-manage-overlay .templateInfoControls {
          margin-top: 7px !important;
          gap: 4px !important;
        }
        
        #bm-template-manage-overlay .templateInfoControls button {
          height: 42px !important;
          font-size: 11px !important;
          padding: 4px 2px !important;
        }
        
        #bm-template-manage-overlay .templateInfoControls button[style*="min-width: 80px"] {
          font-size: 10px !important;
          padding: 4px 1px !important;
        }
      }
      
      /* Very small screens (360px) - mais compacto */
      @media screen and (max-width: 360px) {
        #bm-template-manage-overlay div[style*="justify-content: space-between"][style*="padding: 16px"] {
          padding: 13px !important;
          gap: 9px !important;
        }
        
        #bm-template-manage-overlay div[style*="flex: 1"][style*="min-width: 0"][style*="margin-right: 16px"] {
          line-height: 1.25 !important;
        }
        
        #bm-template-manage-overlay div[style*="display:flex"][style*="align-items:center"][style*="gap:8px"] {
          margin-bottom: 4px !important;
        }
        
        #bm-template-manage-overlay div[style*="font-size: 0.85em"][style*="color: #94a3b8"] {
          font-size: 0.81em !important;
          margin-bottom: 2px !important;
        }
        
        #bm-template-manage-overlay div[style*="font-size: 0.75em"][style*="color: #60a5fa"] {
          font-size: 0.71em !important;
        }
        
        #bm-template-manage-overlay .templateInfoControls button {
          height: 40px !important;
          font-size: 10px !important;
        }
        
        #bm-template-manage-overlay .templateInfoControls button[style*="min-width: 80px"] {
          font-size: 9px !important;
        }
      }
      
      /* Ultra small screens (320px) - máximo compacto */
      @media screen and (max-width: 320px) {
        #bm-template-manage-overlay div[style*="justify-content: space-between"][style*="padding: 16px"] {
          padding: 12px !important;
          gap: 8px !important;
        }
        
        #bm-template-manage-overlay div[style*="flex: 1"][style*="min-width: 0"][style*="margin-right: 16px"] {
          line-height: 1.2 !important;
        }
        
        #bm-template-manage-overlay div[style*="display:flex"][style*="align-items:center"][style*="gap:8px"] {
          margin-bottom: 3px !important;
        }
        
        #bm-template-manage-overlay div[style*="font-size: 0.85em"][style*="color: #94a3b8"] {
          font-size: 0.8em !important;
          margin-bottom: 2px !important;
        }
        
        #bm-template-manage-overlay div[style*="font-size: 0.75em"][style*="color: #60a5fa"] {
          font-size: 0.7em !important;
          margin-top: 1px !important;
        }
        
        #bm-template-manage-overlay .templateInfoControls {
          margin-top: 6px !important;
          gap: 3px !important;
        }
        
        #bm-template-manage-overlay .templateInfoControls button {
          height: 38px !important;
          font-size: 10px !important;
          padding: 3px 1px !important;
        }
        
        #bm-template-manage-overlay .templateInfoControls button[style*="min-width: 80px"] {
          font-size: 9px !important;
        }
      }
      
      /* Extra small screens (330px) - reduzir título para não quebrar */
      @media screen and (max-width: 330px) {
        #bm-template-manage-overlay h3 {
          font-size: 1.3em !important;
          line-height: 1.2 !important;
        }
      }
    `;
    document.head.appendChild(mobileStyles);
  }
  
  // Header
  const header = document.createElement('div');
  header.style.cssText = `
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 20px 24px 16px 24px;
    border-bottom: 1px solid #334155;
    background: linear-gradient(135deg, #1e293b, #293548);
  `;
  
  const title = document.createElement('h3');
  title.textContent = 'Manage Templates';
  title.style.cssText = `
    margin: 0;
    font-size: 1.5em;
    font-weight: 700;
    background: linear-gradient(135deg, #f1f5f9, #cbd5e1);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;
  `;
  
  const closeBtn = document.createElement('button');
  closeBtn.textContent = '×';
  closeBtn.className = 'bm-close-btn';
  closeBtn.style.cssText = `
    background: none;
    border: none;
    color: #94a3b8;
    font-size: 24px;
    cursor: pointer;
    padding: 0;
    width: 30px;
    height: 30px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 6px;
  `;
  closeBtn.onclick = () => document.body.removeChild(overlay);
  
  header.appendChild(title);
  header.appendChild(closeBtn);
  
  // Content
  const content = document.createElement('div');
  content.style.cssText = `
    padding: 20px 24px;
    overflow-y: auto;
    flex: 1;
  `;
  
  // Template list
  const templateList = document.createElement('div');
  templateList.style.cssText = `
    display: flex;
    flex-direction: column;
    gap: 12px;
  `;
  
  // Add loading indicator
  const loadingDiv = document.createElement('div');
  loadingDiv.style.cssText = `
    text-align: center;
    padding: 40px;
    color: #94a3b8;
    font-size: 14px;
  `;
  loadingDiv.textContent = 'Loading templates...';
  templateList.appendChild(loadingDiv);
  
  // Build basic structure first
  content.appendChild(templateList);
  
  // Footer with actions that keep dialog open
  const footer = document.createElement('div');
  footer.style.cssText = `
    display: flex; gap: 12px; padding: 12px 16px; border-top: 1px solid #334155;
    background: #1b2433; position: sticky; bottom: 0; justify-content: center; align-items: center;`
  ;
  
  // Assemble the interface early (before populating templates)
  container.appendChild(header);
  container.appendChild(content);
  container.appendChild(footer);
  overlay.appendChild(container);

  // Close overlay when clicking outside
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) {
      document.body.removeChild(overlay);
    }
  });
  
  // Add to page FIRST (before heavy operations)
  document.body.appendChild(overlay);
  
  // Now populate templates asynchronously in batches to avoid lag
  const batchSize = 3; // Process 3 templates at a time
  let currentIndex = 0;
  
  const processBatch = () => {
    const endIndex = Math.min(currentIndex + batchSize, templateKeys.length);
    
    // Clear loading indicator on first batch
    if (currentIndex === 0) {
      templateList.innerHTML = '';
    }
    
    // Process current batch
    for (let i = currentIndex; i < endIndex; i++) {
      const templateKey = templateKeys[i];
      const template = templates[templateKey];
    const templateName = template.name || `Template ${templateKey}`;
    const templateCoords = template.coords || 'Unknown location';
    const pixelCount = template.pixelCount || 0;
    const isEnabled = templateManager.isTemplateEnabled(templateKey);
    
    // Main template card - modern gradient design
    const templateItem = document.createElement('div');
    templateItem.className = 'bm-template-item';
    templateItem.style.cssText = `
      display: flex;
      flex-direction: column;
      padding: 16px;
      background: linear-gradient(145deg, #374151 0%, #1f2937 100%);
      border-radius: 16px;
      border: 1px solid rgba(255, 255, 255, 0.1);
      gap: 14px;
      max-width: 480px;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
    `;
    
    // HEADER: Edit button + Name
    const headerRow = document.createElement('div');
    headerRow.style.cssText = `
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 0;
    `;
    
    const renameBtn = document.createElement('button');
    renameBtn.innerHTML = icons.pencilIcon;
    renameBtn.title = 'Rename template';
    renameBtn.style.cssText = `
      background: rgba(0, 0, 0, 0.3);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 8px;
      width: 32px;
      height: 32px;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      transition: all 0.2s ease;
      flex-shrink: 0;
    `;
    renameBtn.onmouseover = () => {
      renameBtn.style.background = 'rgba(0, 0, 0, 0.4)';
      renameBtn.style.borderColor = 'rgba(255, 255, 255, 0.2)';
      renameBtn.style.transform = 'scale(1.05)';
    };
    renameBtn.onmouseout = () => {
      renameBtn.style.background = 'rgba(0, 0, 0, 0.3)';
      renameBtn.style.borderColor = 'rgba(255, 255, 255, 0.1)';
      renameBtn.style.transform = '';
    };
    
    const nameLabel = document.createElement('div');
    nameLabel.textContent = templateName;
    nameLabel.style.cssText = `
      color: #f9fafb;
      font-size: 18px;
      font-weight: 600;
      letter-spacing: -0.01em;
      cursor: pointer;
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    `;
    
    const startInlineRename = () => {
      const input = document.createElement('input');
      input.type = 'text';
      input.value = nameLabel.textContent || '';
      input.style.cssText = `
        font-size: 18px;
        font-weight: 600;
        color: #f9fafb;
        border: 2px solid #3b82f6;
        background: rgba(0, 0, 0, 0.3);
        border-radius: 8px;
        padding: 4px 8px;
        outline: none;
        width: 100%;
        letter-spacing: -0.01em;
      `;
      
      const finish = async (commit) => {
        const newVal = input.value.trim();
        headerRow.replaceChild(nameLabel, input);
        if (!commit) return;
        if (!newVal || newVal === nameLabel.textContent) return;
        const ok = await templateManager.renameTemplate(templateKey, newVal);
        if (ok) {
          nameLabel.textContent = newVal;
          instance.handleDisplayStatus(`Renamed to "${newVal}"`);
        } else {
          instance.handleDisplayError('Failed to rename template');
        }
      };
      
      input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') finish(true);
        else if (ev.key === 'Escape') finish(false);
        ev.stopPropagation();
      });
      input.addEventListener('blur', () => finish(true));
      headerRow.replaceChild(input, nameLabel);
      setTimeout(() => { input.focus(); input.select(); }, 0);
    };
    
    renameBtn.onclick = (e) => { e.stopPropagation(); startInlineRename(); };
    nameLabel.onclick = (e) => { e.stopPropagation(); startInlineRename(); };
    headerRow.appendChild(renameBtn);
    headerRow.appendChild(nameLabel);
    
    // CONTENT ROW: Thumbnail + Actions/Info
    const contentRow = document.createElement('div');
    contentRow.style.cssText = `
      display: flex;
      gap: 14px;
      align-items: flex-start;
    `;
    
    // Thumbnail with radial gradient effect
    const thumbnailContainer = document.createElement('div');
    thumbnailContainer.style.cssText = `
      width: 95px;
      height: 95px;
      background: rgba(0, 0, 0, 0.4);
      border-radius: 10px;
      display: flex;
      align-items: center;
      justify-content: center;
      border: 1px solid rgba(255, 255, 255, 0.08);
      flex-shrink: 0;
      position: relative;
      overflow: hidden;
    `;
    
    // Add radial gradient overlay
    const gradientOverlay = document.createElement('div');
    gradientOverlay.style.cssText = `
      position: absolute;
      inset: 0;
      background: radial-gradient(circle at center, rgba(59, 130, 246, 0.05) 0%, transparent 70%);
      pointer-events: none;
    `;
    thumbnailContainer.appendChild(gradientOverlay);
    
    if (template.thumbnail) {
      const thumbnailImg = document.createElement('img');
      thumbnailImg.src = template.thumbnail;
      thumbnailImg.style.cssText = `
        max-width: 100%;
        max-height: 100%;
        object-fit: contain;
        image-rendering: pixelated;
        position: relative;
        z-index: 1;
      `;
      thumbnailContainer.appendChild(thumbnailImg);
    } else {
      const noImageText = document.createElement('span');
      noImageText.textContent = 'No Image';
      noImageText.style.cssText = `
        color: #6b7280;
        font-size: 10px;
        font-weight: 500;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        position: relative;
        z-index: 1;
      `;
      thumbnailContainer.appendChild(noImageText);
    }
    
    // Right section (actions + info)
    const rightSection = document.createElement('div');
    rightSection.style.cssText = `
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 10px;
    `;
    
    // Actions row
    const actionsRow = document.createElement('div');
    actionsRow.style.cssText = `
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    `;
    
    // Export button
    const exportBtn = document.createElement('button');
    exportBtn.innerHTML = icons.exportIcon;
    exportBtn.title = 'Export this template as JSON';
    exportBtn.style.cssText = `
      width: 40px;
      height: 40px;
      border: none;
      border-radius: 10px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      background: #22c55e;
      color: white;
      transition: all 0.2s ease;
      flex-shrink: 0;
    `;
    exportBtn.onmouseover = () => {
      exportBtn.style.background = '#16a34a';
      exportBtn.style.transform = 'translateY(-2px)';
      exportBtn.style.boxShadow = '0 4px 12px rgba(0, 0, 0, 0.3)';
    };
    exportBtn.onmouseout = () => {
      exportBtn.style.background = '#22c55e';
      exportBtn.style.transform = '';
      exportBtn.style.boxShadow = '';
    };
    exportBtn.onclick = () => {
      exportBtn.style.transform = 'scale(0.95)';
      setTimeout(() => { exportBtn.style.transform = ''; }, 150);
      templateManager.downloadTemplateJSON(templateKey);
      instance.handleDisplayStatus(`Exported "${templateName}"`);
    };
    
    // Fly button
    const flyBtn = document.createElement('button');
    flyBtn.innerHTML = icons.pinIcon;
    flyBtn.title = 'Fly to template coordinates';
    flyBtn.style.cssText = `
      width: 40px;
      height: 40px;
      border: none;
      border-radius: 10px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      background: #3b82f6;
      color: white;
      transition: all 0.2s ease;
      flex-shrink: 0;
    `;
    flyBtn.onmouseover = () => {
      flyBtn.style.background = '#2563eb';
      flyBtn.style.transform = 'translateY(-2px)';
      flyBtn.style.boxShadow = '0 4px 12px rgba(0, 0, 0, 0.3)';
    };
    flyBtn.onmouseout = () => {
      flyBtn.style.background = '#3b82f6';
      flyBtn.style.transform = '';
      flyBtn.style.boxShadow = '';
    };
    flyBtn.onclick = () => {
      flyBtn.style.transform = 'scale(0.95)';
      setTimeout(() => { flyBtn.style.transform = ''; }, 150);
      
      if (templateCoords && templateCoords !== 'Unknown location') {
        const coords = templateCoords.split(', ');
        if (coords.length === 4) {
          const [tileX, tileY, pX, pY] = coords.map(coord => parseInt(coord.trim(), 10));
          const coordinates = [tileX, tileY, pX, pY];
          
          const coordTxInput = document.querySelector('#bm-input-tx');
          const coordTyInput = document.querySelector('#bm-input-ty');
          const coordPxInput = document.querySelector('#bm-input-px');
          const coordPyInput = document.querySelector('#bm-input-py');
          
          if (coordTxInput) coordTxInput.value = tileX;
          if (coordTyInput) coordTyInput.value = tileY;
          if (coordPxInput) coordPxInput.value = pX;
          if (coordPyInput) coordPyInput.value = pY;
          
          const latLng = canvasPosToLatLng(coordinates);
          
          if (latLng) {
            const navigationMethod = Settings.getNavigationMethod();
            
            if (navigationMethod === 'openurl') {
              const zoom = 13.62;
              const url = `https://wplace.live/?lat=${latLng.lat}&lng=${latLng.lng}&zoom=${zoom}`;
              window.location.href = url;
            } else {
              flyToLatLng(latLng.lat, latLng.lng);
            }
            
            document.body.removeChild(overlay);
            instance.handleDisplayStatus(`🧭 ${navigationMethod === 'openurl' ? 'Navigating' : 'Flying'} to "${templateName}" at ${latLng.lat.toFixed(6)}, ${latLng.lng.toFixed(6)}! Coordinates auto-filled.`);
          } else {
            instance.handleDisplayStatus('❌ Unable to convert coordinates to location!');
          }
        } else {
          instance.handleDisplayStatus('❌ Invalid coordinate format!');
        }
      } else {
        instance.handleDisplayStatus('❌ No coordinates available for this template!');
      }
    };
    
    // Delete button
    const deleteBtn = document.createElement('button');
    deleteBtn.innerHTML = icons.deleteIcon;
    deleteBtn.title = 'Delete this template';
    deleteBtn.style.cssText = `
      width: 40px;
      height: 40px;
      border: none;
      border-radius: 10px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      background: #ef4444;
      color: white;
      transition: all 0.2s ease;
      flex-shrink: 0;
    `;
    deleteBtn.onmouseover = () => {
      deleteBtn.style.background = '#dc2626';
      deleteBtn.style.transform = 'translateY(-2px)';
      deleteBtn.style.boxShadow = '0 4px 12px rgba(0, 0, 0, 0.3)';
    };
    deleteBtn.onmouseout = () => {
      deleteBtn.style.background = '#ef4444';
      deleteBtn.style.transform = '';
      deleteBtn.style.boxShadow = '';
    };
    deleteBtn.onclick = (e) => {
      e.stopPropagation();
      deleteBtn.style.transform = 'scale(0.95)';
      setTimeout(() => { deleteBtn.style.transform = ''; }, 150);
      
      showCustomConfirmDialog(
        `Delete "${templateName}"?`,
        `Are you sure you want to delete this template?\n\nThis action cannot be undone!`,
        async () => {
          try {
            const success = await templateManager.deleteTemplate(templateKey);
            
            if (success) {
              invalidateTemplateCache();
              templateItem.remove();
              instance.handleDisplayStatus(`Successfully deleted template "${templateName}"!`);
              debugLog(`🗑️ Deleted template: ${templateName} (${templateKey})`);
              
              const remainingTemplates = templateList.children.length;
              if (remainingTemplates === 0) {
                document.body.removeChild(overlay);
                instance.handleDisplayStatus('All templates deleted - dialog closed');
              }
            } else {
              throw new Error('Delete operation returned false');
            }
          } catch (error) {
            console.error('❌ Failed to delete template:', error);
            instance.handleDisplayError('Failed to delete template. Check console for details.');
          }
        }
      );
    };
    
    // Toggle button
    const toggleBtn = document.createElement('button');
    toggleBtn.textContent = isEnabled ? 'Enabled' : 'Disabled';
    toggleBtn.style.cssText = `
      background: ${isEnabled ? '#10b981' : '#4b5563'};
      padding: 0 16px;
      border-radius: 10px;
      height: 40px;
      display: flex;
      align-items: center;
      justify-content: center;
      color: ${isEnabled ? 'white' : '#d1d5db'};
      font-size: 13px;
      font-weight: 600;
      border: none;
      cursor: pointer;
      transition: all 0.2s ease;
      flex-shrink: 0;
    `;
    toggleBtn.onmouseover = () => {
      const currentState = templateManager.isTemplateEnabled(templateKey);
      toggleBtn.style.background = currentState ? '#059669' : '#374151';
      toggleBtn.style.transform = 'translateY(-2px)';
      toggleBtn.style.boxShadow = '0 4px 12px rgba(0, 0, 0, 0.3)';
    };
    toggleBtn.onmouseout = () => {
      const currentState = templateManager.isTemplateEnabled(templateKey);
      toggleBtn.style.background = currentState ? '#10b981' : '#4b5563';
      toggleBtn.style.transform = '';
      toggleBtn.style.boxShadow = '';
    };
    toggleBtn.onclick = () => {
      toggleBtn.style.transform = 'scale(0.95)';
      setTimeout(() => { toggleBtn.style.transform = ''; }, 150);
      
      const newState = !templateManager.isTemplateEnabled(templateKey);
      templateManager.setTemplateEnabled(templateKey, newState);
      invalidateTemplateCache();
      
      toggleBtn.textContent = newState ? 'Enabled' : 'Disabled';
      toggleBtn.style.background = newState ? '#10b981' : '#4b5563';
      toggleBtn.style.color = newState ? 'white' : '#d1d5db';
      
      instance.handleDisplayStatus(`${newState ? 'Enabled' : 'Disabled'} template "${templateName}"!`);
      
      setTimeout(() => {
        if (typeof clearColorMenuCache === 'function') {
          clearColorMenuCache();
        }
        if (typeof updateColorMenuDisplay === 'function') {
          updateColorMenuDisplay(false, true);
        }
      }, 200);
    };
    
    actionsRow.appendChild(exportBtn);
    actionsRow.appendChild(flyBtn);
    actionsRow.appendChild(deleteBtn);
    actionsRow.appendChild(toggleBtn);
    
    // Info box (tile and pixels)
    const infoBox = document.createElement('div');
    infoBox.style.cssText = `
      display: flex;
      flex-direction: column;
      gap: 6px;
    `;
    
    // Tile info with arrow
    const tileInfoRow = document.createElement('div');
    tileInfoRow.style.cssText = `
      display: flex;
      gap: 8px;
      font-size: 13px;
      align-items: center;
    `;
    
    if (templateCoords && templateCoords !== 'Unknown location') {
      const coords = templateCoords.split(', ');
      if (coords.length === 4) {
        const [tileX, tileY, pX, pY] = coords;
        
        const arrow = document.createElement('span');
        arrow.textContent = '↑';
        arrow.style.cssText = `
          color: #ef4444;
          font-weight: bold;
        `;
        
        const tileText = document.createElement('span');
        tileText.textContent = `Tile ${tileX},${tileY}`;
        tileText.style.cssText = `
          color: #60a5fa;
        `;
        
        const separator = document.createElement('span');
        separator.textContent = '•';
        separator.style.cssText = `color: #6b7280;`;
        
        const pixelText = document.createElement('span');
        pixelText.textContent = `Pixel ${pX},${pY}`;
        pixelText.style.cssText = `
          color: #60a5fa;
        `;
        
        tileInfoRow.appendChild(arrow);
        tileInfoRow.appendChild(tileText);
        tileInfoRow.appendChild(separator);
        tileInfoRow.appendChild(pixelText);
      }
    } else {
      tileInfoRow.textContent = '↑ Unknown location';
      tileInfoRow.style.color = '#6b7280';
    }
    
    // Pixels info
    const validPixelCount = template.validPixelCount || pixelCount;
    const transparentPixelCount = template.transparentPixelCount || 0;
    
    const pixelsInfo = document.createElement('div');
    if (validPixelCount !== pixelCount && transparentPixelCount > 0) {
      pixelsInfo.textContent = `${new Intl.NumberFormat().format(pixelCount)} pixels (${new Intl.NumberFormat().format(validPixelCount)} valid)`;
    } else {
      pixelsInfo.textContent = `${new Intl.NumberFormat().format(pixelCount)} pixels`;
    }
    pixelsInfo.style.cssText = `
      color: #d1d5db;
      font-size: 14px;
      font-weight: 600;
    `;
    
    infoBox.appendChild(tileInfoRow);
    infoBox.appendChild(pixelsInfo);
    
    // Assemble right section
    rightSection.appendChild(actionsRow);
    rightSection.appendChild(infoBox);
    
    // Assemble content row
    contentRow.appendChild(thumbnailContainer);
    contentRow.appendChild(rightSection);
    
    // Assemble card: Header → Content
    templateItem.appendChild(headerRow);
    templateItem.appendChild(contentRow);
    templateList.appendChild(templateItem);
    }
    
    // Move to next batch or finish
    currentIndex = endIndex;
    if (currentIndex < templateKeys.length) {
      requestAnimationFrame(processBatch);
    } else {
      // All templates loaded, add footer buttons
      const enableAllBtn = document.createElement('button');
      enableAllBtn.textContent = 'Enable All';
      enableAllBtn.style.cssText = `padding: 10px 16px; border: none; border-radius: 8px; cursor: pointer; font-weight: 600; background: linear-gradient(135deg,#10b981,#059669); color: white;`;
      enableAllBtn.onclick = () => {
        Object.keys(templates).forEach(k => templateManager.setTemplateEnabled(k, true));
        invalidateTemplateCache();
        instance.handleDisplayStatus('Enabled all templates');
        content.querySelectorAll('button').forEach(btn => {
          if (btn.textContent === 'Disabled' || btn.textContent === 'Enabled') {
            btn.textContent = 'Enabled';
            btn.style.background = 'linear-gradient(135deg, #10b981, #059669)';
            btn.style.color = 'white';
          }
        });
      };
      const disableAllBtn = document.createElement('button');
      disableAllBtn.textContent = 'Disable All';
      disableAllBtn.style.cssText = `padding: 10px 16px; border: none; border-radius: 8px; cursor: pointer; font-weight: 600; background: linear-gradient(135deg,#64748b,#475569); color: #e2e8f0;`;
      disableAllBtn.onclick = () => {
        Object.keys(templates).forEach(k => templateManager.setTemplateEnabled(k, false));
        invalidateTemplateCache();
        instance.handleDisplayStatus('Disabled all templates');
        content.querySelectorAll('button').forEach(btn => {
          if (btn.textContent === 'Disabled' || btn.textContent === 'Enabled') {
            btn.textContent = 'Disabled';
            btn.style.background = 'linear-gradient(135deg, #64748b, #475569)';
            btn.style.color = '#e2e8f0';
          }
        });
      };
      footer.appendChild(enableAllBtn);
      footer.appendChild(disableAllBtn);
    }
  };
  
  // Start processing first batch
  requestAnimationFrame(processBatch);
}

/** Deploys the overlay to the page with minimize/maximize functionality.
 * Creates a responsive overlay UI that can toggle between full-featured and minimized states.
 * 
 * Parent/child relationships in the DOM structure below are indicated by indentation.
 * @since 0.58.3
 */
function buildOverlayMain() {
  let isMinimized = false; // Overlay state tracker (false = maximized, true = minimized)
  
  overlayMain.addDiv({'id': 'bm-overlay', 'style': 'top: 10px; right: 75px;'})
    .addDiv({'id': 'bm-contain-header'})
      .addDiv({'id': 'bm-bar-drag'}).buildElement()
      .addDiv({'id': 'bm-title-container'})
        .addImg({'alt': 'Blue Marble Icon - Click to minimize/maximize', 'src': 'https://raw.githubusercontent.com/Seris0/Wplace-SkirkMarble/main/dist/assets/Favicon.png', 'style': 'cursor: pointer; width: 42px; height: 42px;'}, 
          (instance, img) => {
          /** Click event handler for overlay minimize/maximize functionality.
           * 
           * Toggles between two distinct UI states:
           * 1. MINIMIZED STATE (60×76px):
           *    - Shows only the Blue Marble icon and drag bar
           *    - Hides all input fields, buttons, and status information
           *    - Applies fixed dimensions for consistent appearance
           *    - Repositions icon with 3px right offset for visual centering
           * 
           * 2. MAXIMIZED STATE (responsive):
           *    - Restores full functionality with all UI elements
           *    - Removes fixed dimensions to allow responsive behavior
           *    - Resets icon positioning to default alignment
           *    - Shows success message when returning to maximized state
           * 
           * @param {Event} event - The click event object (implicit)
           */
          img.addEventListener('click', () => {
            isMinimized = !isMinimized; // Toggle the current state

            const overlay = document.querySelector('#bm-overlay');
            const header = document.querySelector('#bm-contain-header');
            const dragBar = document.querySelector('#bm-bar-drag');
            const coordsContainer = document.querySelector('#bm-contain-coords');
            const coordsButton = document.querySelector('#bm-button-coords');
            const createButton = document.querySelector('#bm-button-create');
            const manageButton = document.querySelector('#bm-button-manage');
            const pauseButton = document.querySelector('#bm-button-pause-tiles');
            const coordInputs = document.querySelectorAll('#bm-contain-coords input');
            const colorFilterButton = document.getElementById('bm-button-color-filter');
            
            // Pre-restore original dimensions when switching to maximized state
            // This ensures smooth transition and prevents layout issues
            if (!isMinimized) {
              overlay.style.width = "";
              overlay.style.height = "";
              overlay.style.maxWidth = "";
              overlay.style.minWidth = "";
              overlay.style.padding = "10px";
            }
            
            // Define elements that should be hidden/shown during state transitions
            // Each element is documented with its purpose for maintainability
                          const elementsToToggle = [
                '#bm-overlay h1',                    // Main title "Blue Marble"
                '#bm-contain-userinfo',              // User information section (username, droplets, level)
                '#bm-overlay #bm-separator',         // Visual separator lines
                '#bm-contain-automation > *:not(#bm-contain-coords)', // Automation section excluding coordinates
                'div:has(> #bm-input-file-template)', // Template file upload interface container
                '#bm-contain-buttons-action',        // Action buttons container
                `#${instance.outputStatusId}`        // Status log textarea for user feedback
              ];
            
            // Apply visibility changes to all toggleable elements
            elementsToToggle.forEach(selector => {
              const elements = document.querySelectorAll(selector);
              elements.forEach(element => {
                element.style.display = isMinimized ? 'none' : '';
              });
            });
            // Handle coordinate container and button visibility based on state
            if (isMinimized) {
              // ==================== MINIMIZED STATE CONFIGURATION ====================
              // In minimized state, we hide ALL interactive elements except the icon and drag bar
              // This creates a clean, unobtrusive interface that maintains only essential functionality
              
              // Hide coordinate input container completely
              if (coordsContainer) {
                coordsContainer.style.display = 'none';
              }
              
              // Hide coordinate button (pin icon)
              if (coordsButton) {
                coordsButton.style.display = 'none';
              }
              
              // Hide create template button
              if (createButton) {
                createButton.style.display = 'none';
              }

              // Hide manage templates button
              if (manageButton) {
                manageButton.style.display = 'none';
              }

              // Hide pause tiles button
              if (pauseButton) {
                pauseButton.style.display = 'none';
              }


              // Keep Color Filter button visible but compact in minimized state
              if (colorFilterButton) {
                // Ensure the container chain is visible
                let parent = colorFilterButton.parentElement;
                for (let i = 0; i < 3 && parent; i++) {
                  parent.style.display = '';
                  parent = parent.parentElement;
                }

                // Normalize the immediate container to center the compact button
                const btnContainer = colorFilterButton.parentElement;
                if (btnContainer) {
                  btnContainer.style.display = 'flex';
                  btnContainer.style.justifyContent = 'center';
                  btnContainer.style.alignItems = 'center';
                  btnContainer.style.gap = '0';
                  btnContainer.style.position = 'relative';
                  btnContainer.style.height = '44px'; // Fixed height to contain the absolute positioned button
                  // clear grid constraints if any
                  btnContainer.style.gridTemplateColumns = 'unset';
                }

                // Save original innerHTML once
                if (!colorFilterButton.dataset.originalHtml) {
                  colorFilterButton.dataset.originalHtml = colorFilterButton.innerHTML;
                }
                // Reduce to icon-only
                const svg = colorFilterButton.querySelector('svg');
                if (svg) {
                  colorFilterButton.innerHTML = svg.outerHTML;
                }

                // Compact styling to fit the 60px overlay (inner content width = 60 - 2*8 padding = 44px)
                colorFilterButton.style.width = '56px';
                colorFilterButton.style.height = '38px';
                colorFilterButton.style.padding = '0';
                colorFilterButton.style.gap = '0';
                colorFilterButton.style.fontSize = '0';
                colorFilterButton.style.overflow = 'hidden';
                colorFilterButton.style.borderRadius = '8px';
                colorFilterButton.style.animation = 'none';
                colorFilterButton.style.gridColumn = 'auto';
                colorFilterButton.style.margin = '2px auto 0';
                colorFilterButton.style.display = 'flex';
                colorFilterButton.style.alignItems = 'center';
                colorFilterButton.style.justifyContent = 'center';
                colorFilterButton.style.alignSelf = 'center';
                colorFilterButton.style.position = 'absolute';
                colorFilterButton.style.left = '50%';
                colorFilterButton.style.transform = 'translateX(-50%)';
                colorFilterButton.style.zIndex = '1000';
                // Tweak SVG size
                const icon = colorFilterButton.querySelector('svg');
                if (icon) {
                  icon.style.width = '18px';
                  icon.style.height = '18px';
                  icon.style.display = 'block';
                  icon.style.margin = '0 auto';
                }
              }
              
              // Hide all coordinate input fields individually (failsafe)
              coordInputs.forEach(input => {
                input.style.display = 'none';
              });
              
              // Apply fixed dimensions for consistent minimized appearance
              // These dimensions were chosen to accommodate the icon while remaining compact
              // Increase width to accommodate compact Color Filter button (56px) + padding
              overlay.style.width = '72px';    // 56px button + 6px*2 padding
              overlay.style.height = '76px';   // Keep height consistent
              overlay.style.maxWidth = '72px';  // Prevent expansion
              overlay.style.minWidth = '72px';  // Prevent shrinking
              overlay.style.padding = '6px';    // Reduced padding for tighter layout
              
                             // Apply icon positioning for better visual centering in minimized state
               img.style.margin = '0.3rem 0 0 0';
              
              // Configure header layout for minimized state
              header.style.textAlign = 'center';
              header.style.margin = '0';
              header.style.marginBottom = '0';
              
              // Ensure drag bar remains visible and properly spaced
              if (dragBar) {
                dragBar.style.display = '';
                dragBar.style.marginBottom = '0.1em';
              }
            } else {
              // ==================== MAXIMIZED STATE RESTORATION ====================
              // In maximized state, we restore all elements to their default functionality
              // This involves clearing all style overrides applied during minimization
              
              // Restore coordinate container to default state
              if (coordsContainer) {
                coordsContainer.style.display = '';           // Show container
                coordsContainer.style.flexDirection = '';     // Reset flex layout
                coordsContainer.style.justifyContent = '';    // Reset alignment
                coordsContainer.style.alignItems = '';        // Reset alignment
                coordsContainer.style.gap = '';               // Reset spacing
                coordsContainer.style.textAlign = '';         // Reset text alignment
                coordsContainer.style.margin = '';            // Reset margins
              }
              
              // Restore coordinate button visibility
              if (coordsButton) {
                coordsButton.style.display = '';
              }
              
              // Restore create button visibility and reset positioning
              if (createButton) {
                createButton.style.display = '';
                createButton.style.marginTop = '';
              }

              // Restore manage button visibility and reset positioning
              if (manageButton) {
                manageButton.style.display = '';
                manageButton.style.marginTop = '';
              }

              // Restore pause tiles button visibility and reset positioning
              if (pauseButton) {
                pauseButton.style.display = '';
                pauseButton.style.marginTop = '';
              }


              // Restore Color Filter button to normal size/state
              if (colorFilterButton) {
                // Restore content
                if (colorFilterButton.dataset.originalHtml) {
                  colorFilterButton.innerHTML = colorFilterButton.dataset.originalHtml;
                }
                // Clear compact styles
                colorFilterButton.style.width = '';
                colorFilterButton.style.height = '';
                colorFilterButton.style.padding = '';
                colorFilterButton.style.gap = '';
                colorFilterButton.style.fontSize = '';
                colorFilterButton.style.overflow = '';
                colorFilterButton.style.borderRadius = '';
                colorFilterButton.style.animation = '';
                colorFilterButton.style.transform = '';
                colorFilterButton.style.gridColumn = '';
                colorFilterButton.style.margin = '';
                colorFilterButton.style.display = '';
                colorFilterButton.style.alignItems = '';
                colorFilterButton.style.justifyContent = '';
                colorFilterButton.style.position = '';
                colorFilterButton.style.left = '';
                colorFilterButton.style.zIndex = '';

                // Reset parent container layout
                const btnContainer = colorFilterButton.parentElement;
                if (btnContainer) {
                  btnContainer.style.display = '';
                  btnContainer.style.justifyContent = '';
                  btnContainer.style.alignItems = '';
                  btnContainer.style.gap = '';
                  btnContainer.style.position = '';
                  btnContainer.style.height = '';
                  btnContainer.style.gridTemplateColumns = '';
                }
              }
              
              // Restore all coordinate input fields
              coordInputs.forEach(input => {
                input.style.display = '';
              });
              
              // Reset icon positioning to default (remove minimized state offset)
              img.style.margin = '';
              
              // Restore overlay to responsive dimensions
              overlay.style.padding = '10px';
              
              // Reset header styling to defaults
              header.style.textAlign = '';
              header.style.margin = '';
              header.style.marginBottom = '';
              
              // Reset drag bar spacing
              if (dragBar) {
                dragBar.style.marginBottom = '';
              }
              
              // Remove all dimension constraints to allow natural responsive behavior
              overlay.style.maxWidth = "";
              overlay.style.minWidth = "";
            }
            
            // Update mini tracker visibility based on collapse setting
            updateMiniTracker();
            
            // ==================== ACCESSIBILITY AND USER FEEDBACK ====================
            // Update accessibility information for screen readers and tooltips
            
            // Update alt text to reflect current state for screen readers and tooltips
            img.alt = isMinimized ? 
              'Blue Marble Icon - Minimized (Click to maximize)' : 
              'Blue Marble Icon - Maximized (Click to minimize)';
            
            // No status message needed - state change is visually obvious to users
          });
        }
      ).buildElement()
      .addHeader(1, {'textContent': 'Skirk Marble'}).buildElement()
    .buildElement()

    .addDiv({ 
      id: 'bm-separator', 
      style: (() => {
        try {
          const show = JSON.parse(localStorage.getItem('bmShowInformationHeader') ?? 'true');
          return show ? '' : 'display: none;';
        } catch (e) {
          return '';
        }
      })()
    })
      .addHr().buildElement()
      .addDiv({ id: 'bm-separator-text'})
        .addDiv({ innerHTML: icons.informationIcon }).buildElement()
        .addP({ textContent: 'Information' }).buildElement()
        .buildElement()
      .addHr().buildElement()
    .buildElement()

    .addDiv({'id': 'bm-contain-userinfo'})
      .addDiv({'id': 'bm-user-name'})
        .addDiv({'id': 'bm-user-icon', innerHTML: icons.userIcon}).buildElement()
        .addP({'id': 'bm-user-name-content', innerHTML: '<b>Username:</b> loading...'}).buildElement()
      .buildElement()
      .addDiv({'id': 'bm-user-droplets'})
        .addDiv({'id': 'bm-user-droplets-icon', innerHTML: icons.dropletIcon}).buildElement()
        .addP({'id': 'bm-user-droplets-content', innerHTML: '<b>Droplets:</b> loading...'}).buildElement()
      .buildElement()
      .addDiv({'id': 'bm-user-nextlevel'})
        .addDiv({'id': 'bm-user-nextlevel-icon', innerHTML: icons.nextLevelIcon}).buildElement()
        .addP({'id': 'bm-user-nextlevel-content', 'textContent': 'Next level in...'}).buildElement()
      .buildElement()
      .addDiv({'id': 'bm-user-fullcharge'})
        .addDiv({'id': 'bm-user-fullcharge-icon', innerHTML: icons.chargeIcon}).buildElement()
        .addP({'id': 'bm-user-fullcharge-content', 'textContent': 'Full Charge in...'}).buildElement()
      .buildElement()
    .buildElement()
    

    .addDiv({ 
      id: 'bm-separator', 
      style: (() => {
        try {
          const show = JSON.parse(localStorage.getItem('bmShowTemplateHeader') ?? 'true');
          return show ? '' : 'display: none;';
        } catch (e) {
          return '';
        }
      })()
    })
      .addHr().buildElement()
      .addDiv({ id: 'bm-separator-text'})
        .addDiv({ innerHTML: icons.templateIcon }).buildElement()
        .addP({ textContent: 'Template' }).buildElement()
        .buildElement()
      .addHr().buildElement()
    .buildElement()

    .addDiv({'id': 'bm-contain-automation'})
      // .addCheckbox({'id': 'bm-input-stealth', 'textContent': 'Stealth', 'checked': true}).buildElement()
      // .addButtonHelp({'title': 'Waits for the website to make requests, instead of sending requests.'}).buildElement()
      // .addBr().buildElement()
      // .addCheckbox({'id': 'bm-input-possessed', 'textContent': 'Possessed', 'checked': true}).buildElement()
      // .addButtonHelp({'title': 'Controls the website as if it were possessed.'}).buildElement()
      // .addBr().buildElement()
      .addDiv({'id': 'bm-contain-coords'})
        .addDiv({ id: 'bm-coords-title' })
          .addDiv({ innerHTML: icons.pinIcon }).buildElement()
          .addP({ innerHTML: 'Coordinates:' }).buildElement()
          .addButton({'id': 'bm-button-coords', 'innerHTML': icons.pointerIcon + 'Detect', title: 'Set the location to the pixel you\'ve selected'},
            (instance, button) => {
              button.onclick = () => {
                const coords = instance.apiManager?.coordsTilePixel; // Retrieves the coords from the API manager
                if (!coords?.[0]) {
                  instance.handleDisplayError('Coordinates are malformed! Did you try clicking on the canvas first?');
                  return;
                }
                instance.updateInnerHTML('bm-input-tx', coords?.[0] || '');
                instance.updateInnerHTML('bm-input-ty', coords?.[1] || '');
                instance.updateInnerHTML('bm-input-px', coords?.[2] || '');
                instance.updateInnerHTML('bm-input-py', coords?.[3] || '');
              }
            }
          ).buildElement()
        .buildElement()
        .addDiv({ id: 'bm-contain-inputs'})
          .addP({ textContent: 'Tile: '}).buildElement()
          .addInput({'type': 'number', 'id': 'bm-input-tx', 'placeholder': 'T1 X', 'min': 0, 'max': 2047, 'step': 1, 'required': true}).buildElement()
          .addInput({'type': 'number', 'id': 'bm-input-ty', 'placeholder': 'T1 Y', 'min': 0, 'max': 2047, 'step': 1, 'required': true}).buildElement()
          .addInput({'type': 'number', 'id': 'bm-input-px', 'placeholder': 'Px X', 'min': 0, 'max': 2047, 'step': 1, 'required': true}).buildElement()
          .addInput({'type': 'number', 'id': 'bm-input-py', 'placeholder': 'Px Y', 'min': 0, 'max': 2047, 'step': 1, 'required': true}).buildElement()
        .buildElement()
      .buildElement()
      
      // Color Menu
      .addDiv({ 
        id: 'bm-color-menu',
        style: `
          background: rgba(255, 255, 255, 0.05);
          border-radius: 8px;
          padding: 12px;
          border: 1px solid rgba(255, 255, 255, 0.1);
          margin-top: 8px;
          display: ${JSON.parse(localStorage.getItem('bmShowColorMenu') ?? 'false') ? 'block' : 'none'};
        `
      })
        .addDiv({
          style: 'display: flex; gap: 6px; align-items: center; margin-bottom: 6px;'
        })
          .addDiv({
            innerHTML: '<input type="text" id="bm-color-search" placeholder="🔍 Search colors..." style="flex: 1; padding: 4px 8px; font-size: 11px; border: 1px solid rgba(255,255,255,0.2); border-radius: 4px; background: rgba(255,255,255,0.1); color: white; min-width: 0; max-width: 120px;" autocomplete="off">',
          }).buildElement()
          .addDiv({
            innerHTML: '<select id="bm-color-sort" style="padding: 4px 6px; font-size: 11px; border: 1px solid rgba(255,255,255,0.2); border-radius: 4px; background: rgba(255,255,255,0.1); color: white; flex: 1; min-width: 80px;"><option value="default" style="background: #2a2a2a; color: white;">Default</option><option value="premium" style="background: #2a2a2a; color: white;">Premium 💧</option><option value="most-wrong" style="background: #2a2a2a; color: white;">Most Wrong</option><option value="most-missing" style="background: #2a2a2a; color: white;">Most Missing</option><option value="less-missing" style="background: #2a2a2a; color: white;">Less Missing</option><option value="most-painted" style="background: #2a2a2a; color: white;">Most Painted</option><option value="less-painted" style="background: #2a2a2a; color: white;">Less Painted</option><option value="enhanced" style="background: #2a2a2a; color: white;">Enhanced Only</option><option value="name-asc" style="background: #2a2a2a; color: white;">Name A-Z</option><option value="name-desc" style="background: #2a2a2a; color: white;">Name Z-A</option></select>',
          }).buildElement()
          .addDiv({
            innerHTML: '<button id="bm-color-toggle-all" title="Enable/Disable All Colors" style="padding: 4px 8px; font-size: 11px; border: 1px solid rgba(255,255,255,0.2); border-radius: 4px; background: rgba(255,255,255,0.1); color: white; cursor: pointer; white-space: nowrap;">⚡</button>',
          }).buildElement()
        .buildElement()
        .addDiv({ 
          id: 'bm-color-list',
          style: `
            display: flex;
            flex-direction: column;
            gap: 3px;
            max-height: 140px;
            overflow-y: auto;
            scrollbar-width: thin;
            scrollbar-color: rgba(255,255,255,0.3) transparent;
          `
        }, (instance) => {
          // Initialize color menu after DOM is created and templates are loaded
          setTimeout(() => {
            updateColorMenuDisplay(true, true);
          }, 2000);
        }).buildElement()
        .addDiv({
          id: 'bm-color-menu-resize-handle',
          style: `
            height: 8px;
            background: rgba(255, 255, 255, 0.05);
            cursor: ns-resize;
            border-radius: 0 0 6px 6px;
            display: flex;
            align-items: center;
            justify-content: center;
            transition: background 0.2s;
          `,
          innerHTML: '<div style="width: 30px; height: 3px; background: rgba(255,255,255,0.3); border-radius: 2px;"></div>'
        }, (instance) => {
          // Setup resize functionality
          setTimeout(() => initColorMenuResize(), 100);
        }).buildElement()
      .buildElement()
      .addDiv({'id': 'bm-contain-buttons-template'})
        .addInputFile({'id': 'bm-input-file-template', 'textContent': 'Upload Template', 'accept': 'image/png, image/jpeg, image/webp, image/bmp, image/gif'})
        .addButton({'id': 'bm-button-create', innerHTML: icons.createIcon + 'Create'}, (instance, button) => {
          button.onclick = () => {
            const input = document.querySelector('#bm-input-file-template');

            const coordTlX = document.querySelector('#bm-input-tx');
            if (!coordTlX.checkValidity()) {coordTlX.reportValidity(); instance.handleDisplayError('Coordinates are malformed! Did you try clicking on the canvas first?'); return;}
            const coordTlY = document.querySelector('#bm-input-ty');
            if (!coordTlY.checkValidity()) {coordTlY.reportValidity(); instance.handleDisplayError('Coordinates are malformed! Did you try clicking on the canvas first?'); return;}
            const coordPxX = document.querySelector('#bm-input-px');
            if (!coordPxX.checkValidity()) {coordPxX.reportValidity(); instance.handleDisplayError('Coordinates are malformed! Did you try clicking on the canvas first?'); return;}
            const coordPxY = document.querySelector('#bm-input-py');
            if (!coordPxY.checkValidity()) {coordPxY.reportValidity(); instance.handleDisplayError('Coordinates are malformed! Did you try clicking on the canvas first?'); return;}

            // Kills itself if there is no file
            if (!input?.files[0]) {instance.handleDisplayError(`No file selected!`); return;}

            templateManager.createTemplate(input.files[0], input.files[0]?.name.replace(/\.[^/.]+$/, ''), [Number(coordTlX.value), Number(coordTlY.value), Number(coordPxX.value), Number(coordPxY.value)]);

            // Invalidate cache after template creation
            invalidateTemplateCache();

            // Update mini tracker after template creation
            setTimeout(() => {
              updateMiniTracker();
              updateColorMenuDisplay(false, true); // Force update without resetting filters
            }, 500);

            // console.log(`TCoords: ${apiManager.templateCoordsTilePixel}\nCoords: ${apiManager.coordsTilePixel}`);
            // apiManager.templateCoordsTilePixel = apiManager.coordsTilePixel; // Update template coords
            // console.log(`TCoords: ${apiManager.templateCoordsTilePixel}\nCoords: ${apiManager.coordsTilePixel}`);
            // templateManager.setTemplateImage(input.files[0]);

                      instance.handleDisplayStatus(`Drew to canvas!`);
        }
      }).buildElement()
      .addButton({'id': 'bm-button-manage', innerHTML: icons.manageIcon + 'Manage'}, (instance, button) => {
        button.onclick = () => {
          showTemplateManageDialog(instance);
        }
      }).buildElement()
      .addButton({'id': 'bm-button-pause-tiles', innerHTML: (isTileRefreshPaused() ? icons.playIcon : icons.pauseIcon) + (isTileRefreshPaused() ? 'Resume' : 'Pause')}, (instance, button) => {
        // Set initial CSS class based on current pause state
        if (isTileRefreshPaused()) {
          button.classList.add('paused');
        }
        button.onclick = () => {
          const isPaused = toggleTileRefreshPause(templateManager);
          const cachedCount = getCachedTileCount();
          
          button.innerHTML = `${isPaused ? icons.playIcon : icons.pauseIcon} ${isPaused ? 'Resume' : 'Pause'}${isPaused && cachedCount > 0 ? ` (${cachedCount})` : ''}`;
          
          // Toggle CSS class based on pause state
          if (isPaused) {
            button.classList.add('paused');
          } else {
            button.classList.remove('paused');
          }
          
          instance.handleDisplayStatus(isPaused ? 
            `🧊 Tile refresh paused! Showing frozen template view with ${cachedCount} cached tiles for better performance.` : 
            '▶️ Tile refresh resumed - templates now update in real-time'
          );
        }
      }).buildElement()
      .addButton({'id': 'bm-button-color-filter', innerHTML: icons.colorFilterIcon + 'Color Filter'}, (instance, button) => {
        button.onclick = () => {
          buildColorFilterOverlay();
        }
      }).buildElement()
      .buildElement() // Close bm-contain-buttons-template
      .addTextarea({'id': overlayMain.outputStatusId, 'placeholder': `Status: Sleeping...\nVersion: ${version}`, 'readOnly': true}).buildElement()
      .addDiv({'id': 'bm-contain-buttons-action', 'style': 'position: relative; padding-bottom: 22px;'})
        .addDiv({'style': 'display: flex; gap: 6px; align-items: center;'})
          .addButton({'id': 'bm-button-convert', 'className': 'bm-help', 'innerHTML': '🎨', 'title': 'Template Color Converter'}, 
            (instance, button) => {
            button.addEventListener('click', () => {
              window.open('https://pepoafonso.github.io/color_converter_wplace/', '_blank', 'noopener noreferrer');
            });
          }).buildElement()
          .addButton({'id': 'bm-search', 'className': 'bm-help', 'innerHTML': '🔍', 'title': 'Location Search'}, 
            (instance, button) => {
            button.addEventListener('click', () => {
              const searchPanel = document.getElementById('skirk-search-draggable');
              if (searchPanel) {
                searchPanel.style.display = searchPanel.style.display === 'none' || !searchPanel.style.display ? 'flex' : 'none';
              }
            });
          }).buildElement()
          .addButton({'id': 'bm-button-flyto', 'className': 'bm-help', 'innerHTML': '🗺️', 'title': 'Fly to current coordinates'}, 
            (instance, button) => {
            button.addEventListener('click', () => {
              function coordsToLatLng(tileX, tileY, pixelX, pixelY){
                const z = 40075.016685578485 / 2 ** 11
                const ys = 20037508.342789244
                let metersX = (tileX * 1000 + pixelX) * z - ys
                let metersY = (ys - (tileY * 1000 + pixelY) * z) / ys * 180

                let lat = 180 / Math.PI * (2 * Math.atan(Math.exp(metersY * Math.PI / 180)) - Math.PI / 2)
                let lng = metersX / ys * 180
                return [lat, lng]
              }
              
              const coordTlX = Number(document.querySelector('#bm-input-tx').value);
              const coordTlY = Number(document.querySelector('#bm-input-ty').value);
              const coordPxX = Number(document.querySelector('#bm-input-px').value);
              const coordPxY = Number(document.querySelector('#bm-input-py').value);

              const [lat, lng] = coordsToLatLng(coordTlX, coordTlY, coordPxX, coordPxY);
              
              // Use navigation method setting
              const navigationMethod = Settings.getNavigationMethod();
              
              if (navigationMethod === 'openurl') {
                const zoom = 13.62;
                const url = `https://wplace.live/?lat=${lat}&lng=${lng}&zoom=${zoom}`;
                window.location.href = url;
              } else {
                flyToLatLng(lat, lng);
              }
              
            });
          }).buildElement()
          .addButton({'id': 'bm-button-screenshot', 'className': 'bm-help', 'innerHTML': '📸', 'title': 'Screenshot current template area (auto-detects coordinates)'},
            (instance, button) => {
              button.addEventListener('click', async () => {
                try {
                  // SMART DETECTION: Get currently displayed template or first enabled template
                  let t = null;
                  
                  if (templateManager.smartDetectionEnabled && templateManager.currentlyDisplayedTemplates.size === 1) {
                    // Use the currently displayed template for screenshot
                    const displayedTemplateKey = Array.from(templateManager.currentlyDisplayedTemplates)[0];
                    t = templateManager.templatesArray.find(template => `${template.sortID} ${template.authorID}` === displayedTemplateKey);
                  }
                  
                  // Fallback: Use first enabled template
                  if (!t && templateManager.templatesArray) {
                    for (const template of templateManager.templatesArray) {
                      const templateKey = `${template.sortID} ${template.authorID}`;
                      if (templateManager.isTemplateEnabled(templateKey)) {
                        t = template;
                        break;
                      }
                    }
                  }
                  
                  // Final fallback: Use first template (backward compatibility)
                  if (!t) {
                    t = templateManager.templatesArray?.[0];
                  }
                  
                  if (!t) {
                    instance.handleDisplayError('No template loaded.');
                    return;
                  }
                  
                  // Auto-detect coordinates from active template
                  if (!t.coords || t.coords.length !== 4) {
                    instance.handleDisplayError('Template coordinates not available. Create a template first.');
                    return;
                  }
                  
                  const [tx, ty, px, py] = t.coords;
                  if (!Number.isFinite(tx) || !Number.isFinite(ty) || !Number.isFinite(px) || !Number.isFinite(py)) {
                    instance.handleDisplayError('Invalid template coordinates detected.');
                    return;
                  }
                  
                  if (!t.imageWidth || !t.imageHeight) {
                    // Attempt to infer from chunked tiles if missing
                    try {
                      const tiles = Object.keys(t.chunked || {});
                      if (tiles.length > 0) {
                        let minScaledX = Infinity, minScaledY = Infinity, maxScaledX = 0, maxScaledY = 0;
                        const scale = templateManager.drawMult || 3;
                        const tileSizeScaled = (templateManager.tileSize || 1000) * scale;
                        for (const key of tiles) {
                          const bmp = t.chunked[key];
                          const [tX, tY, pX, pY] = key.split(',').map(Number);
                          const startX = tX * tileSizeScaled + pX * scale;
                          const startY = tY * tileSizeScaled + pY * scale;
                          const endX = startX + bmp.width;
                          const endY = startY + bmp.height;
                          if (startX < minScaledX) minScaledX = startX;
                          if (startY < minScaledY) minScaledY = startY;
                          if (endX > maxScaledX) maxScaledX = endX;
                          if (endY > maxScaledY) maxScaledY = endY;
                        }
                        t.imageWidth = Math.round((maxScaledX - minScaledX) / scale);
                        t.imageHeight = Math.round((maxScaledY - minScaledY) / scale);
                      }
                    } catch (_) {}
                  }
                  if (!t.imageWidth || !t.imageHeight) {
                    instance.handleDisplayError('Template size unavailable; create or reload the template first.');
                    return;
                  }
                  const base = apiManager?.tileServerBase;
                  if (!base) {
                    instance.handleDisplayError('Tile server not detected yet; open the board to load tiles.');
                    return;
                  }
                  const blob = await templateManager.buildTemplateAreaScreenshot(base, [tx, ty, px, py], [t.imageWidth, t.imageHeight]);
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement('a');
                  a.href = url;
                  const ts = new Date().toISOString().replace(/[:.]/g,'-');
                  a.download = `wplace_template_area_${String(tx).padStart(4,'0')},${String(ty).padStart(4,'0')}_${ts}.png`;
                  document.body.appendChild(a);
                  a.click();
                  a.remove();
                  setTimeout(() => URL.revokeObjectURL(url), 1000);
                  instance.handleDisplayStatus(`📸 Saved template area screenshot!\nLocation: Tile ${tx},${ty} • Pixel ${px},${py}\nSize: ${t.imageWidth}×${t.imageHeight}px`);
                } catch (e) {
                  console.error(e);
                  instance.handleDisplayError('Failed to create screenshot');
                }
              });
            }
          ).buildElement()
          // Clear All Storage button
          .addButton({'id': 'bm-button-clear-storage', 'className': 'bm-help', innerHTML: icons.clearStorageIcon, 'title': 'Clear All Storage'}, (instance, button) => {
            button.addEventListener('click', () => {
              clearAllStorage(instance);
            });
          }).buildElement()
          // Import Templates button
          .addButton({'id': 'bm-button-import', 'className': 'bm-help', innerHTML: icons.uploadIcon, 'title': 'Import Templates'}, (instance, button) => {
            button.addEventListener('click', () => {
              showImportDialog(instance);
            });
          }).buildElement()
          // Settings button (direct access)
          .addButton({'id': 'bm-button-settings-direct', 'className': 'bm-help', innerHTML: icons.settingsIcon, 'title': 'Settings (Quick Access)'}, (instance, button) => {
            button.addEventListener('click', () => {
              buildCrosshairSettingsOverlay();
            });
          }).buildElement()
        .buildElement()
        .addDiv({'style': 'position: absolute; left: 0; bottom: 2px; text-align: left; padding: 0; pointer-events: auto; user-select: text; line-height: 12px;'}).
        addSmall({'textContent': `Made by SwingTheVine | Fork Seris0 | v${version}`, 'style': 'color: #94a3b8; font-size: 0.74em; opacity: 0.85;'}).buildElement()        .buildElement()
      .buildElement()
    .buildElement()
  .buildOverlay(document.body);
}

function buildOverlayTabTemplate() {
  overlayTabTemplate.addDiv({'id': 'bm-tab-template', 'style': 'top: 20%; left: 10%;'})
      .addDiv()
        .addDiv({'className': 'bm-dragbar'}).buildElement()
        .addButton({'className': 'bm-button-minimize', 'textContent': '↑'},
          (instance, button) => {
            button.onclick = () => {
              let isMinimized = false;
              if (button.textContent == '↑') {
                button.textContent = '↓';
              } else {
                button.textContent = '↑';
                isMinimized = true;
              }

              
            }
          }
        ).buildElement()
      .buildElement()
    .buildElement()
  .buildOverlay();

}



/** Builds and displays the color filter overlay
 * @since 1.0.0
 */
function buildColorFilterOverlay() {
  // Check if templates are available
  if (!templateManager.templatesArray || templateManager.templatesArray.length === 0) {
    overlayMain.handleDisplayError('No templates available for color filtering!');
    return;
  }

  // Remove existing color filter overlay if it exists
  const existingOverlay = document.getElementById('bm-color-filter-overlay');
  if (existingOverlay) {
    existingOverlay.remove();
  }

  debugLog('[Color Filter] Starting color filter overlay build...');

  // Check if mobile mode is enabled
  const isMobileMode = getMobileMode();
  debugLog(`[Color Filter] Mobile mode: ${isMobileMode ? 'enabled' : 'disabled'}`);

  // Import the color palette from utils
  import('./utils.js').then(utils => {
    const colorPalette = utils.colorpalette;
    
    // Get enhanced pixel analysis data
    debugLog('[Color Filter] Calculating pixel statistics...');
    const pixelStats = templateManager.calculateRemainingPixelsByColor(0, true); // Only enabled templates
    debugLog('[Color Filter] Pixel statistics received:', pixelStats);
    // Update native palette badges as well (if settings enabled)
    try {
      updatePaletteLeftBadges(pixelStats);
    } catch (e) {
      console.warn('Failed to update palette left badges:', e);
    }
    
    // Calculate overall progress
    let totalRequired = 0;
    let totalPainted = 0;
    let totalNeedCrosshair = 0;
    let totalWrong = 0;
    
    // Get excluded colors from localStorage (used for both wrong pixels and main calculation)
    const excludedColors = JSON.parse(localStorage.getItem('bmcf-excluded-colors') || '[]');
    
    // Get wrong pixels from tile progress data (only once) - FILTERED BY ENABLED TEMPLATES
    if (templateManager.tileProgress && templateManager.tileProgress.size > 0) {
      // Get list of enabled templates for filtering (same logic as calculateRemainingPixelsByColor)
      const enabledTemplateKeys = new Set();
      if (templateManager.templatesArray) {
        for (const template of templateManager.templatesArray) {
          const templateKey = `${template.sortID} ${template.authorID}`;
          if (templateManager.isTemplateEnabled(templateKey)) {
            enabledTemplateKeys.add(templateKey);
          }
        }
      }
      
      for (const [tileKey, tileStats] of templateManager.tileProgress.entries()) {
        // Filter tiles by enabled templates only (same logic as calculateRemainingPixelsByColor)
        let shouldIncludeTile = true;
        
        if (enabledTemplateKeys.size > 0) {
          shouldIncludeTile = false;
          const [tileX, tileY] = tileKey.split(',').map(coord => parseInt(coord));
          
          for (const template of templateManager.templatesArray) {
            const templateKey = `${template.sortID} ${template.authorID}`;
            if (!enabledTemplateKeys.has(templateKey)) continue;
            
            if (template.chunked) {
              for (const chunkKey of Object.keys(template.chunked)) {
                const [chunkTileX, chunkTileY] = chunkKey.split(',').map(coord => parseInt(coord));
                if (chunkTileX === tileX && chunkTileY === tileY) {
                  shouldIncludeTile = true;
                  break;
                }
              }
            }
            if (shouldIncludeTile) break;
          }
        }
        
        if (!shouldIncludeTile) continue;
        
        if (tileStats.colorBreakdown) {
          for (const [colorKey, colorStats] of Object.entries(tileStats.colorBreakdown)) {
            // Skip excluded colors from wrong pixels calculation too
            if (excludedColors.includes(colorKey)) {
              continue;
            }
            totalWrong += colorStats.wrong || 0;
          }
        }
      }
    }
    
    for (const [colorKey, stats] of Object.entries(pixelStats)) {
      // Skip excluded colors from progress calculation
      if (excludedColors.includes(colorKey)) {
        continue;
      }
      
      totalRequired += stats.totalRequired || 0;
      totalPainted += stats.painted || 0;
      totalNeedCrosshair += stats.needsCrosshair || 0;
    }
    
    // Apply wrong color logic based on settings
    let overallProgress, displayPainted, displayRequired;
    
    if (templateManager.getIncludeWrongColorsInProgress()) {
      // Wrong colors are ALREADY included in totalPainted from calculateRemainingPixelsByColor()
      // Do NOT add totalWrong again to avoid double counting
      displayPainted = totalPainted;
      displayRequired = totalRequired;
      if (displayRequired > 0) {
        if (displayPainted === displayRequired) {
          overallProgress = 100;
        } else {
          const percentage = (displayPainted / displayRequired) * 100;
          overallProgress = Math.min(Math.round(percentage * 100) / 100, 99.99);
        }
      } else {
        overallProgress = 0;
      }
    } else {
      // Standard calculation (exclude wrong colors)
      displayPainted = totalPainted;
      displayRequired = totalRequired;
      if (displayRequired > 0) {
        if (displayPainted === displayRequired) {
          overallProgress = 100;
        } else {
          const percentage = (displayPainted / displayRequired) * 100;
          overallProgress = Math.min(Math.round(percentage * 100) / 100, 99.99);
        }
      } else {
        overallProgress = 0;
      }
    }
    
    // Inject compact modern styles for Color Filter UI (once)
    if (!document.getElementById('bmcf-styles')) {
      const s = document.createElement('style');
      s.id = 'bmcf-styles';
      s.textContent = `
        :root { 
          --slate-50: #f8fafc; --slate-100: #f1f5f9; --slate-200: #e2e8f0; --slate-300: #cbd5e1; 
          --slate-400: #94a3b8; --slate-500: #64748b; --slate-600: #475569; --slate-700: #334155; 
          --slate-750: #293548; --slate-800: #1e293b; --slate-900: #0f172a; --slate-950: #020617;
          --blue-400: #60a5fa; --blue-500: #3b82f6; --blue-600: #2563eb; --blue-700: #1d4ed8;
          --emerald-400: #34d399; --emerald-500: #10b981; --emerald-600: #059669; --emerald-700: #047857;
          --bmcf-bg: var(--slate-900); --bmcf-card: var(--slate-800); --bmcf-border: var(--slate-700); 
          --bmcf-muted: var(--slate-400); --bmcf-text: var(--slate-100); --bmcf-text-muted: var(--slate-300);
        }
        .bmcf-overlay { 
          width: min(94vw, 670px); max-height: 88vh; background: var(--bmcf-bg); color: var(--bmcf-text); 
          border-radius: 20px; border: 1px solid var(--bmcf-border); 
          box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.7), 0 0 0 1px rgba(255, 255, 255, 0.05); 
          display: flex; flex-direction: column; overflow: hidden; 
          font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; 
          backdrop-filter: blur(16px); position: relative;
        }
        .bmcf-overlay::before {
          content: ''; position: absolute; inset: 0; border-radius: 20px; 
          background: linear-gradient(135deg, rgba(59, 130, 246, 0.1), rgba(16, 185, 129, 0.05)); 
          pointer-events: none;
        }
        .bmcf-header { 
          display: flex; flex-direction: column; padding: 16px 20px 12px 20px; 
          border-bottom: 1px solid var(--bmcf-border); 
          background: linear-gradient(135deg, var(--slate-800), var(--slate-750)); 
          position: relative; z-index: 1;
        }
        .bmcf-content { padding: 20px; overflow: auto; position: relative; z-index: 1; }
        .bmcf-footer { 
          display: flex; gap: 12px; justify-content: center; align-items: center; padding: 16px 20px; 
          border-top: 1px solid var(--bmcf-border); 
          background: linear-gradient(135deg, var(--slate-800), var(--slate-750)); 
          position: relative; z-index: 1;
        }
        .bmcf-btn { 
          display: inline-flex; align-items: center; justify-content: center; height: 40px; 
          padding: 0 18px; min-width: 120px; border-radius: 12px; border: 1px solid var(--bmcf-border); 
          font-size: 0.9em; font-weight: 600; white-space: nowrap; cursor: pointer; 
          transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1); position: relative; overflow: hidden;
          background: var(--slate-700); color: var(--bmcf-text);
        }
        .bmcf-btn::before {
          content: ''; position: absolute; inset: 0; border-radius: 12px; 
          background: linear-gradient(135deg, rgba(255,255,255,0.1), rgba(255,255,255,0.05)); 
          opacity: 0; transition: opacity 0.2s ease;
        }
        .bmcf-btn:hover::before { opacity: 1; }
        .bmcf-btn:hover { transform: translateY(-2px); box-shadow: 0 8px 25px rgba(0,0,0,0.3); }
        .bmcf-btn.success { 
          background: linear-gradient(135deg, var(--emerald-500), var(--emerald-600)); 
          color: white; border-color: var(--emerald-600);
        }
        .bmcf-btn.success:hover { 
          background: linear-gradient(135deg, var(--emerald-600), var(--emerald-700)); 
          box-shadow: 0 8px 25px rgba(16, 185, 129, 0.4);
        }
        .bmcf-btn.primary { 
          background: linear-gradient(135deg, var(--blue-500), var(--blue-600)); 
          color: white; border-color: var(--blue-600);
        }
        .bmcf-btn.primary:hover { 
          background: linear-gradient(135deg, var(--blue-600), var(--blue-700)); 
          box-shadow: 0 8px 25px rgba(59, 130, 246, 0.4);
        }
        .bmcf-input { 
          width: 100%; height: 44px; padding: 12px 16px; border-radius: 12px; 
          border: 1px solid var(--bmcf-border); background: var(--slate-800); color: var(--bmcf-text); 
          outline: none; font-size: 0.95em; transition: all 0.2s ease;
        }
        .bmcf-input:focus { 
          border-color: var(--blue-500); 
          box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.2), 0 4px 12px rgba(59, 130, 246, 0.15); 
        }
        @media (max-width: 520px) { .bmcf-btn { min-width: 100px; height: 36px; font-size: 0.85em; } }
        
        /* View toggle guards - prevent grid/list overlap */
        .bmcf-view-container .bmcf-grid { display: grid; }
        .bmcf-view-container .bmcf-list { display: none; }
        .bmcf-view-container.list-mode .bmcf-grid { display: none !important; }
        .bmcf-view-container.list-mode .bmcf-list { display: flex !important; }
        
        /* Mobile Mode will be applied dynamically via applyMobileModeToColorFilter() */
      `;
      document.head.appendChild(s);
    }

    // Initialize pending excluded colors (copy from applied if not exists)
    if (!localStorage.getItem('bmcf-excluded-colors-pending')) {
      const appliedExcluded = localStorage.getItem('bmcf-excluded-colors') || '[]';
      localStorage.setItem('bmcf-excluded-colors-pending', appliedExcluded);
    }
    
    // Create the color filter overlay
    const colorFilterOverlay = document.createElement('div');
    colorFilterOverlay.id = 'bm-color-filter-overlay';
    colorFilterOverlay.style.cssText = `
      position: fixed;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      z-index: 9001;
      ${isMobileMode ? 'max-width: 95vw; max-height: 90vh;' : ''}
    `;
    colorFilterOverlay.className = 'bmcf-overlay';

    // Header
    const header = document.createElement('div');
    header.className = 'bmcf-header';
    header.style.cssText = `cursor: move; user-select:none; flex-shrink:0; flex-direction: column;`;

    // Drag bar (similar to main overlay)
    const dragBar = document.createElement('div');
    dragBar.className = 'bmcf-drag-bar';
    dragBar.style.cssText = `
      background: linear-gradient(90deg, #475569 0%, #64748b 50%, #475569 100%);
      border-radius: 4px;
      cursor: grab;
      width: 100%;
      height: 6px;
      margin-bottom: 8px;
      opacity: 0.8;
      transition: opacity 0.2s ease;
    `;

    // Drag bar hover effect
    dragBar.addEventListener('mouseenter', () => {
      dragBar.style.opacity = '1';
    });
    dragBar.addEventListener('mouseleave', () => {
      dragBar.style.opacity = '0.8';
    });

    // Container for title and close button
    const titleContainer = document.createElement('div');
    titleContainer.style.cssText = `
      display: flex;
      align-items: center;
      justify-content: space-between;
      width: 100%;
    `;

    const title = document.createElement('h2');
    title.textContent = 'Template Color Filter';
    const titleFontSize = isMobileMode ? '1.2em' : '1.5em';
    title.style.cssText = `
      margin: 0; 
      font-size: ${titleFontSize}; 
      font-weight: 700;
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
      text-align: center;
      flex: 1;
      pointer-events: none;
      letter-spacing: -0.025em;
      background: linear-gradient(135deg, var(--slate-100), var(--slate-300));
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
    `;

    const closeButton = document.createElement('button');
    closeButton.textContent = '✕';
    const buttonSize = isMobileMode ? '32px' : '36px';
    const buttonFontSize = isMobileMode ? '14px' : '16px';
    closeButton.style.cssText = `
      background: linear-gradient(135deg, #ef4444, #dc2626);
      border: 1px solid rgba(239, 68, 68, 0.3);
      color: white;
      width: ${buttonSize};
      height: ${buttonSize};
      border-radius: 12px;
      cursor: pointer;
      font-size: ${buttonFontSize};
      font-weight: 600;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
      position: relative;
      overflow: hidden;
    `;
    // Add hover effects but prevent them on touch devices
    closeButton.onmouseover = () => {
      closeButton.style.transform = 'translateY(-1px) scale(1.05)';
      closeButton.style.boxShadow = '0 6px 20px rgba(239, 68, 68, 0.4)';
    };
    closeButton.onmouseout = () => {
      closeButton.style.transform = '';
      closeButton.style.boxShadow = '';
    };
    
    // Prevent hover effects on touch by immediately resetting styles on touchstart
    closeButton.addEventListener('touchstart', () => {
      closeButton.style.transform = '';
      closeButton.style.boxShadow = '';
    }, { passive: true });
    
    closeButton.onclick = () => {
      // Discard pending changes when closing without applying
      localStorage.removeItem('bmcf-excluded-colors-pending');
      colorFilterOverlay.remove();
    };

    // Settings button 
    const settingsButton = document.createElement('button');
    settingsButton.innerHTML = icons.settingsIcon;
    settingsButton.style.cssText = `
      background: linear-gradient(135deg, var(--slate-600), var(--slate-700));
      border: 1px solid var(--slate-500);
      color: var(--slate-200);
      width: ${buttonSize};
      height: ${buttonSize};
      border-radius: 12px;
      cursor: pointer;
      font-size: ${buttonFontSize};
      display: flex;
      align-items: center;
      justify-content: center;
      margin-right: 12px;
      transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
      position: relative;
      overflow: hidden;
    `;
    // Add hover effects but prevent them on touch devices
    settingsButton.onmouseover = () => {
      settingsButton.style.transform = 'translateY(-1px) scale(1.05)';
      settingsButton.style.background = 'linear-gradient(135deg, var(--slate-500), var(--slate-600))';
      settingsButton.style.boxShadow = '0 6px 20px rgba(71, 85, 105, 0.3)';
    };
    settingsButton.onmouseout = () => {
      settingsButton.style.transform = '';
      settingsButton.style.background = 'linear-gradient(135deg, var(--slate-600), var(--slate-700))';
      settingsButton.style.boxShadow = '';
    };
    
    // Prevent hover effects on touch by immediately resetting styles on touchstart
    settingsButton.addEventListener('touchstart', () => {
      settingsButton.style.transform = '';
      settingsButton.style.background = 'linear-gradient(135deg, var(--slate-600), var(--slate-700))';
      settingsButton.style.boxShadow = '';
    }, { passive: true });
    settingsButton.onclick = () => buildCrosshairSettingsOverlay();

    // View toggle button (Grid/List)
    const viewToggleButton = document.createElement('button');
    viewToggleButton.innerHTML = '📋'; // List icon
    viewToggleButton.title = 'Toggle between Grid and List view';
    viewToggleButton.style.cssText = `
      background: linear-gradient(135deg, var(--slate-600), var(--slate-700));
      border: 1px solid var(--slate-500);
      color: var(--slate-200);
      width: ${buttonSize};
      height: ${buttonSize};
      border-radius: 12px;
      cursor: pointer;
      font-size: ${buttonFontSize};
      display: flex;
      align-items: center;
      justify-content: center;
      margin-right: 12px;
      transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
      position: relative;
      overflow: hidden;
    `;
    
    // State variable for current view mode - restore from localStorage
    const savedPreference = localStorage.getItem('bmcf-view-preference');
    let isListView = savedPreference === 'list';
    
    // Add hover effects but prevent them on touch devices
    viewToggleButton.onmouseover = () => {
      viewToggleButton.style.transform = 'translateY(-1px) scale(1.05)';
      viewToggleButton.style.background = 'linear-gradient(135deg, var(--slate-500), var(--slate-600))';
      viewToggleButton.style.boxShadow = '0 6px 20px rgba(71, 85, 105, 0.3)';
    };
    viewToggleButton.onmouseout = () => {
      viewToggleButton.style.transform = '';
      viewToggleButton.style.background = 'linear-gradient(135deg, var(--slate-600), var(--slate-700))';
      viewToggleButton.style.boxShadow = '';
    };
    
    // Prevent hover effects on touch by immediately resetting styles on touchstart
    viewToggleButton.addEventListener('touchstart', () => {
      viewToggleButton.style.transform = '';
      viewToggleButton.style.background = 'linear-gradient(135deg, var(--slate-600), var(--slate-700))';
      viewToggleButton.style.boxShadow = '';
    }, { passive: true });

    // Toggle view functionality
    const toggleView = () => {
      isListView = !isListView;
      
      // Save preference to localStorage
      localStorage.setItem('bmcf-view-preference', isListView ? 'list' : 'grid');
      
      // Use CSS classes to control visibility - this prevents DOM manipulation conflicts
      if (isListView) {
        colorViewContainer.classList.add('list-mode');
        viewToggleButton.innerHTML = '⊞'; // Grid icon
        viewToggleButton.title = 'Switch to Grid view';
      } else {
        colorViewContainer.classList.remove('list-mode');
        viewToggleButton.innerHTML = '📋'; // List icon
        viewToggleButton.title = 'Switch to List view';
      }
      
      // Force layout recalculation
      colorViewContainer.offsetHeight;
      
      // Re-apply current filter to the new view
      if (typeof filterSelect !== 'undefined' && filterSelect.value) {
        applyFilter(filterSelect.value);
      }
      
      // Re-apply current search to the new view
      if (typeof searchInput !== 'undefined' && searchInput.value.trim()) {
        const searchTerm = searchInput.value.toLowerCase().trim();
        const currentViewItems = isListView ? 
          Array.from(colorList.querySelectorAll('[data-color-item]')) : 
          Array.from(colorGrid.querySelectorAll('[data-color-item]'));
        
        currentViewItems.forEach(item => {
          const colorName = item.getAttribute('data-color-name').toLowerCase();
          if (colorName.includes(searchTerm)) {
            item.style.display = 'flex';
          } else {
            item.style.display = 'none';
          }
        });
      }
    };

    viewToggleButton.onclick = toggleView;

    // Initialize view state based on saved preference
    const initializeViewState = () => {
      // Use CSS classes for clean view switching
      if (isListView) {
        colorViewContainer.classList.add('list-mode');
        viewToggleButton.innerHTML = '⊞'; // Grid icon
        viewToggleButton.title = 'Switch to Grid view';
      } else {
        colorViewContainer.classList.remove('list-mode');
        viewToggleButton.innerHTML = '📋'; // List icon
        viewToggleButton.title = 'Switch to List view';
      }
      
      // Force layout recalculation
      colorViewContainer.offsetHeight;
    };

    // Compact List button
    const compactListButton = document.createElement('button');
    compactListButton.innerHTML = '📌';
    compactListButton.title = 'Toggle Compact Color List';
    compactListButton.style.cssText = `
      background: linear-gradient(135deg, var(--slate-600), var(--slate-700));
      border: 1px solid var(--slate-500);
      color: var(--slate-200);
      width: ${buttonSize};
      height: ${buttonSize};
      border-radius: 12px;
      cursor: pointer;
      font-size: ${buttonFontSize};
      display: flex;
      align-items: center;
      justify-content: center;
      margin-right: 12px;
      transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
      position: relative;
      overflow: hidden;
    `;
    compactListButton.onmouseover = () => {
      compactListButton.style.transform = 'translateY(-1px) scale(1.05)';
      compactListButton.style.background = 'linear-gradient(135deg, var(--slate-500), var(--slate-600))';
      compactListButton.style.boxShadow = '0 6px 20px rgba(71, 85, 105, 0.3)';
    };
    compactListButton.onmouseout = () => {
      compactListButton.style.transform = '';
      compactListButton.style.background = 'linear-gradient(135deg, var(--slate-600), var(--slate-700))';
      compactListButton.style.boxShadow = '';
    };
    compactListButton.addEventListener('touchstart', () => {
      compactListButton.style.transform = '';
      compactListButton.style.background = 'linear-gradient(135deg, var(--slate-600), var(--slate-700))';
      compactListButton.style.boxShadow = '';
    }, { passive: true });

    // Add elements to titleContainer
    titleContainer.appendChild(title);
    titleContainer.appendChild(viewToggleButton);
    titleContainer.appendChild(compactListButton);
    titleContainer.appendChild(settingsButton);
    titleContainer.appendChild(closeButton);

    // Add drag bar and titleContainer to header
    header.appendChild(dragBar);
    header.appendChild(titleContainer);

    // Progress Summary
    const progressSummary = document.createElement('div');
    progressSummary.style.cssText = `
      background: linear-gradient(135deg, var(--slate-800), var(--slate-750));
      border: 1px solid var(--bmcf-border);
      border-radius: 16px;
      padding: 20px;
      margin-bottom: 24px;
      color: var(--bmcf-text);
      text-align: center;
      position: relative;
      overflow: hidden;
    `;
    
    // Add subtle background pattern
    progressSummary.innerHTML = `
      <div style="
        position: absolute; inset: 0; 
        background: radial-gradient(circle at 20% 20%, rgba(59, 130, 246, 0.1), transparent 50%),
                    radial-gradient(circle at 80% 80%, rgba(16, 185, 129, 0.08), transparent 50%);
        pointer-events: none;
      "></div>
      <div style="position: relative; z-index: 1;">
        <div style="
          font-size: 1.2em; font-weight: 700; margin-bottom: 12px; 
          color: var(--bmcf-text);
        ">
          <span style="margin-right: 8px;">📊</span>
          <span style="
            background: linear-gradient(135deg, var(--blue-400), var(--emerald-400));
            -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text;
          ">Template Progress: ${overallProgress}%</span>
        </div>
        <div style="font-size: 0.95em; color: var(--bmcf-text-muted); margin-bottom: 16px; line-height: 1.5;">
          ${displayPainted.toLocaleString()} / ${displayRequired.toLocaleString()} pixels painted
          ${templateManager.getIncludeWrongColorsInProgress() && totalWrong > 0 ? ` (includes ${totalWrong.toLocaleString()} wrong)` : ''}
        </div>
        <div style="
          width: 100%; height: 12px; background: var(--slate-700); 
          border-radius: 8px; overflow: hidden; position: relative;
          box-shadow: inset 0 2px 4px rgba(0,0,0,0.3);
        ">
          <div style="
            width: ${overallProgress}%; height: 100%; 
            background: linear-gradient(90deg, var(--blue-500), var(--emerald-500)); 
            transition: width 0.4s cubic-bezier(0.4, 0, 0.2, 1);
            position: relative;
          ">
            <div style="
              position: absolute; inset: 0; 
              background: linear-gradient(90deg, transparent, rgba(255,255,255,0.2), transparent);
              animation: shimmer 2s infinite;
            "></div>
          </div>
        </div>
        <div style="
          font-size: 0.85em; color: #fbbf24; margin-top: 12px; font-weight: 600;
          text-shadow: 0 1px 2px rgba(0,0,0,0.5);
        ">
          ${totalNeedCrosshair.toLocaleString()} Pixels Remaining
        </div>
      </div>
      <style>
        @keyframes shimmer {
          0% { transform: translateX(-100%); }
          100% { transform: translateX(100%); }
        }
      </style>
    `;

    // Include Wrong Color Pixels in Progress - moved below progress bar
    const includeWrongProgressContainer = document.createElement('div');
    includeWrongProgressContainer.style.cssText = `
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 12px 16px;
      background: linear-gradient(135deg, var(--slate-800), var(--slate-750));
      border-radius: 12px;
      border: 1px solid var(--bmcf-border);
      margin-bottom: 24px;
      transition: all 0.2s ease;
      cursor: pointer;
    `;
    includeWrongProgressContainer.onmouseover = () => {
      includeWrongProgressContainer.style.background = 'linear-gradient(135deg, var(--slate-750), var(--slate-700))';
      includeWrongProgressContainer.style.transform = 'translateY(-1px)';
    };
    includeWrongProgressContainer.onmouseout = () => {
      includeWrongProgressContainer.style.background = 'linear-gradient(135deg, var(--slate-800), var(--slate-750))';
      includeWrongProgressContainer.style.transform = '';
    };

    const includeWrongProgressCheckbox = document.createElement('input');
    includeWrongProgressCheckbox.type = 'checkbox';
    includeWrongProgressCheckbox.id = 'bm-include-wrong-progress';
    includeWrongProgressCheckbox.checked = templateManager.getIncludeWrongColorsInProgress();
    includeWrongProgressCheckbox.style.cssText = `
      width: 18px;
      height: 18px;
      cursor: pointer;
      accent-color: var(--blue-500);
      border-radius: 4px;
    `;

    const includeWrongProgressLabel = document.createElement('label');
    includeWrongProgressLabel.htmlFor = 'bm-include-wrong-progress';
    includeWrongProgressLabel.textContent = 'Include Wrong Color Pixels in Progress';
    includeWrongProgressLabel.style.cssText = `
      color: var(--bmcf-text);
      font-size: 0.95em;
      font-weight: 500;
      cursor: pointer;
      user-select: none;
      flex: 1;
      letter-spacing: -0.01em;
    `;

    // Event listener for include wrong colors in progress
    includeWrongProgressCheckbox.addEventListener('change', async () => {
      const enabled = includeWrongProgressCheckbox.checked;
      await templateManager.setIncludeWrongColorsInProgress(enabled);
      overlayMain.handleDisplayStatus(`Include wrong colors in progress ${enabled ? 'enabled' : 'disabled'}!`);
      
      // Force refresh color filter overlay to update progress calculations immediately
      buildColorFilterOverlay();
    });

    includeWrongProgressContainer.appendChild(includeWrongProgressCheckbox);
    includeWrongProgressContainer.appendChild(includeWrongProgressLabel);

    // Instructions
    const instructions = document.createElement('p');
    instructions.textContent = 'Click on colors to toggle their visibility in the template.';
    instructions.style.cssText = `
      margin: 0 0 24px 0; 
      font-size: 0.95em; 
      color: var(--bmcf-text-muted); 
      text-align: center; 
      font-weight: 500;
      letter-spacing: -0.01em;
      line-height: 1.4;
    `;

    // Search box
    const searchContainer = document.createElement('div');
    searchContainer.style.cssText = `
      margin: 0 0 24px 0;
      position: relative;
    `;

    const searchInput = document.createElement('input');
    searchInput.className = 'bmcf-input';
    searchInput.type = 'text';
    searchInput.id = 'bm-color-search';
    searchInput.placeholder = 'Search colors by name or RGB (e.g., "red", "255,0,0")...';
    searchInput.autocomplete = 'off';
    searchInput.spellcheck = false;
    searchInput.style.cssText = `
      width: 100%;
      padding: 14px 50px 14px 48px;
      border: 1px solid var(--bmcf-border);
      border-radius: 12px;
      background: var(--slate-800);
      color: var(--bmcf-text);
      font-size: 0.95em;
      font-weight: 400;
      outline: none;
      transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
      box-sizing: border-box;
      font-family: inherit;
      -webkit-user-select: text;
      -moz-user-select: text;
      -ms-user-select: text;
      user-select: text;
      pointer-events: auto;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
    `;

    const searchIcon = document.createElement('div');
    searchIcon.innerHTML = '🔍';
    searchIcon.style.cssText = `
      position: absolute;
      left: 16px;
      top: 50%;
      transform: translateY(-50%);
      font-size: 1.2em;
      pointer-events: none;
      opacity: 0.6;
    `;

    const searchClearButton = document.createElement('button');
    searchClearButton.innerHTML = '✕';
    searchClearButton.style.cssText = `
      position: absolute;
      right: 16px;
      top: 50%;
      transform: translateY(-50%);
      background: var(--slate-600);
      border: 1px solid var(--slate-500);
      border-radius: 8px;
      color: var(--slate-300);
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      padding: 0;
      width: 24px;
      height: 24px;
      display: none;
      align-items: center;
      justify-content: center;
      transition: all 0.2s ease;
    `;
    searchClearButton.onmouseover = () => {
      searchClearButton.style.background = 'var(--slate-500)';
      searchClearButton.style.color = 'var(--slate-100)';
    };
    searchClearButton.onmouseout = () => {
      searchClearButton.style.background = 'var(--slate-600)';
      searchClearButton.style.color = 'var(--slate-300)';
    };

    searchContainer.appendChild(searchInput);
    searchContainer.appendChild(searchIcon);
    searchContainer.appendChild(searchClearButton);

    // Search functionality
    const performSearch = (searchTerm) => {
      const term = searchTerm.toLowerCase().trim();
      // Get items from both views but only apply to the currently visible view
      const gridItems = colorGrid.querySelectorAll('[data-color-item]');
      const listItems = colorList.querySelectorAll('[data-color-item]');
      const colorItems = isListView ? listItems : gridItems;
      let visibleCount = 0;

      colorItems.forEach(item => {
        const colorName = item.getAttribute('data-color-name').toLowerCase();
        const colorRgb = item.getAttribute('data-color-rgb');
        
        // Search by name or RGB values
        const matchesName = colorName.includes(term);
        const matchesRgb = colorRgb.includes(term);
        const matchesRgbFormatted = colorRgb.replace(/,/g, ' ').includes(term);
        
        if (term === '' || matchesName || matchesRgb || matchesRgbFormatted) {
          item.style.display = 'flex';
          visibleCount++;
        } else {
          item.style.display = 'none';
        }
      });

      // Show/hide clear button
      if (term) {
        searchClearButton.style.display = 'flex';
      } else {
        searchClearButton.style.display = 'none';
      }

      // Update search input border color based on results
      if (term && visibleCount === 0) {
        searchInput.style.borderColor = '#ef4444'; // Red if no results
        searchInput.style.boxShadow = '0 0 0 3px rgba(239, 68, 68, 0.2)';
      } else {
        searchInput.style.borderColor = 'var(--bmcf-border)'; // Default
        searchInput.style.boxShadow = '0 2px 4px rgba(0,0,0,0.1)';
      }
    };

    // Search input event listeners
    searchInput.addEventListener('input', (e) => {
      performSearch(e.target.value);
    });

    searchInput.addEventListener('focus', () => {
      searchInput.style.borderColor = 'var(--blue-500)';
      searchInput.style.boxShadow = '0 0 0 3px rgba(59, 130, 246, 0.2), 0 4px 12px rgba(59, 130, 246, 0.15)';
    });

    searchInput.addEventListener('blur', () => {
      if (!searchInput.value) {
        searchInput.style.borderColor = 'var(--bmcf-border)';
        searchInput.style.boxShadow = '0 2px 4px rgba(0,0,0,0.1)';
      }
    });

    // Prevent any interference with spacebar and other keys
    searchInput.addEventListener('keydown', (e) => {
      // Allow all normal typing including spacebar
      e.stopPropagation();
    });

    searchInput.addEventListener('keyup', (e) => {
      // Allow all normal typing including spacebar
      e.stopPropagation();
    });

    searchInput.addEventListener('keypress', (e) => {
      // Allow all normal typing including spacebar
      e.stopPropagation();
    });

    // Clear button functionality
    searchClearButton.addEventListener('click', () => {
      searchInput.value = '';
      performSearch('');
      searchInput.focus();
    });

    // Color Filter/Sort Section
    const filterContainer = document.createElement('div');
    filterContainer.style.cssText = `
      margin-bottom: 20px;
      display: flex;
      align-items: center;
      gap: 10px;
    `;

    const filterLabel = document.createElement('label');
    filterLabel.textContent = 'Sort by:';
    filterLabel.style.cssText = `
      color: white;
      font-size: 0.9em;
      font-weight: bold;
      min-width: 60px;
    `;

    const filterSelect = document.createElement('select');
    filterSelect.style.cssText = `
      flex: 1;
      padding: 6px 14px;
      border: 2px solid rgba(255, 255, 255, 0.2);
      border-radius: 6px;
      background: rgba(0, 0, 0, 0.3);
      color: white;
      font-size: 0.9em;
      outline: none;
      cursor: pointer;
    `;

    // Filter options
    const filterOptions = [
      { value: 'default', text: 'Default Order' },
      { value: 'premium', text: 'Premium (Most Missing)' },
      { value: 'enhanced', text: 'Enhanced Colors Only' },
      { value: 'wrong-desc', text: 'Most Wrong Colors' },
      { value: 'wrong-asc', text: 'Least Wrong Colors' },
      { value: 'missing-desc', text: 'Most Pixels Missing' },
      { value: 'missing-asc', text: 'Least Pixels Missing' },
      { value: 'total-desc', text: 'Most Total Pixels' },
      { value: 'total-asc', text: 'Least Total Pixels' },
      { value: 'percentage-desc', text: 'Highest Completion %' },
      { value: 'percentage-asc', text: 'Lowest Completion %' },
      { value: 'name-asc', text: 'Name A-Z' },
      { value: 'name-desc', text: 'Name Z-A' }
    ];

    filterOptions.forEach(option => {
      const optionElement = document.createElement('option');
      optionElement.value = option.value;
      optionElement.textContent = option.text;
      optionElement.style.cssText = `
        background: #2a2a2a;
        color: white;
      `;
      filterSelect.appendChild(optionElement);
    });

    // Store original order when color items are created
    let originalGridOrder = [];
    let originalListOrder = [];

    filterContainer.appendChild(filterLabel);
    filterContainer.appendChild(filterSelect);

    // Enhanced mode info section
    const enhancedSection = document.createElement('div');
    enhancedSection.style.cssText = `
      margin-bottom: 20px;
    `;

    const enhancedInfo = document.createElement('div');
    enhancedInfo.textContent = 'Enhanced: Highlight the Pixels.';
    enhancedInfo.style.cssText = `
      background: #333;
      color: white;
      padding: 6px 14px;
      border-radius: 6px;
      font-size: 0.9em;
      font-weight: bold;
      text-align: center;
      margin-bottom: 10px;
    `;

    // Main buttons container (Enable All / Disable All)
    const mainButtonsContainer = document.createElement('div');
    mainButtonsContainer.style.cssText = `
      display: flex;
      gap: 10px;
      margin-bottom: 10px;
    `;

    const enableAllButton = document.createElement('button');
    enableAllButton.textContent = 'Enable All';
    enableAllButton.style.cssText = `
      background: #4caf50;
      border: none;
      color: white;
      padding: 8px 16px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 0.9em;
      white-space: nowrap;
      flex: 1;
    `;

    const disableAllButton = document.createElement('button');
    disableAllButton.textContent = 'Disable All';
    disableAllButton.style.cssText = `
      background: #f44336;
      border: none;
      color: white;
      padding: 8px 16px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 0.9em;
      white-space: nowrap;
      flex: 1;
    `;

    // Disable Enhanced button (full width below)
    const disableAllEnhancedButton = document.createElement('button');
    disableAllEnhancedButton.textContent = 'Disable all Enhanced';
    disableAllEnhancedButton.style.cssText = `
      background: #6c757d;
      color: white;
      border: none;
      padding: 6px 14px;
      border-radius: 6px;
      cursor: pointer;
      width: 100%;
      font-size: 0.9em;
    `;

    mainButtonsContainer.appendChild(enableAllButton);
    mainButtonsContainer.appendChild(disableAllButton);
    
    enhancedSection.appendChild(enhancedInfo);
    enhancedSection.appendChild(mainButtonsContainer);
    enhancedSection.appendChild(disableAllEnhancedButton);

    // Enhance Wrong Colors - moved below Disable All Enhanced
    const enhanceWrongContainer = document.createElement('div');
    enhanceWrongContainer.style.cssText = `
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 14px;
      background: rgba(255, 255, 255, 0.1);
      border-radius: 6px;
      border: 1px solid rgba(255, 255, 255, 0.2);
      margin-top: 10px;
    `;

    const enhanceWrongCheckbox = document.createElement('input');
    enhanceWrongCheckbox.type = 'checkbox';
    enhanceWrongCheckbox.id = 'bm-enhance-wrong-enhanced';
    enhanceWrongCheckbox.checked = templateManager.getEnhanceWrongColors();
    enhanceWrongCheckbox.style.cssText = `
      width: 16px;
      height: 16px;
      cursor: pointer;
    `;

    const enhanceWrongLabel = document.createElement('label');
    enhanceWrongLabel.htmlFor = 'bm-enhance-wrong-enhanced';
    enhanceWrongLabel.textContent = 'Enhance Wrong Colors (Crosshair)';
    enhanceWrongLabel.style.cssText = `
      color: white;
      font-size: 0.9em;
      cursor: pointer;
      user-select: none;
      flex: 1;
    `;

    // Event listener for enhance wrong colors
    enhanceWrongCheckbox.addEventListener('change', async () => {
      const enabled = enhanceWrongCheckbox.checked;
      await templateManager.setEnhanceWrongColors(enabled);
      overlayMain.handleDisplayStatus(`Wrong colors crosshair ${enabled ? 'enabled' : 'disabled'}!`);
      
      invalidateTemplateCache();
    });

    enhanceWrongContainer.appendChild(enhanceWrongCheckbox);
    enhanceWrongContainer.appendChild(enhanceWrongLabel);
    enhancedSection.appendChild(enhanceWrongContainer);







    // Color grid
    const colorGrid = document.createElement('div');
    colorGrid.className = 'bmcf-grid';
    colorGrid.style.cssText = `
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 8px;
      margin-bottom: 20px;
      justify-content: center;
    `;

    // Color list (alternative view)
    const colorList = document.createElement('div');
    colorList.className = 'bmcf-list';
    colorList.style.cssText = `
      display: none;
      flex-direction: column;
      gap: 8px;
      margin-bottom: 20px;
    `;

    // Container to hold both grid and list
    const colorViewContainer = document.createElement('div');
    colorViewContainer.className = 'bmcf-view-container';
    colorViewContainer.style.cssText = `
      position: relative;
      width: 100%;
    `;
    colorViewContainer.appendChild(colorGrid);
    colorViewContainer.appendChild(colorList);

    // Get current template
    const currentTemplate = templateManager.templatesArray[0];

    // Create color items
    colorPalette.forEach((colorInfo, index) => {
      // Flag to prevent sync loops between grid and list
      let isSyncing = false;
      
      const colorItem = document.createElement('div');
      colorItem.className = 'bmcf-card';
      const rgb = colorInfo.rgb;
      const colorKey = `${rgb[0]},${rgb[1]},${rgb[2]}`;
      const isFreeColor = colorInfo.free;
      const isDisabled = currentTemplate.isColorDisabled(rgb);
      const isEnhanced = currentTemplate.isColorEnhanced ? currentTemplate.isColorEnhanced(rgb) : false;
      
      // Add data attributes for search functionality
      colorItem.setAttribute('data-color-item', 'true');
      colorItem.setAttribute('data-color-name', colorInfo.name);
      colorItem.setAttribute('data-color-rgb', rgb.join(','));
      
      colorItem.style.cssText = `
        background: rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]});
        border: 3px solid ${isDisabled ? '#f44336' : '#4caf50'};
        border-radius: 8px;
        padding: 6px 6px 14px 6px;
        text-align: center;
        transition: all 0.2s ease;
        position: relative;
        width: 100%;
        height: 120px;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: flex-start;
        box-sizing: border-box;
        overflow: hidden;
      `;

      // Desktop: keep content more central to avoid items glued to the top
      if (!isMobileMode) {
        colorItem.style.padding = '12px 8px 16px 8px';
        colorItem.style.justifyContent = 'center';
      }

      // Color info and controls container
      const controlsContainer = document.createElement('div');
      controlsContainer.style.cssText = `
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 2px;
        width: 100%;
        flex-shrink: 0;
      `;

      // Color enable/disable click area (main area)
      const colorClickArea = document.createElement('div');
      colorClickArea.style.cssText = `
        width: 100%;
        height: 20px;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        position: relative;
        flex-shrink: 0;
      `;

      // Add overlay for disabled state
      if (isDisabled) {
        const overlay = document.createElement('div');
        overlay.style.cssText = `
          position: absolute;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          background: rgba(244, 67, 54, 0.3);
          border-radius: 5px;
          display: flex;
          align-items: center;
          justify-content: center;
          color: white;
          font-weight: bold;
          font-size: 16px;
        `;
        overlay.textContent = '✕';
        colorClickArea.appendChild(overlay);
      }

      // Enhanced mode checkbox
      const enhancedContainer = document.createElement('div');
      enhancedContainer.className = 'bmcf-enhanced';
      enhancedContainer.style.cssText = `
        display: flex;
        align-items: center;
        gap: 2px;
        font-size: 9px;
        color: white;
        text-shadow: 1px 1px 1px rgba(0,0,0,0.8);
        font-weight: bold;
        flex-shrink: 0;
      `;

      const enhancedCheckbox = document.createElement('input');
      enhancedCheckbox.type = 'checkbox';
      enhancedCheckbox.checked = isEnhanced;
      enhancedCheckbox.disabled = isDisabled; // Disable checkbox if color is disabled
      enhancedCheckbox.style.cssText = `
        width: 12px;
        height: 12px;
        cursor: pointer;
      `;

      const enhancedLabel = document.createElement('label');
      enhancedLabel.textContent = 'Enhanced';
      enhancedLabel.style.cssText = `
        cursor: pointer;
        user-select: none;
      `;

      enhancedContainer.appendChild(enhancedCheckbox);
      enhancedContainer.appendChild(enhancedLabel);

      // Slight top spacing on desktop to avoid sticking to top border
      if (!isMobileMode) {
        enhancedContainer.style.marginTop = '6px';
      }

      controlsContainer.appendChild(colorClickArea);
      controlsContainer.appendChild(enhancedContainer);
      colorItem.appendChild(controlsContainer);

      const colorName = document.createElement('div');
      colorName.className = 'bmcf-color-name';
      colorName.textContent = colorInfo.name;
      colorName.style.cssText = `
        font-size: 0.75em;
        text-shadow: 1px 1px 2px rgba(0,0,0,0.8);
        color: white;
        font-weight: bold;
        z-index: 1;
        position: relative;
        text-align: center;
        margin-bottom: 6px;
        flex-shrink: 0;
        line-height: 1.1;
      `;

      const dropletIcon = document.createElement('div');
      dropletIcon.textContent = "💧";
      dropletIcon.style.cssText = `
        font-size: 0.7em;
        position: absolute;
        bottom: 2px;
        right: 4px;
        z-index: 2;
      `;

      // Exclude from progress icon (top-left corner)
      const excludeIcon = document.createElement('div');
      excludeIcon.textContent = "👁️";
      excludeIcon.title = "Click to exclude/include this color from progress calculation";
      excludeIcon.style.cssText = `
        font-size: 0.8em;
        position: absolute;
        top: 4px;
        left: 4px;
        z-index: 3;
        cursor: pointer;
        opacity: 0.7;
        transition: all 0.2s ease;
        background: rgba(0,0,0,0.3);
        border-radius: 50%;
        width: 20px;
        height: 20px;
        display: flex;
        align-items: center;
        justify-content: center;
      `;

      // Check if color is excluded from progress (check both applied and pending)
      const appliedExcluded = JSON.parse(localStorage.getItem('bmcf-excluded-colors') || '[]');
      const pendingExcluded = JSON.parse(localStorage.getItem('bmcf-excluded-colors-pending') || JSON.stringify(appliedExcluded));
      const isExcluded = pendingExcluded.includes(colorKey);
      
      if (isExcluded) {
        excludeIcon.textContent = "🚫";
        excludeIcon.style.opacity = '1';
        excludeIcon.style.background = 'rgba(244, 67, 54, 0.8)';
      }

      excludeIcon.onmouseenter = () => {
        excludeIcon.style.opacity = '1';
        excludeIcon.style.transform = 'scale(1.1)';
      };
      
      excludeIcon.onmouseleave = () => {
        excludeIcon.style.opacity = isExcluded ? '1' : '0.7';
        excludeIcon.style.transform = 'scale(1)';
      };

      excludeIcon.onclick = (e) => {
        e.stopPropagation();
        const pendingExcluded = JSON.parse(localStorage.getItem('bmcf-excluded-colors-pending') || JSON.stringify(JSON.parse(localStorage.getItem('bmcf-excluded-colors') || '[]')));
        
        if (pendingExcluded.includes(colorKey)) {
          // Remove from pending excluded list
          const newPendingExcluded = pendingExcluded.filter(c => c !== colorKey);
          localStorage.setItem('bmcf-excluded-colors-pending', JSON.stringify(newPendingExcluded));
          excludeIcon.textContent = "👁️";
          excludeIcon.style.background = 'rgba(0,0,0,0.3)';
          excludeIcon.style.opacity = '0.7';
          // Also update list icon
          listExcludeIcon.textContent = "👁️";
          listExcludeIcon.style.background = 'rgba(0,0,0,0.3)';
          listExcludeIcon.style.opacity = '0.7';
        } else {
          // Add to pending excluded list
          pendingExcluded.push(colorKey);
          localStorage.setItem('bmcf-excluded-colors-pending', JSON.stringify(pendingExcluded));
          excludeIcon.textContent = "🚫";
          excludeIcon.style.background = 'rgba(244, 67, 54, 0.8)';
          excludeIcon.style.opacity = '1';
          // Also update list icon
          listExcludeIcon.textContent = "🚫";
          listExcludeIcon.style.background = 'rgba(244, 67, 54, 0.8)';
          listExcludeIcon.style.opacity = '1';
        }
        
        // Show status message (no automatic refresh)
        if (typeof overlayMain !== 'undefined' && overlayMain.handleDisplayStatus) {
          overlayMain.handleDisplayStatus(`Color ${pendingExcluded.includes(colorKey) ? 'excluded from' : 'included in'} progress calculation - click Apply Colors to confirm`);
        }
      };

      // Add pixel statistics display  
      const stats = pixelStats[colorKey];
      const pixelStatsDisplay = document.createElement('div');
      pixelStatsDisplay.className = 'bmcf-stats';
      
      if (stats && stats.totalRequired > 0) {
        // Get wrong pixels for this specific color from tile progress data - FILTERED BY ENABLED TEMPLATES
        let wrongPixelsForColor = 0;
        if (templateManager.tileProgress && templateManager.tileProgress.size > 0) {
          // Same filtering logic as above
          const enabledTemplateKeys = new Set();
          if (templateManager.templatesArray) {
            for (const template of templateManager.templatesArray) {
              const templateKey = `${template.sortID} ${template.authorID}`;
              if (templateManager.isTemplateEnabled(templateKey)) {
                enabledTemplateKeys.add(templateKey);
              }
            }
          }
          
          for (const [tileKey, tileStats] of templateManager.tileProgress.entries()) {
            // Filter tiles by enabled templates only
            let shouldIncludeTile = true;
            
            if (enabledTemplateKeys.size > 0) {
              shouldIncludeTile = false;
              const [tileX, tileY] = tileKey.split(',').map(coord => parseInt(coord));
              
              for (const template of templateManager.templatesArray) {
                const templateKey = `${template.sortID} ${template.authorID}`;
                if (!enabledTemplateKeys.has(templateKey)) continue;
                
                if (template.chunked) {
                  for (const chunkKey of Object.keys(template.chunked)) {
                    const [chunkTileX, chunkTileY] = chunkKey.split(',').map(coord => parseInt(coord));
                    if (chunkTileX === tileX && chunkTileY === tileY) {
                      shouldIncludeTile = true;
                      break;
                    }
                  }
                }
                if (shouldIncludeTile) break;
              }
            }
            
            if (!shouldIncludeTile) continue;
            
            if (tileStats.colorBreakdown && tileStats.colorBreakdown[colorKey]) {
              wrongPixelsForColor += tileStats.colorBreakdown[colorKey].wrong || 0;
            }
          }
        }

        // Apply wrong color logic to individual color progress
        let displayPainted, displayRequired, displayPercentage, displayRemaining;
        
        if (templateManager.getIncludeWrongColorsInProgress()) {
          // When wrong colors are included, stats.painted already contains the effective painted count
          // so we don't need to add wrongPixelsForColor again (that would be double counting)
          displayPainted = stats.painted; // stats.painted already includes wrong colors logic from calculateRemainingPixelsByColor
          displayRequired = stats.totalRequired;
          displayPercentage = stats.percentage || 0; // Use pre-calculated percentage
          displayRemaining = stats.needsCrosshair;
        } else {
          // Standard calculation (exclude wrong colors)
          displayPainted = stats.painted;
          displayRequired = stats.totalRequired;
          displayPercentage = stats.percentage || 0;
          displayRemaining = stats.totalRequired - stats.painted;
        }
        
        // Add data attributes for filtering/sorting
        colorItem.setAttribute('data-wrong-count', wrongPixelsForColor.toString());
        colorItem.setAttribute('data-missing-count', displayRemaining.toString());
        colorItem.setAttribute('data-total-count', displayRequired.toString());
        colorItem.setAttribute('data-painted-count', displayPainted.toString());
        
        // Always render full stats inside the Template Color overlay
        let displayText = `${displayPainted.toLocaleString()}/${displayRequired.toLocaleString()} (${displayPercentage}%)`;
        if (templateManager.getIncludeWrongColorsInProgress() && wrongPixelsForColor > 0) {
          displayText += `\n+${wrongPixelsForColor.toLocaleString()} wrong`;
        }
        pixelStatsDisplay.innerHTML = `
          <div style="font-size: 0.6em; color: rgba(255,255,255,0.9); text-shadow: 1px 1px 2px rgba(0,0,0,0.8); line-height: 1.1;">
            <div style="margin-bottom: 1px;">
              ${displayText}
            </div>
            <div style="color: rgba(255,255,255,0.7); font-size: 0.9em;">
              ${displayRemaining.toLocaleString()} Left
            </div>
          </div>
        `;

        // Fixed progress bar pinned to bottom of the card
        const progressTrack = document.createElement('div');
        progressTrack.style.cssText = `
          position: absolute;
          left: 20px;
          right: 20px;
          bottom: 6px;
          height: 4px;
          background: rgba(255,255,255,0.25);
          border-radius: 2px;
          overflow: hidden;
          pointer-events: none;
          z-index: 1;
        `;
        const progressFill = document.createElement('div');
        progressFill.style.cssText = `
          width: ${Math.min(displayPercentage, 100)}%;
          height: 100%;
          background: linear-gradient(90deg, #4CAF50, #8BC34A, #CDDC39);
          transition: width 0.3s ease;
        `;
        progressTrack.appendChild(progressFill);
        colorItem.appendChild(progressTrack);
        
        debugLog(`[Color Filter] Displaying stats for ${colorInfo.name} (${colorKey}): ${displayPainted}/${displayRequired} (${displayPercentage}%) - ${displayRemaining} need crosshair${wrongPixelsForColor > 0 ? ` - includes ${wrongPixelsForColor} wrong` : ''}`);
      } else {
        pixelStatsDisplay.innerHTML = `
          <div style="font-size: 0.65em; color: rgba(255,255,255,0.6); text-shadow: 1px 1px 2px rgba(0,0,0,0.8);">
            Not Used
          </div>
        `;
        
        debugLog(`[Color Filter] Color ${colorInfo.name} (${colorKey}) not used in template`);
      }
      
      pixelStatsDisplay.style.cssText = `
        z-index: 1;
        position: relative;
        padding: 4px 6px;
        text-align: center;
        flex-grow: 1;
        display: flex;
        flex-direction: column;
        justify-content: center;
        min-height: 0;
      `;

      colorItem.appendChild(colorName);
      colorItem.appendChild(pixelStatsDisplay);
      if (!isFreeColor){
        colorItem.appendChild(dropletIcon);
      }
      colorItem.appendChild(excludeIcon);

      // Color enable/disable click handler (only on click area, not checkbox)
      colorClickArea.onclick = (e) => {
        e.stopPropagation(); // Prevent bubbling
        if (isSyncing) return; // Prevent sync loops
        
        const wasDisabled = currentTemplate.isColorDisabled(rgb);
        if (wasDisabled) {
          currentTemplate.enableColor(rgb);
          colorItem.style.border = '3px solid #4caf50';
          const overlay = colorClickArea.querySelector('div[style*="position: absolute"]');
          if (overlay) overlay.remove();
          enhancedCheckbox.disabled = false;
          
          // Sync to list item
          isSyncing = true;
          listItem.style.border = '2px solid #4caf50';
          listItem.style.opacity = '1';
          listEnhancedCheckbox.disabled = false;
          isSyncing = false;
        } else {
          currentTemplate.disableColor(rgb);
          colorItem.style.border = '3px solid #f44336';
          const overlay = document.createElement('div');
          overlay.style.cssText = `
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: rgba(244, 67, 54, 0.3);
            border-radius: 5px;
            display: flex;
            align-items: center;
            justify-content: center;
            color: white;
            font-weight: bold;
            font-size: 16px;
          `;
          overlay.textContent = '✕';
          colorClickArea.appendChild(overlay);
          enhancedCheckbox.disabled = true;
          enhancedCheckbox.checked = false;
          
          // Sync to list item
          isSyncing = true;
          listItem.style.border = '2px solid #f44336';
          listItem.style.opacity = '0.7';
          listEnhancedCheckbox.disabled = true;
          listEnhancedCheckbox.checked = false;
          listEnhancedLabel.style.color = 'rgba(255,255,255,0.6)';
          isSyncing = false;
        }
        
        invalidateTemplateCache();
        
        // Refresh template display in real-time
        refreshTemplateDisplay().catch(error => {
          console.error('Error refreshing template:', error);
        });
      };

      // Enhanced checkbox handler
      enhancedCheckbox.onchange = (e) => {
        e.stopPropagation(); // Prevent bubbling
        if (enhancedCheckbox.checked) {
          currentTemplate.enableColorEnhanced(rgb);
        } else {
          currentTemplate.disableColorEnhanced(rgb);
        }
        
        invalidateTemplateCache();
        
        // Refresh template display in real-time
        refreshTemplateDisplay().catch(error => {
          console.error('Error refreshing enhanced mode:', error);
        });
      };

      // Label click handler
      enhancedLabel.onclick = (e) => {
        e.stopPropagation();
        if (!enhancedCheckbox.disabled) {
          enhancedCheckbox.checked = !enhancedCheckbox.checked;
          enhancedCheckbox.onchange(e);
        }
      };

      colorGrid.appendChild(colorItem);

      // Create corresponding list item based on the log.txt example
      const listItem = document.createElement('div');
      listItem.className = 'bmcf-list-item';
      
      // Add data attributes for search functionality
      listItem.setAttribute('data-color-item', 'true');
      listItem.setAttribute('data-color-name', colorInfo.name);
      listItem.setAttribute('data-color-rgb', rgb.join(','));
      
      // Copy stats data attributes from grid item to list item
      if (colorItem.hasAttribute('data-wrong-count')) {
        listItem.setAttribute('data-wrong-count', colorItem.getAttribute('data-wrong-count'));
        listItem.setAttribute('data-missing-count', colorItem.getAttribute('data-missing-count'));
        listItem.setAttribute('data-total-count', colorItem.getAttribute('data-total-count'));
        listItem.setAttribute('data-painted-count', colorItem.getAttribute('data-painted-count'));
      }
      
      listItem.style.cssText = `
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 8px 12px;
        background: var(--slate-800);
        border: 2px solid ${isDisabled ? '#f44336' : '#4caf50'};
        border-radius: 10px;
        position: relative;
        cursor: pointer;
        transition: all 0.2s ease;
        box-shadow: 0 2px 4px rgba(0,0,0,0.2);
        min-height: 50px;
        opacity: ${isDisabled ? '0.7' : '1'};
      `;
      
      // Color swatch (small square)
      const colorSwatch = document.createElement('div');
      colorSwatch.style.cssText = `
        width: 32px;
        height: 32px;
        background: rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]});
        border-radius: 6px;
        border: 2px solid rgba(255,255,255,0.3);
        flex-shrink: 0;
        box-shadow: 0 2px 4px rgba(0,0,0,0.3);
      `;

      // Color info container (main content area)
      const infoContainer = document.createElement('div');
      infoContainer.style.cssText = `
        flex: 1;
        display: flex;
        flex-direction: column;
        gap: 4px;
        min-width: 0;
      `;
      
      // Color click area for enable/disable (covers whole item)
      const listColorClickArea = document.createElement('div');
      listColorClickArea.style.cssText = `
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        cursor: pointer;
        z-index: 1;
      `;

      // Top row: Color name and main stats in the same line
      const topRow = document.createElement('div');
      topRow.style.cssText = `
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 0.9em;
        line-height: 1.2;
      `;

      // Color name
      const listColorName = document.createElement('div');
      listColorName.textContent = colorInfo.name;
      listColorName.style.cssText = `
        font-weight: 600;
        color: var(--slate-100);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        max-width: 120px;
        flex-shrink: 0;
      `;

      // Stats - get correct values from data attributes
      let mainStatsText = '';
      let leftValue = 0;
      
      // Get values from data attributes (same as grid item)
      const totalCount = parseInt(listItem.getAttribute('data-total-count') || '0');
      const paintedCount = parseInt(listItem.getAttribute('data-painted-count') || '0');
      const missingCount = parseInt(listItem.getAttribute('data-missing-count') || '0');
      const wrongCount = parseInt(listItem.getAttribute('data-wrong-count') || '0');
      
      if (totalCount > 0) {
        const percentage = totalCount > 0 ? Math.round(((totalCount - missingCount) / totalCount) * 100) : 0;
        mainStatsText = `${paintedCount.toLocaleString()}/${totalCount.toLocaleString()} (${percentage}%)`;
        // Add wrong pixels display if they exist and wrong colors are included in progress
        if (templateManager.getIncludeWrongColorsInProgress() && wrongCount > 0) {
          mainStatsText += ` +${wrongCount.toLocaleString()} wrong`;
        }
        leftValue = missingCount; // This is the correct "Left" value
      } else {
        mainStatsText = 'Not Used';
        leftValue = 0;
      }

      // Main stats span
      const mainStats = document.createElement('span');
      mainStats.textContent = mainStatsText;
      mainStats.style.cssText = `
        color: var(--slate-300);
        font-size: 0.8em;
        white-space: nowrap;
      `;

      // Bottom row: Left status with color coding
      const bottomRow = document.createElement('div');
      bottomRow.style.cssText = `
        display: flex;
        align-items: center;
        gap: 4px;
        font-size: 0.75em;
        margin-top: 2px;
      `;

      if (mainStatsText !== 'Not Used') {
        const leftStats = document.createElement('span');
        leftStats.textContent = `${leftValue.toLocaleString()} Left`;
        leftStats.style.cssText = `
          color: ${leftValue === 0 ? '#10b981' : '#f59e0b'}; // green if 0, orange if > 0
          font-weight: 500;
        `;
        bottomRow.appendChild(leftStats);
      }

      topRow.appendChild(listColorName);
      if (mainStatsText) {
        topRow.appendChild(mainStats);
      }
      
      infoContainer.appendChild(topRow);
      if (mainStatsText !== 'Not Used') {
        infoContainer.appendChild(bottomRow);
      }
      
      // Controls container (right side)
      const listControlsContainer = document.createElement('div');
      listControlsContainer.style.cssText = `
        display: flex;
        align-items: center;
        gap: 8px;
        z-index: 2;
        position: relative;
      `;
      
      // Enhanced mode checkbox
      const listEnhancedCheckbox = document.createElement('input');
      listEnhancedCheckbox.type = 'checkbox';
      listEnhancedCheckbox.checked = isEnhanced;
      listEnhancedCheckbox.disabled = isDisabled;
      listEnhancedCheckbox.style.cssText = `
        width: 16px;
        height: 16px;
        cursor: pointer;
        accent-color: #ffd700;
      `;

      const listEnhancedLabel = document.createElement('label');
      listEnhancedLabel.textContent = 'Enhanced';
      listEnhancedLabel.title = 'Enhanced mode - highlights this color on the canvas';
      listEnhancedLabel.style.cssText = `
        font-size: 12px;
        cursor: pointer;
        color: ${isEnhanced ? '#ffd700' : 'rgba(255,255,255,0.6)'};
        user-select: none;
        transition: color 0.2s ease;
        font-weight: 500;
      `;

      listEnhancedLabel.onclick = (e) => {
        e.stopPropagation();
        if (!listEnhancedCheckbox.disabled) {
          listEnhancedCheckbox.checked = !listEnhancedCheckbox.checked;
          listEnhancedCheckbox.onchange(e);
        }
      };

      listEnhancedCheckbox.onchange = (e) => {
        e.stopPropagation();
        const isNowEnhanced = listEnhancedCheckbox.checked;
        
        if (isNowEnhanced) {
          currentTemplate.enableColorEnhanced(rgb);
          listEnhancedLabel.style.color = '#ffd700';
          // Also update grid checkbox
          enhancedCheckbox.checked = true;
        } else {
          currentTemplate.disableColorEnhanced(rgb);
          listEnhancedLabel.style.color = 'rgba(255,255,255,0.6)';
          // Also update grid checkbox
          enhancedCheckbox.checked = false;
        }
        
        invalidateTemplateCache();
        
        refreshTemplateDisplay().catch(error => {
          console.error('Error refreshing enhanced mode:', error);
        });
      };
      
      // Eyedropper icon for non-free colors
      if (!isFreeColor) {
        const listDropletIcon = document.createElement('div');
        listDropletIcon.innerHTML = '💧';
        listDropletIcon.title = 'Click to select this color in the palette';
        listDropletIcon.style.cssText = `
          font-size: 16px;
          cursor: pointer;
          opacity: 0.7;
          user-select: none;
          transition: opacity 0.2s ease;
        `;
        
        listDropletIcon.onmouseenter = () => listDropletIcon.style.opacity = '1';
        listDropletIcon.onmouseleave = () => listDropletIcon.style.opacity = '0.7';
        
        listDropletIcon.onclick = (e) => {
          e.stopPropagation();
          const colorButtons = document.querySelectorAll(`button[id^="color-"]`);
          colorButtons.forEach(btn => {
            const btnStyle = window.getComputedStyle(btn);
            const btnBg = btnStyle.backgroundColor;
            const targetColor = `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
            if (btnBg === targetColor) {
              btn.click();
              if (typeof overlayMain !== 'undefined' && overlayMain.handleDisplayStatus) {
                overlayMain.handleDisplayStatus(`Selected color: ${colorInfo.name}`);
              }
            }
          });
        };
        
        listControlsContainer.appendChild(listDropletIcon);
      }
      
      // Exclude from progress icon for list view
      const listExcludeIcon = document.createElement('div');
      listExcludeIcon.textContent = "👁️";
      listExcludeIcon.title = "Click to exclude/include this color from progress calculation";
      listExcludeIcon.style.cssText = `
        font-size: 14px;
        cursor: pointer;
        opacity: 0.7;
        transition: all 0.2s ease;
        background: rgba(0,0,0,0.3);
        border-radius: 50%;
        width: 18px;
        height: 18px;
        display: flex;
        align-items: center;
        justify-content: center;
      `;

      // Check if color is excluded (check pending changes)
      const listAppliedExcluded = JSON.parse(localStorage.getItem('bmcf-excluded-colors') || '[]');
      const listPendingExcluded = JSON.parse(localStorage.getItem('bmcf-excluded-colors-pending') || JSON.stringify(listAppliedExcluded));
      const listIsExcluded = listPendingExcluded.includes(colorKey);
      
      if (listIsExcluded) {
        listExcludeIcon.textContent = "🚫";
        listExcludeIcon.style.opacity = '1';
        listExcludeIcon.style.background = 'rgba(244, 67, 54, 0.8)';
      }

      listExcludeIcon.onmouseenter = () => {
        listExcludeIcon.style.opacity = '1';
        listExcludeIcon.style.transform = 'scale(1.1)';
      };
      
      listExcludeIcon.onmouseleave = () => {
        listExcludeIcon.style.opacity = listIsExcluded ? '1' : '0.7';
        listExcludeIcon.style.transform = 'scale(1)';
      };

      listExcludeIcon.onclick = (e) => {
        e.stopPropagation();
        const pendingExcluded = JSON.parse(localStorage.getItem('bmcf-excluded-colors-pending') || JSON.stringify(JSON.parse(localStorage.getItem('bmcf-excluded-colors') || '[]')));
        
        if (pendingExcluded.includes(colorKey)) {
          // Remove from pending excluded list
          const newPendingExcluded = pendingExcluded.filter(c => c !== colorKey);
          localStorage.setItem('bmcf-excluded-colors-pending', JSON.stringify(newPendingExcluded));
          listExcludeIcon.textContent = "👁️";
          listExcludeIcon.style.background = 'rgba(0,0,0,0.3)';
          listExcludeIcon.style.opacity = '0.7';
          // Also update grid icon
          excludeIcon.textContent = "👁️";
          excludeIcon.style.background = 'rgba(0,0,0,0.3)';
          excludeIcon.style.opacity = '0.7';
        } else {
          // Add to pending excluded list
          pendingExcluded.push(colorKey);
          localStorage.setItem('bmcf-excluded-colors-pending', JSON.stringify(pendingExcluded));
          listExcludeIcon.textContent = "🚫";
          listExcludeIcon.style.background = 'rgba(244, 67, 54, 0.8)';
          listExcludeIcon.style.opacity = '1';
          // Also update grid icon
          excludeIcon.textContent = "🚫";
          excludeIcon.style.background = 'rgba(244, 67, 54, 0.8)';
          excludeIcon.style.opacity = '1';
        }
        
        // Show status message (no automatic refresh)
        if (typeof overlayMain !== 'undefined' && overlayMain.handleDisplayStatus) {
          overlayMain.handleDisplayStatus(`Color ${pendingExcluded.includes(colorKey) ? 'excluded from' : 'included in'} progress calculation - click Apply Colors to confirm`);
        }
      };
      
      listControlsContainer.appendChild(listExcludeIcon);
      listControlsContainer.appendChild(listEnhancedCheckbox);
      listControlsContainer.appendChild(listEnhancedLabel);
      
      // Assemble the list item
      listItem.appendChild(colorSwatch);
      listItem.appendChild(infoContainer);
      listItem.appendChild(listControlsContainer);
      listItem.appendChild(listColorClickArea);

      // List item click handler (enable/disable color)
      listColorClickArea.onclick = (e) => {
        e.stopPropagation();
        if (isSyncing) return; // Prevent sync loops
        
        const wasDisabled = currentTemplate.isColorDisabled(rgb);
        if (wasDisabled) {
          currentTemplate.enableColor(rgb);
          listItem.style.border = '2px solid #4caf50';
          listItem.style.opacity = '1';
          listEnhancedCheckbox.disabled = false;
          
          // Sync to grid item
          isSyncing = true;
          colorItem.style.border = '3px solid #4caf50';
          const gridOverlay = colorClickArea.querySelector('div[style*="position: absolute"]');
          if (gridOverlay) gridOverlay.remove();
          enhancedCheckbox.disabled = false;
          isSyncing = false;
        } else {
          currentTemplate.disableColor(rgb);
          listItem.style.border = '2px solid #f44336';
          listItem.style.opacity = '0.7';
          listEnhancedCheckbox.disabled = true;
          listEnhancedCheckbox.checked = false;
          listEnhancedLabel.style.color = 'rgba(255,255,255,0.6)';
          
          // Sync to grid item
          isSyncing = true;
          colorItem.style.border = '3px solid #f44336';
          const gridOverlay = document.createElement('div');
          gridOverlay.style.cssText = `
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: rgba(244, 67, 54, 0.3);
            border-radius: 5px;
            display: flex;
            align-items: center;
            justify-content: center;
            color: white;
            font-weight: bold;
            font-size: 16px;
          `;
          gridOverlay.textContent = '✕';
          colorClickArea.appendChild(gridOverlay);
          enhancedCheckbox.disabled = true;
          enhancedCheckbox.checked = false;
          isSyncing = false;
        }
        
        invalidateTemplateCache();
        
        refreshTemplateDisplay().catch(error => {
          console.error('Error refreshing template:', error);
        });
      };

      colorList.appendChild(listItem);
    });

    // Initialize original orders immediately after creating all items
    originalGridOrder = Array.from(colorGrid.querySelectorAll('[data-color-item]'));
    originalListOrder = Array.from(colorList.querySelectorAll('[data-color-item]'));

    // Filter functionality - defined after color items are created
    const applyFilter = (filterType) => {
      const gridItems = Array.from(colorGrid.querySelectorAll('[data-color-item]'));
      const listItems = Array.from(colorList.querySelectorAll('[data-color-item]'));
      const colorItems = isListView ? listItems : gridItems;
      
      // Original orders are already initialized after creating all items
      
      if (filterType === 'default') {
        // Restore original order and show all items
        colorItems.forEach(item => {
          item.style.display = 'flex';
        });
        // Restore original DOM order
        const container = isListView ? colorList : colorGrid;
        const originalItems = isListView ? originalListOrder : originalGridOrder;
        
        originalItems.forEach(item => {
          container.appendChild(item);
        });
        return;
      }
      
      if (filterType === 'enhanced') {
        // Filter to show only enhanced colors
        colorItems.forEach(item => {
          const enhancedCheckbox = item.querySelector('input[type="checkbox"]');
          if (enhancedCheckbox && enhancedCheckbox.checked) {
            item.style.display = 'flex';
          } else {
            item.style.display = 'none';
          }
        });
        return;
      }
      
      // Show all items for sorting
      colorItems.forEach(item => {
        item.style.display = 'flex';
      });
      
      colorItems.sort((a, b) => {
        const aWrong = parseInt(a.getAttribute('data-wrong-count') || '0');
        const bWrong = parseInt(b.getAttribute('data-wrong-count') || '0');
        const aMissing = parseInt(a.getAttribute('data-missing-count') || '0');
        const bMissing = parseInt(b.getAttribute('data-missing-count') || '0');
        const aTotal = parseInt(a.getAttribute('data-total-count') || '0');
        const bTotal = parseInt(b.getAttribute('data-total-count') || '0');
        const aName = a.getAttribute('data-color-name') || '';
        const bName = b.getAttribute('data-color-name') || '';
        const aPercentage = aTotal > 0 ? ((aTotal - aMissing) / aTotal) * 100 : 0;
        const bPercentage = bTotal > 0 ? ((bTotal - bMissing) / bTotal) * 100 : 0;

        switch (filterType) {
          case 'premium': 
            // Get color RGB from data attributes
            const aRgb = a.getAttribute('data-color-rgb');
            const bRgb = b.getAttribute('data-color-rgb');
            
            // Find colors in utils.colorpalette
            const aColor = colorPalette.find(c => `${c.rgb[0]},${c.rgb[1]},${c.rgb[2]}` === aRgb);
            const bColor = colorPalette.find(c => `${c.rgb[0]},${c.rgb[1]},${c.rgb[2]}` === bRgb);
            
            const aIsPremium = aColor && aColor.free === false;
            const bIsPremium = bColor && bColor.free === false;
            
            // Premium colors first
            if (aIsPremium && !bIsPremium) return -1;
            if (!aIsPremium && bIsPremium) return 1;
            
            // If both are premium or both are free, sort by most pixels missing
            return bMissing - aMissing;
          case 'wrong-desc': return bWrong - aWrong;
          case 'wrong-asc': return aWrong - bWrong;
          case 'missing-desc': return bMissing - aMissing;
          case 'missing-asc': return aMissing - bMissing;
          case 'total-desc': return bTotal - aTotal;
          case 'total-asc': return aTotal - bTotal;
          case 'percentage-desc': return bPercentage - aPercentage;
          case 'percentage-asc': return aPercentage - bPercentage;
          case 'name-asc': return aName.localeCompare(bName);
          case 'name-desc': return bName.localeCompare(aName);
          default: return 0;
        }
      });

      // Reorder DOM elements after sorting
      const container = isListView ? colorList : colorGrid;
      colorItems.forEach(item => {
        container.appendChild(item);
      });
    };
      /* Date: 2025-09-30 — Persist main Template Color Filter sort via settingsManager */
      (function restoreMainSortOnce() {
          try {
              const saved = getTemplateColorSort();       // 'default' if nothing saved
              if (filterSelect && [...filterSelect.options].some(o => o.value === saved)) {
                  filterSelect.value = saved;
              }
              applyFilter(filterSelect ? filterSelect.value : 'default');
          } catch {
              applyFilter('default');
          }
      })();

      filterSelect.addEventListener('change', () => {
          try { saveTemplateColorSort(filterSelect.value); } catch { }
          applyFilter(filterSelect.value);
      });


    
    enableAllButton.onclick = async () => {
      colorPalette.forEach((colorInfo) => {
        currentTemplate.enableColor(colorInfo.rgb);
      });
      
      invalidateTemplateCache();
      
      colorFilterOverlay.remove();
      overlayMain.handleDisplayStatus('Enabling all colors...');
      
      try {
        await refreshTemplateDisplay();
        buildColorFilterOverlay(); 
      } catch (error) {
        console.error('Error enabling all colors:', error);
        overlayMain.handleDisplayError('Failed to enable all colors');
      }
    };

    disableAllButton.onclick = async () => {
      colorPalette.forEach((colorInfo) => {
        currentTemplate.disableColor(colorInfo.rgb);
      });
      
      invalidateTemplateCache();
      
      colorFilterOverlay.remove();
      overlayMain.handleDisplayStatus('Disabling all colors...');
      
      try {
        await refreshTemplateDisplay();
        buildColorFilterOverlay(); 
      } catch (error) {
        console.error('Error disabling all colors:', error);
        overlayMain.handleDisplayError('Failed to disable all colors');
      }
    };

    // Disable all Enhanced: clears enhancedColors set and rebuilds
    disableAllEnhancedButton.onclick = async () => {
      // Visual feedback - button click animation
      const originalBg = disableAllEnhancedButton.style.background;
      const originalText = disableAllEnhancedButton.textContent;
      
      // Immediate click feedback
      disableAllEnhancedButton.style.background = '#dc3545'; // Red
      disableAllEnhancedButton.textContent = 'Disabling...';
      disableAllEnhancedButton.style.transform = 'scale(0.95)';
      disableAllEnhancedButton.style.transition = 'all 0.1s ease';
      
      try {
        const tmpl = templateManager.templatesArray?.[0];
        if (tmpl && tmpl.enhancedColors && tmpl.enhancedColors.size > 0) {
          tmpl.enhancedColors.clear();
          
          invalidateTemplateCache();
          
          // Success feedback
          disableAllEnhancedButton.style.background = '#28a745'; // Green
          disableAllEnhancedButton.textContent = 'Disabled! ✓';
          
          // Trigger template refresh
          await refreshTemplateDisplay();
          buildColorFilterOverlay();
          
          // Reset button after 100ms
          setTimeout(() => {
            disableAllEnhancedButton.style.background = originalBg;
            disableAllEnhancedButton.textContent = originalText;
            disableAllEnhancedButton.style.transform = 'scale(1)';
          }, 100);
        } else {
          // No enhanced colors to disable
          disableAllEnhancedButton.style.background = '#ffc107'; // Yellow
          disableAllEnhancedButton.textContent = 'No Enhanced Colors';
          
          setTimeout(() => {
            disableAllEnhancedButton.style.background = originalBg;
            disableAllEnhancedButton.textContent = originalText;
            disableAllEnhancedButton.style.transform = 'scale(1)';
          }, 100);
        }
      } catch (error) {
        // Error feedback
        disableAllEnhancedButton.style.background = '#dc3545'; // Red
        disableAllEnhancedButton.textContent = 'Error! ✗';
        
        setTimeout(() => {
          disableAllEnhancedButton.style.background = originalBg;
          disableAllEnhancedButton.textContent = originalText;
          disableAllEnhancedButton.style.transform = 'scale(1)';
        }, 100);
        
        console.error('Error disabling all enhanced colors:', error);
        overlayMain.handleDisplayError('Failed to disable all enhanced colors');
      }
    };

    // Create fixed footer with action buttons
    const footerContainer = document.createElement('div');
    footerContainer.className = 'bmcf-footer';

    // Refresh Statistics button
    const refreshStatsButton = document.createElement('button');
    refreshStatsButton.innerHTML = '🔄 Update Stats';
    refreshStatsButton.className = 'bmcf-btn success';

    refreshStatsButton.onmouseover = () => {
      refreshStatsButton.style.transform = 'translateY(-2px)';
      refreshStatsButton.style.boxShadow = '0 4px 15px rgba(76, 175, 80, 0.5)';
    };

    refreshStatsButton.onmouseout = () => {
      refreshStatsButton.style.transform = 'translateY(0)';
      refreshStatsButton.style.boxShadow = '0 2px 8px rgba(76, 175, 80, 0.3)';
    };

    // Apply button  
    const applyButton = document.createElement('button');
    applyButton.innerHTML = '🎯 Apply Colors';
    applyButton.className = 'bmcf-btn primary';

    applyButton.onmouseover = () => {
      applyButton.style.transform = 'translateY(-2px)';
      applyButton.style.boxShadow = '0 4px 15px rgba(33, 150, 243, 0.5)';
    };

    applyButton.onmouseout = () => {
      applyButton.style.transform = 'translateY(0)';
      applyButton.style.boxShadow = '0 2px 8px rgba(33, 150, 243, 0.3)';
    };
    
    refreshStatsButton.onclick = () => {
      debugLog('[Color Filter] Refreshing statistics...');
      // Apply pending excluded colors changes
      const pendingExcluded = localStorage.getItem('bmcf-excluded-colors-pending');
      if (pendingExcluded) {
        localStorage.setItem('bmcf-excluded-colors', pendingExcluded);
        localStorage.removeItem('bmcf-excluded-colors-pending');
      }
      // Update mini tracker to reflect excluded colors
      updateMiniTracker();
      buildColorFilterOverlay(); // Rebuild overlay with fresh data
    };
    applyButton.onclick = async () => {
      // Apply pending excluded colors changes before closing
      const pendingExcluded = localStorage.getItem('bmcf-excluded-colors-pending');
      if (pendingExcluded) {
        localStorage.setItem('bmcf-excluded-colors', pendingExcluded);
        localStorage.removeItem('bmcf-excluded-colors-pending');
      }
      
      colorFilterOverlay.remove();
      overlayMain.handleDisplayStatus('Applying color filter...');
      
      try {
        // Update mini tracker to reflect excluded colors
        updateMiniTracker();
        await refreshTemplateDisplay();
        updateColorMenuDisplay(false); // Don't reset filters after color filter applied
        overlayMain.handleDisplayStatus('Color filter applied successfully!');
      } catch (error) {
        console.error('Error applying color filter:', error);
        overlayMain.handleDisplayError('Failed to apply color filter');
      }
    };

    // Create scrollable content container for fixed header solution
    const contentContainer = document.createElement('div');
    contentContainer.style.cssText = `
      overflow-y: auto;
      flex: 1;
      min-height: 0;
      padding: 20px;
    `;

    // Add buttons to footer
    footerContainer.appendChild(refreshStatsButton);
    footerContainer.appendChild(applyButton);

    // Assemble overlay with fixed header and footer
    colorFilterOverlay.appendChild(header);
    contentContainer.appendChild(progressSummary);
    contentContainer.appendChild(includeWrongProgressContainer);
    contentContainer.appendChild(instructions);
    contentContainer.appendChild(enhancedSection);
    contentContainer.appendChild(searchContainer);
    contentContainer.appendChild(filterContainer);
    contentContainer.appendChild(colorViewContainer);

    // Check if compact list already exists, if so skip its creation
    let compactList = document.getElementById('bmcf-compact-list');
    let shouldCreateCompactList = !compactList;

    if (shouldCreateCompactList) {
      // Create compact color list as separate floating window
      compactList = document.createElement('div');
      compactList.id = 'bmcf-compact-list';
      compactList.style.cssText = `
      display: none;
      position: fixed;
      top: 100px;
      right: 20px;
      width: 240px;
      background: var(--slate-800);
      border: 1px solid var(--bmcf-border);
      border-radius: 12px;
      box-shadow: 0 10px 30px rgba(0,0,0,0.6);
      z-index: 999999;
      font-family: Inter, system-ui, sans-serif;
      flex-direction: column;
      min-height: auto;
      max-height: none;
    `;
    
    // Set flex layout when visible
    compactList.setAttribute('data-flex-layout', 'true');

    // Add header to compact list
    const compactHeader = document.createElement('div');
    compactHeader.style.cssText = `
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 12px;
      background: var(--slate-700);
      border-bottom: 1px solid var(--bmcf-border);
      border-radius: 12px 12px 0 0;
      transition: border-radius 0.3s ease, border-bottom 0.3s ease;
    `;
    
    // Create left section with title and collapse arrow
    const compactLeftSection = document.createElement('div');
    compactLeftSection.style.cssText = `
      display: flex;
      align-items: center;
      gap: 6px;
    `;
    
    const compactCollapseArrow = document.createElement('span');
    compactCollapseArrow.innerHTML = '▼';
    compactCollapseArrow.style.cssText = `
      font-size: 10px;
      color: var(--bmcf-text-muted);
      transition: transform 0.2s ease;
      user-select: none;
      cursor: pointer;
      padding: 2px 4px;
      border-radius: 3px;
    `;
    
    // Hover effect for arrow only
    compactCollapseArrow.addEventListener('mouseenter', () => {
      compactCollapseArrow.style.background = 'var(--slate-600)';
    });
    compactCollapseArrow.addEventListener('mouseleave', () => {
      compactCollapseArrow.style.background = 'none';
    });
    
    // Touch support for mobile
    compactCollapseArrow.addEventListener('touchstart', (e) => {
      e.preventDefault();
      compactCollapseArrow.style.background = 'var(--slate-600)';
    });
    compactCollapseArrow.addEventListener('touchend', () => {
      compactCollapseArrow.style.background = 'none';
    });
    
    const compactTitle = document.createElement('span');
    compactTitle.textContent = 'Color Toggle';
    compactTitle.style.cssText = `
      font-size: 12px;
      font-weight: 600;
      color: var(--bmcf-text);
      user-select: none;
      cursor: default;
    `;
    
    compactLeftSection.appendChild(compactCollapseArrow);
    compactLeftSection.appendChild(compactTitle);

    
    const compactCloseBtn = document.createElement('button');
    compactCloseBtn.innerHTML = '✕';
    compactCloseBtn.title = 'Close';
    compactCloseBtn.style.cssText = `
      background: none;
      border: none;
      color: var(--bmcf-text-muted);
      cursor: pointer;
      font-size: 14px;
      padding: 2px 6px;
      border-radius: 4px;
      transition: all 0.15s ease;
    `;
    compactCloseBtn.onmouseover = () => compactCloseBtn.style.background = 'var(--slate-600)';
    compactCloseBtn.onmouseout = () => compactCloseBtn.style.background = 'none';
    compactCloseBtn.onclick = () => {
      compactList.style.display = 'none';
      compactListButton.style.background = 'linear-gradient(135deg, var(--slate-600), var(--slate-700))';
    };
    
    compactHeader.appendChild(compactLeftSection);
    compactHeader.appendChild(compactCloseBtn);
    compactList.appendChild(compactHeader);

    // Create collapsible content container
    const compactCollapsibleContent = document.createElement('div');
    compactCollapsibleContent.style.cssText = `
      display: block;
      transition: height 0.3s ease, opacity 0.2s ease;
      overflow: hidden;
      border-radius: 0 0 12px 12px;
      position: relative;
      z-index: 1;
    `;
    compactList.appendChild(compactCollapsibleContent);

    // Load collapse state from localStorage
    const COMPACT_COLLAPSE_KEY = 'bmcf-compact-collapsed';
    let isCollapsed = localStorage.getItem(COMPACT_COLLAPSE_KEY) === 'true';

    // Apply initial collapse state
    if (isCollapsed) {
      compactCollapsibleContent.style.height = '0px';
      compactCollapsibleContent.style.opacity = '0';
      compactCollapsibleContent.style.pointerEvents = 'none';
      compactCollapseArrow.style.transform = 'rotate(-90deg)';
      // Fix border radius when collapsed
      compactHeader.style.borderRadius = '12px';
      compactHeader.style.borderBottom = 'none';
    } else {
      compactCollapsibleContent.style.height = 'auto';
      compactCollapsibleContent.style.opacity = '1';
      compactCollapsibleContent.style.pointerEvents = 'auto';
      // Restore original border radius when expanded
      compactHeader.style.borderRadius = '12px 12px 0 0';
      compactHeader.style.borderBottom = '1px solid var(--bmcf-border)';
    }

    // Add collapse functionality - only on arrow click (works for both click and touch)
    const handleCollapseToggle = (e) => {
      e.stopPropagation(); // Prevent dragging when clicking to collapse
      
      isCollapsed = !isCollapsed;
      localStorage.setItem(COMPACT_COLLAPSE_KEY, isCollapsed.toString());
      
      if (isCollapsed) {
        // Get the natural height first
        compactCollapsibleContent.style.height = 'auto';
        const naturalHeight = compactCollapsibleContent.offsetHeight;
        compactCollapsibleContent.style.height = naturalHeight + 'px';
        
        // Force a reflow to establish the starting height
        compactCollapsibleContent.offsetHeight;
        
        // Then animate to collapsed state
        requestAnimationFrame(() => {
          compactCollapsibleContent.style.height = '0px';
          compactCollapsibleContent.style.opacity = '0';
          compactCollapsibleContent.style.pointerEvents = 'none';
          compactCollapseArrow.style.transform = 'rotate(-90deg)';
          // Fix border radius when collapsing
          compactHeader.style.borderRadius = '12px';
          compactHeader.style.borderBottom = 'none';
        });
      } else {
        // First remove pointer-events and set opacity to start expanding
        compactCollapsibleContent.style.pointerEvents = 'auto';
        compactCollapsibleContent.style.opacity = '1';
        
        // Get the natural height by temporarily setting height to auto
        const tempHeight = compactCollapsibleContent.style.height;
        compactCollapsibleContent.style.height = 'auto';
        const naturalHeight = compactCollapsibleContent.offsetHeight;
        compactCollapsibleContent.style.height = tempHeight;
        
        // Force reflow and animate to natural height
        compactCollapsibleContent.offsetHeight;
        compactCollapsibleContent.style.height = naturalHeight + 'px';
        compactCollapseArrow.style.transform = 'rotate(0deg)';
        // Restore border radius when expanding
        compactHeader.style.borderRadius = '12px 12px 0 0';
        compactHeader.style.borderBottom = '1px solid var(--bmcf-border)';
        
        // After transition, set to auto for dynamic resizing
        setTimeout(() => {
          if (!isCollapsed) {
            compactCollapsibleContent.style.height = 'auto';
          }
        }, 300);
      }
    };
    
    // Add both click and touch event listeners for mobile compatibility
    compactCollapseArrow.addEventListener('click', handleCollapseToggle);
    compactCollapseArrow.addEventListener('touchstart', handleCollapseToggle);

    // Add search bar section
    const compactSearchContainer = document.createElement('div');
    compactSearchContainer.style.cssText = `
      padding: 6px 12px;
      background: var(--slate-700);
      border-bottom: 1px solid var(--bmcf-border);
      display: flex;
      align-items: center;
      gap: 6px;
    `;
    
    const searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.placeholder = 'Search colors...';
    searchInput.style.cssText = `
      flex: 1;
      padding: 4px 8px;
      background: var(--slate-600);
      border: 1px solid var(--slate-500);
      border-radius: 4px;
      color: var(--bmcf-text);
      font-size: 11px;
      height: 24px;
      outline: none;
      transition: all 0.2s ease;
    `;
    
    // Search input focus/blur effects
    searchInput.addEventListener('focus', () => {
      searchInput.style.borderColor = 'var(--blue-400)';
      searchInput.style.background = 'var(--slate-550)';
    });
    
    searchInput.addEventListener('blur', () => {
      searchInput.style.borderColor = 'var(--slate-500)';
      searchInput.style.background = 'var(--slate-600)';
    });
    
    // Clear search button
    const clearSearchBtn = document.createElement('button');
    clearSearchBtn.innerHTML = '✕';
    clearSearchBtn.title = 'Clear search';
    clearSearchBtn.style.cssText = `
      background: none;
      border: none;
      color: var(--bmcf-text-muted);
      cursor: pointer;
      font-size: 10px;
      padding: 2px;
      border-radius: 3px;
      width: 20px;
      height: 20px;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.15s ease;
      opacity: 0.7;
    `;
    
    clearSearchBtn.addEventListener('mouseenter', () => {
      clearSearchBtn.style.background = 'var(--slate-600)';
      clearSearchBtn.style.opacity = '1';
    });
    
    clearSearchBtn.addEventListener('mouseleave', () => {
      clearSearchBtn.style.background = 'none';
      clearSearchBtn.style.opacity = '0.7';
    });
    
    clearSearchBtn.addEventListener('click', () => {
      searchInput.value = '';
      searchInput.dispatchEvent(new Event('input'));
      searchInput.focus();
    });
    
    compactSearchContainer.appendChild(searchInput);
    compactSearchContainer.appendChild(clearSearchBtn);
    compactCollapsibleContent.appendChild(compactSearchContainer);

    // Add bulk action buttons above sort
    const compactBulkContainer = document.createElement('div');
    compactBulkContainer.style.cssText = `
      padding: 3px 8px;
      background: var(--slate-700);
      border-bottom: 1px solid var(--bmcf-border);
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 4px;
    `;
    
    const disableAllBtn = document.createElement('button');
    disableAllBtn.textContent = 'Disable';
    disableAllBtn.style.cssText = `
      background: #dc2626;
      color: white;
      border: none;
      padding: 2px 6px;
      border-radius: 3px;
      font-size: 10px;
      cursor: pointer;
      transition: all 0.2s ease;
      font-weight: 500;
    `;
    disableAllBtn.addEventListener('mouseenter', () => disableAllBtn.style.background = '#b91c1c');
    disableAllBtn.addEventListener('mouseleave', () => disableAllBtn.style.background = '#dc2626');
    
    const enableAllBtn = document.createElement('button');
    enableAllBtn.textContent = 'Enable';
    enableAllBtn.style.cssText = `
      background: #16a34a;
      color: white;
      border: none;
      padding: 2px 6px;
      border-radius: 3px;
      font-size: 10px;
      cursor: pointer;
      transition: all 0.2s ease;
      font-weight: 500;
    `;
    enableAllBtn.addEventListener('mouseenter', () => enableAllBtn.style.background = '#15803d');
    enableAllBtn.addEventListener('mouseleave', () => enableAllBtn.style.background = '#16a34a');
    
    // Add click handlers usando a lógica que já existe
    disableAllBtn.addEventListener('click', () => {
      const currentTemplate = templateManager.templatesArray?.[0];
      if (!currentTemplate) return;
      
      // Usar a mesma lógica que já existe no código para desabilitar cores
      const items = compactContent.querySelectorAll('.bmcf-compact-item');
      items.forEach(item => {
        const colorRgb = item.getAttribute('data-color-rgb');
        if (colorRgb) {
          const [r, g, b] = colorRgb.split(',').map(Number);
          if (!currentTemplate.isColorDisabled([r, g, b])) {
            currentTemplate.disableColor([r, g, b]);
            item.style.opacity = '0.5';
            item.style.background = 'rgba(244, 67, 54, 0.1)';
          }
        }
      });
      invalidateTemplateCache();
    });
    
    enableAllBtn.addEventListener('click', () => {
      const currentTemplate = templateManager.templatesArray?.[0];
      if (!currentTemplate) return;
      
      // Usar a mesma lógica que já existe no código para habilitar cores
      const items = compactContent.querySelectorAll('.bmcf-compact-item');
      items.forEach(item => {
        const colorRgb = item.getAttribute('data-color-rgb');
        if (colorRgb) {
          const [r, g, b] = colorRgb.split(',').map(Number);
          if (currentTemplate.isColorDisabled([r, g, b])) {
            currentTemplate.enableColor([r, g, b]);
            item.style.opacity = '1';
            item.style.background = '';
          }
        }
      });
      invalidateTemplateCache();
    });
    
    compactBulkContainer.appendChild(disableAllBtn);
    compactBulkContainer.appendChild(enableAllBtn);
    compactCollapsibleContent.appendChild(compactBulkContainer);

    // Add sort filter section
    const compactSortContainer = document.createElement('div');
    compactSortContainer.style.cssText = `
      padding: 8px 12px;
      background: var(--slate-700);
      border-bottom: 1px solid var(--bmcf-border);
      display: flex;
      align-items: center;
      gap: 8px;
    `;
    
    const sortLabel = document.createElement('span');
    sortLabel.textContent = 'Sort:';
    sortLabel.style.cssText = `
      font-size: 11px;
      color: var(--bmcf-text-muted);
      min-width: 30px;
    `;
    
    const compactSortSelect = document.createElement('select');
    compactSortSelect.style.cssText = `
      flex: 1;
      padding: 4px 8px;
      border: 1px solid rgba(255, 255, 255, 0.2);
      border-radius: 4px;
      background: rgba(0, 0, 0, 0.3);
      color: white;
      font-size: 10px;
      outline: none;
      cursor: pointer;
    `;
    
    // Sort options
    const sortOptions = [
      { value: 'default', text: 'Default Order' },
      { value: 'name', text: 'By Name' },
      { value: 'premium', text: 'Premium (Most Missing)' },
      { value: 'most-missing', text: 'Most Pixels Missing' },
      { value: 'less-missing', text: 'Less Pixels Missing' },
      { value: 'remaining', text: 'By Remaining' },
      { value: 'progress', text: 'By Progress' },
      { value: 'most-painted', text: 'Most Painted' },
      { value: 'less-painted', text: 'Less Painted' },
      { value: 'enhanced', text: 'Enhanced Only' }
    ];
    
    sortOptions.forEach(option => {
      const optionElement = document.createElement('option');
      optionElement.value = option.value;
      optionElement.textContent = option.text;
      optionElement.style.cssText = `
        background: #2a2a2a;
        color: white;
      `;
      compactSortSelect.appendChild(optionElement);
    });
    
    compactSortContainer.appendChild(sortLabel);
    compactSortContainer.appendChild(compactSortSelect);
    compactCollapsibleContent.appendChild(compactSortContainer);

    // Create scrollable content container
    const compactContent = document.createElement('div');
    compactContent.style.cssText = `
      overflow-y: auto;
      max-height: 300px;
      min-height: 0;
    `;
    compactCollapsibleContent.appendChild(compactContent);

    // Add drag functionality to compact list
    let isDraggingCompact = false;
    let compactDragStartX = 0;
    let compactDragStartY = 0;
    let compactInitialLeft = 0;
    let compactInitialTop = 0;

    compactHeader.style.cursor = 'move';
    compactHeader.addEventListener('mousedown', (e) => {
      // Don't start dragging if clicking on close button or collapse arrow
      if (e.target === compactCloseBtn || e.target === compactCollapseArrow) return;
      
      isDraggingCompact = true;
      compactDragStartX = e.clientX;
      compactDragStartY = e.clientY;
      
      // Get current position
      const rect = compactList.getBoundingClientRect();
      compactInitialLeft = rect.left;
      compactInitialTop = rect.top;
      
      // Change cursor and prevent text selection
      compactHeader.style.cursor = 'grabbing';
      compactList.style.userSelect = 'none';
      document.body.style.userSelect = 'none';
      
      e.preventDefault();
    });

    // Mouse move handler for dragging
    document.addEventListener('mousemove', (e) => {
      if (!isDraggingCompact) return;
      
      const deltaX = e.clientX - compactDragStartX;
      const deltaY = e.clientY - compactDragStartY;
      
      const newLeft = compactInitialLeft + deltaX;
      const newTop = compactInitialTop + deltaY;
      
      // Keep within viewport bounds
      const maxLeft = window.innerWidth - compactList.offsetWidth;
      const maxTop = window.innerHeight - compactList.offsetHeight;
      
      compactList.style.left = Math.max(0, Math.min(maxLeft, newLeft)) + 'px';
      compactList.style.top = Math.max(0, Math.min(maxTop, newTop)) + 'px';
      compactList.style.right = 'auto'; // Remove right positioning
    });

    // Mouse up handler to stop dragging
    document.addEventListener('mouseup', () => {
      if (!isDraggingCompact) return;
      
      isDraggingCompact = false;
      compactHeader.style.cursor = 'move';
      compactList.style.userSelect = '';
      document.body.style.userSelect = '';
    });

    // Touch support for mobile
    compactHeader.addEventListener('touchstart', (e) => {
      if (e.target === compactCloseBtn) return;
      
      const touch = e.touches[0];
      isDraggingCompact = true;
      compactDragStartX = touch.clientX;
      compactDragStartY = touch.clientY;
      
      const rect = compactList.getBoundingClientRect();
      compactInitialLeft = rect.left;
      compactInitialTop = rect.top;
      
      compactList.style.userSelect = 'none';
      e.preventDefault();
    }, { passive: false });

    document.addEventListener('touchmove', (e) => {
      if (!isDraggingCompact) return;
      
      const touch = e.touches[0];
      const deltaX = touch.clientX - compactDragStartX;
      const deltaY = touch.clientY - compactDragStartY;
      
      const newLeft = compactInitialLeft + deltaX;
      const newTop = compactInitialTop + deltaY;
      
      const maxLeft = window.innerWidth - compactList.offsetWidth;
      const maxTop = window.innerHeight - compactList.offsetHeight;
      
      compactList.style.left = Math.max(0, Math.min(maxLeft, newLeft)) + 'px';
      compactList.style.top = Math.max(0, Math.min(maxTop, newTop)) + 'px';
      compactList.style.right = 'auto';
    }, { passive: false });

    document.addEventListener('touchend', () => {
      if (!isDraggingCompact) return;
      
      isDraggingCompact = false;
      compactList.style.userSelect = '';
    });

    // Function to apply sort to compact list
    const applyCompactSort = (sortType) => {
      const sortedItems = [...allCompactItems];
      
      switch (sortType) {
        case 'name':
          // Show all items first
          sortedItems.forEach(item => {
            item.style.display = 'flex';
          });
          sortedItems.sort((a, b) => {
            const nameA = a.querySelector('.bmcf-compact-name div').textContent.toLowerCase();
            const nameB = b.querySelector('.bmcf-compact-name div').textContent.toLowerCase();
            return nameA.localeCompare(nameB);
          });
          break;
          
        case 'premium':
          // Show all items first
          sortedItems.forEach(item => {
            item.style.display = 'flex';
          });
          sortedItems.sort((a, b) => {
            const colorKeyA = a.getAttribute('data-color-rgb');
            const colorKeyB = b.getAttribute('data-color-rgb');
            
            // Find colors in utils.colorpalette
            const colorA = utils.colorpalette.find(c => c.name !== 'Transparent' && `${c.rgb[0]},${c.rgb[1]},${c.rgb[2]}` === colorKeyA);
            const colorB = utils.colorpalette.find(c => c.name !== 'Transparent' && `${c.rgb[0]},${c.rgb[1]},${c.rgb[2]}` === colorKeyB);
            
            const isPremiumA = colorA && colorA.free === false;
            const isPremiumB = colorB && colorB.free === false;
            
            // Premium colors first
            if (isPremiumA && !isPremiumB) return -1;
            if (!isPremiumA && isPremiumB) return 1;
            
            // If both are premium or both are free, sort by most pixels missing
            const remainingA = parseInt(a.getAttribute('data-remaining') || '0');
            const remainingB = parseInt(b.getAttribute('data-remaining') || '0');
            const totalA = parseInt(a.getAttribute('data-total') || '0');
            const totalB = parseInt(b.getAttribute('data-total') || '0');
            
            // Filter out 0/0 colors (no pixels at all)
            if (totalA === 0 && totalB > 0) return 1;
            if (totalB === 0 && totalA > 0) return -1;
            if (totalA === 0 && totalB === 0) return 0;
            
            return remainingB - remainingA; // Descending (more missing first)
          });
          break;
          
        case 'most-missing':
          // Show all items first
          sortedItems.forEach(item => {
            item.style.display = 'flex';
          });
          sortedItems.sort((a, b) => {
            const remainingA = parseInt(a.getAttribute('data-remaining') || '0');
            const remainingB = parseInt(b.getAttribute('data-remaining') || '0');
            const totalA = parseInt(a.getAttribute('data-total') || '0');
            const totalB = parseInt(b.getAttribute('data-total') || '0');
            
            // Filter out 0/0 colors (no pixels at all)
            if (totalA === 0 && totalB > 0) return 1;
            if (totalB === 0 && totalA > 0) return -1;
            if (totalA === 0 && totalB === 0) return 0;
            
            return remainingB - remainingA; // Descending (more missing first)
          });
          break;
          
        case 'less-missing':
          // Show all items first
          sortedItems.forEach(item => {
            item.style.display = 'flex';
          });
          sortedItems.sort((a, b) => {
            const remainingA = parseInt(a.getAttribute('data-remaining') || '0');
            const remainingB = parseInt(b.getAttribute('data-remaining') || '0');
            const totalA = parseInt(a.getAttribute('data-total') || '0');
            const totalB = parseInt(b.getAttribute('data-total') || '0');
            
            // Filter out 0/0 colors (no pixels at all) - put them at the end
            if (totalA === 0 && totalB > 0) return 1;
            if (totalB === 0 && totalA > 0) return -1;
            if (totalA === 0 && totalB === 0) return 0;
            
            return remainingA - remainingB; // Ascending (less missing first)
          });
          break;
          
        case 'remaining':
          // Show all items first
          sortedItems.forEach(item => {
            item.style.display = 'flex';
          });
          sortedItems.sort((a, b) => {
            const remainingA = parseInt(a.getAttribute('data-remaining') || '0');
            const remainingB = parseInt(b.getAttribute('data-remaining') || '0');
            return remainingB - remainingA; // Descending (more remaining first)
          });
          break;
          
        case 'progress':
          // Show all items first
          sortedItems.forEach(item => {
            item.style.display = 'flex';
          });
          sortedItems.sort((a, b) => {
            const progressA = parseFloat(a.getAttribute('data-progress') || '0');
            const progressB = parseFloat(b.getAttribute('data-progress') || '0');
            return progressB - progressA; // Descending (higher progress first)
          });
          break;
          
        case 'most-painted':
          // Show all items first
          sortedItems.forEach(item => {
            item.style.display = 'flex';
          });
          sortedItems.sort((a, b) => {
            const paintedA = parseInt(a.getAttribute('data-painted') || '0');
            const paintedB = parseInt(b.getAttribute('data-painted') || '0');
            return paintedB - paintedA; // Descending (more painted first)
          });
          break;
          
        case 'less-painted':
          // Show all items first
          sortedItems.forEach(item => {
            item.style.display = 'flex';
          });
          sortedItems.sort((a, b) => {
            const paintedA = parseInt(a.getAttribute('data-painted') || '0');
            const paintedB = parseInt(b.getAttribute('data-painted') || '0');
            const totalA = parseInt(a.getAttribute('data-total') || '0');
            const totalB = parseInt(b.getAttribute('data-total') || '0');
            
            // Filter out 0/0 colors (no pixels at all) - put them at the end
            if (totalA === 0 && totalB > 0) return 1;
            if (totalB === 0 && totalA > 0) return -1;
            if (totalA === 0 && totalB === 0) return 0;
            
            return paintedA - paintedB; // Ascending (less painted first)
          });
          break;
          
        case 'enhanced':
          // First show all items, then sort enhanced ones to top
          sortedItems.forEach(item => {
            item.style.display = 'flex';
          });
          sortedItems.sort((a, b) => {
            const enhancedA = a.querySelector('input[type="checkbox"]').checked;
            const enhancedB = b.querySelector('input[type="checkbox"]').checked;
            if (enhancedA && !enhancedB) return -1;
            if (!enhancedA && enhancedB) return 1;
            return 0;
          });
          // Filter to show only enhanced colors
          sortedItems.forEach(item => {
            const isEnhanced = item.querySelector('input[type="checkbox"]').checked;
            item.style.display = isEnhanced ? 'flex' : 'none';
          });
          break;
          
        case 'default':
        default:
          // Show all items and use original order
          sortedItems.forEach(item => {
            item.style.display = 'flex';
          });
          // Sort by original index
          sortedItems.sort((a, b) => {
            const indexA = parseInt(a.getAttribute('data-original-index') || '0');
            const indexB = parseInt(b.getAttribute('data-original-index') || '0');
            return indexA - indexB;
          });
          break;
      }
      
      // Clear and re-append all sorted items
      compactContent.innerHTML = '';
      sortedItems.forEach(item => {
        compactContent.appendChild(item);
      });
    };
    
    // Add sort event listener
        compactSortSelect.addEventListener('change', () => {
            saveCompactSort(compactSortSelect.value);
            applyCompactSort(compactSortSelect.value);
        });

    
    // Load saved sort preference
        const savedSort = getCompactSort(); // migrates from localStorage if needed
        if ([...compactSortSelect.options].some(o => o.value === savedSort)) {
            compactSortSelect.value = savedSort;
        } else {
            compactSortSelect.value = 'default';
        }


    // Store reference to all original items for sorting
    let allCompactItems = [];

    // Build compact list items
    utils.colorpalette.forEach((color, index) => {
      const colorKey = `${color.rgb[0]},${color.rgb[1]},${color.rgb[2]}`;
      if (index === 0) return; // Skip transparent

      const stats = pixelStats[colorKey] || {};

      // Check if color is currently disabled in template
      const templateInstance = templateManager.templatesArray?.[0];
      const isDisabled = templateInstance ? templateInstance.isColorDisabled(color.rgb) : false;

      // Get progress data first
      const painted = stats.painted || 0;
      const remaining = stats.needsCrosshair || 0;
      const totalPixels = painted + remaining; // Real total = painted + remaining
      const progressPercent = totalPixels > 0 ? Math.round((painted / totalPixels) * 100) : 0;

      const item = document.createElement('div');
      item.className = 'bmcf-compact-item';
      item.setAttribute('data-color-rgb', colorKey);
      item.setAttribute('data-original-index', index.toString());
      item.setAttribute('data-remaining', remaining.toString());
      item.setAttribute('data-painted', painted.toString());
      item.setAttribute('data-total', totalPixels.toString());
      item.setAttribute('data-progress', progressPercent.toString());
      item.style.cssText = `
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 4px 8px;
        border-bottom: 1px solid var(--slate-700);
        cursor: pointer;
        transition: background-color 0.15s ease;
        min-height: 32px;
        ${isDisabled ? 'opacity: 0.5; background: rgba(244, 67, 54, 0.1);' : ''}
      `;
      item.onmouseover = () => item.style.backgroundColor = 'var(--slate-700)';
      item.onmouseout = () => item.style.backgroundColor = '';

      // Color swatch
      const swatch = document.createElement('div');
      swatch.style.cssText = `
        width: 14px;
        height: 14px;
        border-radius: 2px;
        background: rgb(${color.rgb.join(',')});
        border: 1px solid rgba(255,255,255,0.2);
        flex-shrink: 0;
      `;

      // Color name with progress
      const name = document.createElement('div');
      name.className = 'bmcf-compact-name';
      name.style.cssText = `
        font-size: 10px;
        color: var(--bmcf-text);
        flex: 1;
        min-width: 0;
        overflow: hidden;
      `;
      
      name.innerHTML = `
        <div style="font-weight: 600; margin-bottom: 1px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${color.name}</div>
        <div style="font-size: 8px; color: var(--bmcf-text-muted); opacity: 0.8; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
          ${painted.toLocaleString()}/${totalPixels.toLocaleString()} (${progressPercent}%) | ${remaining.toLocaleString()} left
        </div>
      `;

      // Remove separate count display since it's now in the progress line

      // Controls container
      const controlsContainer = document.createElement('div');
      controlsContainer.style.cssText = `
        display: flex;
        align-items: center;
        gap: 4px;
        flex-shrink: 0;
      `;

      // Enhanced mode checkbox
      const enhancedCheckbox = document.createElement('input');
      enhancedCheckbox.type = 'checkbox';
      enhancedCheckbox.style.cssText = `
        width: 12px;
        height: 12px;
        cursor: pointer;
      `;
      enhancedCheckbox.title = 'Enable enhanced mode for this color';
      
      // Check if color is currently enhanced
      if (templateInstance && templateInstance.enhancedColors) {
        const rgbKey = color.rgb.join(',');
        enhancedCheckbox.checked = templateInstance.enhancedColors.has(rgbKey);
      }
      
      enhancedCheckbox.onclick = (e) => {
        e.stopPropagation();
      };
      
      enhancedCheckbox.onchange = (e) => {
        e.stopPropagation();
        const currentTemplate = templateManager.templatesArray?.[0];
        if (!currentTemplate) return;
        
        if (enhancedCheckbox.checked) {
          currentTemplate.enableColorEnhanced(color.rgb);
          overlayMain.handleDisplayStatus(`Enhanced mode enabled: ${color.name}`);
        } else {
          currentTemplate.disableColorEnhanced(color.rgb);
          overlayMain.handleDisplayStatus(`Enhanced mode disabled: ${color.name}`);
        }
        
        invalidateTemplateCache();
        
        // Sync with main overlay checkboxes
        const gridItem = colorViewContainer.querySelector(`[data-color-rgb="${colorKey}"]`);
        const listItem = colorViewContainer.querySelector(`[data-color-rgb="${colorKey}"].bmcf-list-item`);
        
        if (gridItem) {
          const gridCheckbox = gridItem.querySelector('input[type="checkbox"]');
          if (gridCheckbox) gridCheckbox.checked = enhancedCheckbox.checked;
        }
        
        if (listItem) {
          const listCheckbox = listItem.querySelector('input[type="checkbox"]');
          if (listCheckbox) listCheckbox.checked = enhancedCheckbox.checked;
        }
        
        
        // Refresh template display to save changes persistently
        refreshTemplateDisplay().catch(error => {
          console.error('Error refreshing enhanced mode from Color Toggle:', error);
        });
      };

      // Premium indicator (droplet for premium colors only)
      const premiumIcon = document.createElement('div');
      if (!color.free) {
        premiumIcon.textContent = "💧";
        premiumIcon.title = "Premium color";
        premiumIcon.style.cssText = `
          width: 14px;
          height: 14px;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 10px;
          opacity: 0.8;
          flex-shrink: 0;
        `;
      } else {
        // Empty space for free colors to maintain alignment
        premiumIcon.style.cssText = `
          width: 14px;
          height: 14px;
          flex-shrink: 0;
        `;
      }
      
      controlsContainer.appendChild(premiumIcon);
      controlsContainer.appendChild(enhancedCheckbox);

      // Click handler - directly toggle color using template methods
      item.onclick = (e) => {
        e.stopPropagation();
        
        // Get current template
        const currentTemplate = templateManager.templatesArray?.[0];
        if (!currentTemplate) {
          overlayMain.handleDisplayStatus(`No template loaded`);
          return;
        }

        const rgb = color.rgb;
        const wasDisabled = currentTemplate.isColorDisabled(rgb);
        
        // Find the corresponding grid/list items for visual sync
        const gridItem = colorViewContainer.querySelector(`[data-color-rgb="${colorKey}"]`);
        const listItem = colorViewContainer.querySelector(`[data-color-rgb="${colorKey}"].bmcf-list-item`);
        
        if (wasDisabled) {
          // Enable the color
          currentTemplate.enableColor(rgb);
          
          // Update grid item visual
          if (gridItem) {
            gridItem.style.border = '3px solid #4caf50';
            const overlay = gridItem.querySelector('div[style*="position: absolute"]');
            if (overlay) overlay.remove();
            const enhancedCheckbox = gridItem.querySelector('input[type="checkbox"]');
            if (enhancedCheckbox) enhancedCheckbox.disabled = false;
          }
          
          // Update list item visual
          if (listItem) {
            listItem.style.border = '2px solid #4caf50';
            listItem.style.opacity = '1';
            const listEnhancedCheckbox = listItem.querySelector('input[type="checkbox"]');
            if (listEnhancedCheckbox) listEnhancedCheckbox.disabled = false;
          }
          
          // Update compact list visual
          item.style.opacity = '1';
          item.style.background = '';
          
          overlayMain.handleDisplayStatus(`Color enabled: ${color.name}`);
        } else {
          // Disable the color
          currentTemplate.disableColor(rgb);
          
          // Update grid item visual
          if (gridItem) {
            gridItem.style.border = '3px solid #f44336';
            // Add disabled overlay
            const colorClickArea = gridItem.querySelector('[style*="cursor: pointer"]');
            if (colorClickArea && !colorClickArea.querySelector('div[style*="position: absolute"]')) {
              const disabledOverlay = document.createElement('div');
              disabledOverlay.style.cssText = `
                position: absolute; top: 0; left: 0; right: 0; bottom: 0;
                background: rgba(0,0,0,0.6); display: flex; align-items: center; justify-content: center;
                font-size: 24px; color: #f44336; pointer-events: none;
              `;
              disabledOverlay.textContent = '✕';
              colorClickArea.appendChild(disabledOverlay);
            }
            const enhancedCheckbox = gridItem.querySelector('input[type="checkbox"]');
            if (enhancedCheckbox) enhancedCheckbox.disabled = true;
          }
          
          // Update list item visual
          if (listItem) {
            listItem.style.border = '2px solid #f44336';
            listItem.style.opacity = '0.5';
            const listEnhancedCheckbox = listItem.querySelector('input[type="checkbox"]');
            if (listEnhancedCheckbox) listEnhancedCheckbox.disabled = true;
          }
          
          // Update compact list visual
          item.style.opacity = '0.5';
          item.style.background = 'rgba(244, 67, 54, 0.1)';
          
          overlayMain.handleDisplayStatus(`Color disabled: ${color.name}`);
        }

        invalidateTemplateCache();

        // Update progress display after the toggle
        setTimeout(() => {
          const freshStats = templateManager.calculateRemainingPixelsByColor(0, true); // Only enabled templates
          const freshPainted = freshStats[colorKey]?.painted || 0;
          const freshRemaining = freshStats[colorKey]?.needsCrosshair || 0;
          
          // Update the progress line in the name element
          const freshTotalPixels = freshPainted + freshRemaining;
          const freshProgressPercent = freshTotalPixels > 0 ? Math.round((freshPainted / freshTotalPixels) * 100) : 0;
          
          name.innerHTML = `
            <div style="font-weight: 600; margin-bottom: 1px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${color.name}</div>
            <div style="font-size: 8px; color: var(--bmcf-text-muted); opacity: 0.8; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
              ${freshPainted.toLocaleString()}/${freshTotalPixels.toLocaleString()} (${freshProgressPercent}%) | ${freshRemaining.toLocaleString()} left
            </div>
          `;
        }, 100);
      };

      item.appendChild(swatch);
      item.appendChild(name);
      item.appendChild(controlsContainer);
      compactContent.appendChild(item);
      allCompactItems.push(item);
    });

    // Apply initial sort
    applyCompactSort(savedSort);
    
    // Add search functionality
    const applySearch = (searchTerm) => {
      const items = Array.from(compactContent.children);
      const term = searchTerm.toLowerCase().trim();
      
      let visibleCount = 0;
      items.forEach(item => {
        // Skip the no-results message element
        if (item.classList.contains('no-results-msg')) return;
        
        const colorNameElement = item.querySelector('.bmcf-compact-name');
        const colorName = colorNameElement?.textContent.toLowerCase() || '';
        const isVisible = term === '' || colorName.includes(term);
        
        item.style.display = isVisible ? 'flex' : 'none';
        if (isVisible) visibleCount++;
      });
      
      // Show "No results" message if no colors match
      let noResultsMsg = compactContent.querySelector('.no-results-msg');
      if (visibleCount === 0 && term !== '') {
        if (!noResultsMsg) {
          noResultsMsg = document.createElement('div');
          noResultsMsg.className = 'no-results-msg';
          noResultsMsg.style.cssText = `
            padding: 20px;
            text-align: center;
            color: var(--bmcf-text-muted);
            font-size: 12px;
            font-style: italic;
          `;
          noResultsMsg.textContent = 'No colors found';
          compactContent.appendChild(noResultsMsg);
        }
        noResultsMsg.style.display = 'block';
      } else if (noResultsMsg) {
        noResultsMsg.style.display = 'none';
      }
    };
    
    // Add search input event listener
    searchInput.addEventListener('input', (e) => {
      applySearch(e.target.value);
    });
    
    // Prevent any interference with spacebar and other keys
    searchInput.addEventListener('keydown', (e) => {
      // Allow all normal typing including spacebar
      e.stopPropagation();
    });

    searchInput.addEventListener('keyup', (e) => {
      // Allow all normal typing including spacebar
      e.stopPropagation();
    });

    searchInput.addEventListener('keypress', (e) => {
      // Allow all normal typing including spacebar
      e.stopPropagation();
    });
    
    // Add keyboard shortcut for search (Ctrl+F)
    compactList.addEventListener('keydown', (e) => {
      if (e.ctrlKey && e.key === 'f') {
        e.preventDefault();
        searchInput.focus();
        searchInput.select();
      }
      
      // Escape to clear search
      if (e.key === 'Escape' && document.activeElement === searchInput) {
        searchInput.value = '';
        applySearch('');
        searchInput.blur();
      }
    });

    // Add compact list to body (separate floating window)
    document.body.appendChild(compactList);
    } // End of shouldCreateCompactList

    // Function to update compact list data
    window.updateCompactListData = function(existingList) {
      const compactContent = existingList.querySelector('div[style*="overflow-y: auto"]');
      if (!compactContent) return;
      
      // Get fresh data
      const freshPixelStats = templateManager.calculateRemainingPixelsByColor(0, true); // Only enabled templates
      const templateInstance = templateManager.templatesArray?.[0];
      
      // Update each item
      utils.colorpalette.forEach((color, index) => {
        if (index === 0) return; // Skip transparent
        
        const colorKey = `${color.rgb[0]},${color.rgb[1]},${color.rgb[2]}`;
        const item = compactContent.querySelector(`[data-color-rgb="${colorKey}"]`);
        
        if (item) {
          const stats = freshPixelStats[colorKey] || {};
          const painted = stats.painted || 0;
          const remaining = stats.needsCrosshair || 0;
          const totalPixels = painted + remaining;
          const progressPercent = totalPixels > 0 ? Math.round((painted / totalPixels) * 100) : 0;
          
          // Update data attributes for sorting
          item.setAttribute('data-remaining', remaining.toString());
          item.setAttribute('data-painted', painted.toString());
          item.setAttribute('data-total', totalPixels.toString());
          item.setAttribute('data-progress', progressPercent.toString());
          
          // Update progress text
          const nameDiv = item.querySelector('div[style*="flex: 1"]');
          if (nameDiv) {
            nameDiv.innerHTML = `
              <div style="font-weight: 600; margin-bottom: 1px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${color.name}</div>
              <div style="font-size: 8px; color: var(--bmcf-text-muted); opacity: 0.8; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
                ${painted.toLocaleString()}/${totalPixels.toLocaleString()} (${progressPercent}%) | ${remaining.toLocaleString()} left
              </div>
            `;
          }
          
          // Update visual state based on template
          const isDisabled = templateInstance ? templateInstance.isColorDisabled(color.rgb) : false;
          if (isDisabled) {
            item.style.opacity = '0.5';
            item.style.background = 'rgba(244, 67, 54, 0.1)';
          } else {
            item.style.opacity = '1';
            item.style.background = '';
          }
          
          // Update enhanced checkbox
          const checkbox = item.querySelector('input[type="checkbox"]');
          if (checkbox && templateInstance && templateInstance.enhancedColors) {
            const rgbKey = color.rgb.join(',');
            checkbox.checked = templateInstance.enhancedColors.has(rgbKey);
          }
        }
      });
    };

    // Add click handler to compact list button
    compactListButton.onclick = () => {
      // Check if there's already an existing compact list
      const existingCompactList = document.getElementById('bmcf-compact-list');
      
      if (existingCompactList) {
        // Reuse existing list
        const isVisible = existingCompactList.style.display !== 'none';
        if (isVisible) {
          existingCompactList.style.display = 'none';
          compactListButton.style.background = 'linear-gradient(135deg, var(--slate-600), var(--slate-700))';
        } else {
          existingCompactList.style.display = 'flex';
          existingCompactList.style.flexDirection = 'column';
          compactListButton.style.background = 'linear-gradient(135deg, var(--blue-600), var(--blue-700))';
          
          // Update the existing list with fresh data
          updateCompactListData(existingCompactList);
        }
      } else {
        // Show the newly created list
        const isVisible = compactList.style.display !== 'none';
        if (isVisible) {
          compactList.style.display = 'none';
          compactListButton.style.background = 'linear-gradient(135deg, var(--slate-600), var(--slate-700))';
        } else {
          compactList.style.display = 'flex';
          compactList.style.flexDirection = 'column';
          compactListButton.style.background = 'linear-gradient(135deg, var(--blue-600), var(--blue-700))';
        }
      }
    };

    // Set up automatic updates for compact list
    const originalRefreshTemplateDisplay = window.refreshTemplateDisplay;
    if (originalRefreshTemplateDisplay && typeof originalRefreshTemplateDisplay === 'function') {
      window.refreshTemplateDisplay = async function(...args) {
        const result = await originalRefreshTemplateDisplay.apply(this, args);
        
        // Update compact list if it exists and is visible
        const existingCompactList = document.getElementById('bmcf-compact-list');
        if (existingCompactList && existingCompactList.style.display !== 'none') {
          setTimeout(() => {
            if (window.updateCompactListData) {
              window.updateCompactListData(existingCompactList);
            }
          }, 200); // Small delay to ensure stats are updated
        }
        
        return result;
      };
    }
    
    colorFilterOverlay.appendChild(contentContainer);
    colorFilterOverlay.appendChild(footerContainer);

    document.body.appendChild(colorFilterOverlay);

    // Initialize view state based on saved preference
    initializeViewState();

    // Apply or remove mobile mode styles based on current setting
    applyMobileModeToColorFilter(!!isMobileMode);
    if (isMobileMode) {
      debugLog('[Initial Build] Mobile mode applied immediately');
    } else {
      debugLog('[Initial Build] Mobile mode is OFF - ensuring desktop styles');
    }

    // Add drag functionality
    let isDragging = false;
    let dragStartX = 0;
    let dragStartY = 0;
    let initialLeft = 0;
    let initialTop = 0;

    header.addEventListener('mousedown', (e) => {
      isDragging = true;
      dragStartX = e.clientX;
      dragStartY = e.clientY;
      
      // Get current position
      const rect = colorFilterOverlay.getBoundingClientRect();
      initialLeft = rect.left;
      initialTop = rect.top;
      
      // Change to absolute positioning for dragging
      colorFilterOverlay.style.position = 'fixed';
      colorFilterOverlay.style.transform = 'none';
      colorFilterOverlay.style.left = initialLeft + 'px';
      colorFilterOverlay.style.top = initialTop + 'px';
      
      // Change cursor and drag bar style
      header.style.cursor = 'grabbing';
      dragBar.style.cursor = 'grabbing';
      dragBar.style.opacity = '1';
      colorFilterOverlay.style.userSelect = 'none';
      
      e.preventDefault();
    });

    // Touch drag support (mobile)
    header.addEventListener('touchstart', (e) => {
      const t = e.touches && e.touches[0];
      if (!t) return;
      
      // Check if the touch target is a button - if so, don't start dragging
      const target = e.target;
      if (target.tagName === 'BUTTON' || target.closest('button')) {
        return; // Let the button handle the touch event
      }
      
      isDragging = true;
      dragStartX = t.clientX;
      dragStartY = t.clientY;
      const rect = colorFilterOverlay.getBoundingClientRect();
      initialLeft = rect.left;
      initialTop = rect.top;
      colorFilterOverlay.style.position = 'fixed';
      colorFilterOverlay.style.transform = 'none';
      colorFilterOverlay.style.left = initialLeft + 'px';
      colorFilterOverlay.style.top = initialTop + 'px';
      colorFilterOverlay.style.userSelect = 'none';
      e.preventDefault();
    }, { passive: false });

    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      
      const deltaX = e.clientX - dragStartX;
      const deltaY = e.clientY - dragStartY;
      
      const newLeft = initialLeft + deltaX;
      const newTop = initialTop + deltaY;
      
      // Keep within viewport bounds
      const maxLeft = window.innerWidth - colorFilterOverlay.offsetWidth;
      const maxTop = window.innerHeight - colorFilterOverlay.offsetHeight;
      
      const clampedLeft = Math.max(0, Math.min(newLeft, maxLeft));
      const clampedTop = Math.max(0, Math.min(newTop, maxTop));
      
      colorFilterOverlay.style.left = clampedLeft + 'px';
      colorFilterOverlay.style.top = clampedTop + 'px';
    });

    document.addEventListener('touchmove', (e) => {
      if (!isDragging) return;
      const t = e.touches && e.touches[0];
      if (!t) return;
      const deltaX = t.clientX - dragStartX;
      const deltaY = t.clientY - dragStartY;
      const newLeft = initialLeft + deltaX;
      const newTop = initialTop + deltaY;
      const maxLeft = window.innerWidth - colorFilterOverlay.offsetWidth;
      const maxTop = window.innerHeight - colorFilterOverlay.offsetHeight;
      const clampedLeft = Math.max(0, Math.min(newLeft, maxLeft));
      const clampedTop = Math.max(0, Math.min(newTop, maxTop));
      colorFilterOverlay.style.left = clampedLeft + 'px';
      colorFilterOverlay.style.top = clampedTop + 'px';
      e.preventDefault();
    }, { passive: false });

    document.addEventListener('mouseup', () => {
      if (isDragging) {
        isDragging = false;
        // Restore cursor and drag bar style
        header.style.cursor = 'move';
        dragBar.style.cursor = 'grab';
        dragBar.style.opacity = '0.8';
        colorFilterOverlay.style.userSelect = '';
      }
    });

    document.addEventListener('touchend', () => {
      if (isDragging) {
        isDragging = false;
        colorFilterOverlay.style.userSelect = '';
      }
    });
  }).catch(err => {
    console.error('Failed to load color palette:', err);
    overlayMain.handleDisplayError('Failed to load color palette!');
  });
}

/** Refreshes the color filter overlay to update progress calculations
 * @since 1.0.0
 */
function refreshColorFilterOverlay() {
  // Close and reopen the color filter overlay to refresh stats
  const existingOverlay = document.getElementById('bm-color-filter-overlay');
  if (existingOverlay) {
    existingOverlay.remove();
    setTimeout(() => {
      buildColorFilterOverlay();
    }, 100);
  }
}

/** Forces template redraw to apply enhanced mode changes
 * @since 1.0.0
 */
function forceTemplateRedraw() {
  // Force a complete redraw of templates
  if (templateManager.templatesArray && templateManager.templatesArray.length > 0) {
    templateManager.setTemplatesShouldBeDrawn(false);
    setTimeout(() => {
      templateManager.setTemplatesShouldBeDrawn(true);
      // Update mini tracker after template redraw
      updateMiniTracker();
    }, 100); // Slightly longer delay to ensure redraw is complete
  }
}

// ====== KEYBOARD SHORTCUT: X + CLICK FOR ENHANCED COLORS ======

/** Map of color IDs to RGB values from r/place palette */
const COLOR_PALETTE_MAP = {
  'color-0': [255, 255, 255, 0], // Transparent
  'color-1': [0, 0, 0], // Black
  'color-2': [60, 60, 60], // Dark Gray
  'color-3': [120, 120, 120], // Gray
  'color-4': [210, 210, 210], // Light Gray
  'color-5': [255, 255, 255], // White
  'color-6': [96, 0, 24], // Deep Red
  'color-7': [237, 28, 36], // Red
  'color-8': [255, 127, 39], // Orange
  'color-9': [246, 170, 9], // Gold
  'color-10': [249, 221, 59], // Yellow
  'color-11': [255, 250, 188], // Light Yellow
  'color-12': [14, 185, 104], // Dark Green
  'color-13': [19, 230, 123], // Green
  'color-14': [135, 255, 94], // Light Green
  'color-15': [12, 129, 110], // Dark Teal
  'color-16': [16, 174, 166], // Teal
  'color-17': [19, 225, 190], // Light Teal
  'color-18': [40, 80, 158], // Dark Blue
  'color-19': [64, 147, 228], // Blue
  'color-20': [96, 247, 242], // Cyan
  'color-21': [107, 80, 246], // Indigo
  'color-22': [153, 177, 251], // Light Indigo
  'color-23': [120, 12, 153], // Dark Purple
  'color-24': [170, 56, 185], // Purple
  'color-25': [224, 159, 249], // Light Purple
  'color-26': [203, 0, 122], // Dark Pink
  'color-27': [236, 31, 128], // Pink
  'color-28': [243, 141, 169], // Light Pink
  'color-29': [104, 70, 52], // Dark Brown
  'color-30': [149, 104, 42], // Brown
  'color-31': [248, 178, 119], // Beige
  'color-32': [170, 170, 170], // Medium Gray
  'color-33': [165, 14, 30], // Dark Red
  'color-34': [250, 128, 114], // Light Red
  'color-35': [228, 92, 26], // Dark Orange
  'color-36': [214, 181, 148], // Light Tan
  'color-37': [156, 132, 49], // Dark Goldenrod
  'color-38': [197, 173, 49], // Goldenrod
  'color-39': [232, 212, 95], // Light Goldenrod
  'color-40': [74, 107, 58], // Dark Olive
  'color-41': [90, 148, 74], // Olive
  'color-42': [132, 197, 115], // Light Olive
  'color-43': [15, 121, 159], // Dark Cyan
  'color-44': [187, 250, 242], // Light Cyan
  'color-45': [125, 199, 255], // Light Blue
  'color-46': [77, 49, 184], // Dark Indigo
  'color-47': [74, 66, 132], // Dark Slate Blue
  'color-48': [122, 113, 196], // Slate Blue
  'color-49': [181, 174, 241], // Light Slate Blue
  'color-50': [219, 164, 99], // Light Brown
  'color-51': [209, 128, 81], // Dark Beige
  'color-52': [255, 197, 165], // Light Beige
  'color-53': [155, 82, 73], // Dark Peach
  'color-54': [209, 128, 120], // Peach
  'color-55': [250, 182, 164], // Light Peach
  'color-56': [123, 99, 82], // Dark Tan
  'color-57': [156, 132, 107], // Tan
  'color-58': [51, 57, 65], // Dark Slate
  'color-59': [109, 117, 141], // Slate
  'color-60': [179, 185, 209], // Light Slate
  'color-61': [109, 100, 63], // Dark Stone
  'color-62': [148, 140, 107], // Stone
  'color-63': [205, 197, 158] // Light Stone
};

/** State for X key shortcut */
let isEKeyPressed = false;
let eKeyModeActive = false;

/** Initialize keyboard shortcut functionality 
 * 
 * HOW TO USE THE X+CLICK SHORTCUT:
 * 1. Press and hold the 'X' key
 * 2. While holding 'X', click on any color in the r/place palette
 * 3. This will:
 *    - Clear all currently enhanced colors
 *    - Enable enhanced mode ONLY for the clicked color
 *    - Refresh the template to show the changes
 * 4. Release the 'X' key to exit enhanced selection mode
 * 
 * VISUAL FEEDBACK:
 * - Cursor changes to crosshair when X-Mode is active
 * - Status messages appear to confirm actions
 * - Color filter overlay automatically refreshes if open
 * 
 * @since 1.0.0
 */
function initializeKeyboardShortcuts() {
  debugLog('🎹 [Keyboard Shortcuts] Initializing X+Click shortcut for enhanced colors...');
  
  // Track X key press/release
  document.addEventListener('keydown', (event) => {
    if (event.code === 'KeyX' && !event.repeat) {
      isEKeyPressed = true;
      eKeyModeActive = true;
      
      // Visual feedback - add cursor style to show X mode is active
      document.body.style.cursor = 'crosshair';
      
      // Show notification
      if (typeof overlayMain !== 'undefined' && overlayMain.handleDisplayStatus) {
        overlayMain.handleDisplayStatus('🎹 X-Mode: Click a color to enable enhanced mode for that color only');
      }
      
      debugLog('🎹 [X-Mode] Enhanced selection mode ACTIVATED');
    }
  });
  
  document.addEventListener('keyup', (event) => {
    if (event.code === 'KeyX') {
      isEKeyPressed = false;
      eKeyModeActive = false;
      
      // Reset cursor
      document.body.style.cursor = '';
      
      debugLog('🎹 [X-Mode] Enhanced selection mode DEACTIVATED');
    }
  });
  
  // Handle clicks on color palette buttons when X is pressed
  document.addEventListener('click', handleEKeyColorClick, true);
  
  debugLog('[Keyboard Shortcuts] X+Click shortcut initialized successfully');
}

/** Handle X+Click on color palette */
function handleEKeyColorClick(event) {
  if (!eKeyModeActive) return;
  
  // Check if clicked element is a color button
  const colorButton = event.target.closest('button[id^="color-"]');
  if (!colorButton) return;
  
  // Prevent normal color selection
  event.preventDefault();
  event.stopPropagation();
  
  const colorId = colorButton.id;
  const rgbColor = COLOR_PALETTE_MAP[colorId];
  
  if (!rgbColor) {
    console.warn(`🎹 [X-Mode] Unknown color ID: ${colorId}`);
    return;
  }
  
  // Skip transparent color
  if (colorId === 'color-0') {
    if (typeof overlayMain !== 'undefined' && overlayMain.handleDisplayStatus) {
      overlayMain.handleDisplayStatus('🎹 X-Mode: Cannot enhance transparent color');
    }
    return;
  }
  
  debugLog(`🎹 [X-Mode] Processing color: ${colorId} -> RGB(${rgbColor.join(', ')})`);
  
  // Get current template
  const currentTemplate = templateManager.templatesArray?.[0];
  if (!currentTemplate) {
    if (typeof overlayMain !== 'undefined' && overlayMain.handleDisplayError) {
      overlayMain.handleDisplayError('🎹 X-Mode: No template loaded');
    }
    return;
  }
  
  try {
    // Clear all enhanced colors first
    currentTemplate.enhancedColors.clear();
    debugLog('🎹 [X-Mode] Cleared all enhanced colors');
    
    // Enable enhanced mode for the selected color
    currentTemplate.enableColorEnhanced(rgbColor);
    debugLog(`🎹 [X-Mode] Enhanced mode enabled for RGB(${rgbColor.join(', ')})`);
    
    invalidateTemplateCache();
    
    // Visual feedback
    const colorName = colorButton.getAttribute('aria-label') || colorId;
    if (typeof overlayMain !== 'undefined' && overlayMain.handleDisplayStatus) {
      overlayMain.handleDisplayStatus(`✅ Enhanced mode enabled for: ${colorName}`);
    }
    
    // Refresh template to apply changes
    refreshTemplateDisplay().then(() => {
      debugLog('🎹 [X-Mode] Template refreshed with new enhanced color');
    }).catch(error => {
      console.error('🎹 [X-Mode] Error refreshing template:', error);
    });
    
    // Update color filter overlay if it's open
    const colorFilterOverlay = document.getElementById('bm-color-filter-overlay');
    if (colorFilterOverlay) {
      // Close and reopen to refresh
      colorFilterOverlay.remove();
      setTimeout(() => {
        buildColorFilterOverlay();
      }, 100);
    }
    
  } catch (error) {
    console.error('🎹 [X-Mode] Error processing enhanced color:', error);
    if (typeof overlayMain !== 'undefined' && overlayMain.handleDisplayError) {
      overlayMain.handleDisplayError('🎹 X-Mode: Failed to set enhanced color');
    }
  }
}

// Make functions globally available
window.refreshColorFilterOverlay = refreshColorFilterOverlay;
window.forceTemplateRedraw = forceTemplateRedraw;

// Helper function to invalidate cache when templates change
function invalidateTemplateCache() {
  import('./tileManager.js').then(tileManager => {
    if (tileManager.invalidateCacheForSettingsChange) {
      tileManager.invalidateCacheForSettingsChange();
    }
  }).catch(() => {
    // Ignore errors if tileManager is not available yet
  });
}

// ====== ERROR MAP MODE (LURK INTEGRATION) ======

/** Gets the error map enabled state from storage */
function getErrorMapEnabled() {
  try {
    let enabled = null;
    if (typeof GM_getValue !== 'undefined') {
      const saved = GM_getValue('bmErrorMap', null);
      if (saved !== null) enabled = JSON.parse(saved);
    }
    if (enabled === null) {
      const saved = localStorage.getItem('bmErrorMap');
      if (saved !== null) enabled = JSON.parse(saved);
    }
    return enabled !== null ? enabled : false;
  } catch (error) {
    console.warn('Failed to load error map setting:', error);
  }
  return false;
}

/** Saves the error map enabled state to storage */
function saveErrorMapEnabled(enabled) {
  try {
    const enabledString = JSON.stringify(!!enabled);
    if (typeof GM_setValue !== 'undefined') {
      GM_setValue('bmErrorMap', enabledString);
    }
    localStorage.setItem('bmErrorMap', enabledString);
    debugLog('Error map setting saved:', enabled);
    // Invalidate cache since visual mode changed
    import('./tileManager.js').then(tileManager => {
      tileManager.invalidateCacheForSettingsChange();
    });
  } catch (error) {
    console.error('❌ Failed to save error map setting:', error);
  }
}

/** Toggles error map mode on/off */
function toggleErrorMapMode() {
  const currentState = getErrorMapEnabled();
  const newState = !currentState;
  saveErrorMapEnabled(newState);
  
  
  // Apply to template manager
  if (templateManager) {
    templateManager.setErrorMapMode(newState);
  }
  
  // Force template redraw to apply changes
  if (templateManager.templatesArray && templateManager.templatesArray.length > 0) {
    templateManager.setTemplatesShouldBeDrawn(false);
    setTimeout(() => {
      templateManager.setTemplatesShouldBeDrawn(true);
    }, 50);
  }
}

/** Injects/updates numeric LEFT badges on the site's native color palette buttons
 * @param {Object} pixelStats - Map keyed by "r,g,b" with {totalRequired, painted, needsCrosshair}
 */
function updatePaletteLeftBadges(pixelStats) {
  if (!getShowLeftOnColorEnabled()) return;
  if (!pixelStats || typeof pixelStats !== 'object') return;
  
  const idToRgb = COLOR_PALETTE_MAP || {};
  
  Object.entries(idToRgb).forEach(([colorId, rgb]) => {
    const btn = document.querySelector(`button#${CSS.escape(colorId)}`);
    if (!btn) return;
    if (colorId === 'color-0') return; // Transparent
    const key = `${rgb[0]},${rgb[1]},${rgb[2]}`;
    const stats = pixelStats[key];
    const left = stats && typeof stats.needsCrosshair === 'number' ? stats.needsCrosshair : 0;
    
    let badge = btn.querySelector('.bm-left-badge');
    if (!badge) {
      badge = document.createElement('div');
      badge.className = 'bm-left-badge';
      badge.style.cssText = `
        position: absolute;
        bottom: 2px;
        right: 2px;
        background: rgba(0,0,0,0.65);
        color: #fff;
        font-weight: 800;
        font-size: 10px;
        line-height: 1;
        padding: 2px 4px;
        border-radius: 6px;
        pointer-events: none;
        user-select: none;
        z-index: 2;
      `;
      if (!btn.style.position) btn.style.position = 'relative';
      btn.appendChild(badge);
    }
    badge.textContent = left.toLocaleString();
    badge.style.display = left > 0 ? 'block' : 'none';
  });
}

/** Refreshes the template display to show color filter changes
 * @since 1.0.0
 */
async function refreshTemplateDisplay() {
  // This will trigger a re-render of the template
  if (templateManager.templatesArray && templateManager.templatesArray.length > 0) {
    // Force a complete recreation of the template with current color filter
    try {
      debugLog('Starting template refresh with color filter...');
      
      // Get the current template
      const currentTemplate = templateManager.templatesArray[0];
      debugLog('Current disabled colors:', currentTemplate.getDisabledColors());
      
      // Invalidate enhanced cache when colors change
      currentTemplate.invalidateEnhancedCache();
      
      // Disable templates first to clear the display
      templateManager.setTemplatesShouldBeDrawn(false);
      
      // Wait a moment for the change to take effect
      await new Promise(resolve => setTimeout(resolve, 50));
      
      // Force recreation of template tiles with current color filter
      debugLog('Recreating template tiles with color filter...');
      await templateManager.updateTemplateWithColorFilter(0);
      
      // Re-enable templates to show the updated version
      templateManager.setTemplatesShouldBeDrawn(true);
      
      debugLog('Template refresh completed successfully');
      
    } catch (error) {
      console.error('Error refreshing template display:', error);
      overlayMain.handleDisplayError('Failed to apply color filter');
      throw error; // Re-throw to handle in calling function
    }
  } else {
    console.warn('No templates available to refresh');
  }
  
  // Update mini tracker after template refresh
  updateMiniTracker();
  
  // Update Color Menu after template refresh (same as mini tracker)
  if (typeof updateColorMenuDisplay === 'function') {
    setTimeout(() => updateColorMenuDisplay(false, true), 100);
  }
}

/** Gets the saved crosshair color from storage
 * @returns {Object} The crosshair color configuration
 * @since 1.0.0 
 */
function getCrosshairColor() {
  try {
    let savedColor = null;
    
    // Try TamperMonkey storage first
    if (typeof GM_getValue !== 'undefined') {
      const saved = GM_getValue('bmCrosshairColor', null);
      if (saved) savedColor = JSON.parse(saved);
    }
    
    // Fallback to localStorage
    if (!savedColor) {
      const saved = localStorage.getItem('bmCrosshairColor');
      if (saved) savedColor = JSON.parse(saved);
    }
    
    // Auto-migrate old alpha values (180 -> 255)
    if (savedColor && savedColor.alpha === 180) {
      savedColor.alpha = 255;
      saveCrosshairColor(savedColor); // Save the migrated value
      debugLog('Auto-migrated crosshair transparency from 71% to 100%');
    }
    
    if (savedColor) return savedColor;
  } catch (error) {
    console.warn('Failed to load crosshair color:', error);
  }
  
  // Default red color
  return {
    name: 'Red',
    rgb: [255, 0, 0],
    alpha: 255
  };
}

/** Saves the crosshair color to storage
 * @param {Object} colorConfig - The color configuration to save
 * @since 1.0.0
 */
function saveCrosshairColor(colorConfig) {
  try {
    const colorString = JSON.stringify(colorConfig);
    
    // Save to TamperMonkey storage
    if (typeof GM_setValue !== 'undefined') {
      GM_setValue('bmCrosshairColor', colorString);
    }
    
    // Also save to localStorage as backup
    localStorage.setItem('bmCrosshairColor', colorString);
    
    debugLog('Crosshair color saved:', colorConfig);
    // Invalidate cache for setting change
    import('./tileManager.js').then(tileManager => {
      tileManager.invalidateCacheForSettingsChange();
    });
  } catch (error) {
    console.error('Failed to save crosshair color:', error);
  }
}

/** Gets the border enabled setting from storage
 * @returns {boolean} Whether borders are enabled
 * @since 1.0.0 
 */
function getBorderEnabled() {
  try {
    let borderEnabled = null;
    
    // Try TamperMonkey storage first
    if (typeof GM_getValue !== 'undefined') {
      const saved = GM_getValue('bmCrosshairBorder', null);
      if (saved !== null) borderEnabled = JSON.parse(saved);
    }
    
    // Fallback to localStorage
    if (borderEnabled === null) {
      const saved = localStorage.getItem('bmCrosshairBorder');
      if (saved !== null) borderEnabled = JSON.parse(saved);
    }
    
    if (borderEnabled !== null) {
      debugLog('🔲 Border setting loaded:', borderEnabled);
      return borderEnabled;
    }
  } catch (error) {
    console.warn('Failed to load border setting:', error);
  }
  
  // Default to disabled
  debugLog('🔲 Using default border setting: false');
  return false;
}

/** Saves the border enabled setting to storage
 * @param {boolean} enabled - Whether borders should be enabled
 * @since 1.0.0
 */
function saveBorderEnabled(enabled) {
  try {
    const enabledString = JSON.stringify(enabled);
    
    debugLog('Saving border setting:', enabled, 'as string:', enabledString);
    
    // Save to TamperMonkey storage
    if (typeof GM_setValue !== 'undefined') {
      GM_setValue('bmCrosshairBorder', enabledString);
    }
    
    // Also save to localStorage as backup
    localStorage.setItem('bmCrosshairBorder', enabledString);
    debugLog('🔲 Saved to localStorage');
    
    debugLog('Border setting saved successfully:', enabled);
  } catch (error) {
    console.error('❌ Failed to save border setting:', error);
  }
}

/** Gets the enhanced size enabled setting from storage
 * @returns {boolean} Whether enhanced size is enabled
 * @since 1.0.0 
 */
function getEnhancedSizeEnabled() {
  try {
    let enhancedSizeEnabled = null;
    
    // Try TamperMonkey storage first
    if (typeof GM_getValue !== 'undefined') {
      const saved = GM_getValue('bmCrosshairEnhancedSize', null);
      if (saved !== null) {
        enhancedSizeEnabled = JSON.parse(saved);
      }
    }
    
    // Fallback to localStorage
    if (enhancedSizeEnabled === null) {
      const saved = localStorage.getItem('bmCrosshairEnhancedSize');
      if (saved !== null) {
        enhancedSizeEnabled = JSON.parse(saved);
      }
    }
    
    if (enhancedSizeEnabled !== null) {
      return enhancedSizeEnabled;
    }
  } catch (error) {
    console.error('Failed to load enhanced size setting:', error);
  }
  
  // Default to disabled
  return false;
}

/** Saves the enhanced size enabled setting to storage
 * @param {boolean} enabled - Whether enhanced size should be enabled
 * @since 1.0.0 
 */
function saveEnhancedSizeEnabled(enabled) {
  try {
    const enabledString = JSON.stringify(enabled);
    
    // Save to TamperMonkey storage
    if (typeof GM_setValue !== 'undefined') {
      GM_setValue('bmCrosshairEnhancedSize', enabledString);
    }
    
    // Also save to localStorage as backup
    localStorage.setItem('bmCrosshairEnhancedSize', enabledString);
    
    debugLog('Enhanced size setting saved successfully:', enabled);
  } catch (error) {
    console.error('❌ Failed to save enhanced size setting:', error);
  }
}

/** Gets the crosshair radius setting from storage
 * @returns {number} The crosshair radius value (12-32)
 * @since 1.0.0 
 */
function getCrosshairRadius() {
  try {
    let radiusValue = null;
    
    // Try TamperMonkey storage first
    if (typeof GM_getValue !== 'undefined') {
      const saved = GM_getValue('bmCrosshairRadius', null);
      if (saved !== null) {
        radiusValue = JSON.parse(saved);
      }
    }
    
    // Fallback to localStorage
    if (radiusValue === null) {
      const saved = localStorage.getItem('bmCrosshairRadius');
      if (saved !== null) {
        radiusValue = JSON.parse(saved);
      }
    }
    
    if (radiusValue !== null) {
      // Ensure value is within valid range
      return Math.max(12, Math.min(32, radiusValue));
    }
  } catch (error) {
    console.error('Failed to load crosshair radius setting:', error);
  }
  
  return 16; // Default radius (between min 12 and max 32)
}

/** Saves the crosshair radius setting to storage
 * @param {number} radius - The crosshair radius value (12-32)
 * @since 1.0.0 
 */
function saveCrosshairRadius(radius) {
  try {
    // Ensure value is within valid range
    const clampedRadius = Math.max(12, Math.min(32, radius));
    const radiusString = JSON.stringify(clampedRadius);
    
    // Save to TamperMonkey storage
    if (typeof GM_setValue !== 'undefined') {
      GM_setValue('bmCrosshairRadius', radiusString);
    }
    
    // Also save to localStorage as backup
    localStorage.setItem('bmCrosshairRadius', radiusString);
    
    debugLog('Crosshair radius setting saved successfully:', clampedRadius);
  } catch (error) {
    console.error('❌ Failed to save crosshair radius setting:', error);
  }
}

/** Gets the mini tracker enabled setting from storage
 * @returns {boolean} Whether mini tracker is enabled
 * @since 1.0.0 
 */
function getMiniTrackerEnabled() {
  try {
    let trackerEnabled = null;
    
    // Try TamperMonkey storage first
    if (typeof GM_getValue !== 'undefined') {
      const saved = GM_getValue('bmMiniTracker', null);
      if (saved !== null) trackerEnabled = JSON.parse(saved);
    }
    
    // Fallback to localStorage
    if (trackerEnabled === null) {
      const saved = localStorage.getItem('bmMiniTracker');
      if (saved !== null) trackerEnabled = JSON.parse(saved);
    }
    
    if (trackerEnabled !== null) {
      debugLog('Mini tracker setting loaded:', trackerEnabled);
      return trackerEnabled;
    }
  } catch (error) {
    console.warn('Failed to load mini tracker setting:', error);
  }
  
  // Default to disabled
  return false;
}

/** Saves the mini tracker enabled setting to storage
 * @param {boolean} enabled - Whether mini tracker should be enabled
 * @since 1.0.0
 */
function saveMiniTrackerEnabled(enabled) {
  try {
    const enabledString = JSON.stringify(enabled);
    
    debugLog('Saving mini tracker setting:', enabled, 'as string:', enabledString);
    
    // Save to TamperMonkey storage
    if (typeof GM_setValue !== 'undefined') {
      GM_setValue('bmMiniTracker', enabledString);
    }
    
    // Also save to localStorage as backup
    localStorage.setItem('bmMiniTracker', enabledString);
    debugLog('Saved to localStorage');
    
    debugLog('Mini tracker setting saved successfully:', enabled);
  } catch (error) {
    console.error('❌ Failed to save mini tracker setting:', error);
  }
}

/** Gets the top bar enabled setting from storage
 * @returns {boolean} Whether top bar is enabled
 * @since 1.0.0
 */
function getTopBarEnabled() {
  try {
    let topBarEnabled = null;
    
    if (typeof GM_getValue !== 'undefined') {
      const saved = GM_getValue('bmTopBar', null);
      if (saved !== null) topBarEnabled = JSON.parse(saved);
    }
    
    if (topBarEnabled === null) {
      const saved = localStorage.getItem('bmTopBar');
      if (saved !== null) topBarEnabled = JSON.parse(saved);
    }
    
    if (topBarEnabled !== null) {
      return topBarEnabled;
    }
  } catch (error) {
    console.warn('Failed to load top bar setting:', error);
  }
  
  return false;
}

/** Saves the top bar enabled setting to storage
 * @param {boolean} enabled - Whether top bar should be enabled
 * @since 1.0.0
 */
function saveTopBarEnabled(enabled) {
  try {
    const enabledString = JSON.stringify(enabled);
    
    if (typeof GM_setValue !== 'undefined') {
      GM_setValue('bmTopBar', enabledString);
    }
    
    localStorage.setItem('bmTopBar', enabledString);
    
    debugLog('Top bar setting saved successfully:', enabled);
  } catch (error) {
    console.error('❌ Failed to save top bar setting:', error);
  }
}

/** Gets the collapse mini template setting from storage
 * @returns {boolean} Whether collapse mini template should be enabled
 * @since 1.0.0
 */
function getCollapseMinEnabled() {
  try {
    let collapseEnabled = null;
    
    // Try TamperMonkey storage first
    if (typeof GM_getValue !== 'undefined') {
      const saved = GM_getValue('bmCollapseMin', null);
      if (saved !== null) collapseEnabled = JSON.parse(saved);
    }
    
    // Fallback to localStorage
    if (collapseEnabled === null) {
      const saved = localStorage.getItem('bmCollapseMin');
      if (saved !== null) collapseEnabled = JSON.parse(saved);
    }
    
    if (collapseEnabled !== null) {
      debugLog('Collapse mini template setting loaded:', collapseEnabled);
      return collapseEnabled;
    }
  } catch (error) {
    console.warn('Failed to load collapse mini template setting:', error);
  }
  
  // Default to enabled
  return true;
}

/** Saves the collapse mini template setting to storage
 * @param {boolean} enabled - Whether collapse mini template should be enabled
 * @since 1.0.0
 */
function saveCollapseMinEnabled(enabled) {
  try {
    const enabledString = JSON.stringify(enabled);
    
    debugLog('Saving collapse mini template setting:', enabled, 'as string:', enabledString);
    
    // Save to TamperMonkey storage
    if (typeof GM_setValue !== 'undefined') {
      GM_setValue('bmCollapseMin', enabledString);
    }
    
    // Also save to localStorage as backup
    localStorage.setItem('bmCollapseMin', enabledString);
    debugLog('Saved to localStorage');
    
    debugLog('Collapse mini template setting saved successfully:', enabled);
  } catch (error) {
    console.error('❌ Failed to save collapse mini template setting:', error);
  }
}

/** Gets the mobile mode setting
 * @returns {boolean} Mobile mode enabled state
 * @since 1.0.0
 */
function getMobileMode() {
  try {
    debugLog('Loading mobile mode setting...');
    const storedValue = localStorage.getItem('bmMobileMode') || 'false';
    const mobileMode = JSON.parse(storedValue);
    debugLog('Mobile mode setting loaded:', mobileMode);
    return mobileMode;
  } catch (error) {
    console.error('❌ Failed to load mobile mode setting:', error);
    return false;
  }
}

/** Gets the setting for showing only the numeric left value on color cards
 * @returns {boolean} Whether numeric left badges are enabled
 */
function getShowLeftOnColorEnabled() {
  try {
    let enabled = null;
    if (typeof GM_getValue !== 'undefined') {
      const saved = GM_getValue('bmShowLeftOnColor', null);
      if (saved !== null) enabled = JSON.parse(saved);
    }
    if (enabled === null) {
      const saved = localStorage.getItem('bmShowLeftOnColor');
      if (saved !== null) enabled = JSON.parse(saved);
    }
    if (enabled !== null) {
      debugLog('Show Left-on-Color setting loaded:', enabled);
      return enabled;
    }
  } catch (error) {
    console.warn('Failed to load Show Left-on-Color setting:', error);
  }
  return false;
}

/** Saves the setting for showing only the numeric left value on color cards
 * @param {boolean} enabled - Whether numeric left badges should be shown
 */
function saveShowLeftOnColorEnabled(enabled) {
  try {
    const enabledString = JSON.stringify(!!enabled);
    if (typeof GM_setValue !== 'undefined') {
      GM_setValue('bmShowLeftOnColor', enabledString);
    }
    localStorage.setItem('bmShowLeftOnColor', enabledString);
    debugLog('Show Left-on-Color setting saved:', enabled);
    
    // Restart the left badges auto-update system with the new setting
    startLeftBadgesAutoUpdate();
  } catch (error) {
    console.error('❌ Failed to save Show Left-on-Color setting:', error);
  }
}

/** Saves the mobile mode setting
 * @param {boolean} enabled - Whether mobile mode is enabled
 * @since 1.0.0
 */
function saveMobileMode(enabled) {
  try {
    const enabledString = JSON.stringify(enabled);
    debugLog('Saving mobile mode setting:', enabled);
    localStorage.setItem('bmMobileMode', enabledString);
    debugLog('Mobile mode setting saved successfully:', enabled);
  } catch (error) {
    console.error('❌ Failed to save mobile mode setting:', error);
  }
}

/**
 * Apply mobile mode styles to existing Color Filter overlay dynamically
 * @param {boolean} enableMobile - Whether to enable mobile mode
 * @since 1.0.0
 */
function applyMobileModeToColorFilter(enableMobile) {
  const existingOverlay = document.getElementById('bm-color-filter-overlay');
  if (!existingOverlay) {
    debugLog('[Dynamic Mobile] No Color Filter overlay found');
    return;
  }

  // ALWAYS remove existing mobile styles first to prevent accumulation
  let mobileStyleElement = document.getElementById('bmcf-mobile-styles');
  if (mobileStyleElement) {
    mobileStyleElement.remove();
    debugLog('[Dynamic Mobile] Removed existing mobile styles');
  }
  
  if (enableMobile) {
    // Create fresh mobile style element
    mobileStyleElement = document.createElement('style');
    mobileStyleElement.id = 'bmcf-mobile-styles';
    document.head.appendChild(mobileStyleElement);
    
    mobileStyleElement.textContent = `
      /* Dynamic Mobile Mode Styles - Applied Fresh */
      .bmcf-overlay { 
        width: min(96vw, 420px) !important; 
        max-height: 75vh !important; 
        border-radius: 12px !important; 
        padding: 6px !important;
      }
      .bmcf-header { 
        padding: 8px 10px 6px 10px !important; 
      }
      .bmcf-drag-bar { 
        height: 4px !important; 
        margin-bottom: 6px !important; 
      }
      .bmcf-title { 
        font-size: 1.12em !important; 
      }
      .bmcf-close { 
        width: 22px !important; 
        height: 22px !important; 
      }
      .bmcf-search { 
        height: 28px !important; 
        padding: 6px 10px !important; 
        font-size: 0.75em !important; 
      }
      .bmcf-select { 
        height: 28px !important; 
        padding: 4px 8px !important; 
        font-size: 0.85em !important; 
      }
      .bmcf-grid { 
        grid-template-columns: repeat(3, minmax(0, 1fr)) !important; 
        gap: 4px !important; 
        justify-content: stretch !important;
      }
      .bmcf-card { 
        padding: 6px 8px 10px 8px !important; 
        border-radius: 6px !important; 
        width: auto !important;
        height: 108px !important;
        box-sizing: border-box !important;
      }
      /* Enhanced row and label compact spacing */
      .bmcf-card .bmcf-enhanced { 
        padding: 0 2px !important; 
        margin-top: 2px !important; 
        margin-bottom: 2px !important; 
        gap: 2px !important; 
      }
      .bmcf-card .bmcf-enhanced input { 
        width: 12px !important; 
        height: 12px !important; 
      }
      .bmcf-card .bmcf-color-name { 
        margin-bottom: 1px !important; 
        font-size: 0.9em !important; 
        line-height: 1.05 !important;
      }
      .bmcf-card .bmcf-stats { 
        padding: 0 2px !important; 
        font-size: 0.8em !important; 
        line-height: 1.05 !important;
      }
      .bmcf-color-box { 
        width: 18px !important; 
        height: 18px !important; 
        border-radius: 3px !important; 
      }
      .bmcf-color-name { 
        font-size: 0.75em !important; 
      }
      .bmcf-stats { 
        font-size: 0.65em !important; 
        gap: 2px !important; 
      }
      .bmcf-btn { 
        height: 28px !important; 
        padding: 0 10px !important; 
        min-width: 70px !important; 
        font-size: 0.75em !important; 
      }
      .bmcf-footer { 
        padding: 6px 8px !important; 
        gap: 6px !important; 
      }
      .bmcf-progress-container { 
        padding: 6px 10px !important; 
      }
      .bmcf-instructions { 
        font-size: 0.7em !important; 
        padding: 6px 10px !important; 
      }
      /* List view styles for mobile */
      .bmcf-list { 
        gap: 4px !important; 
      }
      .bmcf-list-item { 
        padding: 6px 8px !important; 
        min-height: 40px !important;
        gap: 8px !important;
      }
      .bmcf-list-item .info-container { 
        font-size: 0.8em !important; 
      }
      .bmcf-list-item .color-swatch { 
        width: 24px !important; 
        height: 24px !important; 
      }
    `;
    debugLog('[Dynamic Mobile] Mobile mode styles applied FRESH to Color Filter');
  } else {
    debugLog('[Dynamic Mobile] Mobile mode disabled - styles removed');
  }
}

/** Updates the mini progress tracker visibility and content
 * @since 1.0.0
 */
function updateMiniTracker() {
  try {
  const trackerEnabled = getMiniTrackerEnabled();
  const collapseEnabled = getCollapseMinEnabled();
  const existingTracker = document.getElementById('bm-mini-tracker');
  
  // Check if main overlay is minimized
  const mainOverlay = document.getElementById('bm-overlay');
    if (!mainOverlay) {
      console.warn('Main overlay not found, skipping mini tracker update');
      return;
    }
    const isMainMinimized = mainOverlay && (mainOverlay.style.width === '60px' || mainOverlay.style.height === '76px' || mainOverlay.style.width === '72px');
  
  // Hide tracker if disabled OR if collapse is enabled and main is minimized
  if (!trackerEnabled || (collapseEnabled && isMainMinimized)) {
    if (existingTracker) {
      existingTracker.remove();
      debugLog(`Mini tracker hidden - ${!trackerEnabled ? 'disabled' : 'collapsed with main overlay'}`);
    }
    return;
  }
  
  // Calculate progress data using the SAME method as the main progress bar
  let totalRequired = 0;
  let totalPainted = 0;
  let totalNeedCrosshair = 0;
  
  if (templateManager.templatesArray && templateManager.templatesArray.length > 0) {
    // Use templateManager.calculateRemainingPixelsByColor() like the main progress bar does
    const pixelStats = templateManager.calculateRemainingPixelsByColor(0, true); // Only enabled templates
    
    // Get excluded colors from localStorage (same as main progress bar)
    const excludedColors = JSON.parse(localStorage.getItem('bmcf-excluded-colors') || '[]');
    
    for (const [colorKey, stats] of Object.entries(pixelStats)) {
      // Skip excluded colors from mini tracker calculation too
      if (excludedColors.includes(colorKey)) {
        continue;
      }
      
      totalRequired += stats.totalRequired || 0;
      totalPainted += stats.painted || 0;
      totalNeedCrosshair += stats.needsCrosshair || 0;
    }
  }
  
  let progressPercentage;
  if (totalRequired > 0) {
    if (totalPainted === totalRequired) {
      progressPercentage = 100;
    } else {
      const percentage = (totalPainted / totalRequired) * 100;
      progressPercentage = Math.min(Math.round(percentage * 100) / 100, 99.99);
    }
  } else {
    progressPercentage = 0;
  }
  const remaining = totalRequired - totalPainted;
  
  // Create or update tracker
  let tracker = existingTracker;
  if (!tracker) {
    tracker = document.createElement('div');
    tracker.id = 'bm-mini-tracker';
    
    // Find the buttons container to position tracker after it
    const buttonsContainer = document.getElementById('bm-contain-buttons-template');
    const mainOverlay = document.getElementById('bm-overlay');
    
    if (buttonsContainer && mainOverlay) {
      try {
        // Insert tracker after the buttons container but before the status textarea
        const statusTextarea = document.getElementById(overlayMain.outputStatusId);
        if (statusTextarea && statusTextarea.parentNode === mainOverlay) {
          mainOverlay.insertBefore(tracker, statusTextarea);
        } else if (buttonsContainer.parentNode && buttonsContainer.nextSibling) {
          // Fallback: insert after buttons container
          buttonsContainer.parentNode.insertBefore(tracker, buttonsContainer.nextSibling);
        } else {
          // Last resort: append to main overlay
          mainOverlay.appendChild(tracker);
        }
      } catch (error) {
        console.error('Error inserting mini tracker:', error);
        // Try to append as fallback
        try {
          mainOverlay.appendChild(tracker);
        } catch (appendError) {
          console.error('Failed to append mini tracker:', appendError);
        }
      }
    }
  }
  
  // Style the tracker - COMPACT SLATE THEME (responsive to minimized state)
  const isMainMinimizedForStyle = mainOverlay && (mainOverlay.style.width === '60px' || mainOverlay.style.height === '76px' || mainOverlay.style.width === '72px');
  
  tracker.style.cssText = `
    background: linear-gradient(135deg, #1e293b, #334155);
    border: 1px solid #475569;
    border-radius: 12px;
    padding: 12px 16px;
    margin-top: 8px;
    color: #f1f5f9;
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
    width: ${isMainMinimizedForStyle ? '230px' : '100%'};
    font-size: 0.85rem;
    display: grid;
    grid-template-columns: 1fr;
    grid-template-rows: auto auto auto auto;
    grid-gap: 6px;
    letter-spacing: -0.01em;
    box-sizing: border-box;
  `;
  
  // LAYOUT CSS GRID - HTML LIMPO
  if (totalRequired === 0) {
    tracker.innerHTML = `
      <div class="tracker-title">📊 Template Progress: 0%</div>
      <div class="tracker-pixels">0 / 0 pixels painted</div>
      <div class="tracker-progress">
        <div class="tracker-bar" style="width: 0%;"></div>
      </div>
      <div class="tracker-left">0 Pixels Left</div>
    `;
  } else {
    tracker.innerHTML = `
      <div class="tracker-title">📊 Template Progress: ${progressPercentage}%</div>
      <div class="tracker-pixels">${totalPainted.toLocaleString()} / ${totalRequired.toLocaleString()} pixels painted</div>
      <div class="tracker-progress">
        <div class="tracker-bar" style="width: ${progressPercentage}%;"></div>
      </div>
      <div class="tracker-left">${totalNeedCrosshair.toLocaleString()} Pixels Left</div>
    `;
  }
  
  // Aplicar estilos CSS às classes - SLATE THEME COMPACT (fixed styles)
  const style = document.createElement('style');
  style.textContent = `
    .tracker-title {
      font-size: 1rem;
      font-weight: 700;
      grid-row: 1;
      width: 100%;
      text-align: left;
      color: #f1f5f9;
      letter-spacing: -0.02em;
      line-height: 1.2;
    }
    .tracker-pixels {
      font-size: 0.8rem;
      color: #cbd5e1;
      grid-row: 2;
      width: 100%;
      text-align: left;
      font-weight: 500;
      line-height: 1.2;
    }
    .tracker-progress {
      height: 8px;
      background: #475569;
      border-radius: 6px;
      overflow: hidden;
      grid-row: 3;
      width: 100%;
      border: 1px solid #64748b;
      min-width: 0;
    }
    .tracker-bar {
      height: 100%;
      background: linear-gradient(90deg, #3b82f6, #10b981);
      border-radius: 4px;
      transition: width 0.3s ease;
      min-width: 0;
    }
    .tracker-left {
      font-size: 0.8rem;
      color: #fbbf24;
      grid-row: 4;
      width: 100%;
      text-align: left;
      font-weight: 600;
      line-height: 1.2;
    }
  `;
  // Remove existing styles and add updated ones to ensure state changes are reflected
  const existingStyle = document.getElementById('tracker-styles');
  if (existingStyle) {
    existingStyle.remove();
  }
  style.id = 'tracker-styles';
  document.head.appendChild(style);
  
  debugLog(`Mini tracker updated: ${totalPainted}/${totalRequired} (${progressPercentage}%) - ${totalNeedCrosshair} need crosshair`);
  } catch (error) {
    console.error('❌ Error updating mini tracker:', error);
    // Clean up any problematic tracker
    const problemTracker = document.getElementById('bm-mini-tracker');
    if (problemTracker) {
      try {
        problemTracker.remove();
      } catch (removeError) {
        console.error('Failed to remove problematic tracker:', removeError);
      }
    }
  }
}

function createTopProgressBar() {
  const existingBar = document.getElementById('bm-top-progress-bar');
  
  if (!getTopBarEnabled()) {
    if (existingBar) {
      existingBar.remove();
    }
    return;
  }

  if (!templateManager.templatesArray || templateManager.templatesArray.length === 0) {
    if (existingBar) {
      existingBar.remove();
    }
    return;
  }

  let totalRequired = 0;
  let totalPainted = 0;
  
  const pixelStats = templateManager.calculateRemainingPixelsByColor(0, true);
  const excludedColors = JSON.parse(localStorage.getItem('bmcf-excluded-colors') || '[]');
  
  for (const [colorKey, stats] of Object.entries(pixelStats)) {
    if (excludedColors.includes(colorKey)) {
      continue;
    }
    
    totalRequired += stats.totalRequired || 0;
    totalPainted += stats.painted || 0;
  }
  
  let progressPercentage;
  if (totalRequired > 0) {
    if (totalPainted === totalRequired) {
      progressPercentage = '100.00';
    } else {
      const percentage = (totalPainted / totalRequired) * 100;
      progressPercentage = Math.min(percentage, 99.99).toFixed(2);
    }
  } else {
    progressPercentage = '0.00';
  }

  if (existingBar) {
    // Update responsive sizing
    const isSmallScreen = window.innerWidth < 450;
    const barPadding = isSmallScreen ? '6px 12px' : '8px 20px';
    const barGap = isSmallScreen ? '8px' : '12px';
    const barFontSize = isSmallScreen ? '0.75rem' : '0.9rem';
    
    existingBar.style.padding = barPadding;
    existingBar.style.gap = barGap;
    existingBar.style.fontSize = barFontSize;
    
    existingBar.innerHTML = `
      <span style="color: #60a5fa;">${totalPainted.toLocaleString()}</span>
      <span style="color: #94a3b8;">/</span>
      <span style="color: #cbd5e1;">${totalRequired.toLocaleString()}</span>
      <span style="color: #fbbf24;">• ${progressPercentage}%</span>
    `;
    return;
  }

  const topBar = document.createElement('div');
  topBar.id = 'bm-top-progress-bar';
  
  // Responsive sizing
  const isSmallScreen = window.innerWidth < 450;
  const barPadding = isSmallScreen ? '6px 12px' : '8px 20px';
  const barGap = isSmallScreen ? '8px' : '12px';
  const barFontSize = isSmallScreen ? '0.75rem' : '0.9rem';
  
  topBar.style.cssText = `
    position: fixed;
    top: 5px;
    left: 50%;
    transform: translateX(-50%);
    background: linear-gradient(135deg, #1e293b, #334155);
    border: 1px solid #475569;
    border-radius: 12px;
    padding: ${barPadding};
    color: #f1f5f9;
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
    z-index: 9999;
    display: flex;
    align-items: center;
    gap: ${barGap};
    font-size: ${barFontSize};
    font-weight: 600;
    letter-spacing: -0.01em;
    user-select: none;
    max-width: 95vw;
    white-space: nowrap;
    overflow: hidden;
  `;

  topBar.innerHTML = `
    <span style="color: #60a5fa;">${totalPainted.toLocaleString()}</span>
    <span style="color: #94a3b8;">/</span>
    <span style="color: #cbd5e1;">${totalRequired.toLocaleString()}</span>
    <span style="color: #fbbf24;">• ${progressPercentage}%</span>
  `;

  document.body.appendChild(topBar);
}

// Recreate top bar on window resize for responsive sizing
let topBarResizeTimeout = null;
window.addEventListener('resize', () => {
  if (!getTopBarEnabled()) return;
  
  clearTimeout(topBarResizeTimeout);
  topBarResizeTimeout = setTimeout(() => {
    createTopProgressBar();
  }, 250);
});

// Auto-update mini tracker every 5 seconds if enabled
let miniTrackerAutoUpdateInterval = null;

function startMiniTrackerAutoUpdate() {
  // Clear existing interval if any
  if (miniTrackerAutoUpdateInterval) {
    clearInterval(miniTrackerAutoUpdateInterval);
  }
  
  // Only start auto-update if mini tracker is enabled
  if (getMiniTrackerEnabled()) {
    miniTrackerAutoUpdateInterval = setInterval(() => {
      const isStillEnabled = getMiniTrackerEnabled();
      if (isStillEnabled) {
        updateMiniTracker();
        debugLog('Mini tracker auto-updated');
      } else {
        // Stop auto-update if disabled
        clearInterval(miniTrackerAutoUpdateInterval);
        miniTrackerAutoUpdateInterval = null;
        debugLog('Mini tracker auto-update stopped (disabled)');
      }
    }, 5000); // Update every 5 seconds
    
    debugLog('Mini tracker auto-update started (every 5 seconds)');
  }
}

// Auto-update top bar every 5 seconds if enabled
let topBarAutoUpdateInterval = null;

function startTopBarAutoUpdate() {
  if (topBarAutoUpdateInterval) {
    clearInterval(topBarAutoUpdateInterval);
  }
  
  if (getTopBarEnabled()) {
    topBarAutoUpdateInterval = setInterval(() => {
      const isStillEnabled = getTopBarEnabled();
      if (isStillEnabled) {
        createTopProgressBar();
        debugLog('Top bar auto-updated');
      } else {
        clearInterval(topBarAutoUpdateInterval);
        topBarAutoUpdateInterval = null;
        debugLog('Top bar auto-update stopped (disabled)');
      }
    }, 5000);
    
    debugLog('Top bar auto-update started (every 5 seconds)');
  }
}

// Auto-update left badges independently of mini tracker
let leftBadgesAutoUpdateInterval = null;

function updateLeftBadgesOnly() {
  // Only update if the setting is enabled
  if (!getShowLeftOnColorEnabled()) return;
  
  // Check if templates are available
  if (!templateManager.templatesArray || templateManager.templatesArray.length === 0) return;
  
  try {
    // Calculate pixel statistics
    const pixelStats = templateManager.calculateRemainingPixelsByColor(0, true); // Only enabled templates
    
    // Update the palette badges
    updatePaletteLeftBadges(pixelStats);
    
    debugLog('Left badges auto-updated independently');
  } catch (error) {
    console.warn('Failed to auto-update left badges:', error);
  }
}

function startLeftBadgesAutoUpdate() {
  // Clear existing interval if any
  if (leftBadgesAutoUpdateInterval) {
    clearInterval(leftBadgesAutoUpdateInterval);
  }
  
  // Only start auto-update if left badges are enabled
  if (getShowLeftOnColorEnabled()) {
    leftBadgesAutoUpdateInterval = setInterval(() => {
      const isStillEnabled = getShowLeftOnColorEnabled();
      if (isStillEnabled) {
        updateLeftBadgesOnly();
      } else {
        // Stop auto-update if disabled
        clearInterval(leftBadgesAutoUpdateInterval);
        leftBadgesAutoUpdateInterval = null;
        debugLog('Left badges auto-update stopped (disabled)');
      }
    }, 5000); // Update every 5 seconds
    
    debugLog('Left badges auto-update started (every 5 seconds)');
  }
}

// Auto-update Color Menu (main template color list) every 5 seconds if visible
let colorMenuAutoUpdateInterval = null;

function startColorMenuAutoUpdate() {
  // Clear existing interval if any
  if (colorMenuAutoUpdateInterval) {
    clearInterval(colorMenuAutoUpdateInterval);
  }
  
  colorMenuAutoUpdateInterval = setInterval(() => {
    const colorMenu = document.getElementById('bm-color-menu');
    const colorList = document.getElementById('bm-color-list');
    
    if (skipNextColorMenuUpdate) {
      debugLog('🎨 Color Menu auto-update skipped (manual change in progress)');
      return;
    }
    
    if (colorMenu && colorList && 
        colorMenu.style.display !== 'none' && 
        colorMenu.offsetParent !== null &&
        templateManager?.templatesArray?.length > 0) {
      
      updateColorMenuNumbers();
      debugLog('🎨 Color Menu numbers auto-updated');
    }
  }, 5000);
  
  debugLog('🎨 Color Menu auto-update started');
}

// Auto-update compact list every 5 seconds if visible
let compactListAutoUpdateInterval = null;

function startCompactListAutoUpdate() {
  // Clear existing interval if any
  if (compactListAutoUpdateInterval) {
    clearInterval(compactListAutoUpdateInterval);
  }
  
  // Start auto-update interval
  compactListAutoUpdateInterval = setInterval(() => {
    const existingCompactList = document.getElementById('bmcf-compact-list');
    if (existingCompactList && existingCompactList.style.display !== 'none') {
      // Only update if the list is visible
      if (window.updateCompactListData) {
        window.updateCompactListData(existingCompactList);
        debugLog('📌 Compact list auto-updated');
      }
    }
  }, 5000); // Update every 5 seconds
  
  debugLog('📌 Compact list auto-update started (every 5 seconds)');
}

// Start auto-update when page loads
setTimeout(() => {
  startMiniTrackerAutoUpdate();
  startTopBarAutoUpdate();
  startLeftBadgesAutoUpdate();
  startColorMenuAutoUpdate();
  startCompactListAutoUpdate();
  createTopProgressBar();
  
  // Pin functionality removed - Color Toggle is now just a simple toggle without persistence
}, 2000); // Start after 2 seconds to let everything initialize

/** Apply header visibility based on localStorage setting
 * @param {string} key - localStorage key (bmShowInformationHeader or bmShowTemplateHeader)
 * @param {boolean} visible - Whether the header should be visible
 * @since 1.0.0
 */
function applyHeaderVisibility(key, visible) {
  try {
    const separators = document.querySelectorAll('[id="bm-separator"]');
    
    separators.forEach((separator) => {
      const separatorText = separator.querySelector('#bm-separator-text p');
      if (separatorText) {
        const text = separatorText.textContent.trim();
        
        if (key === 'bmShowInformationHeader' && text === 'Information') {
          separator.style.display = visible ? '' : 'none';
        } else if (key === 'bmShowTemplateHeader' && text === 'Template') {
          separator.style.display = visible ? '' : 'none';
        }
      }
    });
    
  } catch (error) {
    console.error('Failed to apply header visibility:', error);
  }
}


/** Apply all stored overlay settings (fallback function for manual use)
 * @since 1.0.0
 */
function applyStoredOverlaySettings() {
  try {
    // Read settings from localStorage
    const showInfoHeader = JSON.parse(localStorage.getItem('bmShowInformationHeader') ?? 'true');
    const showTemplateHeader = JSON.parse(localStorage.getItem('bmShowTemplateHeader') ?? 'true');
    const showColorMenu = JSON.parse(localStorage.getItem('bmShowColorMenu') ?? 'false'); // Default: disabled (Beta)
    
    // Apply header visibility (fallback - usually handled during creation)
    applyHeaderVisibility('bmShowInformationHeader', showInfoHeader);
    applyHeaderVisibility('bmShowTemplateHeader', showTemplateHeader);
    
    // Apply color menu visibility
    const colorMenu = document.getElementById('bm-color-menu');
    if (colorMenu) {
      colorMenu.style.display = showColorMenu ? '' : 'none';
    }
    
  } catch (error) {
    console.error('Failed to apply stored overlay settings:', error);
  }
}



/** Manual test function for overlay settings (console only)
 * @since 1.0.0
 */
window.testOverlaySettings = () => applyStoredOverlaySettings();

// Cache for color menu data to prevent unnecessary updates
let colorMenuCache = {
  templateId: null,
  colorsData: null,
  enhancedColors: null,
  disabledColors: null,
  enabledTemplates: null
};

// Flag to prevent auto-update right after manual checkbox changes
let skipNextColorMenuUpdate = false;

/** Check if color data has changed since last update
 * @returns {boolean} True if data has changed
 * @since 1.0.0
 */
function hasColorDataChanged() {
  const currentTemplate = templateManager?.templatesArray?.[0];
  
  if (!currentTemplate) {
    // If no template now but had one before, data changed
    const hasChanged = colorMenuCache.templateId !== null;
    if (hasChanged) {
      // Clear cache when template is removed
      clearColorMenuCache();
    }
    return hasChanged;
  }
  
  const currentTemplateId = `${currentTemplate.sortID}_${currentTemplate.authorID}`;
  const currentEnhanced = Array.from(currentTemplate.enhancedColors || []).sort().join(',');
  const currentDisabled = (currentTemplate.getDisabledColors?.() || []).sort().join(',');
  
  const enabledTemplates = [];
  if (templateManager.templatesArray) {
    for (const template of templateManager.templatesArray) {
      const templateKey = `${template.sortID} ${template.authorID}`;
      if (templateManager.isTemplateEnabled(templateKey)) {
        enabledTemplates.push(templateKey);
      }
    }
  }
  const currentEnabledTemplates = enabledTemplates.sort().join('|');
  
  const hasChanged = 
    colorMenuCache.templateId === null ||
    colorMenuCache.templateId !== currentTemplateId ||
    colorMenuCache.enhancedColors !== currentEnhanced ||
    colorMenuCache.disabledColors !== currentDisabled ||
    colorMenuCache.enabledTemplates !== currentEnabledTemplates; 
  
  return hasChanged;
}

/** Update color menu cache with current data
 * @since 1.0.0
 */
function updateColorMenuCache() {
  const currentTemplate = templateManager?.templatesArray?.[0];
  
  if (!currentTemplate) {
    clearColorMenuCache();
    return;
  }
  
  const currentTemplateId = `${currentTemplate.sortID}_${currentTemplate.authorID}`;
  const currentEnhanced = Array.from(currentTemplate.enhancedColors || []).sort().join(',');
  const currentDisabled = (currentTemplate.getDisabledColors?.() || []).sort().join(',');
  
  const enabledTemplates = [];
  if (templateManager.templatesArray) {
    for (const template of templateManager.templatesArray) {
      const templateKey = `${template.sortID} ${template.authorID}`;
      if (templateManager.isTemplateEnabled(templateKey)) {
        enabledTemplates.push(templateKey);
      }
    }
  }
  const currentEnabledTemplates = enabledTemplates.sort().join('|');
  
  colorMenuCache.templateId = currentTemplateId;
  colorMenuCache.enhancedColors = currentEnhanced;
  colorMenuCache.disabledColors = currentDisabled;
  colorMenuCache.enabledTemplates = currentEnabledTemplates;
}

/** Clear color menu cache to force next update
 * @since 1.0.0
 */
function clearColorMenuCache() {
  colorMenuCache = {
    templateId: null,
    colorsData: null,
    enhancedColors: null,
    disabledColors: null,
    enabledTemplates: null
  };
}

/** Update ONLY the numbers in existing color menu items (lightweight, no DOM recreation)
 * This prevents the "jumping" effect during auto-updates
 * @since 1.0.0
 */
function updateColorMenuNumbers() {
  const colorList = document.getElementById('bm-color-list');
  if (!colorList) return;
  
  // Get fresh pixel statistics
  const pixelStats = templateManager?.calculateRemainingPixelsByColor?.(0, true);
  if (!pixelStats) return;
  
  // Update each existing item's numbers only
  const items = colorList.querySelectorAll('.bm-color-item');
  items.forEach(item => {
    const colorName = item.getAttribute('data-name');
    if (!colorName) return;
    
    // Find color in palette to get RGB key
    import('./utils.js').then(utils => {
      const colorInfo = utils.colorpalette.find(c => c.name.toLowerCase() === colorName);
      if (!colorInfo) return;
      
      const colorKey = `${colorInfo.rgb[0]},${colorInfo.rgb[1]},${colorInfo.rgb[2]}`;
      const stats = pixelStats[colorKey] || {};
      
      const painted = stats.painted || 0;
      const remaining = stats.needsCrosshair || 0;
      const totalPixels = painted + remaining;
      const percentage = totalPixels > 0 ? Math.round((painted / totalPixels) * 100) : 0;
      
      // Update data attributes (for sorting to work correctly)
      item.setAttribute('data-painted', painted);
      item.setAttribute('data-total', totalPixels);
      item.setAttribute('data-left', remaining);
      item.setAttribute('data-percentage', percentage);
      
      // Update the text content (find the info div and update innerHTML)
      const infoDiv = item.querySelector('div[style*="flex: 1"]');
      if (infoDiv) {
        const isPremium = colorInfo.free === false;
        infoDiv.innerHTML = `
          <div style="color: white; font-weight: 500; line-height: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; padding-right: ${isPremium ? '18px' : '0'};">
            ${colorInfo.name} <span style="color: #888;">${painted} / ${totalPixels}</span> <span style="color: #888;">(${percentage}%)</span> <span style="color: #ff8c42; font-weight: bold;">${remaining.toLocaleString()}</span>
          </div>
          ${isPremium ? '<span style="position: absolute; right: 0; top: 50%; transform: translateY(-50%); font-size: 10px; opacity: 0.7;">💧</span>' : ''}
        `;
      }
    }).catch(() => {
      // Silently fail if utils can't be loaded
    });
  });
}

/** Update the color menu display with current template colors
 * @param {boolean} resetFilters - Whether to reset search and sort filters
 * @param {boolean} forceUpdate - Force update even if data hasn't changed
 * @since 1.0.0
 */
function updateColorMenuDisplay(resetFilters = true, forceUpdate = false) {
  const colorList = document.getElementById('bm-color-list');
  if (!colorList) return;
  
  // Skip update if data hasn't changed (unless forced)
  const dataChanged = hasColorDataChanged();
  if (!forceUpdate && !dataChanged) {
    return;
  }
  
  // Clear existing content
  colorList.innerHTML = '';
  
  // Get current template (use global templateManager like color filter does)
  const currentTemplate = templateManager?.templatesArray?.[0];
  
  if (!currentTemplate) {
    colorList.innerHTML = '<p style="margin: 0; color: #888; text-align: center;">No template loaded</p>';
    return;
  }
  
  import('./utils.js').then(utils => {
    const colorPalette = utils.colorpalette;
    
    debugLog('[Color Menu] Template Manager:', templateManager);
    debugLog('[Color Menu] Current Template:', currentTemplate);
    debugLog('[Color Menu] Color Palette Length:', colorPalette?.length);
    
    const pixelStats = templateManager.calculateRemainingPixelsByColor(0, true);
    debugLog('[Color Menu] Pixel statistics received:', pixelStats);
    debugLog('[Color Menu] Pixel stats keys:', pixelStats ? Object.keys(pixelStats) : 'null');
    
    const disabledColors = new Set(currentTemplate.getDisabledColors?.() || []);
    const enhancedColors = currentTemplate.enhancedColors || new Set();
    
    debugLog('[Color Menu] Disabled colors:', disabledColors.size);
    debugLog('[Color Menu] Enhanced colors:', enhancedColors.size);
    
    let colorsAdded = 0;
    
    let colorIndex = 0;
    colorPalette.forEach((colorInfo, index) => {
      if (index === 0) return;
      
      const colorKey = `${colorInfo.rgb[0]},${colorInfo.rgb[1]},${colorInfo.rgb[2]}`;
      const stats = pixelStats[colorKey] || {};
      
      debugLog(`[Color Menu] Processing color ${colorInfo.name} (${colorKey}):`, stats);
      
      const painted = stats.painted || 0;
      const remaining = stats.needsCrosshair || 0;
      const totalPixels = painted + remaining;
      
      if (totalPixels <= 0) {
        debugLog(`[Color Menu] Skipping ${colorInfo.name} - totalPixels <= 0`);
        return;
      }
      
      colorsAdded++;
      debugLog(`[Color Menu] Adding color ${colorInfo.name} to menu`);
      
      const [r, g, b] = colorInfo.rgb;
      const isDisabled = disabledColors.has(colorKey);
      const isEnhanced = enhancedColors.has(colorKey);
      
      const colorItem = document.createElement('div');
      colorItem.className = 'bm-color-item';
      colorItem.setAttribute('data-original-index', colorIndex++);
      
      const left = remaining;
      const total = totalPixels;
      const percentage = total > 0 ? Math.round((painted / total) * 100) : 0;
      const isPremium = colorInfo.free === false;
      
      colorItem.setAttribute('data-name', colorInfo.name.toLowerCase());
      colorItem.setAttribute('data-painted', painted);
      colorItem.setAttribute('data-total', total);
      colorItem.setAttribute('data-left', left);
      colorItem.setAttribute('data-percentage', percentage);
      colorItem.setAttribute('data-enhanced', isEnhanced ? '1' : '0');
      colorItem.setAttribute('data-disabled', isDisabled ? '1' : '0');
      colorItem.setAttribute('data-premium', isPremium ? '1' : '0');
      
      colorItem.style.cssText = `
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 6px 8px;
        border-radius: 4px;
        border: 1px solid rgba(255, 255, 255, 0.1);
        background: rgba(255, 255, 255, 0.05);
        font-size: 11px;
        line-height: 1.3;
        min-height: 28px;
        transition: all 0.2s;
        ${isDisabled ? 'opacity: 0.5;' : ''}
      `;
      
      // Enhanced checkbox
      const enhancedCheckbox = document.createElement('input');
      enhancedCheckbox.type = 'checkbox';
      enhancedCheckbox.checked = isEnhanced;
      enhancedCheckbox.style.cssText = `
        width: 16px;
        height: 16px;
        cursor: pointer;
        accent-color: gold;
        flex-shrink: 0;
      `;
      
      enhancedCheckbox.onchange = (e) => {
        e.stopPropagation();
        
        if (enhancedCheckbox.checked) {
          currentTemplate.enhancedColors.add(colorKey);
        } else {
          currentTemplate.enhancedColors.delete(colorKey);
        }
        
        invalidateTemplateCache();
        templateManager.updateTemplateWithColorFilter(0);
        
        colorItem.setAttribute('data-enhanced', enhancedCheckbox.checked ? '1' : '0');
        
        if (colorMenuCache.templateId) {
          const newEnhanced = Array.from(currentTemplate.enhancedColors || []).sort().join(',');
          colorMenuCache.enhancedColors = newEnhanced;
        }
        
        skipNextColorMenuUpdate = true;
        setTimeout(() => {
          skipNextColorMenuUpdate = false;
        }, 2000);
      };
      
      // Color swatch (aumentado de 12px para 16px)
      const swatch = document.createElement('div');
      swatch.style.cssText = `
        width: 16px;
        height: 16px;
        border-radius: 2px;
        background: rgb(${r}, ${g}, ${b});
        border: 1px solid rgba(255, 255, 255, 0.2);
        flex-shrink: 0;
        cursor: pointer;
      `;
      
      // Color info - número laranja movido para DEPOIS da porcentagem
      const info = document.createElement('div');
      info.style.cssText = 'flex: 1; overflow: hidden; cursor: pointer; min-width: 0; position: relative;';
      
      info.innerHTML = `
        <div style="color: white; font-weight: 500; line-height: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; padding-right: ${isPremium ? '18px' : '0'};">
          ${colorInfo.name} <span style="color: #888;">${painted} / ${total}</span> <span style="color: #888;">(${percentage}%)</span> <span style="color: #ff8c42; font-weight: bold;">${left.toLocaleString()}</span>
        </div>
        ${isPremium ? '<span style="position: absolute; right: 0; top: 50%; transform: translateY(-50%); font-size: 10px; opacity: 0.7;">💧</span>' : ''}
      `;
      
      // Click handler to toggle color enable/disable (on swatch and info)
      const toggleColor = (e) => {
        e.stopPropagation();
        
        // Check current disabled state
        const currentlyDisabled = colorItem.getAttribute('data-disabled') === '1';
        const newDisabled = !currentlyDisabled;
        
        if (currentlyDisabled) {
          currentTemplate.enableColor?.([r, g, b]);
        } else {
          currentTemplate.disableColor?.([r, g, b]);
        }
        
        colorItem.style.opacity = newDisabled ? '0.5' : '1';
        colorItem.setAttribute('data-disabled', newDisabled ? '1' : '0');
        
        invalidateTemplateCache();
        templateManager.updateTemplateWithColorFilter(0);
        
        if (colorMenuCache.templateId) {
          const newDisabledColors = (currentTemplate.getDisabledColors?.() || []).sort().join(',');
          colorMenuCache.disabledColors = newDisabledColors;
        }
        
        skipNextColorMenuUpdate = true;
        setTimeout(() => {
          skipNextColorMenuUpdate = false;
        }, 2000);
      };
      
      swatch.onclick = toggleColor;
      info.onclick = toggleColor;
      
      colorItem.appendChild(enhancedCheckbox);
      colorItem.appendChild(swatch);
      colorItem.appendChild(info);
      colorList.appendChild(colorItem);
    });
    
    debugLog(`[Color Menu] Processing complete. Colors added: ${colorsAdded}`);
    debugLog(`[Color Menu] Color list children count: ${colorList.children.length}`);
    
    // If no colors were added, show message
    if (colorList.children.length === 0) {
      debugLog('[Color Menu] No colors in DOM - showing "no colors available" message');
      colorList.innerHTML = '<p style="margin: 0; color: #888; text-align: center;">No template colors available</p>';
      return;
    }
    
    debugLog('[Color Menu] Setting up filters and updating cache');
    
    // Setup search and sort functionality
    setupColorMenuFilters(resetFilters);
    
    // Update cache after successful display update
    updateColorMenuCache();
    
  }).catch(error => {
    console.error('[Color Menu] Failed to load utils:', error);
    colorList.innerHTML = '<p style="margin: 0; color: #f88; text-align: center;">Error loading colors</p>';
  });
}

/** Initialize resize functionality for color menu list
 * @since 1.0.0
 */
function initColorMenuResize() {
  const resizeHandle = document.getElementById('bm-color-menu-resize-handle');
  const colorList = document.getElementById('bm-color-list');
  
  if (!resizeHandle || !colorList) return;
  
  let isResizing = false;
  let startY = 0;
  let startHeight = 0;
  
  // Load saved height from localStorage
  const savedHeight = localStorage.getItem('bmColorMenuHeight');
  if (savedHeight) {
    colorList.style.maxHeight = savedHeight + 'px';
  }
  
  const onMouseDown = (e) => {
    isResizing = true;
    startY = e.clientY;
    startHeight = colorList.offsetHeight;
    
    // Visual feedback
    resizeHandle.style.background = 'rgba(59, 130, 246, 0.3)';
    document.body.style.cursor = 'ns-resize';
    document.body.style.userSelect = 'none';
    
    e.preventDefault();
    e.stopPropagation();
  };
  
  const onMouseMove = (e) => {
    if (!isResizing) return;
    
    const delta = e.clientY - startY;
    const newHeight = Math.max(60, Math.min(400, startHeight + delta));
    
    colorList.style.maxHeight = newHeight + 'px';
    
    e.preventDefault();
    e.stopPropagation();
  };
  
  const onMouseUp = () => {
    if (!isResizing) return;
    
    isResizing = false;
    
    // Reset visual feedback
    resizeHandle.style.background = 'rgba(255, 255, 255, 0.05)';
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    
    // Save height to localStorage
    const currentHeight = colorList.offsetHeight;
    localStorage.setItem('bmColorMenuHeight', currentHeight);
  };
  
  // Touch events for mobile
  const onTouchStart = (e) => {
    isResizing = true;
    startY = e.touches[0].clientY;
    startHeight = colorList.offsetHeight;
    
    // Visual feedback
    resizeHandle.style.background = 'rgba(59, 130, 246, 0.3)';
    
    e.preventDefault();
    e.stopPropagation();
  };
  
  const onTouchMove = (e) => {
    if (!isResizing) return;
    
    const delta = e.touches[0].clientY - startY;
    const newHeight = Math.max(60, Math.min(400, startHeight + delta));
    
    colorList.style.maxHeight = newHeight + 'px';
    
    e.preventDefault();
    e.stopPropagation();
  };
  
  const onTouchEnd = () => {
    if (!isResizing) return;
    
    isResizing = false;
    
    // Reset visual feedback
    resizeHandle.style.background = 'rgba(255, 255, 255, 0.05)';
    
    // Save height to localStorage
    const currentHeight = colorList.offsetHeight;
    localStorage.setItem('bmColorMenuHeight', currentHeight);
  };
  
  // Hover effect
  resizeHandle.addEventListener('mouseenter', () => {
    if (!isResizing) {
      resizeHandle.style.background = 'rgba(255, 255, 255, 0.1)';
    }
  });
  
  resizeHandle.addEventListener('mouseleave', () => {
    if (!isResizing) {
      resizeHandle.style.background = 'rgba(255, 255, 255, 0.05)';
    }
  });
  
  // Attach mouse event listeners
  resizeHandle.addEventListener('mousedown', onMouseDown);
  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('mouseup', onMouseUp);
  
  // Attach touch event listeners for mobile
  resizeHandle.addEventListener('touchstart', onTouchStart, { passive: false });
  document.addEventListener('touchmove', onTouchMove, { passive: false });
  document.addEventListener('touchend', onTouchEnd);
  
  debugLog('[Color Menu] Resize functionality initialized (mouse + touch)');
}

/** Setup search and sort functionality for color menu
 * @param {boolean} resetFilters - Whether to reset filters
 * @since 1.0.0
 */
function setupColorMenuFilters(resetFilters) {
  const searchInput = document.getElementById('bm-color-search');
  const sortSelect = document.getElementById('bm-color-sort');
  const colorList = document.getElementById('bm-color-list');
  
  if (!searchInput || !sortSelect || !colorList) return;
  
  if (!searchInput._bmKeyboardListenersAdded) {
    searchInput.addEventListener('keydown', (e) => {
      e.stopPropagation();
    });
    searchInput.addEventListener('keyup', (e) => {
      e.stopPropagation();
    });
    searchInput.addEventListener('keypress', (e) => {
      e.stopPropagation();
    });
    searchInput._bmKeyboardListenersAdded = true;
  }
  
  // Clear existing listeners and data to prevent duplicates
  const existingListener = searchInput._bmColorMenuListener;
  const existingSortListener = sortSelect._bmColorMenuListener;
  
  if (existingListener) {
    searchInput.removeEventListener('input', existingListener);
    delete searchInput._bmColorMenuListener;
  }
  
  if (existingSortListener) {
    sortSelect.removeEventListener('change', existingSortListener);
    delete sortSelect._bmColorMenuListener;
  }
  
  // Setup toggle all button
  const toggleAllBtn = document.getElementById('bm-color-toggle-all');
  if (toggleAllBtn && !toggleAllBtn._bmToggleListenerAdded) {
    toggleAllBtn.addEventListener('click', () => {
      const currentTemplate = templateManager?.templatesArray?.[0];
      if (!currentTemplate) return;
      
      const items = Array.from(colorList.querySelectorAll('.bm-color-item'));
      if (items.length === 0) return;
      
      const allDisabled = items.every(item => item.getAttribute('data-disabled') === '1');
      
      items.forEach(item => {
        const swatch = item.querySelector('div[style*="background: rgb"]');
        if (!swatch) return;
        
        const rgbMatch = swatch.style.background.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
        if (!rgbMatch) return;
        
        const rgb = [parseInt(rgbMatch[1]), parseInt(rgbMatch[2]), parseInt(rgbMatch[3])];
        
        if (allDisabled) {
          currentTemplate.enableColor?.(rgb);
          item.style.opacity = '1';
          item.setAttribute('data-disabled', '0');
        } else {
          currentTemplate.disableColor?.(rgb);
          item.style.opacity = '0.5';
          item.setAttribute('data-disabled', '1');
        }
      });
      
      invalidateTemplateCache();
      templateManager.updateTemplateWithColorFilter(0);
      
      if (colorMenuCache.templateId) {
        const newDisabledColors = (currentTemplate.getDisabledColors?.() || []).sort().join(',');
        colorMenuCache.disabledColors = newDisabledColors;
      }
      
      skipNextColorMenuUpdate = true;
      setTimeout(() => {
        skipNextColorMenuUpdate = false;
      }, 2000);
    });
    toggleAllBtn._bmToggleListenerAdded = true;
  }
  
  // Reset filters if requested (but preserve current values if user is actively using them)
  if (resetFilters) {
    // Only reset if inputs are not currently focused or have user input
    if (!searchInput.matches(':focus') && searchInput.value === '') {
      searchInput.value = '';
    }
    if (!sortSelect.matches(':focus') && sortSelect.value === 'default') {
      sortSelect.value = 'default';
    }
  }
  
  // Get current items (fresh list each time)
  const getItems = () => Array.from(colorList.querySelectorAll('.bm-color-item'));
  
  // Store original order only once
  const items = getItems();
  items.forEach((item, index) => {
    if (!item.hasAttribute('data-original-index')) {
      item.setAttribute('data-original-index', index);
    }
  });
  
  // Filter and sort function
  const filterAndSort = () => {
    // Get fresh items list each time to avoid stale references
    const currentItems = getItems();
    const searchTerm = searchInput.value.toLowerCase().trim();
    const sortBy = sortSelect.value;
    
    // Clear previous no-results messages
    const existingNoResults = colorList.querySelector('.bm-no-results');
    if (existingNoResults) {
      existingNoResults.remove();
    }
    
    let filteredItems = currentItems.filter(item => {
      const name = item.getAttribute('data-name') || '';
      const enhanced = item.getAttribute('data-enhanced') === '1';
      
      // Search filter
      const matchesSearch = !searchTerm || name.includes(searchTerm);
      
      // Enhanced filter
      const matchesSort = sortBy !== 'enhanced' || enhanced;
      
      return matchesSearch && matchesSort;
    });
    
    // Sort items
    filteredItems.sort((a, b) => {
      if (!sortBy || sortBy === 'default') {
        return parseInt(a.getAttribute('data-original-index') || '0') - parseInt(b.getAttribute('data-original-index') || '0');
      }
      
      switch (sortBy) {
        case 'premium': {
          const aIsPremium = a.getAttribute('data-premium') === '1';
          const bIsPremium = b.getAttribute('data-premium') === '1';
          if (aIsPremium && !bIsPremium) return -1;
          if (!aIsPremium && bIsPremium) return 1;
          return parseInt(b.getAttribute('data-left') || '0') - parseInt(a.getAttribute('data-left') || '0');
        }
        case 'most-wrong': {
          const aWrong = parseInt(a.getAttribute('data-total') || '0') - parseInt(a.getAttribute('data-painted') || '0');
          const bWrong = parseInt(b.getAttribute('data-total') || '0') - parseInt(b.getAttribute('data-painted') || '0');
          return bWrong - aWrong;
        }
        case 'most-missing':
          return parseInt(b.getAttribute('data-left') || '0') - parseInt(a.getAttribute('data-left') || '0');
        case 'less-missing':
          return parseInt(a.getAttribute('data-left') || '0') - parseInt(b.getAttribute('data-left') || '0');
        case 'most-painted':
          return parseInt(b.getAttribute('data-painted') || '0') - parseInt(a.getAttribute('data-painted') || '0');
        case 'less-painted':
          return parseInt(a.getAttribute('data-painted') || '0') - parseInt(b.getAttribute('data-painted') || '0');
        case 'name-asc':
          return (a.getAttribute('data-name') || '').localeCompare(b.getAttribute('data-name') || '');
        case 'name-desc':
          return (b.getAttribute('data-name') || '').localeCompare(a.getAttribute('data-name') || '');
        default:
          return parseInt(a.getAttribute('data-original-index') || '0') - parseInt(b.getAttribute('data-original-index') || '0');
      }
    });
    
    // Hide all items first
    currentItems.forEach(item => {
      item.style.display = 'none';
    });
    
    // Show and reorder filtered items
    if (filteredItems.length > 0) {
      filteredItems.forEach(item => {
        item.style.display = 'flex';
        colorList.appendChild(item);
      });
    } else {
      // Show "no results" message
      const noResults = document.createElement('p');
      noResults.className = 'bm-no-results';
      noResults.style.cssText = 'margin: 8px 0; color: #888; text-align: center; font-size: 10px;';
      noResults.textContent = searchTerm ? 'No colors match your search' : 'No colors available';
      colorList.appendChild(noResults);
    }
  };
  
  // Store listeners on elements to track them
  searchInput._bmColorMenuListener = filterAndSort;
  sortSelect._bmColorMenuListener = filterAndSort;
  
  // Add event listeners
  searchInput.addEventListener('input', filterAndSort);
  sortSelect.addEventListener('change', filterAndSort);
  
  // Apply current filters
  setTimeout(filterAndSort, 50); // Small delay to ensure DOM is ready
}

// Initialize color menu when template is loaded
window.addEventListener('message', (event) => {
  if (event.data?.source === 'template-loaded' || event.data?.source === 'template-changed') {
    clearColorMenuCache();
    setTimeout(() => updateColorMenuDisplay(true, true), 500);
  }
});

// Update color menu when overlay is shown and periodically
const originalShowOverlay = window.showOverlay;
if (originalShowOverlay) {
  window.showOverlay = function(...args) {
    const result = originalShowOverlay.apply(this, args);
    setTimeout(() => updateColorMenuDisplay(false), 200); // Don't reset filters when showing overlay
    return result;
  };
}

window.updateColorMenuDisplay = updateColorMenuDisplay;
window.clearColorMenuCache = clearColorMenuCache;
window.updateColorMenuCache = updateColorMenuCache;


/** Builds and displays the crosshair settings overlay
 * @since 1.0.0
 */
function buildCrosshairSettingsOverlay() {
  try {
    // Ensure Slate theme CSS variables are available globally
    if (!document.getElementById('bm-settings-styles')) {
      const crosshairStyles = document.createElement('style');
      crosshairStyles.id = 'bm-settings-styles';
      crosshairStyles.textContent = `
        :root { 
          --slate-50: #f8fafc; --slate-100: #f1f5f9; --slate-200: #e2e8f0; --slate-300: #cbd5e1; 
          --slate-400: #94a3b8; --slate-500: #64748b; --slate-600: #475569; --slate-700: #334155; 
          --slate-750: #293548; --slate-800: #1e293b; --slate-900: #0f172a; --slate-950: #020617;
          --blue-400: #60a5fa; --blue-500: #3b82f6; --blue-600: #2563eb; --blue-700: #1d4ed8;
          --emerald-400: #34d399; --emerald-500: #10b981; --emerald-600: #059669; --emerald-700: #047857;
          --bmcf-bg: var(--slate-900); --bmcf-card: var(--slate-800); --bmcf-border: var(--slate-700); 
          --bmcf-muted: var(--slate-400); --bmcf-text: var(--slate-100); --bmcf-text-muted: var(--slate-300);
        }
        
        @keyframes gradientShift {
          0% { background-position: 0% 50%; }
          50% { background-position: 100% 50%; }
          100% { background-position: 0% 50%; }
        }
        
        /* Custom RGB input placeholder styling */
        .bm-custom-rgb-input::placeholder {
          text-align: center !important;
          color: var(--slate-400) !important;
          font-weight: 600 !important;
          opacity: 1 !important;
        }
        
        .bm-custom-rgb-input::-webkit-input-placeholder {
          text-align: center !important;
          color: var(--slate-400) !important;
          font-weight: 600 !important;
        }
        
        .bm-custom-rgb-input::-moz-placeholder {
          text-align: center !important;
          color: var(--slate-400) !important;
          font-weight: 600 !important;
          opacity: 1 !important;
        }
        
        .bm-custom-rgb-input:-ms-input-placeholder {
          text-align: center !important;
          color: var(--slate-400) !important;
          font-weight: 600 !important;
        }
      `;
      document.head.appendChild(crosshairStyles);
    }

    // Remove existing settings overlay if it exists
    const existingOverlay = document.getElementById('bm-crosshair-settings-overlay');
    if (existingOverlay) {
      existingOverlay.remove();
    }

    // Predefined color options - declare first
    const colorOptions = [
      { name: 'Red', rgb: [255, 0, 0], alpha: 255 },
      { name: 'Blue', rgb: [64, 147, 228], alpha: 255 },
      { name: 'Green', rgb: [0, 255, 0], alpha: 255 },
      { name: 'Purple', rgb: [170, 56, 185], alpha: 255 },
      { name: 'Yellow', rgb: [249, 221, 59], alpha: 255 },
      { name: 'Orange', rgb: [255, 127, 39], alpha: 255 },
      { name: 'Cyan', rgb: [96, 247, 242], alpha: 255 },
      { name: 'Pink', rgb: [236, 31, 128], alpha: 255 },
      { name: 'Custom', rgb: [255, 255, 255], alpha: 255, isCustom: true }
    ];

    // Get current crosshair color
    const currentColor = getCrosshairColor();
    
    // Track temporary settings (before confirm)
    let tempColor = { ...currentColor };
    
    // If current color is custom, ensure it has the isCustom flag
    if (!tempColor.isCustom && !colorOptions.filter(c => !c.isCustom).some(predefined => 
        JSON.stringify(predefined.rgb) === JSON.stringify(tempColor.rgb)
      )) {
      tempColor.isCustom = true;
      tempColor.name = 'Custom';
    }
    let tempBorderEnabled = getBorderEnabled();
    let tempMiniTrackerEnabled = getMiniTrackerEnabled();
    let tempTopBarEnabled = getTopBarEnabled();
    let tempCollapseMinEnabled = getCollapseMinEnabled();
    let tempMobileMode = getMobileMode();
    let tempShowLeftOnColor = getShowLeftOnColorEnabled();

    // Create the settings overlay
    const settingsOverlay = document.createElement('div');
    settingsOverlay.id = 'bm-crosshair-settings-overlay';
    
    // Check if mobile mode is enabled for compact layout
    const isMobileMode = getMobileMode();
    const mobileStyles = isMobileMode ? `
      max-width: 350px;
      max-height: 70vh;
      border-radius: 12px;
    ` : `
      max-width: 520px;
      max-height: 85vh;
      border-radius: 20px;
    `;
    
    settingsOverlay.style.cssText = `
      position: fixed;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      background: #0f172a;
      color: #f1f5f9;
      padding: 0;
      ${mobileStyles}
      z-index: 9002;
      display: flex;
      flex-direction: column;
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.7), 0 0 0 1px rgba(255, 255, 255, 0.05);
      border: 1px solid #334155;
      backdrop-filter: blur(16px);
      overflow: hidden;
    `;
  
  // Add subtle background pattern
  settingsOverlay.innerHTML = `
    <div style="
      position: absolute; inset: 0; border-radius: 20px;
      background: linear-gradient(135deg, rgba(59, 130, 246, 0.1), rgba(16, 185, 129, 0.05));
      pointer-events: none; z-index: 0;
    "></div>
  `;

  // Header
  const header = document.createElement('div');
  const headerPadding = isMobileMode ? '8px 12px' : '16px 20px';
  header.style.cssText = `
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: ${headerPadding};
    border-bottom: 1px solid var(--slate-700);
    background: linear-gradient(135deg, var(--slate-800), var(--slate-750));
    cursor: move;
    user-select: none;
    flex-shrink: 0;
    position: relative;
    z-index: 1;
  `;

  const title = document.createElement('h2');
  title.textContent = 'Settings';
  const titleFontSize = isMobileMode ? '1.2em' : '1.5em';
  title.style.cssText = `
    margin: 0; 
    font-size: ${titleFontSize}; 
    font-weight: 700;
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
    text-align: center;
    flex: 1;
    pointer-events: none;
    letter-spacing: -0.025em;
    background: linear-gradient(135deg, var(--slate-100), var(--slate-300));
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;
  `;

  const closeButton = document.createElement('button');
  closeButton.textContent = '✕';
  closeButton.style.cssText = `
    background: linear-gradient(135deg, #ef4444, #dc2626);
    border: 1px solid rgba(239, 68, 68, 0.3);
    color: white;
    width: 36px;
    height: 36px;
    border-radius: 12px;
    cursor: pointer;
    font-size: 16px;
    font-weight: 600;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
    position: relative;
    overflow: hidden;
  `;
  // Add hover effects but prevent them on touch devices
  closeButton.onmouseover = () => {
    closeButton.style.transform = 'translateY(-1px) scale(1.05)';
    closeButton.style.boxShadow = '0 6px 20px rgba(239, 68, 68, 0.4)';
  };
  closeButton.onmouseout = () => {
    closeButton.style.transform = '';
    closeButton.style.boxShadow = '';
  };
  
  // Prevent hover effects on touch by immediately resetting styles on touchstart
  closeButton.addEventListener('touchstart', () => {
    closeButton.style.transform = '';
    closeButton.style.boxShadow = '';
  }, { passive: true });
  
  closeButton.onclick = () => settingsOverlay.remove();

  header.appendChild(title);
  header.appendChild(closeButton);

  // Instructions
  const instructions = document.createElement('p');
  instructions.textContent = 'Select the crosshair color that appears on highlighted template pixels:';
  const instructionsMargin = isMobileMode ? '0 0 16px 0' : '0 0 24px 0';
  const instructionsFontSize = isMobileMode ? '0.9em' : '0.95em';
  instructions.style.cssText = `
    margin: ${instructionsMargin}; 
    font-size: ${instructionsFontSize}; 
    color: var(--slate-300); 
    text-align: center;
    font-weight: 500;
    letter-spacing: -0.01em;
    line-height: 1.4;
  `;

  // Current color preview
  const currentColorPreview = document.createElement('div');
  const previewPadding = isMobileMode ? '12px' : '20px';
  const previewMargin = isMobileMode ? '16px' : '24px';
  const previewBorderRadius = isMobileMode ? '12px' : '16px';
  currentColorPreview.style.cssText = `
    background: linear-gradient(135deg, var(--slate-800), var(--slate-750));
    border: 1px solid var(--slate-700);
    border-radius: ${previewBorderRadius};
    padding: ${previewPadding};
    margin-bottom: ${previewMargin};
    text-align: center;
    position: relative;
    overflow: hidden;
  `;

  const previewLabel = document.createElement('div');
  previewLabel.textContent = 'Current Color:';
  previewLabel.style.cssText = `
    font-size: 1em; 
    margin-bottom: 12px; 
    color: var(--slate-200);
    font-weight: 600;
    letter-spacing: -0.01em;
  `;

  const previewColor = document.createElement('div');
  previewColor.id = 'bm-current-color-preview';
  previewColor.style.cssText = `
    width: 60px;
    height: 60px;
    margin: 0 auto 12px;
    position: relative;
    background: var(--slate-700);
    border: 2px solid var(--slate-500);
    border-radius: 12px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
    transition: all 0.2s ease;
  `;
  previewColor.onmouseover = () => {
    previewColor.style.transform = 'scale(1.05)';
    previewColor.style.boxShadow = '0 6px 20px rgba(0, 0, 0, 0.6)';
  };
  previewColor.onmouseout = () => {
    previewColor.style.transform = '';
    previewColor.style.boxShadow = '0 4px 12px rgba(0, 0, 0, 0.4)';
  };
  
  // Create crosshair preview pattern (simple cross: center + 4 sides)
  function updateCrosshairPreview(color, borderEnabled, enhancedSize = false) {
    const { rgb, alpha } = color;
    const colorRgba = `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha / 255})`;
    const borderRgba = borderEnabled ? 'rgba(0, 100, 255, 0.8)' : 'transparent'; // Blue borders
    
    if (enhancedSize) {
      // Enhanced 5x size crosshair preview (extends beyond center)
      previewColor.innerHTML = `
        <div style="
          position: absolute;
          top: 50%;
          left: 50%;
          transform: translate(-50%, -50%);
          width: 100%;
          height: 100%;
          display: grid;
          grid-template-columns: repeat(5, 1fr);
          grid-template-rows: repeat(5, 1fr);
          gap: 1px;
          background: rgba(0,0,0,0.1);
        ">
          <div style="background: ${borderEnabled ? borderRgba : 'transparent'};"></div>
          <div style="background: ${borderEnabled ? borderRgba : 'transparent'};"></div>
          <div style="background: ${colorRgba};"></div>
          <div style="background: ${borderEnabled ? borderRgba : 'transparent'};"></div>
          <div style="background: ${borderEnabled ? borderRgba : 'transparent'};"></div>
          
          <div style="background: ${borderEnabled ? borderRgba : 'transparent'};"></div>
          <div style="background: ${borderEnabled ? borderRgba : 'transparent'};"></div>
          <div style="background: ${colorRgba};"></div>
          <div style="background: ${borderEnabled ? borderRgba : 'transparent'};"></div>
          <div style="background: ${borderEnabled ? borderRgba : 'transparent'};"></div>
          
          <div style="background: ${colorRgba};"></div>
          <div style="background: ${colorRgba};"></div>
          <div style="background: black; border: 2px solid rgba(255,255,255,0.4); box-sizing: border-box;"></div>
          <div style="background: ${colorRgba};"></div>
          <div style="background: ${colorRgba};"></div>
          
          <div style="background: ${borderEnabled ? borderRgba : 'transparent'};"></div>
          <div style="background: ${borderEnabled ? borderRgba : 'transparent'};"></div>
          <div style="background: ${colorRgba};"></div>
          <div style="background: ${borderEnabled ? borderRgba : 'transparent'};"></div>
          <div style="background: ${borderEnabled ? borderRgba : 'transparent'};"></div>
          
          <div style="background: ${borderEnabled ? borderRgba : 'transparent'};"></div>
          <div style="background: ${borderEnabled ? borderRgba : 'transparent'};"></div>
          <div style="background: ${colorRgba};"></div>
          <div style="background: ${borderEnabled ? borderRgba : 'transparent'};"></div>
          <div style="background: ${borderEnabled ? borderRgba : 'transparent'};"></div>
        </div>
      `;
    } else {
      // Standard 3x3 crosshair preview
      previewColor.innerHTML = `
        <div style="
          position: absolute;
          top: 50%;
          left: 50%;
          transform: translate(-50%, -50%);
          width: 100%;
          height: 100%;
          display: grid;
          grid-template-columns: 1fr 1fr 1fr;
          grid-template-rows: 1fr 1fr 1fr;
          gap: 1px;
          background: rgba(0,0,0,0.1);
        ">
          <div style="background: ${borderEnabled ? borderRgba : 'transparent'};"></div>
          <div style="background: ${colorRgba};"></div>
          <div style="background: ${borderEnabled ? borderRgba : 'transparent'};"></div>
          
          <div style="background: ${colorRgba};"></div>
          <div style="background: black; border: 2px solid rgba(255,255,255,0.4); box-sizing: border-box;"></div>
          <div style="background: ${colorRgba};"></div>
          
          <div style="background: ${borderEnabled ? borderRgba : 'transparent'};"></div>
          <div style="background: ${colorRgba};"></div>
          <div style="background: ${borderEnabled ? borderRgba : 'transparent'};"></div>
        </div>
      `;
    }
  }
  
  // Initialize crosshair preview
  updateCrosshairPreview(currentColor, tempBorderEnabled);

  const previewName = document.createElement('div');
  previewName.id = 'bm-current-color-name';
  previewName.textContent = currentColor.name;
  previewName.style.cssText = `
    font-weight: 700; 
    font-size: 1.1em;
    color: var(--slate-100);
    letter-spacing: -0.025em;
  `;

  currentColorPreview.appendChild(previewLabel);
  currentColorPreview.appendChild(previewColor);
  currentColorPreview.appendChild(previewName);

  // Color grid
  const colorGrid = document.createElement('div');
  const gridGap = isMobileMode ? '8px' : '16px';
  const gridMargin = isMobileMode ? '16px' : '24px';
  colorGrid.style.cssText = `
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: ${gridGap};
    margin-bottom: ${gridMargin};
    position: relative;
    z-index: 1;
  `;

  // Create color option buttons
  colorOptions.forEach((color) => {
    const colorOption = document.createElement('button');
    
    // Enhanced selection logic for custom colors
    let isSelected = false;
    if (color.isCustom) {
      // For custom color, check if saved color has isCustom flag OR is not a predefined color
      isSelected = currentColor.isCustom || 
        !colorOptions.filter(c => !c.isCustom).some(predefined => 
          JSON.stringify(predefined.rgb) === JSON.stringify(currentColor.rgb)
        );
    } else {
      // For predefined colors, check exact RGB match AND that current color is not custom
      isSelected = JSON.stringify(color.rgb) === JSON.stringify(currentColor.rgb) && !currentColor.isCustom;
    }
    
    // Special handling for custom color button
    if (color.isCustom) {
      // Use current color if custom is selected, otherwise use sophisticated gradient
      const backgroundStyle = isSelected 
        ? `rgba(${currentColor.rgb[0]}, ${currentColor.rgb[1]}, ${currentColor.rgb[2]}, 1)`
        : `linear-gradient(135deg, 
            #8B5CF6 0%, #A855F7 25%, #3B82F6 50%, #06B6D4 75%, #8B5CF6 100%)`;
            
      const buttonHeight = isMobileMode ? '85px' : '110px';
      const buttonPadding = isMobileMode ? '8px' : '12px';
      colorOption.style.cssText = `
        background: ${backgroundStyle};
        border: 2px solid ${isSelected ? 'var(--slate-100)' : 'var(--slate-600)'};
        border-radius: 12px;
        padding: ${buttonPadding};
        cursor: pointer;
        transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
        position: relative;
        height: ${buttonHeight};
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 6px;
        box-sizing: border-box;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
        ${!isSelected ? 'background-size: 200% 200%; animation: gradientShift 3s ease infinite;' : ''}
      `;
    } else {
      const buttonHeight = isMobileMode ? '85px' : '110px';
      const buttonPadding = isMobileMode ? '8px' : '12px';
      colorOption.style.cssText = `
        background: rgba(${color.rgb[0]}, ${color.rgb[1]}, ${color.rgb[2]}, ${color.alpha / 255});
        border: 2px solid ${isSelected ? 'var(--slate-100)' : 'var(--slate-600)'};
        border-radius: 12px;
        padding: ${buttonPadding};
        cursor: pointer;
        transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
        position: relative;
        height: ${buttonHeight};
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 6px;
        box-sizing: border-box;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
      `;
    }

    // Color name
    const colorName = document.createElement('div');
    colorName.textContent = color.name;
    colorName.style.cssText = `
      font-size: 0.9em;
      font-weight: bold;
      color: white;
      text-shadow: 1px 1px 2px rgba(0, 0, 0, 0.8);
      text-align: center;
    `;

    // RGB values or custom inputs
    if (color.isCustom) {
      // Create RGB input container
      const rgbInputs = document.createElement('div');
      const containerWidth = isMobileMode ? '70%' : '80%';
      const containerMaxWidth = isMobileMode ? '65px' : '80px';
      const containerGap = isMobileMode ? '2px' : '3px';
      rgbInputs.style.cssText = `
        display: flex;
        flex-direction: column;
        gap: ${containerGap};
        width: ${containerWidth};
        max-width: ${containerMaxWidth};
      `;
      
      // Create individual RGB inputs
      const rInput = document.createElement('input');
      rInput.type = 'number';
      rInput.min = '0';
      rInput.max = '255';
      rInput.value = isSelected ? currentColor.rgb[0] : '';
      rInput.placeholder = 'R';
      rInput.className = 'bm-custom-rgb-input';
      const inputPadding = isMobileMode ? '2px 3px' : '3px 4px';
      const inputHeight = isMobileMode ? '18px' : '22px';
      const inputFontSize = isMobileMode ? '0.65em' : '0.7em';
      rInput.style.cssText = `
        width: 100%;
        padding: ${inputPadding};
        border: 1px solid var(--slate-500);
        border-radius: 4px;
        background: var(--slate-700);
        color: var(--slate-100);
        font-size: ${inputFontSize};
        text-align: center;
        outline: none;
        font-weight: 600;
        transition: all 0.2s ease;
        box-sizing: border-box;
        height: ${inputHeight};
      `;
      rInput.onfocus = () => {
        rInput.style.borderColor = 'var(--blue-500)';
        rInput.style.boxShadow = '0 0 0 2px rgba(59, 130, 246, 0.2)';
      };
      rInput.onblur = () => {
        rInput.style.borderColor = 'var(--slate-500)';
        rInput.style.boxShadow = '';
      };
      
      const gInput = document.createElement('input');
      gInput.type = 'number';
      gInput.min = '0';
      gInput.max = '255';
      gInput.value = isSelected ? currentColor.rgb[1] : '';
      gInput.placeholder = 'G';
      gInput.className = 'bm-custom-rgb-input';
      gInput.style.cssText = rInput.style.cssText;
      
      const bInput = document.createElement('input');
      bInput.type = 'number';
      bInput.min = '0';
      bInput.max = '255';
      bInput.value = isSelected ? currentColor.rgb[2] : '';
      bInput.placeholder = 'B';
      bInput.className = 'bm-custom-rgb-input';
      bInput.style.cssText = rInput.style.cssText;
      
      // Update function for RGB inputs
      const updateCustomColor = () => {
        const r = Math.max(0, Math.min(255, parseInt(rInput.value) || 0));
        const g = Math.max(0, Math.min(255, parseInt(gInput.value) || 0));
        const b = Math.max(0, Math.min(255, parseInt(bInput.value) || 0));
        
        tempColor = { name: 'Custom', rgb: [r, g, b], alpha: tempColor.alpha, isCustom: true };
        
        // Update the button background to show the custom color
        colorOption.style.background = `rgba(${r}, ${g}, ${b}, 1)`;
        
        // Update preview
        updateCrosshairPreview(tempColor, tempBorderEnabled);
        document.getElementById('bm-current-color-name').textContent = `Custom RGB(${r}, ${g}, ${b})`;
      };
      
      // Add event listeners
      [rInput, gInput, bInput].forEach(input => {
        input.addEventListener('input', updateCustomColor);
        input.addEventListener('change', updateCustomColor);
        
        // Prevent clicks on inputs from bubbling to button
        input.addEventListener('click', (e) => e.stopPropagation());
        input.addEventListener('mousedown', (e) => e.stopPropagation());
      });
      
      rgbInputs.appendChild(rInput);
      rgbInputs.appendChild(gInput);
      rgbInputs.appendChild(bInput);
      
      colorOption.appendChild(colorName);
      colorOption.appendChild(rgbInputs);
    } else {
      // RGB values for predefined colors
      const rgbText = document.createElement('div');
      rgbText.textContent = `RGB(${color.rgb.join(', ')})`;
      rgbText.style.cssText = `
        font-size: 0.7em;
        color: rgba(255, 255, 255, 0.8);
        text-shadow: 1px 1px 2px rgba(0, 0, 0, 0.8);
      `;
      
      colorOption.appendChild(colorName);
      colorOption.appendChild(rgbText);
    }

    // Selection indicator
    if (isSelected) {
      const checkmark = document.createElement('div');
      checkmark.textContent = '✓';
      checkmark.style.cssText = `
        position: absolute;
        top: 5px;
        right: 5px;
        color: white;
        font-weight: bold;
        font-size: 1.2em;
        text-shadow: 1px 1px 2px rgba(0, 0, 0, 0.8);
      `;
      colorOption.appendChild(checkmark);
    }

    // Click handler
    colorOption.onclick = () => {
      // For custom color, the inputs handle the color updates
      if (!color.isCustom) {
        // Update temporary color (don't save yet)
        tempColor = { ...color };
        
        // Update crosshair preview with new color and current border setting
        updateCrosshairPreview(tempColor, tempBorderEnabled);
        document.getElementById('bm-current-color-name').textContent = color.name;
      }
      
      // Update visual selection
      colorGrid.querySelectorAll('button').forEach(btn => {
        btn.style.border = '3px solid rgba(255, 255, 255, 0.3)';
        const checkmark = btn.querySelector('div[style*="position: absolute"]');
        if (checkmark) checkmark.remove();
      });
      
      colorOption.style.border = '3px solid #fff';
      const checkmark = document.createElement('div');
      checkmark.textContent = '✓';
      checkmark.style.cssText = `
        position: absolute;
        top: 5px;
        right: 5px;
        color: white;
        font-weight: bold;
        font-size: 1.2em;
        text-shadow: 1px 1px 2px rgba(0, 0, 0, 0.8);
      `;
      colorOption.appendChild(checkmark);
    };

    // Hover effects (only for non-custom buttons to avoid interfering with inputs)
    if (!color.isCustom) {
      colorOption.addEventListener('mouseenter', () => {
        if (!isSelected) {
          colorOption.style.border = '3px solid rgba(255, 255, 255, 0.7)';
          colorOption.style.transform = 'scale(1.05)';
        }
      });

      colorOption.addEventListener('mouseleave', () => {
        if (!isSelected) {
          colorOption.style.border = '3px solid rgba(255, 255, 255, 0.3)';
          colorOption.style.transform = 'scale(1)';
        }
      });
    }

    colorGrid.appendChild(colorOption);
  });

  // Alpha slider section
  const alphaSection = document.createElement('div');
  const sectionPadding = isMobileMode ? '12px' : '18px';
  const sectionMargin = isMobileMode ? '14px' : '20px';
  const sectionBorderRadius = isMobileMode ? '8px' : '12px';
  alphaSection.style.cssText = `
    background: linear-gradient(135deg, var(--slate-800), var(--slate-750));
    border: 1px solid var(--slate-700);
    border-radius: ${sectionBorderRadius};
    padding: ${sectionPadding};
    margin-bottom: ${sectionMargin};
    position: relative;
    z-index: 1;
  `;

  const alphaLabel = document.createElement('div');
  alphaLabel.textContent = 'Crosshair Transparency:';
  alphaLabel.style.cssText = `
    font-size: 1em; 
    margin-bottom: 12px; 
    color: var(--slate-200);
    font-weight: 600;
    letter-spacing: -0.01em;
  `;

  const alphaSlider = document.createElement('input');
  alphaSlider.type = 'range';
  alphaSlider.min = '50';
  alphaSlider.max = '255';
  alphaSlider.value = currentColor.alpha.toString();
  alphaSlider.style.cssText = `
    width: 100%;
    margin: 10px 0;
  `;

  const alphaValue = document.createElement('div');
  alphaValue.textContent = `${Math.round((currentColor.alpha / 255) * 100)}%`;
  alphaValue.style.cssText = `
    text-align: center; 
    font-weight: 700; 
    font-size: 1.1em;
    color: var(--slate-100);
    margin-top: 8px;
    letter-spacing: -0.025em;
  `;

  alphaSlider.oninput = () => {
    const alpha = parseInt(alphaSlider.value);
    alphaValue.textContent = `${Math.round((alpha / 255) * 100)}%`;
    
    // Update temporary color with new alpha
    tempColor.alpha = alpha;
    
    // Update crosshair preview with new alpha
    updateCrosshairPreview(tempColor, tempBorderEnabled);
  };

  alphaSection.appendChild(alphaLabel);
  alphaSection.appendChild(alphaSlider);
  alphaSection.appendChild(alphaValue);

  // Border options section
  const borderSection = document.createElement('div');
  borderSection.style.cssText = `
    background: linear-gradient(135deg, var(--slate-800), var(--slate-750));
    border: 1px solid var(--slate-700);
    border-radius: ${sectionBorderRadius};
    padding: ${sectionPadding};
    margin-bottom: ${sectionMargin};
    position: relative;
    z-index: 1;
  `;

  const borderLabel = document.createElement('div');
  borderLabel.textContent = 'Corner Borders:';
  borderLabel.style.cssText = `
    font-size: 1em; 
    margin-bottom: 12px; 
    color: var(--slate-200);
    font-weight: 600;
    letter-spacing: -0.01em;
  `;

  const borderDescription = document.createElement('div');
  borderDescription.textContent = 'Add subtle borders around corner pixels of the crosshair';
  borderDescription.style.cssText = `
    font-size: 0.9em; 
    margin-bottom: 16px; 
    color: var(--slate-300);
    line-height: 1.4;
    letter-spacing: -0.005em;
  `;

  const borderToggle = document.createElement('label');
  borderToggle.style.cssText = `
    display: flex;
    align-items: center;
    gap: 10px;
    cursor: pointer;
    user-select: none;
  `;

  const borderCheckbox = document.createElement('input');
  borderCheckbox.type = 'checkbox';
  borderCheckbox.checked = tempBorderEnabled;
  borderCheckbox.style.cssText = `
    width: 16px;
    height: 16px;
    cursor: pointer;
    border-radius: 4px;
  `;

  const borderToggleText = document.createElement('span');
  borderToggleText.textContent = tempBorderEnabled ? 'Enabled' : 'Disabled';
  borderToggleText.style.cssText = `
    color: var(--slate-100); 
    font-weight: 700;
    letter-spacing: -0.01em;
  `;

  borderCheckbox.onchange = () => {
    tempBorderEnabled = borderCheckbox.checked;
    
    // Update crosshair preview to show/hide borders
    updateCrosshairPreview(tempColor, tempBorderEnabled);
    // Visual feedback like the Mini Progress Tracker (text color only)
    borderToggleText.style.background = '';
    borderToggleText.style.border = '';
    borderToggleText.style.padding = '';
    borderToggleText.style.borderRadius = '';
    borderToggleText.style.color = tempBorderEnabled ? '#4caf50' : '#f44336';
    borderToggleText.textContent = tempBorderEnabled ? 'Enabled' : 'Disabled';
  };

  borderToggle.appendChild(borderCheckbox);
  borderToggle.appendChild(borderToggleText);
  borderSection.appendChild(borderLabel);
  borderSection.appendChild(borderDescription);
  borderSection.appendChild(borderToggle);

  // Crosshair Size section
  const sizeSection = document.createElement('div');
  sizeSection.style.cssText = `
    background: linear-gradient(135deg, var(--slate-800), var(--slate-750));
    border: 1px solid var(--slate-700);
    border-radius: ${sectionBorderRadius};
    padding: ${sectionPadding};
    margin-bottom: ${sectionMargin};
    position: relative;
    z-index: 1;
  `;

  const sizeLabel = document.createElement('div');
  sizeLabel.textContent = 'Crosshair Size:';
  sizeLabel.style.cssText = `
    font-size: 1em; 
    margin-bottom: 12px; 
    color: var(--slate-200);
    font-weight: 600;
    letter-spacing: -0.01em;
  `;

  const sizeDescription = document.createElement('div');
  sizeDescription.textContent = 'Make crosshair 5x larger, extending beyond pixel boundaries';
  sizeDescription.style.cssText = `
    font-size: 0.9em; 
    margin-bottom: 16px; 
    color: var(--slate-300);
    line-height: 1.4;
    letter-spacing: -0.005em;
  `;

  const sizeToggle = document.createElement('label');
  sizeToggle.style.cssText = `
    display: flex;
    align-items: center;
    gap: 12px;
    cursor: pointer;
    padding: 4px 0;
    user-select: none;
  `;

  // Get current enhanced size setting (single source of truth)
  let tempEnhancedSize = getEnhancedSizeEnabled();

  const sizeCheckbox = document.createElement('input');
  sizeCheckbox.type = 'checkbox';
  sizeCheckbox.checked = tempEnhancedSize;
  sizeCheckbox.style.cssText = `
    width: 16px;
    height: 16px;
    cursor: pointer;
    border-radius: 4px;
  `;

  const sizeToggleText = document.createElement('span');
  sizeToggleText.textContent = tempEnhancedSize ? 'Enabled' : 'Disabled';
  sizeToggleText.style.cssText = `
    font-size: 0.95em;
    color: var(--slate-100);
    font-weight: 700;
    letter-spacing: -0.01em;
  `;

  sizeCheckbox.onchange = () => {
    tempEnhancedSize = sizeCheckbox.checked;
    updateCrosshairPreview(tempColor, tempBorderEnabled, tempEnhancedSize);
    // Visual feedback like the Mini Progress Tracker (only checkbox toggles)
    sizeToggleText.style.background = '';
    sizeToggleText.style.border = '';
    sizeToggleText.style.padding = '';
    sizeToggleText.style.borderRadius = '';
    sizeToggleText.style.color = tempEnhancedSize ? '#4caf50' : '#f44336';
    sizeToggleText.textContent = tempEnhancedSize ? 'Enabled' : 'Disabled';
  };

  // Only a BOX click altera o estado – clique no texto não alterna
  sizeToggle.onclick = (e) => {};

  sizeToggle.appendChild(sizeCheckbox);
  sizeToggle.appendChild(sizeToggleText);
  // Initialize visual state
  borderCheckbox.onchange();
  sizeCheckbox.onchange();
  sizeSection.appendChild(sizeLabel);
  sizeSection.appendChild(sizeDescription);
  sizeSection.appendChild(sizeToggle);

  // Crosshair Radius section (only show when enhanced size is enabled)
  const radiusSection = document.createElement('div');
  radiusSection.style.cssText = `
    background: linear-gradient(135deg, var(--slate-800), var(--slate-750));
    border: 1px solid var(--slate-700);
    border-radius: ${sectionBorderRadius};
    padding: ${sectionPadding};
    margin-bottom: ${sectionMargin};
    position: relative;
    z-index: 1;
    transition: opacity 0.3s ease, transform 0.3s ease;
  `;

  const radiusLabel = document.createElement('div');
  radiusLabel.textContent = 'Crosshair Radius:';
  radiusLabel.style.cssText = `
    font-size: 1em; 
    margin-bottom: 12px; 
    color: var(--slate-200);
    font-weight: 600;
    letter-spacing: -0.01em;
  `;

  const radiusDescription = document.createElement('div');
  radiusDescription.textContent = 'Control how far the crosshair extends from the center pixel';
  radiusDescription.style.cssText = `
    font-size: 0.9em; 
    margin-bottom: 16px; 
    color: var(--slate-300);
    line-height: 1.4;
    letter-spacing: -0.005em;
  `;

  // Get current radius setting
  let tempRadius = getCrosshairRadius();

  const radiusSliderContainer = document.createElement('div');
  radiusSliderContainer.style.cssText = `
    display: flex;
    align-items: center;
    gap: 16px;
    margin-bottom: 12px;
  `;

  const radiusSlider = document.createElement('input');
  radiusSlider.type = 'range';
  radiusSlider.min = '12';
  radiusSlider.max = '32';
  radiusSlider.step = '1';
  radiusSlider.value = tempRadius;
  radiusSlider.style.cssText = `
    flex: 1;
    height: 6px;
    background: linear-gradient(90deg, var(--slate-600), var(--slate-500));
    border-radius: 3px;
    outline: none;
    cursor: pointer;
    -webkit-appearance: none;
    -moz-appearance: none;
  `;

  // Style the slider thumb
  const radiusSliderStyle = document.createElement('style');
  radiusSliderStyle.textContent = `
    input[type="range"]::-webkit-slider-thumb {
      -webkit-appearance: none;
      width: 18px;
      height: 18px;
      background: linear-gradient(135deg, var(--slate-300), var(--slate-400));
      border-radius: 50%;
      cursor: pointer;
      border: 2px solid var(--slate-100);
      box-shadow: 0 2px 6px rgba(0, 0, 0, 0.3);
    }
    input[type="range"]::-moz-range-thumb {
      width: 18px;
      height: 18px;
      background: linear-gradient(135deg, var(--slate-300), var(--slate-400));
      border-radius: 50%;
      cursor: pointer;
      border: 2px solid var(--slate-100);
      box-shadow: 0 2px 6px rgba(0, 0, 0, 0.3);
    }
  `;
  document.head.appendChild(radiusSliderStyle);

  const radiusValue = document.createElement('div');
  radiusValue.textContent = tempRadius;
  radiusValue.style.cssText = `
    font-size: 1em;
    font-weight: 600;
    color: var(--slate-100);
    min-width: 32px;
    text-align: center;
    background: var(--slate-700);
    padding: 6px 12px;
    border-radius: 6px;
    border: 1px solid var(--slate-600);
  `;

  radiusSlider.oninput = () => {
    tempRadius = parseInt(radiusSlider.value);
    radiusValue.textContent = tempRadius;
    updateCrosshairPreview(tempColor, tempBorderEnabled, tempEnhancedSize);
  };

  // Update radius section visibility based on enhanced size
  const updateRadiusVisibility = () => {
    if (tempEnhancedSize) {
      radiusSection.style.opacity = '1';
      radiusSection.style.transform = 'translateY(0)';
      radiusSection.style.pointerEvents = 'auto';
    } else {
      radiusSection.style.opacity = '0.5';
      radiusSection.style.transform = 'translateY(-10px)';
      radiusSection.style.pointerEvents = 'none';
    }
  };

  // Override the enhanced size checkbox onchange to also update radius visibility
  const originalSizeOnChange = sizeCheckbox.onchange;
  sizeCheckbox.onchange = () => {
    originalSizeOnChange();
    updateRadiusVisibility();
  };

  radiusSliderContainer.appendChild(radiusSlider);
  radiusSliderContainer.appendChild(radiusValue);
  radiusSection.appendChild(radiusLabel);
  radiusSection.appendChild(radiusDescription);
  radiusSection.appendChild(radiusSliderContainer);

  // Initialize radius visibility
  updateRadiusVisibility();

  // Unified Tracker Settings Section
  const trackerSection = document.createElement('div');
  trackerSection.style.cssText = `
    background: linear-gradient(135deg, var(--slate-800), var(--slate-750));
    border: 1px solid var(--slate-700);
    border-radius: ${sectionBorderRadius};
    padding: ${sectionPadding};
    margin-bottom: ${sectionMargin};
    position: relative;
    z-index: 1;
  `;

  const trackerSectionTitle = document.createElement('div');
  trackerSectionTitle.textContent = '📊 Tracker Settings:';
  trackerSectionTitle.style.cssText = `
    font-size: 1.1em; 
    margin-bottom: 20px; 
    color: var(--slate-100);
    font-weight: 700;
    letter-spacing: -0.02em;
    border-bottom: 1px solid var(--slate-700);
    padding-bottom: 12px;
  `;

  // Mini Progress Tracker Toggle
  const miniTrackerContainer = document.createElement('div');
  miniTrackerContainer.style.cssText = `
    margin-bottom: 20px;
    padding-bottom: 20px;
    border-bottom: 1px solid var(--slate-700);
  `;

  const miniTrackerLabel = document.createElement('div');
  miniTrackerLabel.textContent = 'Mini Progress Tracker:';
  miniTrackerLabel.style.cssText = `
    font-size: 1em; 
    margin-bottom: 8px; 
    color: var(--slate-200);
    font-weight: 600;
    letter-spacing: -0.01em;
  `;

  const miniTrackerDescription = document.createElement('div');
  miniTrackerDescription.textContent = 'Show a compact progress tracker below the Color Filter button.';
  miniTrackerDescription.style.cssText = `
    font-size: 0.9em; 
    color: var(--slate-300); 
    margin-bottom: 12px; 
    line-height: 1.4;
    letter-spacing: -0.005em;
  `;

  const miniTrackerToggle = document.createElement('div');
  miniTrackerToggle.style.cssText = `
    display: flex;
    align-items: center;
    gap: 8px;
  `;

  const miniTrackerCheckbox = document.createElement('input');
  miniTrackerCheckbox.type = 'checkbox';
  miniTrackerCheckbox.checked = tempMiniTrackerEnabled;
  miniTrackerCheckbox.style.cssText = `
    width: 16px;
    height: 16px;
    cursor: pointer;
  `;

  const miniTrackerToggleText = document.createElement('span');
  miniTrackerToggleText.textContent = tempMiniTrackerEnabled ? 'Enabled' : 'Disabled';
  miniTrackerToggleText.style.cssText = `
    color: ${tempMiniTrackerEnabled ? '#4caf50' : '#f44336'};
    font-weight: bold;
    cursor: pointer;
  `;

  const updateMiniTrackerState = () => {
    tempMiniTrackerEnabled = miniTrackerCheckbox.checked;
    miniTrackerToggleText.textContent = tempMiniTrackerEnabled ? 'Enabled' : 'Disabled';
    miniTrackerToggleText.style.color = tempMiniTrackerEnabled ? '#4caf50' : '#f44336';
    debugLog(`Mini tracker ${tempMiniTrackerEnabled ? 'enabled' : 'disabled'} (preview only)`);
  };

  miniTrackerCheckbox.addEventListener('change', updateMiniTrackerState);
  miniTrackerToggleText.onclick = (e) => {
    e.stopPropagation();
    miniTrackerCheckbox.checked = !miniTrackerCheckbox.checked;
    updateMiniTrackerState();
  };

  miniTrackerToggle.style.cursor = 'default';
  miniTrackerToggle.appendChild(miniTrackerCheckbox);
  miniTrackerToggle.appendChild(miniTrackerToggleText);
  miniTrackerContainer.appendChild(miniTrackerLabel);
  miniTrackerContainer.appendChild(miniTrackerDescription);
  miniTrackerContainer.appendChild(miniTrackerToggle);

  // Top Progress Bar Toggle
  const topBarContainer = document.createElement('div');
  topBarContainer.style.cssText = `
    margin-bottom: 20px;
    padding-bottom: 20px;
    border-bottom: 1px solid var(--slate-700);
  `;

  const topBarLabel = document.createElement('div');
  topBarLabel.textContent = 'Top Progress Bar:';
  topBarLabel.style.cssText = `
    font-size: 1em; 
    margin-bottom: 8px; 
    color: var(--slate-200);
    font-weight: 600;
    letter-spacing: -0.01em;
  `;

  const topBarDescription = document.createElement('div');
  topBarDescription.textContent = 'Show a centered progress bar at the top of the screen.';
  topBarDescription.style.cssText = `
    font-size: 0.9em; 
    color: var(--slate-300); 
    margin-bottom: 12px; 
    line-height: 1.4;
    letter-spacing: -0.005em;
  `;

  const topBarToggle = document.createElement('div');
  topBarToggle.style.cssText = `
    display: flex;
    align-items: center;
    gap: 8px;
  `;

  const topBarCheckbox = document.createElement('input');
  topBarCheckbox.type = 'checkbox';
  topBarCheckbox.checked = tempTopBarEnabled;
  topBarCheckbox.style.cssText = `
    width: 16px;
    height: 16px;
    cursor: pointer;
  `;

  const topBarToggleText = document.createElement('span');
  topBarToggleText.textContent = tempTopBarEnabled ? 'Enabled' : 'Disabled';
  topBarToggleText.style.cssText = `
    color: ${tempTopBarEnabled ? '#4caf50' : '#f44336'};
    font-weight: bold;
    cursor: pointer;
  `;

  const updateTopBarState = () => {
    tempTopBarEnabled = topBarCheckbox.checked;
    topBarToggleText.textContent = tempTopBarEnabled ? 'Enabled' : 'Disabled';
    topBarToggleText.style.color = tempTopBarEnabled ? '#4caf50' : '#f44336';
    debugLog(`Top bar ${tempTopBarEnabled ? 'enabled' : 'disabled'} (preview only)`);
  };

  topBarCheckbox.addEventListener('change', updateTopBarState);
  topBarToggleText.onclick = (e) => {
    e.stopPropagation();
    topBarCheckbox.checked = !topBarCheckbox.checked;
    updateTopBarState();
  };

  topBarToggle.style.cursor = 'default';
  topBarToggle.appendChild(topBarCheckbox);
  topBarToggle.appendChild(topBarToggleText);
  topBarContainer.appendChild(topBarLabel);
  topBarContainer.appendChild(topBarDescription);
  topBarContainer.appendChild(topBarToggle);

  // Collapse Mini Tracker Toggle
  const collapseContainer = document.createElement('div');
  collapseContainer.style.cssText = `
    margin-bottom: 0;
  `;

  const collapseLabel = document.createElement('div');
  collapseLabel.textContent = 'Collapse Mini Tracker:';
  collapseLabel.style.cssText = `
    font-size: 1em; 
    margin-bottom: 8px; 
    color: var(--slate-200);
    font-weight: 600;
    letter-spacing: -0.01em;
  `;

  const collapseDescription = document.createElement('div');
  collapseDescription.textContent = 'Hide mini tracker when template section is collapsed.';
  collapseDescription.style.cssText = `
    font-size: 0.9em; 
    color: var(--slate-300); 
    margin-bottom: 12px; 
    line-height: 1.4;
    letter-spacing: -0.005em;
  `;

  const collapseToggle = document.createElement('div');
  collapseToggle.style.cssText = `
    display: flex;
    align-items: center;
    gap: 8px;
  `;

  const collapseCheckbox = document.createElement('input');
  collapseCheckbox.type = 'checkbox';
  collapseCheckbox.checked = tempCollapseMinEnabled;
  collapseCheckbox.style.cssText = `
    width: 16px;
    height: 16px;
    cursor: pointer;
  `;

  const collapseToggleText = document.createElement('span');
  collapseToggleText.textContent = tempCollapseMinEnabled ? 'Enabled' : 'Disabled';
  collapseToggleText.style.cssText = `
    color: ${tempCollapseMinEnabled ? '#4caf50' : '#f44336'};
    font-weight: bold;
    cursor: pointer;
  `;

  const updateCollapseState = () => {
    tempCollapseMinEnabled = collapseCheckbox.checked;
    collapseToggleText.textContent = tempCollapseMinEnabled ? 'Enabled' : 'Disabled';
    collapseToggleText.style.color = tempCollapseMinEnabled ? '#4caf50' : '#f44336';
    debugLog(`Collapse mini ${tempCollapseMinEnabled ? 'enabled' : 'disabled'} (preview only)`);
  };

  collapseCheckbox.addEventListener('change', updateCollapseState);
  collapseToggleText.onclick = (e) => {
    e.stopPropagation();
    collapseCheckbox.checked = !collapseCheckbox.checked;
    updateCollapseState();
  };

  collapseToggle.style.cursor = 'default';
  collapseToggle.appendChild(collapseCheckbox);
  collapseToggle.appendChild(collapseToggleText);
  collapseContainer.appendChild(collapseLabel);
  collapseContainer.appendChild(collapseDescription);
  collapseContainer.appendChild(collapseToggle);

  // Add all toggles to unified tracker section
  trackerSection.appendChild(trackerSectionTitle);
  trackerSection.appendChild(miniTrackerContainer);
  trackerSection.appendChild(topBarContainer);
  trackerSection.appendChild(collapseContainer);

  // Mobile Mode Section
  const mobileSection = document.createElement('div');
  mobileSection.style.cssText = `
    background: linear-gradient(135deg, var(--slate-800), var(--slate-750));
    border: 1px solid var(--slate-700);
    border-radius: ${sectionBorderRadius};
    padding: ${sectionPadding};
    margin-bottom: ${sectionMargin};
    position: relative;
    z-index: 1;
  `;

  const mobileLabel = document.createElement('div');
  mobileLabel.textContent = '📱 Mobile Mode:';
  mobileLabel.style.cssText = `
    font-size: 1em; 
    margin-bottom: 12px; 
    color: var(--slate-200);
    font-weight: 600;
    letter-spacing: -0.01em;
  `;

  const mobileDescription = document.createElement('div');
  mobileDescription.textContent = 'Enable ultra-compact UI for mobile devices. Makes Color Filter extremely compact for better mobile experience.';
  mobileDescription.style.cssText = `
    font-size: 0.9em; 
    color: var(--slate-300); 
    margin-bottom: 16px; 
    line-height: 1.4;
    letter-spacing: -0.005em;
  `;

  const mobileToggle = document.createElement('div');
  mobileToggle.style.cssText = `
    display: flex;
    align-items: center;
    gap: 8px;
  `;

  // Use global mobile mode setting

  const mobileCheckbox = document.createElement('input');
  mobileCheckbox.type = 'checkbox';
  const currentMobileMode = getMobileMode(); // Get fresh value from storage
  mobileCheckbox.checked = currentMobileMode;
  tempMobileMode = currentMobileMode; // Synchronize temp variable
  mobileCheckbox.style.cssText = `
    width: 16px;
    height: 16px;
    cursor: pointer;
  `;

  const mobileToggleText = document.createElement('span');
  mobileToggleText.textContent = currentMobileMode ? 'Enabled' : 'Disabled';
  mobileToggleText.style.cssText = `
    color: ${currentMobileMode ? '#4caf50' : '#f44336'};
    font-weight: bold;
    cursor: pointer;
  `;

  // Function to update mobile mode state (visual only, no saving)
  const updateMobileState = () => {
    tempMobileMode = mobileCheckbox.checked;
    mobileToggleText.textContent = tempMobileMode ? 'Enabled' : 'Disabled';
    mobileToggleText.style.color = tempMobileMode ? '#4caf50' : '#f44336';
    
    // Only update visual state, actual saving happens on Apply
    debugLog(`Mobile mode ${tempMobileMode ? 'enabled' : 'disabled'} (preview only)`);
  };

  mobileCheckbox.addEventListener('change', updateMobileState);

  // Only make the TEXT clickable, not the whole container
  mobileToggleText.onclick = (e) => {
    e.stopPropagation(); // Prevent event bubbling
    mobileCheckbox.checked = !mobileCheckbox.checked;
    updateMobileState();
  };

  // Remove cursor pointer from the container since only text should be clickable
  mobileToggle.style.cursor = 'default';

  mobileToggle.appendChild(mobileCheckbox);
  mobileToggle.appendChild(mobileToggleText);
  // Visual feedback for enabled/disabled
  const applyMobileVisual = () => {
    mobileToggleText.style.background = '';
    mobileToggleText.style.border = '';
    mobileToggleText.style.padding = '';
    mobileToggleText.style.borderRadius = '';
    mobileToggleText.style.color = tempMobileMode ? '#4caf50' : '#f44336';
    mobileToggleText.textContent = tempMobileMode ? 'Enabled' : 'Disabled';
  };
  applyMobileVisual();
  const oldUpdateMobile = updateMobileState;
  const updateMobileStateWrapped = () => { oldUpdateMobile(); applyMobileVisual(); };
  mobileCheckbox.removeEventListener('change', updateMobileState);
  mobileCheckbox.addEventListener('change', updateMobileStateWrapped);
  // Make TEXT clickable too
  mobileToggleText.onclick = (e) => {
    e.stopPropagation();
    mobileCheckbox.checked = !mobileCheckbox.checked;
    updateMobileStateWrapped();
  };
  mobileSection.appendChild(mobileLabel);
  mobileSection.appendChild(mobileDescription);
  mobileSection.appendChild(mobileToggle);

  // Drag Mode Section
  const dragModeSection = document.createElement('div');
  dragModeSection.style.cssText = `
    background: linear-gradient(135deg, var(--slate-800), var(--slate-750));
    border: 1px solid var(--slate-700);
    border-radius: ${sectionBorderRadius};
    padding: ${sectionPadding};
    margin-bottom: ${sectionMargin};
    position: relative;
    z-index: 1;
  `;

  const dragModeLabel = document.createElement('div');
  dragModeLabel.textContent = 'Drag Mode:';
  dragModeLabel.style.cssText = `
    color: var(--text-primary);
    font-weight: 600;
    font-size: 14px;
    margin-bottom: 8px;
  `;

  const dragModeDescription = document.createElement('div');
  dragModeDescription.textContent = 'Choose how to drag the overlay: full overlay (easier on mobile) or drag bar only (classic mode).';
  dragModeDescription.style.cssText = `
    color: var(--text-secondary);
    font-size: 12px;
    line-height: 1.4;
    margin-bottom: 12px;
  `;

  const dragModeToggle = document.createElement('div');
  dragModeToggle.style.cssText = `
    display: flex;
    gap: 8px;
    padding: 4px;
    background: var(--slate-900);
    border-radius: 8px;
    border: 1px solid var(--slate-600);
  `;

  // Initialize drag mode setting
  let tempDragMode = getDragModeEnabled();

  const fullOverlayButton = document.createElement('button');
  fullOverlayButton.textContent = 'Full Overlay';
  fullOverlayButton.style.cssText = `
    flex: 1;
    padding: 8px 12px;
    border: none;
    border-radius: 6px;
    cursor: pointer;
    font-size: 0.9em;
    font-weight: 600;
    transition: all 0.2s ease;
    ${tempDragMode 
      ? 'background: linear-gradient(135deg, var(--blue-500), var(--blue-600)); color: white;'
      : 'background: transparent; color: var(--slate-300);'
    }
  `;

  const dragBarButton = document.createElement('button');
  dragBarButton.textContent = 'Drag Bar Only';
  dragBarButton.style.cssText = `
    flex: 1;
    padding: 8px 12px;
    border: none;
    border-radius: 6px;
    cursor: pointer;
    font-size: 0.9em;
    font-weight: 600;
    transition: all 0.2s ease;
    ${!tempDragMode 
      ? 'background: linear-gradient(135deg, var(--blue-500), var(--blue-600)); color: white;'
      : 'background: transparent; color: var(--slate-300);'
    }
  `;

  fullOverlayButton.onclick = () => {
    tempDragMode = true;
    saveDragModeEnabled(tempDragMode);
    applyDragMode(tempDragMode);
    
    fullOverlayButton.style.background = 'linear-gradient(135deg, var(--blue-500), var(--blue-600))';
    fullOverlayButton.style.color = 'white';
    dragBarButton.style.background = 'transparent';
    dragBarButton.style.color = 'var(--slate-300)';
  };

  dragBarButton.onclick = () => {
    tempDragMode = false;
    saveDragModeEnabled(tempDragMode);
    applyDragMode(tempDragMode);
    
    dragBarButton.style.background = 'linear-gradient(135deg, var(--blue-500), var(--blue-600))';
    dragBarButton.style.color = 'white';
    fullOverlayButton.style.background = 'transparent';
    fullOverlayButton.style.color = 'var(--slate-300)';
  };

  dragModeToggle.appendChild(fullOverlayButton);
  dragModeToggle.appendChild(dragBarButton);
  dragModeSection.appendChild(dragModeLabel);
  dragModeSection.appendChild(dragModeDescription);
  dragModeSection.appendChild(dragModeToggle);

  // Create fixed footer with action buttons
  const footerContainer = document.createElement('div');
  const footerPadding = isMobileMode ? '10px 12px' : '16px 20px';
  footerContainer.style.cssText = `
    display: flex;
    gap: 12px;
    justify-content: center;
    align-items: center;
    padding: ${footerPadding};
    border-top: 1px solid var(--slate-700);
    background: linear-gradient(135deg, var(--slate-800), var(--slate-750));
    position: relative;
    z-index: 1;
    flex-shrink: 0;
  `;

  // Action buttons
  const actionsContainer = document.createElement('div');
  actionsContainer.style.cssText = `
    display: flex;
    gap: 12px;
    width: 100%;
    max-width: 400px;
  `;

  const cancelButton = document.createElement('button');
  cancelButton.textContent = 'Cancel';
  cancelButton.style.cssText = `
    background: linear-gradient(135deg, var(--slate-600), var(--slate-700));
    border: 1px solid var(--slate-500);
    color: var(--slate-100);
    padding: 14px 20px;
    border-radius: 12px;
    cursor: pointer;
    font-size: 0.95em;
    font-weight: 600;
    flex: 1;
    transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
    position: relative;
    overflow: hidden;
  `;
  cancelButton.onmouseover = () => {
    cancelButton.style.transform = 'translateY(-1px)';
    cancelButton.style.background = 'linear-gradient(135deg, var(--slate-500), var(--slate-600))';
    cancelButton.style.boxShadow = '0 6px 20px rgba(71, 85, 105, 0.3)';
  };
  cancelButton.onmouseout = () => {
    cancelButton.style.transform = '';
    cancelButton.style.background = 'linear-gradient(135deg, var(--slate-600), var(--slate-700))';
    cancelButton.style.boxShadow = '';
  };
  cancelButton.onclick = () => {
    // Check if any settings have changed
    const currentColorSaved = getCrosshairColor();
    const currentBorderSaved = getBorderEnabled();
    const currentTrackerSaved = getMiniTrackerEnabled();
    const currentCollapseSaved = getCollapseMinEnabled();
    const currentMobileSaved = getMobileMode();
    
    const hasChanges = 
      JSON.stringify(tempColor) !== JSON.stringify(currentColorSaved) ||
      tempBorderEnabled !== currentBorderSaved ||
      tempEnhancedSize !== getEnhancedSizeEnabled() ||
      tempRadius !== getCrosshairRadius() ||
      tempMiniTrackerEnabled !== currentTrackerSaved ||
      tempCollapseMinEnabled !== currentCollapseSaved ||
      tempMobileMode !== currentMobileSaved ||
      tempShowLeftOnColor !== getShowLeftOnColorEnabled() ||
      tempNavigationMethod !== Settings.getNavigationMethod();
    
    if (hasChanges) {
      if (confirm('Discard changes? Any unsaved settings will be lost.')) {
        settingsOverlay.remove();
        overlayMain.handleDisplayStatus('Crosshair settings cancelled - changes discarded');
      }
    } else {
      settingsOverlay.remove();
    }
  };

  const applyButton = document.createElement('button');
  applyButton.textContent = 'Apply Settings';
  applyButton.style.cssText = `
    background: linear-gradient(135deg, var(--blue-500), var(--blue-600));
    border: 1px solid var(--blue-600);
    color: white;
    padding: 14px 20px;
    border-radius: 12px;
    cursor: pointer;
    font-size: 0.95em;
    font-weight: 700;
    flex: 2;
    transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
    position: relative;
    overflow: hidden;
  `;
  applyButton.onmouseover = () => {
    applyButton.style.transform = 'translateY(-1px)';
    applyButton.style.background = 'linear-gradient(135deg, var(--blue-600), var(--blue-700))';
    applyButton.style.boxShadow = '0 6px 20px rgba(59, 130, 246, 0.4)';
  };
  applyButton.onmouseout = () => {
    applyButton.style.transform = '';
    applyButton.style.background = 'linear-gradient(135deg, var(--blue-500), var(--blue-600))';
    applyButton.style.boxShadow = '';
  };

  applyButton.onclick = async () => {
    // Visual feedback - button click animation
    const originalBg = applyButton.style.background;
    const originalText = applyButton.textContent;
    
    // Immediate click feedback
    applyButton.style.background = 'linear-gradient(135deg, var(--emerald-500), var(--emerald-600))';
    applyButton.textContent = 'Applying...';
    applyButton.style.transform = 'scale(0.95)';
    applyButton.disabled = true;
    
    try {
      // Save all settings
      debugLog('Applying crosshair settings:', { color: tempColor, borders: tempBorderEnabled, miniTracker: tempMiniTrackerEnabled, topBar: tempTopBarEnabled, collapse: tempCollapseMinEnabled, mobile: tempMobileMode, showLeftOnColor: tempShowLeftOnColor, navigation: tempNavigationMethod, debug: tempDebugEnabled, smartCache: tempCacheEnabled });
      
      saveCrosshairColor(tempColor);
      saveBorderEnabled(tempBorderEnabled);
      saveEnhancedSizeEnabled(tempEnhancedSize);
      saveCrosshairRadius(tempRadius);
      saveMiniTrackerEnabled(tempMiniTrackerEnabled);
      saveTopBarEnabled(tempTopBarEnabled);
      saveCollapseMinEnabled(tempCollapseMinEnabled);
      saveMobileMode(tempMobileMode);
      saveShowLeftOnColorEnabled(tempShowLeftOnColor);
      Settings.saveNavigationMethod(tempNavigationMethod);
      saveDebugLoggingEnabled(tempDebugEnabled);
      
      // Apply smart tile cache setting
      if (getSmartCacheStats().enabled !== tempCacheEnabled) {
        toggleSmartTileCache();
        updateCacheStatsDisplay(); // Update the stats display
      }
      
      
      // Apply mobile mode to existing Color Filter overlay dynamically
      applyMobileModeToColorFilter(tempMobileMode);
      
      // Update top bar visibility
      createTopProgressBar();
      startTopBarAutoUpdate();

      // Refresh palette badges immediately after applying settings
      try {
        const stats = templateManager.calculateRemainingPixelsByColor(0, true); // Only enabled templates
        updatePaletteLeftBadges(stats);
      } catch (e) {
        console.warn('Failed to refresh palette left badges after apply:', e);
      }
      
      // Success feedback
      applyButton.style.background = 'linear-gradient(135deg, var(--emerald-600), var(--emerald-700))';
      applyButton.textContent = 'Applied! ✓';
      
      // Update mini tracker visibility and restart auto-update
      updateMiniTracker();
      startMiniTrackerAutoUpdate();
      
      // Force invalidate template caches to ensure borders are applied
      if (templateManager.templatesArray && templateManager.templatesArray.length > 0) {
        templateManager.templatesArray.forEach(template => {
          if (template.invalidateEnhancedCache) {
            template.invalidateEnhancedCache();
          }
        });
      }
      
      // Refresh template display to apply new settings
      await refreshTemplateDisplay();
      
      // Close overlay after short delay
      setTimeout(() => {
        settingsOverlay.remove();
        overlayMain.handleDisplayStatus(`Crosshair settings applied: ${tempColor.name}, ${tempBorderEnabled ? 'with' : 'without'} borders, tracker ${tempMiniTrackerEnabled ? 'enabled' : 'disabled'}, collapse ${tempCollapseMinEnabled ? 'enabled' : 'disabled'}, mobile ${tempMobileMode ? 'enabled' : 'disabled'}, Left-on-Color ${tempShowLeftOnColor ? 'enabled' : 'disabled'}!`);
      }, 800);
      
      debugLog('Crosshair settings successfully applied and templates refreshed');
    } catch (error) {
      // Error feedback
      applyButton.style.background = 'linear-gradient(135deg, #ef4444, #dc2626)';
      applyButton.textContent = 'Error! ✗';
      
      setTimeout(() => {
        applyButton.style.background = originalBg;
        applyButton.textContent = originalText;
        applyButton.style.transform = 'scale(1)';
        applyButton.disabled = false;
      }, 2000);
      
      console.error('❌ Error applying crosshair settings:', error);
      overlayMain.handleDisplayError('Failed to apply crosshair settings');
    }
  };

  actionsContainer.appendChild(cancelButton);
  actionsContainer.appendChild(applyButton);
  footerContainer.appendChild(actionsContainer);

  // Create scrollable content container for fixed header solution
  const contentContainer = document.createElement('div');
  const contentPadding = isMobileMode ? '12px' : '20px';
  contentContainer.style.cssText = `
    overflow-y: auto;
    flex: 1;
    min-height: 0;
    padding: ${contentPadding};
    position: relative;
    z-index: 1;
  `;

  // Assemble overlay with fixed header and footer
  settingsOverlay.appendChild(header);
  contentContainer.appendChild(instructions);
  contentContainer.appendChild(currentColorPreview);
  contentContainer.appendChild(colorGrid);
  contentContainer.appendChild(alphaSection);
  contentContainer.appendChild(borderSection);


  // Overlay Elements Visibility Settings
  const overlayVisibilitySection = document.createElement('div');
  overlayVisibilitySection.style.cssText = `
    background: linear-gradient(135deg, var(--slate-800), var(--slate-750));
    border: 1px solid var(--slate-700);
    border-radius: ${sectionBorderRadius};
    padding: ${sectionPadding};
    margin-bottom: ${sectionMargin};
    position: relative;
    z-index: 1;`;

  const overlayVisibilityTitle = document.createElement('div');
  overlayVisibilityTitle.textContent = 'Overlay Elements Visibility:';
  overlayVisibilityTitle.style.cssText = `
    font-size: 1em; 
    margin-bottom: 12px; 
    color: var(--slate-200); 
    font-weight: 600;
  `;

  // Create checkboxes container
  const checkboxContainer = document.createElement('div');
  checkboxContainer.style.cssText = `
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
  `;

  // Helper function to create checkbox
  const createVisibilityCheckbox = (key, label, elementId) => {
    const checkboxDiv = document.createElement('div');
    checkboxDiv.style.cssText = 'display: flex; align-items: center; gap: 8px;';
    
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.style.cssText = 'accent-color: var(--blue-500);';
    
    // Load saved value
    let savedValue;
    try { 
      savedValue = JSON.parse(localStorage.getItem(key) ?? 'true'); 
    } catch(e) { 
      savedValue = true; 
    }
    checkbox.checked = savedValue;
    
    const text = document.createElement('span');
    text.textContent = label;
    text.style.cssText = 'color: var(--slate-300); font-size: 0.9em; cursor: pointer;';
    
    const changeHandler = () => {
      const next = !!checkbox.checked;
      localStorage.setItem(key, JSON.stringify(next));
      
      if (elementId) {
        const el = document.getElementById(elementId);
        if (el) {
          el.style.display = next ? '' : 'none';
        }
      } else {
        // For headers, apply visibility
        applyHeaderVisibility(key, next);
      }
    };
    
    checkbox.onchange = changeHandler;
    text.onclick = () => { checkbox.checked = !checkbox.checked; changeHandler(); };
    
    checkboxDiv.appendChild(checkbox);
    checkboxDiv.appendChild(text);
    return checkboxDiv;
  };

  // Add all checkboxes
  checkboxContainer.appendChild(createVisibilityCheckbox('bmShowInformationHeader', 'Information Header'));
  checkboxContainer.appendChild(createVisibilityCheckbox('bmShowTemplateHeader', 'Template Header'));
  checkboxContainer.appendChild(createVisibilityCheckbox('bmShowUsername', 'Username', 'bm-user-name'));
  checkboxContainer.appendChild(createVisibilityCheckbox('bmShowDroplets', 'Droplets', 'bm-user-droplets'));
  checkboxContainer.appendChild(createVisibilityCheckbox('bmShowNextLevel', 'Next Level', 'bm-user-nextlevel'));
  checkboxContainer.appendChild(createVisibilityCheckbox('bmShowFullCharge', 'Full Charge', 'bm-user-fullcharge'));
  checkboxContainer.appendChild(createVisibilityCheckbox('bmShowColorMenu', 'Color Menu (Beta Test)', 'bm-color-menu'));
  

  overlayVisibilitySection.appendChild(overlayVisibilityTitle);
  overlayVisibilitySection.appendChild(checkboxContainer);
  contentContainer.appendChild(overlayVisibilitySection);

  contentContainer.appendChild(sizeSection);
  contentContainer.appendChild(radiusSection);
  contentContainer.appendChild(trackerSection);
  
  // Show Left number on color cards (compact mode)
  const leftOnColorSection = document.createElement('div');
  leftOnColorSection.style.cssText = `
    background: linear-gradient(135deg, var(--slate-800), var(--slate-750));
    border: 1px solid var(--slate-700);
    border-radius: ${sectionBorderRadius};
    padding: ${sectionPadding};
    margin-bottom: ${sectionMargin};
    position: relative;
    z-index: 1;
  `;
  const leftOnColorLabel = document.createElement('div');
  leftOnColorLabel.textContent = 'Display Left number on color cards:';
  leftOnColorLabel.style.cssText = `
    font-size: 1em; 
    margin-bottom: 12px; 
    color: var(--slate-200);
    font-weight: 600;
    letter-spacing: -0.01em;
  `;
  const leftOnColorDescription = document.createElement('div');
  leftOnColorDescription.textContent = 'Displays just the remaining pixels number centered on each color.';
  leftOnColorDescription.style.cssText = `
    font-size: 0.9em; 
    color: var(--slate-300); 
    margin-bottom: 16px; 
    line-height: 1.4;
    letter-spacing: -0.005em;
  `;
  const leftOnColorToggle = document.createElement('div');
  leftOnColorToggle.style.cssText = `
    display: flex;
    align-items: center;
    gap: 8px;
  `;
  const leftOnColorCheckbox = document.createElement('input');
  leftOnColorCheckbox.type = 'checkbox';
  leftOnColorCheckbox.checked = tempShowLeftOnColor;
  leftOnColorCheckbox.style.cssText = `
    width: 16px;
    height: 16px;
    cursor: pointer;
  `;
  const leftOnColorToggleText = document.createElement('span');
  leftOnColorToggleText.textContent = tempShowLeftOnColor ? 'Enabled' : 'Disabled';
  leftOnColorToggleText.style.cssText = `
    color: ${tempShowLeftOnColor ? '#4caf50' : '#f44336'};
    font-weight: bold;
    cursor: pointer;
  `;
  const updateLeftOnColorState = () => {
    tempShowLeftOnColor = leftOnColorCheckbox.checked;
    leftOnColorToggleText.textContent = tempShowLeftOnColor ? 'Enabled' : 'Disabled';
    leftOnColorToggleText.style.color = tempShowLeftOnColor ? '#4caf50' : '#f44336';
  };
  leftOnColorCheckbox.addEventListener('change', updateLeftOnColorState);
  leftOnColorToggleText.onclick = (e) => {
    e.stopPropagation();
    leftOnColorCheckbox.checked = !leftOnColorCheckbox.checked;
    updateLeftOnColorState();
  };
  leftOnColorToggle.style.cursor = 'default';
  leftOnColorToggle.appendChild(leftOnColorCheckbox);
  leftOnColorToggle.appendChild(leftOnColorToggleText);
  // Visual estado verde/vermelho no container
  const applyLeftOnColorToggleVisual = () => {
    leftOnColorToggleText.style.background = '';
    leftOnColorToggleText.style.border = '';
    leftOnColorToggleText.style.padding = '';
    leftOnColorToggleText.style.borderRadius = '';
    leftOnColorToggleText.style.color = tempShowLeftOnColor ? '#4caf50' : '#f44336';
    leftOnColorToggleText.textContent = tempShowLeftOnColor ? 'Enabled' : 'Disabled';
  };
  applyLeftOnColorToggleVisual();
  // Hook on change
  const oldUpdateLeftOnColorState = updateLeftOnColorState;
  const updateLeftOnColorStateWrapped = () => {
    oldUpdateLeftOnColorState();
    applyLeftOnColorToggleVisual();
  };
  leftOnColorCheckbox.removeEventListener('change', updateLeftOnColorState);
  leftOnColorCheckbox.addEventListener('change', updateLeftOnColorStateWrapped);
  // Make TEXT clickable too
  leftOnColorToggleText.onclick = (e) => {
    e.stopPropagation();
    leftOnColorCheckbox.checked = !leftOnColorCheckbox.checked;
    updateLeftOnColorStateWrapped();
  };
  leftOnColorSection.appendChild(leftOnColorLabel);
  leftOnColorSection.appendChild(leftOnColorDescription);
  leftOnColorSection.appendChild(leftOnColorToggle);
  contentContainer.appendChild(mobileSection);
  contentContainer.appendChild(leftOnColorSection);

  // Navigation method section
  const navigationSection = document.createElement('div');
  navigationSection.style.cssText = `
    background: linear-gradient(135deg, var(--slate-800), var(--slate-750));
    border: 1px solid var(--slate-700);
    border-radius: ${sectionBorderRadius};
    padding: ${sectionPadding};
    margin-bottom: ${sectionMargin};
    position: relative;
    z-index: 1;
  `;

  const navigationLabel = document.createElement('h3');
  navigationLabel.textContent = 'Navigation Method';
  navigationLabel.style.cssText = `
    margin: 0 0 8px 0;
    color: var(--slate-100);
    font-size: 1em;
    font-weight: 700;
    letter-spacing: -0.01em;
  `;

  const navigationDescription = document.createElement('p');
  navigationDescription.textContent = 'Choose how to navigate when clicking search results and favorites';
  navigationDescription.style.cssText = `
    margin: 0 0 16px 0;
    color: var(--slate-400);
    font-size: 0.85em;
    line-height: 1.4;
  `;

  // Get current navigation method setting (single source of truth)
  let tempNavigationMethod = Settings.getNavigationMethod();

  const navigationToggle = document.createElement('div');
  navigationToggle.style.cssText = `
    display: flex;
    gap: 8px;
    padding: 4px;
    background: var(--slate-900);
    border-radius: 8px;
    border: 1px solid var(--slate-600);
  `;

  const flytoButton = document.createElement('button');
  flytoButton.textContent = 'FlyTo';
  flytoButton.style.cssText = `
    flex: 1;
    padding: 8px 12px;
    border: none;
    border-radius: 6px;
    cursor: pointer;
    font-size: 0.9em;
    font-weight: 600;
    transition: all 0.2s ease;
    ${tempNavigationMethod === 'flyto' 
      ? 'background: linear-gradient(135deg, var(--blue-500), var(--blue-600)); color: white;'
      : 'background: transparent; color: var(--slate-300);'
    }
  `;

  const openurlButton = document.createElement('button');
  openurlButton.textContent = 'OpenURL';
  openurlButton.style.cssText = `
    flex: 1;
    padding: 8px 12px;
    border: none;
    border-radius: 6px;
    cursor: pointer;
    font-size: 0.9em;
    font-weight: 600;
    transition: all 0.2s ease;
    ${tempNavigationMethod === 'openurl' 
      ? 'background: linear-gradient(135deg, var(--blue-500), var(--blue-600)); color: white;'
      : 'background: transparent; color: var(--slate-300);'
    }
  `;

  flytoButton.onclick = () => {
    tempNavigationMethod = 'flyto';
    flytoButton.style.background = 'linear-gradient(135deg, var(--blue-500), var(--blue-600))';
    flytoButton.style.color = 'white';
    openurlButton.style.background = 'transparent';
    openurlButton.style.color = 'var(--slate-300)';
  };

  openurlButton.onclick = () => {
    tempNavigationMethod = 'openurl';
    openurlButton.style.background = 'linear-gradient(135deg, var(--blue-500), var(--blue-600))';
    openurlButton.style.color = 'white';
    flytoButton.style.background = 'transparent';
    flytoButton.style.color = 'var(--slate-300)';
  };

  navigationToggle.appendChild(flytoButton);
  navigationToggle.appendChild(openurlButton);
  navigationSection.appendChild(navigationLabel);
  navigationSection.appendChild(navigationDescription);
  navigationSection.appendChild(navigationToggle);
  contentContainer.appendChild(navigationSection);
  contentContainer.appendChild(dragModeSection);

  // Smart Tile Cache section
  const cacheSection = document.createElement('div');
  cacheSection.style.cssText = `
    background: linear-gradient(135deg, var(--slate-800), var(--slate-750));
    border: 1px solid var(--slate-700);
    border-radius: ${sectionBorderRadius};
    padding: ${sectionPadding};
    margin-bottom: ${sectionMargin};
    position: relative;
    z-index: 1;
  `;

  const cacheLabel = document.createElement('h3');
  cacheLabel.textContent = 'Tile Cache';
  cacheLabel.style.cssText = `
    margin: 0 0 8px 0;
    color: var(--slate-100);
    font-size: 1em;
    font-weight: 700;
    letter-spacing: -0.01em;
  `;

  const cacheDescription = document.createElement('p');
  cacheDescription.textContent = 'Cache processed tiles to reduce lag when revisiting areas. Automatically detects canvas changes.';
  cacheDescription.style.cssText = `
    margin: 0 0 12px 0;
    color: var(--slate-400);
    font-size: 0.85em;
    line-height: 1.4;
  `;

  // Get current cache stats
  const cacheStats = getSmartCacheStats();
  let tempCacheEnabled = cacheStats.enabled;

  // Cache statistics display
  const cacheStatsDisplay = document.createElement('div');
  cacheStatsDisplay.style.cssText = `
    background: var(--slate-900);
    border: 1px solid var(--slate-600);
    border-radius: 6px;
    padding: 8px 12px;
    margin-bottom: 12px;
    font-family: 'Courier New', monospace;
    font-size: 0.8em;
    color: var(--slate-300);
    line-height: 1.3;
  `;
  
  function updateCacheStatsDisplay() {
    const stats = getSmartCacheStats();
    cacheStatsDisplay.innerHTML = `
      <div>Status: <span style="color: ${stats.enabled ? 'var(--emerald-400)' : 'var(--red-400)'};">${stats.enabled ? 'ENABLED' : 'DISABLED'}</span></div>
      <div>Cached Tiles: <span style="color: var(--blue-400);">${stats.size}</span>/${stats.maxSize}</div>
    `;
  }
  
  updateCacheStatsDisplay();

  const cacheToggle = document.createElement('div');
  cacheToggle.style.cssText = `
    display: flex;
    gap: 8px;
    padding: 4px;
    background: var(--slate-900);
    border-radius: 8px;
    border: 1px solid var(--slate-600);
  `;

  const cacheOffButton = document.createElement('button');
  cacheOffButton.textContent = 'OFF';
  cacheOffButton.style.cssText = `
    flex: 1 1 0%;
    padding: 8px 12px;
    border: none;
    border-radius: 6px;
    cursor: pointer;
    font-size: 0.9em;
    font-weight: 600;
    transition: 0.2s;
    ${!tempCacheEnabled ? 
      'background: linear-gradient(135deg, var(--blue-500), var(--blue-600)); color: white;' : 
      'background: var(--slate-700); color: var(--slate-300);'}
  `;

  const cacheOnButton = document.createElement('button');
  cacheOnButton.textContent = 'ON';
  cacheOnButton.style.cssText = `
    flex: 1 1 0%;
    padding: 8px 12px;
    border: none;
    border-radius: 6px;
    cursor: pointer;
    font-size: 0.9em;
    font-weight: 600;
    transition: 0.2s;
    ${tempCacheEnabled ? 
      'background: linear-gradient(135deg, var(--blue-500), var(--blue-600)); color: white;' : 
      'background: var(--slate-700); color: var(--slate-300);'}
  `;

  cacheOffButton.onclick = () => {
    if (tempCacheEnabled) {
      tempCacheEnabled = false;
      cacheOffButton.style.cssText = `
        flex: 1 1 0%;
        padding: 8px 12px;
        border: none;
        border-radius: 6px;
        cursor: pointer;
        font-size: 0.9em;
        font-weight: 600;
        transition: 0.2s;
        background: linear-gradient(135deg, var(--blue-500), var(--blue-600));
        color: white;
      `;
      cacheOnButton.style.cssText = `
        flex: 1 1 0%;
        padding: 8px 12px;
        border: none;
        border-radius: 6px;
        cursor: pointer;
        font-size: 0.9em;
        font-weight: 600;
        transition: 0.2s;
        background: var(--slate-700);
        color: var(--slate-300);
      `;
    }
  };

  cacheOnButton.onclick = () => {
    if (!tempCacheEnabled) {
      tempCacheEnabled = true;
      cacheOnButton.style.cssText = `
        flex: 1 1 0%;
        padding: 8px 12px;
        border: none;
        border-radius: 6px;
        cursor: pointer;
        font-size: 0.9em;
        font-weight: 600;
        transition: 0.2s;
        background: linear-gradient(135deg, var(--blue-500), var(--blue-600));
        color: white;
      `;
      cacheOffButton.style.cssText = `
        flex: 1 1 0%;
        padding: 8px 12px;
        border: none;
        border-radius: 6px;
        cursor: pointer;
        font-size: 0.9em;
        font-weight: 600;
        transition: 0.2s;
        background: var(--slate-700);
        color: var(--slate-300);
      `;
    }
  };

  cacheToggle.appendChild(cacheOffButton);
  cacheToggle.appendChild(cacheOnButton);

  cacheSection.appendChild(cacheLabel);
  cacheSection.appendChild(cacheDescription);
  cacheSection.appendChild(cacheStatsDisplay);
  cacheSection.appendChild(cacheToggle);

  contentContainer.appendChild(cacheSection);

  // Debug logging section
  const debugSection = document.createElement('div');
  debugSection.style.cssText = `
    background: linear-gradient(135deg, var(--slate-800), var(--slate-750));
    border: 1px solid var(--slate-700);
    border-radius: ${sectionBorderRadius};
    padding: ${sectionPadding};
    margin-bottom: ${sectionMargin};
    position: relative;
    z-index: 1;
  `;

  const debugLabel = document.createElement('h3');
  debugLabel.textContent = 'Debug Console Logging';
  debugLabel.style.cssText = `
    margin: 0 0 8px 0;
    color: var(--slate-100);
    font-size: 1em;
    font-weight: 700;
    letter-spacing: -0.01em;
  `;

  const debugDescription = document.createElement('p');
  debugDescription.textContent = 'Enable debug console messages for troubleshooting';
  debugDescription.style.cssText = `
    margin: 0 0 16px 0;
    color: var(--slate-400);
    font-size: 0.85em;
    line-height: 1.4;
  `;

  // Get current debug setting (default off)
  let tempDebugEnabled = getDebugLoggingEnabled();

  const debugToggle = document.createElement('div');
  debugToggle.style.cssText = `
    display: flex;
    gap: 8px;
    padding: 4px;
    background: var(--slate-900);
    border-radius: 8px;
    border: 1px solid var(--slate-600);
  `;

  const debugOffButton = document.createElement('button');
  debugOffButton.textContent = 'OFF';
  debugOffButton.style.cssText = `
    flex: 1;
    padding: 8px 12px;
    border: none;
    border-radius: 6px;
    cursor: pointer;
    font-size: 0.9em;
    font-weight: 600;
    transition: all 0.2s ease;
    ${!tempDebugEnabled 
      ? 'background: linear-gradient(135deg, var(--blue-500), var(--blue-600)); color: white;'
      : 'background: transparent; color: var(--slate-300);'
    }
  `;

  const debugOnButton = document.createElement('button');
  debugOnButton.textContent = 'ON';
  debugOnButton.style.cssText = `
    flex: 1;
    padding: 8px 12px;
    border: none;
    border-radius: 6px;
    cursor: pointer;
    font-size: 0.9em;
    font-weight: 600;
    transition: all 0.2s ease;
    ${tempDebugEnabled 
      ? 'background: linear-gradient(135deg, var(--blue-500), var(--blue-600)); color: white;'
      : 'background: transparent; color: var(--slate-300);'
    }
  `;

  debugOffButton.onclick = () => {
    tempDebugEnabled = false;
    debugOffButton.style.cssText = debugOffButton.style.cssText.replace(
      /background: [^;]+;/,
      'background: linear-gradient(135deg, var(--blue-500), var(--blue-600));'
    ).replace(/color: [^;]+;/, 'color: white;');
    debugOnButton.style.cssText = debugOnButton.style.cssText.replace(
      /background: [^;]+;/,
      'background: transparent;'
    ).replace(/color: [^;]+;/, 'color: var(--slate-300);');
  };

  debugOnButton.onclick = () => {
    tempDebugEnabled = true;
    debugOnButton.style.cssText = debugOnButton.style.cssText.replace(
      /background: [^;]+;/,
      'background: linear-gradient(135deg, var(--blue-500), var(--blue-600));'
    ).replace(/color: [^;]+;/, 'color: white;');
    debugOffButton.style.cssText = debugOffButton.style.cssText.replace(
      /background: [^;]+;/,
      'background: transparent;'
    ).replace(/color: [^;]+;/, 'color: var(--slate-300);');
  };

  debugToggle.appendChild(debugOffButton);
  debugToggle.appendChild(debugOnButton);
  debugSection.appendChild(debugLabel);
  debugSection.appendChild(debugDescription);
  debugSection.appendChild(debugToggle);
  contentContainer.appendChild(debugSection);

  settingsOverlay.appendChild(contentContainer);
  settingsOverlay.appendChild(footerContainer);
  document.body.appendChild(settingsOverlay);

    // Add drag functionality
    let isDragging = false;
    let dragStartX = 0;
    let dragStartY = 0;
    let initialLeft = 0;
    let initialTop = 0;

    header.addEventListener('mousedown', (e) => {
      isDragging = true;
      dragStartX = e.clientX;
      dragStartY = e.clientY;
      
      const rect = settingsOverlay.getBoundingClientRect();
      initialLeft = rect.left;
      initialTop = rect.top;
      
      settingsOverlay.style.position = 'fixed';
      settingsOverlay.style.transform = 'none';
      settingsOverlay.style.left = initialLeft + 'px';
      settingsOverlay.style.top = initialTop + 'px';
      
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      
      const deltaX = e.clientX - dragStartX;
      const deltaY = e.clientY - dragStartY;
      
      const newLeft = initialLeft + deltaX;
      const newTop = initialTop + deltaY;
      
      const maxLeft = window.innerWidth - settingsOverlay.offsetWidth;
      const maxTop = window.innerHeight - settingsOverlay.offsetHeight;
      
      const clampedLeft = Math.max(0, Math.min(newLeft, maxLeft));
      const clampedTop = Math.max(0, Math.min(newTop, maxTop));
      
      settingsOverlay.style.left = clampedLeft + 'px';
      settingsOverlay.style.top = clampedTop + 'px';
    });

    document.addEventListener('mouseup', () => {
      isDragging = false;
    });
    
  } catch (error) {
    console.error('Failed to build Crosshair Settings overlay:', error);
    overlayMain.handleDisplayError('Failed to open Crosshair Settings');
  }
}

// Add Search Functionality
function createSearchWindow() {
  // Check if search window already exists to prevent duplicates
  if (document.getElementById('skirk-search-draggable')) {
    console.warn('Search window already exists, skipping creation');
    return;
  }

  const searchPanel = document.createElement('div');
  searchPanel.id = 'skirk-search-draggable';
  searchPanel.innerHTML = `
<div class="drag-handle"></div>
<div class="hdr">
  <h3>
    <img class="skirk-icon" src="https://raw.githubusercontent.com/Seris0/Wplace-SkirkMarble/main/dist/assets/Favicon.png" alt="Blue Marble" style="width:42px;height:42px;">
    Location Search
  </h3>
  <div class="actions">
    <button id="skirk-location-btn">Location</button>
    <button id="skirk-search-close">Close</button>
  </div>
</div>
<div class="body">
  <input type="text" id="skirk-search-input" placeholder="Search for a place...">
  <div id="skirk-search-results"></div>
  <div id="skirk-favorites-menu" style="display: none;">
    <div id="skirk-favorites-header">
      <div id="skirk-favorites-title" style="cursor: pointer;">
        <span id="skirk-favorites-toggle">▼</span> ⭐ Favorites
        <span id="skirk-favorites-count">0</span>
      </div>

      <button id="skirk-clear-favorites">Clear All</button>
    </div>
    <input type="text" id="skirk-favorites-filter" class="skirk-favorites-filter" placeholder="Filter favorites...">
    <div id="skirk-favorites-list"></div>
  </div>
</div>`;
  document.body.appendChild(searchPanel);

  // Close logic
  searchPanel.querySelector('#skirk-search-close').addEventListener('click', () => searchPanel.style.display = 'none');

  // Favorites management
  const FAVORITES_KEY = 'bm-search-favorites';
  
  function getFavorites() {
    try {
      const stored = localStorage.getItem(FAVORITES_KEY);
      if (stored === null || stored === undefined) {
        return [];
      }
      const parsed = JSON.parse(stored);
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      console.error('Error getting favorites:', error);
      return [];
    }
  }
  
  function getFilteredFavorites(filterValue) {
    const list = getFavorites();
    const query = (filterValue || '').toLowerCase();
    if (!query) {return list;}
    return list.filter(fav => {
      const a = `${fav.primaryName || ''} ${fav.secondaryInfo || ''} ${fav.fullAddress || ''}`.toLowerCase();
      return a.includes(query);
    });
  }
  
  function saveFavorites(favorites) {
    try {
      localStorage.setItem(FAVORITES_KEY, JSON.stringify(favorites));
      updateFavoritesDisplay();
    } catch (error) {
      console.error('Error saving favorites:', error);
    }
  }
  
  function addFavorite(location) {
    const favorites = getFavorites();
    const exists = favorites.find(fav => fav.lat === location.lat && fav.lon === location.lon);
    if (!exists) {
      favorites.push(location);
      saveFavorites(favorites);
    }
  }
  
  function removeFavorite(lat, lon) {
    const favorites = getFavorites();
    const filtered = favorites.filter(fav => !(fav.lat === lat && fav.lon === lon));
    saveFavorites(filtered);
  }
  
  function isFavorited(lat, lon) {
    const favorites = getFavorites();
    return favorites.some(fav => fav.lat === lat && fav.lon === lon);
  }
  
  function updateFavoritesDisplay() {
    const filterInput = searchPanel.querySelector('#skirk-favorites-filter');
    const filterText = filterInput ? filterInput.value : '';
    const allFavorites = getFavorites();
    const favorites = getFilteredFavorites(filterText);
    const favoritesMenu = searchPanel.querySelector('#skirk-favorites-menu');
    const favoritesCount = searchPanel.querySelector('#skirk-favorites-count');
    const favoritesList = searchPanel.querySelector('#skirk-favorites-list');
    
    // Always show total number saved, not filtered count
    favoritesCount.textContent = allFavorites.length;
    
    if (allFavorites.length > 0) {
      favoritesMenu.style.display = 'block';
      favoritesList.innerHTML = '';
      
      if (favorites.length === 0) {
        favoritesList.innerHTML = '<div class="skirk-no-results">No favorites match your filter</div>';
        return;
      }
      
      favorites.forEach(favorite => {
        const favoriteItem = document.createElement('div');
        favoriteItem.className = 'skirk-favorite-item';
        
        favoriteItem.innerHTML = `
          <div class="skirk-result-content">
            <div class="skirk-result-name">${favorite.primaryName}</div>
            <div class="skirk-result-address">${favorite.secondaryInfo}</div>
          </div>
          <span class="skirk-favorite-remove" title="Remove from favorites">×</span>
        `;
        
        // Click to navigate
        favoriteItem.querySelector('.skirk-result-content').addEventListener('click', () => {
          navigateToLocation(favorite.lat, favorite.lon);
          searchPanel.style.display = 'none';
        });
        
        // Click to remove
        favoriteItem.querySelector('.skirk-favorite-remove').addEventListener('click', (e) => {
          e.stopPropagation();
          removeFavorite(favorite.lat, favorite.lon);
        });
        
        favoritesList.appendChild(favoriteItem);
      });
    } else {
      favoritesMenu.style.display = 'none';
    }
  }
  
  // Clear all favorites
  searchPanel.querySelector('#skirk-clear-favorites').addEventListener('click', () => {
    if (confirm('Are you sure you want to clear all favorites?')) {
      saveFavorites([]);
    }
  });
  
  // Favorites filter input
  const favoritesFilterInput = searchPanel.querySelector('#skirk-favorites-filter');
  if (favoritesFilterInput) {
    let favFilterTimeout;
    const onFilterChange = () => {
      clearTimeout(favFilterTimeout);
      favFilterTimeout = setTimeout(() => updateFavoritesDisplay(), 120);
    };
    favoritesFilterInput.addEventListener('input', onFilterChange);
  }
  
  // Initialize favorites display
  updateFavoritesDisplay();

  // Create modals
  const locationModal = document.createElement('div');
  locationModal.id = 'skirk-location-modal';
  locationModal.innerHTML = `
    <div id="skirk-location-dialog">
      <h3>Add Custom Location</h3>
      <div class="form-group">
        <label for="location-name">Name:</label>
        <input type="text" id="location-name" placeholder="e.g., My House, My Art, Work">
      </div>
      
      <div class="form-group">
        <label for="location-link">Paste wplace.live link:</label>
        <input type="text" id="location-link" placeholder="https://wplace.live/?lat=-19.037942104984218&lng=-42.420498378222675&zoom=16.078281108991245">
      </div>
      
      <div class="form-group" style="display: flex; gap: 8px;">
        <div style="flex: 1;">
          <label for="location-lat">Latitude:</label>
          <input type="text" id="location-lat" placeholder="e.g., -23.5506507" readonly>
        </div>
        <div style="flex: 1;">
          <label for="location-lon">Longitude:</label>
          <input type="text" id="location-lon" placeholder="e.g., -46.6333824" readonly>
        </div>
      </div>
      
      <div class="button-group">
        <button class="btn-secondary" id="location-cancel">Cancel</button>
        <button class="btn-primary" id="location-save">Save to Favorites</button>
      </div>
    </div>
  `;
  document.body.appendChild(locationModal);



  // Location button logic
  searchPanel.querySelector('#skirk-location-btn').addEventListener('click', () => {
    locationModal.style.display = 'flex';
    locationModal.querySelector('#location-name').focus();
  });

  // Add link parsing functionality
  const linkInput = locationModal.querySelector('#location-link');
  const latInput = locationModal.querySelector('#location-lat');
  const lonInput = locationModal.querySelector('#location-lon');
  
  linkInput.addEventListener('input', () => {
    const link = linkInput.value.trim();
    if (!link) {
      latInput.value = '';
      lonInput.value = '';
      return;
    }
    
    // Extract lat and lng from wplace.live URL
    const latMatch = link.match(/lat=([^&]+)/);
    const lngMatch = link.match(/lng=([^&]+)/);
    
    if (latMatch && lngMatch) {
      const lat = parseFloat(latMatch[1]);
      const lng = parseFloat(lngMatch[1]);
      
      if (!isNaN(lat) && !isNaN(lng)) {
        latInput.value = lat.toString();
        lonInput.value = lng.toString();
        latInput.style.color = '#4ade80'; // Green to indicate success
        lonInput.style.color = '#4ade80';
      } else {
        latInput.value = '';
        lonInput.value = '';
        latInput.style.color = '#f87171'; // Red to indicate error
        lonInput.style.color = '#f87171';
      }
    } else {
      latInput.value = '';
      lonInput.value = '';
      latInput.style.color = '#f87171'; // Red to indicate invalid format
      lonInput.style.color = '#f87171';
    }
  });

  // Location modal logic
  locationModal.querySelector('#location-cancel').addEventListener('click', () => {
    locationModal.style.display = 'none';
    locationModal.querySelector('#location-name').value = '';
    locationModal.querySelector('#location-link').value = '';
    locationModal.querySelector('#location-lat').value = '';
    locationModal.querySelector('#location-lon').value = '';
    latInput.style.color = '#f1f5f9'; // Reset color
    lonInput.style.color = '#f1f5f9';
  });

  locationModal.querySelector('#location-save').addEventListener('click', () => {
    const name = locationModal.querySelector('#location-name').value.trim();
    const lat = locationModal.querySelector('#location-lat').value.trim();
    const lon = locationModal.querySelector('#location-lon').value.trim();

    if (!name || !lat || !lon) {
      alert('Please fill all fields');
      return;
    }

    if (isNaN(parseFloat(lat)) || isNaN(parseFloat(lon))) {
      alert('Please enter valid coordinates');
      return;
    }

    const locationData = {
      lat: lat,
      lon: lon,
      primaryName: name,
      secondaryInfo: `Custom Location (${lat}, ${lon})`,
      fullAddress: ''
    };

    addFavorite(locationData);
    locationModal.style.display = 'none';
    locationModal.querySelector('#location-name').value = '';
    locationModal.querySelector('#location-link').value = '';
    locationModal.querySelector('#location-lat').value = '';
    locationModal.querySelector('#location-lon').value = '';
    latInput.style.color = '#f1f5f9'; // Reset color
    lonInput.style.color = '#f1f5f9';
  });

  // Close modal on outside click
  locationModal.addEventListener('click', (e) => {
    if (e.target === locationModal) {
      locationModal.querySelector('#location-cancel').click();
    }
  });

  // Favorites collapse toggle
  let favoritesCollapsed = false;
  searchPanel.querySelector('#skirk-favorites-title').addEventListener('click', () => {
    favoritesCollapsed = !favoritesCollapsed;
    const toggle = searchPanel.querySelector('#skirk-favorites-toggle');
    const list = searchPanel.querySelector('#skirk-favorites-list');
    
    if (favoritesCollapsed) {
      toggle.classList.add('collapsed');
      list.style.display = 'none';
    } else {
      toggle.classList.remove('collapsed');
      list.style.display = 'block';
    }
  });





  // Drag logic
  const dragHandle = searchPanel.querySelector('.drag-handle');
  let isDragging = false, dragOriginX = 0, dragOriginY = 0, dragOffsetX = 0, dragOffsetY = 0, animationId = 0;

  function getTransformXY(el) {
    const computed = window.getComputedStyle(el).transform;
    if (computed && computed !== 'none') {
      const matrix = new DOMMatrix(computed);
      return [matrix.m41, matrix.m42];
    }
    return [0, 0];
  }

  function animate() {
    if (isDragging) {
      searchPanel.style.transform = `translate(${dragOffsetX}px, ${dragOffsetY}px)`;
      animationId = requestAnimationFrame(animate);
    }
  }

  function startDrag(clientX, clientY) {
    isDragging = true;
    searchPanel.classList.add('dragging');
    const rect = searchPanel.getBoundingClientRect();
    let [curX, curY] = getTransformXY(searchPanel);
    dragOriginX = clientX - rect.left;
    dragOriginY = clientY - rect.top;
    searchPanel.style.left = "0px";
    searchPanel.style.top = "0px";
    searchPanel.style.right = "auto";
    searchPanel.style.bottom = "auto";
    searchPanel.style.position = "fixed";
    if (curX === 0 && curY === 0) {
      dragOffsetX = rect.left;
      dragOffsetY = rect.top;
      searchPanel.style.transform = `translate(${dragOffsetX}px, ${dragOffsetY}px)`;
    } else {
      dragOffsetX = curX;
      dragOffsetY = curY;
    }
    document.body.style.userSelect = "none";
    if (animationId) cancelAnimationFrame(animationId);
    animate();
  }

  function stopDrag() {
    isDragging = false;
    if (animationId) cancelAnimationFrame(animationId);
    document.body.style.userSelect = "";
    searchPanel.classList.remove('dragging');
  }

  function doDrag(clientX, clientY) {
    if (!isDragging) return;
    dragOffsetX = clientX - dragOriginX;
    dragOffsetY = clientY - dragOriginY;
  }

  dragHandle.addEventListener("mousedown", function(e) {
    e.preventDefault();
    startDrag(e.clientX, e.clientY);
  });

  document.addEventListener("mousemove", function(e) {
    if (isDragging) doDrag(e.clientX, e.clientY);
  }, { passive: true });

  document.addEventListener("mouseup", stopDrag);

  dragHandle.addEventListener("touchstart", function(e) {
    const touch = e?.touches?.[0];
    if (touch) {
      startDrag(touch.clientX, touch.clientY);
      e.preventDefault();
    }
  }, { passive: false });

  document.addEventListener("touchmove", function(e) {
    if (isDragging) {
      const touch = e?.touches?.[0];
      if (!touch) return;
      doDrag(touch.clientX, touch.clientY);
      e.preventDefault();
    }
  }, { passive: false });

  document.addEventListener("touchend", stopDrag);
  document.addEventListener("touchcancel", stopDrag);

  // Search functionality
  const searchInput = searchPanel.querySelector('#skirk-search-input');
  const resultsContainer = searchPanel.querySelector('#skirk-search-results');

  function searchLocation(query) {
    return new Promise((resolve, reject) => {
      debugLog('Searching for:', query);
      GM_xmlhttpRequest({
        method: 'GET',
        url: `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=5&addressdetails=1`,
        headers: {
          'User-Agent': 'BlueMarble-Search-UserScript/1.0'
        },
        onload: function(response) {
          debugLog('Search API Response Status:', response.status);
          debugLog('Search API Response Text:', response.responseText);
          try {
            const data = JSON.parse(response.responseText);
            debugLog('Parsed data:', data);
            resolve(data);
          } catch (error) {
            console.error('JSON Parse error:', error);
            reject(error);
          }
        },
        onerror: function(error) {
          console.error('Search API error:', error);
          reject(error);
        }
      });
    });
  }

  function navigateToLocation(lat, lon) {
    const navigationMethod = Settings.getNavigationMethod();
    
    if (navigationMethod === 'openurl') {
    const zoom = 13.62;
    const url = `https://wplace.live/?lat=${lat}&lng=${lon}&zoom=${zoom}`;
    
    // Open in current tab (like the original)
    window.location.href = url;
    } else {
      flyToLatLng(lat, lon);
    }
  }

  function displayResults(results) {
    debugLog('Search results received:', results);
    
    if (results.length === 0) {
      resultsContainer.innerHTML = '<div class="skirk-no-results">No results found</div>';
      return;
    }

    resultsContainer.innerHTML = '';
    results.forEach(result => {
      debugLog('Raw result object:', result);
      debugLog('Object keys:', Object.keys(result));
      
      // Try to access properties directly from the raw object
      const displayName = result['display_name'] || result['name'] || 'Unknown location';
      const lat = result['lat'];
      const lon = result['lon'];
      
      debugLog('Extracted values:', {
        displayName: displayName,
        lat: lat,
        lon: lon
      });
      
      const resultItem = document.createElement('div');
      resultItem.className = 'skirk-search-result';

      // Store lat/lon directly on the element as data attributes
      resultItem.dataset.lat = String(lat || '');
      resultItem.dataset.lon = String(lon || '');

      // Show primary name + first part of address for better context
      const nameParts = displayName.split(',');
      const primaryName = nameParts[0]?.trim() || 'Unknown';
      const secondaryInfo = nameParts.slice(1, 3).join(',').trim(); // Show next 2 parts
      const fullAddress = nameParts.slice(3).join(',').trim(); // Rest of address

      debugLog('Display parts:', {
        primaryName: primaryName,
        secondaryInfo: secondaryInfo,
        fullAddress: fullAddress
      });

      resultItem.innerHTML = `
        <div class="skirk-result-content">
          <div class="skirk-result-name">${primaryName}</div>
          ${secondaryInfo ? `<div class="skirk-result-address secondary">${secondaryInfo}</div>` : ''}
          ${fullAddress ? `<div class="skirk-result-address">${fullAddress}</div>` : ''}
        </div>
        <span class="skirk-favorite-star ${isFavorited(lat, lon) ? 'favorited' : ''}" title="Add to favorites">★</span>
      `;

      // Handle content click (navigation)
      resultItem.querySelector('.skirk-result-content').addEventListener('click', (e) => {
        const latStr = e.currentTarget.parentElement.dataset.lat;
        const lonStr = e.currentTarget.parentElement.dataset.lon;
        debugLog('=== NAVIGATION DEBUG ===');
        debugLog('Clicking result with lat:', latStr, 'lon:', lonStr);
        debugLog('URL will be:', `https://wplace.live/?lat=${latStr}&lng=${lonStr}&zoom=14.62`);
        
        if (latStr && lonStr && latStr !== 'undefined' && lonStr !== 'undefined') {
          navigateToLocation(latStr, lonStr);
          searchPanel.style.display = 'none';
          searchInput.value = '';
          resultsContainer.innerHTML = '';
        } else {
          console.error('Invalid coordinates, not navigating');
          alert('Error: Invalid coordinates for this location');
        }
      });

      // Handle star click (favorites)
      resultItem.querySelector('.skirk-favorite-star').addEventListener('click', (e) => {
        e.stopPropagation();
        const star = e.target;
        const isFav = star.classList.contains('favorited');
        
        if (isFav) {
          removeFavorite(lat, lon);
          star.classList.remove('favorited');
          star.title = 'Add to favorites';
        } else {
          const locationData = {
            lat: lat,
            lon: lon,
            primaryName: primaryName,
            secondaryInfo: secondaryInfo || '',
            fullAddress: fullAddress || ''
          };
          addFavorite(locationData);
          star.classList.add('favorited');
          star.title = 'Remove from favorites';
        }
      });

      resultsContainer.appendChild(resultItem);
    });
  }

  async function handleSearch() {
    const query = searchInput.value.trim();
    if (!query) return;

    resultsContainer.innerHTML = '<div class="skirk-loading">Searching...</div>';

    try {
      const results = await searchLocation(query);
      displayResults(results);
    } catch (error) {
      console.error('Search error:', error);
      resultsContainer.innerHTML = '<div class="skirk-no-results">Error searching. Please try again.</div>';
    }
  }

  searchInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      handleSearch();
    }
  });

  let searchTimeout;
  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimeout);
    
    const query = searchInput.value.trim();
    if (!query) {
      // Clear results when search is empty
      resultsContainer.innerHTML = '';
      return;
    }
    
    searchTimeout = setTimeout(handleSearch, 500); // Debounce search
  });
}

// Initialize search window when DOM is ready - FIXED LOGIC
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', createSearchWindow);
} else {
  createSearchWindow();
}