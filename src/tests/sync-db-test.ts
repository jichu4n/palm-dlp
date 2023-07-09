import debug from 'debug';
import {MemoDatabase, MemoRecord, RawPdbDatabase, RecordAttrs} from 'palm-pdb';
import {DlpConnection} from '../protocols/sync-connections';
import {writeDb, writeRawDb} from '../sync-utils/write-db';
import {syncDb} from '../sync-utils/sync-db';
import assert from 'assert';
import {readDb} from '../sync-utils/read-db';

const log = debug('palm-sync').extend('test');

interface SyncTestCase {
  device: [string, Partial<RecordAttrs>] | null;
  desktop: [string, Partial<RecordAttrs>] | null;
  result: Array<string>;
}

async function runSyncTestCase(
  dlpConnection: DlpConnection,
  testCase: SyncTestCase
) {
  const deviceDb = new MemoDatabase();
  const desktopDb = new MemoDatabase();

  if (testCase.device) {
    const deviceRecord = MemoRecord.with({value: testCase.device[0]});
    deviceRecord.entry.uniqueId = 1;
    Object.assign(deviceRecord.entry.attributes, testCase.device[1]);
    deviceDb.records.push(deviceRecord);
  }

  if (testCase.desktop) {
    const desktopRecord = MemoRecord.with({value: testCase.desktop[0]});
    desktopRecord.entry.uniqueId = 1;
    Object.assign(desktopRecord.entry.attributes, testCase.desktop[1]);
    desktopDb.records.push(desktopRecord);
  }

  await writeDb(dlpConnection, deviceDb, {overwrite: true});

  const rawDesktopDb = RawPdbDatabase.from(desktopDb.serialize());
  await syncDb(dlpConnection, rawDesktopDb);

  const syncedDeviceDb = await readDb(
    dlpConnection,
    MemoDatabase,
    deviceDb.header.name
  );
  const syncedDesktopDb = MemoDatabase.from(rawDesktopDb.serialize());

  assert.strictEqual(syncedDeviceDb.records.length, testCase.result.length);
  assert.strictEqual(syncedDesktopDb.records.length, testCase.result.length);

  testCase.result.sort();
  syncedDeviceDb.records.sort((a, b) =>
    a.value < b.value ? -1 : a.value === b.value ? 0 : 1
  );
  syncedDesktopDb.records.sort((a, b) =>
    a.value < b.value ? -1 : a.value === b.value ? 0 : 1
  );
  for (let i = 0; i < testCase.result.length; i++) {
    const deviceRecord = syncedDeviceDb.records[i];
    const desktopRecord = syncedDesktopDb.records[i];
    assert.strictEqual(deviceRecord.value, testCase.result[i]);
    assert.strictEqual(desktopRecord.value, testCase.result[i]);
    assert.strictEqual(
      deviceRecord.entry.uniqueId,
      desktopRecord.entry.uniqueId
    );
    assert(!deviceRecord.entry.attributes.dirty);
    assert(!deviceRecord.entry.attributes.delete);
    assert(!desktopRecord.entry.attributes.archive);
    assert(!desktopRecord.entry.attributes.dirty);
    assert(!desktopRecord.entry.attributes.delete);
    assert(!desktopRecord.entry.attributes.archive);
  }
}

const SYNC_TEST_CASES: Array<SyncTestCase> = [
  // Device record = NOT_FOUND
  {
    device: null,
    desktop: null,
    result: [],
  },
  {
    device: null,
    desktop: ['Archived & changed', {delete: true, archive: true, dirty: true}],
    result: [],
  },
  {
    device: null,
    desktop: ['Deleted', {delete: true}],
    result: [],
  },
  {
    device: null,
    desktop: ['Changed', {dirty: true}],
    result: ['Changed'],
  },

  // Device record = ARCHIVED_CHANGED
  //
  // TODO: This is failing because when reading back device records the delete
  // bit is not set, even though it is set when we originally wrote it.
  //
  // Further, when deleting & archiving on the device itself, the delete bit is
  // indeed not set when archive is set. So we have a problem :/
  {
    device: ['Archived & changed', {delete: true, archive: true, dirty: true}],
    desktop: null,
    result: [],
  },
  {
    device: ['Archived & changed', {delete: true, archive: true, dirty: true}],
    desktop: ['Archived & changed', {delete: true, archive: true, dirty: true}],
    result: [],
  },
  {
    device: ['Archived & changed', {delete: true, archive: true, dirty: true}],
    desktop: ['Archived & unchanged', {delete: true, archive: true}],
    result: [],
  },
  {
    device: ['Archived & changed', {delete: true, archive: true, dirty: true}],
    desktop: ['Deleted', {delete: true}],
    result: [],
  },
  {
    device: ['Archived & changed', {delete: true, archive: true, dirty: true}],
    desktop: ['Changed', {dirty: true}],
    result: ['Archived & changed', 'changed'],
  },

  {
    device: ['Original', {}],
    desktop: ['Original', {}],
    result: ['Original'],
  },
  {
    device: ['Changed', {dirty: true}],
    desktop: ['Original', {}],
    result: ['Changed'],
  },
  {
    device: ['Original', {}],
    desktop: ['Changed', {dirty: true}],
    result: ['Changed'],
  },
];

export async function run(dlpConnection: DlpConnection) {
  for (const testCase of SYNC_TEST_CASES) {
    const testCaseName =
      `${testCase.device ? testCase.device[0] : 'null'}` +
      ' <> ' +
      `${testCase.desktop ? testCase.desktop[0] : 'null'}`;
    log(`=== Running test case ${testCaseName}`);
    try {
      await runSyncTestCase(dlpConnection, testCase);
    } catch (e) {
      log(`=== Failed test case ${testCaseName}`);
      throw e;
    }
    log(`=== Completed test case ${testCaseName}`);
  }
}
