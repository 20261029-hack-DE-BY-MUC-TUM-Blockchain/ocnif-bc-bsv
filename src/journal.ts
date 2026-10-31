import type { PaymentJournal, PaymentRecord } from './index.ts';

export class IndexedDBOperationJournal<RecordType> {
  private database: Promise<IDBDatabase>;
  constructor(name = 'ocnif-payments') {
    this.database = new Promise((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () => request.result.createObjectStore('payments');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error('payment_journal_unavailable'));
    });
  }
  private async write(key: string, record: RecordType, reserve: boolean) {
    const database = await this.database;
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction('payments', 'readwrite');
      const store = transaction.objectStore('payments');
      if (reserve) store.add(record, key);
      else store.put(record, key);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () =>
        reject(
          new Error(
            reserve && transaction.error?.name === 'ConstraintError'
              ? 'payment_already_attempted'
              : 'payment_journal_unavailable',
          ),
        );
      transaction.onabort = () => reject(new Error('payment_journal_write_aborted'));
    });
  }
  reserve(key: string, record: RecordType) {
    return this.write(key, record, true);
  }
  update(key: string, record: RecordType) {
    return this.write(key, record, false);
  }
  async get(key: string): Promise<RecordType | undefined> {
    const database = await this.database;
    return await new Promise((resolve, reject) => {
      const request = database.transaction('payments', 'readonly').objectStore('payments').get(key);
      request.onsuccess = () => resolve(request.result as RecordType | undefined);
      request.onerror = () => reject(new Error('payment_journal_unavailable'));
    });
  }
}

export class IndexedDBPaymentJournal
  extends IndexedDBOperationJournal<PaymentRecord>
  implements PaymentJournal {}
