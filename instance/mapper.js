var exceptions = require('../lib/dependencies/exceptions.js');

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

            if (!this.mappers[family]) throw new exceptions.General("No such Object Family");
            return this.mappers[family];
        },

        /**
         * Returns the persistence mapper attached to the specified object family
         * @returns {mapper} the mapper instance
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
         * @returns {mapper} the mapper instance
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

            if (Array.isArray(this.processors[name])) {
                this.processors[name].forEach(mapper => {
                    mapper.setObjectFamily(name);
                })
            } else this.processors[name].setObjectFamily(name);
        },

        getObserver: function(family) {
            if (!this.observers[family]) throw new exceptions.General("No such Object Family");
            return this.observers[family];
        },

        plugInObserver: function(name, observer) {
            if (!name) throw new exceptions.General("No mapper name provided");
            this.observers[name] = observer;
            
            if (Array.isArray(this.observers[name])) {
                this.observers[name].forEach(mapper => {
                    mapper.setObjectFamily(name);
                })
            } else this.observers[name].setObjectFamily(name);
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


        remove: function(obj, success, error, app, client, params, instance) {

            this.removeObject(obj, success, error, app, client, params, instance);

        },

        removeObject: function(obj, success, error, app, client, params, instance) {

            var self = this;


            if (Array.isArray(self.mappers[role])) {

                var idx = 0;
                var len = self.mappers[role].length;
                var sequence = [];

                function commit(idx) {

                    this.mappers[obj.role][idx].remove(obj, function(data) {

                    sequence.push(data);
                    ++idx;
                    if (chainOperation == 'break' || idx == len) return success(data);
                    else if(!chainOperation) commit(idx, data)

                }, function(err) {
                    error(err);
                }, app, client, params, instance);

                   
                }

                commit(idx);

            } else {

                this.mappers[obj.role].remove(obj, function(data) {

                    success(data);

                }, function(err) {
                    error(err);
                }, app, client, params, instance);

            }
        },

        add: function(obj, success, error, app, client, params, instance) {

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

            this.addObject(obj, success, error, app, client, params, instance);

        },

        addObject: function(obj, success, error, app, client, params, instance) {
            var self = this;
            // OBJY.deSerializePropsObject(obj, params)

            if (Array.isArray(self.mappers[obj.role])) {

                var idx = 0;
                var len = self.mappers[obj.role].length;
                var sequence = [];

                function commit(idx) {
                    self.mappers[obj.role][idx].add(obj, function(data, chainOperation) {
                        sequence.push(data);
                        ++idx;
                        if (chainOperation == 'break' || idx == len) return success(data);
                        else if(!chainOperation) commit(idx)

                    }, function(err) {
                        error(err);
                    }, app, client, sequence[idx - 1], instance);
                }

                commit(idx);

                /*this.mappers[obj.role].forEach(mapper => {

                })*/
            } else {
                self.mappers[obj.role].add(obj, function(data, chainOperation) {

                    success(data);

                }, function(err) {
                    error(err);
                }, app, client, params, instance);
            }

        },

        updateO: function(obj, success, error, app, client, params, instance) {

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

                            thisRef.updateObject(obj, success, error, app, client, params, instance);
                            return obj;
                        }, client, params, instance)
                } else {
                    if (obj.inherits.length == 1) {
                        thisRef.updateObject(obj, success, error, app, client, params, instance);
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

        updateObject: function(obj, success, error, app, client, params, instance) {

            if (Array.isArray(self.mappers[role])) {

                var idx = 0;
                var len = self.mappers[role].length;
                var sequence = [];

                function commit(idx) {

                    this.mappers[obj.role][idx].update(obj, function(data, chainOperation) {


                        sequence.push(data);
                        ++idx;
                        if (chainOperation == 'break' || idx == len) return success(data);
                        else if(!chainOperation) commit(idx)

                    }, function(err) {
                        error(err);
                    }, app, client, params, instance);

                }

                commit(idx);

            } else {

                this.mappers[obj.role].update(obj, function(data) {
                    success(data);
                }, function(err) {
                    error(err);
                }, app, client, params, instance);
            }
        },

        getObjectById: function(role, id, success, error, app, client, instance, params) {
            var self = this;


            if (Array.isArray(self.mappers[role])) {

                var idx = 0;
                var len = self.mappers[role].length;
                var sequence = [];

                function commit(idx) {


                    self.mappers[role][idx].getById(id, function(data, chainOperation) {

                        /*if (data == null) {
                            error('Error - object not found: ' + id);
                            return;
                        }*/

                        sequence.push(data);
                        ++idx;
                        if (chainOperation == 'break' || idx == len) return success(data);
                        else if(!chainOperation) commit(idx)


                    }, function(err) {
                        error('Error - Could get object: ' + err);
                    }, app, client, params, instance);


                }

                commit(idx);

            } else {
                self.mappers[role].getById(id, function(data) {

                    if (data == null) {
                        error('Error - object not found: ' + id);
                        return;
                    }

                    success(data);

                }, function(err) {
                    error('Error - Could get object: ' + err);
                }, app, client, params, instance);
            }

            
        },

        findObjects: function(criteria, role, success, error, app, client, flags, params, instance) {

            var self = this;

            if (Array.isArray(self.mappers[role])) {

                var idx = 0;
                var len = self.mappers[role].length;
                var sequence = [];

                function commit(idx) {

                    self.mappers[role][idx].getByCriteria(criteria, function(data, chainOperation) {
                        var counter = 0;
                        var num = data.length;
                        if (num == 0) return success([]);

                        sequence.push(data);
                        ++idx;
                        if (chainOperation == 'break' || idx == len) return success(data);
                        else if(!chainOperation) commit(idx)

                    }, function(err) {
                        error('Error - Could get object: ' + err);
                    }, app, client, flags, params, instance);

                }

                commit(idx);

            } else {

                self.mappers[role].getByCriteria(criteria, function(data) {
                    var counter = 0;
                    var num = data.length;
                    if (num == 0) return success([]);

                    success(data);

                }, function(err) {
                    error('Error - Could get object: ' + err);
                }, app, client, flags, params, instance);
            }
        },

        countObjects: function(criteria, role, success, error, app, client, flags, params, instance) {

            var templatesCache = [];
            var objectsCache = [];

            this.mappers[role].count(criteria, function(data) {
                var counter = 0;
                var num = data.length;
                if (num == 0) success([]);

                success(data);

            }, function(err) {
                error('Error - Could get object: ' + err);
            }, app, client, flags, params, instance);
        },

        findAllObjects: function(role, criteria, success, error, client, flags, params, instance) {
            this.findObjects(role, criteria, success, error, client, flags, params, instance);
        },
    }
}