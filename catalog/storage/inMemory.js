var Query = require("query");

var Global = require('./_template.js')

Mapper = function(SPOO, options) {

    return Object.assign(new Global(SPOO, options), {

        database: {},
        index: {},

        createClient: function(client, success, error) {

            if (this.multitenancy == this.CONSTANTS.MULTITENANCY.ISOLATED) {
                if (this.database[client])
                    error('Client already exists')

                this.database[client] = [];
                this.index[client] = {};
                success()
            }
        },
        getDBByMultitenancy: function(client) {

            if (this.multitenancy == this.CONSTANTS.MULTITENANCY.SHARED) {
                if (!Array.isArray(this.database)) this.database = [];

                return this.database;
            } else if (this.multitenancy == this.CONSTANTS.MULTITENANCY.ISOLATED) {

                if (!this.database[client])
                    throw new Error('no database for client ' + client);

                return this.database[client];
            }
        },

        listClients: function(success, error) {
            if (!this.database)
                return error('no database');

            if (this.multitenancy == this.CONSTANTS.MULTITENANCY.ISOLATED)
                success(Object.keys(this.database));
            else success(Object.keys(this.database));
        },

        getById: function(id, success, error, app, client) {

            var db = this.getDBByMultitenancy(client);

            if (this.index[client][id] === undefined)
                return error('object not found: ' + id);

            if (this.multitenancy == this.CONSTANTS.MULTITENANCY.SHARED)
                if (this.index[client][id].tenantId != client)
                    return error('object not found: ' + _id);

            success(db[this.index[client][id]]);
        },

        getByCriteria: function(criteria, success, error, app, client, flags) {

            var db = this.getDBByMultitenancy(client);

            if (app)
                Object.assign(criteria, { applications: { $in: [app] } })

            if (this.multitenancy == this.CONSTANTS.MULTITENANCY.SHARED)
                Object.assign(criteria, { tenantId: client })

            success(Query.query(db, criteria, Query.undot));
        },

        count: function(criteria, success, error, app, client, flags) {

            var db = this.getDBByMultitenancy(client);

            if (app)
                Object.assign(criteria, { applications: { $in: [app] } })

            if (this.multitenancy == this.CONSTANTS.MULTITENANCY.SHARED)
                Object.assign(criteria, { tenantId: client })

            success(Query.query(db, criteria, Query.undot).length);
        },

        update: function(spooElement, success, error, app, client) {

            var db = this.getDBByMultitenancy(client);

            if (this.index[client][spooElement._id] === undefined)
                return error('object not found: ' + spooElement._id);

            if (this.multitenancy == this.CONSTANTS.MULTITENANCY.SHARED)
                if (this.index[client][spooElement._id].tenantId != client)
                    return error('object not found: ' + _id);

            db[this.index[client][spooElement._id]] = spooElement;

            success(db[this.index[client][spooElement._id]]);
        },

        add: function(spooElement, success, error, app, client) {

            if (!this.database[client])
                this.database[client] = [];

            if (!this.index[client]) this.index[client] = {};

            if (this.index[client][spooElement._id] !== undefined)
                return error('object with taht id already exists: ' + spooElement._id);
            if (!this.index[client]) this.index[client] = {};

            var db = this.getDBByMultitenancy(client);

            if (this.multitenancy == this.CONSTANTS.MULTITENANCY.SHARED) {
                spooElement.tenantId = client;
            }



            this.index[client][spooElement._id] = db.push(spooElement) - 1;

            success(spooElement);
        },
        remove: function(spooElement, success, error, app, client) {

            var db = this.getDBByMultitenancy(client);

            if (this.index[client][spooElement._id] === undefined)
                return error('object not found: ' + spooElement._id);

            if (this.multitenancy == this.CONSTANTS.MULTITENANCY.SHARED)
                if (this.index[client][spooElement._id].tenantId != client)
                    return error('object not found: ' + spooElement._id);


            db.splice(this.index[client][spooElement._id], 1);
            delete this.index[client][spooElement._id];
            success(spooElement)

        }


    })
}



module.exports = Mapper;