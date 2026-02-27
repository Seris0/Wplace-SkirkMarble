/** ApiManager class for handling API requests, responses, and interactions.
 * Note: Fetch spying is done in main.js, not here.
 * @class ApiManager
 * @since 0.11.1
 */

import TemplateManager from "./templateManager.js";
import { escapeHTML, numberToEncoded, serverTPtoDisplayTP, debugLog } from "./utils.js";
import { notifyCanvasChange } from "./tileManager.js";

export default class ApiManager {

  /** Constructor for ApiManager class
   * @param {TemplateManager} templateManager 
   * @since 0.11.34
   */
  constructor(templateManager) {
    this.templateManager = templateManager;
    this.disableAll = false; // Should the entire userscript be disabled?
    this.coordsTilePixel = []; // Contains the last detected tile/pixel coordinate pair requested
    this.templateCoordsTilePixel = []; // Contains the last "enabled" template coords
    this.tileServerBase = null; // Remember last seen tile server base URL
  }

  /** Determines if the spontaneously recieved response is something we want.
   * Otherwise, we can ignore it.
   * Note: Due to aggressive compression, make your calls like `data['jsonData']['name']` instead of `data.jsonData.name`
   * 
   * @param {Overlay} overlay - The Overlay class instance
   * @since 0.11.1
  */
  spontaneousResponseListener(overlay) {

    // Triggers whenever a message is sent
    window.addEventListener('message', async (event) => {

      const data = event.data; // The data of the message
      const dataJSON = data['jsonData']; // The JSON response, if any

      // Handle canvas change notifications
      if (data['source'] === 'blue-marble-canvas-change') {
        debugLog('[Canvas Change] Detected pixel placement request:', data['method'], data['endpoint']);
        notifyCanvasChange();
        return;
      }

      // Kills itself if the message was not intended for Blue Marble
      if (!(data && data['source'] === 'blue-marble')) {return;}

      // Kills itself if the message has no endpoint (intended for Blue Marble, but not this function)
      if (!data['endpoint']) {return;}

      // Trims endpoint to the second to last non-number, non-null directoy.
      // E.g. "wplace.live/api/pixel/0/0?payload" -> "pixel"
      // E.g. "wplace.live/api/files/s0/tiles/0/0/0.png" -> "tiles"
      const endpointText = data['endpoint']?.split('?')[0].split('/').filter(s => s && isNaN(Number(s))).filter(s => s && !s.includes('.')).pop();

      debugLog(`Blue Marble: Recieved message about "${endpointText}"`);

      // Each case is something that Blue Marble can use from the fetch.
      // For instance, if the fetch was for "me", we can update the overlay stats
      switch (endpointText) {

        case 'me': // Request to retrieve user data

          // If the game can not retrieve the userdata...
          if (dataJSON['status'] && dataJSON['status']?.toString()[0] != '2') {
            // The server is probably down (NOT a 2xx status)
            
            overlay.handleDisplayError(`You are not logged in!\nCould not fetch userdata.`);
            return; // Kills itself before attempting to display null userdata
          }

          const nextLevelPixels = Math.ceil(Math.pow(Math.floor(dataJSON['level']) * Math.pow(30, 0.65), (1/0.65)) - dataJSON['pixelsPainted']); // Calculates pixels to the next level

          debugLog(dataJSON['id']);
          if (!!dataJSON['id'] || dataJSON['id'] === 0) {
            debugLog(numberToEncoded(
              dataJSON['id'],
              '!#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[]^_`abcdefghijklmnopqrstuvwxyz{|}~'
            ));
          }
          this.templateManager.userID = dataJSON['id'];
          
          // Store paint/cooldown information for external access
          this.userPaintData = {
            charges: dataJSON['charges'] || 0,
            maxCharges: dataJSON['maxCharges'] || 1,
            nextChargeTime: dataJSON['nextChargeTime'] || null,
            cooldownMs: dataJSON['cooldownMs'] || null,
            canPaint: dataJSON['canPaint'] || false,
            timeUntilNextCharge: null
          };
          
          // Calculate time until next charge if available
          if (this.userPaintData.nextChargeTime) {
            const nextChargeTimestamp = new Date(this.userPaintData.nextChargeTime).getTime();
            const currentTime = Date.now();
            this.userPaintData.timeUntilNextCharge = Math.max(0, nextChargeTimestamp - currentTime);
          }
          
          // Log paint data for debugging
          debugLog('Skirk Marble: Paint Data:', this.userPaintData);
          
          overlay.updateInnerHTML('bm-user-name-content', `<b>Username:</b> ${escapeHTML(dataJSON['name'])}`); // Updates the text content of the username field
          try {
            const show = JSON.parse(localStorage.getItem('bmShowUsername') ?? 'true');
            const el = document.getElementById('bm-user-name');
            if (el) el.style.display = show ? '' : 'none';
          } catch(_) {}
          
          overlay.updateInnerHTML('bm-user-droplets-content', `<b>Droplets:</b> ${new Intl.NumberFormat().format(dataJSON['droplets'])}`); // Updates the text content of the droplets field
          try {
            const show = JSON.parse(localStorage.getItem('bmShowDroplets') ?? 'true');
            const el = document.getElementById('bm-user-droplets');
            if (el) el.style.display = show ? '' : 'none';
          } catch(_) {}
          
          overlay.updateInnerHTML('bm-user-nextlevel-content', `Next level in <b>${new Intl.NumberFormat().format(nextLevelPixels)}</b> pixel${nextLevelPixels == 1 ? '' : 's'}`); // Updates the text content of the next level field
          try {
            const show = JSON.parse(localStorage.getItem('bmShowNextLevel') ?? 'true');
            const el = document.getElementById('bm-user-nextlevel');
            if (el) el.style.display = show ? '' : 'none';
          } catch(_) {}
          
          // Update full charge countdown
          this.updateFullChargeInfo(overlay, dataJSON);
          break;

        case 'pixel': // Request to retrieve pixel data
          const coordsTile = data['endpoint'].split('?')[0].split('/').filter(s => s && !isNaN(Number(s))); // Retrieves the tile coords as [x, y]
          const payloadExtractor = new URLSearchParams(data['endpoint'].split('?')[1]); // Declares a new payload deconstructor and passes in the fetch request payload
          const coordsPixel = [payloadExtractor.get('x'), payloadExtractor.get('y')]; // Retrieves the deconstructed pixel coords from the payload
          
          // Don't save the coords if there are previous coords that could be used
          if (this.coordsTilePixel.length && (!coordsTile.length || !coordsPixel.length)) {
            overlay.handleDisplayError(`Coordinates are malformed!\nDid you try clicking the canvas first?`);
            return; // Kills itself
          }
          
          this.coordsTilePixel = [...coordsTile, ...coordsPixel]; // Combines the two arrays such that [x, y, x, y]
          const displayTP = serverTPtoDisplayTP(coordsTile, coordsPixel);
          
          const spanElements = document.querySelectorAll('span'); // Retrieves all span elements

          // For every span element, find the one we want (pixel numbers when canvas clicked)
          for (const element of spanElements) {
            if (element.textContent.trim().includes(`${displayTP[0]}, ${displayTP[1]}`)) {

              let displayCoords = document.querySelector('#bm-display-coords'); // Find the additional pixel coords span

              const text = `(Tl X: ${coordsTile[0]}, Tl Y: ${coordsTile[1]}, Px X: ${coordsPixel[0]}, Px Y: ${coordsPixel[1]})`;
              
              // If we could not find the addition coord span, we make it then update the textContent with the new coords
              if (!displayCoords) {
                displayCoords = document.createElement('span');
                displayCoords.id = 'bm-display-coords';
                displayCoords.textContent = text;
                displayCoords.style = 'margin-left: calc(var(--spacing)*3); font-size: small;';
                element.parentNode.parentNode.parentNode.insertAdjacentElement('afterend', displayCoords);
              } else {
                displayCoords.textContent = text;
              }
            }
          }
          break;
        
        case 'tiles':

          // Runs only if the tile has the template
          let tileCoordsTile = data['endpoint'].split('/');
          tileCoordsTile = [parseInt(tileCoordsTile[tileCoordsTile.length - 2]), parseInt(tileCoordsTile[tileCoordsTile.length - 1].replace('.png', ''))];

          // Persist tile server base URL for screenshot pulls
          try {
            const endpointFull = data['endpoint'] || '';
            const parts = endpointFull.split('?')[0].split('/');
            const idx = parts.lastIndexOf('tiles');
            if (idx > 0) {
              const base = parts.slice(0, idx + 1).join('/');
              this.tileServerBase = base; // e.g., https://wplace.live/api/files/s0/tiles
            }
          } catch (_) {}
          
          const blobUUID = data['blobID'];
          const blobData = data['blobData'];
          
          const templateBlob = await this.templateManager.drawTemplateOnTile(blobData, tileCoordsTile);

          window.postMessage({
            source: 'blue-marble',
            blobID: blobUUID,
            blobData: templateBlob,
            blink: data['blink']
          });
          break;

        case 'robots': // Request to retrieve what script types are allowed
          this.disableAll = dataJSON['userscript']?.toString().toLowerCase() == 'false'; // Disables Blue Marble if site owner wants userscripts disabled
          break;
      }
    });
  }

