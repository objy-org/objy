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

Mapper = function(OBJY, options) {
    this.type = (options || {}).type || CONSTANTS.TYPES.SCHEDULED;
    this.database = {};
    this.objectFamily = null;
    this.index = {};
    this.OBJY = OBJY;
    this.multitenancy = (options || {}).multitenancy || CONSTANTS.MULTITENANCY.ISOLATED;

    this.setObjectFamily = function(value) {
        this.objectFamily = value;
    };

    this.setMultiTenancy = function(value) {
        this.multitenancy = value;
    };

    this.getDBByMultitenancy = function(client) {

        if (this.multitenancy == CONSTANTS.MULTITENANCY.ISOLATED) {
            if (!Array.isArray(this.database)) this.database = [];

            return this.database;
        } else if (this.multitenancy == CONSTANTS.MULTITENANCY.SHARED) {

            if (!this.database[client])
                throw new Error('no database for client ' + client);

            return this.database[client];
        }
    };

    this.listTenants = function(success, error) {
        if (!this.database)
            return error('no database');
        success(Object.keys(this.database));
    };

    this.getEvent = function(objId, propName, success, error, client) {
       var db = this.getDBByMultitenancy(client);

        if (!this.index[client][objId + ':' + propName])
            return error('object not found: ' + objId + ':' + propName);

        /*if(this.multitenancy == CONSTANTS.MULTITENANCY.ISOLATED)
            if(this.index[client][objId + ':'+propName].tenantId != client) 
                return error('object not found: ' + objId + ':'+propName);*/

        console.log(this.index[client]);
        
        db.splice(this.index[client][objId + ':' + propName], 1);
        success(this.index[client][objId + ':' + propName]);
    };

    this.addEvent = function(objId, propName, event, success, error, client) {
        var self = this;

        if (!this.database[client])
            this.database[client] = [];

        if (!this.index[client]) this.index[client] = [];

        if (this.index[client][objId + ':' + propName])
            return error('object with that id already exists: ' + objId);

        if (!this.index[client]) this.index[client] = {};

        var db = this.getDBByMultitenancy(client);

        if (this.multitenancy == CONSTANTS.MULTITENANCY.ISOLATED)
            event.tenantId = client;

        if (event.date) {
            var difference = Infinity;

            difference = moment().diff(event.date);

            db.push(setTimeout(function() {

                // @TODO: link to processor
                if(self.OBJY.processors[self.objectFamily]) self.OBJY.processors[self.objectFamily].execute(event.action, {}, {}, {}, function(){}, client, null, null, {});
                else self.OBJY.Logger.warn('No processor defined')

            }, difference))
        } else if (event.interval) {

            var interval = Infinity; // @TODO: convert iso8601 duration to millis

            interval = moment.duration(event.interval).asMilliseconds()

            if (interval == 0) interval = Infinity;

            db.push(setInterval(function() {

                console.log(event.action);

                if(self.OBJY.processors[self.objectFamily]) self.OBJY.processors[self.objectFamily].execute(event.action, {}, {}, {}, function(){}, client, null, null, {});
                else self.OBJY.Logger.warn('No processor defined')

            }, interval))
        }

        this.index[client][objId + ':' + propName] = db.length;

        success(event);
    };

    this.removeEvent = function(objId, propName, success, error, client) {

        var db = this.getDBByMultitenancy(client);

        if (!this.index[client][objId + ':' + propName])
            return error('object not found: ' + objId + ':' + propName);

        /*if(this.multitenancy == CONSTANTS.MULTITENANCY.ISOLATED)
            if(this.index[client][objId + ':'+propName].tenantId != client) 
                return error('object not found: ' + objId + ':'+propName);*/

        console.log(this.index[client]);

        try {
            clearInterval(db[this.index[client][objId + ':' + propName]]);
            clearTimeout(db[this.index[client][objId + ':' + propName]]);
        } catch(e){ }

        db.splice(this.index[client][objId + ':' + propName], 1);
        delete this.index[client][objId + ':' + propName];
        success('removed')

    };
}

module.exports = Mapper;