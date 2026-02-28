import Template from "./Template.js";
import { base64ToUint8, uint8ToBase64, numberToEncoded, debugLog } from "./utils.js";
import { clearFrozenTileCache } from "./tileManager.js";

/** Manages the template system.
 * This class handles all external requests for template modification, creation, and analysis.
 * It serves as the central coordinator between template instances and the user interface.
 * @class TemplateManager
 * @since 0.55.8
 * @example
 * // JSON structure for a template
 * {
 *   "whoami": "BlueMarble",
 *   "scriptVersion": "1.13.0",
 *   "schemaVersion": "2.1.0",
 *   "templates": {
 *     "0 $Z": {
 *       "name": "My Template",
 *       "enabled": true,
 *       "tiles": {
 *         "1231,0047,183,593": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA",
 *         "1231,0048,183,000": "data:image/png;AAAFCAYAAACNbyblAAAAHElEQVQI12P4"
 *       }
 *     },
 *     "1 $Z": {
 *       "name": "My Template",
 *       "URL": "https://github.com/SwingTheVine/Wplace-BlueMarble/blob/main/dist/assets/Favicon.png",
 *       "URLType": "template",
 *       "enabled": false,
 *       "tiles": {
 *         "375,1846,276,188": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA",
 *         "376,1846,000,188": "data:image/png;AAAFCAYAAACNbyblAAAAHElEQVQI12P4"
 *       }
 *     }
 *   }
 * }
 */
export default class TemplateManager {

  /** The constructor for the {@link TemplateManager} class.
   * @since 0.55.8
   */
  constructor(name, version, overlay) {

    // Meta
    this.name = name; // Name of userscript
    this.version = version; // Version of userscript
    this.overlay = overlay; // The main instance of the Overlay class
    this.templatesVersion = '1.0.0'; // Version of JSON schema
    this.userID = null; // The ID of the current user
    this.encodingBase = '!#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[]^_`abcdefghijklmnopqrstuvwxyz{|}~'; // Characters to use for encoding/decoding
    this.tileSize = 1000; // The number of pixels in a tile. Assumes the tile is square
    this.drawMult = 3; // The enlarged size for each pixel. E.g. when "3", a 1x1 pixel becomes a 1x1 pixel inside a 3x3 area. MUST BE ODD
    this.tileProgress = new Map(); // Tracks per-tile progress stats {painted, required, wrong}
    
    // Smart Template Detection Properties
    this.currentlyDisplayedTemplates = new Set(); // Tracks which templates are currently being rendered
    this.lastDisplayedCount = 0; // Tracks the last count of displayed templates
    this.smartDetectionEnabled = true; // Whether smart detection is enabled
    
    // Error Map Mode Properties (ported from lurk)
    this.errorMapEnabled = false; // Whether to show green/red overlay for correct/wrong pixels
    this.showCorrectPixels = true; // Show green overlay for correct pixels
    this.showWrongPixels = true; // Show red overlay for wrong pixels
    this.showUnpaintedAsWrong = false; // Mark unpainted pixels as wrong (red) (from Storage fork)
    
    // Wrong Color Options
    this.includeWrongColorsInProgress = false; // Include wrong color pixels in progress calculation
    this.enhanceWrongColors = false; // Use crosshair enhance on wrong colors
    
    // Load wrong color settings from storage on initialization
    this.loadWrongColorSettings();
    
    // Template
    this.templatesArray = []; // All Template instnaces currently loaded (Template)
    this.templatesJSON = null; // All templates currently loaded (JSON)
    this.templatesShouldBeDrawn = true; // Should ALL templates be drawn to the canvas?
  }

  /** Creates the JSON object to store templates in
   * @returns {{ whoami: string, scriptVersion: string, schemaVersion: string, templates: Object }} The JSON object
   * @since 0.65.4
   */
  async createJSON() {
    const json = {
      "whoami": 'BlueMarble', // Name of userscript
      "scriptVersion": this.version, // Version of userscript
      "schemaVersion": this.templatesVersion, // Version of JSON schema
      "createdAt": new Date().toISOString(), // When the JSON was first created
      "lastModified": new Date().toISOString(), // When it was last modified
      "templateCount": 0, // Number of templates
      "totalPixels": 0, // Total pixels across all templates
      "templates": {} // The templates
    };
    
    
    return json;
  }

  /** Finds a duplicate template by name and pixel count
   * @param {string} name - The display name to search for
   * @param {number} pixelCount - The pixel count to match
   * @returns {string|null} The template key if duplicate found, null otherwise
   * @since 1.0.0
   */
  findDuplicateTemplate(name, pixelCount) {
    if (!this.templatesJSON?.templates) return null;
    
    // Only check for duplicates if both name and pixelCount are valid
    if (!name || !pixelCount || pixelCount <= 0) return null;
    
    for (const [templateKey, templateData] of Object.entries(this.templatesJSON.templates)) {
      if (templateData.name === name && templateData.pixelCount === pixelCount) {
        debugLog(` Found duplicate template: ${templateKey} (${name}, ${pixelCount} pixels)`);
        return templateKey;
      }
    }
    
    return null;
  }

  /** Creates the template from the inputed file blob
   * @param {File} blob - The file blob to create a template from
   * @param {string} name - The display name of the template
   * @param {Array<number, number, number, number>} coords - The coordinates of the top left corner of the template
   * @since 0.65.77
   */
  async createTemplate(blob, name, coords) {

    // Creates the JSON object if it does not already exist
    if (!this.templatesJSON) {this.templatesJSON = await this.createJSON();}



    this.overlay.handleDisplayStatus(`Creating template at ${coords.join(', ')}...`);

    // Determine sortID first (for duplicates, reuse existing sortID)
    const existingSortIDs = Object.keys(this.templatesJSON.templates).map(key => parseInt(key.split(' ')[0]));
    const nextSortID = existingSortIDs.length > 0 ? Math.max(...existingSortIDs) + 1 : 0;

    // Creates the template instance ONCE
    const template = new Template({
      displayName: name,
      sortID: nextSortID,
      authorID: numberToEncoded(this.userID || 0, this.encodingBase),
      file: blob,
      coords: coords
    });
    
    // Process template tiles (this is the heavy operation - do it only once!)
    const { templateTiles, templateTilesBuffers } = await template.createTemplateTiles(this.tileSize);
    template.chunked = templateTiles;

    // Check for duplicate templates AFTER processing (using actual pixel count)
    debugLog(` Creating template: "${name}" with ${template.pixelCount} pixels`);
    
    const ENABLE_DUPLICATE_DETECTION = true;
    const duplicateKey = ENABLE_DUPLICATE_DETECTION ? this.findDuplicateTemplate(name, template.pixelCount) : null;
    
    let finalSortID = nextSortID;
    if (duplicateKey) {
      // Replace existing template
      finalSortID = parseInt(duplicateKey.split(' ')[0]);
      this.overlay.handleDisplayStatus(`Duplicate detected! Replacing existing template "${name}"...`);
      debugLog(`Replacing duplicate template: ${duplicateKey}`);
      
      // Update template with existing sortID
      template.sortID = finalSortID;
      
      // Remove old template from array
      const oldTemplateIndex = this.templatesArray.findIndex(t => `${t.sortID} ${t.authorID}` === duplicateKey);
      if (oldTemplateIndex !== -1) {
        this.templatesArray.splice(oldTemplateIndex, 1);
      }
      
      // Remove old template from JSON
      if (this.templatesJSON.templates[duplicateKey]) {
        delete this.templatesJSON.templates[duplicateKey];
        debugLog(` Removed old duplicate template from JSON: ${duplicateKey}`);
      }
    }

    // Convert original image to base64 for thumbnail
    let thumbnailBase64 = null;
    try {
      const reader = new FileReader();
      thumbnailBase64 = await new Promise((resolve, reject) => {
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
    } catch (error) {
      debugLog('Failed to create thumbnail from original image:', error);
    }
    
    // Appends a child into the templates object
    // The child's name is the number of templates already in the list (sort order) plus the encoded player ID
    this.templatesJSON.templates[`${template.sortID} ${template.authorID}`] = {
      "name": template.displayName, // Display name of template
      "coords": coords.join(', '), // The coords of the template
      "createdAt": new Date().toISOString(), // When this template was created
      "pixelCount": template.pixelCount,
      "validPixelCount": template.validPixelCount,
      "transparentPixelCount": template.transparentPixelCount,
      "enabled": true,
      "disabledColors": template.getDisabledColors(),
      "enhancedColors": template.getEnhancedColors(),
      "tiles": templateTilesBuffers,
      "thumbnail": thumbnailBase64 // Store original image as thumbnail
    };

    // Update JSON metadata
    this.templatesJSON.lastModified = new Date().toISOString();
    this.templatesJSON.templateCount = Object.keys(this.templatesJSON.templates).length;
    this.templatesJSON.totalPixels = this.templatesArray.reduce((total, t) => total + (t.pixelCount || 0), 0) + template.pixelCount;

    // Initialize templatesArray if it doesn't exist, but don't clear existing templates
    if (!this.templatesArray) {
      this.templatesArray = [];
    }
    this.templatesArray.push(template); // Pushes the Template object instance to the Template Array

    // ==================== PIXEL COUNT DISPLAY SYSTEM ====================
    // Display pixel count statistics with internationalized number formatting
    // This provides immediate feedback to users about template complexity and size
    const pixelCountFormatted = new Intl.NumberFormat().format(template.pixelCount);
    const totalTemplates = Object.keys(this.templatesJSON.templates).length;
    const actionText = duplicateKey ? 'replaced' : 'created';
    this.overlay.handleDisplayStatus(`Template #${template.sortID} ${actionText} at ${coords.join(', ')}! Total pixels: ${pixelCountFormatted} | Total templates: ${totalTemplates}`);

    // Store templates in background (non-blocking)
    this.#storeTemplates().catch(error => {
      console.error('❌ Template storage failed:', error);
      this.overlay.handleDisplayStatus(`Template created but storage failed: ${error.message}`);
    });
  }

  /** Stores the JSON object of the loaded templates into storage with fallback system.
   * Tries TamperMonkey first, falls back to localStorage if that fails.
   * @since 0.72.7
   */
  async #storeTemplates() {
    if (!this.templatesJSON) {
      console.error('❌ Cannot store templates: this.templatesJSON is null/undefined');
      return;
    }
    
    const data = JSON.stringify(this.templatesJSON);
    const timestamp = Date.now();
    
    // Try TamperMonkey storage first
    try {
      if (typeof GM !== 'undefined' && GM.setValue) {
        // Chunk if too large for TM or browser storage limitations
        const CHUNK_SIZE = 900000; // ~0.9MB per chunk
        if (data.length > CHUNK_SIZE) {
          const parts = Math.ceil(data.length / CHUNK_SIZE);
          // Clear single key
          try { await GM.deleteValue?.('bmTemplates'); } catch (_) {}
          await GM.setValue('bmTemplates_chunkCount', parts);
          for (let i = 0; i < parts; i++) {
            const slice = data.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
            await GM.setValue(`bmTemplates_part_${i}`, slice);
          }
          await GM.setValue('bmTemplates_timestamp', timestamp);
          debugLog(`Templates stored in TamperMonkey (chunked x${parts})`);
        } else {
          await GM.setValue('bmTemplates', data);
          await GM.setValue('bmTemplates_timestamp', timestamp);
          // Clear any previous chunked keys
          try {
            const count = await GM.getValue('bmTemplates_chunkCount', 0);
            for (let i = 0; i < count; i++) await GM.deleteValue(`bmTemplates_part_${i}`);
            await GM.deleteValue('bmTemplates_chunkCount');
          } catch (_) {}
        }
        return;
      } else if (typeof GM_setValue !== 'undefined') {
        // Legacy GM_* APIs (synchronous) - use no-chunk or minimal chunk via localStorage fallback below
        GM_setValue('bmTemplates', data);
        GM_setValue('bmTemplates_timestamp', timestamp);
        return;
      }
    } catch (error) {
      console.warn('⚠️ TamperMonkey storage failed:', error);
    }
    
