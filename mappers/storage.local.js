var Datastore = require('./../dependencies/nedb.min.js')
var Mapper = function(OBJY, options) {

    return Object.assign(new OBJY.StorageTemplate(OBJY, options), {

        database: {},
        index: {},

        createClient: function(client, success, error) {
            if (!client) client = 'default';

            if (this.multitenancy == this.CONSTANTS.MULTITENANCY.ISOLATED) {
                if (this.database[client + '_' + this.objectFamily])
                    error('Client already exists')

                this.database[client + '_' + this.objectFamily] = new Datastore({ filename: client + '_' + this.objectFamily + '.db', autoload: true })
                success()
            }
        },

        getConnection: function() {
            return this.database;
        },

        useConnection: function(connection, success, error) {
            this.database = connection;

            return this;
        },

        getDBByMultitenancy: function(client) {
            if (!client) client = 'default';

            console.log(client, this.objectFamily);

            if (!this.database[client + '_' + this.objectFamily]) this.database[client + '_' + this.objectFamily] = new Datastore({ filename: client + '_' + this.objectFamily + '.db', autoload: true })

            if (this.multitenancy == this.CONSTANTS.MULTITENANCY.SHARED) {
                if (!Array.isArray(this.database)) this.database = [];

                return this.database;
            } else if (this.multitenancy == this.CONSTANTS.MULTITENANCY.ISOLATED) {

                if (!this.database[client + '_' + this.objectFamily])
                    throw new Error('no database for client ' + client);

                return this.database[client + '_' + this.objectFamily];
            }
        },

        listClients: function(success, error) {
            if (!this.database)
                return error('no database');

            if (this.multitenancy == this.CONSTANTS.MULTITENANCY.ISOLATED) {
                var dbs = [];
                Object.keys(this.database).forEach(function(d) {
                    dbs.push(d.split('_')[0])
                })
                success(dbs);
            } else success(Object.keys(this.database));
        },

        getById: function(id, success, error, app, client) {
            if (!client) client = 'default';

            var db = this.getDBByMultitenancy(client);

            db.find({ _id: id }, function(err, docs) {
                if (err) return error('db error');
                if (docs.length != 1) return error('object not found: ' + id)

                success(docs[0]);
            });

        },

        getByCriteria: function(criteria, success, error, app, client, flags) {
            if (!client) client = 'default';

            var db = this.getDBByMultitenancy(client);

            if (app)
                Object.assign(criteria, {
                    applications: {
                        $in: [app]
                    }
                })

            if (this.multitenancy == this.CONSTANTS.MULTITENANCY.SHARED)
                Object.assign(criteria, {
                    tenantId: client
                })

            db.find(criteria, function(err, docs) {
                if (err) return error('db error');
                success(docs);
            });

        },

        count: function(criteria, success, error, app, client, flags) {
            if (!client) client = 'default';

            var db = this.getDBByMultitenancy(client);

            if (app)
                Object.assign(criteria, {
                    applications: {
                        $in: [app]
                    }
                })

            if (this.multitenancy == this.CONSTANTS.MULTITENANCY.SHARED)
                Object.assign(criteria, {
                    tenantId: client
                })

            db.count(criteria, function(err, count) {
                if (err) return error('db error');
                success(count);
            });
        },

        update: function(spooElement, success, error, app, client) {
            if (!client) client = 'default';

            var db = this.getDBByMultitenancy(client);

            db.update({ _id: spooElement._id }, spooElement, {}, function(err, numReplaced) {
                if (err) return error('update error');
                success(spooElement)
            });
        },

        add: function(spooElement, success, error, app, client) {
            if (!client) client = 'default';

            var db = this.getDBByMultitenancy(client);

            if (this.multitenancy == this.CONSTANTS.MULTITENANCY.SHARED) {
                spooElement.tenantId = client;
            }

            db.insert(spooElement, function(err, newDoc) {
                if (err) return error('insert error');
                success(newDoc)
            });
        },
        remove: function(spooElement, success, error, app, client) {
            if (!client) client = 'default';

            var db = this.getDBByMultitenancy(client);

            db.remove({ _id: spooElement._id }, function(err, numRemoved) {
                if (err) return error('remove error');
                success(spooElement)
            });
        }

    })
}

if (window) window.LocalMapper = Mapper;

module.exports = Mapper;