  /** Update full charge information from API data
   * @param {Overlay} overlay - The Overlay class instance
   * @param {Object} dataJSON - JSON data from API response
   * @since 1.0.0
   */
  updateFullChargeInfo(overlay, dataJSON) {
    // Calculate and display full charge countdown
    if (dataJSON['charges']) {
      const charges = dataJSON['charges'];
      const currentCharges = charges['count'] || 0;
      const maxCharges = charges['max'] || 1;
      const cooldownMs = charges['cooldownMs'] || 30000; // Default 30 seconds
      
      // Calculate charges needed and time to full
      const chargesNeeded = maxCharges - currentCharges;
      const timeToFullMs = chargesNeeded * cooldownMs;
      
      // Store data for countdown
      window.skirkChargeData = {
        current: currentCharges,
        max: maxCharges,
        cooldownMs: cooldownMs,
        timeToFull: timeToFullMs,
        startTime: Date.now()
      };
      
      // Initial display
      this.updateFullChargeDisplay(overlay);
      
      // Start countdown interval
      if (window.skirkChargeInterval) {
        clearInterval(window.skirkChargeInterval);
      }
      
      window.skirkChargeInterval = setInterval(() => {
        this.updateFullChargeDisplay(overlay);
      }, 1000); // Update every second
    } else {
      // No charge data available
      overlay.updateInnerHTML('bm-user-fullcharge-content','Full Charge in <b style="color: #6b7280;">N/A</b>');
      // Apply visibility setting
      try {
        const show = JSON.parse(localStorage.getItem('bmShowFullCharge') ?? 'true');
        const el = document.getElementById('bm-user-fullcharge');
        if (el) el.style.display = show ? '' : 'none';
      } catch(_) {}
    }
  }

