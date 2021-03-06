﻿/* Copyright (c) Microsoft Open Technologies, Inc.  All rights reserved.  Licensed under the Apache License, Version 2.0.  See License.txt in the project root for license information. */ 
/* Copyright (c) Microsoft Open Technologies, Inc.  All rights reserved.  Licensed under the Apache License, Version 2.0.  See License.txt in the project root for license information. */ var AngularCloudDataConnector;
(function (AngularCloudDataConnector) {
    var ConnectivityService = (function () {
        function ConnectivityService() {
            // Members
            this.onlineStatus = ConnectivityService.NotDefinedStatus;
            this.statusChangeFns = new Array();
        }
        Object.defineProperty(ConnectivityService, "OnlineStatus", {
            get: function () {
                return ConnectivityService._OnlineStatus;
            },
            enumerable: true,
            configurable: true
        });

        Object.defineProperty(ConnectivityService, "LocalStatus", {
            get: function () {
                return ConnectivityService._LocalStatus;
            },
            enumerable: true,
            configurable: true
        });

        Object.defineProperty(ConnectivityService, "NotDefinedStatus", {
            get: function () {
                return ConnectivityService._NotDefinedStatus;
            },
            enumerable: true,
            configurable: true
        });

        // Methods
        ConnectivityService.prototype.addStatusChangeNotify = function (notifyFn) {
            this.statusChangeFns.push(notifyFn);
        };

        ConnectivityService.prototype.getStatus = function () {
            if (this.onlineStatus === ConnectivityService.NotDefinedStatus) {
                this.resetStatus();
            }
            return this.onlineStatus;
        };

        ConnectivityService.prototype.setStatus = function (value) {
            var notifyChange = value != this.onlineStatus;
            this.onlineStatus = value;
            if (notifyChange) {
                angular.forEach(this.statusChangeFns, function (fn, index) {
                    fn();
                });
            }
        };

        ConnectivityService.prototype.resetStatus = function () {
            var _this = this;
            this.setStatus(navigator.onLine ? ConnectivityService.OnlineStatus : ConnectivityService.LocalStatus);

            if (window.addEventListener) {
                window.addEventListener("online", function () {
                    _this.setStatus(ConnectivityService.OnlineStatus);
                }, true);
                window.addEventListener("offline", function () {
                    _this.setStatus(ConnectivityService.LocalStatus);
                }, true);
            }
        };

        ConnectivityService.prototype.isOnline = function () {
            return this.getStatus() === ConnectivityService.OnlineStatus;
        };
        ConnectivityService._NotDefinedStatus = "not defined";
        ConnectivityService._OnlineStatus = "online";
        ConnectivityService._LocalStatus = "online";
        return ConnectivityService;
    })();
    AngularCloudDataConnector.ConnectivityService = ConnectivityService;
})(AngularCloudDataConnector || (AngularCloudDataConnector = {}));

// Angular
var connectivityModule = angular.module('ConnectivityModule', []);

