---
title: SharedWorker RxStorage 👑
slug: rx-storage-shared-worker.html
---

# SharedWorker RxStorage 

The SharedWorker [RxStorage](./rx-storage.md) uses the [SharedWorker API](https://developer.mozilla.org/en-US/docs/Web/API/SharedWorker) to run the storage inside of a separate JavaScript process **in browsers**. Compared to a normal [WebWorker](./rx-storage-worker.md), the SharedWorker is created exactly once, even when there are multiple browser tabs opened. Because of having exactly one worker, multiple performance optimizations can be done because the storage itself does not have to handle multiple opened database connections.

**NOTICE:** This plugin is part of [RxDB Premium 👑](/premium). It is not part of the default RxDB module.


## Usage

### On the SharedWorker process

In the worker process JavaScript file, you have wrap the original RxStorage with `getRxStorageIndexedDB()`.

```ts
// shared-worker.ts

import { exposeWorkerRxStorage } from 'rxdb-premium/plugins/storage-worker';
import { 
    getRxStorageIndexedDB
} from 'rxdb-premium/plugins/indexeddb';

exposeWorkerRxStorage({
    /**
     * You can wrap any implementation of the RxStorage interface
     * into a worker.
     * Here we use the IndexedDB RxStorage.
     */
    storage: getRxStorageIndexedDB()
});
```

### On the main process

```ts
import {
    createRxDatabase
} from 'rxdb';
import { getRxStorageSharedWorker } from 'rxdb-premium/plugins/storage-worker';
import { getRxStorageIndexedDB } from 'rxdb/plugins/storage-indexeddb';


const database = await createRxDatabase({
    name: 'mydatabase',
    storage: getRxStorageSharedWorker(
        {
            /**
             * Contains any value that can be used as parameter
             * to the SharedWorker constructor of thread.js
             * Most likely you want to put the path to the shared-worker.js file in here.
             * 
             * @link https://developer.mozilla.org/en-US/docs/Web/API/SharedWorker?retiredLocale=de
             */
            workerInput: 'path/to/shared-worker.js',
            /**
             * (Optional) options
             * for the worker.
             */
            workerOptions: {
                type: 'module',
                credentials: 'omit'
            }
        }
    )
});
```

## Pre-build workers

The `shared-worker.js` must be a self containing JavaScript file that contains all dependencies in a bundle.
To make it easier for you, RxDB ships with pre-bundles worker files that are ready to use.
You can find them in the folder `node_modules/rxdb-premium/dist/workers` after you have installed the [RxDB Premium 👑 Plugin](/premium). From there you can copy them to a location where it can be served from the webserver and then use their path to create the `RxDatabase`

Any valid `worker.js` JavaScript file can be used both, for normal Workers and SharedWorkers.


```ts
import {
    createRxDatabase
} from 'rxdb';
import { getRxStorageSharedWorker } from 'rxdb-premium/plugins/storage-worker';
const database = await createRxDatabase({
    name: 'mydatabase',
    storage: getRxStorageSharedWorker(
        {
            /**
             * Path to where the copied file from node_modules/rxdb-premium/dist/workers
             * is reachable from the webserver.
             */
            workerInput: '/indexeddb.shared-worker.js'
        }
    )
});
```

## Building a custom worker

To build a custom `worker.js` file, check out the webpack config at the [worker](./rx-storage-worker.md#building-a-custom-worker) documentation. Any worker file form the worker storage can also be used in a shared worker because `exposeWorkerRxStorage` detects where it runs and exposes the correct messaging endpoints.

## Passing in a SharedWorker instance

Instead of setting an url as `workerInput`, you can also specify a function that returns a new `SharedWorker` instance when called. This is mostly used when you have a custom worker file and dynamically import it.
This works equal to the [workerInput of the Worker Storage](./rx-storage-worker.md#passing-in-a-worker-instance)

## Replication with SharedWorker

When a SharedWorker RxStorage is used, it is recommended to run the replication **inside** of the worker. You can do that by opening another [RxDatabase](./rx-database.md) inside of it and starting the replication there.

```ts
// shared-worker.ts

import { exposeWorkerRxStorage } from 'rxdb-premium/plugins/storage-worker';
import { 
    getRxStorageIndexedDB
} from 'rxdb-premium/plugins/storage-indexeddb';
import {
    createRxDatabase,
    addRxPlugin
} from 'rxdb';
import {
    RxDBReplicationGraphQLPlugin
} from 'rxdb/plugins/replication-graphql';
addRxPlugin(RxDBReplicationGraphQLPlugin);

const baseStorage = getRxStorageIndexedDB();

// first expose the RxStorage to the outside
exposeWorkerRxStorage({
    storage: baseStorage
});

/**
 * Then create a normal RxDatabase and RxCollections
 * and start the replication.
 */
const database = await createRxDatabase({
    name: 'mydatabase',
    /**
     * Important: INSIDE of your SharedWorker, you can
     * be sure that there is exactly one instance running.
     * Therefore you MUST set multiInstance=false for better performance.
     */
    multiInstance: false,
    storage: baseStorage
});
await db.addCollections({
    humans: {/* ... */}
});
const replicationState = db.humans.syncGraphQL({/* ... */});
```