  /** Update the full charge countdown display
   * @param {Overlay} overlay - The Overlay class instance
   * @since 1.0.0
   */
  updateFullChargeDisplay(overlay) {
    if (!window.skirkChargeData) return;
    
    const data = window.skirkChargeData;
    const elapsed = Date.now() - data.startTime;
    const remainingMs = Math.max(0, data.timeToFull - elapsed);
    
    // If already at full charges
    if (data.current >= data.max || remainingMs <= 0) {
      overlay.updateInnerHTML('bm-user-fullcharge-content', `Full Charge in <b style="color: #10b981;">FULL</b>`);
      
      // Apply visibility setting
      try {
        const show = JSON.parse(localStorage.getItem('bmShowFullCharge') ?? 'true');
        const el = document.getElementById('bm-user-fullcharge');
        if (el) el.style.display = show ? '' : 'none';
      } catch(_) {}
      
      // Clear interval when full
      if (window.skirkChargeInterval) {
        clearInterval(window.skirkChargeInterval);
        window.skirkChargeInterval = null;
      }
      return;
    }
    
    // Convert to hours, minutes, seconds
    const totalSeconds = Math.ceil(remainingMs / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    
    let timeText = '';
    if (hours > 0) {
      timeText = `${hours}h ${minutes}m ${seconds}s`;
    } else if (minutes > 0) {
      timeText = `${minutes}m ${seconds}s`;
    } else {
      timeText = `${seconds}s`;
    }
    
    // Calculate current charges (increases over time)
    const chargesGained = Math.floor(elapsed / data.cooldownMs);
    const currentCharges = Math.min(data.current + chargesGained, data.max);
    const chargesText = `${Math.floor(currentCharges)}/${data.max}`;
    
    overlay.updateInnerHTML('bm-user-fullcharge-content', 
      `Full Charge in <b style="color: #f59e0b;">${timeText}</b> <span style="color: #6b7280; font-size: 0.9em;">(${chargesText})</span>`
    );
    
    // Apply visibility setting
    try {
      const show = JSON.parse(localStorage.getItem('bmShowFullCharge') ?? 'true');
      const el = document.getElementById('bm-user-fullcharge');
      if (el) el.style.display = show ? '' : 'none';
    } catch(_) {}
  }
}