connectivityModule.service('connectivityService', function () {
    return new AngularCloudDataConnector.ConnectivityService();
});
/* Copyright (c) Microsoft Open Technologies, Inc.  All rights reserved.  Licensed under the Apache License, Version 2.0.  See License.txt in the project root for license information. */ var AngularCloudDataConnector;
(function (AngularCloudDataConnector) {
    var indexedDB = window.indexedDB || window.mozIndexedDB || window.webkitIndexedDB || window.msIndexedDB;
    if (!indexedDB) {
        console.log("IDB not supported. Offline mode Framework will not be available.");
    }

    var DataService = (function () {
        function DataService(offlineService, connectivityService) {
            this.offlineService = offlineService;
            this.connectivityService = connectivityService;
            this._dataServices = new Array();
            // On a per table basis we keep track of the latest date we got data.  Ideally the data set contains the ability to query from a given time
            // So _lastSyncDate[0]['tableName']returns date.
            this._lastSyncDates = new Array();
            // Temp space
            this._pendingEntities = {};
        }
        DataService.prototype.addSource = function (dataService) {
            if (dataService._dataId !== undefined) {
                return;
            }
            dataService._dataId = this._dataServices.length;

            this._dataServices.push(dataService);

            var lastSyncDates = {};
            for (var i = 0; i < dataService.tableNames.length; i++) {
                lastSyncDates[dataService.tableNames[i]] = null;
            }
            this._lastSyncDates.push(lastSyncDates);
        };

        DataService.prototype.connect = function (onsuccess, scope, version) {
            var _this = this;
            if (typeof scope === "undefined") { scope = null; }
            if (typeof version === "undefined") { version = 1; }
            if (!indexedDB) {
                indexedDB = new AngularCloudDataConnector.Internals.InMemoryDatabase();
            }

            var request = indexedDB.open("syncbase", version);

            this._scope = scope;

            request.onerror = function (event) {
                console.log("IDB request error.", event.target.error.name);
            };

            // executes when a version change transaction cannot complete due to other active transactions
            request.onblocked = function (event) {
                console.log("IDB request blocked. Please reload the page.", event.target.error.name);
            };

            // DB has been opened successfully
            request.onsuccess = function () {
                console.log("DB successfully opened");
                _this._db = request.result;

                // If online, check for pending orders
                if (_this.connectivityService.isOnline()) {
                    _this.processPendingEntities(onsuccess);
                } else {
                    _this.sync(onsuccess);
                }

                // Offline support
                _this.connectivityService.addStatusChangeNotify(function () {
                    if (_this.connectivityService.isOnline()) {
                        _this.processPendingEntities(onsuccess);
                    } else {
                        _this.offlineService.reset();
                    }
                });
            };

            // Initialization of the DB. Creating stores
            request.onupgradeneeded = function (event) {
                _this._db = event.target.result;
                for (var i = 0; i < _this._dataServices.length; i++) {
                    var dataService = _this._dataServices[i];
                    for (var j = 0; j < dataService.tableNames.length; j++) {
                        var tableName = dataService.tableNames[j];
                        try  {
                            _this._db.createObjectStore(tableName + "LocalDB" + dataService._dataId, { keyPath: "id" });
                            _this._db.createObjectStore(tableName + "OfflineDB" + dataService._dataId, { keyPath: "index" });
                            console.log("Created object store in DB for " + tableName);
                        } catch (ex) {
                            console.log("Error while creating object stores for " + tableName + " Exception: " + ex.message);
                        }
                    }
                }
            };
        };

        DataService.prototype._prepareAndClone = function (objectToClone, tableName, dataService) {
            var result = {};

            for (var prop in objectToClone) {
                result[prop] = objectToClone[prop];
            }

            this._markItem(result, tableName, dataService);

            return result;
        };

        // Sync callback gets an object where the keys on the object will be placed into the $scope of the controller.
        // The values associate the key are arrays that correspond to the "Tables" from various cloud databases.
        DataService.prototype.sync = function (onsuccess) {
            var _this = this;
            var count = 0;
            for (var i = 0; i < this._dataServices.length; i++) {
                this.syncDataService(this._dataServices[i], function (partialResult) {
                    var results = { tableName: partialResult.tableName, table: [] };

                    for (var index = 0; index < partialResult.table.length; index++) {
                        results.table.push(_this._prepareAndClone(partialResult.table[index], partialResult.tableName, _this._dataServices[count]));
                    }

                    if (_this._scope) {
                        // Syncing the scope
                        if (_this._scope.$apply) {
                            _this._scope.$apply(_this._scope[results.tableName] = results.table);
                        } else {
                            _this._scope[results.tableName] = results.table;
                        }
                    }

                    // Calling onSuccess
                    if (onsuccess) {
                        onsuccess(results);
                    }

                    // Custom callback
                    if (_this.onSync) {
                        _this.onSync(results);
                    }
                });
            }
        };

        // onsuccess needs to be called with an object where the keys are the tablename and the values are the "tables"
        DataService.prototype.syncDataService = function (dataService, onsuccess) {
            var _this = this;
            if (this.connectivityService.isOnline()) {
                // Get the updated rows since last sync date
                dataService.get(function (tables) {
                    var tableCount = tables.length;

                    for (var i = 0; i < tableCount; i++) {
                        var tableName = tables[i].tableName;
                        var list = tables[i].table;
                        var lastSyncDate = _this._lastSyncDates[dataService._dataId][tableName];
                        var firstCall = (lastSyncDate === null);

                        for (var index = 0; index < list.length; index++) {
                            var entity = list[index];
                            var updatedate = new Date(entity.sync_updated);
                            if (!lastSyncDate || updatedate > lastSyncDate) {
                                _this._lastSyncDates[dataService._dataId][tableName] = updatedate;
                            }
                        }

                        _this.updateEntriesForTable(tableName, dataService, firstCall, list, function (currentTableName) {
                            _this.getEntriesForServiceTable(dataService, currentTableName, onsuccess);
                        });
                    }
                }, this._lastSyncDates[dataService._dataId]);
                return;
            }

            // Offline
            this.readAll(onsuccess);
        };

        Object.defineProperty(DataService.prototype, "tableCount", {
            get: function () {
                var result = 0;
                for (var i = 0; i < this._dataServices.length; i++) {
                    var dataService = this._dataServices[i];
                    result += dataService.tableNames.length;
                }

                return result;
            },
            enumerable: true,
            configurable: true
        });

        DataService.prototype.forAllTables = function (action, onsuccess) {
            var total = this.tableCount;
            var count = 0;
            var results = [];
            for (var i = 0; i < this._dataServices.length; i++) {
                var dataService = this._dataServices[i];
                for (var j = 0; j < dataService.tableNames.length; j++) {
                    var tableName = dataService.tableNames[j];
                    action(dataService, tableName, function (result) {
                        count++;
                        results.push(result);
                        if (count === total) {
                            onsuccess(results);
                        }
                    });
                }
            }
        };

        // this updates the values in the local index.db store - when it completes onsuccess is called with no value.
        DataService.prototype.updateEntriesForTable = function (tableName, dataService, firstCall, entities, onsuccess) {
            var dbName = tableName + "LocalDB" + dataService._dataId;
            var transaction = this._db.transaction([dbName], "readwrite");

            // the transaction could abort because of a QuotaExceededError error
            transaction.onabort = function (event) {
                console.log("Error with transaction", event.target.error.name);
            };

            transaction.oncomplete = function () {
                onsuccess(tableName);
            };

            var store = transaction.objectStore(dbName);

            if (firstCall) {
                store.clear(); // Start with a fresh empty store
            }

            for (var index = 0; index < entities.length; index++) {
                var entity = entities[index];

                if (firstCall) {
                    store.put(entity); // Inject all on first call
                } else {
                    if (entity.sync_deleted) {
                        store.delete(entity.id);
                    } else {
                        store.put(entity); // IDB will update or insert
                    }
                }
            }
        };

        // This gets all entries.  The callback onsuccess is called with an Object where the keys are the tableNames and the values are the tables.
        // Note that the arrays returned for the table are in memory copies of what is stored in the local database.
        DataService.prototype.readAll = function (onsuccess) {
            var _this = this;
            this.forAllTables(// action
            function (dataService, tableName, doNext) {
                _this.getEntriesForServiceTable(dataService, tableName, doNext);
            }, function (partialResultArray) {
                var result = {};
                for (var i = 0; i < partialResultArray.length; i++) {
                    result[partialResultArray[i].tableName] = partialResultArray[i].table;
                }
                if (onsuccess) {
                    onsuccess(result);
                }
            });
        };

        // onsuccess is called with an Object where the key is the tableName and the value is the table.
        DataService.prototype.getEntriesForServiceTable = function (dataService, tableName, onsuccess) {
            var _this = this;
            var dbName = tableName + "LocalDB" + dataService._dataId;
            var objectStore = this._db.transaction(dbName).objectStore(dbName);
            var resultTable = [];

            objectStore.openCursor().onsuccess = function (event) {
                var cursor = event.target.result;
                if (cursor) {
                    resultTable.push(cursor.value);
                    cursor.continue();
                } else {
                    if (onsuccess) {
                        var result = {
                            tableName: tableName,
                            table: resultTable,
                            dataService: dataService
                        };

                        _this[tableName] = resultTable;

                        onsuccess(result);
                    }
                }
            };
        };

        DataService.prototype.processPendingEntities = function (onsuccess) {
            var _this = this;
            var remainingTables = 0;
            for (var i = 0; i < this._dataServices.length; i++) {
                var dataService = this._dataServices[i];
                remainingTables += dataService.tableNames.length;
                for (var j = 0; j < dataService.tableNames.length; j++) {
                    var tableName = dataService.tableNames[j];
                    this.offlineService.checkForPendingEntities(this._db, tableName, dataService, function () {
                        remainingTables--;
                        if (remainingTables === 0) {
                            _this.sync(onsuccess);
                        }
                    });
                }
            }
        };

        DataService.prototype.findDataService = function (tableName) {
            var dataService = $.grep(this._dataServices, function (service) {
                return $.inArray(tableName, service.tableNames) != -1;
            });
            if (dataService.length >= 0) {
                return dataService[0];
            }
            return null;
        };

        DataService.prototype._addProperty = function (objectToMark, prop, currentValue, controlledEntity) {
            Object.defineProperty(objectToMark, prop, {
                get: function () {
                    return currentValue;
                },
                set: function (value) {
                    currentValue = value;
                    controlledEntity.isDirty = true;
                },
                enumerable: true,
                configurable: true
            });
        };

        DataService.prototype._markItem = function (objectToMark, tableName, dataService) {
            if (this._pendingEntities[tableName] && objectToMark._getControllerItem) {
                // Existing one
                var controlledEntity = objectToMark._getControllerItem();
                controlledEntity.isDirty = true;
            } else {
                // New one
                controlledEntity = {
                    isDirty: false,
                    dataService: dataService,
                    tableName: tableName,
                    entity: objectToMark,
                    isNew: false,
                    isDeleted: false
                };

                // Add properties instead of direct access members
                var count = 0;
                for (var prop in objectToMark) {
                    count++;
                    var currentValue = objectToMark[prop];
                    this._addProperty(objectToMark, prop, currentValue, controlledEntity);
                }

                objectToMark._getControllerItem = function () {
                    return controlledEntity;
                };
                count++;
                controlledEntity.enumerablePropertyCount = count;

                if (!this._pendingEntities[tableName]) {
                    this._pendingEntities[tableName] = new Array();
                }

                this._pendingEntities[tableName].push(controlledEntity);
            }

            return controlledEntity;
        };

        DataService.prototype.isDirtyIncludingNewProperties = function (controller) {
            if (controller.isDirty) {
                return true;
            }

            var propertyCount = Object.keys(controller.entity).length;
            if (propertyCount != (controller.enumerablePropertyCount + 1)) {
                // the +1 comes from $$hashKey that Angular ng-repeat operations inject
                // Now mark missing properties
                var count = 0;
                for (var prop in controller.entity) {
                    if (prop[0] === "_" || prop[0] === "$") {
                        continue;
                    }
                    count++;
                    var currentValue = controller.entity[prop];
                    this._addProperty(controller.entity, prop, currentValue, controller);
                }

                controller.enumerablePropertyCount = count + 1;
                controller.isDirty = true; // and remember this is still dirty.
                return true;
            }
            return false;
        };

        DataService.prototype.commit = function (onsuccess, onerror) {
            var _this = this;
            var count = 0;

            for (var tableName in this._pendingEntities) {
                for (var index in this._pendingEntities[tableName]) {
                    var entity = this._pendingEntities[tableName][index];
                    if (this.isDirtyIncludingNewProperties(entity)) {
                        count++;
                    }
                }
            }

            // onerror
            var processOnError = function () {
                if (!_this.connectivityService.isOnline()) {
                    _this.readAll(onerror);
                } else {
                    _this.sync(onerror);
                }
            };

            for (tableName in this._pendingEntities) {
                for (index in this._pendingEntities[tableName]) {
                    entity = this._pendingEntities[tableName][index];

                    // No need to process if not dirty
                    if (!this.isDirtyIncludingNewProperties(entity)) {
                        continue;
                    }

                    var offlineOrder;
                    var onlineFunc;
                    if (entity.isNew) {
                        offlineOrder = "put";
                        onlineFunc = entity.dataService.add;
                    } else if (entity.isDeleted) {
                        offlineOrder = "delete";
                        onlineFunc = entity.dataService.remove;
                    } else {
                        offlineOrder = "put";
                        onlineFunc = entity.dataService.update;
                    }

                    // Resetting states
                    entity.isNew = false;
                    entity.isDirty = false;
                    entity.isDeleted = false;

                    // Sending orders
                    if (!this.connectivityService.isOnline()) {
                        this.offlineService.processOfflineEntity(this._db, tableName, entity.dataService, offlineOrder, entity.entity, function () {
                            count--;

                            if (count === 0) {
                                _this.readAll(onsuccess);
                            }
                        }, processOnError);
                        continue;
                    }

                    // Online mode
                    onlineFunc.call(entity.dataService, tableName, entity.entity, function () {
                        count--;

                        if (count === 0) {
                            _this.sync(onsuccess);
                        }
                    }, processOnError);

                    continue;
                }
            }
        };

        DataService.prototype.rollback = function (onsuccess) {
            // This is where the magic happens. We just need to clear the pendingEntities and ask for a sync
            this._pendingEntities = {};

            // Sync
            if (!this.connectivityService.isOnline()) {
                this.readAll(onsuccess);
                return;
            }

            this.sync(onsuccess);
        };

        DataService.prototype._processFunction = function (tableName, entityOrArray, itemFunc) {
            var dataService = this.findDataService(tableName);
            var entities = entityOrArray;
            if (!Array.isArray(entityOrArray)) {
                entities = (entityOrArray === null) ? [] : [entityOrArray];
            }

            for (var index = 0; index < entities.length; index++) {
                var entity = entities[index];
                var controlledItem = this._markItem(entity, tableName, dataService);
                itemFunc(controlledItem);

                if (this._scope) {
                    // Syncing the scope
                    if (controlledItem.isDeleted) {
                        var position = this._scope[tableName].indexOf(entity);

                        if (position > -1) {
                            this._scope[tableName].splice(position, 1);
                        }
                        continue;
                    }

                    if (controlledItem.isNew) {
                        this._scope[tableName].push(entity);
                        continue;
                    }
                }
            }

            if (this._scope && this._scope.$apply && !this._scope.$$phase) {
                this._scope.$apply();
            }
        };

        DataService.prototype.add = function (tableName, entityOrArray) {
            this._processFunction(tableName, entityOrArray, function (item) {
                item.isDirty = true;
                item.isNew = true;
            });
        };

        DataService.prototype.remove = function (tableName, entityOrArray) {
            this._processFunction(tableName, entityOrArray, function (item) {
                item.isDirty = true;
                item.isDeleted = true;
            });
        };
        return DataService;
    })();
    AngularCloudDataConnector.DataService = DataService;
})(AngularCloudDataConnector || (AngularCloudDataConnector = {}));

