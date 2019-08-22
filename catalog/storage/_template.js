Mapper = function(SPOO, options) {
    this.CONSTANTS = {
        MULTITENANCY: {
            ISOLATED: "isolated",
            SHARED: "shared"
        },
        TYPES: {
            SCHEDULED: 'scheduled',
            QUERIED: 'queried'
        }
    };
    this.objectFamily = null;
    this.multitenancy = (options || {}).multitenancy || this.CONSTANTS.MULTITENANCY.ISOLATED;

    this.connect = function(connectionString, success, error) {

    }

    this.closeConnection = function(success, error) {

    }

    this.setObjectFamily = function(value) {
        this.objectFamily = value;
    };

    this.setMultiTenancy = function(value) {
        this.multitenancy = value;
    };

    this.createClient = function(client, success, error) {

    };

    this.getDBByMultitenancy = function(client) {

    };

    this.listClients = function(success, error) {

    };

    this.getById = function(id, success, error, app, client) {

    }

    this.getByCriteria = function(criteria, success, error, app, client, flags) {

    }

    this.count = function(criteria, success, error, app, client, flags) {

    }

    this.update = function(spooElement, success, error, app, client) {

    };

    this.add = function(spooElement, success, error, app, client) {

    };

    this.remove = function(spooElement, success, error, app, client) {

    };
}

module.exports = Mapper;