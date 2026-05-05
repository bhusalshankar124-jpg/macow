/**
 * GUI Handler - Handles clicking items in Minecraft GUI windows.
 * Supports items with JSON chat component names (objects), NBT display names, and lore.
 */

const logger = require('../utils/logger');

/**
 * Strips Minecraft color/formatting codes from text.
 */
function stripColors(text) {
  if (!text) return '';
  return text
    .replace(/\u00A7[0-9a-fk-or]/gi, '')
    .replace(/\\u00a7[0-9a-fk-or]/gi, '')
    .trim();
}

/**
 * Recursively extracts plain text from a Minecraft JSON chat component.
 * Handles strings, objects with .text/.extra/.translate, and ChatMessage objects.
 */
function flattenChatComponent(obj) {
  if (!obj) return '';
  // If it has a .toString() that isn't the default Object one, use it (ChatMessage)
  if (typeof obj === 'string') {
    try {
      const parsed = JSON.parse(obj);
      return flattenChatComponent(parsed);
    } catch (_) {
      return stripColors(obj);
    }
  }
  if (typeof obj === 'number') return String(obj);
  // ChatMessage objects from prismarine-chat have .toString()
  if (typeof obj.toString === 'function' && obj.constructor && obj.constructor.name !== 'Object') {
    return stripColors(obj.toString());
  }
  let result = '';
  if (obj.text != null) result += String(obj.text);
  if (obj.translate) result += String(obj.translate);
  if (obj.extra && Array.isArray(obj.extra)) {
    for (const part of obj.extra) {
      result += flattenChatComponent(part);
    }
  }
  if (obj.with && Array.isArray(obj.with)) {
    for (const part of obj.with) {
      result += flattenChatComponent(part);
    }
  }
  return stripColors(result);
}

/**
 * Waits for a GUI window to open and clicks the item matching the target name.
 * @param {import('mineflayer').Bot} bot - The mineflayer bot instance
 * @param {string} targetItemName - The name of the item/button to click (e.g. "AFK 27")
 * @param {string} accountName - Account label for logging
 * @param {number} timeout - How long to wait for the window (ms)
 * @returns {Promise<boolean>} - Whether the click was successful
 */
async function clickGuiItem(bot, targetItemName, accountName, timeout = 15000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      logger.warn(`GUI window did not open within ${timeout / 1000}s`, accountName);
      bot.removeListener('windowOpen', onWindowOpen);
      resolve(false);
    }, timeout);

    async function onWindowOpen(window) {
      clearTimeout(timer);
      logger.info(`GUI window opened: "${window.title || 'Untitled'}" with ${window.slots.length} slots`, accountName);

      // Small delay to let slots populate
      await sleep(500);

      let targetSlot = null;

      for (let i = 0; i < window.slots.length; i++) {
        const slot = window.slots[i];
        if (!slot) continue;

        // Build a combined searchable string from all sources
        let allText = '';

        // 1. customName — may be string or ChatMessage object
        if (slot.customName) {
          allText += flattenChatComponent(slot.customName) + ' ';
        }
        // 2. displayName — may be string or object
        if (slot.displayName) {
          allText += flattenChatComponent(slot.displayName) + ' ';
        }
        // 3. Vanilla item name
        if (slot.name) {
          allText += stripColors(String(slot.name)) + ' ';
        }
        // 4. NBT display Name + Lore (legacy)
        allText += extractNbtText(slot) + ' ';
        // 5. Components (1.20.5+ format)
        allText += extractComponentText(slot) + ' ';

        allText = allText.toLowerCase();

        logger.debug(`  Slot ${i}: "${allText.trim()}" | id: ${slot.type}`, accountName);

        if (allText.includes(targetItemName.toLowerCase())) {
          targetSlot = i;
          logger.success(`Found "${targetItemName}" in slot ${i}`, accountName);
          break;
        }
      }

      if (targetSlot !== null) {
        try {
          await bot.clickWindow(targetSlot, 0, 0);
          logger.success(`Clicked "${targetItemName}" in slot ${targetSlot}`, accountName);
          resolve(true);
        } catch (err) {
          logger.error(`Failed to click slot ${targetSlot}: ${err.message}`, accountName);
          resolve(false);
        }
      } else {
        logger.warn(`Could not find "${targetItemName}" in GUI`, accountName);
        // Try to close the window
        try {
          bot.closeWindow(window);
        } catch (_) {}
        resolve(false);
      }
    }

    bot.once('windowOpen', onWindowOpen);
  });
}

/**
 * Recursively walks an NBT compound structure and extracts all "text" string values.
 * Handles the deeply nested {type:"string", value:"..."} format used in 1.20.5+ components.
 */
