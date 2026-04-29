// SPDX-License-Identifier: GPL-3.0-or-later
// IndexedDB-backed key storage for uvpacket-web.
//
// Stores a single active key slot — a 32-byte secp256k1 secret. The
// secret stays on the device; only the public address travels over the
// air. The DB schema is intentionally minimal so existing slots can be
// re-read without a migration plan.

const DB_NAME = 'uvpacket-keystore';
const DB_VERSION = 1;
const STORE = 'keys';
const ACTIVE_ID = 'active';

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    const r = fn(store);
    t.oncomplete = () => resolve(r);
    t.onerror = () => reject(t.error);
  });
}

export async function loadActive() {
  return tx('readonly', (s) => {
    return new Promise((res) => {
      const r = s.get(ACTIVE_ID);
      r.onsuccess = () => res(r.result || null);
    });
  });
}

/**
 * @param {{ secret_hex: string, addr_m: string, addr_p: string,
 *           addr_mona1: string, mycall: string, active_addr_type: string }} slot
 */
export async function saveActive(slot) {
  await tx('readwrite', (s) => s.put({ id: ACTIVE_ID, ...slot }));
}

export async function clearActive() {
  await tx('readwrite', (s) => s.delete(ACTIVE_ID));
}
