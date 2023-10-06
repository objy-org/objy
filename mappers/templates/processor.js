const ProcessorMapperTemplate = function(OBJY) {
    this.CONSTANTS = {
        MULTITENANCY: {
            ISOLATED: "isolated",
            SHARED: "shared"
        },
        TYPES: {
            SCHEDULED: 'scheduled',
            QUERIED: 'queried'
        }
    }

    this.OBJY = OBJY;
    this.objectFamily = null;
    this.multitenancy = this.CONSTANTS.MULTITENANCY.ISOLATED;

    this.execute = function(dsl, obj, prop, data, callback, client, app, user, options) {

    };

    this.setMultiTenancy = function(value) {
        this.multitenancy = value;
    };

    this.setObjectFamily = function(value) {
        this.objectFamily = value;
    };

};

module.exports = ProcessorMapperTemplate;