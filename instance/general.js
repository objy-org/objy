/*var shortid = require('shortid');
var exceptions = require('../lib/dependencies/exceptions.js');*/

import shortid from 'shortid';
import exceptions from '../lib/dependencies/exceptions.js';

export default function(OBJY) {
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
            if (!client) throw new exceptions.General("No client specified");
            OBJY.globalCtx.activeTenant = client
            return this;
        },

        /**
         * Sets user context
         * @param {user} - the user object
         * @returns {this}
         */
        useUser: function(user) {
            OBJY.globalCtx.activeUser = user
            return this;
        },

        /**
         * Sets app context
         * @param {app} - the app identifier
         * @returns {this}
         */
        app: function(app) {
            //if (!app) throw new Error("No app specified");
            OBJY.globalCtx.activeApp = app

            return this;
        },

        getPropsObject: function(obj, params) {
            
            return obj;
        },

        serializePropsObject: function(realObj, obj, propsObject, context, params) {
            /*
            if (!obj.hasOwnProperty(propsObject)) return;
            Object.keys(obj[propsObject]).forEach(p => {
                if (!OBJY.predefinedProperties.includes(p) && realObj.hasOwnProperty('role')) {
                    var prop = {};
                    prop[p] = obj[propsObject][p]
                    realObj[p] =  obj[propsObject][p]
                    //new OBJY.PropertyCreateWrapper(realObj, prop, false, context, params);
                }
            })
            delete obj[propsObject];*/
        },

        deSerializePropsObject: function(obj, params) {
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
         * @param {context} - the OBJY context
         * @param {key} - the command name
         * @param {value} - the command value (parameter)
         */
        chainCommand: function(obj, context, key, value) {
            context.commandSequence.push({
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
            let processorApp = this.context?.activeApp || (obj.applications || {})[0]
            OBJY.Logger.log('triggering dsl');
            this.processors[obj.role].execute(dsl, obj, prop, data, callback, client, processorApp, this.context?.activeUser, options);
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


        checkConstraints: function(obj, operation) {

            var self = this;
            var _return = true;
            var messages = [];
            if (!obj['_constraints']) return false;
            obj._constraints.forEach(c => {
                if (obj[c.key]) {
                    if (typeof c.validate === 'function') {
                        var res = c.validate(obj[c.key]);
                        if (!res) messages.push(c.key)
                    }
                } else if (c.key.indexOf('.') != -1) {
                    function getValue(_obj, access) {
                        
                        if (typeof(access) == 'string') {
                            access = access.split('.');
                        }
                        if (access.length > 1) {
                            getValue(_obj[access.shift()], access);
                        } else if(_obj){

                            propertyToReturn = _obj[access[0]];

                            if (typeof c.validate === 'function') {
                                var res = c.validate(propertyToReturn);
                                if (!res && !messages.includes(c.key)) messages.push(c.key)
                            }
                        }
                    }
                    getValue(obj, c.key);
                }
            })
            if (!messages.length) return true;
            else return messages
        }

    }
}