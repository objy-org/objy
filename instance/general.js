var shortid = require('shortid');

module.exports = function(OBJY) {
    return {
        /**
         * Serialises an object into the objy structure (comming soon)
         * @param {obj} - object
         * @returns {this}
         */
        serialize: function(obj) {
            return obj;
        },

        /**
         * Deserialises an object from the objy structure (comming soon)
         * @param {obj} - object
         * @returns {this}
         */
        deserialize: function(obj) {
            /*if(obj.hasOwnProperty('onCreate')){
                Object.keys(obj.onCreate).forEach(h => {
                   if(obj.onCreate[h].hidden) delete obj.onCreate[h]
                })
            }*/
            return obj;
        },

        /**
         * Sets client (workspace) context (deprecated)
         * @param {tenant} - the tenant identifier
         * @returns {this}
         */
        tenant: function(client) {
            return this.client(client);
        },

        /**
         * Sets client (workspace) context
         * @param {client} - the tenant identifier
         * @returns {this}
         */
        client: function(client) {
            if (!client) throw new Error("No client specified");
            this.activeTenant = client;
            return this;
        },

        /**
         * Sets user context
         * @param {user} - the user object
         * @returns {this}
         */
        useUser: function(user) {
            this.activeUser = user;
            return this;
        },

        /**
         * Sets app context
         * @param {app} - the app identifier
         * @returns {this}
         */
        app: function(app) {
            //if (!app) throw new Error("No app specified");
            this.activeApp = app;

            return this;
        },

        getPropsObject: function(obj, params){
            if(obj.hasOwnProperty('role'))
                if(params.hasOwnProperty('propsObject'))
                    if(!obj.hasOwnProperty(params.propsObject))
                        obj[params.propsObject] = {};

            return obj[params.propsObject] || obj;
        },

        serializePropsObject: function(realObj, obj, propsObject, instance, params) {
            /*
            if (!obj.hasOwnProperty(propsObject)) return;
            Object.keys(obj[propsObject]).forEach(p => {
                if (!OBJY.predefinedProperties.includes(p) && realObj.hasOwnProperty('role')) {
                    var prop = {};
                    prop[p] = obj[propsObject][p]
                    realObj[p] =  obj[propsObject][p]
                    //new OBJY.PropertyCreateWrapper(realObj, prop, false, instance, params);
                }
            })
            delete obj[propsObject];*/
        },

        deSerializePropsObject: function(obj, params) {
            return obj;

            if (!params.propsObject) return obj;
            if (!obj.hasOwnProperty(params.propsObject)) obj[params.propsObject] = {};
            Object.keys(obj).forEach(p => {
                if (!OBJY.predefinedProperties.includes(p) && typeof obj[p] !== 'function') {
                    console.log('---', p)
                    obj[params.propsObject][p] = obj[p];
                    delete obj[p];
                }
            })
            return obj;
        },

        deSerializePropsObjectMulti: function(objs, params) {
            /*if (!params.propsObject) return objs;
            
            objs.forEach(obj => {
                OBJY.deSerializePropsObject(obj, params)
            })*/

            return objs;
        },

        /**
         * Chains command information, when performing multiple operations
         * @param {obj} - the object
         * @param {instance} - the OBJY instance
         * @param {key} - the command name
         * @param {value} - the command value (parameter)
         */
        chainCommand: function(obj, instance, key, value) {
            instance.commandSequence.push({
                name: key,
                value: value
            });
        },


        ConditionsChecker: function(property, value) {

            if (property.hasOwnProperty('conditions')) {

                // TODO
            }
        },

        execProcessorAction: function(dsl, obj, prop, data, callback, client, options) {
            OBJY.Logger.log("triggering dsl")
            this.processors[obj.role].execute(dsl, obj, prop, data, callback, client, this.instance.activeUser, options);
        },


        ID: function() {
            var text = "";
            var possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789,;-_"; // NO DOT!!! 

            for (var i = 0; i < 25; i++)
                text += possible.charAt(Math.floor(Math.random() * possible.length));

            return text;
        },

        RANDOM: function(amount) {
            return shortid.generate();
        },


    }
}