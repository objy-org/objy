Mapper = function(OBJY) {
    return Object.assign(new OBJY.ProcessorTemplate(OBJY), {

        execute: function(dsl, obj, prop, data, callback, client, app, user, options) {

            var OBJY = this.OBJY;
            OBJY.Logger.log("Executing dsl in mapper")
            if (this.multitenancy == this.CONSTANTS.MULTITENANCY.ISOLATED) {
                try {
                    eval(dsl);
                } catch (e) {
                    OBJY.Logger.error(e)
                }
                callback();
            } else {
                try {
                    eval(dsl);
                } catch (e) {
                    OBJY.Logger.error(e)
                }
                callback();
            }
        }
    })
}

module.exports = Mapper;