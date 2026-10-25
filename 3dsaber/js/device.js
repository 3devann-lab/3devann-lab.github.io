// ============ What this device can afford ============
// Console browsers (Xbox's Edge) and low-memory devices give a tab far less
// memory than a PC: there, songs stream instead of being decoded into memory
// and the renderer keeps its buffers small (Memory Saver).
import { settings } from './settings.js';

const KEY = 'saber3d_lowmem';

export const isConsole = /Xbox|PlayStation|Nintendo/i.test(navigator.userAgent || '');

// Settings → Graphics → Memory Saver: Auto (below), On or Off
export function lowMemory() {
    const pick = settings.get('memorySaver');
    if (pick === 'on') return true;
    if (pick === 'off') return false;
    if (isConsole) return true;
    const dm = navigator.deviceMemory;
    if (dm && dm <= 2) return true;
    try { return localStorage.getItem(KEY) === '1'; } catch (e) { return false; }
}

// a song couldn't be decoded for lack of memory: behave as a low-memory device from now on
export function rememberLowMemory() {
    try { localStorage.setItem(KEY, '1'); } catch (e) { /* private mode */ }
}
