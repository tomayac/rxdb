import assert from 'assert';
import AsyncTestUtil, { clone, wait } from 'async-test-util';

import { wrappedValidateAjvStorage } from '../../plugins/validate-ajv';
import * as schemas from '../helper/schemas';
import * as schemaObjects from '../helper/schema-objects';
import {
    createRxDatabase,
    randomCouchString,
    addRxPlugin,
    RxJsonSchema,
    ensureNotFalsy,
    RxCollection,
    CRDTDocumentField,
    fillWithDefaultSettings,
    defaultHashFunction,
    RxConflictHandlerOutput,
    RxDocumentData,
    rxStorageInstanceToReplicationHandler,
    RxReplicationWriteToMasterRow,
    defaultConflictHandler
} from '../../';



import {
    getCRDTSchemaPart,
    RxDDcrdtPlugin,
    getCRDTConflictHandler
} from '../../plugins/crdt';
addRxPlugin(RxDDcrdtPlugin);
import config from './config';
import { replicateRxCollection, RxReplicationState } from '../../plugins/replication';
import { ReplicationPullHandler, ReplicationPushHandler } from '../../src/types';

config.parallel('crdt.test.js', () => {
    type WithCRDTs<RxDocType> = RxDocType & {
        crdts?: CRDTDocumentField<RxDocType>
    };
    function enableCRDTinSchema<RxDocType>(schema: RxJsonSchema<RxDocType>): RxJsonSchema<WithCRDTs<RxDocType>> {
        const ret: RxJsonSchema<WithCRDTs<RxDocType>> = clone(schema);
        ret.crdt = {
            field: 'crdts',
            maxOperations: 100,
            maxTTL: 1000 * 60 * 60
        };
        ret.properties.crdts = getCRDTSchemaPart();
        return ret;
    }


    async function getCRDTCollection<RxDocType = schemas.HumanDocumentType>(
        schema: RxJsonSchema<RxDocType> = schemas.human as any
    ): Promise<RxCollection<WithCRDTs<RxDocType>>> {
        const useSchema = enableCRDTinSchema(schema);
        const db = await createRxDatabase({
            name: randomCouchString(10),
            /**
             * Use the validator in tests to ensure we do not write
             * broken data.
             */
            storage: wrappedValidateAjvStorage({
                storage: config.storage.getStorage(),
            }),
            multiInstance: false
        });
        await db.addCollections({
            docs: {
                schema: useSchema
            }
        });

        return db.docs;
    }

    describe('collection creation', () => {
        it('should throw if the wrong conflict handler is set', async () => {
            const useSchema = enableCRDTinSchema(schemas.human as any);
            const db = await createRxDatabase({
                name: randomCouchString(10),
                storage: config.storage.getStorage(),
                multiInstance: false
            });
            await AsyncTestUtil.assertThrows(
                () => db.addCollections({
                    docs: {
                        schema: useSchema,
                        conflictHandler: ((() => { }) as any)
                    }
                }),
                'RxError',
                'CRDT3'
            );
            db.destroy();
        });
        it('should automatically set the CRDT conflict handler', async () => {
            const collection = await getCRDTCollection();
            assert.ok(collection.conflictHandler !== defaultConflictHandler);
            collection.database.destroy();
        });
    });


    describe('.insert()', () => {
        it('should insert a document and initialize the crdt state', async () => {
            const collection = await getCRDTCollection();
            const writeData = schemaObjects.human();
            const doc = await collection.insert(writeData);
            assert.ok(doc);
            const docData = doc.toJSON(true);
            assert.ok(docData.crdts);
            const firstOp = docData.crdts.operations[0][0];
            assert.ok(firstOp);
            assert.strictEqual(firstOp.body[0].ifMatch?.$set?.passportId, writeData.passportId);

            collection.database.destroy();
        });
        it('should insert document via bulkInsert', async () => {
            const collection = await getCRDTCollection();
            const writeData = schemaObjects.human();
            await collection.bulkInsert([writeData]);
            const doc = await collection.findOne().exec(true);
            assert.ok(doc);
            const docData = doc.toJSON(true);
            assert.ok(docData.crdts);
            const firstOp = docData.crdts.operations[0][0];
            assert.ok(firstOp);
            assert.strictEqual(firstOp.body[0].ifMatch?.$set?.passportId, writeData.passportId);

            collection.database.destroy();
        });
    });
    describe('.remove()', () => {
        it('should delete the document via .remove', async () => {
            const collection = await getCRDTCollection();
            const doc = await collection.insert(schemaObjects.human('foobar', 1));
            await doc.remove();

            const docsAfter = await collection.find().exec();
            assert.deepStrictEqual(docsAfter.map(d => d.toJSON(true)), []);

            const secondOp = ensureNotFalsy(doc.toJSON()).crdts?.operations[1][0];
            assert.ok(secondOp);
            assert.strictEqual(secondOp.body[0].ifMatch?.$set?._deleted, true);

            collection.database.destroy();
        });
    });

    describe('.atomicPatch()', () => {
        it('should update the document', async () => {
            const collection = await getCRDTCollection();
            const doc = await collection.insert(schemaObjects.human('foobar', 1));
            await doc.atomicPatch({
                age: 10
            });
            assert.strictEqual(
                doc.age,
                10
            );

            const secondOp = ensureNotFalsy(doc.toJSON()).crdts?.operations[1][0];
            assert.ok(secondOp);
            assert.strictEqual(secondOp.body[0].ifMatch?.$set?.age, 10);

            collection.database.destroy();
        });
    });

    /**
     * For some method it is no longer allowed to
     * call them because it might break the document state
     * when the operations are not CRDTs.
     */
    describe('dissallowed methods', () => {
        it('should throw the correct errors', async () => {
            const collection = await getCRDTCollection();
            const doc = await collection.insert(schemaObjects.human('foobar', 1));

            await AsyncTestUtil.assertThrows(
                () => doc.atomicUpdate(d => d),
                'RxError',
                'CRDT2'
            );

            collection.database.destroy();
        });
    });

    describe('.updateCRDT()', () => {
        it('should update the document via CRDT', async () => {
            const collection = await getCRDTCollection();
            const doc = await collection.insert(schemaObjects.human('foobar', 1));
            await doc.updateCRDT({
                ifMatch: {
                    $inc: {
                        age: 1
                    }
                }
            });
            assert.strictEqual(
                doc.age,
                2
            );

            const secondOp = ensureNotFalsy(doc.toJSON()).crdts?.operations[1][0];
            assert.ok(secondOp);
            assert.strictEqual(secondOp.body[0].ifMatch?.$inc?.age, 1);

            collection.database.destroy();
        });
        it('should delete the document via CRDT', async () => {
            const collection = await getCRDTCollection();
            const doc = await collection.insert(schemaObjects.human('foobar', 1));
            await doc.updateCRDT({
                ifMatch: {
                    $set: {
                        _deleted: true
                    }
                }
            });

            const docsAfter = await collection.find().exec();
            assert.deepStrictEqual(docsAfter.map(d => d.toJSON(true)), []);

            const secondOp = ensureNotFalsy(doc.toJSON()).crdts?.operations[1][0];
            assert.ok(secondOp);
            assert.strictEqual(secondOp.body[0].ifMatch?.$set?._deleted, true);

            collection.database.destroy();
        });
    });

    describe('conflict handling', () => {
        const schema = enableCRDTinSchema(fillWithDefaultSettings(schemas.human));
        const conflictHandler = getCRDTConflictHandler<WithCRDTs<schemas.HumanDocumentType>>(
            defaultHashFunction,
            config.storage.getStorage().statics,
            schema
        );
        describe('.getCRDTConflictHandler()', () => {
            it('should merge 2 inserts correctly', async () => {
                const writeData = schemaObjects.human();
                async function getDoc() {
                    const c = await getCRDTCollection();
                    const doc = await c.insert(writeData);
                    return doc;
                }
                const doc1 = await getDoc();
                const doc2 = await getDoc();


                const mustBeEqual = await conflictHandler({
                    newDocumentState: doc1.toMutableJSON(true),
                    realMasterState: doc1.toMutableJSON(true)
                }, 'text-crdt');
                assert.strictEqual(mustBeEqual.isEqual, true);

                const resolved: RxConflictHandlerOutput<any> = await conflictHandler({
                    newDocumentState: doc1.toMutableJSON(true),
                    realMasterState: doc2.toMutableJSON(true)
                }, 'text-crdt');
                assert.strictEqual(resolved.isEqual, false);
                const crdtData: CRDTDocumentField<any> = (resolved as any).documentData.crdts;
                assert.strictEqual(crdtData.operations[0].length, 2);

                doc1.collection.database.destroy();
                doc2.collection.database.destroy();
            });
        });
        describe('conflicts during replication', () => {
            const REPLICATION_IDENTIFIER_TEST = 'replication-crdt-tests';
            type TestDocType = WithCRDTs<schemas.HumanDocumentType>;
            type CheckpointType = any;
            function getPullHandler(
                remoteCollection: RxCollection<TestDocType>
            ): ReplicationPullHandler<TestDocType, CheckpointType> {
                const helper = rxStorageInstanceToReplicationHandler(
                    remoteCollection.storageInstance,
                    remoteCollection.database.conflictHandler as any,
                    remoteCollection.database.hashFunction
                );
                const handler: ReplicationPullHandler<TestDocType, CheckpointType> = async (
                    latestPullCheckpoint: CheckpointType | null,
                    batchSize: number
                ) => {
                    const result = await helper.masterChangesSince(latestPullCheckpoint, batchSize);
                    return result;
                };
                return handler;
            }
            function getPushHandler(
                remoteCollection: RxCollection<TestDocType>
            ): ReplicationPushHandler<TestDocType> {
                const helper = rxStorageInstanceToReplicationHandler(
                    remoteCollection.storageInstance,
                    remoteCollection.conflictHandler,
                    remoteCollection.database.hashFunction
                );
                const handler: ReplicationPushHandler<TestDocType> = async (
                    rows: RxReplicationWriteToMasterRow<TestDocType>[]
                ) => {
                    const result = await helper.masterWrite(rows);
                    return result;
                }
                return handler;
            }
            function ensureReplicationHasNoErrors(replicationState: RxReplicationState<any, any>) {
                replicationState.error$.subscribe(err => {
                    console.error('ensureReplicationHasNoErrors() has error:');
                    console.dir(err);
                    throw err;
                });
            }
            async function replicateOnce(
                clientCollection: RxCollection<TestDocType>,
                serverCollection: RxCollection<TestDocType>
            ) {
                const pullHandler = getPullHandler(serverCollection);
                const pushHandler = getPushHandler(serverCollection);
                const replicationState = replicateRxCollection({
                    collection: clientCollection,
                    replicationIdentifier: REPLICATION_IDENTIFIER_TEST,
                    live: false,
                    pull: {
                        batchSize: 10,
                        async handler(lastPulledCheckpoint, batchSize) {
                            console.log('pull send:');
                            console.dir(lastPulledCheckpoint);
                            const ret = await pullHandler(lastPulledCheckpoint, batchSize);
                            console.log('pull ret:');
                            console.dir(ret);
                            return ret;
                        }
                    },
                    push: {
                        batchSize: 10,
                        async handler(docs) {
                            console.log('push send:');
                            console.dir(docs);
                            const ret = await pushHandler(docs);
                            console.log('push ret:');
                            console.dir(ret);


                            return ret;
                        }
                    }
                });
                ensureReplicationHasNoErrors(replicationState);

                await replicationState.awaitInSync();

                const evAfter = await ensureNotFalsy(replicationState.internalReplicationState)
                    .input.metaInstance.getChangedDocumentsSince(1000).then();
                console.dir(await evAfter);


                await replicationState.cancel();
            }
            it('should merge the +1 increments', async () => {
                const clientACollection = await getCRDTCollection();
                const clientBCollection = await getCRDTCollection();
                const serverCollection = await getCRDTCollection();

                // first replicate the document once
                const writeData = schemaObjects.human('foobar', 0);
                await clientACollection.insert(writeData);
                await replicateOnce(clientACollection, serverCollection);


                console.log('first replication b to server');
                await replicateOnce(clientBCollection, serverCollection);

                const docA = await clientACollection.findOne().exec(true);
                const docB = await clientBCollection.findOne().exec(true);
                assert.ok(docB);


                // update on both sides while 'offline'
                await Promise.all(
                    [docA, docB].map(doc => doc.updateCRDT({
                        ifMatch: {
                            $inc: {
                                age: 1
                            }
                        }
                    }))
                );
                console.dir('FROM STORAGE 3:');
                console.dir(await clientACollection.storageInstance.findDocumentsById(['foobar'], true));


                assert.strictEqual(docA.age, 1);
                assert.strictEqual(docB.age, 1);

                await replicateOnce(clientACollection, serverCollection);

                
                console.dir('FROM STORAGE 5:');
                console.dir(await clientACollection.storageInstance.findDocumentsById(['foobar'], true));
                
                await replicateOnce(clientBCollection, serverCollection);
                console.dir('FROM STORAGE 6:');
                console.dir(await clientBCollection.storageInstance.findDocumentsById(['foobar'], true));
                await wait(2000);

                process.exit();


                await replicateOnce(clientACollection, serverCollection);


                console.dir('FROM STORAGE 4:');
                console.dir(await clientACollection.storageInstance.findDocumentsById(['foobar'], true));

                console.log('AAAAAAAAAAAAA');
                assert.strictEqual(docA.age, 2);
                console.log('BBBBBBBBBBBBb');
                assert.strictEqual(docB.age, 2);




                process.exit();
                clientACollection.destroy();
                clientBCollection.destroy();
                serverCollection.destroy();
            });
        });
    });
});
