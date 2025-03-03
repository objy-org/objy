import moment from 'moment';

function generalAttributes (OBJY) {
    return {
        // @TODO make this better!
        predefinedProperties: [
            '_aggregatedEvents',
            'authorisations',
            '_id',
            'role',
            'applications',
            'inherits',
            'onCreate',
            'onChange',
            'onDelete',
            'permissions',
            'privileges',
            'created',
            'lastModified',
        ],

        metaPropPrefix: '',

        activeTenant: null,

        activeUser: null,

        activeApp: null,

        objectFamilies: [],

        affectables: [],

        staticRules: [],

        mappers: {},

        caches: {},

        ignorePermissions: false,
        ignoreAuthorisations: false,

        handlerSequence: [],
        permissionSequence: [],
        alterSequence: [],
        commandSequence: [],
        eventAlterationSequence: [],

        storage: null,
        processor: null,
        observer: null,

        processors: {},
        observers: {},
    };
}

const exceptions = {
    NoOnChangeException: function (message) {
        this.message = 'onChange not found';
        this.name = 'NoOnChangeException';
    },

    General: function (message) {
        this.message = message;
        this.name = 'Exception';
    },

    NoMetaException: function (message) {
        this.message = 'meta not found';
        this.name = 'NoMetaException';
    },

    NoOnDeleteException: function (message) {
        this.message = 'onDelete not found';
        this.name = 'NoOnDeleteException';
    },

    NoEventIdException: function (message) {
        this.message = 'No Event ID provided';
        this.name = 'NoEventIdException';
    },

    InvalidTypeException: function (message) {
        this.message = message + ' is not a valid type';
        this.name = 'InvalidTypeException';
    },

    InvalidValueException: function (value, type) {
        this.message = value + ' is not valid. Type must be: ' + type;
        this.name = 'InvalidValueException';
    },

    InvalidFormatException: function () {
        this.message = 'Invlid format';
        this.name = 'InvalidFormatException';
    },

    DuplicatePropertyException: function (message) {
        this.message = 'Property ' + message + ' already exists in this object';
        this.name = 'DuplicatePropertyException';
    },

    DuplicateActionException: function (message) {
        this.message = 'Action ' + message + ' already exists in this object';
        this.name = 'DuplicateActionException';
    },

    DuplicateApplicationException: function (message) {
        this.message = 'Application ' + message + ' already exists in this object';
        this.name = 'DuplicateApplicationException';
    },

    NoSuchApplicationException: function (message) {
        this.message = 'Application ' + message + ' does not exist in this object';
        this.name = 'NoSuchApplicationException';
    },

    NoSuchReminderException: function (message) {
        this.message = 'Reminder ' + message + ' does not exist in this event';
        this.name = 'NoSuchReminderException';
    },

    DuplicateEventException: function (message) {
        this.message = 'Event ' + message + ' already exists in this object';
        this.name = 'DuplicateEventException';
    },

    NoSuchTemplateException: function (message) {
        this.message = 'Template id ' + message + ' does not exist';
        this.name = 'NoSuchTemplateException';
    },

    NotAnEventException: function (message) {
        this.message = 'Property ' + message + ' is not an event';
        this.name = 'NotAnEventException';
    },

    NoSuchObjectException: function (message) {
        this.message = 'Object id ' + message + ' does not exist';
        this.name = 'NoSuchObjectException';
    },

    NoSuchPropertyException: function (message) {
        this.message = 'Property ' + message + ' does not exist in this object';
        this.name = 'NoSuchPropertyException';
    },

    NoSuchEventException: function (message) {
        this.message = 'Event ' + message + ' does not exist in this object';
        this.name = 'NoSuchEventException';
    },

    PropertyNotFoundException: function (message) {
        this.message = 'Property ' + message + ' does not exist in this object';
        this.name = 'PropertyNotFoundException';
    },

    MissingAttributeException: function (message) {
        this.message = 'Missing attibute ' + message + ' in this object';
        this.name = 'MissingAttributeException';
    },

    CallbackErrorException: function (message) {
        this.message = message;
        this.name = 'CallbackErrorException';
    },

    InvalidDateException: function (message) {
        this.message = message + ' is not a valid date';
        this.name = 'InvalidDateException';
    },

    InvalidActionException: function (message) {
        this.message = message + ' is not a valid event action';
        this.name = 'InvalidActionException';
    },

    InvalidDataTypeException: function (message, type) {
        this.message = message + ' is not of type ' + type;
        this.name = 'InvalidDataTypeException';
    },

    NotATemplateExteptopn: function (message) {
        this.message = message + ' is not a template';
        this.name = 'NotATemplateExteptopn';
    },

    InvalidPrivilegeException: function (message) {
        this.message = 'Invalid privileges format';
        this.name = 'InvalidPrivilegeException';
    },

    NoSuchPrivilegeException: function (message) {
        this.message = 'Privilege does not exist';
        this.name = 'NoSuchPrivilegeException';
    },

    NoSuchPermissionException: function (message) {
        this.message = 'Permission ' + message + ' does not exist';
        this.name = 'NoSuchPermissionException';
    },

    InvalidPermissionException: function (message) {
        this.message = 'Permission format invalid';
        this.name = 'InvalidPermissionException';
    },

    InvalidEventIdException: function (message) {
        this.message = 'Event ID format not valid: ' + message;
        this.name = 'InvalidEventIdException';
    },

    NoHandlerProvidedException: function (message) {
        this.message = 'No handler provided ' + message;
        this.name = 'NoHandlerProvidedException';
    },

    HandlerExistsException: function (message) {
        this.message = 'Handler ' + message + ' already exists';
        this.name = 'HandlerExistsException';
    },

    HandlerNotFoundException: function (message) {
        this.message = 'Handler ' + message + ' not found';
        this.name = 'HandlerNotFoundException';
    },

    InvalidArgumentException: function (message) {
        this.message = 'Invalid argument';
        this.name = 'InvalidArgumentException';
    },

    InvalidHandlerException: function (message) {
        this.message = 'Invalid handler';
        this.name = 'InvalidHandlerException';
    },

    LackOfPermissionsException: function (message) {
        if (Array.isArray(message)) {
            var result = 'No permissions to perform these operations: ';

            message.forEach(function (m) {
                result += '(' + m.name + ': ' + m.key + ') ';
            });

            this.message = result;
            this.name = 'LackOfPermissionsException';
        } else {
            this.message = 'No permissions to perform this operation';
            this.name = 'LackOfPermissionsException';
        }
    },
};