function extractDeepNbtStrings(obj) {
  if (!obj) return '';
  if (typeof obj === 'string') return obj;
  if (typeof obj === 'number') return '';

  let result = '';

  // Direct {type:"string", value:"..."} leaf
  if (obj.type === 'string' && obj.value != null) {
    return String(obj.value);
  }

  // Compound: {type:"compound", value:{...}}
  if (obj.type === 'compound' && obj.value && typeof obj.value === 'object') {
    if (Array.isArray(obj.value)) {
      for (const entry of obj.value) {
        result += extractDeepNbtStrings(entry) + ' ';
      }
    } else {
      for (const key of Object.keys(obj.value)) {
        result += extractDeepNbtStrings(obj.value[key]) + ' ';
      }
    }
    return result;
  }

  // List: {type:"list", value:{type:"compound", value:[...]}}
  if (obj.type === 'list' && obj.value) {
    return extractDeepNbtStrings(obj.value);
  }

  // Array
  if (Array.isArray(obj)) {
    for (const entry of obj) {
      result += extractDeepNbtStrings(entry) + ' ';
    }
    return result;
  }

  // Plain object (walk all keys)
  if (typeof obj === 'object') {
    for (const key of Object.keys(obj)) {
      result += extractDeepNbtStrings(obj[key]) + ' ';
    }
  }

  return result;
}

/**
 * Extracts text from the 1.20.5+ components array (custom_name, lore).
 */
function extractComponentText(item) {
  let result = '';
  try {
    if (!item.components || !Array.isArray(item.components)) return '';
    for (const comp of item.components) {
      if (comp.type === 'custom_name' || comp.type === 'lore') {
        result += extractDeepNbtStrings(comp.data) + ' ';
      }
    }
  } catch (_) {}
  return stripColors(result);
}

/**
 * Extracts all text from NBT display data (Name + Lore) — legacy format.
 */
function extractNbtText(item) {
  let result = '';
  try {
    if (item.nbt && item.nbt.value) {
      const display = item.nbt.value.display;
      if (display && display.value) {
        if (display.value.Name) {
          result += flattenChatComponent(display.value.Name.value) + ' ';
        }
        if (display.value.Lore && display.value.Lore.value) {
          const loreEntries = display.value.Lore.value.value || display.value.Lore.value;
          const loreArr = Array.isArray(loreEntries) ? loreEntries : [];
          for (let i = 0; i < loreArr.length; i++) {
            result += flattenChatComponent(loreArr[i]) + ' ';
          }
        }
      }
    }
  } catch (_) {}
  return stripColors(result);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Clicks an item in an ALREADY-OPEN window (no waiting for windowOpen).
 * @param {import('mineflayer').Bot} bot
 * @param {Object} window - The already-open window object
 * @param {string} targetItemName - Partial name to search for
 * @param {string} accountName - For logging
 * @returns {Promise<boolean>}
 */
async function clickGuiItemInWindow(bot, window, targetItemName, accountName) {
  logger.info(`Scanning open window: "${window.title || 'Untitled'}" with ${window.slots.length} slots`, accountName);

  // Small delay to let slots populate
  await sleep(500);

  let targetSlot = null;

  for (let i = 0; i < window.slots.length; i++) {
    const slot = window.slots[i];
    if (!slot) continue;

    let allText = '';
    if (slot.customName) allText += flattenChatComponent(slot.customName) + ' ';
    if (slot.displayName) allText += flattenChatComponent(slot.displayName) + ' ';
    if (slot.name) allText += stripColors(String(slot.name)) + ' ';
    allText += extractNbtText(slot) + ' ';
    allText += extractComponentText(slot) + ' ';
    allText = allText.toLowerCase();

    logger.debug(`  Slot ${i}: "${allText.trim()}" | id: ${slot.type}`, accountName);

    if (allText.includes(targetItemName.toLowerCase())) {
      targetSlot = i;
      logger.success(`Found "${targetItemName}" in slot ${i}`, accountName);
      break;
    }
  }

  if (targetSlot !== null) {
    try {
      await bot.clickWindow(targetSlot, 0, 0);
      logger.success(`Clicked "${targetItemName}" in slot ${targetSlot}`, accountName);
      return true;
    } catch (err) {
      logger.error(`Failed to click slot ${targetSlot}: ${err.message}`, accountName);
      return false;
    }
  } else {
    logger.warn(`Could not find "${targetItemName}" in GUI`, accountName);
    try { bot.closeWindow(window); } catch (_) {}
    return false;
  }
}

module.exports = { clickGuiItem, clickGuiItemInWindow, flattenChatComponent, extractComponentText };
