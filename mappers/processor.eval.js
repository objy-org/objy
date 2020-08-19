Mapper = function(OBJY) {
    return Object.assign(new OBJY.ProcessorTemplate(OBJY), {

        execute: function(dsl, obj, prop, data, callback, client, app, user, options) {

            OBJY.Logger.log("Executing dsl in mapper")
            if (this.multitenancy == this.CONSTANTS.MULTITENANCY.ISOLATED) {
                try {
                    if (!OBJY.dslType || OBJY.dslType == 'js')
                        eval(dsl);
                    else if (OBJY.dslType == 'custom') {
                        OBJY.lang.parse(dsl);
                    }
                } catch (e) {
                    OBJY.Logger.error(e)
                }
                callback();
            } else {
                try {
                    if (!OBJY.dslType || OBJY.dslType == 'js')
                        eval(dsl);
                    else if (OBJY.dslType == 'custom') {
                        OBJY.lang.parse(dsl);
                    }
                } catch (e) {
                    OBJY.Logger.error(e)
                }
                callback();
            }
        }
    })
}

module.exports = Mapper;