function generalFunctions (OBJY) {
    return {
        /**
         * Serialises an object into the objy structure (comming soon)
         * @param {obj} - object
         * @returns {this.instance}
         */
        serialize: function (obj) {
            return obj;
        },

        /**
         * Deserialises an object from the objy structure (comming soon)
         * @param {obj} - object
         * @returns {this.instance}
         */
        deserialize: function (obj) {
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
         * @returns {this.instance}
         */
        tenant: function (client) {
            return this.instance.client(client);
        },

        /**
         * Sets client (workspace) context
         * @param {client} - the tenant identifier
         * @returns {this}
         */
        client: function (client) {
            if (!client) throw new exceptions.General('No client specified');
            this.instance.activeTenant = client;
            return this;
        },

        /**
         * Sets user context
         * @param {user} - the user object
         * @returns {this}
         */
        useUser: function (user) {
            this.instance.activeUser = user;
            return this;
        },

        /**
         * Sets app context
         * @param {app} - the app identifier
         * @returns {this}
         */
        app: function (app) {
            //if (!app) throw new Error("No app specified");
            this.instance.activeApp = app;

            return this;
        },

        getPropsObject: function (obj, params) {
            return obj;
        },

        serializePropsObject: function (realObj, obj, propsObject, instance, params) {
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

        deSerializePropsObject: function (obj, params) {
            return obj;
        },

        deSerializePropsObjectMulti: function (objs, params) {
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
        chainCommand: function (obj, instance, key, value) {
            instance.commandSequence.push({
                name: key,
                value: value,
            });
        },

        ConditionsChecker: function (property, value) {
            if (property.hasOwnProperty('conditions')) ;
        },

        execProcessorAction: function (dsl, obj, prop, data, callback, client, options) {
            let processorApp = this.instance?.activeApp || (obj.applications || {})[0];
            OBJY.Logger.log('triggering dsl');
            this.processors[obj.role].execute(dsl, obj, prop, data, callback, client, processorApp, this.instance?.activeUser, options);
        },

        ID: function () {
            var text = '';
            var possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789,;-_'; // NO DOT!!!

            for (var i = 0; i < 25; i++) text += possible.charAt(Math.floor(Math.random() * possible.length));

            return text;
        },

        checkConstraints: function (obj, operation) {
            var messages = [];
            if (!obj['_constraints']) return false;
            obj._constraints.forEach((c) => {
                if (obj[c.key]) {
                    if (typeof c.validate === 'function') {
                        var res = c.validate(obj[c.key]);
                        if (!res) messages.push(c.key);
                    }
                } else if (c.key.indexOf('.') != -1) {
                    function getValue(_obj, access) {
                        if (typeof access == 'string') {
                            access = access.split('.');
                        }
                        if (access.length > 1) {
                            getValue(_obj[access.shift()], access);
                        } else if (_obj) {
                            propertyToReturn = _obj[access[0]];

                            if (typeof c.validate === 'function') {
                                var res = c.validate(propertyToReturn);
                                if (!res && !messages.includes(c.key)) messages.push(c.key);
                            }
                        }
                    }
                    getValue(obj, c.key);
                }
            });
            if (!messages.length) return true;
            else return messages;
        },
    };
}

var Query;
(function () {
    function objectify(a) {
        var rows = [];
        for (var key in a) {
            var o = {};
            o[key] = a[key];
            rows.push(o);
        }
        return rows;
    }
    if (!String.prototype.startsWith) {
        Object.defineProperty(String.prototype, 'startsWith', {
            enumerable: false,
            configurable: false,
            writable: false,
            value: function (searchString, position) {
                position = position || 0;
                return this.lastIndexOf(searchString, position) === position;
            },
        });
    }
    if (!String.prototype.endsWith) {
        Object.defineProperty(String.prototype, 'endsWith', {
            value: function (searchString, position) {
                var subjectString = this.toString();
                if (position === undefined || position > subjectString.length) {
                    position = subjectString.length;
                }
                position -= searchString.length;
                var lastIndex = subjectString.indexOf(searchString, position);
                return lastIndex !== -1 && lastIndex === position;
            },
        });
    }
    Query = {
        satisfies: function (row, constraints, getter) {
            return Query.lhs._rowsatisfies(row, constraints, getter);
        },
        Query: function (constraints, getter) {
            return function (row) {
                return Query.lhs._rowsatisfies(row, constraints, getter);
            };
        },
        join: function (left_rows, right_rows, left_key, right_key) {
            return left_rows;
        },
        query: function (rows, constraints, getter) {
            if (typeof getter == 'string') {
                var method = getter;
                getter = function (obj, key) {
                    return obj[method](key);
                };
            }
            var filter = new Query.Query(constraints, getter);
            return rows.filter(filter);
        },
        lhs: {
            _rowsatisfies: function (row, constraints, getter) {
                for (var key in constraints) {
                    if (this[key]) {
                        if (!this[key](row, constraints[key], getter)) return false;
                    } else {
                        var val = getter ? getter(row, key) : row[key];
                        var res = this.rhs._satisfies(val, constraints[key], key);
                        if (!res) return false;
                    }
                }
                return true;
            },
            $count: function (row, condition, getter) {
                var res = condition.$constraints
                    .map(function (c) {
                        return Query.satisfies(row, c, getter);
                    })
                    .filter(function (v) {
                        return v;
                    }).length;
                return this.rhs._satisfies(res, condition.$constraint);
            },
            $not: function (row, constraint, getter) {
                return !this._rowsatisfies(row, constraint, getter);
            },
            $or: function (row, constraint, getter) {
                if (!Array.isArray(constraint)) {
                    constraint = objectify(constraint);
                }
                for (var i = 0; i < constraint.length; i++) {
                    if (this._rowsatisfies(row, constraint[i], getter)) return true;
                }
                return false;
            },
            $and: function (row, constraint, getter) {
                if (!Array.isArray(constraint)) {
                    constraint = objectify(constraint);
                }
                for (var i = 0; i < constraint.length; i++) {
                    if (!this._rowsatisfies(row, constraint[i], getter)) return false;
                }
                return true;
            },
            $nor: function (row, constraint, getter) {
                return !this.$or(row, constraint, getter);
            },
            $where: function (values, ref) {
                var fn = typeof ref == 'string' ? new Function(ref) : ref;
                var res = fn.call(values);
                return res;
            },
            rhs: {
                $cb: function (value, constraint, parentKey) {
                    return constraint(value);
                },
                _satisfies: function (value, constraint, parentKey) {
                    if (constraint === value) return true;
                    else if (constraint instanceof RegExp) return this.$regex(value, constraint);
                    else if (Array.isArray(constraint)) return this.$in(value, constraint);
                    else if (constraint && typeof constraint === 'object') {
                        if (constraint instanceof Date) return this.$eq(value, constraint.getTime());
                        else {
                            if (constraint.$regex) return this.$regex(value, new RegExp(constraint.$regex, constraint.$options));
                            for (var key in constraint) {
                                if (!this[key]) return this.$eq(value, constraint, parentKey);
                                else if (!this[key](value, constraint[key], parentKey)) return false;
                            }
                            return true;
                        }
                    } else if (Array.isArray(value)) {
                        for (var i = 0; i < value.length; i++) if (this.$eq(value[i], constraint)) return true;
                        return false;
                    } else if (constraint === '' || constraint === null || constraint === undefined) return this.$null(value);
                    else return this.$eq(value, constraint);
                },
                $eq: function (value, constraint) {
                    if (value === constraint) return true;
                    else if (Array.isArray(value)) {
                        for (var i = 0; i < value.length; i++) if (this.$eq(value[i], constraint)) return true;
                        return false;
                    } else if (constraint === null || constraint === undefined || constraint === '') {
                        return this.$null(value);
                    } else if (value === null || value === '' || value === undefined) return false;
                    else if (value instanceof Date) {
                        if (constraint instanceof Date) {
                            return value.getTime() == constraint.getTime();
                        } else if (typeof constraint == 'number') {
                            return value.getTime() == constraint;
                        } else if (typeof constraint == 'string') return value.getTime() == new Date(constraint).getTime();
                    } else {
                        return value == constraint;
                    }
                },
                $exists: function (value, constraint, parentKey) {
                    return (value != undefined) == (constraint && true);
                },
                $deepEquals: function (value, constraint) {
                    if (typeof _ == 'undefined' || typeof _.isEqual == 'undefined') {
                        return JSON.stringify(value) == JSON.stringify(constraint);
                    } else {
                        return _.isEqual(value, constraint);
                    }
                },
                $not: function (values, constraint) {
                    return !this._satisfies(values, constraint);
                },
                $ne: function (values, constraint) {
                    return !this._satisfies(values, constraint);
                },
                $nor: function (values, constraint, parentKey) {
                    return !this.$or(values, constraint, parentKey);
                },
                $and: function (values, constraint, parentKey) {
                    if (!Array.isArray(constraint)) {
                        throw new Error('Logic $and takes array of constraint objects');
                    }
                    for (var i = 0; i < constraint.length; i++) {
                        var res = this._satisfies(values, constraint[i], parentKey);
                        if (!res) return false;
                    }
                    return true;
                },
                $or: function (values, constraint, parentKey) {
                    if (!Array.isArray(values)) {
                        values = [values];
                    }
                    for (var v = 0; v < values.length; v++) {
                        for (var i = 0; i < constraint.length; i++) {
                            if (this._satisfies(values[v], constraint[i], parentKey)) {
                                return true;
                            }
                        }
                    }
                    return false;
                },
                $null: function (values) {
                    if (values === '' || values === null || values === undefined) {
                        return true;
                    } else if (Array.isArray(values)) {
                        for (var v = 0; v < values.length; v++) {
                            if (!this.$null(values[v])) {
                                return false;
                            }
                        }
                        return true;
                    } else return false;
                },
                $in: function (values, constraint) {
                    if (!Array.isArray(constraint)) throw new Error('$in requires an array operand');
                    var result = false;
                    if (!Array.isArray(values)) {
                        values = [values];
                    }
                    for (var v = 0; v < values.length; v++) {
                        var val = values[v];
                        for (var i = 0; i < constraint.length; i++) {
                            if (this._satisfies(val, constraint[i])) {
                                result = true;
                                break;
                            }
                        }
                        result = result || constraint.indexOf(val) >= 0;
                    }
                    return result;
                },
                $likeI: function (values, constraint) {
                    return values.toLowerCase().indexOf(constraint) >= 0;
                },
                $like: function (values, constraint) {
                    return values.indexOf(constraint) >= 0;
                },
                $startsWith: function (values, constraint) {
                    if (!values) return false;
                    return values.startsWith(constraint);
                },
                $endsWith: function (values, constraint) {
                    if (!values) return false;
                    return values.endsWith(constraint);
                },
                $elemMatch: function (values, constraint, parentKey) {
                    for (var i = 0; i < values.length; i++) {
                        if (Query.lhs._rowsatisfies(values[i], constraint)) return true;
                    }
                    return false;
                },
                $contains: function (values, constraint) {
                    return values.indexOf(constraint) >= 0;
                },
                $nin: function (values, constraint) {
                    return !this.$in(values, constraint);
                },
                $regex: function (values, constraint) {
                    if (Array.isArray(values)) {
                        for (var i = 0; i < values.length; i++) {
                            if (constraint.test(values[i])) {
                                return true;
                            }
                        }
                    } else return constraint.test(values);
                },
                $gte: function (values, ref) {
                    return !this.$null(values) && values >= this.resolve(ref);
                },
                $gt: function (values, ref) {
                    return !this.$null(values) && values > this.resolve(ref);
                },
                $lt: function (values, ref) {
                    return !this.$null(values) && values < this.resolve(ref);
                },
                $lte: function (values, ref) {
                    return !this.$null(values) && values <= this.resolve(ref);
                },
                $before: function (values, ref) {
                    if (typeof ref === 'string') ref = Date.parse(ref);
                    if (typeof values === 'string') values = Date.parse(values);
                    return this.$lte(values, ref);
                },
                $after: function (values, ref) {
                    if (typeof ref === 'string') ref = Date.parse(ref);
                    if (typeof values === 'string') values = Date.parse(values);
                    return this.$gte(values, ref);
                },
                $type: function (values, ref) {
                    return typeof values == ref;
                },
                $all: function (values, ref) {
                    throw new Error('$all not implemented');
                },
                $size: function (values, ref) {
                    return typeof values == 'object' && (values.length == ref || Object.keys(values).length == ref);
                },
                $mod: function (values, ref) {
                    return values % ref[0] == ref[1];
                },
                $equal: function () {
                    return this.$eq(arguments);
                },
                $between: function (values, ref) {
                    return this._satisfies(values, {
                        $gt: ref[0],
                        $lt: ref[1],
                    });
                },
                resolve: function (ref) {
                    if (typeof ref === 'object') {
                        if (ref['$date']) return Date.parse(ref['$date']);
                    }
                    return ref;
                },
            },
        },
    };
    Query.undot = function (obj, key) {
        var keys = key.split('.'),
            sub = obj;

        for (var i = 0; i < keys.length; i++) {
            if (sub) sub = sub[keys[i]];
        }
        return sub;
    };
    Query.lhs.rhs.$equal = Query.lhs.rhs.$eq;
    Query.lhs.rhs.$any = Query.lhs.rhs.$or;
    Query.lhs.rhs.$all = Query.lhs.rhs.$and;
    Query.satisfies = function (row, constraints, getter) {
        return this.lhs._rowsatisfies(row, constraints, getter);
    };
    Array.prototype.query = function (q) {
        return Query.query(this, q);
    };
    RegExp.prototype.toJSON = RegExp.prototype.toString;

    if (typeof define != 'undefined' && define.amd)
        define('query', [], function () {
            return Query;
        });
    else if (typeof window != 'undefined') window.Query = Query;
    //else if (typeof GLOBAL != undefined && GLOBAL.global) GLOBAL.global.Query = Query;
    return Query;
    //})({});
})();

var Query$1 = Query;

function applyFunctions (OBJY) {
    return {
        /**
         * Applies affect rules
         * @param {obj} - the object
         * @param {operation} - the operation (onChange, onCreate and onDelete)
         * @param {insstance} - the current objy instance
         * @param {client} - the active client
         */
        applyAffects: function (obj, operation, instance, client, trigger) {
            this.instance.affectables.forEach(function (a) {
                if (Query$1.query([obj], a.affects, Query$1.undot).length != 0) {
                    var template = a.apply;
                    var templateId = a._id;

                    if (template.name) {
                        if (!obj.name) obj.name = template.name;
                    }

                    if (template.type) {
                        if (!obj.type) obj.type = template.type;
                    }

                    // Object handlers

                    ['onCreate', 'onChange', 'onDelete'].forEach(function (h) {
                        if (template[h]) {
                            Object.keys(template[h]).forEach(function (oC) {
                                if (!obj[h]) obj[h] = {};
                                if (!obj[h][oC]) {
                                    if (!template[h][oC]) return;
                                    obj[h][oC] = template[h][oC];
                                    obj[h][oC].template = templateId;
                                }
                            });
                        }
                    });

                    var isObject = function (a) {
                        return !!a && a.constructor === Object;
                    };

                    // Properties
                    function doTheProps(template, obj) {
                        var propsObj = obj;
                        if (!template) return;
                        var propsTmpl = template;

                        if (!propsObj) propsObj = {};

                        /*if (obj.type == 'bag') {
                            if (!obj.properties) {
                                obj.properties = {};
                            }
                        }*/

                        Object.keys(propsTmpl || {}).forEach(function (p) {
                            var isO = isObject(propsTmpl[p]);

                            if ((propsTmpl[p] || {}).type == 'bag') {
                                if (!propsObj[p]) {
                                    propsObj[p] = propsTmpl[p];
                                    if (isO) propsObj[p].propsTmpl = templateId;
                                } else {
                                    if (!propsObj[p].overwritten && Object.keys(propsObj[p]).length == 0) {
                                        propsObj[p] = propsTmpl[p];
                                    }

                                    if (isO) propsObj[p].propsTmpl = templateId;
                                    //propsObj.properties[p].overwritten = true;
                                }

                                if (!propsObj[propsObj]) propsObj[p] = {};

                                doTheProps(propsTmpl[p], propsObj[p]);
                            } else if (isObject(propsTmpl[p])) {
                                if (!propsObj[p]) {
                                    propsObj[p] = propsTmpl[p];

                                    if (p != 'properties' && isO) propsObj[p].propsTmpl = templateId;
                                } else {
                                    if (!propsObj[p].overwritten && Object.keys(propsObj[p]).length == 0) {
                                        propsObj[p] = propsTmpl[p];
                                    }

                                    if (p != 'properties' && isO) propsObj[p].propsTmpl = templateId;
                                    //propsObj[p].overwritten = true;
                                }

                                doTheProps(propsTmpl[p], propsObj[p]);
                            }

                            if (!propsObj[p]) {
                                propsObj[p] = propsTmpl[p];
                                if (p != 'properties' && isO) propsObj[p].propsTmpl = templateId;
                                if (isO) delete propsObj[p].overwritten;
                            } else {
                                if (!propsObj[p].overwritten) {
                                    if (p != 'properties' && isO) propsObj[p].propsTmpl = templateId;
                                    if (propsObj[p].value == null && isO) propsObj[p].value = propsTmpl[p].value;
                                    //obj[p].overwritten = true;
                                }

                                if (!propsObj[p].metaOverwritten) {
                                    propsObj[p].meta = propsTmpl[p].meta;
                                }

                                /*if (obj[p].type == 'bag') {
                                    if (!obj[p].properties) {
                                        obj[p].properties = {};
                                    }
                                }*/
                            }

                            if (propsTmpl.permissions) {
                                if (!propsObj.permissions) propsObj.permissions = {};
                                Object.keys(propsTmpl.permissions).forEach(function (p) {
                                    if (!propsObj.permissions[p]) {
                                        propsObj.permissions[p] = propsTmpl.permissions[p];
                                        if (isO) propsObj.permissions[p].propsTmpl = templateId;
                                    } else {
                                        if (isO) propsObj.permissions[p].propsTmpl = templateId;
                                        if (isO) propsObj.permissions[p].overwritten = true;
                                    }
                                });
                            }

                            ['onCreate', 'onChange', 'onDelete'].forEach(function (h) {
                                if (!isObject(propsTmpl[p])) return;
                                if (propsTmpl[p][h]) {
                                    if (!propsObj[p][h]) propsObj[p][h] = {};

                                    Object.keys(propsTmpl[p][h]).forEach(function (oC) {
                                        if (!propsObj[p][h][oC]) {
                                            propsObj[p][h][oC] = propsTmpl[p][h][oC];
                                            propsObj[p][h][oC].propsTmpl = templateId;
                                        }
                                    });
                                }
                            });
                        });
                    }

                    doTheProps(template || {}, obj || {});

                    // Applications

                    if (template.applications) {
                        template.applications.forEach(function (a) {
                            if (obj.applications) if (obj.applications.indexOf(a) == -1) obj.applications.push(a);
                        });
                    }

                    if (template._clients) {
                        template._clients.forEach(function (a) {
                            if ((obj._clients || []).indexOf(a) == -1) (obj._clients || []).push(a);
                        });
                    }

                    if (template.authorisations) {
                        var keys = Object.keys(template.authorisations);

                        if (keys.length > 0) {
                            if (!obj.authorisations) obj.authorisations = {};
                        }

                        keys.forEach(function (k) {
                            if (!obj.authorisations[k]) {
                                obj.authorisations[k] = template.authorisations[k];

                                obj.authorisations[k].forEach(function (a) {
                                    a.template = template._id;
                                });
                            } else {
                                template.authorisations[k].forEach(function (a) {
                                    var f = false;
                                    obj.authorisations[k].forEach(function (objA) {
                                        if (JSON.stringify(objA.query) == JSON.stringify(a.query)) f = true;
                                    });

                                    if (f) {
                                        a.overwritten = true;
                                    } else {
                                        a.template = template._id;
                                        obj.authorisations[k].push(a);
                                    }
                                });
                            }
                        });
                    }

                    // Permissions

                    if (template.permissions) {
                        if (!obj.permissions) obj.permissions = {};
                        Object.keys(template.permissions).forEach(function (p) {
                            if (!obj.permissions[p]) {
                                obj.permissions[p] = template.permissions[p];
                                obj.permissions[p].template = templateId;
                            } else {
                                obj.permissions[p].template = templateId;
                                obj.permissions[p].overwritten = true;
                            }
                        });
                    }

                    // Privileges

                    if (template.privileges) {
                        if (!obj.privileges) obj.privileges = {};
                        Object.keys(template.privileges).forEach(function (a) {
                            if (!obj.privileges[a]) obj.privileges[a] = [];

                            template.privileges[a].forEach(function (tP) {

                                obj.privileges[a].forEach(function (oP) {
                                    if (oP.name == tP.name) ;
                                });
                            });

                            if (!contains) {
                                obj.privileges[a].push({
                                    name: tP.name,
                                    template: templateId,
                                });
                            }
                        });
                    }
                }
            });

            this.applyRules(obj, operation, instance, client, trigger);
        },

        /**
         * Applies static rules
         * @param {obj} - the object
         * @param {operation} - the operation (onChange, onCreate and onDelete)
         * @param {insstance} - the current objy instance
         * @param {client} - the active client
         */

        applyRules: function (obj, operation, instance, client, trigger) {
            this.instance.staticRules.forEach(function (a) {
                if (Query$1.query([obj], a.affects, Query$1.undot).length != 0) {
                    var template = a.apply;
                    var templateId = a._id;

                    ['onCreate', 'onChange', 'onDelete'].forEach(function (h) {
                        if (template[h]) {
                            Object.keys(template[h]).forEach(function (oC) {
                                if (operation != h || (trigger && trigger != template[h][oC]?.trigger)) return;

                                instance.execProcessorAction(
                                    template[h][oC].value || template[h][oC].action,
                                    obj,
                                    null,
                                    null,
                                    function (data) {},
                                    client,
                                    null
                                );
                            });
                        }
                    });

                    if (template._constraints) {
                        if (!Array.isArray(obj._constraints)) obj._constraints = [];
                        template._constraints.forEach((c) => {
                            if (obj._constraints.find((el) => el.key == c.key)) return;

                            c.templateId = templateId;
                            obj._constraints.push(c);
                        });
                    }
                }
            });
        },
    };
}

function permissionFunctions (OBJY) {
    return {
        /**
         * Check the permissions for an object or object part
         * @param {user} - the user object
         * @param {app} - the current application
         * @param {obj} - the object (or property) in question
         * @param {permission} - the permission code to check for
         * @param {soft} - ...
         * @returns true or false
         */
        checkPermissions: function (user, app, obj, permission, soft, instance) {
            if (instance.ignorePermissions == true) return true;

            if (!user) return true;

            if (user.spooAdmin) return true;

            // A user can always see himself
            if (user._id == obj._id && permission == 'r') return true;

            var privileges = user.privileges;
            var permissions = obj.permissions;

            if (!permissions) return true;

            if (Object.keys(permissions || {}).length == 0) return true;

            // if permissions present and user has no privileges
            if (!privileges && permissions) {
                if (!soft) return false;
                else return false;
            }

            var allowed = false;

            if (Array.isArray(permissions)) {
                var perms = {};

                permissions.forEach(function (p) {
                    perms[p.name] = { value: p.value };
                });

                permissions = perms;
            }

            if (app) {
                if (privileges['*']) {
                    Object.keys(permissions).forEach(function (pKey) {
                        privileges['*'].forEach(function (item) {
                            if (permissions[item.name]) {
                                if (((permissions[item.name] || {}).value || '').indexOf(permission) != -1 || (permissions[item.name] || {}).value == '*')
                                    allowed = true;
                            }

                            if (permissions['*']) {
                                if (((permissions['*'] || {}).value || '').indexOf(permission) != -1 || (permissions['*'] || {}).value == '*') allowed = true;
                            }
                        });
                    });

                    if (allowed) return true;
                } else if (privileges[app]) {
                    privileges[app].forEach(function (item) {
                        if (permissions[item.name]) {
                            if (((permissions[item.name] || {}).value || '').indexOf(permission) != -1 || (permissions[item.name] || {}).value == '*')
                                allowed = true;
                        }

                        if (permissions['*']) {
                            if (((permissions['*'] || {}).value || '').indexOf(permission) != -1 || (permissions['*'] || {}).value == '*') allowed = true;
                        }
                    });

                    if (!allowed) return false;
                    else return true;
                } else return false;
            } else return false;
        },

        /**
         * Check the authorisations for an object
         * @param {obj} - the object in question
         * @param {user} - the user object
         * @param {condition} - the condition to check for
         * @param {app} - the current application
         * @returns true or false
         */
        checkAuthroisations: function (obj, user, condition, app, instance) {
            if (instance.ignoreAuthorisations == true) return true;

            var authorisations;
            if (!user) return true;

            if (user.spooAdmin) return true;

            if (Object.keys(user.authorisations || {}).length == 0) return true; //throwError();

            if (!app && !user.authorisations['*']) {
                return false;
            }

            if (user.authorisations['*']) authorisations = user.authorisations['*'];
            else if (app && !user.authorisations[app]) {
                return false;
            } else authorisations = user.authorisations[app];

            var permCheck = [obj];

            var query = { $or: [] };

            authorisations.forEach(function (a) {
                if (typeof a.query === 'string') {
                    try {
                        a.query = JSON.parse(a.query);
                    } catch (e) {
                        a.query = {};
                    }
                }

                if (a.query.$query) {
                    a.query = JSON.parse(JSON.stringify(a.query.$query));
                    delete a.query.$query;
                }

                if (a.perm.indexOf(condition) != -1 || a.perm.indexOf('*') != -1) query.$or.push(a.query);
            });

            if (query.$or.length == 0) return false;

            if (Query$1.query(permCheck, query, Query$1.undot).length == 0) return false;
            else return true;
        },

        /**
         * Add permissions to a query
         * @param {query} - the initial query
         * @param {user} - the user object
         * @param {app} - the current application
         * @returns {query} - the final query with permissions
         */
        buildPermissionQuery: function (query, user, app, instance) {
            if (instance.ignorePermissions == true) return query;

            if (query.$query) {
                query = JSON.parse(JSON.stringify(query.$query));
                delete query.$query;
            }

            if (!user.spooAdmin) {
                if (query.$sum || query.$count || query.$avg) return query;

                if (!user.privileges) return query;

                if (app && user.privileges[app]) {
                    var privArr = [];
                    user.privileges[app].forEach(function (p) {
                        var inn = {};

                        inn['permissions.' + p.name + '.value'] = { $regex: 'r' };
                        privArr.push(inn);
                        //inn = {};
                        //inn["permissions." + p.name] = { $regex: "r" }
                        //privArr.push(inn);
                        inn = {};
                        inn['permissions.' + p.name + '.value'] = '*';
                        privArr.push(inn);

                        inn = {};
                        inn['permissions.name'] = p.name;
                        privArr.push(inn);
                        //inn = {};
                        //inn["permissions." + p.name] = "*";
                        //privArr.push(inn);
                    });

                    var inn = {};
                    inn['permissions.*' + '.value'] = { $regex: 'r' };
                    privArr.push(inn);
                    inn = {};
                    inn['permissions.*'] = { $regex: 'r' };
                    privArr.push(inn);
                    inn = {};
                    inn['permissions.*' + '.value'] = '*';
                    privArr.push(inn);
                    //var inn = {};
                    //inn["permissions.*"] = "*"
                    //privArr.push(inn);

                    if (Object.keys(query).length > 0) {
                        return { $and: [query, { $or: privArr }] };
                    } else {
                        return { $or: privArr };
                    }
                } else if (!app) {
                    return query;
                } else return query;
            } else {
                return query;
            }
        },

        /**
         * Add authorisations to a query
         * @param {obj} - the object
         * @param {user} - the user object
         * @param {condition} - the condition
         * @param {app} - the current application
         * @returns {query} - the final query with permissions
         */
        buildAuthroisationQuery: function (obj, user, condition, app, instance) {
            if (instance.ignoreAuthorisations == true) return obj;

            var authorisations;
            if (!user) return obj;

            if (user.spooAdmin) return obj;

            if (obj.$sum || obj.$count || obj.$avg) return obj;

            function throwError() {
                throw new exceptions.LackOfPermissionsException('Lack of permissions');
            }

            if (Object.keys(user.authorisations || {}).length == 0) return obj; //throwError();

            if (!app && !user.authorisations['*']) {
                throwError();
            }

            if (user.authorisations['*']) authorisations = user.authorisations['*'];
            else if (app && !user.authorisations[app]) {
                throwError();
            } else authorisations = user.authorisations[app];

            //...
            if (obj.$query) {
                obj = JSON.parse(JSON.stringify(obj.$query));
                delete obj.$query;
            }

            var query = [];
            var wildcard = false;

            authorisations.forEach(function (a) {
                try {
                    a.query = JSON.parse(a.query);
                } catch (e) {}

                if (a.query.$query) {
                    a.query = JSON.parse(JSON.stringify(a.query.$query));
                    delete a.query.$query;
                }

                if (a.perm.indexOf(condition) != -1 || a.perm.indexOf('*') != -1) {
                    if (Object.keys(a.query).length == 0) wildcard = true;
                    else {
                        query.push({ $and: [a.query, obj] });
                    }
                }
            });

            if (query.length == 0 && !wildcard) throw new exceptions.LackOfPermissionsException('Lack of permissions');

            query = { $or: query };

            return query;
        },

        /**
         * Chains permission information, when performing multiple operations
         * @param {obj} - the object
         * @param {instance} - the OBJY instance
         * @param {code} - the permission code
         * @param {name} - the permission name
         * @param {key} - the permission key
         */
        chainPermission: function (obj, instance, code, name, key) {
            if (['c', 'r', 'u', 'd', 'x'].includes(code)) ; else code = 'u';

            if (obj.permissions) {
                if (Object.keys(obj.permissions).length > 0) {
                    if (!instance.permissionSequence[obj._id]) instance.permissionSequence[obj._id] = [];

                    if (!OBJY.checkPermissions(instance.activeUser, instance.activeApp, obj, code, true, instance))
                        instance.permissionSequence[obj._id].push({
                            name: name,
                            key: key,
                        });
                }
            }
        },

        getElementPermisson: function (element) {
            if (!element) return {};
            else if (!element.permissions) return {};
            else return element.permissions;
        },
    };
}

function objectFunctions (OBJY) {
    return {
        updateInheritedObjs: function (templ, pluralName, success, error, client, params, instance) {
            // TODO
            /*var templateFamily;

            if (params.templateFamily) templateFamily = `'${params.templateFamily}'`

            var code = `  
                OBJY['${pluralName}']({inherits: {$in: ["${templ._id}"]}}).get(function(data){
                    console.info('data', data)
                    data.forEach(function(d){
                        d = OBJY['${params.name}'](d);
                        console.info('found', d)
                        if(d.inherits.length == 0) d.update();
                        else
                        {
                            d.inherits.forEach(function(templateId)
                            {
                                console.info('i', templateId)
                                 OBJY.getTemplateFieldsForObject(d, templateId, function(data){
                                    console.info('found in', data);
                                    console.info('d', d)
                                    d.replace(data);
                                    d.update();
                                }, function(err){
                                    console.info('err', err)
                                }, '${client}', ${templateFamily})
                            })   
                        }
                    })
                })`;

            this.execProcessorAction(code, templ, null, null, function(data) {

            }, client, {})*/
        },

        removeInheritedObjs: function (templ, pluralName, success, error, client) {
            var code = ` 
            OBJY['${pluralName}']({inherits: {$in: ["${templ._id}"]}}).get(function(data){
                data.forEach(function(d){
                    d.removeInherit(${templ._id})
                    d.update();
                })
            })`;

            this.execProcessorAction(code, templ, null, null, function (data) {}, client, {});
        },

        prepareObjectDelta: function (oldObj, newObj, params, instance) {
            var meta = ['name', 'type'];
            meta.forEach(function (p) {
                if (newObj[p] != oldObj[p]) oldObj[p] = newObj[p];
            });

            var handlers = ['onCreate', 'onChange', 'onDelete'];
            handlers.forEach(function (h) {
                if (newObj[h]) {
                    Object.keys(newObj[h]).forEach(function (oC) {
                        if (newObj[h][oC]) {
                            if (newObj[h][oC].value != oldObj[h][oC].value) oldObj[h][oC].value = newObj[h][oC].value;
                            oldObj[h][oC].overwritten = true;
                        }
                    });
                }
            });

            // Properties
            function doTheProps(newObj) {
                Object.keys(obj).forEach(function (p) {
                    if (obj[p].type == 'bag') {
                        doTheProps(obj[p]);
                    }

                    if (obj[p]) {
                        if (obj[p].template && oldObj[p]) {
                            if (obj[p].value != oldObj[p].value) {
                                oldObj[p].value = obj[p].value;
                                oldObj[p].overwritten = true;
                            }

                            if (obj[p].action != oldObj[p].action) {
                                oldObj[p].action = obj[p].action;
                                oldObj[p].overwritten = true;
                            }

                            if (obj[p].date != oldObj[p].date) {
                                oldObj[p].date = obj[p].date;
                                oldObj[p].overwritten = true;
                            }

                            if (obj[p].interval != oldObj[p].interval) {
                                oldObj[p].interval = obj[p].interval;
                                oldObj[p].overwritten = true;
                            }

                            if (JSON.stringify(obj[p].meta) != JSON.stringify(oldObj[p].interval)) {
                                oldObj[p].meta = obj[p].meta;
                                oldObj[p].overwritten = true;
                            }
                        }
                    }

                    if (!oldObj[p]) oldObj[p] = obj[p];

                    if (obj.permissions) {
                        Object.keys(obj.permissions).forEach(function (p) {
                            if (obj.permissions[p]) {
                                if (JSON.stringify(obj.permissions[p]) != JSON.stringify(oldObj.permissions[p])) oldObj.permissions[p] = obj.permissions[p];
                                oldObj.permissions[p].overwritten = true;
                            }
                        });
                    }

                    if (obj[p]) {
                        handlers.forEach(function (h) {
                            if (obj[p][h]) {
                                Object.keys(obj[p][h]).forEach(function (oC) {
                                    if (obj[p][h][oC]) {
                                        if (obj[p][h][oC].value != oldObj[p][h][oC].value) oldObj[p][h][oC].value = obj[p][h][oC].value;
                                        oldObj[p][h][oC].overwritten = true;
                                    }
                                });
                            }
                        });
                    }
                });
            }

            doTheProps();

            // Applications: TODO!!!

            // Permissions
            if (newObj.permissions) {
                Object.keys(newObj.permissions).forEach(function (p) {
                    if (newObj.permissions[p]) {
                        if (newObj.permissions[p].value != oldObj.permissions[p].value) oldObj.permissions[p].value = newObj.permissions[p].value;
                        oldObj.permissions[p].overwritten = true;
                    }
                });
            }

            // Privileges
            /* if (newObj.privileges) {
                 Object.keys(newObj.privileges).forEach(function(a) {
                     newObj.privileges[a].forEach(function(tP, i) {
                         
                         oldObj.privileges[a].forEach(function(t_P, i_) {
                             if (JSON.stringify(tP) != JSON.stringify(t_P))
                                 
                                 oldObj.privileges[a].overwritten = true;
                                 oldObj.privileges[a].overwritten = true;
                             
                         })                       
                     })
                 })
             }*/
            return oldObj;
        },

        getTemplateFieldsForObject: function (obj, templateId, success, error, client, templateRole, templateSource, params, instance) {
            if (params.templateFamily === null) return success(obj);

            var isObject = function (a) {
                return !!a && a.constructor === Object;
            };

            function run(template) {

                if (template.name) {
                    if (!obj.name) obj.name = template.name;
                }

                if (template.type) {
                    if (!obj.type) obj.type = template.type;
                }

                // Object handlers

                ['onCreate', 'onChange', 'onDelete'].forEach(function (h) {
                    if (template[h]) {
                        Object.keys(template[h]).forEach(function (oC) {
                            if (!template[h][oC] || !isObject(template[h][oC])) return;
                            if (!obj[h]) obj[h] = {};
                            if (!obj[h][oC]) {
                                obj[h][oC] = template[h][oC];

                                obj[h][oC].template = templateId;
                            }
                        });
                    }
                });

                // Properties
                function doTheProps(template, obj) {
                    if (!obj) obj = {};

                    if (!template) template = {};

                    //if (params.object && !obj.hasOwnProperty(params.propsObject)) obj[params.propsObject] = {};

                    if (params.extendedStructure) {
                        Object.keys(params.extendedStructure).forEach((k) => {
                            if (isObject(params.extendedStructure[k]) && template[k]) {
                                doTheProps(template[k], obj[k]);
                            }
                        });
                    }

                    Object.keys(template).forEach((p) => {
                        if (OBJY.instance.predefinedProperties.includes(p) /* || (isObject(template[p]) || Array.isArray(template[p]))*/) return;

                        if (!template[p]) return;

                        if (isObject(template[p])) doTheProps(template[p], obj[p]);

                        var cloned = JSON.parse(JSON.stringify(template[p]));

                        if (!obj.hasOwnProperty(p)) {
                            obj[p] = cloned;
                            obj[p].template = templateId;
                            //delete obj[p].overwritten;
                        } else {
                            if (cloned.meta) {
                                if (!obj[p].meta) {
                                    obj[p].meta = cloned.meta;
                                    //obj[p].meta.overwritten = true;
                                } else {
                                    if (!obj[p].meta.overwritten) {
                                        obj[p].meta = cloned.meta;
                                        //obj[p].meta.overwritten = true;
                                    }
                                }
                            }
                            if (!obj[p].type) obj[p].type = cloned.type;

                            obj[p].template = templateId;
                            //obj[p].overwritten = true;
                        }

                        if (template.permissions) {
                            if (!obj.permissions) obj.permissions = {};
                            Object.keys(template.permissions).forEach(function (p) {
                                if (!obj.permissions[p]) {
                                    obj.permissions[p] = template.permissions[p];
                                    obj.permissions[p].template = templateId;
                                } else {
                                    obj.permissions[p].template = templateId;
                                    obj.permissions[p].overwritten = true;
                                }
                            });
                        }

                        ['onCreate', 'onChange', 'onDelete'].forEach(function (h) {
                            if (template[p][h]) {
                                if (!obj[p][h]) obj[p][h] = {};

                                Object.keys(template[p][h]).forEach(function (oC) {
                                    if (!obj[p][h][oC]) {
                                        obj[p][h][oC] = template[p][h][oC];
                                        if (obj[p][h][oC]) obj[p][h][oC].template = templateId;
                                    }
                                });
                            }
                        });

                        if (template[p].type == 'bag') {
                            doTheProps(cloned, obj[p]);
                        }
                    });
                }

                doTheProps(template, obj);

                // Applications

                if (template.applications) {
                    template.applications.forEach(function (a) {
                        if (obj.applications) if (obj.applications.indexOf(a) == -1) obj.applications.push(a);
                    });
                }

                if (template.authorisations) {
                    var keys = Object.keys(template.authorisations);

                    if (keys.length > 0) {
                        if (!obj.authorisations) obj.authorisations = {};
                    }

                    keys.forEach(function (k) {
                        if (!obj.authorisations[k]) {
                            obj.authorisations[k] = template.authorisations[k];

                            obj.authorisations[k].forEach(function (a) {
                                a.template = template._id;
                            });
                        } else {
                            template.authorisations[k].forEach(function (a) {
                                var f = false;
                                obj.authorisations[k].forEach(function (objA) {
                                    if (JSON.stringify(objA.query) == JSON.stringify(a.query)) f = true;
                                });

                                if (f) {
                                    a.overwritten = true;
                                } else {
                                    a.template = template._id;
                                    a.test = 'has';
                                    obj.authorisations[k].push(a);
                                }
                            });
                        }
                    });
                }

                // Permissions

                if (template.permissions) {
                    if (!obj.permissions) obj.permissions = {};
                    Object.keys(template.permissions).forEach(function (p) {
                        if (!obj.permissions[p]) {
                            obj.permissions[p] = template.permissions[p];
                            obj.permissions[p].template = templateId;
                        } else {
                            obj.permissions[p].template = templateId;
                            obj.permissions[p].overwritten = true;
                        }
                    });
                }

                // Privileges

                if (template.privileges) {
                    if (!obj.privileges) obj.privileges = {};
                    Object.keys(template.privileges).forEach(function (a) {
                        if (!obj.privileges[a]) obj.privileges[a] = [];

                        template.privileges[a].forEach(function (tP) {
                            var contains = false;

                            obj.privileges[a].forEach(function (oP) {
                                if (oP.name == tP.name) contains = true;
                            });

                            if (!contains) {
                                obj.privileges[a].push({
                                    name: tP.name,
                                    template: templateId,
                                });
                            }
                        });
                    });
                }

                success(obj);
            }

            if (this.instance.caches[templateRole || obj.role].get(templateId)) ; else {
                OBJY.getObjectById(
                    templateRole || obj.role,
                    templateId,
                    (template) => {
                        //if (!this.instance.caches[templateRole || obj.role].get(templateId)) this.instance.caches[templateRole || obj.role].add(templateId, template);

                        var counter = 0;

                        if ((template.inherits || []).length == 0) run(template);
                        else {
                            template.inherits.forEach(function (i) {
                                OBJY.getTemplateFieldsForObject(
                                    template,
                                    i,
                                    function () {
                                        counter++;

                                        // console.log('counter', counter, template, i);

                                        if (counter == template.inherits.length) run(template);
                                    },
                                    function (err) {
                                        counter++;

                                        if (counter == template.inherits.length) run(template);
                                    },
                                    client,
                                    templateRole || obj.role,
                                    templateSource || OBJY.instance.activeTenant,
                                    params
                                );
                            });
                        }

                        //run(template)
                    },
                    function (err) {
                        error(err);
                    },
                    OBJY.instance.activeApp,
                    templateSource || OBJY.instance.activeTenant
                );

                /*OBJY[templateRole || obj.role](templateId).get(function(template) {

                    //if(!this.instance.caches[templateRole || obj.role].get(templateId)) this.instance.caches[templateRole || obj.role].add(templateId,  template);

                    run(template)

                }, function(err) {
                    error(err);
                }, templateSource)*/
            }
        },

        removeTemplateFieldsForObject: function (obj, templateId, success, error, client, params, instance) {
            if (params.templateFamily === null) return success(obj);

            if (!templateId) {
                error('template not found');
                return;
            }
            // Object handlers

            ['onCreate', 'onChange', 'onDelete'].forEach(function (h) {
                if (obj[h]) {
                    Object.keys(obj[h]).forEach(function (oC) {
                        if (obj[h][oC]) {
                            if (obj[h][oC].template == templateId && !obj[h][oC].overwritten) delete obj[h][oC];
                        }
                    });
                }
            });

            var isObject = function (a) {
                return !!a && a.constructor === Object;
            };

            function doTheProps(obj) {
                if (obj) {
                    Object.keys(obj).forEach(function (p) {
                        if (!isObject(obj[p])) return;

                        /*if (obj.permissions) {
                            Object.keys(obj.permissions).forEach(function(p) {
                                if (obj.permissions[p]) {
                                    if (obj.permissions[p].template == templateId && !obj.permissions[p].overwritten)
                                        delete obj.permissions[p]
                                }
                            })
                        }*/

                        if (obj[p]) {
                            ['onCreate', 'onChange', 'onDelete'].forEach(function (h) {
                                if (obj[p][h]) {
                                    object.keys(obj[p][h]).forEach(function (oC) {
                                        if (obj[p][h][oC]) {
                                            if (obj[p][h][oC].template == templateId && !obj[p][h][oC].overwritten) delete obj[p][h][oC];
                                        }
                                    });
                                }
                            });
                        }

                        if (obj[p].type == 'bag') {
                            return doTheProps(obj[p]);
                        }

                        if (params.extendedStructure) {
                            Object.keys(params.extendedStructure).forEach((k) => {
                                if (isObject(params.extendedStructure[k]) && k == p) {
                                    doTheProps(obj[p]);
                                }
                            });
                        }

                        if (obj[p]) ;
                    });
                }
            }

            doTheProps(obj);

            // Applications: TODO!!!

            // Permissions
            if (obj.permissions) {
                Object.keys(obj.permissions).forEach(function (p) {
                    if (obj.permissions[p]) {
                        if (obj.permissions[p].template == templateId && !obj.permissions[p].overwritten) delete obj.permissions[p];
                    }
                });
            }

            // Privileges
            if (obj.privileges) {
                Object.keys(obj.privileges).forEach(function (a) {
                    if (!Array.isArray(obj.privileges[a])) return;
                    obj.privileges[a].forEach(function (tP, i) {
                        if (tP.template == templateId && !tP.overwritten) obj.privileges[a].splice(i, 1);
                    });
                });
            }

            if (obj._constraints) {
                if (!Array.isArray(obj._constraints)) return;
                obj._constraints.forEach((c, i) => {
                    if (c.templateId == templateId && !c.overwritten) obj._constraints.splice(i, 1);
                });
            }

            success(obj);
        },

        updateObjAfterTemplateChange: function (templateId) {},

        removeTemplateFieldsToObject: function (obj, templateId) {
            this.getTemplateAsyn(
                templateId,
                function (template) {
                    var propertyKeys = Object.keys(template);
                    propertyKeys.forEach(function (property) {
                        if (obj[property] === undefined) {
                            this.removeTemplateFieldFromObjects(obj.template[property]);
                        }
                    });
                },
                function (error) {}
            );
        },

        addTemplateToObject: function (obj, templateId, instance) {
            var contains = false;
            obj.inherits.forEach(function (templ) {
                if (templ == templateId) contains = true;
            });

            if (!contains) {
                obj.inherits.push(templateId);
                OBJY.chainPermission(obj, instance, 'i', 'addInherit', templateId);
                OBJY.chainCommand(obj, instance, 'addInherit', templateId);
            }
        },

        addApplicationToObject: function (obj, application, instance) {
            var contains = false;

            if (!obj.applications) obj.applications = [];

            obj.applications.forEach(function (app) {
                if (app == application) contains = true;
            });
            if (!contains) {
                obj.applications.push(application);
                OBJY.chainPermission(obj, instance, 'a', 'addApplication', application);
            } else throw new exceptions.DuplicateApplicationException(application);
        },

        removeApplicationFromObject: function (obj, application, instance) {
            var contains = false;
            obj.applications.forEach(function (app, i) {
                if (app == application) {
                    obj.applications.splice(i, 1);
                    contains = true;
                }
            });

            OBJY.chainPermission(obj, instance, 'a', 'removeApplication', application);

            if (!contains) {
                throw new exceptions.NoSuchApplicationException(application);
            }
        },

        removeTemplateFromObject: function (obj, templateId, success, error, instance) {

            obj.inherits.forEach(function (templ) {
            });

            if (obj.inherits.indexOf(templateId) != -1) {
                obj.inherits.splice(obj.inherits.indexOf(templateId), 1);

                OBJY.chainPermission(obj, instance, 'i', 'removeInherit', templateId);
                OBJY.chainCommand(obj, instance, 'removeInherit', templateId);

                success(obj);
            } else {
                error('Template not found in object');
            }
        },

        TemplatesCreateWrapper: function (
            obj,
            template //addTemplateToObject!!!
        ) {
            var existing = false;
            obj.inherits.forEach(function (_template) {
                if (_template == template) existing = true;
            });
            if (!existing) {
                obj.inherits.push(template);
            }
        },

        ObjectPermissionsCreateWrapper: function (
            obj,
            permissions //addTemplateToObject!!!
        ) {
            if (!typeof permissions == 'object') throw new exceptions.InvalidPermissionException();

            if (!permissions) return;

            var permissionKeys = Object.keys(permissions);
            permissionKeys.forEach(function (permission) {
                //if (!typeof permissions[permission] == 'string') throw new InvalidPermissionException();
                if (typeof permissions[permission] == 'string') {
                    permissions[permission] = {
                        value: permissions[permission],
                    };
                } else {
                    permissions[permission] = permissions[permission];
                }
            });
            return permissions;
        },

        ObjectOnCreateSetWrapper: function (obj, name, onCreate, trigger, type, instance) {
            //if (!typeof onchange == 'object') throw new exceptions.InvalidPermissionException();

            if (!onCreate) throw new exceptions.InvalidHandlerException();

            if (!obj.onCreate) obj.onCreate = {};

            if (obj.onCreate[name]) throw new exceptions.HandlerExistsException(name);

            if (!name) name = OBJY.RANDOM();

            if (!obj.onCreate[name]) obj.onCreate[name] = {};

            obj.onCreate[name].value = onCreate;
            obj.onCreate[name].trigger = trigger || 'after';
            obj.onCreate[name].type = type || 'async';

            if (obj.onCreate[name].templateId) obj.onCreate[name].overwritten = true;

            OBJY.chainPermission(obj, instance, 'v', 'setOnCreateHandler', name);

            return onCreate;
        },

        ObjectOnCreateCreateWrapper: function (obj, onCreate, instance) {
            //if (!typeof onchange == 'object') throw new exceptions.InvalidPermissionException();

            if (!onCreate) return;

            Object.keys(onCreate).forEach(function (oC) {
                if (!onCreate[oC].trigger) onCreate[oC].trigger = 'after';
                if (!onCreate[oC].type) onCreate[oC].type = 'async';
            });

            return onCreate;
        },

        AffectsCreateWrapper: function (obj, affects) {
            if (!affects) affects = {};

            return affects;
        },

        ApplyCreateWrapper: function (obj, apply) {
            if (!apply) apply = {};

            return apply;
        },

        ObjectOnChangeCreateWrapper: function (obj, onChange, instance) {
            //if (!typeof onchange == 'object') throw new exceptions.InvalidPermissionException();

            if (!onChange) return;

            Object.keys(onChange).forEach(function (oC) {
                if (!onChange[oC].trigger) onChange[oC].trigger = 'after';
                if (!onChange[oC].type) onChange[oC].type = 'async';
            });

            return onChange;
        },

        ObjectAuthorisationSetWrapper: function (obj, authorisationObj, instance) {
            var app = instance.activeApp || '*';

            if (!obj.authorisations) obj.authorisations = {};

            if (!obj.authorisations[app]) obj.authorisations[app] = [];

            if (!authorisationObj.name) authorisationObj.name = OBJY.RANDOM();

            var found = false;
            obj.authorisations[app].forEach((au) => {
                if (au.name == authorisationObj.name) {
                    au = authorisationObj;
                    found = true;
                }
            });

            if (!found) obj.authorisations[app].push(authorisationObj);

            return authorisationObj;
        },

        ObjectAuthorisationRemoveWrapper: function (obj, authorisationId, instance) {
            var app = instance.activeApp || '*';

            if (!obj.authorisations) throw new exceptions.General('No authorisations present');

            if (!obj.authorisations[app]) throw new exceptions.General('No authorisations for this app present');

            obj.authorisations[app].forEach((au, i) => {
                if (au.name == authorisationId) obj.authorisations[app].splice(i, 1);
            });

            if (Object.keys(obj.authorisations[app]).length == 0) delete obj.authorisations[app];

            return authorisationId;
        },

        ObjectOnDeleteCreateWrapper: function (obj, onDelete, instance) {
            //if (!typeof onchange == 'object') throw new exceptions.InvalidPermissionException();

            if (!onDelete) return;

            Object.keys(onDelete).forEach(function (oC) {
                if (!onDelete[oC].trigger) onDelete[oC].trigger = 'after';
                if (!onDelete[oC].type) onDelete[oC].type = 'async';
            });

            return onDelete;
        },

        ObjectOnChangeSetWrapper: function (obj, name, onChange, trigger, type, instance) {
            //if (!typeof onchange == 'object') throw new exceptions.InvalidPermissionException();

            if (!onChange) throw new exceptions.InvalidHandlerException();

            if (!obj.onChange) obj.onChange = {};

            if (obj.onChange[name]) throw new exceptions.HandlerExistsException(name);

            if (!name) name = OBJY.RANDOM();

            if (!obj.onChange[name]) obj.onChange[name] = {};

            obj.onChange[name].value = onChange;
            obj.onChange[name].trigger = trigger || 'after';
            obj.onChange[name].type = type || 'async';

            if (obj.onChange[name].templateId) obj.onChange[name].overwritten = true;

            OBJY.chainPermission(obj, instance, 'w', 'setOnChangeHandler', name);

            return onChange;
        },

        ObjectOnDeleteSetWrapper: function (obj, name, onDelete, trigger, type, instance) {
            //if (!typeof onchange == 'object') throw new InvalidPermissionException();

            if (!onDelete) throw new exceptions.InvalidHandlerException();

            if (!obj.onDelete) obj.onDelete = {};

            if (obj.onDelete[name]) throw new exceptions.HandlerExistsException(name);

            if (!name) name = OBJY.RANDOM();

            if (!obj.onDelete[name]) obj.onDelete[name] = {};

            obj.onDelete[name].value = onDelete;
            obj.onDelete[name].trigger = trigger || 'after';
            obj.onDelete[name].type = type || 'async';

            if (obj.onDelete[name].templateId) obj.onDelete[name].overwritten = true;

            OBJY.chainPermission(obj, instance, 'z', 'setOnDeleteHandler', name);

            return onDelete;
        },

        ObjectPermissionSetWrapper: function (
            obj,
            permission,
            instance //addTemplateToObject!!!
        ) {
            if (!obj.permissions) obj.permissions = {};
            if (!typeof permission == 'object') throw new exceptions.InvalidPermissionException();

            if (!permission) throw new exceptions.InvalidPermissionException();

            var permissionKey = Object.keys(permission)[0];

            if (!obj.permissions[permissionKey]) obj.permissions[permissionKey] = permission[permissionKey];
            else {
                obj.permissions[permissionKey] = permission[permissionKey];
            }

            OBJY.chainPermission(obj, instance, 'x', 'setPermission', permissionKey);

            return permission;
        },

        ObjectPermissionRemoveWrapper: function (
            obj,
            permissionName,
            instance //addTemplateToObject!!!
        ) {
            if (!permissionName) throw new exceptions.InvalidPermissionException();

            if (!typeof permissionName == 'string') throw new exceptions.InvalidPermissionException();

            if (!obj.permissions[permissionName]) throw new exceptions.NoSuchPermissionException(permissionName);

            OBJY.chainPermission(obj, instance, 'x', 'removePermission', permissionName);

            delete obj.permissions[permissionName];

            return permissionName;
        },

        ObjectRoleChecker: function (obj, role) {
            switch (role) {
                case 'object':
                    return role;
                case 'template':
                    return role;
                case 'tenant':
                    return role;
                case 'application':
                    return role;
                case 'user':
                    obj.username = '';
                    obj.password = '';
                    return role;
                default:
                    return 'object';
            }
        },

        PropertiesChecker: function (obj, properties, instance, params) {
            if (properties === undefined) return;

            //obj.properties = {};

            //if (params.object) obj[params.propsObject] = {};

            var propertyKeys = Object.keys(properties);
            propertyKeys.forEach(function (property) {
                var propKey = {};
                propKey[property] = properties[property];
                var newProp = propKey;
                new OBJY.PropertyCreateWrapper(obj, newProp, false, instance, params);
            });
            return obj;
        },

        ApplicationsChecker: function (obj, applications) {
            if (applications === undefined) return;

            obj.applications = [];
            applications.forEach(function (application) {
                obj.applications.push(application);
            });

            return obj.applications;
        },

        ActionsChecker: function (obj, actions) {
            if (actions === undefined) return;

            obj.actions = {};
            var actionKeys = Object.keys(actions);
            actionKeys.forEach(function (action) {
                var actionKey = {};
                actionKey[action] = actions[action];
                var newAction = actionKey;
                new OBJY.ActionCreateWrapper(obj, newAction, false);
            });
            return obj.actions;
        },

        InheritsChecker: function (obj, templates) {
            if (templates === undefined) return;
            if (typeof templates !== 'object') return;
            obj.inherits = [];

            templates.forEach(function (template) {
                if (template != obj._id) new OBJY.TemplatesCreateWrapper(obj, template);
            });

            return obj.inherits;
        },

        PrivilegesChecker: function (obj) {
            return obj.privileges;
        },

        PrivilegeChecker: function (obj, privilege) {
            if (!typeof privilege == 'object') throw new exceptions.InvalidPrivilegeException();
            var privilegeKey = Object.keys(privilege)[0];

            if (!obj.privileges) obj.privileges = {};

            if (!obj.privileges[privilegeKey]) {
                obj.privileges[privilegeKey] = [];
            }

            var contains = false;

            obj.privileges[privilegeKey].forEach(function (oP) {
                if (oP.name == privilege[privilegeKey].name) contains = true;
            });

            if (!contains) obj.privileges[privilegeKey].push({ name: privilege[privilegeKey].name });
            else throw new exceptions.General('Privilege already exists');

            return privilege;
        },

        PrivilegeRemover: function (obj, privilege, instance) {
            //if (!typeof privilege == 'object') throw new exceptions.InvalidPrivilegeException();
            var appId = instance.activeApp; //Object.keys(privilege)[0];

            if (!obj.privileges[appId]) {
                throw new exceptions.NoSuchPrivilegeException();
            }

            var i;
            for (i = 0; i < obj.privileges[appId].length; i++) {
                if (obj.privileges[appId][i].name == privilege) obj.privileges[appId].splice(i, 1);
            }

            if (obj.privileges[appId].length == 0) {
                delete obj.privileges[appId];
            }

            return privilege;
        },
    };
}

var isObject$1 = function (a) {
    return !!a && a.constructor === Object;
};

function mapperFunctions (OBJY) {
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
                    if (!isObject$1(property)) return;

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

            this.instance.mappers[role].getByCriteria(
                criteria,
                function (data) {
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

            this.instance.mappers[role].count(
                criteria,
                function (data) {
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

var Mapper$2 = function (OBJY, options) {
    return Object.assign(new OBJY.StorageTemplate(OBJY, options), {
        database: {},
        index: {},

        createClient: function (client, success, error) {
            if (this.multitenancy == this.CONSTANTS.MULTITENANCY.ISOLATED) {
                if (this.database[client]) error('Client already exists');

                this.database[client] = [];
                this.index[client] = {};
                success();
            }
        },

        getDBByMultitenancy: function (client) {
            if (this.multitenancy == this.CONSTANTS.MULTITENANCY.SHARED) {
                if (!Array.isArray(this.database)) this.database = [];

                return this.database;
            } else if (this.multitenancy == this.CONSTANTS.MULTITENANCY.ISOLATED) {
                if (!this.database[client]) throw new Error('no database for client ' + client);

                return this.database[client];
            }
        },

        listClients: function (success, error) {
            if (!this.database) return error('no database');

            if (this.multitenancy == this.CONSTANTS.MULTITENANCY.ISOLATED) success(Object.keys(this.database));
            else success(Object.keys(this.database));
        },

        getById: function (id, success, error, app, client) {
            var db = this.getDBByMultitenancy(client);

            if (this.index[client][id] === undefined) return error('object not found: ' + id);

            if (this.multitenancy == this.CONSTANTS.MULTITENANCY.SHARED)
                if (this.index[client][id].tenantId != client) return error('object not found: ' + _id);

            success(db[this.index[client][id]]);
        },

        getByCriteria: function (criteria, success, error, app, client, flags) {
            var db = this.getDBByMultitenancy(client);

            if (app)
                Object.assign(criteria, {
                    applications: {
                        $in: [app],
                    },
                });

            if (this.multitenancy == this.CONSTANTS.MULTITENANCY.SHARED)
                Object.assign(criteria, {
                    tenantId: client,
                });

            success(Query$1.query(db, criteria, Query$1.undot));
        },

        count: function (criteria, success, error, app, client, flags) {
            var db = this.getDBByMultitenancy(client);

            if (app)
                Object.assign(criteria, {
                    applications: {
                        $in: [app],
                    },
                });

            if (this.multitenancy == this.CONSTANTS.MULTITENANCY.SHARED)
                Object.assign(criteria, {
                    tenantId: client,
                });

            success(Query$1.query(db, criteria, Query$1.undot).length);
        },

        update: function (spooElement, success, error, app, client) {
            var db = this.getDBByMultitenancy(client);

            if (this.index[client][spooElement._id] === undefined) return error('object not found: ' + spooElement._id);

            if (this.multitenancy == this.CONSTANTS.MULTITENANCY.SHARED)
                if (this.index[client][spooElement._id].tenantId != client) return error('object not found: ' + _id);

            db[this.index[client][spooElement._id]] = spooElement;

            success(db[this.index[client][spooElement._id]]);
        },

        add: function (spooElement, success, error, app, client) {
            if (!this.database[client]) this.database[client] = [];

            if (!this.index[client]) this.index[client] = {};

            if (this.index[client][spooElement._id] !== undefined) return error('object with taht id already exists: ' + spooElement._id);
            if (!this.index[client]) this.index[client] = {};

            var db = this.getDBByMultitenancy(client);

            if (this.multitenancy == this.CONSTANTS.MULTITENANCY.SHARED) {
                spooElement.tenantId = client;
            }

            this.index[client][spooElement._id] = db.push(spooElement) - 1;

            success(spooElement);
        },
        remove: function (spooElement, success, error, app, client) {
            var db = this.getDBByMultitenancy(client);

            if (this.index[client][spooElement._id] === undefined) return error('object not found: ' + spooElement._id);

            if (this.multitenancy == this.CONSTANTS.MULTITENANCY.SHARED)
                if (this.index[client][spooElement._id].tenantId != client) return error('object not found: ' + spooElement._id);

            db.splice(this.index[client][spooElement._id], 1);
            delete this.index[client][spooElement._id];
            success(spooElement);
        },
    });
};

const Mapper$1 = function (OBJY, mapperOptions) {
    return Object.assign(new OBJY.ProcessorTemplate(OBJY), {
        execute: function (dsl, obj, prop, data, callback, client, app, user, options) {
            OBJY.Logger.log('Executing dsl in mapper');

            if (this.multitenancy == this.CONSTANTS.MULTITENANCY.ISOLATED) {
                try {
                    if ((mapperOptions || {}).hasOwnProperty('parse')) {
                        mapperOptions.parse(dsl);
                    } else {
                        if (typeof dsl === 'function') dsl(obj, prop, data, callback, client, app, user, options);
                        else eval(dsl);
                    }
                } catch (e) {
                    OBJY.Logger.error(e);
                }
                if (callback) callback();
            } else {
                try {
                    if ((mapperOptions || {}).hasOwnProperty('parse')) {
                        mapperOptions.parse(dsl);
                    } else {
                        if (typeof dsl === 'function') dsl(obj, prop, data, callback, client, app, user, options);
                        else eval(dsl);
                    }
                } catch (e) {
                    OBJY.Logger.error(e);
                }
                if (callback) callback();
            }
        },
    });
};

const Mapper = function (OBJY) {
    return Object.assign(new OBJY.ObserverTemplate(OBJY), {
        initialize: function (millis) {
            var self = this;

            this.interval_ = setInterval(function () {
                self.run(moment().utc());
            }, this.interval || 60000);
        },

        run: function (date) {
            var self = this;

            OBJY.getPersistence(self.objectFamily).listClients(
                function (data) {
                    data.forEach(function (tenant) {
                        OBJY.getPersistence(self.objectFamily).getByCriteria(
                            {
                                _aggregatedEvents: {
                                    $elemMatch: {
                                        date: {
                                            $lte: date.toISOString(),
                                        },
                                    },
                                },
                            },
                            function (objs) {
                                objs.forEach(function (obj) {
                                    obj = OBJY[self.objectFamily](obj);

                                    obj._aggregatedEvents.forEach(function (aE) {
                                        var prop = obj.getProperty(aE.propName);

                                        OBJY.execProcessorAction(
                                            prop.action,
                                            obj,
                                            prop,
                                            null,
                                            function () {
                                                obj.setEventTriggered(aE.propName, true, tenant).update(
                                                    function (d) {},
                                                    function (err) {
                                                        console.log(err);
                                                    },
                                                    tenant
                                                );
                                            },
                                            tenant,
                                            {}
                                        );
                                    });
                                });
                            },
                            function (err) {},
                            /*app*/ undefined,
                            tenant,
                            {}
                        );
                    });
                },
                function (err) {}
            );
        },
    });
};

function wrapperFunctions (OBJY) {
    return {
        /**
         * Defines an Object Family. Creates a constructor with the single name and one with the plural name
         * @param {params} an object containing the information.
         * @returns {this.instance} an array of all object families
         */
        define: function (params) {
            if (typeof params == 'string') params = { name: params, pluralName: params + 's' };

            if (!params.name || !params.pluralName) {
                throw new Error('Invalid arguments');
            }

            this[params.name] = function (obj) {
                //return OBJY.SingleProxy(obj, params.name, this, params);
                return new OBJY.Obj(obj, params.name, this.instance, params);
            };

            if (this.instance.objectFamilies.indexOf(params.name) == -1) this.instance.objectFamilies.push(params.name);

            this[params.pluralName] = function (objs, flags) {
                return new OBJY.Objs(objs, params.name, this.instance, params, flags);
            };

            if (params.storage) this.plugInPersistenceMapper(params.name, params.storage);
            else if (params.storage === undefined) this.plugInPersistenceMapper(params.name, this.instance.storage || new Mapper$2(this));

            if (params.processor) this.plugInProcessor(params.name, params.processor);
            else if (params.processor === undefined) this.plugInProcessor(params.name, this.instance.processor || new Mapper$1(this));

            if (params.observer) {
                this.plugInObserver(params.name, params.observer);
                if (params.observer.initialize) params.observer.initialize();
            } else if (params.observer === undefined) {
                this.plugInObserver(params.name, this.instance.observer || new Mapper(this));
                if (this.instance.observers[params.name].initialize) this.instance.observers[params.name].initialize();
            }

            if (params.backend) {
                this.plugInPersistenceMapper(params.name, params.backend.storage);
                this.plugInProcessor(params.name, params.backend.processor);
                this.plugInObserver(params.name, params.backend.observer);
            }

            return this.instance[params.name];
        },

        /**
         * A wrapper for define
         */
        ObjectFamily: function (params) {
            return this.define(params);
        },

        /**
         * Returns the constructor for a specified object family name (singular or plural)
         * @param {role} to object family
         * @returns {constructor} the constructor
         */
        getConstructor: function (role) {
            if (this.instance.mappers[role]) return OBJY[role];
            throw new Error('No constructor');
        },

        /**
         * Returns all defined Object Families from the current instance
         * @returns {objectfamilies} an array of all object families
         */
        getObjectFamilies: function () {
            return this.instance.objectFamilies;
        },
    };
}

var CONSTANTS$1 = {
    EVENT: {
        TYPE_RECURRING: 'recurring',
        TYPE_TERMINATING: 'terminating',
        ACTION: {
            TYPE_AUTORENEW: 'autorenew',
            TYPE_CONFIRM: 'confirm',
            TYPE_PROTOCOL: 'protocol',
        },
    },
    PROPERTY: {
        TYPE_SHORTTEXT: 'shortText',
        TYPE_LONGTEXT: 'longText',
        TYPE_INDEXEDTEXT: 'indexedText',
        TYPE_NUMBER: 'number',
        TYPE_DATE: 'date',
        TYPE_SHORTID: 'shortId',
        TYPE_REF_OBJ: 'objectRef',
        TYPE_REF_USR: 'userRef',
        TYPE_REF_FILE: 'fileRef',
        TYPE_PROPERTY_BAG: 'bag',
        TYPE_BOOLEAN: 'boolean',
        TYPE_ARRAY: 'array',
        TYPE_EVENT: 'event',
        TYPE_ACTION: 'action',
        TYPE_JSON: 'json',
    },
    MULTITENANCY: {
        ISOLATED: 'isolated',
        SHARED: 'shared',
    },
    TYPES: {
        SCHEDULED: 'scheduled',
        QUERIED: 'queried',
    },
    TEMPLATEMODES: {
        STRICT: 'strict',
    },
};

function propertyFunctions (OBJY) {
    return {
        PropertyRefParser: function (obj, propertyName, success, error) {
            var allProperties = obj.getProperties();

            try {
                propertyToReturn = allProperties[propertyName];
            } catch (e) {}

            if (!propertyToReturn) throw new exceptions.PropertyNotFoundException(propertyName);

            if (!propertyToReturn.type == 'objectRef') throw new exceptions.PropertyNotFoundException(propertyName);

            return OBJY.getObjectByIdSyn(propertyToReturn.value);
        },

        EventParser: function (obj, eventName) {
            var eventToReturn;

            function getValue(obj, access) {
                if (typeof access == 'string') {
                    access = access.split('.');
                }
                if (access.length > 1) {
                    getValue(obj.events[access.shift()], access);
                } else {
                    try {
                        var t = obj.events[access[0]].type;
                    } catch (e) {
                        throw new exceptions.NoSuchEventException(propertyName);
                    }

                    eventToReturn = obj.events[access[0]];
                }
            }

            getValue(obj, eventName);

            return eventToReturn;
        },

        PropertyBagItemQueryRemover: function (obj, propertyName) {
            function removeQuery(obj, access) {
                if (typeof access == 'string') {
                    access = access.split('.');
                }
                if (access.length > 1) {
                    removeQuery(obj[access.shift()], access);
                } else {
                    if (!obj.hasOwnProperty(access[0])) throw new exceptions.NoSuchPropertyException(propertyName);

                    if (!obj[access[0]].query) throw new exceptions.NoSuchPermissionException(permissionKey);

                    delete obj[access[0]].query;
                    return;
                }
            }

            removeQuery(obj, propertyName);
        },

        PropertyBagItemConditionsRemover: function (obj, propertyName) {
            function removeConditions(obj, access) {
                if (typeof access == 'string') {
                    access = access.split('.');
                }
                if (access.length > 1) {
                    removeConditions(obj[access.shift()], access);
                } else {
                    if (!obj.hasOwnProperty(access[0])) throw new exceptions.NoSuchPropertyException(propertyName);

                    if (!obj[access[0]].conditions) throw new exceptions.NoSuchPermissionException(permissionKey);

                    delete obj[access[0]].conditions;
                    return;
                }
            }

            removeConditions(obj, propertyName);
        },

        PropertyBagItemOnChangeRemover: function (obj, propertyName, name) {
            function removeOnChange(obj, access) {
                if (typeof access == 'string') {
                    access = access.split('.');
                }
                if (access.length > 1) {
                    removeOnChange(obj[access.shift()], access);
                } else {
                    if (!obj.hasOwnProperty(access[0])) throw new exceptions.NoSuchPropertyException(propertyName);

                    if (!obj[access[0]].onChange[name]) throw new exceptions.HandlerNotFoundException(name);

                    delete obj[access[0]].onChange[name];
                    return;
                }
            }

            removeOnChange(obj, propertyName);
        },

        PropertyBagItemMetaRemover: function (obj, propertyName) {
            function removeOnChange(obj, access) {
                if (typeof access == 'string') {
                    access = access.split('.');
                }
                if (access.length > 1) {
                    removeOnChange(obj[access.shift()], access);
                } else {
                    if (!obj.hasOwnProperty(access[0])) throw new exceptions.NoSuchPropertyException(propertyName);

                    if (!obj[access[0]].meta) throw new exceptions.NoSuchPermissionException(permissionKey);

                    delete obj[access[0]].meta;
                    return;
                }
            }

            removeOnChange(obj, propertyName);
        },

        PropertyBagItemOnCreateRemover: function (obj, propertyName, handlerName) {
            function removeOnCreate(obj, access) {
                if (typeof access == 'string') {
                    access = access.split('.');
                }
                if (access.length > 1) {
                    removeOnCreate(obj[access.shift()], access);
                } else {
                    if (!obj.hasOwnProperty(access[0])) throw new exceptions.NoSuchPropertyException(propertyName);

                    if (!obj[access[0]].onCreate) throw new exceptions.HandlerNotFoundException();
                    if (!obj[access[0]].onCreate[handlerName]) throw new exceptions.HandlerNotFoundException();

                    delete obj[access[0]].onCreate[handlerName];
                    return;
                }
            }

            removeOnCreate(obj, propertyName);
        },

        PropertyBagItemOnDeleteRemover: function (obj, propertyName, name) {
            function removeOnDelete(obj, access) {
                if (typeof access == 'string') {
                    access = access.split('.');
                }
                if (access.length > 1) {
                    removeOnDelete(obj[access.shift()], access);
                } else {
                    if (!obj.hasOwnProperty(access[0])) throw new exceptions.NoSuchPropertyException(propertyName);

                    if (!obj[access[0]].onDelete[name]) throw new exceptions.HandlerNotFoundException(name);

                    delete obj[access[0]].onDelete[name];
                    return;
                }
            }

            removeOnDelete(obj, propertyName);
        },

        PropertyBagItemPermissionRemover: function (obj, propertyName, permissionKey, instance) {
            function removePermission(obj, access) {
                if (typeof access == 'string') {
                    access = access.split('.');
                }
                if (access.length > 1) {
                    removePermission(obj[access.shift()], access);
                } else {
                    if (!obj.hasOwnProperty(access[0])) throw new exceptions.NoSuchPropertyException(propertyName);

                    if (!obj[access[0]].permissions) throw new exceptions.NoSuchPermissionException(permissionKey);
                    if (!obj[access[0]].permissions[permissionKey]) throw new exceptions.NoSuchPermissionException(permissionKey);

                    OBJY.chainPermission(obj, instance, 'x', 'removePropertyPermission', propertyName);

                    delete obj[access[0]].permissions[permissionKey];
                    return;
                }
            }

            removePermission(obj, propertyName);
        },

        PropertyBagItemRemover: function (obj, propertyName, params, instance) {
            var propsObj = obj;

            function getValue(propsObj, access) {
                if (typeof access == 'string') {
                    access = access.split('.');
                }
                if (access.length > 1) {
                    getValue(propsObj[access.shift()], access);
                } else {
                    if (!propsObj.hasOwnProperty(access[0])) throw new exceptions.NoSuchPropertyException(propertyName);

                    if (propsObj[access[0]].onDelete) {
                        if (Object.keys(propsObj[access[0]].onDelete).length > 0) {
                            if (!instance.handlerSequence[propsObj._id]) instance.handlerSequence[obj._id] = {};
                            if (!instance.handlerSequence[propsObj._id].onDelete) instance.handlerSequence[obj._id].onDelete = [];
                            instance.handlerSequence[propsObj._id].onDelete.push(propsObj[access[0]].onDelete);
                        }
                    }

                    OBJY.chainPermission(propsObj[access[0]], instance, 'd', 'removeProperty', propertyName);

                    delete propsObj[access[0]];

                    return;
                }
            }

            getValue(propsObj, propertyName);
        },

        PropertyParser: function (obj, propertyName, instance, params) {
            var app = instance.activeApp;
            var user = instance.activeUser;

            var propsObj = obj;

            var propertyToReturn;

            function getValue(obj, access) {
                var propsObj = obj;

                if (typeof access == 'string') {
                    access = access.split('.');
                }
                if (access.length > 1) {
                    getValue(propsObj[access.shift()], access);
                } else {
                    if (!propsObj.hasOwnProperty(access[0])) throw new exceptions.NoSuchPropertyException(propertyName);

                    propertyToReturn = propsObj[access[0]];
                }
            }

            getValue(propsObj, propertyName);

            if (propertyToReturn.type == 'action') {
                propertyToReturn.call = (callback, client) => {
                    OBJY.checkAuthroisations(obj, user, 'x', app);
                    this.execProcessorAction(propertyToReturn.value || propertyToReturn.action, obj, propertyToReturn, {}, callback, client, {});
                };
            }

            return propertyToReturn;
        },

        ValuePropertyMetaSubstituter: function (property) {
            if (typeof property !== 'undefined') if (typeof property.value === 'undefined') property.value = null;
        },

        PropertyCreateWrapper: function (obj, property, isBag, instance, params, reallyAdd) {
            //if (params.propsObject && !obj[params.propsObject] && !isBag) obj[params.propsObject] = {};

            property = Object.assign({}, property);

            var propsObj = obj;

            var propertyKey = Object.keys(property)[0];

            if (typeof property !== 'object') {
                throw new exceptions.InvalidFormatException();
            }

            /*if (!property[propertyKey].type) {
                obj.properties[propertyKey] = property[propertyKey];
               
                f (typeof property[propertyKey].value === 'string') {
                    if (property[propertyKey].value.length <= 255) property[propertyKey].type = CONSTANTS.PROPERTY.TYPE_SHORTTEXT;
                    else property[propertyKey].type = CONSTANTS.PROPERTY.TYPE_LONGTEXT;
                } else if (typeof property[propertyKey].value === 'boolean')
                    property[propertyKey].type = CONSTANTS.PROPERTY.TYPE_BOOLEAN;
                else property[propertyKey].type = CONSTANTS.PROPERTY.TYPE_SHORTTEXT;
            }*/

            if (reallyAdd && propsObj.hasOwnProperty(propertyKey) && !OBJY.instance.predefinedProperties.includes(propertyKey))
                throw new exceptions.DuplicatePropertyException(propertyKey);

            switch ((property[propertyKey] || {}).type) {
                case undefined:
                    propsObj[propertyKey] = property[propertyKey];
                    break;

                case CONSTANTS$1.PROPERTY.TYPE_SHORTTEXT:
                    propsObj[propertyKey] = property[propertyKey];

                    if (propsObj[propertyKey]?.value) {
                        propsObj[propertyKey].value = propsObj[propertyKey].value + '';
                    }

                    OBJY.ValuePropertyMetaSubstituter(propsObj[propertyKey]);
                    break;

                case CONSTANTS$1.PROPERTY.TYPE_LONGTEXT:
                    propsObj[propertyKey] = property[propertyKey];

                    if (propsObj[propertyKey]?.value) {
                        propsObj[propertyKey].value = propsObj[propertyKey].value + '';
                    }

                    OBJY.ValuePropertyMetaSubstituter(propsObj[propertyKey]);
                    break;

                case CONSTANTS$1.PROPERTY.TYPE_INDEXEDTEXT:
                    propsObj[propertyKey] = property[propertyKey];
                    OBJY.ValuePropertyMetaSubstituter(propsObj[propertyKey]);
                    break;

                case CONSTANTS$1.PROPERTY.TYPE_JSON:
                    if (property[propertyKey].value) {
                        if (typeof property[propertyKey].value === 'string') {
                            try {
                                propsObj[propertyKey].value = JSON.parse(propsObj[propertyKey].value);
                            } catch (e) {
                                //throw new exceptions.InvalidValueException(property[propertyKey].value, CONSTANTS.PROPERTY.TYPE_JSON);
                            }
                        }
                    }
                    propsObj[propertyKey] = property[propertyKey];
                    OBJY.ValuePropertyMetaSubstituter(propsObj[propertyKey]);
                    break;

                case CONSTANTS$1.PROPERTY.TYPE_NUMBER:
                    if (property[propertyKey].value != '') {
                        if (property[propertyKey].value != null)
                            if (isNaN(property[propertyKey].value))
                                throw new exceptions.InvalidValueException(property[propertyKey].value, CONSTANTS$1.PROPERTY.TYPE_NUMBER);
                    }
                    property[propertyKey].value = +property[propertyKey].value;
                    propsObj[propertyKey] = property[propertyKey];
                    OBJY.ValuePropertyMetaSubstituter(propsObj[propertyKey]);
                    break;

                case CONSTANTS$1.PROPERTY.TYPE_EVENT:
                    OBJY.chainPermission(obj, instance, 'evt', 'addProperty (Event)', propertyKey);
                    propsObj[propertyKey] = property[propertyKey];

                    if (!propsObj[propertyKey].eventId) propsObj[propertyKey].eventId = OBJY.ID();

                    if (propsObj[propertyKey].interval !== undefined) {
                        if (propsObj[propertyKey].lastOccurence == undefined) propsObj[propertyKey].lastOccurence = null;
                        else if (!moment(propsObj[propertyKey].lastOccurence).isValid())
                            throw new exceptions.InvalidDateException(propsObj[propertyKey].lastOccurence);
                        else propsObj[propertyKey].lastOccurence = moment(propsObj[propertyKey].lastOccurence).utc().format();

                        if (propsObj[propertyKey].nextOccurence == undefined) propsObj[propertyKey].nextOccurence = moment().toISOString();

                        if (propsObj[propertyKey].action === undefined) propsObj[propertyKey].action = '';

                        if (propsObj[propertyKey].interval === undefined) throw new exceptions.MissingAttributeException('interval');

                        propsObj[propertyKey].nextOccurence = moment(propsObj[propertyKey].lastOccurence || moment().utc())
                            .utc()
                            .add(propsObj[propertyKey].interval)
                            .toISOString();

                        instance.eventAlterationSequence.push({
                            operation: 'add',
                            obj: obj,
                            propName: propertyKey,
                            property: property,
                            date: propsObj[propertyKey].nextOccurence,
                        });
                    } else if (propsObj[propertyKey].date !== undefined) {
                        console.log('EVENTE');
                        if (propsObj[propertyKey].date == null) propsObj[propertyKey].date = moment().utc().toISOString();

                        if (!propsObj[propertyKey].date) throw new exceptions.MissingAttributeException('date');

                        try {
                            propsObj[propertyKey].date = moment(propsObj[propertyKey].date).utc().format();
                        } catch (e) {}

                        console.log('AFSFAASF');
                        propsObj[propertyKey].nextOccurence = propsObj[propertyKey].date;

                        instance.eventAlterationSequence.push({
                            operation: 'add',
                            obj: obj,
                            propName: propertyKey,
                            property: property,
                            date: propsObj[propertyKey].date,
                        });

                        if (!propsObj[propertyKey].action) propsObj[propertyKey].action = '';
                    } else ;

                    break;

                case CONSTANTS$1.PROPERTY.TYPE_DATE:
                    if (!property[propertyKey].value || property[propertyKey].value == '') property[propertyKey].value = null;
                    //else property[propertyKey].value = property[propertyKey];
                    propsObj[propertyKey] = property[propertyKey];
                    OBJY.ValuePropertyMetaSubstituter(propsObj[propertyKey]);
                    break;

                case CONSTANTS$1.PROPERTY.TYPE_SHORTID:
                    if (!property[propertyKey].value || property[propertyKey].value == '') property[propertyKey].value = OBJY.RANDOM();
                    if (obj.role == 'template') property[propertyKey].value = null;
                    propsObj[propertyKey] = property[propertyKey];
                    OBJY.ValuePropertyMetaSubstituter(propsObj[propertyKey]);
                    break;

                case CONSTANTS$1.PROPERTY.TYPE_REF_OBJ:
                    // FOR NOW: no checking for existing object, since callback!!!
                    propsObj[propertyKey] = property[propertyKey];
                    OBJY.ValuePropertyMetaSubstituter(propsObj[propertyKey]);
                    break;

                case CONSTANTS$1.PROPERTY.TYPE_REF_USR:
                    // FOR NOW: no checking for existing object, since callback!!!
                    propsObj[propertyKey] = property[propertyKey];
                    OBJY.ValuePropertyMetaSubstituter(propsObj[propertyKey]);
                    break;

                case CONSTANTS$1.PROPERTY.TYPE_REF_FILE:
                    // FOR NOW: no checking for existing object, since callback!!!
                    propsObj[propertyKey] = property[propertyKey];
                    OBJY.ValuePropertyMetaSubstituter(propsObj[propertyKey]);
                    break;

                case CONSTANTS$1.PROPERTY.TYPE_PROPERTY_BAG:
                    if (!property[propertyKey].properties) property[propertyKey].properties = {};

                    var innerProperties = property[propertyKey][params.propsObject] || property[propertyKey];

                    var propertyKeys = Object.keys(innerProperties);

                    //parentProp = property;

                    obj[propertyKey] = property[propertyKey];
                    obj[propertyKey].type = CONSTANTS$1.PROPERTY.TYPE_PROPERTY_BAG;
                    //obj[propertyKey].properties = {};

                    propertyKeys.forEach(function (property) {
                        var tmpProp = {};
                        tmpProp[property] = innerProperties[property];

                        new OBJY.PropertyCreateWrapper(obj[propertyKey], Object.assign({}, tmpProp), true, instance, params);
                    });

                    break;

                case CONSTANTS$1.PROPERTY.TYPE_ARRAY:
                    if (!property[propertyKey].properties) property[propertyKey].properties = {};

                    var innerProperties = property[propertyKey][params.propsObject] || property[propertyKey];

                    var propertyKeys = Object.keys(innerProperties);

                    propsObj[propertyKey] = {
                        type: CONSTANTS$1.PROPERTY.TYPE_ARRAY,
                        properties: {},
                        query: property[propertyKey].query,
                        meta: property[propertyKey].meta,
                    };

                    propertyKeys.forEach(function (property) {
                        var tmpProp = {};
                        tmpProp[property] = innerProperties[property];

                        new OBJY.PropertyCreateWrapper(propsObj[propertyKey], Object.assign({}, tmpProp), true, instance, params);
                    });

                    break;

                case CONSTANTS$1.PROPERTY.TYPE_BOOLEAN:
                    if (!typeof property[propertyKey].value === 'boolean')
                        throw new exceptions.InvalidValueException(property[propertyKey].value, CONSTANTS$1.PROPERTY.TYPE_BOOLEAN);
                    propsObj[propertyKey] = property[propertyKey];
                    OBJY.ValuePropertyMetaSubstituter(propsObj[propertyKey]);
                    break;

                case CONSTANTS$1.PROPERTY.TYPE_ACTION:
                    OBJY.chainPermission(obj, instance, 'act', 'addProperty (Action)', propertyKey);

                    if (property[propertyKey].value) {
                        if (typeof property[propertyKey].value !== 'string')
                            throw new exceptions.InvalidValueException(property[propertyKey].value, CONSTANTS$1.PROPERTY.TYPE_ACTION);
                    }

                    propsObj[propertyKey] = property[propertyKey];
                    OBJY.ValuePropertyMetaSubstituter(propsObj[propertyKey]);
                    break;
            }

            if ((property[propertyKey] || {}).onCreate) {
                if (Object.keys(property[propertyKey].onCreate).length > 0) {
                    if (!instance.handlerSequence[obj._id]) instance.handlerSequence[obj._id] = {};
                    if (!instance.handlerSequence[obj._id].onCreate) instance.handlerSequence[obj._id].onCreate = [];
                    instance.handlerSequence[obj._id].onCreate.push({
                        handler: property[propertyKey].onCreate,
                        prop: property[propertyKey],
                    });
                }
            }

            if (reallyAdd) OBJY.chainPermission(obj, instance, 'p', 'addProperty', propertyKey);

            /*if(obj.permissions) {
                if(Object.keys(obj.permissions).length > 0)  {
                    if(!instance.permissionSequence[obj._id]) instance.permissionSequence[obj._id] = [];
                        if(!OBJY.checkPermissions(instance.activeUser, instance.activeApp, obj, 'p', true))
                            instance.permissionSequence[obj._id].push({name:'addProperty', key: propertyKey});
                }
            */
        },

        PropertyQuerySetWrapper: function (obj, propertyKey, query, params) {
            var propsObj = obj;

            function setValue(obj, access, value) {
                var propsObj = obj;

                if (typeof access == 'string') {
                    access = access.split('.');
                }
                if (access.length > 1) {
                    setValue(propsObj[access.shift()], access, value);
                } else {
                    //obj[access[0]] = value;
                    if (!propsObj.hasOwnProperty(access[0])) throw new exceptions.NoSuchPropertyException(propertyKey);

                    if (typeof value !== 'object') throw new exceptions.InvalidDataTypeException(value, 'object');

                    propsObj[access[0]].query = query;
                }
            }

            setValue(propsObj, propertyKey, query);
        },

        PropertyMetaSetWrapper: function (obj, propertyKey, meta, params) {
            var propsObj = obj;

            function setMeta(obj, access, meta) {
                var propsObj = obj;
                if (typeof access == 'string') {
                    access = access.split('.');
                }
                if (access.length > 1) {
                    setMeta(propsObj[access.shift()], access, meta);
                } else {
                    if (!propsObj.hasOwnProperty(access[0])) throw new exceptions.NoSuchPropertyException(propertyKey);

                    //if (!obj[access[0]].on) obj[access[0]].on = {};

                    if (propsObj[access[0]].template) propsObj[access[0]].metaOverwritten = true;
                    propsObj[access[0]].meta = meta;
                }
            }

            setMeta(propsObj, propertyKey, meta);
        },

        PropertyOnChangeSetWrapper: function (obj, propertyKey, name, onChange, trigger, type, instance, params) {
            var propsObj = obj;

            function setOnChange(obj, access, onChange) {
                var propsObj = obj;
                if (typeof access == 'string') {
                    access = access.split('.');
                }
                if (access.length > 1) {
                    setOnChange(propsObj[access.shift()], access, onChange);
                } else {
                    if (!propsObj.hasOwnProperty(access[0])) throw new exceptions.NoSuchPropertyException(propertyKey);

                    //if (!obj[access[0]].on) obj[access[0]].on = {};

                    if (!propsObj[access[0]].onChange) propsObj[access[0]].onChange = {};

                    if (!propsObj[access[0]].onChange[name]) propsObj[access[0]].onChange[name] = {};

                    if (propsObj[access[0]].onChange[name].template) propsObj[access[0]].onChange[name].overwritten = true;
                    propsObj[access[0]].onChange[name].value = onChange;
                    propsObj[access[0]].onChange[name].trigger = trigger || 'after';
                    propsObj[access[0]].onChange[name].type = type || 'async';

                    OBJY.chainPermission(propsObj[access[0]], instance, 'w', 'setPropertyOnChangeHandler', name);
                }
            }

            setOnChange(propsObj, propertyKey, onChange);
        },

        PropertyOnCreateSetWrapper: function (obj, propertyKey, name, onCreate, trigger, type, instance, params) {
            var propsObj = obj;

            function setOnCreate(obj, access, onCreate) {
                var propsObj = obj;
                if (typeof access == 'string') {
                    access = access.split('.');
                }
                if (access.length > 1) {
                    setOnCreate(propsObj[access.shift()], access, onCreate);
                } else {
                    //obj[access[0]] = value;

                    if (!propsObj.hasOwnProperty(access[0])) throw new exceptions.NoSuchPropertyException(propertyKey);

                    //if (!obj[access[0]].on) obj[access[0]].on = {};

                    if (!propsObj[access[0]].onCreate) propsObj[access[0]].onCreate = {};

                    if (!propsObj[access[0]].onCreate[name]) propsObj[access[0]].onCreate[name] = {};

                    if (propsObj[access[0]].onCreate[name].templateId) propsObj[access[0]].onCreate[name].overwritten = true;

                    propsObj[access[0]].onCreate[name].value = onCreate;
                    propsObj[access[0]].onCreate[name].trigger = trigger || 'after';
                    propsObj[access[0]].onCreate[name].type = type || 'async';

                    OBJY.chainPermission(propsObj[access[0]], instance, 'v', 'setPropertyOnCreateHandler', name);
                }
            }

            setOnCreate(propsObj, propertyKey, onCreate);
        },

        PropertyOnDeleteSetWrapper: function (obj, propertyKey, name, onDelete, trigger, type, instance, params) {
            var propsObj = obj;

            function setOnDelete(obj, access, onDelete) {
                var propsObj = obj;
                if (typeof access == 'string') {
                    access = access.split('.');
                }
                if (access.length > 1) {
                    setOnDelete(propsObj[access.shift()], access, onDelete);
                } else {
                    if (!propsObj.hasOwnProperty(access[0])) throw new exceptions.NoSuchPropertyException(propertyKey);

                    if (!propsObj[access[0]].onDelete) propsObj[access[0]].onDelete = {};
                    if (!propsObj[access[0]].onDelete[name]) propsObj[access[0]].onDelete[name] = {};

                    if (propsObj[access[0]].onDelete[name].template) propsObj[access[0]].onDelete[name].overwritten = true;
                    propsObj[access[0]].onDelete[name].value = onDelete;
                    propsObj[access[0]].onDelete[name].trigger = trigger || 'after';
                    propsObj[access[0]].onDelete[name].type = type || 'async';

                    OBJY.chainPermission(propsObj[access[0]], instance, 'z', 'setPropertyOnDeleteHandler', name);
                }
            }

            setOnDelete(propsObj, propertyKey, onDelete);
        },

        PropertyConditionsSetWrapper: function (obj, propertyKey, conditions, params) {
            var propsObj = obj;

            function setConditions(obj, access, conditions) {
                var propsObj = obj;
                if (typeof access == 'string') {
                    access = access.split('.');
                }
                if (access.length > 1) {
                    setConditions(propsObj[access.shift()], access, conditions);
                } else {
                    if (!propsObj.hasOwnProperty(access[0])) throw new exceptions.NoSuchPropertyException(propertyKey);

                    propsObj[access[0]].conditions = conditions;
                }
            }

            setConditions(propsObj, propertyKey, conditions);
        },

        PropertyPermissionSetWrapper: function (obj, propertyKey, permission, instance, params) {
            var propsObj = obj;

            function setPermission(obj, access, permission) {
                var propsObj = obj;
                if (typeof access == 'string') {
                    access = access.split('.');
                }
                if (access.length > 1) {
                    setPermission(propsObj[access.shift()], access, permission);
                } else {
                    if (!propsObj.hasOwnProperty(access[0])) throw new exceptions.NoSuchPropertyException(propertyKey);

                    var permissionKey = Object.keys(permission)[0];
                    if (!propsObj[access[0]].permissions) propsObj[access[0]].permissions = {};

                    propsObj[access[0]].permissions[permissionKey] = permission[permissionKey];

                    OBJY.chainPermission(propsObj[access[0]], instance, 'x', 'setPropertyPermission', propertyKey);
                }
            }

            setPermission(propsObj, propertyKey, permission);
        },

        PropertySetWrapper: function (obj, propertyKey, newValue, instance, params) {
            var propsObj = obj;

            function setValue(obj, access, value) {
                var propsObj = obj;

                if (typeof access == 'string') {
                    access = access.split('.');
                }
                if (access.length > 1) {
                    var shift = access.shift();
                    try {
                        if (!propsObj.hasOwnProperty(shift)) throw new exceptions.NoSuchPropertyException(propertyKey);

                        if (propsObj[shift].type) {
                            if (propsObj[shift].type == CONSTANTS$1.PROPERTY.TYPE_PROPERTY_BAG) {
                                if (propsObj[shift].template) propsObj[shift].overwritten = true;
                            }
                            if (propsObj[shift].type == CONSTANTS$1.PROPERTY.TYPE_ARRAY) {
                                if (propsObj[shift].template) propsObj[shift].overwritten = true;
                            }
                        }
                    } catch (e) {}

                    setValue(propsObj[shift], access);
                } else {
                    if (!propsObj.hasOwnProperty(access[0])) throw new exceptions.NoSuchPropertyException(propertyKey);

                    if (propsObj[access[0]].type) {
                        if (propsObj[access[0]].type == 'boolean') {
                            if (typeof newValue != 'boolean') throw new exceptions.InvalidValueException(newValue, propsObj[access[0]].type);
                        }
                        if (propsObj[access[0]].type == 'number') {
                            if (isNaN(newValue)) throw new exceptions.InvalidValueException(newValue, propsObj[access[0]].type);
                        }
                    }

                    if (propsObj[access[0]].template || obj.template) propsObj[access[0]].overwritten = true;

                    propsObj[access[0]].value = newValue;

                    if (propsObj[access[0]].onChange) {
                        if (Object.keys(propsObj[access[0]].onChange).length > 0) {
                            if (!instance.handlerSequence[propsObj._id]) instance.handlerSequence[propsObj._id] = {};
                            if (!instance.handlerSequence[propsObj._id].onChange) instance.handlerSequence[propsObj._id].onChange = [];
                            instance.handlerSequence[propsObj._id].onChange.push({
                                handler: propsObj[access[0]].onChange,
                                prop: propsObj[access[0]],
                            });
                        }
                    }

                    OBJY.chainPermission(propsObj[access[0]], instance, 'u', 'setPropertyValue', propertyKey);
                }
            }

            setValue(propsObj, propertyKey);
        },

        PropertySetFullWrapper: function (obj, propertyKey, newValue, instance, force, params) {
            var propsObj = obj;

            function setValue(obj, access, value) {
                var propsObj = obj;

                if (typeof access == 'string') {
                    access = access.split('.');
                }
                if (access.length > 1) {
                    var shift = access.shift();
                    try {
                        if (propsObj[shift].type) {
                            if (propsObj[shift].type == CONSTANTS$1.PROPERTY.TYPE_PROPERTY_BAG) {
                                if (propsObj[shift].template) propsObj[shift].overwritten = true;
                            }
                            if (propsObj[shift].type == CONSTANTS$1.PROPERTY.TYPE_ARRAY) {
                                if (propsObj[shift].template) propsObj[shift].overwritten = true;
                            }
                        }
                    } catch (e) {}

                    setValue(propsObj[shift], access);
                } else {
                    //if (!propsObj.hasOwnProperty(access[0])) throw new exceptions.NoSuchPropertyException(propertyKey);

                    if ((propsObj[access[0]] || {}).type == 'boolean') {
                        if (typeof newValue != 'boolean') throw new exceptions.InvalidValueException(newValue, (propsObj[access[0]] || {}).type);
                    }
                    if ((propsObj[access[0]] || {}).type == 'number') {
                        if (isNaN(newValue)) throw new exceptions.InvalidValueException(newValue, (propsObj[access[0]] || {}).type);
                    }

                    if ((propsObj[access[0]] || {}).template) propsObj[access[0]].overwritten = true;
                    propsObj[access[0]] = newValue;

                    if (propsObj[access[0]].onChange) {
                        if (Object.keys(propsObj[access[0]].onChange).length > 0) {
                            if (!instance.handlerSequence[propsObj._id]) instance.handlerSequence[propsObj._id] = {};
                            if (!instance.handlerSequence[propsObj._id].onChange) instance.handlerSequence[propsObj._id].onChange = [];
                            instance.handlerSequence[propsObj._id].onChange.push({
                                handler: propsObj[access[0]].onChange,
                                prop: propsObj[access[0]],
                            });
                        }
                    }

                    OBJY.chainPermission(propsObj[access[0]], instance, 'u', 'setProperty', propertyKey);
                }
            }

            setValue(propsObj, propertyKey);
        },

        EventIntervalSetWrapper: function (obj, propertyKey, newValue, client, instance, params) {
            var propsObj = obj;

            var prop = obj.getProperty(propertyKey);

            if (prop.type != CONSTANTS$1.PROPERTY.TYPE_EVENT) throw new exceptions.NotAnEventException(propertyKey);

            function setValue(obj, access, value) {
                var propsObj = obj;
                if (typeof access == 'string') {
                    access = access.split('.');
                }
                if (access.length > 1) {
                    var shift = access.shift();
                    try {
                        if (propsObj[shift].type) {
                            if (propsObj[shift].type == CONSTANTS$1.PROPERTY.TYPE_PROPERTY_BAG) {
                                if (propsObj[shift].template) propsObj[shift].overwritten = true;
                            }
                            if (propsObj[shift].type == CONSTANTS$1.PROPERTY.TYPE_ARRAY) {
                                if (propsObj[shift].template) propsObj[shift].overwritten = true;
                            }
                        }
                    } catch (e) {}

                    setValue(propsObj[shift], access);
                } else {
                    if (!propsObj.hasOwnProperty(access[0])) throw new exceptions.NoSuchPropertyException(propertyKey);

                    if (propsObj[access[0]].template) propsObj[access[0]].overwritten = true;

                    delete propsObj[access[0]].date;
                    propsObj[access[0]].interval = newValue;

                    if (propsObj[access[0]].lastOccurence) {
                        var nextOccurence = moment(propsObj[access[0]].lastOccurence).utc().add(newValue);
                        instance.eventAlterationSequence.push({
                            operation: 'remove',
                            obj: obj,
                            propName: propertyKey,
                            property: propsObj[access[0]],
                            date: nextOccurence,
                        });
                        instance.eventAlterationSequence.push({
                            operation: 'add',
                            obj: obj,
                            propName: propertyKey,
                            property: propsObj[access[0]],
                            date: nextOccurence,
                        });
                    }

                    OBJY.chainPermission(propsObj[access[0]], instance, 'u', 'setEventInterval', propertyKey);
                }
            }

            setValue(propsObj, propertyKey);
        },

        EventTriggeredSetWrapper: function (obj, propertyKey, newValue, client, params) {
            var propsObj = obj;

            var prop = obj.getProperty(propertyKey);

            if (prop.type != CONSTANTS$1.PROPERTY.TYPE_EVENT) throw new exceptions.NotAnEventException(propertyKey);

            function setValue(obj, access, value) {
                var propsObj = obj;
                if (typeof access == 'string') {
                    access = access.split('.');
                }

                if (access.length > 1) {
                    var shift = access.shift();
                    try {
                        if (propsObj[shift].type) {
                            if (propsObj[shift].type == CONSTANTS$1.PROPERTY.TYPE_PROPERTY_BAG) {
                                if (propsObj[shift].template) propsObj[shift].overwritten = true;
                            }
                            if (propsObj[shift].type == CONSTANTS$1.PROPERTY.TYPE_ARRAY) {
                                if (propsObj[shift].template) propsObj[shift].overwritten = true;
                            }
                        }
                    } catch (e) {}

                    setValue(propsObj[shift], access);
                } else {
                    if (!propsObj.hasOwnProperty(access[0])) throw new exceptions.NoSuchPropertyException(propertyKey);

                    if (propsObj[access[0]].interval) propsObj[access[0]].nextOccurence = moment().utc().add(propsObj[access[0]].interval).toISOString();
                    else propsObj[access[0]].triggered = newValue;
                    //obj[access[0]].overwritten = true;
                }
            }

            setValue(propsObj, propertyKey);
        },

        EventLastOccurenceSetWrapper: function (obj, propertyKey, newValue, client, params) {
            var propsObj = obj;

            var prop = obj.getProperty(propertyKey);

            if (prop.type != CONSTANTS$1.PROPERTY.TYPE_EVENT) throw new exceptions.NotAnEventException(propertyKey);

            function setValue(obj, access, value) {
                var propsObj = obj;
                if (typeof access == 'string') {
                    access = access.split('.');
                }
                if (access.length > 1) {
                    var shift = access.shift();
                    try {
                        if (propsObj[shift].type) {
                            if (propsObj[shift].type == CONSTANTS$1.PROPERTY.TYPE_PROPERTY_BAG) {
                                if (propsObj[shift].template) propsObj[shift].overwritten = true;
                            }
                            if (propsObj[shift].type == CONSTANTS$1.PROPERTY.TYPE_ARRAY) {
                                if (propsObj[shift].template) propsObj[shift].overwritten = true;
                            }
                        }
                    } catch (e) {}

                    setValue(propsObj[shift], access);
                } else {
                    if (!propsObj.hasOwnProperty(access[0])) throw new exceptions.NoSuchPropertyException(propertyKey);

                    propsObj[access[0]].lastOccurence = newValue;

                    propsObj[access[0]].nextOccurence = moment(newValue).utc().add(moment.duration(propsObj[access[0]].interval)).toISOString();
                }
            }

            setValue(propsObj, propertyKey);
        },

        EventDateSetWrapper: function (obj, propertyKey, newValue, client, instance, params) {
            var propsObj = obj;

            function setValue(obj, access, value) {
                var propsObj = obj;
                if (typeof access == 'string') {
                    access = access.split('.');
                }
                if (access.length > 1) {
                    var shift = access.shift();
                    try {
                        if (propsObj[shift].type) {
                            if (propsObj[shift].type == CONSTANTS$1.PROPERTY.TYPE_PROPERTY_BAG) {
                                if (propsObj[shift].template) propsObj[shift].overwritten = true;
                            }
                            if (propsObj[shift].type == CONSTANTS$1.PROPERTY.TYPE_ARRAY) {
                                if (propsObj[shift].template) propsObj[shift].overwritten = true;
                            }
                        }
                    } catch (e) {}

                    setValue(propsObj[shift], access);
                } else {
                    if (!propsObj.hasOwnProperty(access[0])) throw new exceptions.NoSuchPropertyException(propertyKey);

                    if (propsObj[access[0]].template) propsObj[access[0]].overwritten = true;
                    delete propsObj[access[0]].interval;
                    delete propsObj[access[0]].lastOccurence;
                    delete propsObj[access[0]].nextOccurence;
                    propsObj[access[0]].date = newValue;

                    instance.eventAlterationSequence.push({
                        operation: 'remove',
                        obj: obj,
                        propName: propertyKey,
                        property: propsObj[access[0]],
                        date: newValue,
                    });
                    instance.eventAlterationSequence.push({
                        operation: 'add',
                        obj: obj,
                        propName: propertyKey,
                        property: propsObj[access[0]],
                        date: newValue,
                    });

                    OBJY.chainPermission(propsObj[access[0]], instance, 'u', 'setEventDate', propertyKey);
                }
            }

            setValue(propsObj, propertyKey);
        },

        EventActionSetWrapper: function (obj, propertyKey, newValue, client, instance, params) {
            var propsObj = obj;

            function setValue(obj, access, value) {
                var propsObj = obj;

                if (typeof access == 'string') {
                    access = access.split('.');
                }
                if (access.length > 1) {
                    var shift = access.shift();
                    try {
                        if (propsObj[shift].type) {
                            if (propsObj[shift].type == CONSTANTS$1.PROPERTY.TYPE_PROPERTY_BAG) {
                                if (propsObj[shift].template) propsObj[shift].overwritten = true;
                            }
                            if (propsObj[shift].type == CONSTANTS$1.PROPERTY.TYPE_ARRAY) {
                                if (propsObj[shift].template) propsObj[shift].overwritten = true;
                            }
                        }
                    } catch (e) {}

                    setValue(propsObj[shift], access);
                } else {
                    if (!propsObj.hasOwnProperty(access[0])) throw new exceptions.NoSuchPropertyException(propertyKey);

                    if (propsObj[access[0]].template) propsObj[access[0]].overwritten = true;

                    propsObj[access[0]].action = newValue;

                    OBJY.chainPermission(propsObj[access[0]], instance, 'u', 'setEventAction', propertyKey);

                    //instance.eventAlterationSequence.push({ operation: 'remove', obj: obj, propName: propertyKey, property: obj[access[0]], date: newValue })
                    //instance.eventAlterationSequence.push({ operation: 'add', obj: obj, propName: propertyKey, property: obj.properties[access[0]], date: newValue })
                }
            }

            setValue(propsObj, propertyKey);
        },
    };
}

function pluralConstructorFunctions (OBJY) {
    return {
        Objs: function (objs, role, instance, params, flags) {
            if (typeof objs === 'object' && !Array.isArray(objs)) {
                var flags = flags || {};

                Object.keys(objs).forEach(function (oK) {
                    if (['$page', '$sort', '$pageSize'].indexOf(oK) != -1) {
                        flags[oK] = objs[oK];
                        delete objs[oK];
                    }
                });

                objs = OBJY.buildAuthroisationQuery(objs, instance.activeUser, 'r', instance.activeApp, instance);

                if (instance.activeUser) objs = OBJY.buildPermissionQuery(objs, instance.activeUser, instance.activeApp, instance);

                Object.getPrototypeOf(this).get = function (success, error, _client, _app) {
                    return new Promise((resolve, reject) => {
                        var client = _client || instance.activeTenant;
                        var app = _app || instance.activeApp;
                        var allCounter = 0;

                        OBJY.findObjects(
                            objs,
                            role,
                            function (data) {
                                var i;
                                for (i = 0; i < data.length; i++) {
                                    if (OBJY[data[i].role]) data[i] = OBJY[data[i].role](OBJY.deserialize(data[i]));
                                }

                                // TODO : change!!!

                                if (params.templateMode == CONSTANTS$1.TEMPLATEMODES.STRICT) {
                                    if (success) success(OBJY.deSerializePropsObjectMulti(data, params));
                                    else {
                                        resolve(OBJY.deSerializePropsObjectMulti(data, params));
                                    }
                                    return;
                                }

                                if (data.length == 0) {
                                    //console.info(data)

                                    if (success) success(OBJY.deSerializePropsObjectMulti(data, params));
                                    else {
                                        resolve(OBJY.deSerializePropsObjectMulti(data, params));
                                    }
                                    return;
                                }

                                data.forEach(function (d) {
                                    OBJY.applyAffects(d, null, instance, client);

                                    if (!d.inherits) d.inherits = [];

                                    /*d.inherits = d.inherits.filter(function(item, pos) {
                                return d.inherits.indexOf(item) == pos;
                            });*/

                                    var counter = 0;

                                    if (d.inherits.length == 0) {
                                        allCounter++;

                                        if (allCounter == data.length) {
                                            if (success) success(OBJY.deSerializePropsObjectMulti(data, params));
                                            else {
                                                resolve(OBJY.deSerializePropsObjectMulti(data, params));
                                            }
                                            return d;
                                        }
                                    }

                                    d.inherits.forEach(function (template) {
                                        if (d._id != template) {
                                            OBJY.getTemplateFieldsForObject(
                                                d,
                                                template,
                                                function () {
                                                    counter++;

                                                    if (counter == d.inherits.length) allCounter++;

                                                    if (allCounter == data.length) {
                                                        if (success) success(OBJY.deSerializePropsObjectMulti(data, params));
                                                        else {
                                                            resolve(OBJY.deSerializePropsObjectMulti(data, params));
                                                        }
                                                        return d;
                                                    }
                                                },
                                                function (err) {
                                                    counter++;

                                                    if (counter == d.inherits.length) allCounter++;

                                                    if (allCounter == data.length) {
                                                        if (success) success(OBJY.deSerializePropsObjectMulti(data, params));
                                                        else {
                                                            resolve(OBJY.deSerializePropsObjectMulti(data, params));
                                                        }
                                                        return d;
                                                    }
                                                },
                                                client,
                                                params.templateFamily,
                                                params.templateSource,
                                                params,
                                                instance
                                            );
                                        } else {
                                            if (d.inherits.length == 1) {
                                                if (success) success(OBJY.deSerializePropsObjectMulti(data, params));
                                                else {
                                                    resolve(OBJY.deSerializePropsObjectMulti(data, params));
                                                }
                                                return d;
                                            } else {
                                                counter++;
                                                return;
                                            }
                                        }
                                    });
                                });
                            },
                            function (err) {
                                if (error) error(err);
                                else {
                                    reject(err);
                                }
                            },
                            app,
                            client,
                            flags || {},
                            params,
                            instance
                        );
                    });
                };

                Object.getPrototypeOf(this).count = function (success, error) {
                    return new Promise((resolve, reject) => {
                        var client = instance.activeTenant;
                        var app = instance.activeApp;

                        OBJY.countObjects(
                            objs,
                            role,
                            function (data) {
                                if (success) success(data);
                                else {
                                    resolve(data);
                                }
                            },
                            function (err) {
                                if (error) error(err);
                                else {
                                    reject(err);
                                }
                            },
                            app,
                            client,
                            flags || {},
                            params,
                            instance
                        );

                        return;
                    });
                };
            } else if (Array.isArray(objs)) {
                Object.getPrototypeOf(this).add = function (success, error) {
                    return new Promise((resolve, reject) => {
                        var client = instance.activeTenant;
                        instance.activeApp;

                        var i;
                        var allCounter = 0;
                        for (i = 0; i < objs.length; i++) {
                            objs[i] = OBJY[role](objs[i]).add(
                                function (data) {
                                    OBJY.applyAffects(data, 'onCreate', instance, client);

                                    if (params.templateMode == CONSTANTS$1.TEMPLATEMODES.STRICT) {
                                        var counter = 0;

                                        if (data.inherits.length == 0) {
                                            allCounter++;
                                            if (allCounter == objs.length) {
                                                if (success) success(objs);
                                                else {
                                                    resolve(objs);
                                                }
                                                return data;
                                            }
                                        }

                                        data.inherits.forEach(function (template) {
                                            if (data._id != template) {
                                                OBJY.getTemplateFieldsForObject(
                                                    data,
                                                    template,
                                                    function () {
                                                        counter++;

                                                        if (counter == data.inherits.length) allCounter++;

                                                        if (allCounter == objs.length) {
                                                            if (success) success(objs);
                                                            else {
                                                                resolve(objs);
                                                            }
                                                            return data;
                                                        }
                                                    },
                                                    function (err) {
                                                        if (error) error(err);
                                                        else {
                                                            reject(err);
                                                        }
                                                        return data;
                                                    },
                                                    client,
                                                    params.templateFamily,
                                                    params.templateSource,
                                                    params,
                                                    instance
                                                );
                                            } else {
                                                if (data.inherits.length == 1) {
                                                    if (success) success(objs);
                                                    else {
                                                        resolve(objs);
                                                    }
                                                    return data;
                                                } else {
                                                    counter++;
                                                    return;
                                                }
                                            }
                                        });
                                    } else {
                                        allCounter++;
                                        if (allCounter == objs.length) {
                                            if (success) success(objs);
                                            else {
                                                resolve(objs);
                                            }
                                            return data;
                                        }
                                    }
                                },
                                function (err) {
                                    //counter++;
                                    /*if (objs.length == counter)*/
                                    if (error) error(err);
                                    else {
                                        reject(err);
                                    }
                                }
                            );
                        }
                    });
                };

                return this;
            } else {
                if (params.authMethod) Object.getPrototypeOf(this).auth = params.authMethod;
                else {
                    Object.getPrototypeOf(this).auth = function (userObj, callback, error, client, app) {
                        return new Promise((resolve, reject) => {
                            var query = { username: userObj.username };

                            if (instance.authableFields) {
                                query = { $or: [] };
                                instance.authableFields.forEach(function (field) {
                                    var f = {};
                                    f[field] = userObj[field];
                                    if (f[field]) query.$or.push(f);
                                });
                                if (Object.keys(query.$or).length == 0) query = { username: userObj.username };
                            }

                            instance[params.pluralName](query).get(
                                function (data) {
                                    if (data.length == 0) error('User not found');

                                    if (callback) callback(data[0]);
                                    else {
                                        resolve(data[0]);
                                    }
                                },
                                function (err) {
                                    if (error) error(err);
                                    else {
                                        reject(err);
                                    }
                                },
                                client,
                                app
                            );
                        });
                    };
                }
            }
        },
    };
}

var isObject = function (a) {
    return !!a && a.constructor === Object;
};

function singularConstructorFunctions (OBJY) {
    return {
        Obj: function (obj, role, instance, params) {
            if (instance.metaPropPrefix != '' && typeof obj !== 'string') obj = OBJY.serialize(obj);

            if (!obj) obj = {}; //throw new Error("Invalid param");

            if (obj._id) this._id = obj._id;

            if (typeof obj === 'string') {
                this._id = obj;
            }

            if (obj === undefined) obj = {};

            this.role = role || 'object';

            if (typeof obj === 'object') {
                obj.role = role;
            }

            if (params.extendedStructure) {
                for (var prop in params.extendedStructure) {
                    if (obj[prop] || params.extendedStructure[prop] === null) this[prop] = obj[prop];
                    else this[prop] = params.extendedStructure[prop];

                    if (!OBJY.instance.predefinedProperties.includes(prop)) OBJY.instance.predefinedProperties.push(prop);
                }
            }

            if (params.hasAffects) {
                this.affects = OBJY.AffectsCreateWrapper(this, obj.affects, instance);
                this.apply = OBJY.ApplyCreateWrapper(this, obj.apply, instance);
            }

            this._constraints = obj._constraints;

            //@TODO: DEPRECATE THIS!
            // this.type = obj.type;

            this.applications = OBJY.ApplicationsChecker(this, obj.applications); // || [];

            this.inherits = OBJY.InheritsChecker(this, obj.inherits); // || [];

            //@TODO: DEPRECATE THIS!
            // this.name = obj.name; // || null;

            this.onCreate = OBJY.ObjectOnCreateCreateWrapper(this, obj.onCreate, instance);
            this.onChange = OBJY.ObjectOnChangeCreateWrapper(this, obj.onChange, instance);
            this.onDelete = OBJY.ObjectOnDeleteCreateWrapper(this, obj.onDelete, instance);

            this.created = obj.created || moment().utc().toDate().toISOString();
            this.lastModified = obj.lastModified || moment().utc().toDate().toISOString();

            //this.properties = OBJY.PropertiesChecker(this, obj.properties, instance); // || {};
            OBJY.PropertiesChecker(this, obj, instance, params);

            this.permissions = OBJY.ObjectPermissionsCreateWrapper(this, obj.permissions); // || {};

            this._aggregatedEvents = obj._aggregatedEvents;

            this.authorisations = obj.authorisations || undefined;

            if (params.authable) {
                this.username = obj.username || null;
                this.email = obj.email || null;
                this.password = obj.password || null;

                this.spooAdmin = obj.spooAdmin;

                delete this.name;

                this.setUsername = function (username) {
                    this.username = username;
                    OBJY.chainPermission(this, instance, 'o', 'setUsername', username);
                    instance.alterSequence.push({ setUsername: arguments });
                    return this;
                };

                this.setEmail = function (email) {
                    this.email = email;
                    OBJY.chainPermission(this, instance, 'h', 'setEmail', email);
                    instance.alterSequence.push({ setEmail: arguments });
                    return this;
                };

                this.setPassword = function (password) {
                    // should be encrypted at this point
                    this.password = password;
                    instance.alterSequence.push({ setPassword: arguments });
                    return this;
                };

                this.setAuthorisation = function (authorisationObj) {
                    new OBJY.ObjectAuthorisationSetWrapper(this, authorisationObj, instance);
                    instance.alterSequence.push({ setAuthorisation: arguments });
                    return this;
                };

                this.removeAuthorisation = function (authorisationId) {
                    new OBJY.ObjectAuthorisationRemoveWrapper(this, authorisationId, instance);
                    instance.alterSequence.push({ removeAuthorisation: arguments });
                    return this;
                };
            }

            // TODO: explain this!
            if (params.authable || params.authableTemplate) {
                this.privileges = OBJY.PrivilegesChecker(obj) || {};
                this._clients = obj._clients;

                this.addPrivilege = function (privilege) {
                    if (instance.activeApp) {
                        var tmpPriv = {};
                        tmpPriv[instance.activeApp] = { name: privilege };
                        new OBJY.PrivilegeChecker(this, tmpPriv);
                        instance.alterSequence.push({ addPrivilege: arguments });
                        return this;
                    } else throw new exceptions.General('Invalid app id');
                };

                this.removePrivilege = function (privilege) {
                    new OBJY.PrivilegeRemover(this, privilege, instance);
                    instance.alterSequence.push({ removePrivilege: arguments });
                    return this;
                };

                this.addClient = function (client) {
                    if (this._clients.indexOf(client) != -1) throw new exceptions.General('Client ' + client + ' already exists');
                    this._clients.push(client);
                    instance.alterSequence.push({ addClient: arguments });
                    return this;
                };

                this.removeClient = function (client) {
                    if (this._clients.indexOf(client) == -1) throw new exceptions.General('Client ' + client + ' does not exist');
                    this._clients.splice(this._clients.indexOf(client), 1);
                    instance.alterSequence.push({ removeClient: arguments });
                    return this;
                };
            }

            /* this.props = function(properties) {
                 this.properties = OBJY.PropertiesChecker(this, properties, instance) || {};
                 return this;
             };*/

            Object.getPrototypeOf(this).addInherit = function (templateId) {
                OBJY.addTemplateToObject(this, templateId, instance);

                instance.alterSequence.push({ addInherit: arguments });

                return this;
            };

            Object.getPrototypeOf(this).removeInherit = function (templateId, success, error) {
                OBJY.removeTemplateFromObject(
                    this,
                    templateId,
                    function (data) {
                        if (success) success(templateId);
                    },
                    function (err) {
                        if (error) error(err);
                    },
                    instance
                );

                instance.alterSequence.push({ removeInherit: arguments });

                return this;
            };

            Object.getPrototypeOf(this).addApplication = function (application) {
                OBJY.addApplicationToObject(this, application, instance);

                instance.alterSequence.push({ addApplication: arguments });

                return this;
            };

            Object.getPrototypeOf(this).removeApplication = function (application) {
                OBJY.removeApplicationFromObject(this, application, instance);

                instance.alterSequence.push({ removeApplication: arguments });

                return this;
            };

            Object.getPrototypeOf(this).replace = function (newObj) {
                newObj = OBJY[this.role](newObj);

                var self = this;

                if (self.role != newObj.role) throw new exceptions.General('cannot alter role');

                Object.keys(this).forEach(function (k) {
                    if (self[k] instanceof Function || k == '_id') return;
                    delete self[k];
                });

                function doTheProps(self, o) {
                    Object.keys(o).forEach(function (k) {
                        if (o[k] == null || o[k] === undefined) return;

                        self[k] = o[k];
                        if (typeof o[k] === 'object') {
                            doTheProps(self[k], o[k]);
                        }
                    });
                }

                doTheProps(self, newObj);

                return self;

                //OBJY.prepareObjectDelta(this, newObj);
            };

            Object.getPrototypeOf(this).addProperty = function (name, property) {
                var prop = {};
                prop[name] = property;
                property = prop;

                var propertyKey = name;
                Object.keys(property)[0];
                if (propertyKey.indexOf('.') != -1) {
                    var lastDot = propertyKey.lastIndexOf('.');
                    var bag = propertyKey.substring(0, lastDot);
                    var newProKey = propertyKey.substring(lastDot + 1, propertyKey.length);
                    var newProp = {};
                    newProp[newProKey] = property[propertyKey];

                    this.addPropertyToBag(bag, newProp);
                    //new OBJY.PropertyCreateWrapper(this[bag], prop, false, instance, params, true);

                    instance.alterSequence.push({ addProperty: arguments });

                    return this;
                }

                new OBJY.PropertyCreateWrapper(this, property, false, instance, params, true);

                instance.alterSequence.push({ addProperty: arguments });
                return this;
            };

            Object.getPrototypeOf(this).setOnChange = function (name, onChangeObj) {
                if (typeof onChangeObj !== 'object') throw new exceptions.InvalidArgumentException();
                var key = name;

                new OBJY.ObjectOnChangeSetWrapper(this, key, onChangeObj.value, onChangeObj.trigger, onChangeObj.type, instance);

                instance.alterSequence.push({ setOnChange: arguments });

                return this;
            };

            Object.getPrototypeOf(this).setOnDelete = function (name, onDeleteObj) {
                if (typeof onDeleteObj !== 'object') throw new exceptions.InvalidArgumentException();
                var key = name;

                new OBJY.ObjectOnDeleteSetWrapper(this, key, onDeleteObj.value, onDeleteObj.trigger, onDeleteObj.type, instance);

                instance.alterSequence.push({ setOnDelete: arguments });

                return this;
            };

            Object.getPrototypeOf(this).setOnCreate = function (name, onCreateObj) {
                if (typeof onCreateObj !== 'object') throw new exceptions.InvalidArgumentException();
                var key = name;

                new OBJY.ObjectOnCreateSetWrapper(this, key, onCreateObj.value, onCreateObj.trigger, onCreateObj.type, instance);

                instance.alterSequence.push({ setOnCreate: arguments });

                return this;
            };

            Object.getPrototypeOf(this).removeOnChange = function (name) {
                if (!this.onChange[name]) throw new exceptions.HandlerNotFoundException(name);
                else delete this.onChange[name];
                instance.alterSequence.push({ removeOnChange: arguments });
                return this;
            };

            Object.getPrototypeOf(this).removeOnDelete = function (name) {
                if (!this.onDelete[name]) throw new exceptions.HandlerNotFoundException(name);
                else delete this.onDelete[name];
                instance.alterSequence.push({ removeOnDelete: arguments });
                return this;
            };

            Object.getPrototypeOf(this).removeOnCreate = function (name) {
                if (!this.onCreate[name]) throw new exceptions.HandlerNotFoundException(name);
                else delete this.onCreate[name];
                instance.alterSequence.push({ removeOnCreate: arguments });
                return this;
            };

            Object.getPrototypeOf(this).setPermission = function (name, permission) {
                var perm = {};
                perm[name] = permission;
                permission = perm;

                new OBJY.ObjectPermissionSetWrapper(this, permission, instance);
                instance.alterSequence.push({ setPermission: arguments });
                return this;
            };

            Object.getPrototypeOf(this).removePermission = function (permission) {
                new OBJY.ObjectPermissionRemoveWrapper(this, permission, instance);
                instance.alterSequence.push({ removePermission: arguments });
                return this;
            };

            Object.getPrototypeOf(this).setPropertyValue = function (property, value, client) {
                new OBJY.PropertySetWrapper(this, property, value, instance, params);
                instance.alterSequence.push({ setPropertyValue: arguments });

                return this;
            };

            Object.getPrototypeOf(this).setProperty = function (property, value, client) {
                new OBJY.PropertySetFullWrapper(this, property, value, instance, false, params);
                instance.alterSequence.push({ setProperty: arguments });
                return this;
            };

            Object.getPrototypeOf(this).makeProperty = function (property, value, client) {
                new OBJY.PropertySetFullWrapper(this, property, value, instance, true, params);
                instance.alterSequence.push({ makeProperty: arguments });
                return this;
            };

            Object.getPrototypeOf(this).setEventDate = function (property, value, client) {
                var propertyKey = Object.keys(property)[0];
                if (propertyKey.indexOf('.') != -1) {
                    var lastDot = propertyKey.lastIndexOf('.');
                    var bag = propertyKey.substring(0, lastDot);
                    var newProKey = propertyKey.substring(lastDot + 1, propertyKey.length);
                    this.setBagEventDate(bag, newProKey, value, client);
                    return;
                }

                new OBJY.EventDateSetWrapper(this, property, value, client, instance, params);
                instance.alterSequence.push({ setEventDate: arguments });
                return this;
            };

            Object.getPrototypeOf(this).setEventAction = function (property, value, client) {
                var propertyKey = Object.keys(property)[0];
                if (propertyKey.indexOf('.') != -1) {
                    var lastDot = propertyKey.lastIndexOf('.');
                    var bag = propertyKey.substring(0, lastDot);
                    var newProKey = propertyKey.substring(lastDot + 1, propertyKey.length);
                    this.setBagEventAction(bag, newProKey, value, client);
                    return;
                }

                new OBJY.EventActionSetWrapper(this, property, value, client, instance, params);
                instance.alterSequence.push({ setEventAction: arguments });
                return this;
            };

            Object.getPrototypeOf(this).setEventTriggered = function (property, value, client) {
                var propertyKey = Object.keys(property)[0];
                if (propertyKey.indexOf('.') != -1) {
                    var lastDot = propertyKey.lastIndexOf('.');
                    var bag = propertyKey.substring(0, lastDot);
                    var newProKey = propertyKey.substring(lastDot + 1, propertyKey.length);
                    this.setBagEventTriggered(bag, newProKey, value, client);
                    return;
                }

                new OBJY.EventTriggeredSetWrapper(this, property, value, client, instance, params);
                instance.alterSequence.push({ setEventTriggered: arguments });
                return this;
            };

            Object.getPrototypeOf(this).setEventLastOccurence = function (property, value, client) {
                var propertyKey = Object.keys(property)[0];
                if (propertyKey.indexOf('.') != -1) {
                    var lastDot = propertyKey.lastIndexOf('.');
                    var bag = propertyKey.substring(0, lastDot);
                    var newProKey = propertyKey.substring(lastDot + 1, propertyKey.length);
                    this.setBagEventLastOccurence(bag, newProKey, value, client);
                    return;
                }

                new OBJY.EventLastOccurenceSetWrapper(this, property, value, client, params);
                instance.alterSequence.push({ setEventLastOccurence: arguments });
                return this;
            };

            Object.getPrototypeOf(this).setEventInterval = function (property, value, client) {
                var propertyKey = Object.keys(property)[0];
                if (propertyKey.indexOf('.') != -1) {
                    var lastDot = propertyKey.lastIndexOf('.');
                    var bag = propertyKey.substring(0, lastDot);
                    var newProKey = propertyKey.substring(lastDot + 1, propertyKey.length);
                    this.setBagEventInterval(bag, newProKey, value, client);
                    return;
                }

                new OBJY.EventIntervalSetWrapper(this, property, value, client, instance, params);
                instance.alterSequence.push({ setEventInterval: arguments });
                return this;
            };

            Object.getPrototypeOf(this).pushToArray = function (array, value) {
                var propKey = Object.keys(value)[0];
                var tmpProp = {};
                var tmpName;
                tmpName = shortid.generate();

                tmpProp[tmpName] = value[propKey];

                this.addPropertyToBag(array, tmpProp);
                instance.alterSequence.push({ pushToArray: arguments });
            };

            Object.getPrototypeOf(this).setPropertyPermission = function (property, name, permission) {
                var perm = {};
                perm[name] = permission;
                permission = perm;

                new OBJY.PropertyPermissionSetWrapper(this, property, permission, instance, params);
                instance.alterSequence.push({ setPropertyPermission: arguments });
                return this;
            };

            Object.getPrototypeOf(this).setPropertyOnCreate = function (property, name, onCreateObj) {
                if (typeof onCreateObj !== 'object') throw new exceptions.InvalidArgumentException();
                var key = name;

                new OBJY.PropertyOnCreateSetWrapper(this, property, key, onCreateObj.value, onCreateObj.trigger, onCreateObj.type, instance, params);
                instance.alterSequence.push({ setPropertyOnCreate: arguments });
                return this;
            };

            Object.getPrototypeOf(this).removePropertyOnCreate = function (propertyName, handlerName) {
                if (propertyName.indexOf('.') != -1) {
                    this.removePropertyOnCreateFromBag(propertyName, handlerName);
                    return;
                } else {
                    if (!this[propertyName]) throw new exceptions.NoSuchPropertyException(propertyName);
                    if (!this[propertyName].onCreate) throw new exceptions.NoOnCreateException(); // CHANGE!!!
                    if (!this[propertyName].onCreate[handlerName]) throw new exceptions.NoOnCreateException(); // CHANGE!!!
                    delete this[propertyName].onCreate[propertyName];
                }

                instance.alterSequence.push({ removePropertyOnCreate: arguments });

                return this;
            };

            Object.getPrototypeOf(this).removePropertyOnCreateFromBag = function (property, handlerName) {
                this.getProperty(property);
                if (this.role == 'template') ;
                new OBJY.PropertyBagItemOnCreateRemover(this, property, handlerName);
                instance.alterSequence.push({ removePropertyOnCreateFromBag: arguments });
                return this;
            };

            Object.getPrototypeOf(this).setPropertyMeta = function (property, meta) {
                new OBJY.PropertyMetaSetWrapper(this, property, meta, params);
                instance.alterSequence.push({ setPropertyMeta: arguments });
                return this;
            };

            Object.getPrototypeOf(this).removePropertyMetaFromBag = function (property) {
                this.getProperty(property);
                if (this.role == 'template') ;
                new OBJY.PropertyBagItemMetaRemover(this, property);

                return this;
            };

            Object.getPrototypeOf(this).removePropertyMeta = function (propertyName) {
                if (propertyName.indexOf('.') != -1) {
                    this.removePropertyMetaFromBag(propertyName);
                    return;
                } else {
                    if (!this[propertyName]) throw new exceptions.NoSuchPropertyException(propertyName);
                    if (!this[propertyName].meta) throw new exceptions.NoMetaException(); // CHANGE!!!
                    delete this[propertyName].meta;
                }

                instance.alterSequence.push({ removePropertyMeta: arguments });
                return this;
            };

            Object.getPrototypeOf(this).setPropertyOnChange = function (property, name, onChangeObj) {
                if (typeof onChangeObj !== 'object') throw new exceptions.InvalidArgumentException();
                var key = name; //Object.keys(onChangeObj)[0];

                new OBJY.PropertyOnChangeSetWrapper(this, property, key, onChangeObj.value, onChangeObj.trigger, onChangeObj.type, instance, params);
                instance.alterSequence.push({ setPropertyOnChange: arguments });
                return this;
            };

            Object.getPrototypeOf(this).removePropertyOnChange = function (propertyName, name) {
                if (propertyName.indexOf('.') != -1) {
                    this.removePropertyOnChangeFromBag(propertyName, name);
                    return;
                } else {
                    if (!this[propertyName]) throw new exceptions.NoSuchPropertyException(propertyName);
                    if (!this[propertyName].onDelete[name]) throw new exceptions.HandlerNotFoundException(name); // CHANGE!!!
                    delete this[propertyName][name];
                }

                instance.alterSequence.push({ removePropertyOnChange: arguments });
                return this;
            };

            Object.getPrototypeOf(this).removePropertyOnChangeFromBag = function (property, name) {
                this.getProperty(property);

                new OBJY.PropertyBagItemOnChangeRemover(this, property, name);

                return this;
            };

            Object.getPrototypeOf(this).setPropertyOnDelete = function (property, name, onDeleteObj) {
                if (typeof onDeleteObj !== 'object') throw new exceptions.InvalidArgumentException();
                var key = name;

                new OBJY.PropertyOnDeleteSetWrapper(this, property, key, onDeleteObj.value, onDeleteObj.trigger, onDeleteObj.type, instance, params);
                instance.alterSequence.push({ setPropertyOnDelete: arguments });
                return this;
            };

            Object.getPrototypeOf(this).removePropertyOnDelete = function (propertyName, name) {
                if (propertyName.indexOf('.') != -1) {
                    this.removePropertyOnDeleteFromBag(propertyName, name);
                    return;
                } else {
                    if (!this[propertyName]) throw new exceptions.NoSuchPropertyException(propertyName);
                    if (!this[propertyName].onDelete[name]) throw new exceptions.HandlerNotFoundException(name); // CHANGE!!!
                    delete this[propertyName].onDelete[name];
                }

                instance.alterSequence.push({ removePropertyOnDelete: arguments });
                return this;
            };

            Object.getPrototypeOf(this).removePropertyOnDeleteFromBag = function (property, name) {
                this.getProperty(property);

                new OBJY.PropertyBagItemOnDeleteRemover(this, property, name);

                return this;
            };

            Object.getPrototypeOf(this).setPropertyConditions = function (property, conditions) {
                var propertyKey = Object.keys(property)[0];
                if (propertyKey.indexOf('.') != -1) {
                    var lastDot = propertyKey.lastIndexOf('.');
                    var bag = propertyKey.substring(0, lastDot);
                    var newProKey = propertyKey.substring(lastDot + 1, propertyKey.length);
                    this.setBagPropertyConditions(bag, newProKey, conditions);
                    return;
                }
                new OBJY.PropertyConditionsSetWrapper(this, property, conditions, params);
                instance.alterSequence.push({ setPropertyConditions: arguments });
                return this;
            };

            Object.getPrototypeOf(this).setBagPropertyConditions = function (bag, property, conditions) {
                new OBJY.PropertyConditionsSetWrapper(this.getProperty(bag), property, conditions, params);
                return this;
            };

            Object.getPrototypeOf(this).setBagPropertyPermission = function (bag, property, permission) {
                new OBJY.PropertyPermissionSetWrapper(this.getProperty(bag), property, permission, params);
                return this;
            };

            Object.getPrototypeOf(this).setPropertyQuery = function (property, options) {
                var propertyKey = Object.keys(property)[0];
                if (propertyKey.indexOf('.') != -1) {
                    var lastDot = propertyKey.lastIndexOf('.');
                    var bag = propertyKey.substring(0, lastDot);
                    var newProKey = propertyKey.substring(lastDot + 1, propertyKey.length);
                    this.setBagPropertyQuery(bag, newProKey, value);
                    return;
                }
                new OBJY.PropertyQuerySetWrapper(this, property, options, params);
                instance.alterSequence.push({ setPropertyQuery: arguments });
                return this;
            };

            /*this.setPropertyEventInterval = function(property, interval) {
                var propertyKey = Object.keys(property)[0];
                if (propertyKey.indexOf('.') != -1) {
                    var lastDot = propertyKey.lastIndexOf(".");
                    var bag = propertyKey.substring(0, lastDot);
                    var newProKey = propertyKey.substring(lastDot + 1, propertyKey.length);
                    var newProp = {};
                    this.setBagPropertyEventInterval(bag, newProKey, value);
                    return;
                }
                new OBJY.PropertyEventIntervalSetWrapper(this, property, interval, instance);
                return this;
            };*/

            Object.getPrototypeOf(this).removePropertyQuery = function (propertyName) {
                if (propertyName.indexOf('.') != -1) {
                    this.removePropertyQueryFromBag(propertyName);
                    return;
                } else {
                    if (!this[propertyName]) throw new exceptions.NoSuchPropertyException(propertyName);
                    if (!this[propertyName].query) throw new exceptions.NoSuchPermissionException(permissionKey); // CHANGE!!!
                    delete this[propertyName].query;
                }

                instance.alterSequence.push({ removePropertyQuery: arguments });

                return this;
            };

            Object.getPrototypeOf(this).removePropertyQueryFromBag = function (property) {
                this.getProperty(property);

                new OBJY.PropertyBagItemQueryRemover(this, property);
                return this;
            };

            Object.getPrototypeOf(this).removePropertyConditions = function (propertyName) {
                if (propertyName.indexOf('.') != -1) {
                    this.removePropertyConditionsFromBag(propertyName);
                    return;
                } else {
                    if (!this[propertyName]) throw new exceptions.NoSuchPropertyException(propertyName);
                    if (!this[propertyName].conditions) throw new exceptions.NoSuchPermissionException(permissionKey); // CHANGE!!!
                    delete this[propertyName].conditions;
                }

                return this;
            };

            Object.getPrototypeOf(this).removePropertyConditionsFromBag = function (property) {
                this.getProperty(property);

                new OBJY.PropertyBagItemConditionsRemover(this, property);
                return this;
            };

            Object.getPrototypeOf(this).setBagPropertyQuery = function (bag, property, options) {
                // @TODO ...
                //new OBJY.setBagPropertyQuery(this.getProperty(bag), property, permoptionsission);
                return this;
            };

            Object.getPrototypeOf(this).removePropertyPermission = function (propertyName, permissionKey) {
                if (propertyName.indexOf('.') != -1) {
                    this.removePropertyPermissionFromBag(propertyName, permissionKey);
                    return;
                } else {
                    if (!this[propertyName]) throw new exceptions.NoSuchPropertyException(propertyName);
                    if (!this[propertyName].permissions[permissionKey]) throw new exceptions.NoSuchPermissionException(permissionKey);

                    OBJY.chainPermission(this, instance, 'x', 'removePropertyPermission', permissionKey);

                    instance.alterSequence.push({ removePropertyPermission: arguments });

                    delete this[propertyName].permissions[permissionKey];
                }

                return this;
            };

            Object.getPrototypeOf(this).setBagPropertyValue = function (bag, property, value, client) {
                new OBJY.PropertySetWrapper(this.getProperty(bag), property, value, instance, params);
                return this;
            };

            Object.getPrototypeOf(this).setBagEventDate = function (bag, property, value, client) {
                new OBJY.EventDateSetWrapper(this.getProperty(bag), property, value, instance, params);
                return this;
            };

            Object.getPrototypeOf(this).setBagEventAction = function (bag, property, value, client) {
                new OBJY.EventActionSetWrapper(this.getProperty(bag), property, value, instance, params);
                return this;
            };

            Object.getPrototypeOf(this).setBagEventInterval = function (bag, property, value, client) {
                new OBJY.EventIntervalSetWrapper(this.getProperty(bag), property, value, instance, params);
                return this;
            };

            Object.getPrototypeOf(this).setBagEventTriggered = function (bag, property, value, client) {
                new OBJY.EventTriggeredSetWrapper(this, property, value, client, instance, params);
                return this;
            };

            Object.getPrototypeOf(this).setBagEventLastOccurence = function (bag, property, value, client) {
                new OBJY.EventLastOccurenceSetWrapper(this.getProperty(bag), property, value, client, params);
                return this;
            };

            Object.getPrototypeOf(this).addPropertyToBag = function (bag, property) {
                var tmpBag = this.getProperty(bag);

                new OBJY.PropertyCreateWrapper(tmpBag, property, true, instance, params, true);

                return this;
            };

            Object.getPrototypeOf(this).removePropertyFromBag = function (property, client) {
                this.getProperty(property);

                new OBJY.PropertyBagItemRemover(this, property, params, instance);
                return this;
            };

            Object.getPrototypeOf(this).removePropertyPermissionFromBag = function (property, permissionKey) {
                this.getProperty(property);

                new OBJY.PropertyBagItemPermissionRemover(this, property, permissionKey, instance);
                return this;
            };

            Object.getPrototypeOf(this).removeProperty = function (propertyName, client) {
                var thisRef = this;

                if (propertyName.indexOf('.') != -1) {
                    this.removePropertyFromBag(propertyName, client);
                    instance.alterSequence.push({ removeProperty: arguments });
                    return this;
                } else {
                    if (!thisRef[propertyName]) throw new exceptions.NoSuchPropertyException(propertyName);

                    var tmpProp = Object.assign({}, thisRef[propertyName]);

                    if (tmpProp.onDelete) {
                        if (Object.keys(tmpProp.onDelete).length > 0) {
                            if (!instance.handlerSequence[this._id]) instance.handlerSequence[this._id] = {};
                            if (!instance.handlerSequence[this._id].onDelete) instance.handlerSequence[this._id].onDelete = [];
                            instance.handlerSequence[this._id].onDelete.push({
                                handler: tmpProp.onDelete,
                                prop: tmpProp,
                            });
                        }
                    }

                    OBJY.chainPermission(thisRef[propertyName], instance, 'd', 'removeProperty', propertyName);

                    instance.alterSequence.push({ removeProperty: arguments });

                    /*if (this[propertyName].type == 'date') instance.eventAlterationSequence.push({
                        operation: 'remove',
                        obj: this,
                        propName: propertyName,
                        date: date
                    })*/

                    delete thisRef[propertyName];
                }

                return this;
            };

            Object.getPrototypeOf(this).getId = function () {
                return this._id;
            };

            Object.getPrototypeOf(this).getName = function () {
                return this.name;
            };

            Object.getPrototypeOf(this).setName = function (name) {
                this.name = name;

                OBJY.chainPermission(this, instance, 'n', 'setName', name);

                instance.alterSequence.push({ setName: arguments });

                return this;
            };

            Object.getPrototypeOf(this).setType = function (type) {
                this.type = type;
                OBJY.chainPermission(this, instance, 't', 'setType', type);
                instance.alterSequence.push({ setType: arguments });
                return this;
            };

            Object.getPrototypeOf(this).getType = function () {
                return this.type;
            };

            Object.getPrototypeOf(this).getRef = function (propertyName) {
                return new OBJY.PropertyRefParser(this, propertyName);
            };

            Object.getPrototypeOf(this).getProperty = function (propertyName) {
                return OBJY.PropertyParser(this, propertyName, instance, params);
            };

            Object.getPrototypeOf(this).getProperties = function () {
                return this;
            };

            Object.getPrototypeOf(this).add = function (success, error, client) {
                return new Promise((resolve, reject) => {
                    var client = client || instance.activeTenant;
                    var app = instance.activeApp;
                    var user = instance.activeUser;

                    var thisRef = this;

                    //OBJY.applyAffects(thisRef, 'onCreate', instance, client);

                    if (!OBJY.checkAuthroisations(this, user, 'c', app, instance)) return error({ error: 'Lack of Permissions' });

                    if (!this._id) this._id = OBJY.ID();

                    if (params.dirty) {
                        var constraints = OBJY.checkConstraints(obj);
                        if (Array.isArray(constraints) && error) {
                            return error({
                                message: 'constraints error: ' + constraints.join(','),
                            });
                        }

                        OBJY.add(
                            thisRef,
                            function (data) {
                                thisRef._id = data._id;

                                OBJY.deSerializePropsObject(data, params);

                                if (success) success(OBJY.deserialize(data));
                                else {
                                    resolve(OBJY.deserialize(data));
                                }

                                delete thisRef.instance;
                            },
                            function (err) {
                                console.warn('err', err, error);
                                if (error) error(err);
                                else {
                                    reject(err);
                                }
                            },
                            app,
                            client,
                            params
                        );

                        return OBJY.deserialize(this);
                    }

                    if (thisRef.onCreate) {
                        Object.keys(thisRef.onCreate).forEach(function (key) {
                            if (thisRef.onCreate[key].trigger == 'before' || !thisRef.onCreate[key].trigger) {
                                instance.execProcessorAction(
                                    thisRef.onCreate[key].value || thisRef.onCreate[key].action,
                                    thisRef,
                                    null,
                                    null,
                                    function (data) {},
                                    client,
                                    null
                                );
                            }
                        });
                    }

                    this.created = moment().utc().toDate().toISOString();
                    this.lastModified = moment().utc().toDate().toISOString();

                    thisRef._aggregatedEvents = [];

                    function aggregateAllEvents(props, prePropsString) {
                        Object.keys(props).forEach(function (p) {
                            if (!isObject(props[p])) return;

                            //if (props[p].type == CONSTANTS.PROPERTY.TYPE_PROPERTY_BAG){
                            if (prePropsString) {
                                aggregateAllEvents(props[p], prePropsString + '.' + p);
                            } else {
                                aggregateAllEvents(props[p], p);
                            }
                            //}

                            if (props[p].type == CONSTANTS$1.PROPERTY.TYPE_EVENT) {
                                var date = null;

                                if (props[p].date) {
                                    if (!props[p].triggered) date = props[p].date;
                                    else date = null;
                                } else if (props[p].interval) {
                                    if (props[p].nextOccurence) {
                                        date = props[p].nextOccurence;
                                    } else date = moment().utc().toISOString();
                                }

                                if (prePropsString) {
                                    instance.eventAlterationSequence.push({
                                        operation: 'add',
                                        obj: thisRef,
                                        propName: prePropsString + '.' + p,
                                        property: props[p],
                                        date: date,
                                    });

                                    var found = false;
                                    thisRef._aggregatedEvents.forEach(function (aE) {
                                        if (aE.propName == prePropsString + '.' + p) found = true;
                                    });

                                    if (!found && props[p].triggered != true)
                                        thisRef._aggregatedEvents.push({
                                            propName: prePropsString + '.' + p,
                                            date: date,
                                        });
                                } else {
                                    instance.eventAlterationSequence.push({
                                        operation: 'add',
                                        obj: thisRef,
                                        propName: p,
                                        property: props[p],
                                        date: date,
                                    });

                                    var found = false;
                                    thisRef._aggregatedEvents.forEach(function (aE) {
                                        if (aE.propName == p) found = true;
                                    });

                                    if (!found && props[p].triggered != true) {
                                        thisRef._aggregatedEvents.push({
                                            propName: p,
                                            date: date,
                                        });
                                    }
                                }
                            }
                        });
                    }

                    var mapper = instance.observers[thisRef.role];

                    //if (this) aggregateAllEvents(this.properties);

                    aggregateAllEvents(thisRef);

                    if (app) {
                        if (!this.applications) this.applications = [];
                        if (this.applications) if (this.applications.indexOf(app) == -1) this.applications.push(app);
                    }

                    var addFn = function (obj) {
                        if (!OBJY.checkPermissions(user, app, obj, 'c', false, instance)) return error({ error: 'Lack of Permissions' });

                        var constraints = OBJY.checkConstraints(obj);
                        if (Array.isArray(constraints) && error) {
                            return error({
                                message: 'constraints error: ' + constraints.join(','),
                            });
                        }

                        OBJY.add(
                            obj,
                            function (data) {
                                obj._id = data._id;

                                OBJY.applyAffects(thisRef, 'onCreate', instance, client);

                                if (data.onCreate) {
                                    Object.keys(data.onCreate).forEach(function (key) {
                                        try {
                                            if (data.onCreate[key].trigger == 'after') {
                                                instance.execProcessorAction(
                                                    data.onCreate[key].value || data.onCreate[key].action,
                                                    data,
                                                    null,
                                                    null,
                                                    function (data) {},
                                                    client,
                                                    null
                                                );
                                            }
                                        } catch (e) {
                                            console.log(e);
                                        }
                                    });
                                }

                                if (mapper.type == 'scheduled') {
                                    instance.eventAlterationSequence.forEach(function (evt) {
                                        if (evt.operation == 'add') {
                                            mapper.addEvent(
                                                obj._id,
                                                evt.propName,
                                                evt.property,
                                                function (evtData) {},
                                                function (evtErr) {},
                                                instance.activeTenant
                                            );
                                        } else if (evt.operation == 'remove') {
                                            mapper.addEvent(
                                                obj._id,
                                                evt.propName,
                                                function (evtData) {},
                                                function (evtErr) {},
                                                instance.activeTenant
                                            );
                                        }
                                    });
                                }

                                instance.eventAlterationSequence = [];

                                OBJY.Logger.log('Added Object: ' + JSON.stringify(data, null, 2));

                                OBJY.deSerializePropsObject(data, params);

                                if (success) success(OBJY.deserialize(data));
                                else {
                                    resolve(OBJY.deserialize(data));
                                }

                                delete thisRef.instance;
                            },
                            function (err) {
                                if (error) error(err);
                                else {
                                    reject(err);
                                }
                            },
                            app,
                            client,
                            params,
                            instance
                        );
                    };

                    if (params.templateMode == CONSTANTS$1.TEMPLATEMODES.STRICT) {
                        if (this.inherits.length == 0) addFn(thisRef);

                        var counter = 0;
                        this.inherits.forEach(function (template) {
                            if (thisRef._id != template) {
                                OBJY.getTemplateFieldsForObject(
                                    thisRef,
                                    template,
                                    function () {
                                        counter++;
                                        if (counter == thisRef.inherits.length) {
                                            addFn(thisRef);
                                            return this;
                                        }
                                    },
                                    function (err) {
                                        if (error) error(thisRef);
                                        else {
                                            reject(thisRef);
                                        }
                                        return this;
                                    },
                                    client,
                                    params.templateFamily,
                                    params.templateSource,
                                    params
                                );
                            }
                        });
                    } else {
                        addFn(thisRef);
                    }
                    return OBJY.deserialize(this);
                });
            };

            Object.getPrototypeOf(this).update = function (success, error, client) {
                return new Promise((resolve, reject) => {
                    var client = client || instance.activeTenant;
                    var app = instance.activeApp;
                    var user = instance.activeUser;

                    OBJY.applyAffects(this, 'onChange', instance, client, 'before');

                    if (!OBJY.checkAuthroisations(this, user, 'u', app, instance)) return error({ error: 'Lack of Permissions' });

                    var thisRef = this;

                    if (params.dirty) {
                        var constraints = OBJY.checkConstraints(this);
                        if (Array.isArray(constraints) && error) {
                            return error({
                                message: 'constraints error: ' + constraints.join(','),
                            });
                        }

                        OBJY.updateO(
                            thisRef,
                            function (data) {
                                delete instance.handlerSequence[this._id];

                                instance.eventAlterationSequence = [];

                                OBJY.deSerializePropsObject(data, params);

                                instance.alterSequence = [];

                                if (success) success(OBJY.deserialize(data));
                                else {
                                    resolve(OBJY.deserialize(data));
                                }
                            },
                            function (err) {
                                if (error) error(err);
                                else {
                                    reject(err);
                                }
                            },
                            app,
                            client,
                            params,
                            instance
                        );

                        return OBJY.deserialize(this);
                    }

                    if (!OBJY.checkPermissions(user, app, thisRef, 'u', false, instance)) return error({ error: 'Lack of Permissions' });

                    if ((instance.permissionSequence[thisRef._id] || []).length > 0) {
                        throw new exceptions.LackOfPermissionsException(instance.permissionSequence[thisRef._id]);
                    }

                    if (thisRef.onChange) {
                        Object.keys(thisRef.onChange).forEach(function (key) {
                            if (thisRef.onChange[key].trigger == 'before') {
                                instance.execProcessorAction(
                                    thisRef.onChange[key].value || thisRef.onChange[key].action,
                                    thisRef,
                                    null,
                                    null,
                                    function (data) {},
                                    client,
                                    null
                                );
                            }
                        });
                    }

                    if (instance.handlerSequence[this._id]) {
                        for (var type in instance.handlerSequence[this._id]) {
                            for (var item in instance.handlerSequence[this._id][type]) {
                                var handlerObj = instance.handlerSequence[this._id][type][item];

                                for (var handlerItem in handlerObj.handler) {
                                    if (handlerObj.handler[handlerItem].trigger == 'before') {
                                        instance.execProcessorAction(
                                            handlerObj.handler[handlerItem].value || handlerObj.handler[handlerItem].action,
                                            thisRef,
                                            handlerObj.prop,
                                            null,
                                            function (data) {},
                                            client,
                                            null
                                        );
                                    }
                                }
                            }
                        }
                    }

                    this.lastModified = moment().toDate().toISOString();

                    var thisRef = this;

                    thisRef._aggregatedEvents = [];

                    function aggregateAllEvents(props, prePropsString) {
                        Object.keys(props).forEach(function (p) {
                            if (!isObject(props[p])) return;

                            //if (props[p].type == CONSTANTS.PROPERTY.TYPE_PROPERTY_BAG){
                            if (prePropsString) {
                                aggregateAllEvents(props[p], prePropsString + '.' + p);
                            } else {
                                aggregateAllEvents(props[p], p);
                            }
                            //}

                            if (props[p].type == CONSTANTS$1.PROPERTY.TYPE_EVENT) {
                                var date = null;

                                if (props[p].date) {
                                    if (!props[p].triggered) date = props[p].date;
                                    else date = null;
                                } else if (props[p].interval) {
                                    if (props[p].nextOccurence) {
                                        date = props[p].nextOccurence;
                                    } else date = moment().utc().toISOString();
                                }

                                if (prePropsString) {
                                    var found = false;
                                    thisRef._aggregatedEvents.forEach(function (aE) {
                                        if (aE.propName == prePropsString + '.' + p) found = true;
                                    });

                                    if (!found && props[p].triggered != true)
                                        thisRef._aggregatedEvents.push({
                                            propName: prePropsString + '.' + p,
                                            date: date,
                                        });
                                } else {
                                    var found = false;
                                    thisRef._aggregatedEvents.forEach(function (aE) {
                                        if (aE.propName == p) found = true;
                                    });

                                    if (!found && props[p].triggered != true)
                                        thisRef._aggregatedEvents.push({
                                            propName: p,
                                            date: date,
                                        });
                                }
                            }
                        });
                    }

                    var mapper = instance.observers[thisRef.role];

                    //if (mapper.type != 'scheduled' && this) aggregateAllEvents(this.properties);
                    if (mapper.type != 'scheduled') aggregateAllEvents(this);

                    function updateFn() {
                        var constraints = OBJY.checkConstraints(thisRef);
                        if (Array.isArray(constraints) && error) {
                            return error({
                                message: 'constraints error: ' + constraints.join(','),
                            });
                        }

                        OBJY.updateO(
                            thisRef,
                            function (data) {
                                OBJY.applyAffects(data, 'onChange', instance, client, 'after');

                                if (data.onChange) {
                                    Object.keys(data.onChange).forEach(function (key) {
                                        if (data.onChange[key].trigger == 'after') {
                                            instance.execProcessorAction(
                                                data.onChange[key].value || data.onChange[key].action,
                                                data,
                                                null,
                                                null,
                                                function (data) {},
                                                client,
                                                null
                                            );
                                        }
                                    });
                                }

                                if (instance.handlerSequence[thisRef._id]) {
                                    for (var type in instance.handlerSequence[thisRef._id]) {
                                        for (var item in instance.handlerSequence[thisRef._id][type]) {
                                            var handlerObj = instance.handlerSequence[thisRef._id][type][item];
                                            for (var handlerItem in handlerObj.handler) {
                                                if (handlerObj.handler[handlerItem].trigger == 'after' || !handlerObj.handler[handlerItem].trigger) {
                                                    instance.execProcessorAction(
                                                        handlerObj.handler[handlerItem].value || handlerObj.handler[handlerItem].action,
                                                        thisRef,
                                                        handlerObj.prop,
                                                        null,
                                                        function (data) {},
                                                        client,
                                                        null
                                                    );
                                                }
                                            }
                                        }
                                    }
                                }

                                delete instance.handlerSequence[thisRef._id];

                                if (mapper.type == 'scheduled') {
                                    instance.eventAlterationSequence.forEach(function (evt) {
                                        if (evt.type == 'add') {
                                            mapper.addEvent(
                                                thisRef._id,
                                                evt.propName,
                                                evt.property,
                                                function (evtData) {},
                                                function (evtErr) {},
                                                instance.activeTenant
                                            );
                                        }
                                    });
                                }

                                instance.eventAlterationSequence = [];

                                if (params.templateMode == CONSTANTS$1.TEMPLATEMODES.STRICT) {
                                    OBJY.updateInheritedObjs(
                                        thisRef,
                                        params.pluralName,
                                        function (data) {},
                                        function (err) {},
                                        client,
                                        params
                                    );
                                }

                                OBJY.Logger.log('Updated Object: ' + data);
                                OBJY.deSerializePropsObject(data, params);
                                instance.alterSequence = [];
                                if (success) success(OBJY.deserialize(data));
                                else {
                                    resolve(OBJY.deserialize(data));
                                }
                            },
                            function (err) {
                                if (error) error(err);
                                else {
                                    reject(err);
                                }
                            },
                            app,
                            client,
                            params,
                            instance
                        );
                    }

                    if (instance.commandSequence.length > 0 && params.templateMode == CONSTANTS$1.TEMPLATEMODES.STRICT) {
                        var foundCounter = 0;
                        instance.commandSequence.forEach(function (i) {
                            if (i.name == 'addInherit' || i.name == 'removeInherit') {
                                foundCounter++;
                            }
                        });

                        if (foundCounter == 0) updateFn();

                        var execCounter = 0;
                        instance.commandSequence.forEach(function (i) {
                            if (i.name == 'addInherit' && thisRef.inherits.indexOf(i.value) != -1) {
                                execCounter++;

                                OBJY.getTemplateFieldsForObject(
                                    thisRef,
                                    i.value,
                                    function () {
                                        if (execCounter == foundCounter) {
                                            updateFn();
                                        }
                                    },
                                    function (err) {
                                        if (error) error(thisRef);
                                        else {
                                            reject(thisRef);
                                        }
                                        return thisRef;
                                    },
                                    client,
                                    params.templateFamily,
                                    params.templateSource,
                                    params,
                                    instance
                                );
                            }

                            if (i.name == 'removeInherit' && thisRef.inherits.indexOf(i.value) == -1) {
                                execCounter++;
                                OBJY.removeTemplateFieldsForObject(
                                    thisRef,
                                    i.value,
                                    function () {
                                        if (execCounter == foundCounter) {
                                            updateFn();
                                        }
                                    },
                                    function (err) {
                                        if (error) error(thisRef);
                                        else {
                                            reject(thisRef);
                                        }
                                        return thisRef;
                                    },
                                    client,
                                    params,
                                    instance
                                );
                            }
                        });
                    } else updateFn();

                    instance.commandSequence = [];

                    return OBJY.deserialize(this);
                });
            };

            Object.getPrototypeOf(this).remove = function (success, error, client) {
                return new Promise((resolve, reject) => {
                    var client = client || instance.activeTenant;
                    var app = instance.activeApp;
                    var user = instance.activeUser;

                    var thisRef = JSON.parse(JSON.stringify(this));

                    OBJY.applyAffects(thisRef, 'onDelete', instance, client);

                    if (params.dirty) {
                        OBJY.getObjectById(
                            this.role,
                            this._id,
                            function (data) {
                                if (!OBJY.checkAuthroisations(data, user, 'd', app, instance)) return error({ error: 'Lack of Permissions' });

                                return OBJY.remove(
                                    thisRef,
                                    function (_data) {
                                        OBJY.deSerializePropsObject(data, params);

                                        if (success) success(OBJY.deserialize(data));
                                        else {
                                            resolve(OBJY.deserialize(data));
                                        }
                                    },
                                    function (err) {
                                        if (error) error(err);
                                        else {
                                            reject(err);
                                        }
                                    },
                                    app,
                                    client
                                );
                            },
                            function (err) {
                                if (error) error(err);
                                else {
                                    reject(err);
                                }
                            },
                            app,
                            client,
                            instance,
                            params
                        );

                        return OBJY.deserialize(this);
                    }

                    if (!OBJY.checkPermissions(user, app, thisRef, 'd', false, instance)) return error({ error: 'Lack of Permissions' });

                    if (thisRef.onDelete) {
                        Object.keys(thisRef.onDelete).forEach(function (key) {
                            if (thisRef.onDelete[key].trigger == 'before') {
                                instance.execProcessorAction(
                                    thisRef.onDelete[key].value || thisRef.onDelete[key].action,
                                    thisRef,
                                    null,
                                    null,
                                    function (data) {},
                                    client,
                                    null
                                );
                            }
                        });
                    }

                    OBJY.getObjectById(
                        this.role,
                        this._id,
                        function (data) {
                            return OBJY.remove(
                                thisRef,
                                function (_data) {
                                    OBJY.applyAffects(data, 'onDelete', instance, client);

                                    if (thisRef.onDelete) {
                                        Object.keys(thisRef.onDelete).forEach(function (key) {
                                            if (thisRef.onDelete[key].trigger == 'after') {
                                                instance.execProcessorAction(
                                                    thisRef.onDelete[key].value || thisRef.onDelete[key].action,
                                                    thisRef,
                                                    null,
                                                    null,
                                                    function (data) {},
                                                    client,
                                                    null
                                                );
                                            }
                                        });
                                    }

                                    function aggregateAllEvents(props, prePropsString) {
                                        Object.keys(props || {}).forEach(function (p) {
                                            if (!isObject(props[p])) return;

                                            //if (props[p].type == CONSTANTS.PROPERTY.TYPE_PROPERTY_BAG){
                                            if (prePropsString) {
                                                aggregateAllEvents(props[p], prePropsString + '.' + p);
                                            } else {
                                                aggregateAllEvents(props[p], p);
                                            }
                                            //}

                                            if (props[p].type == CONSTANTS$1.PROPERTY.TYPE_EVENT) {
                                                var date = null;

                                                if (props[p].date) {
                                                    if (!props[p].date.triggered) date = props[p].date;
                                                    else date = null;
                                                } else if (props[p].interval) {
                                                    if (props[p].nextOccurence) {
                                                        date = props[p].nextOccurence;
                                                    } else date = moment().utc().toISOString();
                                                }

                                                if (prePropsString) {
                                                    instance.eventAlterationSequence.push({
                                                        operation: 'remove',
                                                        obj: thisRef,
                                                        propName: prePropsString + '.' + p,
                                                        date: date,
                                                    });
                                                } else {
                                                    instance.eventAlterationSequence.push({
                                                        operation: 'remove',
                                                        obj: thisRef,
                                                        propName: p,
                                                        date: date,
                                                    });
                                                }
                                            }
                                        });
                                    }

                                    var mapper = instance.observers[thisRef.role];

                                    aggregateAllEvents(data || {});

                                    if (mapper.type == 'scheduled') {
                                        instance.eventAlterationSequence.forEach(function (evt) {
                                            if (evt.operation == 'add') {
                                                mapper.addEvent(
                                                    data._id,
                                                    evt.propName,
                                                    evt.property,
                                                    function (evtData) {},
                                                    function (evtErr) {},
                                                    instance.activeTenant
                                                );
                                            } else if (evt.operation == 'remove') {
                                                mapper.removeEvent(
                                                    data._id,
                                                    evt.propName,
                                                    function (evtData) {},
                                                    function (evtErr) {
                                                        console.log(evtErr);
                                                    },
                                                    instance.activeTenant
                                                );
                                            }
                                        });
                                    }

                                    if (params.templateMode == CONSTANTS$1.TEMPLATEMODES.STRICT) {
                                        OBJY.removeInheritedObjs(
                                            thisRef,
                                            params.pluralName,
                                            function (data) {},
                                            function (err) {},
                                            client,
                                            params
                                        );
                                    }

                                    OBJY.Logger.log('Removed Object: ' + data);

                                    OBJY.deSerializePropsObject(data, params);
                                    if (success) success(OBJY.deserialize(data));
                                    else {
                                        resolve(OBJY.deserialize(data));
                                    }
                                },
                                function (err) {
                                    if (error) error(err);
                                    else {
                                        reject(err);
                                    }
                                },
                                app,
                                client,
                                instance
                            );
                        },
                        function (err) {
                            if (error) error(err);
                            else {
                                reject(err);
                            }
                        },
                        app,
                        client,
                        instance,
                        params
                    );

                    return OBJY.deserialize(this);
                });
            };

            Object.getPrototypeOf(this).get = function (success, error, dontInherit) {
                return new Promise((resolve, reject) => {
                    var client = instance.activeTenant;
                    var app = instance.activeApp;
                    var user = instance.activeUser;

                    var thisRef = this;

                    if (params.dirty) {
                        OBJY.getObjectById(
                            thisRef.role,
                            thisRef._id,
                            function (data) {
                                OBJY.deSerializePropsObject(data, params);
                                if (!OBJY.checkAuthroisations(data, user, 'r', app, instance)) return error({ error: 'Lack of Permissions' });

                                if (success) success(OBJY[data.role](OBJY.deserialize(data)));
                                else {
                                    resolve(OBJY[data.role](OBJY.deserialize(data)));
                                }
                            },
                            function (err) {
                                if (error) error(err);
                                else {
                                    reject(err);
                                }
                            },
                            app,
                            client,
                            instance,
                            params
                        );

                        return OBJY.deserialize(this);
                    }

                    var counter = 0;

                    /*function arrayDeserialize(obj, parentArray) {

                    if (obj) {
                        var propsArray = [];
                        var propertyKeys = Object.keys(obj);
                        propertyKeys.forEach(function(propKey) {

                            if (obj.properties[propKey].type == 'array')
                                arrayDeserialize(obj.properties[propKey], true);

                            if (obj.properties[propKey].permissions) {
                                obj.properties[propKey].permissions = permDeserialize(obj.properties[propKey].permissions);
                            }

                            propsArray.push(Object.assign({
                                name: propKey
                            }, obj.properties[propKey]));
                        });
                        obj.properties = propsArray;
                    }
                }*/

                    function prepareObj(data) {
                        var returnObject = OBJY[data.role](OBJY.deserialize(data));

                        OBJY.applyAffects(data, null, instance, client);

                        if (!OBJY.checkAuthroisations(returnObject, user, 'r', app, instance))
                            return error({ error: 'Lack of Permissions', source: 'authorisations' });

                        if (!OBJY.checkPermissions(user, app, data, 'r', false, instance))
                            return error({ error: 'Lack of Permissions', source: 'permissions' });

                        if (dontInherit) {
                            if (success) success(returnObject);
                            else {
                                resolve(returnObject);
                            }
                            return data;
                        }

                        if (params.templateMode == CONSTANTS$1.TEMPLATEMODES.STRICT) {
                            if (success) success(returnObject);
                            else {
                                resolve(returnObject);
                            }
                            return data;
                        }

                        if ((data.inherits || []).length == 0) {
                            if (success) success(OBJY.deSerializePropsObject(returnObject, params));
                            else {
                                resolve(OBJY.deSerializePropsObject(returnObject, params));
                            }
                            return data;
                        }

                        data.inherits.forEach(function (template) {
                            if (data._id != template) {
                                OBJY.getTemplateFieldsForObject(
                                    data,
                                    template,
                                    function () {
                                        var returnObject = OBJY[data.role](OBJY.deserialize(data));

                                        counter++;

                                        if (counter == data.inherits.length) {
                                            if (success) success(OBJY.deSerializePropsObject(returnObject, params));
                                            else {
                                                resolve(OBJY.deSerializePropsObject(returnObject, params));
                                            }
                                            return data;
                                        }
                                    },
                                    function (err) {
                                        counter++;

                                        var returnObject = OBJY[data.role](OBJY.deserialize(data));

                                        if (counter == data.inherits.length) {
                                            if (success) success(OBJY.deSerializePropsObject(returnObject, params));
                                            else {
                                                resolve(OBJY.deSerializePropsObject(returnObject, params));
                                            }
                                            return data;
                                        }
                                    },
                                    client,
                                    params.templateFamily,
                                    params.templateSource,
                                    params,
                                    instance
                                );
                            } else {
                                var returnObject = OBJY[data.role](OBJY.deserialize(data));

                                if (thisRef.inherits.length == 1) {
                                    if (success) success(OBJY.deSerializePropsObject(returnObject, params));
                                    else {
                                        resolve(OBJY.deSerializePropsObject(returnObject, params));
                                    }
                                    return data;
                                } else {
                                    counter++;
                                    return;
                                }
                            }
                        });
                    }

                    if (instance.caches[thisRef.role].data[thisRef._id]) {
                        prepareObj(instance.caches[thisRef.role].data[thisRef._id]);
                    } else {
                        OBJY.getObjectById(
                            thisRef.role,
                            thisRef._id,
                            function (data) {
                                prepareObj(data);

                                if (!instance.caches[thisRef.role].data[thisRef._id]) ;
                            },
                            function (err) {
                                if (error) error(err);
                                else {
                                    reject(err);
                                }
                            },
                            app,
                            client,
                            instance,
                            params
                        );
                    }

                    return OBJY.deserialize(this);
                });
            };

            const validator = {
                get: (obj, prop) => {
                    if (typeof obj[prop] === 'object' && obj[prop] !== null) {
                        return new Proxy(obj[prop], validator);
                    } else {
                        return obj[prop];
                    }
                },
                set: (obj, prop, value) => {
                    if (Array.isArray(obj) && prop == 'length') return true;
                    obj[prop] = value;
                    this.update();
                    return true;
                },

                deleteProperty: (obj, prop, value) => {
                    delete obj[prop];
                    this.update();
                    return true;
                },
            };

            if (!params.storage) {
                this.add();
                var thisRef = this;
                (this.inherits || []).forEach(function (template) {
                    OBJY.getTemplateFieldsForObject(
                        thisRef,
                        template,
                        function () {},
                        function (err) {
                            console.log('err', err);
                        },
                        instance.activeTenant,
                        params.templateFamily,
                        params.templateSource,
                        params,
                        instance
                    );
                });

                return new Proxy(this, validator);
            }

            return OBJY.deserialize(this);
        },
    };
}

const StorageMapperTemplate = function (OBJY, options) {
    this.CONSTANTS = {
        MULTITENANCY: {
            ISOLATED: 'isolated',
            SHARED: 'shared',
        },
        TYPES: {
            SCHEDULED: 'scheduled',
            QUERIED: 'queried',
        },
    };
    this.objectFamily = null;
    this.multitenancy = (options || {}).multitenancy || this.CONSTANTS.MULTITENANCY.ISOLATED;

    this.connect = function (connectionString, success, error) {};

    this.closeConnection = function (success, error) {};

    this.setObjectFamily = function (value) {
        this.objectFamily = value;
    };

    this.setMultiTenancy = function (value) {
        this.multitenancy = value;
    };

    this.createClient = function (client, success, error) {};

    this.getDBByMultitenancy = function (client) {};

    this.listClients = function (success, error) {};

    this.getById = function (id, success, error, app, client, user) {};

    this.getByCriteria = function (criteria, success, error, app, client, user, params, flags) {};

    this.count = function (criteria, success, error, app, client, user, params, flags) {};

    this.update = function (spooElement, success, error, app, client, user, params) {};

    this.add = function (spooElement, success, error, app, client, user, params) {};

    this.remove = function (spooElement, success, error, app, client, user, params) {};
};

const ProcessorMapperTemplate = function (OBJY) {
    this.CONSTANTS = {
        MULTITENANCY: {
            ISOLATED: 'isolated',
            SHARED: 'shared',
        },
        TYPES: {
            SCHEDULED: 'scheduled',
            QUERIED: 'queried',
        },
    };

    this.OBJY = OBJY;
    this.objectFamily = null;
    this.multitenancy = this.CONSTANTS.MULTITENANCY.ISOLATED;

    this.execute = function (dsl, obj, prop, data, callback, client, app, user, options) {};

    this.setMultiTenancy = function (value) {
        this.multitenancy = value;
    };

    this.setObjectFamily = function (value) {
        this.objectFamily = value;
    };
};

const ObserverMapperTemplate = function (OBJY, options, content) {
    this.CONSTANTS = {
        MULTITENANCY: {
            ISOLATED: 'isolated',
            SHARED: 'shared',
        },
        TYPES: {
            SCHEDULED: 'scheduled',
            QUERIED: 'queried',
        },
    };
    this.OBJY = OBJY;
    this.interval = (options || {}).interval || 60000;
    this.objectFamily = null;
    this.type = (options || {}).type || this.CONSTANTS.TYPES.QUERIED;
    this.multitenancy = (options || {}).multitenancy || this.CONSTANTS.MULTITENANCY.ISOLATED;

    this.initialize = function (millis) {};

    this.setObjectFamily = function (value) {
        this.objectFamily = value;
    };

    this.run = function (date) {};

    if (content) Object.assign(this, content);
};

var Logger = {
    enabled: [],
    log: function (msg) {
        if (this.enabled.length == 0 || this.enabled.indexOf('log') != -1) console.log(msg);
    },
    warn: function (msg) {
        if (this.enabled.length == 0 || this.enabled.indexOf('warn') != -1) console.warn(msg);
    },
    error: function (msg) {
        if (this.enabled.length == 0 || this.enabled.indexOf('error') != -1) console.error(msg);
    },
};

const StorageTemplate$1 = StorageMapperTemplate;
const ProcessorTemplate$1 = ProcessorMapperTemplate;
const ObserverTemplate$1 = ObserverMapperTemplate;

const clone = (orgOBJY) => {
    let clonedOBJY = {};

    Object.assign(clonedOBJY, {
        ...generalFunctions(clonedOBJY),

        ...applyFunctions(),

        ...permissionFunctions(clonedOBJY),

        ...objectFunctions(clonedOBJY),

        ...mapperFunctions(clonedOBJY),

        ...wrapperFunctions(clonedOBJY),

        ...propertyFunctions(clonedOBJY),

        ...pluralConstructorFunctions(clonedOBJY),

        ...singularConstructorFunctions(clonedOBJY),

        hello: function () {
            clonedOBJY.Logger.log('Hello from OBJY!');
        },

        clone: () => {
            return clone(clonedOBJY);
        },

        Logger: Logger,
        StorageTemplate: StorageTemplate$1,
        ProcessorTemplate: ProcessorTemplate$1,
        ObserverTemplate: ObserverTemplate$1,
    });

    clonedOBJY.instance = orgOBJY.instance;

    return clonedOBJY;
};

/**
 * OBJY Instance
 */
const OBJY = function () {
    let _OBJY = {
        Logger: Logger,
        StorageTemplate: StorageTemplate$1,
        ProcessorTemplate: ProcessorTemplate$1,
        ObserverTemplate: ObserverTemplate$1,
    };
    let instance = Object.assign({}, generalAttributes());

    _OBJY = Object.assign(_OBJY, {
        ...generalFunctions(_OBJY),

        ...applyFunctions(),

        ...permissionFunctions(_OBJY),

        ...objectFunctions(_OBJY),

        ...mapperFunctions(_OBJY),

        ...wrapperFunctions(_OBJY),

        ...propertyFunctions(_OBJY),

        ...pluralConstructorFunctions(_OBJY),

        ...singularConstructorFunctions(_OBJY),

        hello: function () {
            _OBJY.Logger.log('Hello from OBJY!');
        },

        clone: () => {
            return clone(_OBJY);
        },

        instance: instance,
    });

    return _OBJY;
};

export { OBJY as default };
//# sourceMappingURL=index.js.map
