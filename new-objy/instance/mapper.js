import exceptions from '../lib/dependencies/exceptions.js';

var isObject = function (a) {
    return !!a && a.constructor === Object;
};

export default function (OBJY) {
    return {
        customStorage: function (data, options) {
            return Object.assign(new OBJY.StorageTemplate(OBJY, options), data);
        },

        customProcessor: function (data, options) {
            return Object.assign(new OBJY.ProcessorTemplate(OBJY, options), data);
        },

        customObserver: function (data, options) {
            return Object.assign(new OBJY.ObserverTemplate(OBJY, options), data);
        },

        /**
         * Returns the persistence mapper attached to the specified object family
         * @returns {mapper} the mapper instance
         */
        getPersistenceMapper: function (family) {
            if (!this.instance.mappers[family]) throw new exceptions.General('No such Object Family');
            return this.instance.mappers[family];
        },

        /**
         * Returns the persistence mapper attached to the specified object family
         * @returns {mapper} the mapper instance
         */
        getPersistence: function (family) {
            if (!this.instance.mappers[family]) throw new exceptions.General('No such Object Family: ' + family);
            return this.instance.mappers[family];
        },

        /**
         * Attaches a persistence mapper to an object family
         */
        plugInPersistenceMapper: function (name, mapper) {
            if (!name) throw new exceptions.General('No mapper name provided');
            this.instance.mappers[name] = mapper;

            if (Array.isArray(this.instance.mappers[name])) {
                this.instance.mappers[name].forEach((mapper) => {
                    mapper.setObjectFamily(name);
                });
            } else this.instance.mappers[name].setObjectFamily(name);

            // TODO-NEW What is this.data
            this.instance.caches[name] = {
                data: {},
                add: function (k, v) {
                    if (Object.keys(this.data).length >= 50) delete this.data[Object.keys(this.data).length];
                    this.data[k] = v;
                    //console.info('adding to cache', this.data)
                },
                get: function (k) {
                    return this.data[k];
                },
            };
        },

        /**
         * Returns the processor mapper attached to the specified object family
         * @returns {mapper} the mapper instance
         */
        getProcessor: function (family) {
            if (!this.instance.processors[family]) throw new exceptions.General('No such Object Family');
            return this.instance.processors[family];
        },

        /**
         * Attaches a processor mapper to an object family
         */
        plugInProcessor: function (name, processor) {
            if (!name) throw new exceptions.General('No mapper name provided');
            this.instance.processors[name] = processor;
            this.instance.processors[name].setObjectFamily(name);
        },

        getObserver: function (family) {
            if (!this.instance.observers[family]) throw new exceptions.General('No such Object Family');
            return this.instance.observers[family];
        },

        plugInObserver: function (name, observer) {
            if (!name) throw new exceptions.General('No mapper name provided');
            this.instance.observers[name] = observer;
            this.instance.observers[name].setObjectFamily(name);
        },

        // TODO-NEW Is this as param still needed?
        instantStorage: function (obj) {
            return Object.assign(new StorageTemplate(this), obj);
        },

        instantObserver: function (obj) {
            return Object.assign(new ObserverTemplate(this), obj);
        },

        instantProcessor: function (obj) {
            return Object.assign(new ProcessorTemplate(), obj);
        },

        remove: function (obj, success, error, app, client, params, instance) {
            this.removeObject(obj, success, error, app, client, params, instance);
        },

        removeObject: function (obj, success, error, app, client, params, instance) {
            this.instance.mappers[obj.role].remove(
                obj,
                function (data) {
                    success(data);
                },
                function (err) {
                    error(err);
                },
                app,
                client,
                params,
                instance
            );
        },

        add: function (obj, success, error, app, client, params, instance) {
            if (obj) {
                var propKeys = Object.keys(obj);

                propKeys.forEach(function (property) {
                    if (!isObject(property)) return;

                    if (property.template) property = null;

                    if (property.type == CONSTANTS.PROPERTY.TYPE_SHORTID) {
                        if (property.value == '' && !property.value) property.value = OBJY.RANDOM();
                    }
                });
            }

            this.addObject(obj, success, error, app, client, params, instance);
        },

        addObject: function (obj, success, error, app, client, params, instance) {
            // OBJY.deSerializePropsObject(obj, params)

            if (Array.isArray(this.instance.mappers[obj.role])) {
                var idx = 0;
                var len = this.instance.mappers[obj.role].length;
                var sequence = [];

                function commit(idx) {
                    this.instance.mappers[obj.role][idx].add(
                        obj,
                        function (data) {
                            sequence.push(obj);
                            ++idx;
                            if (idx == len) return success(data);
                            commit(idx);
                        },
                        function (err) {
                            error(err);
                        },
                        app,
                        client,
                        sequence[idx - 1],
                        instance
                    );
                }

                commit(idx);

                this.instance.mappers[obj.role].forEach((mapper) => {});
            } else {
                this.instance.mappers[obj.role].add(
                    obj,
                    function (data) {
                        success(data);
                    },
                    function (err) {
                        error(err);
                    },
                    app,
                    client,
                    params,
                    instance
                );
            }
        },

        updateO: function (obj, success, error, app, client, params, instance) {
            if ((obj.inherits || []).length == 0) this.updateObject(obj, success, error, app, client, params);

            var counter = 0;
            (obj.inherits || []).forEach((template) => {
                if (obj._id != template) {
                    OBJY.removeTemplateFieldsForObject(
                        obj,
                        template,
                        () => {
                            counter++;
                            if (counter == obj.inherits.length) {
                                this.updateObject(obj, success, error, app, client, params);

                                return obj;
                            }
                        },
                        (err) => {
                            this.updateObject(obj, success, error, app, client, params, instance);
                            return obj;
                        },
                        client,
                        params,
                        instance
                    );
                } else {
                    if (obj.inherits.length == 1) {
                        this.updateObject(obj, success, error, app, client, params, instance);
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

        updateObject: function (obj, success, error, app, client, params, instance) {
            this.instance.mappers[obj.role].update(
                obj,
                function (data) {
                    success(data);
                },
                function (err) {
                    error(err);
                },
                app,
                client,
                params,
                instance
            );
        },

        getObjectById: function (role, id, success, error, app, client, instance, params) {
            this.instance.mappers[role].getById(
                id,
                function (data) {
                    if (data == null) {
                        error('Error - object not found: ' + id);
                        return;
                    }

                    success(data);

                    /*OBJY[data.role](data).get(function(ob){
                    success(ob);
                }, function(err){

                },client)*/
                },
                function (err) {
                    error('Error - Could get object: ' + err);
                },
                app,
                client,
                params,
                instance
            );
        },

        findObjects: function (criteria, role, success, error, app, client, flags, params, instance) {
            var templatesCache = [];
            var objectsCache = [];

            this.instance.mappers[role].getByCriteria(
                criteria,
                function (data) {
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
                },
                function (err) {
                    error('Error - Could get object: ' + err);
                },
                app,
                client,
                flags,
                params,
                instance
            );
        },

        countObjects: function (criteria, role, success, error, app, client, flags, params, instance) {
            var templatesCache = [];
            var objectsCache = [];

            this.instance.mappers[role].count(
                criteria,
                function (data) {
                    var counter = 0;
                    var num = data.length;
                    if (num == 0) success([]);

                    success(data);
                },
                function (err) {
                    error('Error - Could get object: ' + err);
                },
                app,
                client,
                flags,
                params,
                instance
            );
        },

        findAllObjects: function (role, criteria, success, error, client, flags, params, instance) {
            this.findObjects(role, criteria, success, error, client, flags, params, instance);
        },
    };
}
