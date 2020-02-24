var mongoose = require('mongoose');
var Grid = require('gridfs-stream');
var GridFsStorage = require('multer-gridfs-storage');
var shortid = require('shortid');

const { createModel } = require('mongoose-gridfs');

var Attachment;

const mongo = mongoose.mongo;

Mapper = function(OBJY, options) {
    return Object.assign(new OBJY.StorageTemplate(OBJY, options), {

        database: {},
        index: {},
        globalPaging: 20,

        connect: function(connectionString, success, error) {
            this.database = mongoose.createConnection(connectionString);

            this.database.on('error', function(err) {
                error(err)
            });

            this.database.once('open', function() {
                success();
            });

            return this;
        },

        getConnection: function() {
            return this.database;
        },

        useConnection: function(connection, success, error) {
            this.database = connection;

            this.database.on('error', function(err) {
                error(err)
            });

            this.database.once('open', function() {
                success();
            });

            return this;
        },

        getDBByMultitenancy: function(client) {

            if (this.multitenancy == this.CONSTANTS.MULTITENANCY.SHARED) {
                return this.database.useDb('spoo')
            } else if (this.multitenancy == this.CONSTANTS.MULTITENANCY.ISOLATED) {
                return this.database.useDb(client)
            }
        },

        createClient: function(client, success, error) {

            var db = this.getDBByMultitenancy(client);

            var ClientInfo = db.model('clientinfos', ClientSchema);

            ClientInfo.find({ name: client }).exec(function(err, data) {
                if (err) {
                    error(err);
                    return;
                }
                if (data.length >= 1) {
                    error("client name already taken")
                } else {

                    new ClientInfo({ name: client }).save(function(err, data) {
                        if (err) {

                            error(err);
                            return;
                        }

                        success(data);

                    })
                }

            });
        },

        listClients: function(success, error) {

            if (this.multitenancy == this.CONSTANTS.MULTITENANCY.ISOLATED) {

                new Admin(this.database.db).listDatabases(function(err, result) {
                    if (err) error(err)
                    success(result.databases.map(function(item) {
                        return item.name
                    }));
                });

            } else {
                var db = this.getDBByMultitenancy('spoo');

                var ClientInfo = db.model('clientinfos', ClientSchema);

                ClientInfo.find({}).exec(function(err, data) {

                    if (err) {

                        error(err);
                        return;
                    }

                    success(data.map(function(item) {
                        return item.name
                    }))

                });
            }
        },

        getById: function(id, success, error, app, client) {

            var db = this.getDBByMultitenancy(client);

            var Attachment = createModel({
                modelName: 'Attachment',
                connection: db
            });

            try {
                var data = Attachment.read({ _id: id })

                success({ _id: id, name: id, role: this.objectFamily, properties: { data: data } });
            } catch (e) {
                OBJY.Logger.error(e);
                error('Error getting file')
            }
        },

        getByCriteria: function(criteria, success, error, app, client, flags) {

            error('Querying not possible')

        },

        count: function(criteria, success, error, app, client, flags) {

            error('Count not possible')
        },

        update: function(spooElement, success, error, app, client) {

            error('Update not possible')
        },

        add: function(spooElement, success, error, app, client) {

            var db = this.getDBByMultitenancy(client);

            var Attachment = createModel({
                modelName: 'Attachment',
                connection: db
            });

            spooElement = spooElement.properties.data;

            try {

                var fileId = shortid.generate();

                Attachment.write({ filename: fileId, name: fileId }, spooElement, (err, file) => {
                    if (err) {
                        OBJY.Logger.error(err);
                        error('Error adding file');
                        return;
                    }
                    success({ _id: file._id, name: fileId })
                });

            } catch (e) {
                OBJY.Logger.error(e);
                error('Error adding file')
            }
        },
        remove: function(spooElement, success, error, app, client) {

            var db = this.getDBByMultitenancy(client);

            var Attachment = createModel({
                modelName: 'Attachment',
                connection: db
            });

            Attachment.unlink({ _id: spooElement._id }, (err, file) => {
                if (err) {
                    OBJY.Logger.error(err);
                    error('Error removing file');
                    return
                }

                success({ _id: spooElement._id })
            });
        }
    })
}



module.exports = Mapper;