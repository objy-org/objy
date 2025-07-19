//var exceptions = require('../lib/dependencies/exceptions.js');

import exceptions from '../lib/dependencies/exceptions.js';

var isObject = function(a) {
    return (!!a) && (a.constructor === Object);
};

export default function(OBJY) {
    return {

        customStorage: function(data, options) {
            return Object.assign(new OBJY.StorageTemplate(OBJY, options), data)
        },

        customProcessor: function(data, options) {
            return Object.assign(new OBJY.ProcessorTemplate(OBJY, options), data)
        },

        customObserver: function(data, options) {
            return Object.assign(new OBJY.ObserverTemplate(OBJY, options), data)
        },

        /**
         * Returns the persistence mapper attached to the specified object family
         * @returns {mapper} the mapper context
         */
        getPersistenceMapper: function(family) {

            if (!this.mappers[family]) throw new exceptions.General("No such Object Family");
            return this.mappers[family];
        },

        /**
         * Returns the persistence mapper attached to the specified object family
         * @returns {mapper} the mapper context
         */
        getPersistence: function(family) {
            if (!this.mappers[family]) throw new exceptions.General("No such Object Family: " + family);
            return this.mappers[family];
        },

        /**
         * Attaches a persistence mapper to an object family
         */
        plugInPersistenceMapper: function(name, mapper) {
            if (!name) throw new exceptions.General("No mapper name provided");
            this.mappers[name] = mapper;

            if (Array.isArray(this.mappers[name])) {
                this.mappers[name].forEach(mapper => {
                    mapper.setObjectFamily(name);
                })
            } else this.mappers[name].setObjectFamily(name);

            this.caches[name] = {
                data: {},
                add: function(k, v) {
                    if (Object.keys(this.data).length >= 50) delete this.data[Object.keys(this.data).length];
                    this.data[k] = v;
                    //console.info('adding to cache', this.data)
                },
                get: function(k) {
                    return this.data[k];
                }
            };
        },

        /**
         * Returns the processor mapper attached to the specified object family
         * @returns {mapper} the mapper context
         */
        getProcessor: function(family) {
            if (!this.processors[family]) throw new exceptions.General("No such Object Family");
            return this.processors[family];
        },


        /**
         * Attaches a processor mapper to an object family
         */
        plugInProcessor: function(name, processor) {
            if (!name) throw new exceptions.General("No mapper name provided");
            this.processors[name] = processor;
            this.processors[name].setObjectFamily(name);
        },

        getObserver: function(family) {
            if (!this.observers[family]) throw new exceptions.General("No such Object Family");
            return this.observers[family];
        },

        plugInObserver: function(name, observer) {
            if (!name) throw new exceptions.General("No mapper name provided");
            this.observers[name] = observer;
            this.observers[name].setObjectFamily(name);
        },

        instantStorage: function(obj) {
            return Object.assign(new StorageTemplate(this), obj);
        },

        instantObserver: function(obj) {
            return Object.assign(new ObserverTemplate(this), obj);
        },

        instantProcessor: function(obj) {
            return Object.assign(new ProcessorTemplate(), obj);
        },


        remove: function(obj, success, error, app, client, params, context) {

            this.removeObject(obj, success, error, app, client, params, context);

        },

        removeObject: function(obj, success, error, app, client, params, context) {

            var self = this;

            this.mappers[obj.role].remove(obj, function(data) {

                success(data);

            }, function(err) {
                error(err);
            }, app, client, params, context);
        },

        add: function(obj, success, error, app, client, params, context) {

            if (obj) {

                var propKeys = Object.keys(obj);

                propKeys.forEach(function(property) {
                    if (!isObject(property)) return;

                    if (property.template) property = null;

                    if (property.type == CONSTANTS.PROPERTY.TYPE_SHORTID) {
                        if (property.value == '' && !property.value)
                            property.value = OBJY.RANDOM();
                    }

                })

            }

            this.addObject(obj, success, error, app, client, params, context);

        },

        addObject: function(obj, success, error, app, client, params, context) {

            // OBJY.deSerializePropsObject(obj, params)

            if (Array.isArray(this.mappers[obj.role])) {

                var idx = 0;
                var len = this.mappers[obj.role].length;
                var sequence = [];

                function commit(idx) {
                    this.mappers[obj.role][idx].add(obj, function(data) {
                        sequence.push(obj);
                        ++idx;
                        if (idx == len) return success(data);
                        commit(idx)

                    }, function(err) {
                        error(err);
                    }, app, client, sequence[idx - 1], context);
                }

                commit(idx);

                this.mappers[obj.role].forEach(mapper => {

                })
            } else {
                this.mappers[obj.role].add(obj, function(data) {
                    success(data);

                }, function(err) {
                    error(err);
                }, app, client, params, context);
            }

        },

        updateO: function(obj, success, error, app, client, params, context) {

            var thisRef = this;

            if ((obj.inherits || []).length == 0) thisRef.updateObject(obj, success, error, app, client, params);

            var counter = 0;
            (obj.inherits || []).forEach(function(template) {

                if (obj._id != template) {

                    OBJY.removeTemplateFieldsForObject(obj, template, function() {
                            counter++;
                            if (counter == obj.inherits.length) {

                                thisRef.updateObject(obj, success, error, app, client, params);

                                return obj;
                            }
                        },
                        function(err) {

                            thisRef.updateObject(obj, success, error, app, client, params, context);
                            return obj;
                        }, client, params, context)
                } else {
                    if (obj.inherits.length == 1) {
                        thisRef.updateObject(obj, success, error, app, client, params, context);
                        return obj;
                    } else {
                        counter++;
                        return;
                    }
                }
            });

            return;

            // ADD TENANT AND APPLICATION!!!
        },

        updateObject: function(obj, success, error, app, client, params, context) {

            this.mappers[obj.role].update(obj, function(data) {
                success(data);
            }, function(err) {
                error(err);
            }, app, client, params, context);
        },

        getObjectById: function(role, id, success, error, app, client, context, params) {

            this.mappers[role].getById(id, function(data) {

                if (data == null) {
                    error('Error - object not found: ' + id);
                    return;
                }


                success(data);

                /*OBJY[data.role](data).get(function(ob){
                    success(ob);
                }, function(err){

                },client)*/


            }, function(err) {
                error('Error - Could get object: ' + err);
            }, app, client, params, context);
        },

        findObjects: function(criteria, role, success, error, app, client, flags, params, context) {

            var templatesCache = [];
            var objectsCache = [];

            this.mappers[role].getByCriteria(criteria, function(data) {
                var counter = 0;
                var num = data.length;
                if (num == 0) return success([]);

                success(data);


                /* data.forEach(function(obj, i) {
                     counter++;
                     if (counter == data.length) success(data);
                     OBJY[obj.role](obj).get(function(ob) {
                             counter++;
                             data[i] = ob
                             if (counter == data.length) success(data);
                         },
                         function(err) {
                             error(err);
                         }, client);
                 })*/


            }, function(err) {
                error('Error - Could get object: ' + err);
            }, app, client, flags, params, context);
        },

        countObjects: function(criteria, role, success, error, app, client, flags, params, context) {

            var templatesCache = [];
            var objectsCache = [];

            this.mappers[role].count(criteria, function(data) {
                var counter = 0;
                var num = data.length;
                if (num == 0) success([]);

                success(data);

            }, function(err) {
                error('Error - Could get object: ' + err);
            }, app, client, flags, params, context);
        },

        findAllObjects: function(role, criteria, success, error, client, flags, params, context) {
            this.findObjects(role, criteria, success, error, client, flags, params, context);
        },
    }
}