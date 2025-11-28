export default function (OBJY, mapperOptions) {
    return Object.assign(new OBJY.ProcessorTemplate(OBJY), {
        execute: function (dsl, beforeObj, afterObj, prop, done, client, app, user, options) {
            OBJY.Logger.log('Executing dsl in mapper');

            if (this.multitenancy == this.CONSTANTS.MULTITENANCY.ISOLATED) {
                try {
                    if ((mapperOptions || {}).hasOwnProperty('parse')) {
                        mapperOptions.parse(dsl);
                    } else {
                        
                        if (typeof dsl === 'function') {
                            console.log(dsl.toString())
                            dsl(done, obj);
                        } 
                        else eval(dsl);
                    }
                } catch (e) {
                    OBJY.Logger.error(e);
                }
                //if (done) done();
            } else {
                try {
                    if ((mapperOptions || {}).hasOwnProperty('parse')) {
                        mapperOptions.parse(dsl);
                    } else {
                        if (typeof dsl === 'function') dsl(done, obj);
                        else eval(dsl);
                    }
                } catch (e) {
                    OBJY.Logger.error(e);
                }
                //if (done) done();
            }
        },
    });
};