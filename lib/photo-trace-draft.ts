const DATABASE_NAME = 'leather-label-designer';
const STORE_NAME = 'photo-trace-draft';
const DATABASE_VERSION = 2;

type StoredRecord = {
  key: 'draft';
  value: unknown;
};

export type StoredPhotoSource = {
  name: string;
  type: string;
  blob: Blob;
  fingerprint: string;
};

function openDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME, { keyPath: 'key' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('无法打开本机草稿。'));
  });
}

async function writeRecord(record: StoredRecord) {
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    transaction.objectStore(STORE_NAME).put(record);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('本机草稿保存失败。'));
  });
  database.close();
}

async function readRecord<T>(key: StoredRecord['key']) {
  const database = await openDatabase();
  const value = await new Promise<T | null>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, 'readonly');
    const request = transaction.objectStore(STORE_NAME).get(key);
    request.onsuccess = () => resolve((request.result?.value as T | undefined) ?? null);
    request.onerror = () => reject(request.error ?? new Error('本机草稿读取失败。'));
  });
  database.close();
  return value;
}

export function savePhotoTraceDraft<T>(
  source: StoredPhotoSource,
  settings: T,
) {
  return writeRecord({ key: 'draft', value: { source, settings } });
}

export function loadPhotoTraceDraft<T>() {
  return readRecord<{ source: StoredPhotoSource; settings: T }>('draft');
}

export async function clearPhotoTraceDraft() {
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    transaction.objectStore(STORE_NAME).clear();
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('本机草稿清除失败。'));
  });
  database.close();
}