// Angular
var dataModule = angular.module('DataModule', ['OfflineModule', 'ConnectivityModule']);

dataModule.factory('dataService', [
    'offlineService', 'connectivityService', function (offlineService, connectivityService) {
        return new AngularCloudDataConnector.DataService(offlineService, connectivityService);
    }]);
/* Copyright (c) Microsoft Open Technologies, Inc.  All rights reserved.  Licensed under the Apache License, Version 2.0.  See License.txt in the project root for license information. */ 
/* Copyright (c) Microsoft Open Technologies, Inc.  All rights reserved.  Licensed under the Apache License, Version 2.0.  See License.txt in the project root for license information. */ 
/* Copyright (c) Microsoft Open Technologies, Inc.  All rights reserved.  Licensed under the Apache License, Version 2.0.  See License.txt in the project root for license information. */ var AngularCloudDataConnector;
(function (AngularCloudDataConnector) {
    (function (Internals) {
        // The goal of this class is to provide a IDB API using only in-memory storage
        var InMemoryRequest = (function () {
            function InMemoryRequest(result) {
                var _this = this;
                this.result = result;
                this.onerror = null;
                this.onblocked = null;
                this.onsuccess = null;
                this.onupgradeneeded = null;
                setTimeout(function () {
                    if (_this.onupgradeneeded) {
                        _this.onupgradeneeded({ target: { result: _this.result } });
                    }

                    if (_this.onsuccess) {
                        _this.onsuccess();
                    }
                }, 0);
            }
            return InMemoryRequest;
        })();
        Internals.InMemoryRequest = InMemoryRequest;

        var InMemoryTransaction = (function () {
            function InMemoryTransaction(db) {
                var _this = this;
                this._db = db;
                setTimeout(function () {
                    if (_this.oncomplete) {
                        _this.oncomplete();
                    }
                }, 0);
            }
            InMemoryTransaction.prototype.objectStore = function (name) {
                return new InMemoryTransactionalObjectStore(this._db._objectStores[name], this);
            };
            return InMemoryTransaction;
        })();
        Internals.InMemoryTransaction = InMemoryTransaction;

        var InMemoryObjectStore = (function () {
            function InMemoryObjectStore(keypath) {
                this.keypath = keypath;
                this.data = [];
            }
            return InMemoryObjectStore;
        })();
        Internals.InMemoryObjectStore = InMemoryObjectStore;

        var InMemoryTransactionalObjectStore = (function () {
            function InMemoryTransactionalObjectStore(objectStore, transaction) {
                this.objectStore = objectStore;
                this.transaction = transaction;
            }
            InMemoryTransactionalObjectStore.prototype.delete = function (idToDelete) {
                if (this.objectStore.data[idToDelete]) {
                    delete this.objectStore.data[idToDelete];
                }
            };

            InMemoryTransactionalObjectStore.prototype.put = function (value) {
                var key = value[this.objectStore.keypath];
                this.objectStore.data[key] = value; // Add or update
            };

            InMemoryTransactionalObjectStore.prototype.openCursor = function () {
                return new InMemoryCursor(this.objectStore);
            };

            InMemoryTransactionalObjectStore.prototype.clear = function () {
                this.objectStore.data = [];
            };
            return InMemoryTransactionalObjectStore;
        })();
        Internals.InMemoryTransactionalObjectStore = InMemoryTransactionalObjectStore;

        var InMemoryCursor = (function () {
            function InMemoryCursor(objectStore) {
                this.objectStore = objectStore;
                this._position = -1;
                this._keys = [];

                for (var key in objectStore.data) {
                    this._keys.push(key);
                }

                this.continue();
            }
            Object.defineProperty(InMemoryCursor.prototype, "value", {
                get: function () {
                    return this.objectStore.data[this._keys[this._position]];
                },
                enumerable: true,
                configurable: true
            });

            InMemoryCursor.prototype.continue = function () {
                var _this = this;
                this._position++;

                var nextCursor = this._position < this._keys.length ? this : null;

                setTimeout(function () {
                    if (_this.onsuccess) {
                        _this.onsuccess({ target: { result: nextCursor } });
                    }
                }, 0);
            };
            return InMemoryCursor;
        })();
        Internals.InMemoryCursor = InMemoryCursor;

        var InMemoryDatabase = (function () {
            function InMemoryDatabase() {
                this._objectStores = {};
            }
            InMemoryDatabase.prototype.open = function (name, version) {
                return new InMemoryRequest(this);
            };

            InMemoryDatabase.prototype.createObjectStore = function (name, def) {
                this._objectStores[name] = new InMemoryObjectStore(def.keyPath);
            };

            InMemoryDatabase.prototype.transaction = function (name) {
                return new InMemoryTransaction(this);
            };
            return InMemoryDatabase;
        })();
        Internals.InMemoryDatabase = InMemoryDatabase;
    })(AngularCloudDataConnector.Internals || (AngularCloudDataConnector.Internals = {}));
    var Internals = AngularCloudDataConnector.Internals;
})(AngularCloudDataConnector || (AngularCloudDataConnector = {}));
/* Copyright (c) Microsoft Open Technologies, Inc.  All rights reserved.  Licensed under the Apache License, Version 2.0.  See License.txt in the project root for license information. */ 
/* Copyright (c) Microsoft Open Technologies, Inc.  All rights reserved.  Licensed under the Apache License, Version 2.0.  See License.txt in the project root for license information. */ var AngularCloudDataConnector;
(function (AngularCloudDataConnector) {
    var OfflineService = (function () {
        function OfflineService() {
            this._offlineIndex = 0;
        }
        // Check for pending commands generated when offline
        OfflineService.prototype.checkForPendingEntities = function (db, tableName, dataService, onsuccess) {
            var dbName = tableName + "OfflineDB" + dataService._dataId;
            var objectStore = db.transaction(dbName).objectStore(dbName);
            var commands = new Array();

            var deleteCommand = function (command, then) {
                var transaction = db.transaction(dbName, "readwrite");

                transaction.oncomplete = function () {
                    console.log("Command " + command.order + " for " + command.entity.id + " was played");
                    then();
                };

                transaction.onabort = function () {
                    console.log("Unable to remove offline command");
                };

                objectStore = transaction.objectStore(dbName);
                objectStore.delete(command.index);
            };

            var processCommand = function (index) {
                if (index >= commands.length) {
                    if (onsuccess) {
                        onsuccess();
                    }
                    return;
                }

                var command = commands[index];
                var entity = command.entity;
                var currentTableName = command.tableName;

                try  {
                    switch (command.order) {
                        case "put":
                            var localId = entity.id;
                            delete entity.id; // Let data provider generate the ID for us
                            dataService.add(currentTableName, entity, function (newEntity) {
                                for (var i = 0; i < commands.length; i++) {
                                    if (commands[i].entity.id === localId) {
                                        commands[i].entity.id = newEntity.id;
                                    }
                                }

                                // Deleting command
                                deleteCommand(command, function () {
                                    processCommand(index + 1);
                                });
                            }, function (err) {
                                processCommand(index + 1);
                            });
                            break;
                        case "delete":
                            dataService.remove(currentTableName, entity, function () {
                                deleteCommand(command, function () {
                                    processCommand(index + 1);
                                });
                            }, function (err) {
                                processCommand(index + 1);
                            });
                            break;
                    }
                } catch (ex) {
                    console.log("Error processing pending entity for " + currentTableName + ". Exception: " + ex.message);
                    processCommand(index + 1);
                }
            };

            // Get commands
            objectStore.openCursor().onsuccess = function (event) {
                var cursor = event.target.result;
                if (cursor) {
                    commands.push(cursor.value);
                    cursor.continue();
                } else {
                    processCommand(0);
                }
            };
        };

        OfflineService.prototype.reset = function () {
            this._offlineIndex = 0;
        };

        // Generate offline commands
        OfflineService.prototype.processOfflineEntity = function (db, tableName, dataService, order, entity, onsuccess, onerror) {
            var dbNameLocal = tableName + "LocalDB" + dataService._dataId;
            var dbNameOffline = tableName + "OfflineDB" + dataService._dataId;
            var transaction = db.transaction([dbNameLocal, dbNameOffline], "readwrite");

            transaction.onabort = function (event) {
                onerror(event);
            };

            transaction.oncomplete = function () {
                onsuccess();
            };

            var storeLocal = transaction.objectStore(dbNameLocal);
            var storeOffline = transaction.objectStore(dbNameOffline);

            if (this._offlineIndex === 0) {
                storeOffline.clear();
            }

            switch (order) {
                case "put":
                    entity.id = this._offlineIndex.toString();
                    storeLocal.put(entity);
                    break;
                case "delete":
                    storeLocal.delete(entity.id);
                    break;
            }
            storeOffline.put({
                index: this._offlineIndex.toString(),
                order: order,
                tableName: tableName,
                entity: entity
            });

            this._offlineIndex++;
        };
        return OfflineService;
    })();
    AngularCloudDataConnector.OfflineService = OfflineService;
})(AngularCloudDataConnector || (AngularCloudDataConnector = {}));

// Angular
var dataModule = angular.module('OfflineModule', []);

dataModule.factory('offlineService', function () {
    return new AngularCloudDataConnector.OfflineService();
});
//# sourceMappingURL=AngularCloudDataConnector.js.map
