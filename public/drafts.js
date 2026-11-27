window.ReplicaDrafts = (() => {
  const database = new Promise((resolve, reject) => {
    const request = indexedDB.open('replica-recordings', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('takes');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  async function transact(mode, action) {
    const db = await database;
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('takes', mode);
      const request = action(transaction.objectStore('takes'));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  }
  return {
    get: key => transact('readonly', store => store.get(key)),
    put: (key, value) => transact('readwrite', store => store.put(value, key)),
    remove: key => transact('readwrite', store => store.delete(key)),
  };
})();
