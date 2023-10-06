const ObserverMapperTemplate = function(OBJY, options, content) {
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
    this.OBJY = OBJY;
    this.interval = (options || {}).interval || 60000;
    this.objectFamily = null;
    this.type = (options || {}).type || this.CONSTANTS.TYPES.QUERIED;
    this.multitenancy = (options || {}).multitenancy || this.CONSTANTS.MULTITENANCY.ISOLATED;

    this.initialize = function(millis) {

    }

    this.setObjectFamily = function(value) {
        this.objectFamily = value;
    };

    this.run = function(date) {

    }

    if (content) Object.assign(this, content)
}

module.exports = ObserverMapperTemplate;