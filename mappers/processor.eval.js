Mapper = function(OBJY, mapperOptions) {
    return Object.assign(new OBJY.ProcessorTemplate(OBJY), {

        execute: function(dsl, obj, prop, data, callback, client, app, user, options) {

            OBJY.Logger.log("Executing dsl in mapper")

            try {
        
                if ((mapperOptions || {}).hasOwnProperty('parse')) { 
                    mapperOptions.parse(dsl);
                    return callback();
                } else if(typeof dsl === 'function'){
                    dsl();
                } else eval(dsl);
                
                callback();

             } catch (e) {
                OBJY.Logger.error(e)
            }
        }
    })
}

module.exports = Mapper;