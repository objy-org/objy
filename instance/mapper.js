var isObject = function(a) {
    return (!!a) && (a.constructor === Object);
};

module.exports = function(OBJY) {
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
         * @returns {mapper} the mapper instance
         */
        getPersistenceMapper: function(family) {

            if (!this.mappers[family]) throw new Error("No such Object Family");
            return this.mappers[family];
        },

        /**
         * Returns the persistence mapper attached to the specified object family
         * @returns {mapper} the mapper instance
         */
        getPersistence: function(family) {
            if (!this.mappers[family]) throw new Error("No such Object Family: " + family);
            return this.mappers[family];
        },

        /**
         * Attaches a persistence mapper to an object family
         */
        plugInPersistenceMapper: function(name, mapper) {
            if (!name) throw new Error("No mapper name provided");
            this.mappers[name] = mapper;
            this.mappers[name].setObjectFamily(name);

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
         * @returns {mapper} the mapper instance
         */
        getProcessor: function(family) {
            if (!this.processors[family]) throw new Error("No such Object Family");
            return this.processors[family];
        },


        /**
         * Attaches a processor mapper to an object family
         */
        plugInProcessor: function(name, processor) {
            if (!name) throw new Error("No mapper name provided");
            this.processors[name] = processor;
            this.processors[name].setObjectFamily(name);
        },

        getObserver: function(family) {
            if (!this.observers[family]) throw new Error("No such Object Family");
            return this.observers[family];
        },

        plugInObserver: function(name, observer) {
            if (!name) throw new Error("No mapper name provided");
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


        remove: function(obj, success, error, app, client) {

            this.removeObject(obj, success, error, app, client);

        },

        removeObject: function(obj, success, error, app, client) {

            var self = this;

            this.mappers[obj.role].remove(obj, function(data) {

                success(data);

            }, function(err) {
                error(err);
            }, app, client);
        },

        add: function(obj, success, error, app, client, params) {

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

            this.addObject(obj, success, error, app, client, params);

        },

        addObject: function(obj, success, error, app, client, params) {

            // OBJY.deSerializePropsObject(obj, params)
            this.mappers[obj.role].add(obj, function(data) {
                success(data);

            }, function(err) {
                error(err);
            }, app, client);

        },

        updateO: function(obj, success, error, app, client, params) {

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

                            thisRef.updateObject(obj, success, error, app, client, params);
                            return obj;
                        }, client)
                } else {
                    if (obj.inherits.length == 1) {
                        thisRef.updateObject(obj, success, error, app, client, params);
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

        updateObject: function(obj, success, error, app, client, params) {

            this.mappers[obj.role].update(obj, function(data) {
                success(data);
            }, function(err) {
                error(err);
            }, app, client);
        },

        getObjectById: function(role, id, success, error, app, client, instance, params) {

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
            }, app, client);
        },

        findObjects: function(criteria, role, success, error, app, client, flags) {

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
            }, app, client, flags);
        },

        countObjects: function(criteria, role, success, error, app, client, flags) {

            var templatesCache = [];
            var objectsCache = [];

            this.mappers[role].count(criteria, function(data) {
                var counter = 0;
                var num = data.length;
                if (num == 0) success([]);

                success(data);

            }, function(err) {
                error('Error - Could get object: ' + err);
            }, app, client, flags);
        },

        findAllObjects: function(role, criteria, success, error, client, flags) {
            this.findObjects(role, criteria, success, error, client, flags, true);
        },
    }
}