var Global = require('./_template.js');

Mapper = function(SPOO) {
    return Object.assign(new Global(SPOO), {

        execute: function(dsl, obj, prop, data, callback, client, app, user, options) {

            var SPOO = this.SPOO;
            console.info("22..", dsl);
            if (this.multitenancy == this.CONSTANTS.MULTITENANCY.ISOLATED) {
                try {
                    console.info('pre eval')

                    eval(dsl);
                    console.info('after eval')
                } catch (e) {
                    console.info(e);
                }
                callback();
            } else {
                try {
                    eval(dsl);
                } catch (e) {
                    console.info(e);
                }
                callback();
            }
        }
    })
}

module.exports = Mapper;