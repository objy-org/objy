export default function (OBJY, mapperOptions) {
    return Object.assign(new OBJY.ProcessorTemplate(OBJY), {
        execute: function (dsl, obj, prop, data, callback, client, app, user, options) {
            OBJY.Logger.log('Executing dsl in mapper');

            if (this.multitenancy == this.CONSTANTS.MULTITENANCY.ISOLATED) {
                try {
                    if ((mapperOptions || {}).hasOwnProperty('parse')) {
                        mapperOptions.parse(dsl);
                    } else {
                        if (typeof dsl === 'function') dsl(callback);
                        else eval(dsl);
                    }
                } catch (e) {
                    OBJY.Logger.error(e);
                }
                //if (callback) callback();
            } else {
                try {
                    if ((mapperOptions || {}).hasOwnProperty('parse')) {
                        mapperOptions.parse(dsl);
                    } else {
                        if (typeof dsl === 'function') dsl(callback);
                        else eval(dsl);
                    }
                } catch (e) {
                    OBJY.Logger.error(e);
                }
                //if (callback) callback();
            }
        },
    });
};