    // Fallback to localStorage
    try {
      const CHUNK_SIZE = 900000; // ~0.9MB
      if (data.length > CHUNK_SIZE) {
        const parts = Math.ceil(data.length / CHUNK_SIZE);
        // Clear single key
        try { localStorage.removeItem('bmTemplates'); } catch (_) {}
        localStorage.setItem('bmTemplates_chunkCount', String(parts));
        for (let i = 0; i < parts; i++) {
          const slice = data.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
          localStorage.setItem(`bmTemplates_part_${i}`, slice);
        }
        localStorage.setItem('bmTemplates_timestamp', timestamp.toString());
        debugLog(`Templates stored in localStorage (chunked x${parts})`);
      } else {
        localStorage.setItem('bmTemplates', data);
        localStorage.setItem('bmTemplates_timestamp', timestamp.toString());
        // Clear previous chunked keys
        const count = parseInt(localStorage.getItem('bmTemplates_chunkCount') || '0');
        for (let i = 0; i < count; i++) localStorage.removeItem(`bmTemplates_part_${i}`);
        localStorage.removeItem('bmTemplates_chunkCount');
      }
    } catch (error) {
      console.error('❌ All storage methods failed:', error);
      alert('Erro crítico: Não foi possível salvar templates. Verifique as permissões do navegador.');
    }
  }

  /** Deletes a template from the JSON object.
   * Also delete's the corrosponding {@link Template} class instance
   * @param {string} templateKey - The key of the template to delete (e.g., "0 $Z")
   * @since 1.0.0
   */
  async deleteTemplate(templateKey) {
    if (!templateKey || !this.templatesJSON?.templates) {
      console.warn('⚠️ Invalid template key or no templates available');
      return false;
    }

    try {
      debugLog(` Starting complete deletion of template: ${templateKey}`);

      // Get template reference before deletion for cleanup
      const templateToDelete = this.templatesArray.find(template => {
        const templateKeyFromInstance = `${template.sortID} ${template.authorID}`;
        return templateKeyFromInstance === templateKey;
      });

      // COMPLETE CLEANUP: Clear all template-related caches and data
      
      // 1. Clear template's own caches (enhanced tiles, etc.)
      if (templateToDelete) {
        // Clear enhanced tiles cache
        if (templateToDelete.enhancedTilesCache) {
          templateToDelete.enhancedTilesCache.clear();
        }
        
        // Dispose of template's chunked bitmaps to free memory
        if (templateToDelete.chunked) {
          for (const [tileKey, bitmap] of Object.entries(templateToDelete.chunked)) {
            if (bitmap && typeof bitmap.close === 'function') {
              try {
                bitmap.close(); // Free GPU memory
              } catch (e) {
                // Bitmap already disposed or doesn't support close
              }
            }
          }
        }
      }

      // 2. Clear tile progress cache to remove any cached data from this template
      this.clearTileProgressCache();

      // 3. Clear any frozen tile cache from tileManager
      try {
        clearFrozenTileCache();
      } catch (error) {
      }

      // 4. Remove from JSON storage
      if (this.templatesJSON.templates[templateKey]) {
        delete this.templatesJSON.templates[templateKey];
        debugLog(` Removed template ${templateKey} from JSON storage`);
      }

      // 5. Remove from templatesArray
      const templateIndex = this.templatesArray.findIndex(template => {
        const templateKeyFromInstance = `${template.sortID} ${template.authorID}`;
        return templateKeyFromInstance === templateKey;
      });

      if (templateIndex !== -1) {
        this.templatesArray.splice(templateIndex, 1);
        debugLog(` Removed template ${templateKey} from memory array`);
      }

      // 6. Update JSON metadata after deletion
      this.templatesJSON.lastModified = new Date().toISOString();
      this.templatesJSON.templateCount = Object.keys(this.templatesJSON.templates).length;
      this.templatesJSON.totalPixels = this.templatesArray.reduce((total, t) => total + (t.pixelCount || 0), 0);

      // 7. Save updated templates to BOTH storages to ensure complete removal
      await this.#storeTemplates();

      // 8. Force complete template display refresh to clear any visual artifacts
      if (typeof refreshTemplateDisplay === 'function') {
        try {
          await refreshTemplateDisplay();
        } catch (error) {
          console.warn('Warning: Failed to refresh template display:', error);
        }
      }

      // 9. Update mini tracker to reflect changes
      if (typeof updateMiniTracker === 'function') {
        updateMiniTracker();
      }

      // 10. Force garbage collection hint (if available)
      if (typeof window.gc === 'function') {
        try {
          window.gc();
        } catch (e) {
          // GC not available, ignore
        }
      }

      debugLog(`Template ${templateKey} completely deleted and all related data cleaned`);
      return true;
    } catch (error) {
      console.error('❌ Failed to delete template:', error);
      return false;
    }
  }

  /** Draws all templates on the specified tile.
   * This method handles the rendering of template overlays on individual tiles.
   * @param {File} tileBlob - The pixels that are placed on a tile
   * @param {Array<number>} tileCoords - The tile coordinates [x, y]
   * @since 0.65.77
   */
  async drawTemplateOnTile(tileBlob, tileCoords) {

    // Returns early if no templates should be drawn
    if (!this.templatesShouldBeDrawn) {return tileBlob;}

    // Wrong color settings are now loaded in constructor, no need to check here

    const drawSize = this.tileSize * this.drawMult; // Calculate draw multiplier for scaling

    // Format tile coordinates with proper padding for consistent lookup
    tileCoords = tileCoords[0].toString().padStart(4, '0') + ',' + tileCoords[1].toString().padStart(4, '0');

    debugLog(`Searching for templates in tile: "${tileCoords}"`);

    const templateArray = this.templatesArray;
    debugLog(templateArray);

    // Sorts the array of Template class instances. 0 = first = lowest draw priority
    templateArray.sort((a, b) => {return a.sortID - b.sortID;});

    debugLog(templateArray);

    // Retrieves the relavent template tile blobs
    const templatesToDraw = templateArray
      .filter(template => {
        // Check if template is enabled
        const templateKey = `${template.sortID} ${template.authorID}`;
        const isEnabled = this.isTemplateEnabled(templateKey);
        if (!isEnabled) {
          debugLog(`⏸️ Skipping disabled template: ${templateKey}`);
        }
        return isEnabled;
      })
      .map(template => {
        const matchingTiles = Object.keys(template.chunked).filter(tile =>
          tile.startsWith(tileCoords)
        );

        if (matchingTiles.length === 0) {return null;} // Return null when nothing is found

        // Retrieves the blobs of the templates for this tile
        const matchingTileBlobs = matchingTiles.map(tile => {

          const coords = tile.split(','); // [x, y, x, y] Tile/pixel coordinates
          
          return {
            bitmap: template.chunked[tile],
            tileCoords: [coords[0], coords[1]],
            pixelCoords: [coords[2], coords[3]]
          }
        });

        return matchingTileBlobs?.[0];
      })
    .filter(Boolean);

    debugLog(templatesToDraw);

    const templateCount = templatesToDraw?.length || 0; // Number of templates to draw on this tile
    debugLog(`templateCount = ${templateCount}`);

    if (templateCount > 0) {
      
      // SMART DETECTION: Track which templates are currently being displayed
      this.currentlyDisplayedTemplates.clear();
      for (const template of templateArray) {
        const templateKey = `${template.sortID} ${template.authorID}`;
        if (this.isTemplateEnabled(templateKey)) {
          // Check if this template has tiles matching current coordinates
          const matchingTiles = Object.keys(template.chunked).filter(tile =>
            tile.startsWith(tileCoords)
          );
          if (matchingTiles.length > 0) {
            this.currentlyDisplayedTemplates.add(templateKey);
            debugLog(`Smart Detection - Template actively displayed: ${template.displayName}`);
          }
        }
      }
      
      this.lastDisplayedCount = this.currentlyDisplayedTemplates.size;
      debugLog(`[Smart Detection] Currently displaying ${this.lastDisplayedCount} templates`);
      
      // Calculate total pixel count for templates actively being displayed in this tile
      const totalPixels = templateArray
        .filter(template => {
          // Filter templates to include only those with tiles matching current coordinates
          // AND that are enabled (not disabled)
          const matchingTiles = Object.keys(template.chunked).filter(tile =>
            tile.startsWith(tileCoords)
          );
          
          // Check if template is enabled
          const templateKey = `${template.sortID} ${template.authorID}`;
          const isEnabled = this.isTemplateEnabled(templateKey);
          
          return matchingTiles.length > 0 && isEnabled;
        })
        .reduce((sum, template) => sum + (template.pixelCount || 0), 0);
      
      // Format pixel count with locale-appropriate thousands separators for better readability
      // Examples: "1,234,567" (US), "1.234.567" (DE), "1 234 567" (FR)
      const pixelCountFormatted = new Intl.NumberFormat().format(totalPixels);
      
      // Display status information about the templates being rendered
      this.overlay.handleDisplayStatus(
        `Displaying ${templateCount} template${templateCount == 1 ? '' : 's'}.\nTotal pixels: ${pixelCountFormatted}`
      );
    } else {
      this.overlay.handleDisplayStatus(`Displaying ${templateCount} templates.`);
      this.currentlyDisplayedTemplates.clear();
      this.lastDisplayedCount = 0;
      debugLog(`[Smart Detection] No templates displayed`);
    }
    
    const tileBitmap = await createImageBitmap(tileBlob);

    const canvas = document.createElement('canvas');
    canvas.width = drawSize;
    canvas.height = drawSize;
    const context = canvas.getContext('2d');

    context.imageSmoothingEnabled = false; // Nearest neighbor

    // Tells the canvas to ignore anything outside of this area
    context.beginPath();
    context.rect(0, 0, drawSize, drawSize);
    context.clip();

    context.clearRect(0, 0, drawSize, drawSize); // Draws transparent background
    context.drawImage(tileBitmap, 0, 0, drawSize, drawSize);

    // For each template in this tile, draw them.
    for (let i = 0; i < templatesToDraw.length; i++) {
      const template = templatesToDraw[i];
      debugLog(`Template:`);
      debugLog(template);

      // Get the corresponding template instance to check for disabled colors
      const currentTemplate = templateArray[i]; // Use the correct template from the array
      const hasDisabledColors = currentTemplate && currentTemplate.getDisabledColors().length > 0;
      
                     // Check if any colors have enhanced mode enabled OR if wrong colors should be enhanced
       const hasEnhancedColors = currentTemplate && (currentTemplate.enhancedColors.size > 0 || this.enhanceWrongColors);
       
       // Debug wrong colors enhance setting
       if (this.enhanceWrongColors) {
         debugLog(`Enhance Wrong Colors is ENABLED`);
         debugLog(`Current tile: ${tileCoords}`);
         debugLog(`Tile progress data available: ${this.tileProgress.has(tileCoords)}`);
         if (this.tileProgress.has(tileCoords)) {
           const tileData = this.tileProgress.get(tileCoords);
           debugLog(`Tile has color breakdown: ${!!tileData.colorBreakdown}`);
           if (tileData.colorBreakdown) {
             const wrongColors = Object.entries(tileData.colorBreakdown)
               .filter(([color, data]) => data.wrong > 0)
               .map(([color, data]) => `${color}(${data.wrong} wrong)`);
            //  console.log(`🎯 [Debug] Wrong colors in this tile: ${wrongColors.join(', ')}`);
           }
         }
       }
      
      // Debug logs
      debugLog(`Template: ${currentTemplate?.displayName}`);
      debugLog(`Has enhanced colors: ${hasEnhancedColors} (${currentTemplate?.enhancedColors.size || 0} colors)`);
      debugLog(`Has disabled colors: ${hasDisabledColors}`);
      if (hasEnhancedColors) {
        debugLog(`Enhanced colors:`, Array.from(currentTemplate.enhancedColors));
      }
      
      if (!hasEnhancedColors && !hasDisabledColors) {
        // Fast path: Normal drawing without enhancement or color filtering
        debugLog(`Using fast path (no enhancements)`);
        context.drawImage(template.bitmap, Number(template.pixelCoords[0]) * this.drawMult, Number(template.pixelCoords[1]) * this.drawMult);
      } else {
        // Enhanced/Filtered path: Real-time processing for color filtering and/or enhanced mode
        debugLog(`Using enhanced/filtered path`);
        debugLog(`Template bitmap size: ${template.bitmap.width}x${template.bitmap.height}`);
        
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = template.bitmap.width;
        tempCanvas.height = template.bitmap.height;
        const tempCtx = tempCanvas.getContext('2d');
        tempCtx.imageSmoothingEnabled = false;
        
        // Draw original template to temp canvas
        tempCtx.drawImage(template.bitmap, 0, 0);
        
        // Get image data for processing
        const imageData = tempCtx.getImageData(0, 0, tempCanvas.width, tempCanvas.height);
        const data = imageData.data;
        const width = tempCanvas.width;
        const height = tempCanvas.height;
        
        // Create a copy for border detection if enhanced mode is enabled
        const originalData = hasEnhancedColors ? new Uint8ClampedArray(data) : null;
        const enhancedPixels = hasEnhancedColors ? new Set() : null;
        
        // Get the current canvas state (including painted pixels) for crosshair collision detection
        let canvasData = null;
        if (hasEnhancedColors) {
          const canvasImageData = context.getImageData(0, 0, canvas.width, canvas.height);
          canvasData = canvasImageData.data;
        }
        
                 // First pass: Apply color filtering to center pixels
         if (hasDisabledColors) {
           for (let y = 0; y < height; y++) {
             for (let x = 0; x < width; x++) {
               // Only process center pixels of 3x3 blocks (same as template creation)
               if (x % this.drawMult !== 1 || y % this.drawMult !== 1) {
                 continue;
               }
               
               const i = (y * width + x) * 4;
               const r = data[i];
               const g = data[i + 1];
               const b = data[i + 2];
               const alpha = data[i + 3];
               
               // Skip transparent pixels
               if (alpha === 0) continue;
               
               // Check if this color is disabled
               const isDisabled = currentTemplate.isColorDisabled([r, g, b]);
               
               if (isDisabled) {
                 // Hide disabled colors by making them transparent
                 data[i + 3] = 0;
               } else if (hasEnhancedColors && currentTemplate.isColorEnhanced([r, g, b])) {
                 // Track enhanced pixels for border detection
                 enhancedPixels.add(`${x},${y}`);
               }
             }
           }
         } else if (hasEnhancedColors) {
           // If only enhanced mode (no color filtering), identify enhanced template pixels
           // IMPORTANT: Only process center pixels of 3x3 blocks (template pixels) to avoid affecting painted pixels
           debugLog(`Scanning for enhanced template pixels...`);
           let enhancedPixelCount = 0;
           
           for (let y = 0; y < height; y++) {
             for (let x = 0; x < width; x++) {
               // Only process center pixels of 3x3 blocks (same as template creation)
               if (x % this.drawMult !== 1 || y % this.drawMult !== 1) {
                 continue;
               }
               
               const i = (y * width + x) * 4;
               const alpha = originalData[i + 3];
               
               if (alpha > 0) {
                 const r = originalData[i];
                 const g = originalData[i + 1];
                 const b = originalData[i + 2];
                 
                                                                                       // Check if this color should be enhanced (normal enhanced OR wrong colors enhanced)
                 const isNormalEnhanced = currentTemplate.isColorEnhanced([r, g, b]);
                 // For wrong colors enhancement, we'll detect wrong colors separately and add them to enhanced pixels
                 const shouldBeEnhanced = isNormalEnhanced;
                 
                 if (shouldBeEnhanced) {
                   enhancedPixels.add(`${x},${y}`);
                   enhancedPixelCount++;
                 }
               }
             }
           }
           
                        debugLog(`Found ${enhancedPixelCount} enhanced pixels`);
           }
        
         // Apply enhanced mode crosshair effects
         if (hasEnhancedColors && enhancedPixels && enhancedPixels.size > 0) {
           
           // Enhanced mode with performance limits
           if (enhancedPixels.size > 700000) {
             debugLog(`Skipping enhanced mode: ${enhancedPixels.size} pixels (performance limit)`);
           } else {
             let crosshairCenterCount = 0;
             
             // Get canvas region data only once and only for the template area
             const templateOffsetX = Number(template.pixelCoords[0]) * this.drawMult;
             const templateOffsetY = Number(template.pixelCoords[1]) * this.drawMult;
             
             let canvasRegionData = null;
             try {
               if (templateOffsetX >= 0 && templateOffsetY >= 0 && 
                   templateOffsetX + width <= canvas.width && 
                   templateOffsetY + height <= canvas.height) {
                 const canvasRegion = context.getImageData(templateOffsetX, templateOffsetY, width, height);
                 canvasRegionData = canvasRegion.data;
               }
             } catch (error) {
               debugLog('Could not get canvas region, using fallback mode');
             }
             
              // Process enhanced pixels efficiently 
              const enhancedPixelsArray = Array.from(enhancedPixels);
              const isLargeTemplate = enhancedPixelsArray.length > 25000;
              const chunkSize = isLargeTemplate ? 8000 : enhancedPixelsArray.length;
             
             // Track wrong color pixels
             const wrongColorPixels = new Set();
             let wrongColorCount = 0;
             
              // Detect wrong color pixels
              if (this.enhanceWrongColors) {
                if (enhancedPixelsArray.length > 15000) {
                  debugLog(`Scanning ${enhancedPixelsArray.length} pixels for wrong colors`);
                }
               
               for (const pixelCoord of enhancedPixelsArray) {
                 const [px, py] = pixelCoord.split(',').map(Number);
                 
                 // Get template color at this position
                 const templateIndex = (py * width + px) * 4;
                 const templateR = originalData[templateIndex];
                 const templateG = originalData[templateIndex + 1];
                 const templateB = originalData[templateIndex + 2];
                 
                 // Check canvas color at same position
                 let canvasR = 0, canvasG = 0, canvasB = 0, canvasA = 0;
                 if (canvasRegionData) {
                   canvasR = canvasRegionData[templateIndex];
                   canvasG = canvasRegionData[templateIndex + 1];
                   canvasB = canvasRegionData[templateIndex + 2];
                   canvasA = canvasRegionData[templateIndex + 3];
                 } else {
                   // Fallback for edge cases
                   const canvasX = px + templateOffsetX;
                   const canvasY = py + templateOffsetY;
                   if (canvasX >= 0 && canvasX < canvas.width && canvasY >= 0 && canvasY < canvas.height) {
                     const canvasIndex = (canvasY * canvas.width + canvasX) * 4;
                     canvasR = canvasData[canvasIndex];
                     canvasG = canvasData[canvasIndex + 1];
                     canvasB = canvasData[canvasIndex + 2];
                     canvasA = canvasData[canvasIndex + 3];
                   }
                 }
                 
                 // Check if pixel is painted but wrong color
                 if (canvasA > 0 && (canvasR !== templateR || canvasG !== templateG || canvasB !== templateB)) {
                   wrongColorPixels.add(pixelCoord);
                   wrongColorCount++;
                   
                  }
               }
               
                // Add wrong color pixels to enhanced pixels set for crosshair processing
               for (const pixelCoord of wrongColorPixels) {
                 enhancedPixels.add(pixelCoord);
               }
               
                // Update the array with the new pixels
                const updatedEnhancedPixelsArray = Array.from(enhancedPixels);
                if (wrongColorCount > 50) {
                  debugLog(`Found ${wrongColorCount} wrong colors, total enhanced: ${updatedEnhancedPixelsArray.length}`);
                }
             }
             
             // Get border setting once for the entire tile
             const borderEnabled = this.getBorderEnabled();
             let borderCount = 0;
             
             // Use updated array if wrong colors were detected, otherwise use original
             const finalEnhancedPixelsArray = (this.enhanceWrongColors && wrongColorCount > 0 && typeof updatedEnhancedPixelsArray !== 'undefined') ? updatedEnhancedPixelsArray : enhancedPixelsArray;
             
             for (let chunkStart = 0; chunkStart < finalEnhancedPixelsArray.length; chunkStart += chunkSize) {
               const chunkEnd = Math.min(chunkStart + chunkSize, finalEnhancedPixelsArray.length);
               const chunk = finalEnhancedPixelsArray.slice(chunkStart, chunkEnd);
               
                // Progress logging for large templates
                if (isLargeTemplate && chunkStart > 0 && Math.floor(chunkStart/chunkSize) % 3 === 0) {
                  const currentChunk = Math.floor(chunkStart/chunkSize) + 1;
                  const totalChunks = Math.ceil(finalEnhancedPixelsArray.length/chunkSize);
                  debugLog(`Processing ${currentChunk}/${totalChunks} (${Math.round((chunkStart/finalEnhancedPixelsArray.length)*100)}%)`);
                }
               
               for (const pixelCoord of chunk) {
                 const [px, py] = pixelCoord.split(',').map(Number);
                 
                 // Determine if this is a wrong color pixel
                 const isWrongColor = wrongColorPixels.has(pixelCoord);
                 
                 // Build base offsets and optionally add expansion as EXTRA if base is eligible
                 const enhancedOn = this.getEnhancedSizeEnabled();
                 const baseOffsets = [[0, -1], [0, 1], [-1, 0], [1, 0]];
                 let crosshairOffsets = baseOffsets.map(([dx, dy]) => [dx, dy, 'center']);
                 if (enhancedOn) {
                   // Check if any base offset would apply (transparent and not painted, unless wrong color)
                   let baseEligible = false;
                   for (const [bdx, bdy] of baseOffsets) {
                     const bx = px + bdx;
                     const by = py + bdy;
                     if (bx < 0 || bx >= width || by < 0 || by >= height) continue;
                     const bi = (by * width + bx) * 4;
                     if (originalData[bi + 3] !== 0) continue; // must be transparent in template
                     let painted = false;
                     if (canvasRegionData) {
                       painted = canvasRegionData[bi + 3] > 0;
                     } else {
                       const canvasX = bx + templateOffsetX;
                       const canvasY = by + templateOffsetY;
                       if (canvasX >= 0 && canvasX < canvas.width && canvasY >= 0 && canvasY < canvas.height) {
                         const canvasIndex = (canvasY * canvas.width + canvasX) * 4;
                         painted = canvasData[canvasIndex + 3] > 0;
                       }
                     }
                     if (!painted || isWrongColor) { baseEligible = true; break; }
                   }
                                     if (baseEligible) {
                    const radius = this.getCrosshairRadius(); // dynamic radius from settings
                    for (let d = 2; d <= radius; d++) {
                      crosshairOffsets.push([0, -d, 'center']);
                      crosshairOffsets.push([0, d, 'center']);
                      crosshairOffsets.push([-d, 0, 'center']);
                      crosshairOffsets.push([d, 0, 'center']);
                    }
                  }
                 }
                 
                 for (const [dx, dy, type] of crosshairOffsets) {
                   const x = px + dx;
                   const y = py + dy;
                   
                   // Quick bounds check
                   if (x < 0 || x >= width || y < 0 || y >= height) continue;
                   
                   const i = (y * width + x) * 4;
                   
                   // Only modify transparent template pixels
                   if (originalData[i + 3] !== 0) continue;
                   
                   // Standard logic: skip if already painted (but allow wrong color crosshairs)
                   let skipPainted = false;
                   if (canvasRegionData) {
                     skipPainted = canvasRegionData[i + 3] > 0;
                   } else {
                     // Fallback for edge cases
                     const canvasX = x + templateOffsetX;
                     const canvasY = y + templateOffsetY;
                     if (canvasX >= 0 && canvasX < canvas.width && canvasY >= 0 && canvasY < canvas.height) {
                       const canvasIndex = (canvasY * canvas.width + canvasX) * 4;
                       skipPainted = canvasData[canvasIndex + 3] > 0;
                     }
                   }
                   
                   // For wrong colors, we want to show crosshair even if pixel is painted (to highlight the wrong color)
                   if (skipPainted && !isWrongColor) continue;
                   
                   // Apply crosshair with same color system for both normal and wrong colors
                   const crosshairColor = this.getCrosshairColor();
                   
                   data[i] = crosshairColor.rgb[0]; 
                   data[i + 1] = crosshairColor.rgb[1]; 
                   data[i + 2] = crosshairColor.rgb[2]; 
                   data[i + 3] = crosshairColor.alpha;
                   crosshairCenterCount++;
                 }
               
                 // Apply corner borders if enabled
                 if (borderEnabled) {
                   const cornerOffsets = [
                     [1, 1], [-1, 1], [1, -1], [-1, -1] // Diagonal corners
                   ];
                   
                   for (const [dx, dy] of cornerOffsets) {
                     const x = px + dx;
                     const y = py + dy;
                     
                     // Quick bounds check
                     if (x < 0 || x >= width || y < 0 || y >= height) continue;
                     
                     const i = (y * width + x) * 4;
                     
                     // Only modify transparent template pixels
                     if (originalData[i + 3] !== 0) continue;
                     
                     // Fast canvas collision check
                     let skipPainted = false;
                     if (canvasRegionData) {
                       skipPainted = canvasRegionData[i + 3] > 0;
                     } else {
                       // Fallback for edge cases
                       const canvasX = x + templateOffsetX;
                       const canvasY = y + templateOffsetY;
                       if (canvasX >= 0 && canvasX < canvas.width && canvasY >= 0 && canvasY < canvas.height) {
                         const canvasIndex = (canvasY * canvas.width + canvasX) * 4;
                         skipPainted = canvasData[canvasIndex + 3] > 0;
                       }
                     }
                     
                     if (skipPainted) continue;
                     
                     // Apply blue corner border
                     data[i] = 0;       // No red
                     data[i + 1] = 100; // Some green  
                     data[i + 2] = 255; // Full blue
                     data[i + 3] = 200; // 80% opacity
                     borderCount++;
                   }
                 }
               }
             }
             
               debugLog(`Applied ${crosshairCenterCount} crosshairs and ${borderCount} borders`);
               if (this.enhanceWrongColors && wrongColorCount > 0) {
                 debugLog(`Enhanced ${wrongColorCount} wrong color pixels`);
               }
           }
         }
        
        // Put the processed image data back
        tempCtx.putImageData(imageData, 0, 0);
        
        // Draw the processed template
        context.drawImage(tempCanvas, Number(template.pixelCoords[0]) * this.drawMult, Number(template.pixelCoords[1]) * this.drawMult);
      }
    }

    // ==================== PIXEL COUNTING (Storage Fork Logic) ====================
    // Count painted/wrong/required pixels for this tile
    if (templatesToDraw.length > 0) {
      let paintedCount = 0;
      let wrongCount = 0;
      let requiredCount = 0;
      
      try {
        // CRITICAL FIX: Always use fresh tile blob data (no cache for pixel analysis)
        // Extract tileX and tileY from tileCoords parameter
        const coordsParts = tileCoords.split(',');
        const tileX = parseInt(coordsParts[0]);
        const tileY = parseInt(coordsParts[1]);
        const tileKey = `${tileX},${tileY}`;
        let tileImageData;
        
        // ALWAYS get fresh data for accurate pixel counting
        {
          // CRITICAL FIX: Use the actual tile blob data (from server)
          // This represents the real pixels painted on the server, not our template overlay
          
          // Get the raw tile data directly from tileBlob parameter
          const realTileBitmap = await createImageBitmap(tileBlob);
          const realTileCanvas = document.createElement('canvas');
          realTileCanvas.width = drawSize;
          realTileCanvas.height = drawSize;
          const realTileCtx = realTileCanvas.getContext('2d', { willReadFrequently: true });
          realTileCtx.imageSmoothingEnabled = false;
          realTileCtx.clearRect(0, 0, drawSize, drawSize);
          realTileCtx.drawImage(realTileBitmap, 0, 0, drawSize, drawSize);
          
          tileImageData = realTileCtx.getImageData(0, 0, drawSize, drawSize);
          debugLog(`[Fresh Analysis] Using fresh tile data for ${tileKey}`);
        }
        
        const tilePixels = tileImageData.data;
        
        debugLog(` [Real Tile Analysis] Using actual tile data from server: ${drawSize}x${drawSize}`);
        
        // Prepare per-color breakdown that will be populated from template bitmap comparisons
        const colorBreakdown = {};

        for (const template of templatesToDraw) {
          // Count pixels using Storage fork logic (center pixels only)
          const tempW = template.bitmap.width;
          const tempH = template.bitmap.height;
          const tempCanvas = document.createElement('canvas');
          tempCanvas.width = tempW;
          tempCanvas.height = tempH;
          const tempCtx = tempCanvas.getContext('2d', { willReadFrequently: true });
          tempCtx.imageSmoothingEnabled = false;
          tempCtx.drawImage(template.bitmap, 0, 0);
          const tImg = tempCtx.getImageData(0, 0, tempW, tempH);
          const tData = tImg.data;

          const offsetX = Number(template.pixelCoords[0]) * this.drawMult;
          const offsetY = Number(template.pixelCoords[1]) * this.drawMult;

          for (let y = 0; y < tempH; y++) {
            for (let x = 0; x < tempW; x++) {
              // Only evaluate the center pixel of each 3x3 block
              if ((x % this.drawMult) !== 1 || (y % this.drawMult) !== 1) { continue; }
              
              const gx = x + offsetX;
              const gy = y + offsetY;
              if (gx < 0 || gy < 0 || gx >= drawSize || gy >= drawSize) { continue; }
              
              const tIdx = (y * tempW + x) * 4;
              const tr = tData[tIdx];
              const tg = tData[tIdx + 1];
              const tb = tData[tIdx + 2];
              const ta = tData[tIdx + 3];
              
              // Ignore transparent and semi-transparent (deface uses alpha 32)
              if (ta < 64) { continue; }
              // Ignore #deface explicitly
              if (tr === 222 && tg === 250 && tb === 206) { continue; }
              
              const colorKey = `${tr},${tg},${tb}`;
              if (!colorBreakdown[colorKey]) {
                colorBreakdown[colorKey] = { painted: 0, required: 0, wrong: 0, firstWrongPixel: null };
              }
              colorBreakdown[colorKey].required++;
              requiredCount++;

              const tileIdx = (gy * drawSize + gx) * 4;
              const pr = tilePixels[tileIdx];
              const pg = tilePixels[tileIdx + 1];
              const pb = tilePixels[tileIdx + 2];
              const pa = tilePixels[tileIdx + 3];

              if (pa < 64) {
              } else if (pr === tr && pg === tg && pb === tb) {
                paintedCount++;
                colorBreakdown[colorKey].painted++;
              } else {
                wrongCount++;
                colorBreakdown[colorKey].wrong++;
                if (!colorBreakdown[colorKey].firstWrongPixel) {
                  const pixelX = Math.floor(gx / this.drawMult);
                  const pixelY = Math.floor(gy / this.drawMult);
                  colorBreakdown[colorKey].firstWrongPixel = [pixelX, pixelY];
                }
              }
            }
          }
        }
        
        this.tileProgress.set(tileCoords, {
          painted: paintedCount,
          required: requiredCount,
          wrong: wrongCount,
          colorBreakdown: colorBreakdown // NEW: Per-color detailed stats
        });
        
        // DETAILED ACCURACY DEBUG: Show change from last analysis
        const lastProgressKey = `lastProgress_${tileX}_${tileY}`;
        const lastProgress = this[lastProgressKey] || { painted: 0, required: 0, wrong: 0 };
        const paintedDiff = paintedCount - lastProgress.painted;
        const wrongDiff = wrongCount - lastProgress.wrong;
        
        if (paintedDiff !== 0 || wrongDiff !== 0) {
          debugLog(`[Accuracy Debug] Change detected:`);
          debugLog(`   Painted: ${paintedDiff > 0 ? '+' : ''}${paintedDiff} (${lastProgress.painted} → ${paintedCount})`);
          debugLog(`   ❌ Wrong: ${wrongDiff > 0 ? '+' : ''}${wrongDiff} (${lastProgress.wrong} → ${wrongCount})`);
          debugLog(`   Net Progress: ${paintedDiff - wrongDiff} pixels`);
        }
        
        // Store current progress for next comparison
        this[lastProgressKey] = { painted: paintedCount, required: requiredCount, wrong: wrongCount };
        
        debugLog(`[Tile Progress] ${tileCoords}: ${paintedCount}/${requiredCount} painted, ${wrongCount} wrong`);
        
        // CROSSHAIR COMPARISON DEBUG: Compare with enhanced mode logic
        const missingPixels = requiredCount - paintedCount;
        const totalProblems = missingPixels + wrongCount;
        debugLog(`[Crosshair Debug] Missing: ${missingPixels}, Wrong: ${wrongCount}, Total problems: ${totalProblems}`);
        
      } catch (error) {
        console.warn('Failed to compute tile progress stats:', error);
      }
    }

    // ==================== ERROR MAP MODE (LURK INTEGRATION) ====================
    // Apply green/red overlay when error map mode is enabled (based on lurk logic)
    if (this.errorMapEnabled && templatesToDraw.length > 0) {
      try {
        // Get fresh tile pixels from the original tileBlob (not our overlay with template drawn)
        let tilePixels = null;
        try {
          // Use the original tile blob data for accurate pixel comparison
          const originalTileBitmap = await createImageBitmap(tileBlob);
          const originalTileCanvas = document.createElement('canvas');
          originalTileCanvas.width = drawSize;
          originalTileCanvas.height = drawSize;
          const originalTileCtx = originalTileCanvas.getContext('2d', { willReadFrequently: true });
          originalTileCtx.imageSmoothingEnabled = false;
          originalTileCtx.clearRect(0, 0, drawSize, drawSize);
          originalTileCtx.drawImage(originalTileBitmap, 0, 0, drawSize, drawSize);
          const originalTileImageData = originalTileCtx.getImageData(0, 0, drawSize, drawSize);
          tilePixels = originalTileImageData.data;
        } catch (_) {
          // If reading fails for any reason, we will skip error map
        }

        if (tilePixels) {
          // Store correct and wrong pixels map for visual render (lurk style)
          const wrongMap = [];
          const correctMap = [];

          // Analyze each template (same logic as lurk)
          for (const template of templatesToDraw) {
            const tempW = template.bitmap.width;
            const tempH = template.bitmap.height;
            const tempCanvas = new OffscreenCanvas(tempW, tempH);
            const tempCtx = tempCanvas.getContext('2d', { willReadFrequently: true });
            tempCtx.imageSmoothingEnabled = false;
            tempCtx.clearRect(0, 0, tempW, tempH);
            tempCtx.drawImage(template.bitmap, 0, 0);
            const tImg = tempCtx.getImageData(0, 0, tempW, tempH);
            const tData = tImg.data;

            const offsetX = Number(template.pixelCoords[0]) * this.drawMult;
            const offsetY = Number(template.pixelCoords[1]) * this.drawMult;

            for (let y = 0; y < tempH; y++) {
              for (let x = 0; x < tempW; x++) {
                // Only evaluate the center pixel of each 3x3 block (lurk logic)
                if ((x % this.drawMult) !== 1 || (y % this.drawMult) !== 1) { continue; }
                const gx = x + offsetX;
                const gy = y + offsetY;
                if (gx < 0 || gy < 0 || gx >= drawSize || gy >= drawSize) { continue; }
                const tIdx = (y * tempW + x) * 4;
                const tr = tData[tIdx];
                const tg = tData[tIdx + 1];
                const tb = tData[tIdx + 2];
                const ta = tData[tIdx + 3];
                
                // Handle template transparent pixel (alpha < 64): wrong if board has any site palette color here
                if (ta < 64) {
                  try {
                    const activeTemplate = this.templatesArray?.[0];
                    const tileIdx = (gy * drawSize + gx) * 4;
                    const pr = tilePixels[tileIdx];
                    const pg = tilePixels[tileIdx + 1];
                    const pb = tilePixels[tileIdx + 2];
                    const pa = tilePixels[tileIdx + 3];
                    const key = `${pr},${pg},${pb}`;
                    const isSiteColor = activeTemplate?.allowedColorsSet ? activeTemplate.allowedColorsSet.has(key) : false;
                    if (pa >= 64 && isSiteColor) {
                      wrongMap.push({ x: gx, y: gy, color: `${tr},${tg},${tb}` });
                    }
                  } catch (_) {}
                  continue;
                }
                
                // Treat #deface as Transparent palette color (required and paintable)
                // Ignore non-palette colors (match against allowed set when available)
                try {
                  const activeTemplate = this.templatesArray?.[0];
                  if (activeTemplate?.allowedColorsSet && !activeTemplate.allowedColorsSet.has(`${tr},${tg},${tb}`)) {
                    continue;
                  }
                } catch (_) {}

                // Strict center-pixel matching. Treat transparent tile pixels as unpainted (not wrong)
                const tileIdx = (gy * drawSize + gx) * 4;
                const pr = tilePixels[tileIdx];
                const pg = tilePixels[tileIdx + 1];
                const pb = tilePixels[tileIdx + 2];
                const pa = tilePixels[tileIdx + 3];

                if (pa < 64) {
                  // Unpainted -> neither painted nor wrong
                  // if it not a transparent pixel on target template, treat it as wrong pixel
                  if (this.showUnpaintedAsWrong && ta !== 0) {
                    wrongMap.push({ x: gx, y: gy, color: `${tr},${tg},${tb}`, unpainted: true });
                  }
                } else if (pr === tr && pg === tg && pb === tb) {
                  correctMap.push({ x: gx, y: gy, color: `${tr},${tg},${tb}` });
                } else {
                  wrongMap.push({ x: gx, y: gy, color: `${tr},${tg},${tb}`, unpainted: false });
                }
              }
            }
          }

          // Draw the stat map (exact lurk logic)
          context.globalCompositeOperation = "source-over";

          const activeTemplate = this.templatesArray?.[0];
          const palette = activeTemplate?.colorPalette || {};

          const isDisable = key => {
            const inSitePalette = activeTemplate?.allowedColorsSet ? activeTemplate.allowedColorsSet.has(key) : true;
            const enabled = palette?.[key]?.enabled !== false;
            return !inSitePalette || !enabled;
          }

          if (this.showWrongPixels) {
            // Use blur dark red as marker for wrong pixel
            context.fillStyle = "rgba(255, 0, 0, 0.8)";
            for (const { x, y, color, unpainted } of wrongMap) {
              if (isDisable(color)) {continue;}
              if (unpainted) {
                // Only mark a most center pixel for better visibility
                context.fillRect(x, y, 1, 1);
              }
              else {
                // Calculate offset base on enlarged size
                const offset = Math.floor(this.drawMult / 2);
                context.fillRect(x - offset, y - offset, this.drawMult, this.drawMult);
              }
            }
          }

          if (this.showCorrectPixels) {
            // Use blur dark green as marker for correct pixel
            context.fillStyle = "rgba(0, 128, 0, 0.6)";
            for (const { x, y, color } of correctMap) {
              if (isDisable(color)) {continue;}
              // Calculate offset base on enlarged size
              const offset = Math.floor(this.drawMult / 2); 
              context.fillRect(x - offset, y - offset, this.drawMult, this.drawMult);
            }
          }
        }
        
      } catch (error) {
        console.warn('Failed to render error map overlay:', error);
      }
    }

    // Use compatible blob conversion
    return await new Promise((resolve, reject) => {
      if (canvas.convertToBlob) {
        canvas.convertToBlob({ type: 'image/png' }).then(resolve).catch(reject);
      } else {
        canvas.toBlob(resolve, 'image/png');
      }
    });
  }



  /** Imports the JSON object, and appends it to any JSON object already loaded
   * @param {string} json - The JSON string to parse
   */
  importJSON(json) {

    debugLog(`Importing JSON...`);
    // Minimal logging for performance during template loading

    // If the passed in JSON is a Blue Marble template object...
    // Accept both legacy 'SkirkMarble' and current 'BlueMarble' whoami values
    const validWhoami = ['SkirkMarble', 'BlueMarble', this.name?.replace(' ', '')].filter(Boolean);
    if (validWhoami.includes(json?.whoami)) {
      debugLog('Calling #parseBlueMarble...');
      this.#parseBlueMarble(json); // ...parse the template object as Blue Marble
    } else {
      console.warn('❌ Not a valid BlueMarble JSON:', {
        whoami: json?.whoami,
        expected: validWhoami,
        hasTemplates: !!json?.templates
      });
    }
  }

  /** Parses the Blue Marble JSON object
   * @param {string} json - The JSON string to parse
   * @since 0.72.13
   */
  async #parseBlueMarble(json) {

    debugLog(`Parsing BlueMarble...`);
    
    // *** FIX: Restore templatesJSON from loaded data ***
    this.templatesJSON = json;

    const templates = json.templates;

    debugLog(`BlueMarble length: ${Object.keys(templates).length}`);

    if (Object.keys(templates).length > 0) {

      for (const template in templates) {

        const templateKey = template;
        const templateValue = templates[template];
        if (templates.hasOwnProperty(template)) {

          const templateKeyArray = templateKey.split(' '); // E.g., "0 $Z" -> ["0", "$Z"]
          const sortID = Number(templateKeyArray?.[0]); // Sort ID of the template
          const authorID = templateKeyArray?.[1] || '0'; // User ID of the person who exported the template
          const displayName = templateValue.name || `Template ${sortID || ''}`; // Display name of the template
          const coords = templateValue?.coords?.split(', ').map(Number); // "1, 2, 3, 4" -> [1, 2, 3, 4]
          const tilesbase64 = templateValue.tiles;
          const templateTiles = {}; // Stores the template bitmap tiles for each tile.
          let totalPixelCount = 0; // Calculate total pixels across all tiles

          // Process tiles in parallel for better performance
          const tilePromises = Object.entries(tilesbase64).map(async ([tile, encodedTemplateBase64]) => {
            const templateUint8Array = base64ToUint8(encodedTemplateBase64); // Base 64 -> Uint8Array
            const templateBlob = new Blob([templateUint8Array], { type: "image/png" }); // Uint8Array -> Blob
            const templateBitmap = await createImageBitmap(templateBlob) // Blob -> Bitmap
            return [tile, templateBitmap];
          });
          
          const processedTiles = await Promise.all(tilePromises);
          for (const [tile, bitmap] of processedTiles) {
            templateTiles[tile] = bitmap;
          }

          const template = new Template({
            displayName: displayName,
            sortID: sortID || this.templatesArray?.length || 0,
            authorID: authorID || '',
            coords: coords
          });
          template.chunked = templateTiles;
          // Restore pixel count from stored data for fast loading
          template.pixelCount = templateValue.pixelCount || 0;
          
          // Load disabled colors if they exist
          const disabledColors = templateValue.disabledColors;
          if (disabledColors && Array.isArray(disabledColors)) {
            template.setDisabledColors(disabledColors);
          }
          
          // Load enhanced colors if they exist
          const enhancedColors = templateValue.enhancedColors;
          if (enhancedColors && Array.isArray(enhancedColors)) {
            template.setEnhancedColors(enhancedColors);
          }
          
          // Wrong color settings are now managed globally, not per template
          // These settings should not be overridden during template loading
          // The settings are loaded from storage in the constructor and should persist
          
          this.templatesArray.push(template);
          // Template loaded successfully
        }
      }
    }
  }

  /** Sets the `templatesShouldBeDrawn` boolean to a value.
   * @param {boolean} value - The value to set the boolean to
   * @since 0.73.7
   */
  setTemplatesShouldBeDrawn(value) {
    this.templatesShouldBeDrawn = value;
  }

  /** Enables or disables a specific template by its key
   * @param {string} templateKey - The template key (e.g., "0 I+`")
   * @param {boolean} enabled - Whether to enable or disable the template
   * @since 1.0.0
   */
  setTemplateEnabled(templateKey, enabled) {
    if (!this.templatesJSON?.templates?.[templateKey]) {
      console.warn(`Template not found: ${templateKey}`);
      return false;
    }

    // Update JSON
    this.templatesJSON.templates[templateKey].enabled = enabled;
    
    // Update metadata
    this.templatesJSON.lastModified = new Date().toISOString();
    
    // Save to storage
    this.#storeTemplates();
    
    // CRITICAL FIX: Clear tile progress cache when template enabled state changes
    // This prevents disabled template data from leaking into progress calculations
    this.clearTileProgressCache();
    
    debugLog(`${enabled ? 'Enabled' : 'Disabled'} template: ${templateKey} - cleared tile progress cache`);
    return true;
  }

  /** Rename a template and persist the change
   * @param {string} templateKey
   * @param {string} newName
   * @since 1.0.0
   */
  async renameTemplate(templateKey, newName) {
    try {
      if (!this.templatesJSON?.templates?.[templateKey]) return false;
      const safeName = String(newName || '').trim();
      if (!safeName) return false;

      this.templatesJSON.templates[templateKey].name = safeName;
      this.templatesJSON.lastModified = new Date().toISOString();

      // Update in-memory Template instance if present
      const [sortIdStr, authorId] = templateKey.split(' ');
      const sortId = parseInt(sortIdStr, 10);
      const idx = this.templatesArray?.findIndex(t => t.sortID === sortId && t.authorID === authorId) ?? -1;
      if (idx !== -1) {
        this.templatesArray[idx].displayName = safeName;
      }

      await this.#storeTemplates();
      return true;
    } catch (e) {
      console.error('Failed to rename template', e);
      return false;
    }
  }



  /** Clears the tile progress cache to prevent data leakage between enabled/disabled templates
   * This ensures that progress calculations only include data from currently enabled templates
   * @since 1.0.0
   */
  clearTileProgressCache() {
    const oldSize = this.tileProgress.size;
    this.tileProgress.clear();
    debugLog(`🧹 [Cache Clear] Cleared ${oldSize} tile progress entries to prevent template data leakage`);
  }

  /** Enables or disables smart template detection
   * When enabled, progress automatically shows only for templates currently being displayed
   * @param {boolean} enabled - Whether to enable smart detection
   * @since 1.0.0
   */
  setSmartDetectionEnabled(enabled) {
    this.smartDetectionEnabled = enabled;
    debugLog(`[Smart Detection] ${enabled ? 'Enabled' : 'Disabled'} smart template detection`);
    
    // Clear cache to force recalculation with new detection mode
    this.clearTileProgressCache();
  }

  /** Gets the current smart detection enabled state
   * @returns {boolean} Whether smart detection is enabled
   * @since 1.0.0
   */
  getSmartDetectionEnabled() {
    return this.smartDetectionEnabled;
  }

  /** Gets information about currently displayed templates
   * @returns {Object} Information about displayed templates
   * @since 1.0.0
   */
  getDisplayedTemplatesInfo() {
    return {
      count: this.lastDisplayedCount,
      templates: Array.from(this.currentlyDisplayedTemplates),
      smartDetectionActive: this.smartDetectionEnabled && this.lastDisplayedCount === 1
    };
  }

  /** Gets the enabled state of a specific template
   * @param {string} templateKey - The template key (e.g., "0 I+`")
   * @returns {boolean} Whether the template is enabled
   * @since 1.0.0
   */
  isTemplateEnabled(templateKey) {
    return this.templatesJSON?.templates?.[templateKey]?.enabled ?? true;
  }

  /** Updates template color filter settings (storage only, filtering applied during draw)
   * @param {number} templateIndex - Index of template to update (default: 0)
   * @since 1.0.0
   */
  async updateTemplateWithColorFilter(templateIndex = 0) {
    if (!this.templatesArray || !this.templatesArray[templateIndex]) {
      console.warn('No template available for color filter update');
      return;
    }

    const template = this.templatesArray[templateIndex];
    
    try {
      debugLog('Updating template color filter settings, disabled colors:', template.getDisabledColors());
      
      // Only update storage settings, DON'T modify the actual tiles
      // Color filtering will be applied during drawTemplateOnTile()
      
      // Update JSON if it exists
      if (this.templatesJSON && this.templatesJSON.templates) {
        const templateKey = `${template.sortID} ${template.authorID}`;
        if (this.templatesJSON.templates[templateKey]) {
          // ONLY save the color settings, keep original tiles unchanged
          this.templatesJSON.templates[templateKey].disabledColors = template.getDisabledColors();
          this.templatesJSON.templates[templateKey].enhancedColors = template.getEnhancedColors();
          // Wrong color settings are now managed globally, not saved per template
          debugLog('JSON updated with new filter settings (settings only, tiles unchanged)');
        }
      }
      
      // Store updated settings
      await this.#storeTemplates();
      
      debugLog('Template color filter settings updated successfully');
      
    } catch (error) {
      console.error('Error updating template color filter settings:', error);
      this.overlay.handleDisplayError('Failed to update template color filter settings');
      throw error; // Re-throw for better error handling
    }
  }

  /** Updates disabled colors for a specific template
   * @param {string[]} disabledColors - Array of disabled color keys "r,g,b"
   * @param {number} templateIndex - Index of template to update (default: 0)
   * @since 1.0.0
   */
  async setTemplateDisabledColors(disabledColors, templateIndex = 0) {
    if (!this.templatesArray || !this.templatesArray[templateIndex]) {
      console.warn('No template available for color filter update');
      return;
    }

    const template = this.templatesArray[templateIndex];
    template.setDisabledColors(disabledColors);
    
    // Update the template tiles
    await this.updateTemplateWithColorFilter(templateIndex);
  }

  /** Gets disabled colors for a specific template
   * @param {number} templateIndex - Index of template (default: 0)
   * @returns {string[]} Array of disabled color keys "r,g,b"
   * @since 1.0.0
   */
  getTemplateDisabledColors(templateIndex = 0) {
    if (!this.templatesArray || !this.templatesArray[templateIndex]) {
      return [];
    }
    
    return this.templatesArray[templateIndex].getDisabledColors();
  }

  /** Analyzes template using enhanced mode logic to count remaining pixels by color
   * Uses the EXACT same logic as enhanced mode to determine which pixels need crosshair
   * @param {number} templateIndex - Index of template to analyze (default: 0)
   * @returns {Object} Object with color keys mapping to { totalRequired, painted, needsCrosshair, percentage }
   * @since 1.0.0
   */
  calculateRemainingPixelsByColor(templateIndex = 0, onlyEnabledTemplates = true) {
    debugLog('[Enhanced Pixel Analysis] Starting calculation for template index:', templateIndex);
    
    // SMART DETECTION: Use only currently displayed templates if smart detection is enabled and only 1 template is displayed
    let useSmartDetection = false;
    let smartTemplateKeys = new Set();
    
    if (this.smartDetectionEnabled && this.lastDisplayedCount === 1 && this.currentlyDisplayedTemplates.size === 1) {
      useSmartDetection = true;
      smartTemplateKeys = new Set(this.currentlyDisplayedTemplates);
      debugLog(`[Smart Detection] Using smart detection - showing progress for actively displayed template only`);
      for (const templateKey of smartTemplateKeys) {
        const template = this.templatesArray.find(t => `${t.sortID} ${t.authorID}` === templateKey);
        if (template) {
          debugLog(`[Smart Detection] Target template: ${template.displayName}`);
        }
      }
    }
    
    // NEW: Get list of enabled templates for filtering
    const enabledTemplateKeys = useSmartDetection ? smartTemplateKeys : new Set();
    
    if (!useSmartDetection && onlyEnabledTemplates && this.templatesArray) {
      for (const template of this.templatesArray) {
        const templateKey = `${template.sortID} ${template.authorID}`;
        if (this.isTemplateEnabled(templateKey)) {
          enabledTemplateKeys.add(templateKey);
          debugLog(`[Progress Filter] Including enabled template: ${templateKey} (${template.displayName})`);
        } else {
          debugLog(`❌ [Progress Filter] Excluding disabled template: ${templateKey} (${template.displayName})`);
        }
      }
      
      if (enabledTemplateKeys.size === 0) {
        console.warn('🚨 [Enhanced Pixel Analysis] No enabled templates found');
        return {};
      }
      
      debugLog(`[Progress Filter] Will calculate progress for ${enabledTemplateKeys.size} enabled templates only`);
    }
    
    // NEW: Find the first enabled template to use as reference instead of using templateIndex
    let template = null;
    if (onlyEnabledTemplates && enabledTemplateKeys.size > 0) {
      // Use the first enabled template as reference
      for (const templateCandidate of this.templatesArray) {
        const templateKey = `${templateCandidate.sortID} ${templateCandidate.authorID}`;
        if (enabledTemplateKeys.has(templateKey)) {
          template = templateCandidate;
          debugLog(`[Enhanced Pixel Analysis] Using enabled template as reference: ${template.displayName}`);
          break;
        }
      }
      
      if (!template) {
        console.warn('🚨 [Enhanced Pixel Analysis] No enabled template found for reference');
        return {};
      }
    } else {
      // Fallback to original logic for backward compatibility
      if (!this.templatesArray || !this.templatesArray[templateIndex]) {
        console.warn('🚨 [Enhanced Pixel Analysis] No template available');
        return {};
      }
      template = this.templatesArray[templateIndex];
      debugLog('[Enhanced Pixel Analysis] Template found (fallback):', template.displayName);
    }
    
          // Using fresh tile data for accurate analysis (no cache)
      debugLog('[Enhanced Pixel Analysis] Using fresh tile analysis for accuracy (enabled templates filtering:', onlyEnabledTemplates, ')');
    
    try {
      // Check if we have tile-based progress data (from Storage fork logic)
      debugLog('[Enhanced Pixel Analysis] Checking tile progress data:', this.tileProgress);
      
      if (this.tileProgress && this.tileProgress.size > 0) {
        // Use tile-based analysis like the Storage fork
        const colorStats = {};
        
        // Aggregate painted/wrong across tiles - WITH REAL PER-COLOR STATS
        let totalPainted = 0;
        let totalRequired = 0;
        let totalWrong = 0;
        const realColorStats = {}; // Real per-color statistics from tile analysis
        
        for (const [tileKey, stats] of this.tileProgress.entries()) {
          // NEW: Filter tiles by enabled templates only
          let shouldIncludeTile = true;
          
          if (onlyEnabledTemplates && enabledTemplateKeys.size > 0) {
            // Check if this tile belongs to any enabled template
            shouldIncludeTile = false;
            
            // Extract tile coordinates for template matching
            const [tileX, tileY] = tileKey.split(',').map(coord => parseInt(coord));
            
            for (const template of this.templatesArray) {
              const templateKey = `${template.sortID} ${template.authorID}`;
              
              // Only check enabled templates
              if (!enabledTemplateKeys.has(templateKey)) continue;
              
              // Check if this tile intersects with any template chunks
              if (template.chunked) {
                for (const chunkKey of Object.keys(template.chunked)) {
                  const [chunkTileX, chunkTileY] = chunkKey.split(',').map(coord => parseInt(coord));
                  
                  if (chunkTileX === tileX && chunkTileY === tileY) {
                    shouldIncludeTile = true;
                    debugLog(`[Progress Filter] Including tile ${tileKey} from enabled template: ${template.displayName}`);
                    break;
                  }
                }
              }
              
              if (shouldIncludeTile) break;
            }
            
            if (!shouldIncludeTile) {
              debugLog(`🚫 [Progress Filter] Excluding tile ${tileKey} (belongs to disabled template)`);
              continue;
            }
          }
          
          totalPainted += stats.painted || 0;
          totalRequired += stats.required || 0;  
          totalWrong += stats.wrong || 0;
          
          // NEW: Aggregate real per-color stats from this tile
          if (stats.colorBreakdown) {
            for (const [colorKey, colorData] of Object.entries(stats.colorBreakdown)) {
              if (!realColorStats[colorKey]) {
                realColorStats[colorKey] = { painted: 0, required: 0, wrong: 0 };
              }
              realColorStats[colorKey].painted += colorData.painted;
              realColorStats[colorKey].required += colorData.required;
              realColorStats[colorKey].wrong += colorData.wrong;
            }
          }
        }
        
        debugLog(`[Enhanced Pixel Analysis] Aggregated from ${this.tileProgress.size} tiles (filtering: ${onlyEnabledTemplates ? 'enabled only' : 'all templates'}):`);
        debugLog(`   Total painted: ${totalPainted.toLocaleString()}`);
        debugLog(`   Total required: ${totalRequired.toLocaleString()}`);
        debugLog(`   Total wrong: ${totalWrong.toLocaleString()}`);
        debugLog(`[Real Color Stats] Found ${Object.keys(realColorStats).length} colors with precise data`);
        
        // Use template's color palette to break down by color
        debugLog('[Enhanced Pixel Analysis] Template colorPalette:', template.colorPalette);
        // debugLog('🔍 [Enhanced Pixel Analysis] ColorPalette keys:', Object.keys(template.colorPalette || {}));
        
        // If no color palette, rebuild it from tile data
        if (!template.colorPalette || Object.keys(template.colorPalette).length === 0) {
          // debugLog('🔧 [Enhanced Pixel Analysis] Color palette empty, rebuilding from tiles...');
          template.colorPalette = this.buildColorPaletteFromTileProgress(template);
          // debugLog('🔧 [Enhanced Pixel Analysis] Rebuilt palette:', Object.keys(template.colorPalette));
        }
        
        if (template.colorPalette && Object.keys(template.colorPalette).length > 0) {
          for (const [colorKey, paletteInfo] of Object.entries(template.colorPalette)) {
            const colorCount = paletteInfo.count || 0;
            
            // Use REAL color data if available, otherwise fall back to proportional
            let paintedForColor, wrongForColor, needsCrosshair, percentage;
            
                         if (realColorStats[colorKey]) {
               // Use PRECISE data from per-color tile analysis
               paintedForColor = realColorStats[colorKey].painted;
               wrongForColor = realColorStats[colorKey].wrong;
               
               // Apply wrong color logic based on settings
               if (this.includeWrongColorsInProgress) {
                 // Include wrong colors in progress calculation (wrong pixels count as "painted")
                 const effectivePainted = paintedForColor + wrongForColor;
                 const effectiveRequired = realColorStats[colorKey].required; // Keep original required, wrong pixels are already part of it
                 needsCrosshair = effectiveRequired - effectivePainted;
                 percentage = effectiveRequired > 0 ? 
                   Math.round((effectivePainted / effectiveRequired) * 100) : 0;
                 
                //  debugLog(`🎯 [REAL DATA + WRONG] ${colorKey}: ${effectivePainted}/${effectiveRequired} (${percentage}%) - ${needsCrosshair} need crosshair (includes ${wrongForColor} wrong)`);
               } else {
                 // Standard calculation (exclude wrong colors)
                 needsCrosshair = realColorStats[colorKey].required - paintedForColor;
                 percentage = realColorStats[colorKey].required > 0 ? 
                   Math.round((paintedForColor / realColorStats[colorKey].required) * 100) : 0;
                 
                //  debugLog(`🎯 [REAL DATA] ${colorKey}: ${paintedForColor}/${realColorStats[colorKey].required} (${percentage}%) - ${needsCrosshair} need crosshair`);
               }
            } else {
              // Fall back to proportional estimation for colors without real data
              const proportionOfTemplate = totalRequired > 0 ? colorCount / totalRequired : 0;
              paintedForColor = Math.round(totalPainted * proportionOfTemplate);
              wrongForColor = Math.round(totalWrong * proportionOfTemplate);
              
                             if (this.includeWrongColorsInProgress) {
                 // Include wrong colors in progress calculation (wrong pixels count as "painted")
                 const effectivePainted = paintedForColor + wrongForColor;
                 const effectiveRequired = colorCount; // Keep original required, wrong pixels are already part of it
                 needsCrosshair = effectiveRequired - effectivePainted;
                 percentage = effectiveRequired > 0 ? Math.round((effectivePainted / effectiveRequired) * 100) : 0;
                 
                 debugLog(`[ESTIMATED + WRONG] ${colorKey}: ${effectivePainted}/${effectiveRequired} (${percentage}%) - ${needsCrosshair} need crosshair (includes ${wrongForColor} wrong)`);
               } else {
                // Standard calculation (exclude wrong colors)
                needsCrosshair = colorCount - paintedForColor;
                percentage = colorCount > 0 ? Math.round((paintedForColor / colorCount) * 100) : 0;
                
                // debugLog(`📊 [ESTIMATED] ${colorKey}: ${paintedForColor}/${colorCount} (${percentage}%) - ${needsCrosshair} need crosshair`);
              }
            }
            
            // Apply wrong color logic to painted count for mini tracker
            const effectivePaintedForTracker = this.includeWrongColorsInProgress ? 
              paintedForColor + wrongForColor : paintedForColor;
            
            // Recalculate percentage based on the effective painted count for mini tracker consistency
            const totalRequiredForColor = realColorStats[colorKey] ? realColorStats[colorKey].required : colorCount;
            const correctedPercentage = totalRequiredForColor > 0 ? 
              Math.round((effectivePaintedForTracker / totalRequiredForColor) * 100) : 0;
            
            if (this.includeWrongColorsInProgress && wrongForColor > 0) {
              // debugLog(`🔧 [Mini Tracker Fix] ${colorKey}: painted ${paintedForColor} + wrong ${wrongForColor} = ${effectivePaintedForTracker} (${correctedPercentage}%) - was ${percentage}%`);
            }
            
            colorStats[colorKey] = {
              totalRequired: totalRequiredForColor,
              painted: effectivePaintedForTracker,
              needsCrosshair: Math.max(0, needsCrosshair),
              percentage: correctedPercentage,
              remaining: Math.max(0, needsCrosshair)
            };
          }
        }
        
        debugLog('[Enhanced Pixel Analysis] SUMMARY (from tileProgress):');
        
        // Calculate the ACTUAL totals that will be used by mini tracker
        let totalPaintedForTracker = 0;
        let totalRequiredForTracker = 0;
        for (const stats of Object.values(colorStats)) {
          totalPaintedForTracker += stats.painted || 0;
          totalRequiredForTracker += stats.totalRequired || 0;
        }
        const trackPercentage = totalRequiredForTracker > 0 ? Math.round((totalPaintedForTracker / totalRequiredForTracker) * 100) : 0;
        
        debugLog(`Mini tracker will show: ${totalPaintedForTracker}/${totalRequiredForTracker} (${trackPercentage}%) - ${totalRequiredForTracker - totalPaintedForTracker} need crosshair`);
        
                 // Apply wrong color logic to overall progress
         if (this.includeWrongColorsInProgress) {
           const effectivePainted = totalPainted + totalWrong;
           const effectiveRequired = totalRequired; // Keep original required, wrong pixels are already part of it
           const effectivePercentage = effectiveRequired > 0 ? Math.round((effectivePainted / effectiveRequired) * 100) : 0;
           debugLog(`   Total painted (including wrong): ${effectivePainted}/${effectiveRequired} (${effectivePercentage}%)`);
           debugLog(`   Wrong pixels included in progress: ${totalWrong}`);
         } else {
          debugLog(`   Total painted: ${totalPainted}/${totalRequired} (${totalRequired > 0 ? Math.round((totalPainted / totalRequired) * 100) : 0}%)`);
          debugLog(`   Wrong pixels: ${totalWrong}`);
        }
        
        return colorStats;
        
      } else {
        // console.warn('🚨 [Enhanced Pixel Analysis] No tile progress data available - need to wait for tiles to be processed');
        return this.getFallbackSimulatedStats(template);
      }
      
    } catch (error) {
      console.error('❌ [Enhanced Pixel Analysis] Analysis failed:', error);
      return this.getFallbackSimulatedStats(template);
    }
  }

  /** Analyzes a single tile using enhanced mode logic
   * @param {string} tileKey - Tile key (e.g., "0783,1135,398,618")
   * @param {ImageBitmap} tileBitmap - Tile bitmap
   * @param {Template} template - Template object
   * @param {HTMLCanvasElement} canvas - Main canvas element
   * @param {boolean} hasEnhancedColors - Whether template has enhanced colors defined
   * @returns {Object} Tile analysis results
   * @since 1.0.0
   */
  analyzeTileWithEnhancedLogic(tileKey, tileBitmap, template, canvas, hasEnhancedColors) {
    const coords = tileKey.split(',').map(Number);
    const [tileX, tileY, pixelX, pixelY] = coords;
    
    // Calculate canvas position for this tile
    // For template canvas, use direct coordinates (template canvas shows the full template)
    const canvasX = pixelX - template.coords[2];
    const canvasY = pixelY - template.coords[3];
    
    debugLog(` [Tile Analysis] Tile key: ${tileKey}`);
    debugLog(` [Tile Analysis] Parsed coords: tileX=${tileX}, tileY=${tileY}, pixelX=${pixelX}, pixelY=${pixelY}`);
    debugLog(` [Tile Analysis] Template base coords: (${template.coords[2]}, ${template.coords[3]})`);
    debugLog(` [Tile Analysis] Calculated canvas position: (${canvasX},${canvasY}), tile size: ${tileBitmap.width}x${tileBitmap.height}`);
    debugLog(` [Tile Analysis] Canvas total size: ${canvas.width}x${canvas.height}`);
    
    // Get template bitmap data
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = tileBitmap.width;
    tempCanvas.height = tileBitmap.height;
    const tempCtx = tempCanvas.getContext('2d');
    tempCtx.imageSmoothingEnabled = false;
    tempCtx.drawImage(tileBitmap, 0, 0);
    const templateImageData = tempCtx.getImageData(0, 0, tileBitmap.width, tileBitmap.height);
    const templateData = templateImageData.data;
    
    // Get canvas data for this region
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const tileWidth = Math.min(tileBitmap.width, canvas.width - canvasX);
    const tileHeight = Math.min(tileBitmap.height, canvas.height - canvasY);
    
    if (tileWidth <= 0 || tileHeight <= 0) {
      console.warn(`🚨 [Tile Analysis] Invalid tile dimensions: ${tileWidth}x${tileHeight}`);
      return { colorStats: {}, totalAnalyzed: 0, totalPainted: 0, totalNeedCrosshair: 0 };
    }
    
    const canvasImageData = ctx.getImageData(canvasX, canvasY, tileWidth, tileHeight);
    const canvasData = canvasImageData.data;
    
    // STEP 1: Find enhanced template pixels (EXACT enhanced mode logic)
    const enhancedTemplatePixels = new Set();
    let totalTemplatePixels = 0;
    let enhancedByColor = {};
    let firstPixelsByColor = {};
    
    debugLog(` [Enhanced Detection] Starting enhanced pixel detection...`);
    debugLog(` [Enhanced Detection] Has enhanced colors defined: ${hasEnhancedColors}`);
    if (hasEnhancedColors) {
      debugLog(` [Enhanced Detection] Enhanced colors list:`, Array.from(template.enhancedColors));
    }
    
    for (let y = 0; y < tileBitmap.height; y++) {
      for (let x = 0; x < tileBitmap.width; x++) {
        const i = (y * tileBitmap.width + x) * 4;
        const alpha = templateData[i + 3];
        
        if (alpha > 0) {
          totalTemplatePixels++;
          const r = templateData[i];
          const g = templateData[i + 1];
          const b = templateData[i + 2];
          const colorKey = `${r},${g},${b}`;
          
          // Track pixels by color for debugging
          if (!enhancedByColor[colorKey]) {
            enhancedByColor[colorKey] = 0;
            firstPixelsByColor[colorKey] = `(${x},${y})`;
          }
          
                     // Enhanced mode logic: include if color is enhanced OR no enhanced colors defined OR wrong colors should be enhanced
           const shouldBeEnhanced = !hasEnhancedColors || template.enhancedColors.has(colorKey) || 
             (this.enhanceWrongColors && this.isColorWrongInTile(colorKey, tileCoords));
          
          if (shouldBeEnhanced) {
            enhancedTemplatePixels.add(`${x},${y}`);
            enhancedByColor[colorKey]++;
            
            // Log decision for first few pixels of each color
            if (enhancedByColor[colorKey] <= 3) {
              debugLog(`[Enhanced Detection] Pixel (${x},${y}) color ${colorKey} IS ENHANCED (reason: ${hasEnhancedColors ? 'in enhanced colors list' : 'no enhanced colors defined, all included'})`);
            }
          } else {
            // Log why pixel was excluded
            if (enhancedByColor[colorKey] <= 3) {
              debugLog(`❌ [Enhanced Detection] Pixel (${x},${y}) color ${colorKey} NOT ENHANCED (reason: color not in enhanced colors list)`);
            }
          }
        }
      }
    }
    
    debugLog(` [Enhanced Detection] Enhanced pixels by color:`);
    for (const [colorKey, count] of Object.entries(enhancedByColor)) {
      if (count > 0) {
        debugLog(`   ${colorKey}: ${count} pixels (first at ${firstPixelsByColor[colorKey]})`);
      }
    }
    
    debugLog(` [Tile Analysis] Template pixels: ${totalTemplatePixels} total, ${enhancedTemplatePixels.size} enhanced`);
    
    // STEP 2: Analyze center pixels of 3x3 blocks (enhanced mode logic)
    const colorStats = {};
    let totalAnalyzed = 0;
    let totalPainted = 0;
    let totalNeedCrosshair = 0;
    
    for (let y = 0; y < tileBitmap.height; y += this.drawMult) {
      for (let x = 0; x < tileBitmap.width; x += this.drawMult) {
        const centerX = x + 1;
        const centerY = y + 1;
        
        // Check if center pixel is an enhanced template pixel
        if (!enhancedTemplatePixels.has(`${centerX},${centerY}`)) continue;
        
        const templateIndex = (centerY * tileBitmap.width + centerX) * 4;
        const templateR = templateData[templateIndex];
        const templateG = templateData[templateIndex + 1];
        const templateB = templateData[templateIndex + 2];
        
        // Skip #deface pixels
        if (templateR === 222 && templateG === 250 && templateB === 206) continue;
        
        const colorKey = `${templateR},${templateG},${templateB}`;
        
        // Initialize color stats
        if (!colorStats[colorKey]) {
          colorStats[colorKey] = {
            totalRequired: 0,
            painted: 0,
            needsCrosshair: 0
          };
        }
        
        // This pixel is required by template
        colorStats[colorKey].totalRequired++;
        totalAnalyzed++;
        
        // Check if pixel is correctly painted on canvas
        let isCorrectlyPainted = false;
        let canvasColorInfo = 'no canvas data';
        
        if (centerX < tileWidth && centerY < tileHeight) {
          const canvasIndex = (centerY * tileWidth + centerX) * 4;
          const canvasAlpha = canvasData[canvasIndex + 3];
          
          if (canvasAlpha > 0) {
            const canvasR = canvasData[canvasIndex];
            const canvasG = canvasData[canvasIndex + 1];
            const canvasB = canvasData[canvasIndex + 2];
            canvasColorInfo = `RGBA(${canvasR},${canvasG},${canvasB},${canvasAlpha})`;
            
            if (canvasR === templateR && canvasG === templateG && canvasB === templateB) {
              // Pixel is correctly painted
              isCorrectlyPainted = true;
              colorStats[colorKey].painted++;
              totalPainted++;
              
              if (totalAnalyzed <= 10) { // Log first 10 pixels for debugging
                debugLog(`[Enhanced Logic] Pixel (${centerX},${centerY}) CORRECTLY PAINTED: template=${colorKey}, canvas=${canvasColorInfo} → NO CROSSHAIR`);
              }
            } else {
              if (totalAnalyzed <= 10) {
                debugLog(`❌ [Enhanced Logic] Pixel (${centerX},${centerY}) WRONG COLOR: template=${colorKey}, canvas=${canvasColorInfo} → NEEDS CROSSHAIR`);
              }
            }
          } else {
            canvasColorInfo = 'transparent/unpainted';
            if (totalAnalyzed <= 10) {
              debugLog(`⚪ [Enhanced Logic] Pixel (${centerX},${centerY}) UNPAINTED: template=${colorKey}, canvas=${canvasColorInfo} → NEEDS CROSSHAIR`);
            }
          }
        } else {
          canvasColorInfo = 'outside canvas bounds';
          if (totalAnalyzed <= 10) {
            debugLog(`🚫 [Enhanced Logic] Pixel (${centerX},${centerY}) OUTSIDE BOUNDS: template=${colorKey} → NEEDS CROSSHAIR`);
          }
        }
        
        // KEY INSIGHT: Crosshair only appears where pixel is NOT correctly painted
        // This is the enhanced mode logic we need to replicate
        if (!isCorrectlyPainted) {
          colorStats[colorKey].needsCrosshair++;
          totalNeedCrosshair++;
          
          if (totalAnalyzed <= 10) {
            debugLog(`[Enhanced Logic] CROSSHAIR DECISION: Pixel (${centerX},${centerY}) will get crosshair because it's not correctly painted`);
          }
        } else {
          if (totalAnalyzed <= 10) {
            debugLog(`🔒 [Enhanced Logic] CROSSHAIR DECISION: Pixel (${centerX},${centerY}) will NOT get crosshair because it's correctly painted`);
          }
        }
      }
    }
    
    debugLog(` [Tile Analysis] Results: ${totalAnalyzed} analyzed, ${totalPainted} painted, ${totalNeedCrosshair} need crosshair`);
    
    // Final summary of enhanced logic decisions
    debugLog(`[Enhanced Logic Summary] TILE ${tileKey}:`);
    debugLog(`   Enhanced pixels found: ${enhancedTemplatePixels.size}`);
    debugLog(`   Center pixels analyzed: ${totalAnalyzed}`);
    debugLog(`   Correctly painted (NO crosshair): ${totalPainted}`);
    debugLog(`   Need crosshair (unpainted/wrong): ${totalNeedCrosshair}`);
    debugLog(`   Success rate: ${totalAnalyzed > 0 ? Math.round((totalPainted / totalAnalyzed) * 100) : 0}%`);
    
    // Color breakdown
    debugLog(`[Enhanced Logic Summary] By color:`);
    for (const [colorKey, stats] of Object.entries(colorStats)) {
      const successRate = stats.totalRequired > 0 ? Math.round((stats.painted / stats.totalRequired) * 100) : 0;
      debugLog(`   ${colorKey}: ${stats.painted}/${stats.totalRequired} painted (${successRate}%), ${stats.needsCrosshair} need crosshair`);
    }
    
    return {
      colorStats,
      totalAnalyzed,
      totalPainted,
      totalNeedCrosshair
    };
  }

  /** Builds color palette from template tiles (Storage fork style)
   * @param {Template} template - Template object  
   * @returns {Object} Color palette with count for each color
   * @since 1.0.0
   */
  buildColorPaletteFromTileProgress(template) {
    const colorPalette = {};
    
    try {
      // Analyze each tile bitmap to count colors (like Storage fork)
      for (const [tileKey, tileBitmap] of Object.entries(template.chunked || {})) {
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = tileBitmap.width;
        tempCanvas.height = tileBitmap.height;
        const tempCtx = tempCanvas.getContext('2d', { willReadFrequently: true });
        tempCtx.imageSmoothingEnabled = false;
        tempCtx.drawImage(tileBitmap, 0, 0);
        const imageData = tempCtx.getImageData(0, 0, tileBitmap.width, tileBitmap.height);
        const data = imageData.data;
        
        // Count center pixels only (like Storage fork)
        for (let y = 0; y < tileBitmap.height; y++) {
          for (let x = 0; x < tileBitmap.width; x++) {
            // Only count center pixels of 3x3 blocks
            if ((x % this.drawMult) !== 1 || (y % this.drawMult) !== 1) { continue; }
            
            const idx = (y * tileBitmap.width + x) * 4;
            const r = data[idx];
            const g = data[idx + 1];
            const b = data[idx + 2];
            const a = data[idx + 3];
            
            // Ignore transparent and semi-transparent
            if (a < 64) { continue; }
            // Ignore #deface explicitly
            if (r === 222 && g === 250 && b === 206) { continue; }
            
            const colorKey = `${r},${g},${b}`;
            if (!colorPalette[colorKey]) {
              colorPalette[colorKey] = { count: 0, enabled: true };
            }
            colorPalette[colorKey].count++;
          }
        }
      }
      
      // debugLog(`🔧 [Build Palette] Found ${Object.keys(colorPalette).length} colors in tiles`);
      for (const [colorKey, info] of Object.entries(colorPalette)) {
        debugLog(`   ${colorKey}: ${info.count} pixels`);
      }
      
    } catch (error) {
      console.warn('🚨 [Build Palette] Failed to build color palette:', error);
    }
    
    return colorPalette;
  }

  /** Returns fallback simulated stats when canvas analysis fails
   * @param {Template} template - Template object
   * @returns {Object} Simulated color statistics
   * @since 1.0.0
   */
  getFallbackSimulatedStats(template) {
    debugLog('[Enhanced Pixel Analysis] Using fallback simulation');
    
    const colorStats = {};
    
    // Use template color palette if available
    for (const [colorKey, colorData] of Object.entries(template.colorPalette || {})) {
      const required = colorData.count || 0;
      
      // Create consistent pseudo-random values based on color
      const colorHash = colorKey.split(',').reduce((acc, val) => acc + parseInt(val), 0);
      const consistentRandom = (colorHash % 100) / 100;
      const completionRate = consistentRandom * 0.9; // 0-90% completion
      
      const painted = Math.floor(required * completionRate);
      const needsCrosshair = required - painted;
      
      colorStats[colorKey] = {
        totalRequired: required,
        painted: painted,
        needsCrosshair: needsCrosshair,
        percentage: required > 0 ? Math.round((painted / required) * 100) : 0
      };
    }
    
    return colorStats;
  }

     /** Gets the saved crosshair color from storage
    * @returns {Object} The crosshair color configuration
    * @since 1.0.0 
    */
   getCrosshairColor() {
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

   /** Gets the saved crosshair radius from storage
    * @returns {number} The crosshair radius value (12-32)
    * @since 1.0.0 
    */
   getCrosshairRadius() {
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
       console.warn('Failed to load crosshair radius:', error);
     }
     
     return 16; // Default radius (between min 12 and max 32)
   }



  /** Gets the border enabled setting from storage
   * @returns {boolean} Whether borders are enabled
   * @since 1.0.0 
   */
  getBorderEnabled() {
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
        debugLog('Border setting loaded:', borderEnabled);
        return borderEnabled;
      }
    } catch (error) {
      console.warn('Failed to load border setting:', error);
    }
    
    // Default to disabled
    debugLog('Using default border setting: false');
    return false;
  }

  /** Gets the enhanced size enabled setting from storage
   * Mirrors the setting used in the settings overlay (5x crosshair)
   * @returns {boolean}
   */
  getEnhancedSizeEnabled() {
    try {
      let enhancedSizeEnabled = null;
      if (typeof GM_getValue !== 'undefined') {
        const saved = GM_getValue('bmCrosshairEnhancedSize', null);
        if (saved !== null) enhancedSizeEnabled = JSON.parse(saved);
      }
      if (enhancedSizeEnabled === null) {
        const saved = localStorage.getItem('bmCrosshairEnhancedSize');
        if (saved !== null) enhancedSizeEnabled = JSON.parse(saved);
      }
      if (enhancedSizeEnabled !== null) return enhancedSizeEnabled;
    } catch (error) {
      console.warn('Failed to load enhanced size setting:', error);
    }
    return false;
  }

  /** Sets whether wrong colors should be included in progress calculation
   * @param {boolean} include - Whether to include wrong colors
   * @since 1.0.0
   */
  async setIncludeWrongColorsInProgress(include) {
    this.includeWrongColorsInProgress = include;
    debugLog(`Include wrong colors in progress: ${include}`);
    
    // Always save to storage directly - simpler and more reliable
    this.saveWrongColorSettings();
  }

  /** Gets whether wrong colors should be included in progress calculation
   * @returns {boolean} Whether wrong colors are included
   * @since 1.0.0
   */
  getIncludeWrongColorsInProgress() {
    return this.includeWrongColorsInProgress;
  }

  /** Sets whether wrong colors should be enhanced with crosshair
   * @param {boolean} enhance - Whether to enhance wrong colors
   * @since 1.0.0
   */
  async setEnhanceWrongColors(enhance) {
    this.enhanceWrongColors = enhance;
    debugLog(`Enhance wrong colors: ${enhance}`);
    
    // Always save to storage directly - simpler and more reliable
    this.saveWrongColorSettings();
    
    // Clear debug logs when toggling
    this._loggedWrongColors = new Set();
    this._loggedEnhancedPixels = new Set();
    this._wrongPixelsToEnhance = null;
    this._loggedWrongEnhanced = false;
    
    // Force template redraw to apply enhanced mode changes
    if (this.templatesArray && this.templatesArray.length > 0) {
      debugLog(`Forcing template redraw to apply enhanced mode changes`);
      this.setTemplatesShouldBeDrawn(false);
      setTimeout(() => {
        this.setTemplatesShouldBeDrawn(true);
      }, 50);
    }
  }

  /** Gets whether wrong colors should be enhanced with crosshair
   * @returns {boolean} Whether wrong colors are enhanced
   * @since 1.0.0
   */
  getEnhanceWrongColors() {
    return this.enhanceWrongColors;
  }

  /** Sets the error map mode state
   * @param {boolean} enabled - Whether error map mode should be enabled
   */
  setErrorMapMode(enabled) {
    this.errorMapEnabled = !!enabled;
  }

  /** Gets whether error map mode is enabled
   * @returns {boolean} True if error map mode is enabled
   */
  getErrorMapMode() {
    return this.errorMapEnabled;
  }

  /** Loads wrong color settings from storage
   * @since 1.0.0
   */
  loadWrongColorSettings() {
    try {
      // Try TamperMonkey storage first
      if (typeof GM_getValue !== 'undefined') {
        const includeWrongRaw = GM_getValue('bmIncludeWrongColors', null);
        const enhanceWrongRaw = GM_getValue('bmEnhanceWrongColors', null);
        
        // Check if TamperMonkey has valid values (not null and not 'null' string)
        const hasValidInclude = includeWrongRaw !== null && includeWrongRaw !== 'null';
        const hasValidEnhance = enhanceWrongRaw !== null && enhanceWrongRaw !== 'null';
        
        if (hasValidInclude) {
          this.includeWrongColorsInProgress = JSON.parse(includeWrongRaw);
        }
        if (hasValidEnhance) {
          this.enhanceWrongColors = JSON.parse(enhanceWrongRaw);
        }
        
        // Only return if BOTH values were found in TamperMonkey
        if (hasValidInclude && hasValidEnhance) {
          return;
        }
      }
      
      // Fallback to localStorage
      const includeWrongRaw = localStorage.getItem('bmIncludeWrongColors');
      const enhanceWrongRaw = localStorage.getItem('bmEnhanceWrongColors');
      
      if (includeWrongRaw !== null) {
        this.includeWrongColorsInProgress = JSON.parse(includeWrongRaw);
      }
      if (enhanceWrongRaw !== null) {
        this.enhanceWrongColors = JSON.parse(enhanceWrongRaw);
      }
    } catch (error) {
      console.error('❌ [Wrong Colors] Error loading settings:', error);
      // If there's an error parsing, reset to defaults
      this.includeWrongColorsInProgress = false;
      this.enhanceWrongColors = false;
    }
  }

  /** Saves wrong color settings to storage
   * @since 1.0.0
   */
  saveWrongColorSettings() {
    try {
      // Try TamperMonkey storage first
      if (typeof GM_setValue !== 'undefined') {
        GM_setValue('bmIncludeWrongColors', JSON.stringify(this.includeWrongColorsInProgress));
        GM_setValue('bmEnhanceWrongColors', JSON.stringify(this.enhanceWrongColors));
        return;
      }
      
      // Fallback to localStorage
      localStorage.setItem('bmIncludeWrongColors', JSON.stringify(this.includeWrongColorsInProgress));
      localStorage.setItem('bmEnhanceWrongColors', JSON.stringify(this.enhanceWrongColors));
    } catch (error) {
      console.error('❌ [Wrong Colors] Failed to save settings:', error);
    }
  }

  /** Checks if a color has wrong pixels in a specific tile
   * @param {string} colorKey - Color key in format "r,g,b"
   * @param {string} tileKey - Tile key in format "x,y"
   * @returns {boolean} Whether the color has wrong pixels in this tile
   * @since 1.0.0
   */
  isColorWrongInTile(colorKey, tileKey) {
    const tileProgress = this.tileProgress.get(tileKey);
    if (!tileProgress || !tileProgress.colorBreakdown) {
      return false;
    }
    
    const colorData = tileProgress.colorBreakdown[colorKey];
    const hasWrongPixels = colorData && colorData.wrong > 0;
    
    // Only log once per color per tile to avoid spam
    if (this.enhanceWrongColors && hasWrongPixels && !this._loggedWrongColors) {
      this._loggedWrongColors = this._loggedWrongColors || new Set();
      const logKey = `${colorKey}-${tileKey}`;
      if (!this._loggedWrongColors.has(logKey)) {
        debugLog(`Wrong Color Detection - Color ${colorKey} has ${colorData.wrong} wrong pixels in tile ${tileKey}`);
        this._loggedWrongColors.add(logKey);
      }
    }
    
    return hasWrongPixels;
  }

     /** Gets wrong pixels for selected colors in a specific tile
    * @param {string} tileCoords - Tile coordinates "x,y"
    * @param {Template} template - Template object
    * @returns {Set<string>} Set of pixel coordinates that are wrong for selected colors
    * @since 1.0.0
    */
   getWrongPixelsForSelectedColors(tileCoords, template) {
     const wrongPixels = new Set();
     
     try {
       const tileProgress = this.tileProgress.get(tileCoords);
       if (!tileProgress || !tileProgress.colorBreakdown) {
         return wrongPixels;
       }
       
       // Get selected colors (enhanced colors)
       const selectedColors = Array.from(template.enhancedColors);
       
       if (selectedColors.length === 0) {
        //  console.log(`🎯 [Wrong Color Enhancement] No colors selected for enhancement`);
         return wrongPixels;
       }
       
       debugLog(`Wrong Color Enhancement - Checking wrong pixels for selected colors: ${selectedColors.join(', ')}`);
       
       // For each selected color, find wrong pixels
       for (const colorKey of selectedColors) {
         const colorData = tileProgress.colorBreakdown[colorKey];
         if (colorData && colorData.wrong > 0) {
           debugLog(`Wrong Color Enhancement - Color ${colorKey} has ${colorData.wrong} wrong pixels`);
           
           // Find the actual wrong pixel coordinates for this color
           const wrongCoords = this.findWrongPixelCoordinates(tileCoords, colorKey, template);
           wrongCoords.forEach(coord => wrongPixels.add(coord));
         }
       }
       
       debugLog(`Wrong Color Enhancement - Total wrong pixels to enhance: ${wrongPixels.size}`);
       
     } catch (error) {
       console.warn('Failed to get wrong pixels for selected colors:', error);
     }
     
     return wrongPixels;
   }
   
   /** Finds wrong pixel coordinates for a specific color in a tile
    * @param {string} tileCoords - Tile coordinates "x,y"
    * @param {string} colorKey - Color key "r,g,b"
    * @param {Template} template - Template object
    * @returns {Set<string>} Set of pixel coordinates that are wrong for this color
    * @since 1.0.0
    */
   findWrongPixelCoordinates(tileCoords, colorKey, template) {
     const wrongCoords = new Set();
     
     try {
       // Parse color
       const [targetR, targetG, targetB] = colorKey.split(',').map(Number);
       
       // Find template tiles for this tile coordinate
       const matchingTiles = Object.keys(template.chunked).filter(tile =>
         tile.startsWith(tileCoords)
       );
       
       for (const tileKey of matchingTiles) {
         const tileBitmap = template.chunked[tileKey];
         const coords = tileKey.split(',');
         const pixelCoords = [coords[2], coords[3]];
         
         // Get template bitmap data
         const tempCanvas = document.createElement('canvas');
         tempCanvas.width = tileBitmap.width;
         tempCanvas.height = tileBitmap.height;
         const tempCtx = tempCanvas.getContext('2d');
         tempCtx.imageSmoothingEnabled = false;
         tempCtx.drawImage(tileBitmap, 0, 0);
         const templateImageData = tempCtx.getImageData(0, 0, tileBitmap.width, tileBitmap.height);
         const templateData = templateImageData.data;
         
         // Check each pixel for this color
         for (let y = 0; y < tileBitmap.height; y++) {
           for (let x = 0; x < tileBitmap.width; x++) {
             // Only check center pixels of 3x3 blocks
             if (x % this.drawMult !== 1 || y % this.drawMult !== 1) {
               continue;
             }
             
             const i = (y * tileBitmap.width + x) * 4;
             const r = templateData[i];
             const g = templateData[i + 1];
             const b = templateData[i + 2];
             const a = templateData[i + 3];
             
             // Skip transparent pixels
             if (a < 64) continue;
             
             // Check if this is the color we're looking for
             if (r === targetR && g === targetG && b === targetB) {
               // Calculate global coordinates
               const globalX = Number(pixelCoords[0]) * this.drawMult + x;
               const globalY = Number(pixelCoords[1]) * this.drawMult + y;
               
               // Add to wrong pixels set (we'll verify against canvas later)
               wrongCoords.add(`${globalX},${globalY}`);
             }
           }
         }
       }
       
     } catch (error) {
       console.warn('Failed to find wrong pixel coordinates:', error);
     }
     
     return wrongCoords;
   }
   
   /** Applies crosshair to wrong pixels
    * @param {Uint8ClampedArray} data - Image data to modify
    * @param {Uint8ClampedArray} originalData - Original template data
    * @param {Set<string>} wrongPixels - Set of wrong pixel coordinates
    * @param {number} width - Image width
    * @param {number} height - Image height
    * @param {Object} template - Template object
    * @param {CanvasRenderingContext2D} context - Canvas context
    * @param {Uint8ClampedArray} canvasData - Current canvas data
    * @since 1.0.0
    */
   applyCrosshairToWrongPixels(data, originalData, wrongPixels, width, height, template, context, canvasData) {
     let crosshairCount = 0;
     const crosshairColor = this.getCrosshairColor();
     
     debugLog(`Wrong Color Enhancement - Applying crosshair to ${wrongPixels.size} wrong pixels`);
     
     for (const pixelCoord of wrongPixels) {
       const [px, py] = pixelCoord.split(',').map(Number);
       
       // Convert global coordinates to local template coordinates
       const templateOffsetX = Number(template.pixelCoords[0]) * this.drawMult;
       const templateOffsetY = Number(template.pixelCoords[1]) * this.drawMult;
       const localX = px - templateOffsetX;
       const localY = py - templateOffsetY;
       
       // Check bounds
       if (localX < 0 || localX >= width || localY < 0 || localY >= height) {
         continue;
       }
       
       // Apply crosshair around the wrong pixel
       const crosshairOffsets = [
         [0, -1], [0, 1], [-1, 0], [1, 0] // Orthogonal only
       ];
       
       for (const [dx, dy] of crosshairOffsets) {
         const x = localX + dx;
         const y = localY + dy;
         
         // Quick bounds check
         if (x < 0 || x >= width || y < 0 || y >= height) continue;
         
         const i = (y * width + x) * 4;
         
         // Only modify transparent template pixels
         if (originalData[i + 3] !== 0) continue;
         
         // Check if pixel is already painted on canvas
         const canvasX = x + templateOffsetX;
         const canvasY = y + templateOffsetY;
         if (canvasX >= 0 && canvasX < context.canvas.width && canvasY >= 0 && canvasY < context.canvas.height) {
           const canvasIndex = (canvasY * context.canvas.width + canvasX) * 4;
           if (canvasData[canvasIndex + 3] > 0) continue; // Skip if already painted
         }
         
         // Apply crosshair
         data[i] = crosshairColor.rgb[0];
         data[i + 1] = crosshairColor.rgb[1];
         data[i + 2] = crosshairColor.rgb[2];
         data[i + 3] = crosshairColor.alpha;
         crosshairCount++;
       }
     }
     
     debugLog(`Wrong Color Enhancement - Applied ${crosshairCount} crosshair pixels`);
   }
   
   /** Detects wrong pixels by comparing template with current canvas state
    * @param {string} colorKey - Color key in format "r,g,b"
    * @param {string} tileKey - Tile key in format "x,y"
    * @param {HTMLCanvasElement} canvas - Current canvas element
    * @param {ImageBitmap} templateBitmap - Template bitmap for this tile
    * @param {Array<number>} templateOffset - Template offset [x, y]
    * @returns {Set<string>} Set of pixel coordinates that are wrong
    * @since 1.0.0
    */
   detectWrongPixelsInTile(colorKey, tileKey, canvas, templateBitmap, templateOffset) {
    const wrongPixels = new Set();
    
    try {
      // Parse color key
      const [targetR, targetG, targetB] = colorKey.split(',').map(Number);
      
      // Get template bitmap data
      const tempCanvas = document.createElement('canvas');
      tempCanvas.width = templateBitmap.width;
      tempCanvas.height = templateBitmap.height;
      const tempCtx = tempCanvas.getContext('2d');
      tempCtx.imageSmoothingEnabled = false;
      tempCtx.drawImage(templateBitmap, 0, 0);
      const templateImageData = tempCtx.getImageData(0, 0, templateBitmap.width, templateBitmap.height);
      const templateData = templateImageData.data;
      
      // Get canvas data for comparison
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      const canvasImageData = ctx.getImageData(templateOffset[0], templateOffset[1], templateBitmap.width, templateBitmap.height);
      const canvasData = canvasImageData.data;
      
      let wrongPixelCount = 0;
      
      // Compare each pixel
      for (let y = 0; y < templateBitmap.height; y++) {
        for (let x = 0; x < templateBitmap.width; x++) {
          // Only check center pixels of 3x3 blocks
          if (x % this.drawMult !== 1 || y % this.drawMult !== 1) {
            continue;
          }
          
          const i = (y * templateBitmap.width + x) * 4;
          
          // Get template color
          const templateR = templateData[i];
          const templateG = templateData[i + 1];
          const templateB = templateData[i + 2];
          const templateA = templateData[i + 3];
          
          // Skip transparent template pixels
          if (templateA < 64) continue;
          
          // Check if this is the color we're looking for
          if (templateR === targetR && templateG === targetG && templateB === targetB) {
            // Get canvas color at same position
            const canvasR = canvasData[i];
            const canvasG = canvasData[i + 1];
            const canvasB = canvasData[i + 2];
            const canvasA = canvasData[i + 3];
            
            // Check if pixel is wrong (different color or unpainted)
            if (canvasA < 64 || canvasR !== targetR || canvasG !== targetG || canvasB !== targetB) {
              wrongPixels.add(`${x},${y}`);
              wrongPixelCount++;
              
              // Debug log first few wrong pixels
              if (wrongPixelCount <= 5) {
                debugLog(`Wrong Pixel Detection - Pixel (${x},${y}) - Template: ${targetR},${targetG},${targetB} vs Canvas: ${canvasR},${canvasG},${canvasB} (alpha: ${canvasA})`);
              }
            }
          }
        }
      }
      
      if (wrongPixelCount > 0) {
        debugLog(`Wrong Pixel Detection - Found ${wrongPixelCount} wrong pixels for color ${colorKey} in tile ${tileKey}`);
      }
      
    } catch (error) {
      console.warn('Failed to detect wrong pixels:', error);
    }
    
    return wrongPixels;
  }

  /** Build a screenshot covering the active template's pixel area by fetching raw tiles and composing them.
   * The screenshot shows the current board (not overlay) for the area from the template's top-left pixel
   * to its bottom-right pixel, snapped to tile boundaries as needed.
   * @param {string} tileServerBase - Base URL to the tile server (ending with /tiles)
   * @param {[number, number, number, number]} templateCoords - [tileX, tileY, pixelX, pixelY]
   * @param {[number, number]} sizePx - [width, height] in template pixels to capture
   * @returns {Promise<Blob>} PNG blob of the composed screenshot
   */
  async buildTemplateAreaScreenshot(tileServerBase, templateCoords, sizePx) {
    try {
      // SMART DETECTION: Use currently displayed template or first enabled template
      let active = null;
      
      if (this.smartDetectionEnabled && this.currentlyDisplayedTemplates.size === 1) {
        // Use the currently displayed template for screenshot
        const displayedTemplateKey = Array.from(this.currentlyDisplayedTemplates)[0];
        active = this.templatesArray.find(t => `${t.sortID} ${t.authorID}` === displayedTemplateKey);
        if (active) {
          debugLog(`📸 [Smart Screenshot] Using actively displayed template: ${active.displayName}`);
        }
      }
      
      // Fallback: Use first enabled template
      if (!active && this.templatesArray) {
        for (const template of this.templatesArray) {
          const templateKey = `${template.sortID} ${template.authorID}`;
          if (this.isTemplateEnabled(templateKey)) {
            active = template;
            debugLog(`📸 [Smart Screenshot] Using first enabled template: ${active.displayName}`);
            break;
          }
        }
      }
      
      // Final fallback: Use first template (backward compatibility)
      if (!active) {
        active = this.templatesArray?.[0];
        if (active) {
          debugLog(`📸 [Smart Screenshot] Using fallback template: ${active.displayName}`);
        }
      }
      
      if (!active || !Array.isArray(templateCoords) || templateCoords.length < 4) {
        throw new Error('Missing template or coordinates');
      }
      const tx = Number(templateCoords[0]);
      const ty = Number(templateCoords[1]);
      const px = Number(templateCoords[2]);
      const py = Number(templateCoords[3]);
      const width = Number(sizePx?.[0] ?? active.imageWidth ?? 0);
      const height = Number(sizePx?.[1] ?? active.imageHeight ?? 0);
      if (!Number.isFinite(tx) || !Number.isFinite(ty) || width <= 0 || height <= 0) {
        throw new Error('Invalid screenshot dimensions or coords');
      }

      // Compose in board pixel space (no drawMult scaling)
      const tileSize = this.tileSize || 1000;

      // Compute the bounding box in board pixel space
      const startX = tx * tileSize + px;
      const startY = ty * tileSize + py;
      const endX = startX + width;
      const endY = startY + height;

      // Determine all tile coordinates we need to fetch
      const tileStartX = Math.floor(startX / tileSize);
      const tileStartY = Math.floor(startY / tileSize);
      const tileEndX = Math.floor((endX - 1) / tileSize);
      const tileEndY = Math.floor((endY - 1) / tileSize);

      const canvasW = endX - startX;
      const canvasH = endY - startY;
      const canvas = new OffscreenCanvas(canvasW, canvasH);
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, canvasW, canvasH);

      // Helper to fetch a tile PNG via GM (caller runs in userscript env)
      const fetchTile = (x, y) => new Promise((resolve, reject) => {
        try {
          const url = `${tileServerBase}/${x}/${y}.png`;
          // Try GM first
          if (typeof GM_xmlhttpRequest === 'function') {
            GM_xmlhttpRequest({
              method: 'GET',
              url,
              responseType: 'blob',
              onload: (res) => {
                if (res.status >= 200 && res.status < 300 && res.response) {
                  resolve(res.response);
                } else {
                  // Fallback via Image if GM blocked
                  const img = new Image();
                  img.crossOrigin = 'anonymous';
                  img.onload = async () => {
                    try {
                      const c = new OffscreenCanvas(img.width, img.height);
                      const cx = c.getContext('2d');
                      cx.imageSmoothingEnabled = false;
                      cx.drawImage(img, 0, 0);
                      const b = await c.convertToBlob({ type: 'image/png' });
                      resolve(b);
                    } catch (e) { reject(e); }
                  };
                  img.onerror = () => reject(new Error('Tile fetch failed (img)'));
                  img.src = url;
                }
              },
              onerror: () => {
                const img = new Image();
                img.crossOrigin = 'anonymous';
                img.onload = async () => {
                  try {
                    const c = new OffscreenCanvas(img.width, img.height);
                    const cx = c.getContext('2d');
                    cx.imageSmoothingEnabled = false;
                    cx.drawImage(img, 0, 0);
                    const b = await c.convertToBlob({ type: 'image/png' });
                    resolve(b);
                  } catch (e) { reject(e); }
                };
                img.onerror = () => reject(new Error('Tile fetch failed (img)'));
                img.src = url;
              }
            });
          } else {
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = async () => {
              try {
                const c = new OffscreenCanvas(img.width, img.height);
                const cx = c.getContext('2d');
                cx.imageSmoothingEnabled = false;
                cx.drawImage(img, 0, 0);
                const b = await c.convertToBlob({ type: 'image/png' });
                resolve(b);
              } catch (e) { reject(e); }
            };
            img.onerror = () => reject(new Error('Tile fetch failed (img)'));
            img.src = url;
          }
        } catch (e) { reject(e); }
      });

      // Iterate required tiles and draw only overlapping regions
      for (let tyIdx = tileStartY; tyIdx <= tileEndY; tyIdx++) {
        for (let txIdx = tileStartX; txIdx <= tileEndX; txIdx++) {
          const tileBlob = await fetchTile(txIdx, tyIdx);
          const bitmap = await createImageBitmap(tileBlob);
          // Compute overlap with our screenshot area in board pixels
          const tileOriginX = txIdx * tileSize;
          const tileOriginY = tyIdx * tileSize;
          const srcX = Math.max(0, startX - tileOriginX);
          const srcY = Math.max(0, startY - tileOriginY);
          const dstX = Math.max(0, tileOriginX - startX);
          const dstY = Math.max(0, tileOriginY - startY);
          const drawW = Math.min(tileSize - srcX, canvasW - dstX);
          const drawH = Math.min(tileSize - srcY, canvasH - dstY);
          if (drawW > 0 && drawH > 0) {
            ctx.drawImage(
              bitmap,
              srcX, srcY, drawW, drawH,
              dstX, dstY, drawW, drawH
            );
          }
        }
      }

      return await canvas.convertToBlob({ type: 'image/png' });
    } catch (e) {
      console.warn('Failed to build template area screenshot', e);
      throw e;
    }
  }

  /** Merge-import a BlueMarble JSON object (keeps coords and base64; allocates non-conflicting keys)
   * @param {Object} json
   * @param {{merge?: boolean}} options
   */
  async importFromObject(json, { merge = true } = {}) {
    if (!json?.templates || typeof json.templates !== 'object') return;

    // console.log('🔍 [Import] Starting importFromObject...');
    debugLog('Import - Current templatesArray length:', this.templatesArray?.length || 0);
    // console.log('🔍 [Import] Current templatesJSON templates:', Object.keys(this.templatesJSON?.templates || {}));

    if (!this.templatesJSON) {
      this.templatesJSON = await this.createJSON();
    }

    const existingKeys = Object.keys(this.templatesJSON.templates || {});
    const usedSortIDs = new Set(existingKeys.map(k => parseInt(k.split(' ')[0], 10)).filter(n => Number.isFinite(n)));

    const nextSortID = () => {
      let id = usedSortIDs.size ? Math.max(...Array.from(usedSortIDs)) + 1 : 0;
      while (usedSortIDs.has(id)) id++;
      usedSortIDs.add(id);
      return id;
    };

    const incomingTemplates = json.templates;
    for (const [templateKey, templateValue] of Object.entries(incomingTemplates)) {
      let desiredSortID = parseInt((templateKey.split(' ')[0] || '0'), 10);
      if (!Number.isFinite(desiredSortID) || usedSortIDs.has(desiredSortID)) {
        desiredSortID = nextSortID();
      } else {
        usedSortIDs.add(desiredSortID);
      }

      const authorID = (templateKey.split(' ')[1]) || '';
      const newKey = `${desiredSortID} ${authorID || ''}`.trim();

      this.templatesJSON.templates[newKey] = {
        name: templateValue.name || `Template ${desiredSortID}`,
        coords: templateValue.coords,
        createdAt: templateValue.createdAt || new Date().toISOString(),
        pixelCount: templateValue.pixelCount || 0,
        enabled: templateValue.enabled !== false,
        disabledColors: templateValue.disabledColors || [],
        enhancedColors: templateValue.enhancedColors || [],
        includeWrongColorsInProgress: templateValue.includeWrongColorsInProgress ?? this.includeWrongColorsInProgress ?? false,
        enhanceWrongColors: templateValue.enhanceWrongColors ?? this.enhanceWrongColors ?? false,
        tiles: templateValue.tiles || {}
      };

      try {
        const displayName = this.templatesJSON.templates[newKey].name;
        const coords = this.templatesJSON.templates[newKey].coords?.split(', ').map(Number) || null;
        const tilesbase64 = this.templatesJSON.templates[newKey].tiles;
        const templateTiles = {};
        let totalPixelCount = 0;
        
        for (const [tile, b64] of Object.entries(tilesbase64)) {
          const templateUint8Array = base64ToUint8(b64);
          const templateBlob = new Blob([templateUint8Array], { type: "image/png" });
          const templateBitmap = await createImageBitmap(templateBlob);
          templateTiles[tile] = templateBitmap;

          try {
            const canvas = document.createElement('canvas');
            canvas.width = templateBitmap.width;
            canvas.height = templateBitmap.height;
            const ctx = canvas.getContext('2d');
            ctx.imageSmoothingEnabled = false;
            ctx.drawImage(templateBitmap, 0, 0);
            const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const data = imageData.data;

            for (let y = 0; y < canvas.height; y++) {
              for (let x = 0; x < canvas.width; x++) {
                if (x % this.drawMult !== 1 || y % this.drawMult !== 1) continue;
                const i = (y * canvas.width + x) * 4;
                if (data[i + 3] > 0) totalPixelCount++;
              }
            }
          } catch (err) {
            console.warn('Failed to count pixels for tile during import:', tile, err);
          }
        }

        const template = new Template({
          displayName,
          sortID: desiredSortID,
          authorID,
          coords
        });
        template.chunked = templateTiles;
        template.pixelCount = totalPixelCount;

        if (!this.templatesJSON.templates[newKey].pixelCount) {
          this.templatesJSON.templates[newKey].pixelCount = totalPixelCount;
        }

        if (Array.isArray(this.templatesJSON.templates[newKey].disabledColors)) {
          template.setDisabledColors(this.templatesJSON.templates[newKey].disabledColors);
        }
        if (Array.isArray(this.templatesJSON.templates[newKey].enhancedColors)) {
          template.setEnhancedColors(this.templatesJSON.templates[newKey].enhancedColors);
        }

        // FIXED: Check if template already exists in templatesArray using the newKey (which is unique)
        // instead of just sortID + authorID (which can collide for different templates)
        const existingIndex = this.templatesArray.findIndex(t => {
          const existingKey = `${t.sortID} ${t.authorID}`;
          return existingKey === newKey;
        });
        
        debugLog(`Import - Template "${displayName}" - sortID: ${template.sortID}, authorID: "${template.authorID}", newKey: "${newKey}"`);
        debugLog(`Import - Existing template check - found at index: ${existingIndex}`);
        
        if (existingIndex !== -1) {
          // Replace existing template with same exact key
          this.templatesArray[existingIndex] = template;
          debugLog(`Import - Replaced existing template at index ${existingIndex}: ${newKey}`);
        } else {
          // Add new template - each template gets its own array entry
          this.templatesArray.push(template);
          debugLog(`Import - Added new template: ${newKey}`);
        }
      } catch (e) {
        console.warn('Failed to create Template instance during import merge:', e);
      }
    }

    this.templatesJSON.lastModified = new Date().toISOString();
    this.templatesJSON.templateCount = Object.keys(this.templatesJSON.templates).length;
    this.templatesJSON.totalPixels = this.templatesArray.reduce((total, t) => total + (t.pixelCount || 0), 0);

    debugLog('Import - After import - templatesArray length:', this.templatesArray.length);
    debugLog('Import - After import - templatesJSON templates:', Object.keys(this.templatesJSON.templates));

    await this.#storeTemplates();
    try {
      const imported = Object.entries(json.templates || {});
      const importedCount = imported.length;
      // Compose a brief status summary for bm-v
      let summary = `Imported ${importedCount} template${importedCount!==1?'s':''}`;
      if (importedCount > 0) {
        const first = imported[0][1];
        const name = first?.name || 'Unnamed';
        const coords = first?.coords || 'N/A';
        const pixels = first?.pixelCount ?? 'N/A';
        summary += `\n• First: ${name}\n• Coords: ${coords}\n• Pixels: ${pixels}`;
        if (importedCount > 1) summary += `\n• Others: ${importedCount - 1} more`;
      }
      this.overlay?.handleDisplayStatus?.(summary);
    } catch (_) {
      this.overlay?.handleDisplayStatus?.('Templates imported!');
    }
  }

  /** Build a single-template export JSON object */
  exportTemplateJSON(templateKey) {
    if (!this.templatesJSON?.templates?.[templateKey]) return null;
    const wrapper = {
      whoami: 'BlueMarble',
      scriptVersion: this.version,
      schemaVersion: this.templatesVersion,
      createdAt: new Date().toISOString(),
      lastModified: new Date().toISOString(),
      templateCount: 1,
      totalPixels: this.templatesJSON.templates[templateKey]?.pixelCount || 0,
      templates: {
        [templateKey]: this.templatesJSON.templates[templateKey]
      }
    };
    return wrapper;
  }

  /** Download a single-template JSON file */
  downloadTemplateJSON(templateKey) {
    const obj = this.exportTemplateJSON(templateKey);
    if (!obj) return;
    const name = (obj.templates[templateKey]?.name || 'template').replace(/[\\/:*?"<>|]/g, '_');
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${name}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  /** Build an export JSON with all templates */
  exportAllTemplatesJSON() {
    if (!this.templatesJSON?.templates) return null;
    const wrapper = {
      whoami: 'BlueMarble',
      scriptVersion: this.version,
      schemaVersion: this.templatesVersion,
      createdAt: this.templatesJSON.createdAt || new Date().toISOString(),
      lastModified: new Date().toISOString(),
      templateCount: Object.keys(this.templatesJSON.templates).length,
      totalPixels: this.templatesArray.reduce((t, tt) => t + (tt.pixelCount || 0), 0),
      templates: this.templatesJSON.templates
    };
    return wrapper;
  }

  /** Download all templates as JSON file */
  downloadAllTemplatesJSON() {
    const obj = this.exportAllTemplatesJSON();
    if (!obj) return;
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `BlueMarble-templates.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }
}
