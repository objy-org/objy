// BULLJS SCHEDULED MAPPER

var Queue = require('bull');
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

    this.scheduledQueue = new Queue('scheduledQueue', (options || {}).redisCon || 'redis://127.0.0.1:6379');

    this.type = (options || {}).type || CONSTANTS.TYPES.SCHEDULED;
    this.database = {};
    this.objectFamily = null;
    this.index = {};
    this.OBJY = OBJY;
    this.multitenancy = (options || {}).multitenancy || CONSTANTS.MULTITENANCY.ISOLATED;


/*
    this.scheduledQueue.process(function(job, done){
        console.log('processing job', job)
      done();
    });
*/

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
      
      // CURRENTLY ONLY POSSIBLE FOR DELAYED JOBS 
      this.scheduledQueue.getJob(objId + ':' + propName).then(function(job){
            console.log('jjjoib__', job)
            success(job)
      });
      
    };
 
    this.addEvent = function(objId, propName, event, success, error, client) {
        var self = this;

        /*CHECK IF EXISTS*/

        if (this.multitenancy == CONSTANTS.MULTITENANCY.ISOLATED)
            event.tenantId = client;

        if (event.date) {
            var difference = Infinity;

            difference = moment().diff(event.date);

            this.scheduledQueue.add(objId + ':' + propName, { objId: objId, propName: propName, event:event,client: client }, { jobId: objId + ':' + propName, delay: difference }).then(function(job){
                success(event);
            });

        } else if (event.interval) {

            var interval = Infinity; // @TODO: convert iso8601 duration to millis

            interval = moment.duration(event.interval).asMilliseconds()

            if (interval == 0) interval = Infinity;

            this.scheduledQueue.add(objId + ':' + propName, { objId: objId, propName: propName, event:event,client: client }, { repeat: {
              every: interval
            }, jobId: objId + ':' + propName}).then(function(job){
                success(event);
            });
        }

    };

    this.removeEvent = function(objId, propName, event, success, error, client) {

        var self = this;

        function remRepeatable()
        {

            var interval = Infinity;

            interval = moment.duration(event.interval).asMilliseconds()

            console.log({ repeat: {
              every: interval
            }, jobId: objId + ':' + propName})

            self.scheduledQueue.removeRepeatable(objId + ':' + propName, { repeat: {
              every: interval
            }, jobId: objId + ':' + propName}).then(function(rj){
                success(rj)
            });
        }

        this.scheduledQueue.getJob(objId + ':' + propName).then(function(job){
            
            if(!job) return remRepeatable();
            job.remove().then(function(job){

                if(Object.keys(job || {}).length > 0) success(job)
                else remRepeatable()

            });
        });
    };
}

module.exports = Mapper;