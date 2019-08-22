// SCHEDULED MAPPER

var moment = require('moment');

var CONSTANTS = {
    MULTITENANCY: {
        ISOLATED: "isolated",
        SHARED: "shared"
    },
    TYPES: {
        SCHEDULED: 'scheduled',
        QUERIED: 'queried'
    }
}

Mapper = function(SPOO, options) {
    this.type = (options || {}).type || CONSTANTS.TYPES.SCHEDULED;
    this.database = {};
    this.objectFamily = null;
    this.index = {};
    this.multitenancy = (options || {}).multitenancy || CONSTANTS.MULTITENANCY.ISOLATED;
}

Mapper.prototype.setObjectFamily = function(value) {
    this.objectFamily = value;
};

Mapper.prototype.setMultiTenancy = function(value) {
    this.multitenancy = value;
};

Mapper.prototype.getDBByMultitenancy = function(client) {

    if (this.multitenancy == CONSTANTS.MULTITENANCY.ISOLATED) {
        if (!Array.isArray(this.database)) this.database = [];

        return this.database;
    } else if (this.multitenancy == CONSTANTS.MULTITENANCY.SHARED) {

        if (!this.database[client])
            throw new Error('no database for client ' + client);

        return this.database[client];
    }
};

Mapper.prototype.listTenants = function(success, error) {
    if (!this.database)
        return error('no database');


    success(Object.keys(this.database));
};

Mapper.prototype.getEvent = function(objId, propName, success, error, client) {

    var db = this.getDBByMultitenancy(client);

    if (!db[objId])
        return error('object not found: ' + objId);

    if (this.multitenancy == CONSTANTS.MULTITENANCY.ISOLATED)
        if (db[this.index[client][objId]].tenantId != client)
            error('object not found: ' + objId);

    success(db[this.index[client][objId]]);
}

Mapper.prototype.addEvent = function(objId, propName, event, success, error, client) {

    var self = this;

    if (!this.database[client])
        this.database[client] = [];

    if (!this.index[client]) this.index[client] = [];

    if (this.index[client][objId + ':' + propName])
        return error('object with taht id already exists: ' + objId);

    if (!this.index[client]) this.index[client] = {};

    var db = this.getDBByMultitenancy(client);

    if (this.multitenancy == CONSTANTS.MULTITENANCY.ISOLATED)
        event.tenantId = client;

    if (event.date) {
        var difference = Infinity;

        difference = moment().diff(event.date);

        db.push(setTimeout(function() {

            // @TODO: link to processor

        }, difference))
    } else if (event.interval) {

        var interval = Infinity; // @TODO: convert iso8601 duration to millis

        interval = moment.duration(event.interval).asMilliseconds()

        if (interval == 0) interval = Infinity;

        db.push(setInterval(function() {

            // @TODO: link to processor

            console.log(event.action);

            //self.processor.execute(dsl, obj, prop, data, callback, client, app, user, options);

        }, interval))
    }

    this.index[client][objId + ':' + propName] = db.length;

    success(event);

};

Mapper.prototype.removeEvent = function(objId, propName, success, error, client) {

    var db = this.getDBByMultitenancy(client);



    if (!this.index[client][objId + ':' + propName])
        return error('object not found: ' + objId + ':' + propName);



    /*if(this.multitenancy == CONSTANTS.MULTITENANCY.ISOLATED)
        if(this.index[client][objId + ':'+propName].tenantId != client) 
            return error('object not found: ' + objId + ':'+propName);*/

    console.log(this.index[client]);


    db.splice(this.index[client][objId + ':' + propName], 1);
    delete this.index[client][objId + ':' + propName];
    success('removed')

};

module.exports = Mapper;