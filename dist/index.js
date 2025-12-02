import shortid$1 from 'shortid';
import moment from 'moment';

function StorageMapperTemplate(OBJY, options) {
    this.CONSTANTS = {
        MULTITENANCY: {
            ISOLATED: "isolated",
            SHARED: "shared"
        },
        TYPES: {
            SCHEDULED: 'scheduled',
            QUERIED: 'queried'
        }
    };
    this.objectFamily = null;
    this.multitenancy = (options || {}).multitenancy || this.CONSTANTS.MULTITENANCY.ISOLATED;

    this.connect = function(connectionString, success, error) {

    };

    this.closeConnection = function(success, error) {

    };

    this.setObjectFamily = function(value) {
        this.objectFamily = value;
    };

    this.setMultiTenancy = function(value) {
        this.multitenancy = value;
    };

    this.createClient = function(client, success, error) {

    };

    this.getDBByMultitenancy = function(client) {

    };

    this.listClients = function(success, error) {

    };

    this.getById = function(id, success, error, app, client, user) {

    };

    this.getByCriteria = function(criteria, success, error, app, client, user, params, flags) {

    };

    this.count = function(criteria, success, error, app, client, user, params, flags) {

    };

    this.update = function(spooElement, success, error, app, client, user, params) {

    };

    this.add = function(spooElement, success, error, app, client, user, params) {

    };

    this.remove = function(spooElement, success, error, app, client, user, params) {

    };
}

function ProcessorMapperTemplate(OBJY) {
    this.CONSTANTS = {
        MULTITENANCY: {
            ISOLATED: "isolated",
            SHARED: "shared"
        },
        TYPES: {
            SCHEDULED: 'scheduled',
            QUERIED: 'queried'
        }
    };

    this.OBJY = OBJY;
    this.objectFamily = null;
    this.multitenancy = this.CONSTANTS.MULTITENANCY.ISOLATED;

    this.execute = function(dsl, obj, prop, data, callback, client, app, user, options) {

    };

    this.setMultiTenancy = function(value) {
        this.multitenancy = value;
    };

    this.setObjectFamily = function(value) {
        this.objectFamily = value;
    };

}

function ObserverMapperTemplate(OBJY, options, content) {
    this.CONSTANTS = {
        MULTITENANCY: {
            ISOLATED: "isolated",
            SHARED: "shared"
        },
        TYPES: {
            SCHEDULED: 'scheduled',
            QUERIED: 'queried'
        }
    };
    this.OBJY = OBJY;
    this.interval = (options || {}).interval || 60000;
    this.objectFamily = null;
    this.type = (options || {}).type || this.CONSTANTS.TYPES.QUERIED;
    this.multitenancy = (options || {}).multitenancy || this.CONSTANTS.MULTITENANCY.ISOLATED;

    this.initialize = function(millis) {

    };

    this.setObjectFamily = function(value) {
        this.objectFamily = value;
    };

    this.run = function(date) {

    };

    if (content) Object.assign(this, content);
}

var Logger = {
    enabled: [],
    log: function(msg) {
        if (this.enabled.length == 0 || this.enabled.indexOf('log') != -1) console.log(msg);
    },
    warn: function(msg) {
        if (this.enabled.length == 0 || this.enabled.indexOf('warn') != -1) console.warn(msg);
    },
    error: function(msg) {
        if (this.enabled.length == 0 || this.enabled.indexOf('error') != -1) console.error(msg);
    }
};

/*var StorageMapperTemplate = require('../mappers/templates/storage.js');
var ProcessorMapperTemplate = require('../mappers/templates/processor.js')
var ObserverMapperTemplate = require('../mappers/templates/observer.js')
var Logger = require('../lib/dependencies/logger.js')*/



var StorageTemplate$1 = StorageMapperTemplate;
var ProcessorTemplate$1 = ProcessorMapperTemplate;
var ObserverTemplate$1 = ObserverMapperTemplate;

function generalAttributes(OBJY) {
    return {

        Logger: Logger,

        // @TODO make this better!
        predefinedProperties: ['_aggregatedEvents', 'authorisations', '_id', 'role', 'applications', 'inherits', 'onCreate', 'onChange', 'onDelete', 'permissions', 'privileges', 'created', 'lastModified'],

        metaPropPrefix: '',

        context: this,

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

        StorageTemplate: StorageTemplate$1,
        ProcessorTemplate: ProcessorTemplate$1,
        ObserverTemplate: ObserverTemplate$1,

        processors: {},
        observers: {},

    }
}

var exceptions = {
    NoOnChangeException: function(message) {
        this.message = "onChange not found";
        this.name = 'NoOnChangeException';
    },

    General: function(message) {
        this.message = message;
        this.name = 'Exception';
    },

    NoMetaException: function(message) {
        this.message = "meta not found";
        this.name = 'NoMetaException';
    },

    NoOnDeleteException: function(message) {
        this.message = "onDelete not found";
        this.name = 'NoOnDeleteException';
    },

    NoEventIdException: function(message) {
        this.message = "No Event ID provided";
        this.name = 'NoEventIdException';
    },

    InvalidTypeException: function(message) {
        this.message = message + " is not a valid type";
        this.name = 'InvalidTypeException';
    },

    InvalidValueException: function(value, type) {
        this.message = value + " is not valid. Type must be: " + type;
        this.name = 'InvalidValueException';
    },

    InvalidFormatException: function() {
        this.message = "Invlid format";
        this.name = 'InvalidFormatException';
    },

    DuplicatePropertyException: function(message) {
        this.message = "Property " + message + " already exists in this object";
        this.name = 'DuplicatePropertyException';
    },

    DuplicateActionException: function(message) {
        this.message = "Action " + message + " already exists in this object";
        this.name = 'DuplicateActionException';
    },

    DuplicateApplicationException: function(message) {
        this.message = "Application " + message + " already exists in this object";
        this.name = 'DuplicateApplicationException';
    },

    NoSuchApplicationException: function(message) {
        this.message = "Application " + message + " does not exist in this object";
        this.name = 'NoSuchApplicationException';
    },

    NoSuchReminderException: function(message) {
        this.message = "Reminder " + message + " does not exist in this event";
        this.name = 'NoSuchReminderException';
    },

    DuplicateEventException: function(message) {
        this.message = "Event " + message + " already exists in this object";
        this.name = 'DuplicateEventException';
    },

    NoSuchTemplateException: function(message) {
        this.message = "Template id " + message + " does not exist";
        this.name = 'NoSuchTemplateException';
    },

    NotAnEventException: function(message) {
        this.message = "Property " + message + " is not an event";
        this.name = 'NotAnEventException';
    },

    NoSuchObjectException: function(message) {
        this.message = "Object id " + message + " does not exist";
        this.name = 'NoSuchObjectException';
    },

    NoSuchPropertyException: function(message) {
        this.message = "Property " + message + " does not exist in this object";
        this.name = 'NoSuchPropertyException';
    },

    NoSuchEventException: function(message) {
        this.message = "Event " + message + " does not exist in this object";
        this.name = 'NoSuchEventException';
    },

    PropertyNotFoundException: function(message) {
        this.message = "Property " + message + " does not exist in this object";
        this.name = 'PropertyNotFoundException';
    },

    MissingAttributeException: function(message) {
        this.message = "Missing attibute " + message + " in this object";
        this.name = 'MissingAttributeException';
    },

    CallbackErrorException: function(message) {
        this.message = message;
        this.name = 'CallbackErrorException';
    },

    InvalidDateException: function(message) {
        this.message = message + " is not a valid date";
        this.name = 'InvalidDateException';
    },

    InvalidActionException: function(message) {
        this.message = message + " is not a valid event action";
        this.name = 'InvalidActionException';
    },

    InvalidDataTypeException: function(message, type) {
        this.message = message + " is not of type " + type;
        this.name = 'InvalidDataTypeException';
    },

    NotATemplateExteptopn: function(message) {
        this.message = message + " is not a template";
        this.name = 'NotATemplateExteptopn';
    },

    InvalidPrivilegeException: function(message) {
        this.message = "Invalid privileges format";
        this.name = 'InvalidPrivilegeException';
    },

    NoSuchPrivilegeException: function(message) {
        this.message = "Privilege does not exist";
        this.name = 'NoSuchPrivilegeException';
    },

    NoSuchPermissionException: function(message) {
        this.message = "Permission " + message + " does not exist";
        this.name = 'NoSuchPermissionException';
    },

    InvalidPermissionException: function(message) {
        this.message = "Permission format invalid";
        this.name = 'InvalidPermissionException';
    },

    InvalidEventIdException: function(message) {
        this.message = "Event ID format not valid: " + message;
        this.name = 'InvalidEventIdException';
    },


    NoHandlerProvidedException: function(message) {
        this.message = "No handler provided " + message;
        this.name = 'NoHandlerProvidedException';
    },

    HandlerExistsException: function(message) {
        this.message = "Handler " + message + " already exists";
        this.name = 'HandlerExistsException';
    },

    HandlerNotFoundException: function(message) {
        this.message = "Handler " + message + " not found";
        this.name = 'HandlerNotFoundException';
    },

    InvalidArgumentException: function(message) {
        this.message = "Invalid argument";
        this.name = 'InvalidArgumentException';
    },

    InvalidHandlerException: function(message) {
        this.message = "Invalid handler";
        this.name = 'InvalidHandlerException';
    },

    LackOfPermissionsException: function(message) {

        if (Array.isArray(message)) {
            var result = "No permissions to perform these operations: ";

            message.forEach(function(m) {
                result += "(" + m.name + ": " + m.key + ") ";
            });

            this.message = result;
            this.name = 'LackOfPermissionsException';
        } else {
            this.message = "No permissions to perform this operation";
            this.name = 'LackOfPermissionsException';
        }

    }
};

/*var shortid = require('shortid');
var exceptions = require('../lib/dependencies/exceptions.js');*/


function generalFunctions(OBJY) {
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

        clone() {
            let objyClone = {};
            let ctx = Object.assign({}, OBJY.globalCtx);

            this.objectFamilies.forEach((objFamily) => {
                let params = OBJY.globalCtx.familyParams[objFamily];

                objyClone[params.name] = function (obj) {
                    //return OBJY.SingleProxy(obj, params.name, this, params);

                    return new OBJY.Obj(obj, params.name, ctx, params);
                };

                objyClone[params.pluralName] = function (objs, flags) {
                    return new OBJY.Objs(objs, params.name, ctx, params, flags);
                };
            });

            objyClone.client = (client) => {
                if (!client) throw new exceptions.General('No client specified');
                ctx.activeTenant = client;
            };

            objyClone.useUser = (user) => {
                ctx.activeUser = user;
            };

            objyClone.app = (app) => {
                ctx.activeApp = app;
            };

            objyClone.globalCtx = ctx;

            return objyClone;
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
            OBJY.globalCtx.activeTenant = client;
            return this;
        },

        /**
         * Sets user context
         * @param {user} - the user object
         * @returns {this}
         */
        useUser: function(user) {
            OBJY.globalCtx.activeUser = user;
            return this;
        },

        /**
         * Sets app context
         * @param {app} - the app identifier
         * @returns {this}
         */
        app: function(app) {
            //if (!app) throw new Error("No app specified");
            OBJY.globalCtx.activeApp = app;

            return this;
        },

        getPropsObject: function(obj, params) {
            
            return obj;
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

            if (property.hasOwnProperty('conditions')) ;
        },

        execProcessorAction: function(dsl, beforeObj, afterObj, prop, callback, client, options) {
            let processorApp = OBJY.globalCtx?.activeApp || ((beforeObj || {}).applications || {})[0] || ((afterObj || {}).applications || {})[0];
            let role = (beforeObj || {}).role || (afterObj || {}).role;
            OBJY.Logger.log('triggering dsl');
            this.processors[role].execute(dsl, beforeObj, afterObj, prop, callback, client, processorApp, OBJY.globalCtx?.activeUser, options);
        },


        ID: function() {
            var text = "";
            var possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789,;-_"; // NO DOT!!! 

            for (var i = 0; i < 25; i++)
                text += possible.charAt(Math.floor(Math.random() * possible.length));

            return text;
        },

        RANDOM: function(amount) {
            return shortid$1.generate();
        },


        checkConstraints: function(obj, operation) {
            var messages = [];
            if (!obj['_constraints']) return false;
            obj._constraints.forEach(c => {
                if (obj[c.key]) {
                    if (typeof c.validate === 'function') {
                        var res = c.validate(obj[c.key]);
                        if (!res) messages.push(c.key);
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
                                if (!res && !messages.includes(c.key)) messages.push(c.key);
                            }
                        }
                    }
                    getValue(obj, c.key);
                }
            });
            if (!messages.length) return true;
            else return messages
        }

    }
}

//var Query;
//(function() {
    function objectify(a) {
        var rows = [];
        for (var key in a) {
            var o = {};
            o[key] = a[key];
            rows.push(o);
        }
        return rows
    }
    if (!String.prototype.startsWith) {
        Object.defineProperty(String.prototype, "startsWith", {
            enumerable: false,
            configurable: false,
            writable: false,
            value: function(searchString, position) {
                position = position || 0;
                return this.lastIndexOf(searchString, position) === position
            }
        });
    }
    if (!String.prototype.endsWith) {
        Object.defineProperty(String.prototype, "endsWith", {
            value: function(searchString, position) {
                var subjectString = this.toString();
                if (position === undefined || position > subjectString.length) {
                    position = subjectString.length;
                }
                position -= searchString.length;
                var lastIndex = subjectString.indexOf(searchString, position);
                return lastIndex !== -1 && lastIndex === position
            }
        });
    }
    var Query = {
        satisfies: function(row, constraints, getter) {
            return Query.lhs._rowsatisfies(row, constraints, getter)
        },
        Query: function(constraints, getter) {
            return function(row) {
                return Query.lhs._rowsatisfies(row, constraints, getter)
            }
        },
        join: function(left_rows, right_rows, left_key, right_key) {
            return left_rows
        },
        query: function(rows, constraints, getter) {
            if (typeof getter == "string") {
                var method = getter;
                getter = function(obj, key) {
                    return obj[method](key)
                };
            }
            var filter = new Query.Query(constraints, getter);
            return rows.filter(filter)
        },
        lhs: {
            _rowsatisfies: function(row, constraints, getter) {
                for (var key in constraints) {
                    if (this[key]) {
                        if (!this[key](row, constraints[key], getter)) return false
                    } else {
                        var val = getter ? getter(row, key) : row[key];
                        var res = this.rhs._satisfies(val, constraints[key], key);
                        if (!res) return false
                    }
                }
                return true
            },
            $count: function(row, condition, getter) {
                var res = condition.$constraints.map(function(c) {
                    return Query.satisfies(row, c, getter)
                }).filter(function(v) {
                    return v
                }).length;
                return this.rhs._satisfies(res, condition.$constraint)
            },
            $not: function(row, constraint, getter) {
                return !this._rowsatisfies(row, constraint, getter)
            },
            $or: function(row, constraint, getter) {
                if (!Array.isArray(constraint)) {
                    constraint = objectify(constraint);
                }
                for (var i = 0; i < constraint.length; i++) {
                    if (this._rowsatisfies(row, constraint[i], getter)) return true
                }
                return false
            },
            $and: function(row, constraint, getter) {
                if (!Array.isArray(constraint)) {
                    constraint = objectify(constraint);
                }
                for (var i = 0; i < constraint.length; i++) {
                    if (!this._rowsatisfies(row, constraint[i], getter)) return false
                }
                return true
            },
            $nor: function(row, constraint, getter) {
                return !this.$or(row, constraint, getter)
            },
            $where: function(values, ref) {
                var fn = typeof ref == "string" ? new Function(ref) : ref;
                var res = fn.call(values);
                return res
            },
            rhs: {
                $cb: function(value, constraint, parentKey) {
                    return constraint(value)
                },
                _satisfies: function(value, constraint, parentKey) {
                    if (constraint === value) return true;
                    else if (constraint instanceof RegExp) return this.$regex(value, constraint);
                    else if (Array.isArray(constraint)) return this.$in(value, constraint);
                    else if (constraint && typeof constraint === "object") {
                        if (constraint instanceof Date) return this.$eq(value, constraint.getTime());
                        else {
                            if (constraint.$regex) return this.$regex(value, new RegExp(constraint.$regex, constraint.$options));
                            for (var key in constraint) {
                                if (!this[key]) return this.$eq(value, constraint, parentKey);
                                else if (!this[key](value, constraint[key], parentKey)) return false
                            }
                            return true
                        }
                    } else if (Array.isArray(value)) {
                        for (var i = 0; i < value.length; i++)
                            if (this.$eq(value[i], constraint)) return true;
                        return false
                    } else if (constraint === "" || constraint === null || constraint === undefined) return this.$null(value);
                    else return this.$eq(value, constraint)
                },
                $eq: function(value, constraint) {
                    if (value === constraint) return true;
                    else if (Array.isArray(value)) {
                        for (var i = 0; i < value.length; i++)
                            if (this.$eq(value[i], constraint)) return true;
                        return false
                    } else if (constraint === null || constraint === undefined || constraint === "") {
                        return this.$null(value)
                    } else if (value === null || value === "" || value === undefined) return false;
                    else if (value instanceof Date) {
                        if (constraint instanceof Date) {
                            return value.getTime() == constraint.getTime()
                        } else if (typeof constraint == "number") {
                            return value.getTime() == constraint
                        } else if (typeof constraint == "string") return value.getTime() == new Date(constraint).getTime()
                    } else {
                        return value == constraint
                    }
                },
                $exists: function(value, constraint, parentKey) {
                    return value != undefined == (constraint && true)
                },
                $deepEquals: function(value, constraint) {
                    if (typeof _ == "undefined" || typeof _.isEqual == "undefined") {
                        return JSON.stringify(value) == JSON.stringify(constraint)
                    } else {
                        return _.isEqual(value, constraint)
                    }
                },
                $not: function(values, constraint) {
                    return !this._satisfies(values, constraint)
                },
                $ne: function(values, constraint) {
                    return !this._satisfies(values, constraint)
                },
                $nor: function(values, constraint, parentKey) {
                    return !this.$or(values, constraint, parentKey)
                },
                $and: function(values, constraint, parentKey) {
                    if (!Array.isArray(constraint)) {
                        throw new Error("Logic $and takes array of constraint objects")
                    }
                    for (var i = 0; i < constraint.length; i++) {
                        var res = this._satisfies(values, constraint[i], parentKey);
                        if (!res) return false
                    }
                    return true
                },
                $or: function(values, constraint, parentKey) {
                    if (!Array.isArray(values)) {
                        values = [values];
                    }
                    for (var v = 0; v < values.length; v++) {
                        for (var i = 0; i < constraint.length; i++) {
                            if (this._satisfies(values[v], constraint[i], parentKey)) {
                                return true
                            }
                        }
                    }
                    return false
                },
                $null: function(values) {
                    if (values === "" || values === null || values === undefined) {
                        return true
                    } else if (Array.isArray(values)) {
                        for (var v = 0; v < values.length; v++) {
                            if (!this.$null(values[v])) {
                                return false
                            }
                        }
                        return true
                    } else return false
                },
                $in: function(values, constraint) {
                    if (!Array.isArray(constraint)) throw new Error("$in requires an array operand");
                    var result = false;
                    if (!Array.isArray(values)) {
                        values = [values];
                    }
                    for (var v = 0; v < values.length; v++) {
                        var val = values[v];
                        for (var i = 0; i < constraint.length; i++) {
                            if (this._satisfies(val, constraint[i])) {
                                result = true;
                                break
                            }
                        }
                        result = result || constraint.indexOf(val) >= 0;
                    }
                    return result
                },
                $likeI: function(values, constraint) {
                    return values.toLowerCase().indexOf(constraint) >= 0
                },
                $like: function(values, constraint) {
                    return values.indexOf(constraint) >= 0
                },
                $startsWith: function(values, constraint) {
                    if (!values) return false;
                    return values.startsWith(constraint)
                },
                $endsWith: function(values, constraint) {
                    if (!values) return false;
                    return values.endsWith(constraint)
                },
                $elemMatch: function(values, constraint, parentKey) {
                    for (var i = 0; i < values.length; i++) {
                        if (Query.lhs._rowsatisfies(values[i], constraint)) return true
                    }
                    return false
                },
                $contains: function(values, constraint) {
                    return values.indexOf(constraint) >= 0
                },
                $nin: function(values, constraint) {
                    return !this.$in(values, constraint)
                },
                $regex: function(values, constraint) {
                    if (Array.isArray(values)) {
                        for (var i = 0; i < values.length; i++) {
                            if (constraint.test(values[i])) {
                                return true
                            }
                        }
                    } else return constraint.test(values)
                },
                $gte: function(values, ref) {
                    return !this.$null(values) && values >= this.resolve(ref)
                },
                $gt: function(values, ref) {
                    return !this.$null(values) && values > this.resolve(ref)
                },
                $lt: function(values, ref) {
                    return !this.$null(values) && values < this.resolve(ref)
                },
                $lte: function(values, ref) {
                    return !this.$null(values) && values <= this.resolve(ref)
                },
                $before: function(values, ref) {
                    if (typeof ref === "string") ref = Date.parse(ref);
                    if (typeof values === "string") values = Date.parse(values);
                    return this.$lte(values, ref)
                },
                $after: function(values, ref) {
                    if (typeof ref === "string") ref = Date.parse(ref);
                    if (typeof values === "string") values = Date.parse(values);
                    return this.$gte(values, ref)
                },
                $type: function(values, ref) {
                    return typeof values == ref
                },
                $all: function(values, ref) {
                    throw new Error("$all not implemented")
                },
                $size: function(values, ref) {
                    return typeof values == "object" && (values.length == ref || Object.keys(values).length == ref)
                },
                $mod: function(values, ref) {
                    return values % ref[0] == ref[1]
                },
                $equal: function() {
                    return this.$eq(arguments)
                },
                $between: function(values, ref) {
                    return this._satisfies(values, {
                        $gt: ref[0],
                        $lt: ref[1]
                    })
                },
                resolve: function(ref) {
                    if (typeof ref === "object") {
                        if (ref["$date"]) return Date.parse(ref["$date"])
                    }
                    return ref
                }
            }
        }
    };
    Query.undot = function(obj, key) {
      
        var keys = key.split("."),
            sub = obj;

        for (var i = 0; i < keys.length; i++) {
          
            if(sub)
                sub = sub[keys[i]];
        }
        return sub
    };
    Query.lhs.rhs.$equal = Query.lhs.rhs.$eq;
    Query.lhs.rhs.$any = Query.lhs.rhs.$or;
    Query.lhs.rhs.$all = Query.lhs.rhs.$and;
    Query.satisfies = function(row, constraints, getter) {
        return this.lhs._rowsatisfies(row, constraints, getter)
    };
    Array.prototype.query = function(q) {
        return Query.query(this, q)
    };
    RegExp.prototype.toJSON = RegExp.prototype.toString;

//module.exports = Query;

//var Query = require('../lib/dependencies/query.js');

 var isObject$2 = function(a) {
    return (!!a) && (a.constructor === Object);
};

function applyFunctions (OBJY) {
    return {

        /**
         * Applies affect rules
         * @param {afterObj} - the afterObject
         * @param {operation} - the operation (onChange, onCreate and onDelete)
         * @param {insstance} - the current afterObjy context
         * @param {client} - the active client
         */
        applyAffects: function(afterObj, context, client, params) {
            this.affectables.forEach(function(a) {
                if (Query.query([afterObj], a.affects, Query.undot).length != 0) {

                    var template = a.apply;
                    var templateId = a._id;

                    if (template.name) {
                        if (!afterObj.name) afterObj.name = template.name;
                    }

                    if (template.type) {
                        if (!afterObj.type) afterObj.type = template.type;
                    }

                    // Object handlers

                    ['onCreate', 'onChange', 'onDelete'].forEach(function(h) {
                        if (template[h]) {
                            Object.keys(template[h]).forEach(function(oC) {
                                if (!afterObj[h]) afterObj[h] = {};
                                if (!afterObj[h][oC]) {
                                    if(!template[h][oC]) return;
                                    afterObj[h][oC] = template[h][oC];
                                    afterObj[h][oC].template = templateId;
                                }
                            });
                        }
                    });

                   
                // Properties
                function doTheProps(template, obj, extendedStructure) {

                    if (!obj) obj = {};

                    if (!template) template = {};

                    //if (params.object && !obj.hasOwnProperty(params.propsObject)) obj[params.propsObject] = {};

                        if(extendedStructure && typeof extendedStructure == "object"){
                            Object.keys(extendedStructure).forEach(k => {
                                if(isObject$2(extendedStructure[k]) && template[k]){
                                    doTheProps(template[k], obj[k], extendedStructure[k]);
                                }
                            });
                        }

                    Object.keys(template).forEach(function(p) {

                        if ((OBJY.predefinedProperties.includes(p)/* || (isObject(template[p]) || Array.isArray(template[p]))*/)) return;

                        if (!template[p]) return;

                        if(isObject$2(template[p]))  doTheProps(template[p], obj[p]);

                        var cloned = JSON.parse(JSON.stringify(template[p]));

                        if (!obj.hasOwnProperty(p)) {

                            obj[p] = cloned;
                            if(isObject$2(obj[p])) obj[p].template = templateId;
                            //delete obj[p].overwritten;

                        } else if (isObject$2(obj[p])) {

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
                            Object.keys(template.permissions).forEach(function(p) {
                                if (!obj.permissions[p]) {
                                    obj.permissions[p] = template.permissions[p];
                                    obj.permissions[p].template = templateId;
                                } else {
                                    obj.permissions[p].template = templateId;
                                    obj.permissions[p].overwritten = true;
                                }
                            });
                        }

                        ['onCreate', 'onChange', 'onDelete'].forEach(function(h) {
                            if (template[p][h]) {
                                if (!obj[p][h]) obj[p][h] = {};

                                Object.keys(template[p][h]).forEach(function(oC) {

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


                doTheProps(template, afterObj, params.extendedStructure);

                    // Applications

                    if (template.applications) {
                        template.applications.forEach(function(a) {
                            if (afterObj.applications)
                                if (afterObj.applications.indexOf(a) == -1) afterObj.applications.push(a);
                        });
                    }


                    if (template._clients) {
                        template._clients.forEach(function(a) {
                            if ((afterObj._clients || []).indexOf(a) == -1)(afterObj._clients || []).push(a);
                        });
                    }

                    if (template.authorisations) {
                        var keys = Object.keys(template.authorisations);

                        if (keys.length > 0) {
                            if (!afterObj.authorisations) afterObj.authorisations = {};
                        }

                        keys.forEach(function(k) {

                            if (!afterObj.authorisations[k]) {
                                afterObj.authorisations[k] = template.authorisations[k];

                                afterObj.authorisations[k].forEach(function(a) {
                                    a.template = template._id;
                                });

                            } else {
                                template.authorisations[k].forEach(function(a) {

                                    var f = false;
                                    afterObj.authorisations[k].forEach(function(afterObjA) {
                                        if (JSON.stringify(afterObjA.query) == JSON.stringify(a.query)) f = true;
                                    });

                                    if (f) {
                                        a.overwritten = true;
                                    } else {
                                        a.template = template._id;
                                        afterObj.authorisations[k].push(a);
                                    }
                                });
                            }
                        });
                    }

                    // Permissions

                    if (template.permissions) {
                        if (!afterObj.permissions) afterObj.permissions = {};
                        Object.keys(template.permissions).forEach(function(p) {
                            if (!afterObj.permissions[p]) {
                                afterObj.permissions[p] = template.permissions[p];
                                afterObj.permissions[p].template = templateId;
                            } else {
                                afterObj.permissions[p].template = templateId;
                                afterObj.permissions[p].overwritten = true;
                            }
                        });
                    }

                    // Privileges

                    if (template.privileges) {
                        if (!afterObj.privileges) afterObj.privileges = {};
                        Object.keys(template.privileges).forEach(function(a) {
                            if (!afterObj.privileges[a]) afterObj.privileges[a] = [];

                            template.privileges[a].forEach(function(tP) {

                                afterObj.privileges[a].forEach(function(oP) {
                                    if (oP.name == tP.name) ;
                                });
                            });

                            if (!contains) {
                                afterObj.privileges[a].push({
                                    name: tP.name,
                                    template: templateId
                                });
                            }

                        });
                    }

                }
            });

        },

        // THIS IS A PROTOTYPE!!!
        // removes stuff, that was inserted by affects
        // for now, only
        unapplyHiddenAffects: function(afterObj, operation, context, client, params) {
            this.affectables.forEach(function(a) {
                if (Query.query([afterObj], a.affects, Query.undot).length != 0) {

                    var template = a.apply;
                    a._id;

                    // Object handlers
                    ['onCreate', 'onChange', 'onDelete'].forEach(function(h) {
                        if (template[h]) {
                            Object.keys(template[h]).forEach(function(oC) {
                                if ((afterObj[h] || {})[oC]) {
                                    if (afterObj[h][oC].hidden == true)
                                        delete afterObj[h][oC];
                                }
                            });
                        }
                    });

                }
            });

        }

    }
}

/*var Query = require('../lib/dependencies/query.js');
var exceptions = require('../lib/dependencies/exceptions.js');*/


function permissionFunctions(OBJY) {
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
        checkPermissions: function(user, app, obj, permission, soft, context) {

            if(context.ignorePermissions == true) return true;

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

                permissions.forEach(function(p) {
                    perms[p.name] = { value: p.value };
                });

                permissions = perms;
            }

            if (app) {
                if (privileges['*']) {

                    Object.keys(permissions).forEach(function(pKey) {

                        privileges['*'].forEach(function(item) {
                            if (permissions[item.name]) {

                                if (((permissions[item.name] || {}).value || "").indexOf(permission) != -1 || (permissions[item.name] || {}).value == "*") allowed = true;
                            }

                            if (permissions["*"]) {
                                if (((permissions['*'] || {}).value || "").indexOf(permission) != -1 || (permissions['*'] || {}).value == "*") allowed = true;
                            }
                        });

                    });

                    if (allowed) return true;

                } else if (privileges[app]) {

                    privileges[app].forEach(function(item) {
                        if (permissions[item.name]) {

                            if (((permissions[item.name] || {}).value || "").indexOf(permission) != -1 || (permissions[item.name] || {}).value == "*") allowed = true;
                        }

                        if (permissions["*"]) {
                            if (((permissions['*'] || {}).value || "").indexOf(permission) != -1 || (permissions['*'] || {}).value == "*") allowed = true;
                        }
                    });

                    if (!allowed) return false;
                    else return true

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
        checkAuthroisations: function(obj, user, condition, app, context) {

            if(context.ignoreAuthorisations == true) return true;

            var authorisations;
            if (!user) return true;

            if (user.spooAdmin) return true;

            if (Object.keys(user.authorisations || {}).length == 0) return true; //throwError();

            if (!app && !user.authorisations['*']) {
                return false
            }

            if (user.authorisations['*']) authorisations = user.authorisations['*'];
            else if (app && !user.authorisations[app]) {
                return false
            } else authorisations = user.authorisations[app];

            var permCheck = [obj];

            var query = { $or: [] };

            authorisations.forEach(function(a) {

                if (typeof a.query === "string") {
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

                if (a.perm.indexOf(condition) != -1 || a.perm.indexOf("*") != -1) query.$or.push(a.query);
            });
  
            if (query.$or.length == 0) return false;

            if (Query.query(permCheck, query, Query.undot).length == 0) return false;
            else return true
        },

        /**
         * Add permissions to a query
         * @param {query} - the initial query
         * @param {user} - the user object
         * @param {app} - the current application
         * @returns {query} - the final query with permissions
         */
        buildPermissionQuery: function(query, user, app, context) {

            if(context.ignorePermissions == true) return query;

            if (query.$query) {
                query = JSON.parse(JSON.stringify(query.$query));
                delete query.$query;
            }

            if (!user.spooAdmin) {

                if(query.$sum || query.$count || query.$avg) return query;

                if (!user.privileges) return query;

                if (app && user.privileges[app]) {
                    var privArr = [];
                    user.privileges[app].forEach(function(p) {

                        var inn = {};

                        inn["permissions." + p.name + ".value"] = { $regex: "r" };
                        privArr.push(inn);
                        //inn = {};
                        //inn["permissions." + p.name] = { $regex: "r" }
                        //privArr.push(inn);
                        inn = {};
                        inn["permissions." + p.name + ".value"] = "*";
                        privArr.push(inn);

                        inn = {};
                        inn["permissions.name"] = p.name;
                        privArr.push(inn);
                        //inn = {};
                        //inn["permissions." + p.name] = "*";
                        //privArr.push(inn);
                    });

                    var inn = {};
                    inn["permissions.*" + ".value"] = { $regex: "r" };
                    privArr.push(inn);
                    inn = {};
                    inn["permissions.*"] = { $regex: "r" };
                    privArr.push(inn);
                    inn = {};
                    inn["permissions.*" + ".value"] = "*";
                    privArr.push(inn);
                    //var inn = {};
                    //inn["permissions.*"] = "*"
                    //privArr.push(inn);


                    if (Object.keys(query).length > 0) {

                        return { $and: [query, { $or: privArr }] }
                    } else {
                        return { $or: privArr }
                    }
                } else if (!app) {
                    return query;
                } else return query;

            } else {
                return query
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
        buildAuthroisationQuery: function(obj, user, condition, app, context) {

            if(context.ignoreAuthorisations == true) return obj;

            var authorisations;
            if (!user) return obj;

            if (user.spooAdmin) return obj;

            if(obj.$sum || obj.$count || obj.$avg) return obj;
            

            function throwError() {
                throw new exceptions.LackOfPermissionsException("Lack of permissions")
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

            authorisations.forEach(function(a) {
                try {
                    a.query = JSON.parse(a.query);
                } catch (e) {

                }

                if (a.query.$query) {
                    a.query = JSON.parse(JSON.stringify(a.query.$query));
                    delete a.query.$query;
                }

                if (a.perm.indexOf(condition) != -1 || a.perm.indexOf("*") != -1) {
                    if (Object.keys(a.query).length == 0) wildcard = true;
                    else {
                        query.push({ '$and': [a.query, obj] });
                    }
                }
            });
  
            if (query.length == 0 && !wildcard) throw new exceptions.LackOfPermissionsException("Lack of permissions")

            query = { $or: query };

            return query;
        },

        /**
         * Chains permission information, when performing multiple operations
         * @param {obj} - the object
         * @param {context} - the OBJY context
         * @param {code} - the permission code
         * @param {name} - the permission name
         * @param {key} - the permission key
         */
        chainPermission: function(obj, context, code, name, key) {

            if (['c', 'r', 'u', 'd', 'x'].includes(code)) ; else code = 'u';

            if (obj.permissions) {
                if (Object.keys(obj.permissions).length > 0) {
                    if (!context.permissionSequence[obj._id]) context.permissionSequence[obj._id] = [];

                    if (!OBJY.checkPermissions(context.activeUser, context.activeApp, obj, code, true, context))
                        context.permissionSequence[obj._id].push({
                            name: name,
                            key: key
                        });
                }
            }
        },

        getElementPermisson: function(element) {
            if (!element) return {};
            else if (!element.permissions) return {};
            else return element.permissions;
        },

    }
}

//var exceptions = require('../lib/dependencies/exceptions.js');


function objectFunctions(OBJY) {
    return {

        updateInheritedObjs: function(templ, pluralName, success, error, client, params, context) {
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

        removeInheritedObjs: function(templ, pluralName, success, error, client) {
            var code = ` 
            OBJY['${pluralName}']({inherits: {$in: ["${templ._id}"]}}).get(function(data){
                data.forEach(function(d){
                    d.removeInherit(${templ._id})
                    d.update();
                })
            })`;

            this.execProcessorAction(code, templ, null, null, function(data) {

            }, client, {});
        },


        prepareObjectDelta: function(oldObj, newObj, params, context) {

            var meta = ['name', 'type'];
            meta.forEach(function(p) {
                if (newObj[p] != oldObj[p]) oldObj[p] = newObj[p];
            });


            var handlers = ['onCreate', 'onChange', 'onDelete'];
            handlers.forEach(function(h) {
                if (newObj[h]) {
                    Object.keys(newObj[h]).forEach(function(oC) {
                        if (newObj[h][oC]) {
                            if (newObj[h][oC].value != oldObj[h][oC].value)
                                oldObj[h][oC].value = newObj[h][oC].value;
                            oldObj[h][oC].overwritten = true;
                        }
                    });
                }
            });

            // Properties
            function doTheProps(newObj) {

                Object.keys(obj).forEach(function(p) {

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
                        Object.keys(obj.permissions).forEach(function(p) {
                            if (obj.permissions[p]) {
                                if (JSON.stringify(obj.permissions[p]) != JSON.stringify(oldObj.permissions[p]))
                                    oldObj.permissions[p] = obj.permissions[p];
                                oldObj.permissions[p].overwritten = true;
                            }
                        });
                    }

                    if (obj[p]) {
                        handlers.forEach(function(h) {
                            if (obj[p][h]) {
                                Object.keys(obj[p][h]).forEach(function(oC) {
                                    if (obj[p][h][oC]) {
                                        if (obj[p][h][oC].value != oldObj[p][h][oC].value)
                                            oldObj[p][h][oC].value = obj[p][h][oC].value;
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
                Object.keys(newObj.permissions).forEach(function(p) {
                    if (newObj.permissions[p]) {
                        if (newObj.permissions[p].value != oldObj.permissions[p].value)
                            oldObj.permissions[p].value = newObj.permissions[p].value;
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

        getTemplateFieldsForObject: function(obj, templateId, success, error, client, templateRole, templateSource, params, context) {

            if(params.templateFamily === null) return success(obj);

            var self = this;


            var isObject = function(a) {
                return (!!a) && (a.constructor === Object);
            };

            function run(template) {

                if (template.name) {
                    if (!obj.name) obj.name = template.name;
                }

                if (template.type) {
                    if (!obj.type) obj.type = template.type;
                }

                // Object handlers

                ['onCreate', 'onChange', 'onDelete'].forEach(function(h) {
                    if (template[h]) {
                        Object.keys(template[h]).forEach(function(oC) {


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
                function doTheProps(template, obj, extendedStructure) {

                    if (!obj) obj = {};

                    if (!template) template = {};

                    //if (params.object && !obj.hasOwnProperty(params.propsObject)) obj[params.propsObject] = {};

                        if(extendedStructure && typeof extendedStructure == "object"){
                            Object.keys(extendedStructure).forEach(k => {
                                if(isObject(extendedStructure[k]) && template[k]){
                                    doTheProps(template[k], obj[k], extendedStructure[k]);
                                }
                            });
                        }

                    Object.keys(template).forEach(function(p) {

                        if ((OBJY.predefinedProperties.includes(p)/* || (isObject(template[p]) || Array.isArray(template[p]))*/)) return;

                        if (!template[p]) return;

                        if(isObject(template[p]))  doTheProps(template[p], obj[p]);

                        var cloned = JSON.parse(JSON.stringify(template[p]));

                        if (!obj.hasOwnProperty(p)) {

                            obj[p] = cloned;
                            if(isObject(obj[p])) obj[p].template = templateId;
                            //delete obj[p].overwritten;

                        } else if (isObject(obj[p])) {

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
                            Object.keys(template.permissions).forEach(function(p) {
                                if (!obj.permissions[p]) {
                                    obj.permissions[p] = template.permissions[p];
                                    obj.permissions[p].template = templateId;
                                } else {
                                    obj.permissions[p].template = templateId;
                                    obj.permissions[p].overwritten = true;
                                }
                            });
                        }

                        ['onCreate', 'onChange', 'onDelete'].forEach(function(h) {
                            if (template[p][h]) {
                                if (!obj[p][h]) obj[p][h] = {};

                                Object.keys(template[p][h]).forEach(function(oC) {

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


                doTheProps(template, obj, params.extendedStructure);

                // Applications

                if (template.applications) {
                    template.applications.forEach(function(a) {
                        if (obj.applications)
                            if (obj.applications.indexOf(a) == -1) obj.applications.push(a);
                    });
                }

                if (template.authorisations) {
                    var keys = Object.keys(template.authorisations);

                    if (keys.length > 0) {
                        if (!obj.authorisations) obj.authorisations = {};
                    }

                    keys.forEach(function(k) {


                        if (!obj.authorisations[k]) {
                            obj.authorisations[k] = template.authorisations[k];

                            obj.authorisations[k].forEach(function(a) {
                                a.template = template._id;
                            });

                        } else {
                            template.authorisations[k].forEach(function(a) {

                                var f = false;
                                obj.authorisations[k].forEach(function(objA) {
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
                    Object.keys(template.permissions).forEach(function(p) {
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
                    Object.keys(template.privileges).forEach(function(a) {
                        if (!obj.privileges[a]) obj.privileges[a] = [];


                        template.privileges[a].forEach(function(tP) {

                            var contains = false;

                            obj.privileges[a].forEach(function(oP) {
                                if (oP.name == tP.name) contains = true;
                            });

                            if (!contains) {
                                obj.privileges[a].push({
                                    name: tP.name,
                                    template: templateId
                                });
                            }

                        });


                    });
                }

                success(obj);

            }

            if (self.caches[templateRole || obj.role].get(templateId)) ; else {



                OBJY.getObjectById(templateRole || obj.role, templateId, function(template) {

                    //if (!self.caches[templateRole || obj.role].get(templateId)) self.caches[templateRole || obj.role].add(templateId, template);

                    var counter = 0;


                    if ((template.inherits || []).length == 0) run(template);
                    else {


                        template.inherits.forEach(function(i) {


                            OBJY.getTemplateFieldsForObject(template, i, function() {

                                    counter++;

                                    // console.log('counter', counter, template, i);

                                    if (counter == template.inherits.length) run(template);
                                },
                                function(err) {
                                    counter++;

                                    if (counter == template.inherits.length) run(template);


                                }, client, templateRole || obj.role, templateSource || context.activeTenant, params, context);

                        });


                    }

                    //run(template)

                }, function(err) {
                    error(err);
                }, context.activeApp, templateSource || context.activeTenant);


                /*OBJY[templateRole || obj.role](templateId).get(function(template) {

                    //if(!self.caches[templateRole || obj.role].get(templateId)) self.caches[templateRole || obj.role].add(templateId,  template);

                    run(template)

                }, function(err) {
                    error(err);
                }, templateSource)*/
            }


        },

        removeTemplateFieldsForObject: function(obj, templateId, success, error, client, params, context) {

            if(params.templateFamily === null) return success(obj);

            if (!templateId) {
                error('template not found');
                return;
            }
            // Object handlers

            ['onCreate', 'onChange', 'onDelete'].forEach(function(h) {
                if (obj[h]) {
                    Object.keys(obj[h]).forEach(function(oC) {
                        if (obj[h][oC]) {
                            if (obj[h][oC].template == templateId && !obj[h][oC].overwritten)
                                delete obj[h][oC];
                        }
                    });
                }
            });

            var isObject = function(a) {
                return (!!a) && (a.constructor === Object);
            };


            function doTheProps(obj, extendedStructure) {

                if (obj) {

                    Object.keys(obj).forEach(function(p) {

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
                            ['onCreate', 'onChange', 'onDelete'].forEach(function(h) {
                                if (obj[p][h]) {

                                    object.keys(obj[p][h]).forEach(function(oC) {

                                        if (obj[p][h][oC]) {
                                            if (obj[p][h][oC].template == templateId && !obj[p][h][oC].overwritten)
                                                delete obj[p][h][oC];
                                        }
                                    });
                                }
                            });
                        }

                        if (obj[p].type == 'bag') {
                            return doTheProps(obj[p]);
                        }

                        if(extendedStructure && typeof extendedStructure == "object"){
                            Object.keys(extendedStructure).forEach(k => {
                                if(isObject(extendedStructure[k]) && k == p){
                                    doTheProps(obj[p], extendedStructure[k]);
                                }
                            });
                        }

                        if (obj[p]) ;

                    });

                }


            }

            doTheProps(obj, params.extendedStructure);


            // Applications: TODO!!!

            // Permissions
            if (obj.permissions) {
                Object.keys(obj.permissions).forEach(function(p) {
                    if (obj.permissions[p]) {
                        if (obj.permissions[p].template == templateId && !obj.permissions[p].overwritten)
                            delete obj.permissions[p];
                    }
                });
            }

            // Privileges
            if (obj.privileges) {
                Object.keys(obj.privileges).forEach(function(a) {
                    if (!Array.isArray(obj.privileges[a])) return;
                    obj.privileges[a].forEach(function(tP, i) {
                        if (tP.template == templateId && !tP.overwritten)
                            obj.privileges[a].splice(i, 1);
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

        updateObjAfterTemplateChange: function(templateId) {

        },



        removeTemplateFieldsToObject: function(obj, templateId) {
            this.getTemplateAsyn(templateId, function(template) {
                    var propertyKeys = Object.keys(template);
                    propertyKeys.forEach(function(property) {
                        if (obj[property] === undefined) {
                            this.removeTemplateFieldFromObjects(obj.template[property]);
                        }
                    });
                },
                function(error) {

                });
        },

        addTemplateToObject: function(obj, templateId, context) {
            var contains = false;
            obj.inherits.forEach(function(templ) {
                if (templ == templateId) contains = true;
            });


            if (!contains) {
                obj.inherits.push(templateId);
                OBJY.chainPermission(obj, context, 'i', 'addInherit', templateId);
                OBJY.chainCommand(obj, context, 'addInherit', templateId);
            }

        },

        addApplicationToObject: function(obj, application, context) {
            var contains = false;

            if (!obj.applications) obj.applications = [];

            obj.applications.forEach(function(app) {
                if (app == application) contains = true;
            });
            if (!contains) {
                obj.applications.push(application);
                OBJY.chainPermission(obj, context, 'a', 'addApplication', application);

            } else throw new exceptions.DuplicateApplicationException(application);

        },

        removeApplicationFromObject: function(obj, application, context) {
            var contains = false;
            obj.applications.forEach(function(app, i) {
                if (app == application) {
                    obj.applications.splice(i, 1);
                    contains = true;
                }
            });

            OBJY.chainPermission(obj, context, 'a', 'removeApplication', application);

            if (!contains) {
                throw new exceptions.NoSuchApplicationException(application);
            }
        },

        removeTemplateFromObject: function(obj, templateId, success, error, context) {

            obj.inherits.forEach(function(templ) {
            });

            if (obj.inherits.indexOf(templateId) != -1) {

                obj.inherits.splice(obj.inherits.indexOf(templateId), 1);

                OBJY.chainPermission(obj, context, 'i', 'removeInherit', templateId);
                OBJY.chainCommand(obj, context, 'removeInherit', templateId);

                success(obj);

            } else {
                error('Template not found in object');
            }


        },




        TemplatesCreateWrapper: function(obj, template) //addTemplateToObject!!!
        {
            var existing = false;
            obj.inherits.forEach(function(_template) {
                if (_template == template) existing = true;
            });
            if (!existing) {
                obj.inherits.push(template);

            }
        },


        ObjectPermissionsCreateWrapper: function(obj, permissions) //addTemplateToObject!!!
        {
            if (!typeof permissions == 'object') throw new exceptions.InvalidPermissionException();

            if (!permissions) return;

            var permissionKeys = Object.keys(permissions);
            permissionKeys.forEach(function(permission) {
                //if (!typeof permissions[permission] == 'string') throw new InvalidPermissionException();
                if (typeof permissions[permission] == 'string') {
                    permissions[permission] = {
                        value: permissions[permission]
                    };
                } else {
                    permissions[permission] = permissions[permission];
                }
            });
            return permissions;
        },

        ObjectOnCreateSetWrapper: function(obj, name, onCreate, trigger, type, context) {
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

            OBJY.chainPermission(obj, context, 'v', 'setOnCreateHandler', name);

            return onCreate;
        },

        ObjectOnCreateCreateWrapper: function(obj, onCreate, context) {
            //if (!typeof onchange == 'object') throw new exceptions.InvalidPermissionException();


            if (!onCreate) return;

            Object.keys(onCreate).forEach(function(oC) {
                if (!onCreate[oC].trigger) onCreate[oC].trigger = 'after';
                if (!onCreate[oC].type) onCreate[oC].type = 'async';

            });

            return onCreate;
        },

        AffectsCreateWrapper: function(obj, affects) {

            if (!affects) affects = {};

            return affects;
        },

        ApplyCreateWrapper: function(obj, apply) {

            if (!apply) apply = {};

            return apply;
        },

        ObjectOnChangeCreateWrapper: function(obj, onChange, context) {
            //if (!typeof onchange == 'object') throw new exceptions.InvalidPermissionException();

            if (!onChange) return;

            Object.keys(onChange).forEach(function(oC) {
                if (!onChange[oC].trigger) onChange[oC].trigger = 'after';
                if (!onChange[oC].type) onChange[oC].type = 'async';

            });

            return onChange;
        },

        ObjectAuthorisationSetWrapper: function(obj, authorisationObj, context) {

            var app = context.activeApp || '*';

            if (!obj.authorisations) obj.authorisations = {};

            if (!obj.authorisations[app]) obj.authorisations[app] = [];

            if (!authorisationObj.name) authorisationObj.name = OBJY.RANDOM();

            var found = false;
            obj.authorisations[app].forEach(au => {
                if (au.name == authorisationObj.name) {
                    au = authorisationObj;
                    found = true;
                }
            });

            if (!found) obj.authorisations[app].push(authorisationObj);

            return authorisationObj;
        },

        ObjectAuthorisationRemoveWrapper: function(obj, authorisationId, context) {

            var app = context.activeApp || '*';

            if (!obj.authorisations) throw new exceptions.General('No authorisations present')

            if (!obj.authorisations[app]) throw new exceptions.General('No authorisations for this app present')

            obj.authorisations[app].forEach((au, i) => {
                if (au.name == authorisationId) obj.authorisations[app].splice(i, 1);
            });

            if (Object.keys(obj.authorisations[app]).length == 0) delete obj.authorisations[app];

            return authorisationId;
        },

        ObjectOnDeleteCreateWrapper: function(obj, onDelete, context) {
            //if (!typeof onchange == 'object') throw new exceptions.InvalidPermissionException();

            if (!onDelete) return;

            Object.keys(onDelete).forEach(function(oC) {
                if (!onDelete[oC].trigger) onDelete[oC].trigger = 'after';
                if (!onDelete[oC].type) onDelete[oC].type = 'async';

            });

            return onDelete;
        },

        ObjectOnChangeSetWrapper: function(obj, name, onChange, trigger, type, context) {
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

            OBJY.chainPermission(obj, context, 'w', 'setOnChangeHandler', name);

            return onChange;
        },

        ObjectOnDeleteSetWrapper: function(obj, name, onDelete, trigger, type, context) {
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

            OBJY.chainPermission(obj, context, 'z', 'setOnDeleteHandler', name);

            return onDelete;
        },

        ObjectPermissionSetWrapper: function(obj, permission, context) //addTemplateToObject!!!
        {
            if (!obj.permissions) obj.permissions = {};
            if (!typeof permission == 'object') throw new exceptions.InvalidPermissionException();

            if (!permission) throw new exceptions.InvalidPermissionException();

            var permissionKey = Object.keys(permission)[0];

            if (!obj.permissions[permissionKey]) obj.permissions[permissionKey] = permission[permissionKey];
            else {
                obj.permissions[permissionKey] = permission[permissionKey];
            }

            OBJY.chainPermission(obj, context, 'x', 'setPermission', permissionKey);

            return permission;
        },

        ObjectPermissionRemoveWrapper: function(obj, permissionName, context) //addTemplateToObject!!!
        {
            if (!permissionName) throw new exceptions.InvalidPermissionException();

            if (!typeof permissionName == 'string') throw new exceptions.InvalidPermissionException();

            if (!obj.permissions[permissionName]) throw new exceptions.NoSuchPermissionException(permissionName);

            OBJY.chainPermission(obj, context, 'x', 'removePermission', permissionName);

            delete obj.permissions[permissionName];

            return permissionName;
        },

        ObjectRoleChecker: function(obj, role) {
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

        PropertiesChecker: function(obj, properties, context, params) {
            if (properties === undefined) return;

            //obj.properties = {};

            //if (params.object) obj[params.propsObject] = {};

            var propertyKeys = Object.keys(properties);
            propertyKeys.forEach(function(property) {
                var propKey = {};
                propKey[property] = properties[property];
                var newProp = propKey;
                new OBJY.PropertyCreateWrapper(obj, newProp, false, context, params);
            });
            return obj;
        },

        ApplicationsChecker: function(obj, applications) {
            if (applications === undefined) return;

            obj.applications = [];
            applications.forEach(function(application) {
                obj.applications.push(application);
            });

            return obj.applications;
        },

        ActionsChecker: function(obj, actions) {
            if (actions === undefined) return;

            obj.actions = {};
            var actionKeys = Object.keys(actions);
            actionKeys.forEach(function(action) {
                var actionKey = {};
                actionKey[action] = actions[action];
                var newAction = actionKey;
                new OBJY.ActionCreateWrapper(obj, newAction, false);
            });
            return obj.actions;
        },

        InheritsChecker: function(obj, templates) {
            if (templates === undefined) return;
            if (typeof templates !== 'object') return;
            obj.inherits = [];

            templates.forEach(function(template) {
                if (template != obj._id) new OBJY.TemplatesCreateWrapper(obj, template);
            });

            return obj.inherits;
        },


        PrivilegesChecker: function(obj) {

            return obj.privileges;
        },

        PrivilegeChecker: function(obj, privilege) {

            if (!typeof privilege == 'object') throw new exceptions.InvalidPrivilegeException();
            var privilegeKey = Object.keys(privilege)[0];

            if (!obj.privileges) obj.privileges = {};

            if (!obj.privileges[privilegeKey]) {
                obj.privileges[privilegeKey] = [];
            }

            var contains = false;

            obj.privileges[privilegeKey].forEach(function(oP) {
                if (oP.name == privilege[privilegeKey].name) contains = true;
            });

            if (!contains) obj.privileges[privilegeKey].push({ name: privilege[privilegeKey].name });
            else throw new exceptions.General('Privilege already exists')

            return privilege;
        },

        PrivilegeRemover: function(obj, privilege, context) {


            //if (!typeof privilege == 'object') throw new exceptions.InvalidPrivilegeException();
            var appId = context.activeApp; //Object.keys(privilege)[0];

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


    }
}

//var exceptions = require('../lib/dependencies/exceptions.js');


var isObject$1 = function(a) {
    return (!!a) && (a.constructor === Object);
};

function mapperFunctions(OBJY) {
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
                });
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
                    if (!isObject$1(property)) return;

                    if (property.template) property = null;

                    if (property.type == CONSTANTS.PROPERTY.TYPE_SHORTID) {
                        if (property.value == '' && !property.value)
                            property.value = OBJY.RANDOM();
                    }

                });

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
                        commit(idx);

                    }, function(err) {
                        error(err);
                    }, app, client, sequence[idx - 1], context);
                }

                commit(idx);

                this.mappers[obj.role].forEach(mapper => {

                });
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
                        }, client, params, context);
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

            this.mappers[role].getByCriteria(criteria, function(data) {
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

            this.mappers[role].count(criteria, function(data) {
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

function DefaultStorageMapper(OBJY, options) {

    return Object.assign(new OBJY.StorageTemplate(OBJY, options), {

        database: {},
        index: {},

        createClient: function(client, success, error) {

            if (this.multitenancy == this.CONSTANTS.MULTITENANCY.ISOLATED) {
                if (this.database[client])
                    error('Client already exists');

                this.database[client] = [];
                this.index[client] = {};
                success();
            }
        },

        getDBByMultitenancy: function(client) {

            if (this.multitenancy == this.CONSTANTS.MULTITENANCY.SHARED) {
                if (!Array.isArray(this.database)) this.database = [];

                return this.database;
            } else if (this.multitenancy == this.CONSTANTS.MULTITENANCY.ISOLATED) {

                if (!this.database[client])
                    throw new Error('no database for client ' + client);

                return this.database[client];
            }
        },

        listClients: function(success, error) {
            if (!this.database)
                return error('no database');

            if (this.multitenancy == this.CONSTANTS.MULTITENANCY.ISOLATED)
                success(Object.keys(this.database));
            else success(Object.keys(this.database));
        },

        getById: function(id, success, error, app, client) {

            var db = this.getDBByMultitenancy(client);

            if (this.index[client][id] === undefined)
                return error('object not found: ' + id);

            if (this.multitenancy == this.CONSTANTS.MULTITENANCY.SHARED)
                if (this.index[client][id].tenantId != client)
                    return error('object not found: ' + _id);

            success(db[this.index[client][id]]);
        },

        getByCriteria: function(criteria, success, error, app, client, flags) {

            var db = this.getDBByMultitenancy(client);

            if (app)
                Object.assign(criteria, {
                    applications: {
                        $in: [app]
                    }
                });

            if (this.multitenancy == this.CONSTANTS.MULTITENANCY.SHARED)
                Object.assign(criteria, {
                    tenantId: client
                });
            
       
            success(Query.query(db, criteria, Query.undot));
        },

        count: function(criteria, success, error, app, client, flags) {

            var db = this.getDBByMultitenancy(client);

            if (app)
                Object.assign(criteria, {
                    applications: {
                        $in: [app]
                    }
                });

            if (this.multitenancy == this.CONSTANTS.MULTITENANCY.SHARED)
                Object.assign(criteria, {
                    tenantId: client
                });

            success(Query.query(db, criteria, Query.undot).length);
        },

        update: function(spooElement, success, error, app, client) {

            var db = this.getDBByMultitenancy(client);

            if (this.index[client][spooElement._id] === undefined)
                return error('object not found: ' + spooElement._id);

            if (this.multitenancy == this.CONSTANTS.MULTITENANCY.SHARED)
                if (this.index[client][spooElement._id].tenantId != client)
                    return error('object not found: ' + _id);

            db[this.index[client][spooElement._id]] = spooElement;

            success(db[this.index[client][spooElement._id]]);
        },

        add: function(spooElement, success, error, app, client) {

            if (!this.database[client])
                this.database[client] = [];

            if (!this.index[client]) this.index[client] = {};

            if (this.index[client][spooElement._id] !== undefined)
                return error('object with taht id already exists: ' + spooElement._id);
            if (!this.index[client]) this.index[client] = {};

            var db = this.getDBByMultitenancy(client);

            if (this.multitenancy == this.CONSTANTS.MULTITENANCY.SHARED) {
                spooElement.tenantId = client;
            }

            this.index[client][spooElement._id] = db.push(spooElement) - 1;

            success(spooElement);
        },
        remove: function(spooElement, success, error, app, client) {

            var db = this.getDBByMultitenancy(client);

            if (this.index[client][spooElement._id] === undefined)
                return error('object not found: ' + spooElement._id);

            if (this.multitenancy == this.CONSTANTS.MULTITENANCY.SHARED)
                if (this.index[client][spooElement._id].tenantId != client)
                    return error('object not found: ' + spooElement._id);


            db.splice(this.index[client][spooElement._id], 1);
            delete this.index[client][spooElement._id];
            success(spooElement);

        }


    })
}

function DefaultProcessorMapper (OBJY, mapperOptions) {
    return Object.assign(new OBJY.ProcessorTemplate(OBJY), {
        execute: function (dsl, beforeObj, afterObj, prop, done, client, app, user, options) {
            OBJY.Logger.log('Executing dsl in mapper');

            if (this.multitenancy == this.CONSTANTS.MULTITENANCY.ISOLATED) {
                try {
                    if ((mapperOptions || {}).hasOwnProperty('parse')) {
                        mapperOptions.parse(dsl);
                    } else {
                        
                        if (typeof dsl === 'function') {
                            console.log(dsl.toString());
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
}

function DefaultObserverMapper (OBJY) {
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
}

/*var DefaultStorageMapper = require('../mappers/storage.inmemory.js')
var DefaultProcessorMapper = require('../mappers/processor.eval.js')
var DefaultObserverMapper = require('../mappers/observer.interval.js')*/


function wrapperFunctions(OBJY) {
    return {


        /**
         * Defines an Object Family. Creates a constructor with the single name and one with the plural name
         * @param {params} an object containing the information.
         * @returns {this} an array of all object families
         */
        define: function(params) {

            var thisRef = this;

            if (typeof params == 'string') params = { name: params, pluralName: params + 's' };

            if (!params.name || !params.pluralName) {
                throw new Error("Invalid arguments");
            }

            OBJY.globalCtx.familyParams[params.name] = {
                name: params.name,
                pluralName: params.pluralName,
                extendedStructure: params.extendedStructure,
                authable: params.authable,
                authableTemplate: params.authableTemplate,
            };

            this[params.name] = function(obj) {
                //return OBJY.SingleProxy(obj, params.name, this, params);
                
                let ctx = Object.assign({}, OBJY.globalCtx);

                return new OBJY.Obj(obj, params.name, ctx, params);
            };

            if (this.objectFamilies.indexOf(params.name) == -1) this.objectFamilies.push(params.name);

            this[params.pluralName] = function(objs, flags) {
                let ctx = Object.assign({}, OBJY.globalCtx);
                return new OBJY.Objs(objs, params.name, ctx, params, flags);
            };

            if (params.storage) this.plugInPersistenceMapper(params.name, params.storage);
            else if(params.storage === undefined) this.plugInPersistenceMapper(params.name, thisRef.storage || new DefaultStorageMapper(thisRef));

            if (params.processor) this.plugInProcessor(params.name, params.processor);
            else if(params.processor === undefined) this.plugInProcessor(params.name, thisRef.processor || new DefaultProcessorMapper(thisRef));

            if (params.observer) {
                this.plugInObserver(params.name, params.observer);
                if (params.observer.initialize) params.observer.initialize();
            } else if (params.observer === undefined) {
                this.plugInObserver(params.name, thisRef.observer || new DefaultObserverMapper(thisRef));
                if (this.observers[params.name].initialize) this.observers[params.name].initialize();
            }

            if (params.backend) {
                this.plugInPersistenceMapper(params.name, params.backend.storage);
                this.plugInProcessor(params.name, params.backend.processor);
                this.plugInObserver(params.name, params.backend.observer);
            }

            return this[params.name];
        },

        /**
         * A wrapper for define
         */
        ObjectFamily: function(params) {
            return this.define(params);
        },


        /**
         * Returns the constructor for a specified object family name (singular or plural)
         * @param {role} to object family
         * @returns {constructor} the constructor
         */
        getConstructor: function(role) {
            if (this.mappers[role]) return OBJY[role];
            throw new Error("No constructor");
        },

        /**
         * Returns all defined Object Families from the current instance
         * @returns {objectfamilies} an array of all object families
         */
        getObjectFamilies: function() {
            return this.objectFamilies;
        },

    }
}

var CONSTANTS$1 = {

    EVENT: {
        TYPE_RECURRING: 'recurring',
        TYPE_TERMINATING: 'terminating',
        ACTION: {
            TYPE_AUTORENEW: 'autorenew',
            TYPE_CONFIRM: 'confirm',
            TYPE_PROTOCOL: 'protocol'
        }
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
        TYPE_JSON: 'json'
    },
    MULTITENANCY: {
        ISOLATED: "isolated",
        SHARED: "shared"
    },
    TYPES: {
        SCHEDULED: 'scheduled',
        QUERIED: 'queried'
    },
    TEMPLATEMODES: {
        STRICT: 'strict'
    }
};

/*var CONSTANTS = require('../lib/dependencies/constants.js');
var moment = require('moment');*/


function propertyFunctions(OBJY) {
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

        PropertyBagItemPermissionRemover: function (obj, propertyName, permissionKey, context) {
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

                    OBJY.chainPermission(obj, context, 'x', 'removePropertyPermission', propertyName);

                    delete obj[access[0]].permissions[permissionKey];
                    return;
                }
            }

            removePermission(obj, propertyName);
        },

        PropertyBagItemRemover: function (obj, propertyName, params, context) {
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
                            if (!context.handlerSequence[propsObj._id]) context.handlerSequence[obj._id] = {};
                            if (!context.handlerSequence[propsObj._id].onDelete) context.handlerSequence[obj._id].onDelete = [];
                            context.handlerSequence[propsObj._id].onDelete.push(propsObj[access[0]].onDelete);
                        }
                    }

                    OBJY.chainPermission(propsObj[access[0]], context, 'd', 'removeProperty', propertyName);

                    delete propsObj[access[0]];

                    return;
                }
            }

            getValue(propsObj, propertyName);
        },

        PropertyParser: function (obj, propertyName, context, params) {
            var app = context.activeApp;
            var user = context.activeUser;

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
                propertyToReturn.call = function (callback, client) {
                    OBJY.checkAuthroisations(obj, user, 'x', app);
                    OBJY.execProcessorAction(propertyToReturn.value || propertyToReturn.action, obj, propertyToReturn, {}, callback, client, {});
                };
            }

            return propertyToReturn;
        },

        ValuePropertyMetaSubstituter: function (property) {
            if (typeof property !== 'undefined') if (typeof property.value === 'undefined') property.value = null;
        },

        PropertyCreateWrapper: function (obj, property, isBag, context, params, reallyAdd) {
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

            if (reallyAdd && propsObj.hasOwnProperty(propertyKey) && !OBJY.predefinedProperties.includes(propertyKey))
                throw new exceptions.DuplicatePropertyException(propertyKey);

            switch ((property[propertyKey] || {}).type) {
                case undefined:
                    propsObj[propertyKey] = property[propertyKey];
                    break;

                case CONSTANTS$1.PROPERTY.TYPE_SHORTTEXT:
                    propsObj[propertyKey] = property[propertyKey];

                    if (propsObj[propertyKey]?.value){
                        propsObj[propertyKey].value = propsObj[propertyKey].value  + '';
                    }
                    
                    OBJY.ValuePropertyMetaSubstituter(propsObj[propertyKey]);
                    break;

                case CONSTANTS$1.PROPERTY.TYPE_LONGTEXT:
                    propsObj[propertyKey] = property[propertyKey];

                    if (propsObj[propertyKey]?.value){
                        propsObj[propertyKey].value = propsObj[propertyKey].value  + '';
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
                    OBJY.chainPermission(obj, context, 'evt', 'addProperty (Event)', propertyKey);
                    propsObj[propertyKey] = property[propertyKey];

                    if (!propsObj[propertyKey].eventId) propsObj[propertyKey].eventId = OBJY.ID();

                    if (propsObj[propertyKey].interval !== undefined) {
                        if (propsObj[propertyKey].lastOccurence == undefined) propsObj[propertyKey].lastOccurence = null;
                        else if (!moment(propsObj[propertyKey].lastOccurence).isValid()) throw new exceptions.InvalidDateException(propsObj[propertyKey].lastOccurence);
                        else propsObj[propertyKey].lastOccurence = moment(propsObj[propertyKey].lastOccurence).utc().format();

                        if (propsObj[propertyKey].nextOccurence == undefined) propsObj[propertyKey].nextOccurence = moment().toISOString();

                        if (propsObj[propertyKey].action === undefined) propsObj[propertyKey].action = '';

                        if (propsObj[propertyKey].interval === undefined) throw new exceptions.MissingAttributeException('interval');

                        propsObj[propertyKey].nextOccurence = moment(propsObj[propertyKey].lastOccurence || moment().utc())
                            .utc()
                            .add(propsObj[propertyKey].interval)
                            .toISOString();

                        
                        context.eventAlterationSequence.push({
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

                        context.eventAlterationSequence.push({
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

                        new OBJY.PropertyCreateWrapper(obj[propertyKey], Object.assign({}, tmpProp), true, context, params);
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

                        new OBJY.PropertyCreateWrapper(propsObj[propertyKey], Object.assign({}, tmpProp), true, context, params);
                    });

                    break;

                case CONSTANTS$1.PROPERTY.TYPE_BOOLEAN:
                    if (!typeof property[propertyKey].value === 'boolean')
                        throw new exceptions.InvalidValueException(property[propertyKey].value, CONSTANTS$1.PROPERTY.TYPE_BOOLEAN);
                    propsObj[propertyKey] = property[propertyKey];
                    OBJY.ValuePropertyMetaSubstituter(propsObj[propertyKey]);
                    break;

                case CONSTANTS$1.PROPERTY.TYPE_ACTION:
                    OBJY.chainPermission(obj, context, 'act', 'addProperty (Action)', propertyKey);

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
                    if (!context.handlerSequence[obj._id]) context.handlerSequence[obj._id] = {};
                    if (!context.handlerSequence[obj._id].onCreate) context.handlerSequence[obj._id].onCreate = [];
                    context.handlerSequence[obj._id].onCreate.push({
                        handler: property[propertyKey].onCreate,
                        prop: property[propertyKey],
                    });
                }
            }

            if (reallyAdd) OBJY.chainPermission(obj, context, 'p', 'addProperty', propertyKey);

            /*if(obj.permissions) {
                if(Object.keys(obj.permissions).length > 0)  {
                    if(!context.permissionSequence[obj._id]) context.permissionSequence[obj._id] = [];
                        if(!OBJY.checkPermissions(context.activeUser, context.activeApp, obj, 'p', true))
                            context.permissionSequence[obj._id].push({name:'addProperty', key: propertyKey});
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

        PropertyOnChangeSetWrapper: function (obj, propertyKey, name, onChange, trigger, type, context, params) {
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

                    OBJY.chainPermission(propsObj[access[0]], context, 'w', 'setPropertyOnChangeHandler', name);
                }
            }

            setOnChange(propsObj, propertyKey, onChange);
        },

        PropertyOnCreateSetWrapper: function (obj, propertyKey, name, onCreate, trigger, type, context, params) {
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

                    OBJY.chainPermission(propsObj[access[0]], context, 'v', 'setPropertyOnCreateHandler', name);
                }
            }

            setOnCreate(propsObj, propertyKey, onCreate);
        },

        PropertyOnDeleteSetWrapper: function (obj, propertyKey, name, onDelete, trigger, type, context, params) {
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

                    OBJY.chainPermission(propsObj[access[0]], context, 'z', 'setPropertyOnDeleteHandler', name);
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

        PropertyPermissionSetWrapper: function (obj, propertyKey, permission, context, params) {
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

                    OBJY.chainPermission(propsObj[access[0]], context, 'x', 'setPropertyPermission', propertyKey);
                }
            }

            setPermission(propsObj, propertyKey, permission);
        },

        PropertySetWrapper: function (obj, propertyKey, newValue, context, params) {
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
                            if (!context.handlerSequence[propsObj._id]) context.handlerSequence[propsObj._id] = {};
                            if (!context.handlerSequence[propsObj._id].onChange) context.handlerSequence[propsObj._id].onChange = [];
                            context.handlerSequence[propsObj._id].onChange.push({
                                handler: propsObj[access[0]].onChange,
                                prop: propsObj[access[0]],
                            });
                        }
                    }

                    OBJY.chainPermission(propsObj[access[0]], context, 'u', 'setPropertyValue', propertyKey);
                }
            }

            setValue(propsObj, propertyKey);
        },

        PropertySetFullWrapper: function (obj, propertyKey, newValue, context, force, params) {
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
                            if (!context.handlerSequence[propsObj._id]) context.handlerSequence[propsObj._id] = {};
                            if (!context.handlerSequence[propsObj._id].onChange) context.handlerSequence[propsObj._id].onChange = [];
                            context.handlerSequence[propsObj._id].onChange.push({
                                handler: propsObj[access[0]].onChange,
                                prop: propsObj[access[0]],
                            });
                        }
                    }

                    OBJY.chainPermission(propsObj[access[0]], context, 'u', 'setProperty', propertyKey);
                }
            }

            setValue(propsObj, propertyKey);
        },

        EventIntervalSetWrapper: function (obj, propertyKey, newValue, client, context, params) {
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
                        context.eventAlterationSequence.push({
                            operation: 'remove',
                            obj: obj,
                            propName: propertyKey,
                            property: propsObj[access[0]],
                            date: nextOccurence,
                        });
                        context.eventAlterationSequence.push({
                            operation: 'add',
                            obj: obj,
                            propName: propertyKey,
                            property: propsObj[access[0]],
                            date: nextOccurence,
                        });
                    }

                    OBJY.chainPermission(propsObj[access[0]], context, 'u', 'setEventInterval', propertyKey);
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

        EventDateSetWrapper: function (obj, propertyKey, newValue, client, context, params) {
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

                    context.eventAlterationSequence.push({
                        operation: 'remove',
                        obj: obj,
                        propName: propertyKey,
                        property: propsObj[access[0]],
                        date: newValue,
                    });
                    context.eventAlterationSequence.push({
                        operation: 'add',
                        obj: obj,
                        propName: propertyKey,
                        property: propsObj[access[0]],
                        date: newValue,
                    });

                    OBJY.chainPermission(propsObj[access[0]], context, 'u', 'setEventDate', propertyKey);
                }
            }

            setValue(propsObj, propertyKey);
        },

        EventActionSetWrapper: function (obj, propertyKey, newValue, client, context, params) {
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

                    OBJY.chainPermission(propsObj[access[0]], context, 'u', 'setEventAction', propertyKey);

                    //context.eventAlterationSequence.push({ operation: 'remove', obj: obj, propName: propertyKey, property: obj[access[0]], date: newValue })
                    //context.eventAlterationSequence.push({ operation: 'add', obj: obj, propName: propertyKey, property: obj.properties[access[0]], date: newValue })
                }
            }

            setValue(propsObj, propertyKey);
        },
    };
}

function pluralConstructorFunctions (OBJY) {
    return {

        Objs: function(objs, role, context, params, flags) {

            if (typeof objs === "object" && !Array.isArray(objs)) {

                var flags = flags || {};

                Object.keys(objs).forEach(function(oK) {
                    if (["$page", "$sort", "$pageSize"].indexOf(oK) != -1) {
                        flags[oK] = objs[oK];
                        delete objs[oK];
                    }
                });

                objs = OBJY.buildAuthroisationQuery(objs, context.activeUser, 'r', context.activeApp, context);

                if (context.activeUser) objs = OBJY.buildPermissionQuery(objs, context.activeUser, context.activeApp, context);

                Object.getPrototypeOf(this).get = function(success, error, _client, _app) {
                return new Promise((resolve, reject) => {

                    var client = _client || context.activeTenant;
                    var app = _app || context.activeApp;

                    var allCounter = 0;

                    OBJY.findObjects(objs, role, function(data) {

                        var i;
                        for (i = 0; i < data.length; i++) {
                            if (OBJY[data[i].role]) data[i] = OBJY[data[i].role](data[i]);
                        }


                        // TODO : change!!!

                        if (params.templateMode == CONSTANTS$1.TEMPLATEMODES.STRICT) {

                            if(success) success(data);
                            else {
                                    resolve(data);
                            }
                            return;
                        }

                        if (data.length == 0) {
                            //console.info(data)

                            if(success) success(data);
                            else {
                                    resolve(data);
                            }
                            return;
                        }

                        data.forEach(function(d) {

                            OBJY.applyAffects(d, null, context, client);

                            if (!d.inherits) d.inherits = [];

                            /*d.inherits = d.inherits.filter(function(item, pos) {
                                return d.inherits.indexOf(item) == pos;
                            });*/


                            var counter = 0;



                            if (d.inherits.length == 0) {
                                allCounter++;

                                if (allCounter == data.length) {

                                    if(success) success(data);
                                    else {
                                            resolve(data);
                                    }
                                    return d;
                                }
                            }

                            d.inherits.forEach(function(template) {

                                if (d._id != template) {

                                    OBJY.getTemplateFieldsForObject(d, template, function() {


                                            counter++;

                                            if (counter == d.inherits.length) allCounter++;


                                            if (allCounter == data.length) {

                                                if(success) success(data);
                                                else {
                                                    resolve(data);
                                                }
                                                return d;
                                            }
                                        },
                                        function(err) {
                                            counter++;

                                            if (counter == d.inherits.length) allCounter++;


                                            if (allCounter == data.length) {

                                                if(success) success(data);
                                                else {
                                                    resolve(data);
                                                }
                                                return d;
                                            }

                                        }, client, params.templateFamily, params.templateSource, params, context);
                                } else {

                                    if (d.inherits.length == 1) {

                                        if(success) success(data);
                                        else {
                                            resolve(data);
                                        }
                                        return d;
                                    } else {
                                        counter++;
                                        return;
                                    }

                                }
                            });

                        });

                    }, function(err) {
                        if(error) error(err);
                        else {
                            reject(err);
                        }
                    }, app, client, flags || {}, params, context);

                });

                };

                Object.getPrototypeOf(this).count = function(success, error) {
                return new Promise((resolve, reject) => {

                    var client = context.activeTenant;
                    var app = context.activeApp;


                    OBJY.countObjects(objs, role, function(data) {
                        if(success) success(data);
                        else {
                                resolve(data);
                        }

                    }, function(err) {
                        if(error) error(err);
                        else {
                                reject(err);
                        }
                    }, app, client, flags || {}, params, context);

                    return;

                });
                };


            } else if (Array.isArray(objs)) {

                Object.getPrototypeOf(this).add = function(success, error) {
                return new Promise((resolve, reject) => {

                    var client = context.activeTenant;
                    context.activeApp;


                    var i;
                    var allCounter = 0;
                    for (i = 0; i < objs.length; i++) {
                        objs[i] = OBJY[role](objs[i]).add(function(data) {

                            OBJY.applyAffects(data, 'onCreate', context, client);

                            if (params.templateMode == CONSTANTS$1.TEMPLATEMODES.STRICT) {

                                var counter = 0;

                                if (data.inherits.length == 0) {

                                    allCounter++;
                                    if (allCounter == objs.length) {
                                        if(success) success(objs);
                                        else {
                                                resolve(objs);
                                        }
                                        return data;
                                    }
                                }



                                data.inherits.forEach(function(template) {

                                    if (data._id != template) {

                                        OBJY.getTemplateFieldsForObject(data, template, function() {

                                                counter++;

                                                if (counter == data.inherits.length) allCounter++;

                                                if (allCounter == objs.length) {
                                                    if(success) success(objs);
                                                    else {
                                                            resolve(objs);
                                                    }
                                                    return data;
                                                }
                                            },
                                            function(err) {
                                                if(error) error(err);
                                                else {
                                                        reject(err);
                                                }
                                                return data;
                                            }, client, params.templateFamily, params.templateSource, params, context);
                                    } else {

                                        if (data.inherits.length == 1) {
                                            if(success) success(objs);
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
                                    if(success) success(objs);
                                    else {
                                            resolve(objs);
                                    }
                                    return data;
                                }
                            }

                        }, function(err) {
                            //counter++;
                            /*if (objs.length == counter)*/
                            if(error) error(err);
                            else {
                                    reject(err);
                            }
                        });
                    }
                });
                };

                return this;
            } else {

                if (params.authMethod) Object.getPrototypeOf(this).auth = params.authMethod;
                else {
                    Object.getPrototypeOf(this).auth = function(userObj, callback, error, client, app) {
                    return new Promise((resolve, reject) => {
                        var query = { username: userObj.username };

                        if (OBJY.authableFields) {
                            query = { $or: [] };
                            OBJY.authableFields.forEach(function(field) {
                                var f = {};
                                f[field] = userObj[field];
                                if (f[field]) query.$or.push(f);
                            });
                            if (Object.keys(query.$or).length == 0) query = { username: userObj.username };
                        }


                        OBJY[params.pluralName](query).get(function(data) {
                            if (data.length == 0) error("User not found");
                            
                            if(callback) callback(data[0]);
                            else {
                                    resolve(data[0]);
                            }

                        }, function(err) {
                            if(error) error(err);
                            else {
                                    reject(err);
                            }
                        }, client, app);

                    });
                    };

                }
            }

        },


    }
}

//var moment = require('moment');

var isObject = function (a) {
    return !!a && a.constructor === Object;
};

var isObjyObject = function (a) {
    if(!isObject(a)) return false;
    if (a._id && a.role) return true;
};


function singularConstructorFunctions(OBJY) {
    return {
        Obj: function (obj, role, context, params) {

            //if (context.metaPropPrefix != '' && typeof obj !== 'string') obj = OBJY.serialize(obj);

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

                    if (!OBJY.predefinedProperties.includes(prop)) OBJY.predefinedProperties.push(prop);
                }
            }

            if (params.hasAffects) {
                this.affects = OBJY.AffectsCreateWrapper(this, obj.affects, context);
                this.apply = OBJY.ApplyCreateWrapper(this, obj.apply, context);
            }

            this._constraints = obj._constraints;

            //@TODO: DEPRECATE THIS!
            // this.type = obj.type;

            this.applications = OBJY.ApplicationsChecker(this, obj.applications); // || [];

            this.inherits = OBJY.InheritsChecker(this, obj.inherits); // || [];

            //@TODO: DEPRECATE THIS!
            // this.name = obj.name; // || null;

            this.onCreate = OBJY.ObjectOnCreateCreateWrapper(this, obj.onCreate, context);
            this.onChange = OBJY.ObjectOnChangeCreateWrapper(this, obj.onChange, context);
            this.onDelete = OBJY.ObjectOnDeleteCreateWrapper(this, obj.onDelete, context);

            this.created = obj.created || moment().utc().toDate().toISOString();
            this.lastModified = obj.lastModified || moment().utc().toDate().toISOString();

            //this.properties = OBJY.PropertiesChecker(this, obj.properties, context); // || {};
            OBJY.PropertiesChecker(this, obj, context, params);

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
                    OBJY.chainPermission(this, context, 'o', 'setUsername', username);
                    context.alterSequence.push({ setUsername: arguments });
                    return this;
                };

                this.setEmail = function (email) {
                    this.email = email;
                    OBJY.chainPermission(this, context, 'h', 'setEmail', email);
                    context.alterSequence.push({ setEmail: arguments });
                    return this;
                };

                this.setPassword = function (password) {
                    // should be encrypted at this point
                    this.password = password;
                    context.alterSequence.push({ setPassword: arguments });
                    return this;
                };

                this.setAuthorisation = function (authorisationObj) {
                    new OBJY.ObjectAuthorisationSetWrapper(this, authorisationObj, context);
                    context.alterSequence.push({ setAuthorisation: arguments });
                    return this;
                };

                this.removeAuthorisation = function (authorisationId) {
                    new OBJY.ObjectAuthorisationRemoveWrapper(this, authorisationId, context);
                    context.alterSequence.push({ removeAuthorisation: arguments });
                    return this;
                };
            }

            // TODO: explain this!
            if (params.authable || params.authableTemplate) {
                this.privileges = OBJY.PrivilegesChecker(obj) || {};
                this._clients = obj._clients;

                this.addPrivilege = function (privilege) {
                    if (context.activeApp) {
                        var tmpPriv = {};
                        tmpPriv[context.activeApp] = { name: privilege };
                        new OBJY.PrivilegeChecker(this, tmpPriv);
                        context.alterSequence.push({ addPrivilege: arguments });
                        return this;
                    } else throw new exceptions.General('Invalid app id');
                };

                this.removePrivilege = function (privilege) {
                    new OBJY.PrivilegeRemover(this, privilege, context);
                    context.alterSequence.push({ removePrivilege: arguments });
                    return this;
                };

                this.addClient = function (client) {
                    if (this._clients.indexOf(client) != -1) throw new exceptions.General('Client ' + client + ' already exists');
                    this._clients.push(client);
                    context.alterSequence.push({ addClient: arguments });
                    return this;
                };

                this.removeClient = function (client) {
                    if (this._clients.indexOf(client) == -1) throw new exceptions.General('Client ' + client + ' does not exist');
                    this._clients.splice(this._clients.indexOf(client), 1);
                    context.alterSequence.push({ removeClient: arguments });
                    return this;
                };
            }

            /* this.props = function(properties) {
                 this.properties = OBJY.PropertiesChecker(this, properties, context) || {};
                 return this;
             };*/

            Object.getPrototypeOf(this).addInherit = function (templateId) {
                OBJY.addTemplateToObject(this, templateId, context);

                context.alterSequence.push({ addInherit: arguments });

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
                    context
                );

                context.alterSequence.push({ removeInherit: arguments });

                return this;
            };

            Object.getPrototypeOf(this).addApplication = function (application) {
                OBJY.addApplicationToObject(this, application, context);

                context.alterSequence.push({ addApplication: arguments });

                return this;
            };

            Object.getPrototypeOf(this).removeApplication = function (application) {
                OBJY.removeApplicationFromObject(this, application, context);

                context.alterSequence.push({ removeApplication: arguments });

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
                    //new OBJY.PropertyCreateWrapper(this[bag], prop, false, context, params, true);

                    context.alterSequence.push({ addProperty: arguments });

                    return this;
                }

                new OBJY.PropertyCreateWrapper(this, property, false, context, params, true);

                context.alterSequence.push({ addProperty: arguments });
                return this;
            };

            Object.getPrototypeOf(this).setOnChange = function (name, onChangeObj) {
                if (typeof onChangeObj !== 'object') throw new exceptions.InvalidArgumentException();
                var key = name;

                new OBJY.ObjectOnChangeSetWrapper(this, key, onChangeObj.value, onChangeObj.trigger, onChangeObj.type, context);

                context.alterSequence.push({ setOnChange: arguments });

                return this;
            };

            Object.getPrototypeOf(this).setOnDelete = function (name, onDeleteObj) {
                if (typeof onDeleteObj !== 'object') throw new exceptions.InvalidArgumentException();
                var key = name;

                new OBJY.ObjectOnDeleteSetWrapper(this, key, onDeleteObj.value, onDeleteObj.trigger, onDeleteObj.type, context);

                context.alterSequence.push({ setOnDelete: arguments });

                return this;
            };

            Object.getPrototypeOf(this).setOnCreate = function (name, onCreateObj) {
                if (typeof onCreateObj !== 'object') throw new exceptions.InvalidArgumentException();
                var key = name;

                new OBJY.ObjectOnCreateSetWrapper(this, key, onCreateObj.value, onCreateObj.trigger, onCreateObj.type, context);

                context.alterSequence.push({ setOnCreate: arguments });

                return this;
            };

            Object.getPrototypeOf(this).removeOnChange = function (name) {
                if (!this.onChange[name]) throw new exceptions.HandlerNotFoundException(name);
                else delete this.onChange[name];
                context.alterSequence.push({ removeOnChange: arguments });
                return this;
            };

            Object.getPrototypeOf(this).removeOnDelete = function (name) {
                if (!this.onDelete[name]) throw new exceptions.HandlerNotFoundException(name);
                else delete this.onDelete[name];
                context.alterSequence.push({ removeOnDelete: arguments });
                return this;
            };

            Object.getPrototypeOf(this).removeOnCreate = function (name) {
                if (!this.onCreate[name]) throw new exceptions.HandlerNotFoundException(name);
                else delete this.onCreate[name];
                context.alterSequence.push({ removeOnCreate: arguments });
                return this;
            };

            Object.getPrototypeOf(this).setPermission = function (name, permission) {
                var perm = {};
                perm[name] = permission;
                permission = perm;

                new OBJY.ObjectPermissionSetWrapper(this, permission, context);
                context.alterSequence.push({ setPermission: arguments });
                return this;
            };

            Object.getPrototypeOf(this).removePermission = function (permission) {
                new OBJY.ObjectPermissionRemoveWrapper(this, permission, context);
                context.alterSequence.push({ removePermission: arguments });
                return this;
            };

            Object.getPrototypeOf(this).setPropertyValue = function (property, value, client) {
                new OBJY.PropertySetWrapper(this, property, value, context, params);
                context.alterSequence.push({ setPropertyValue: arguments });

                return this;
            };

            Object.getPrototypeOf(this).setProperty = function (property, value, client) {
                new OBJY.PropertySetFullWrapper(this, property, value, context, false, params);
                context.alterSequence.push({ setProperty: arguments });
                return this;
            };

            Object.getPrototypeOf(this).makeProperty = function (property, value, client) {
                new OBJY.PropertySetFullWrapper(this, property, value, context, true, params);
                context.alterSequence.push({ makeProperty: arguments });
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

                new OBJY.EventDateSetWrapper(this, property, value, client, context, params);
                context.alterSequence.push({ setEventDate: arguments });
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

                new OBJY.EventActionSetWrapper(this, property, value, client, context, params);
                context.alterSequence.push({ setEventAction: arguments });
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

                new OBJY.EventTriggeredSetWrapper(this, property, value, client, context, params);
                context.alterSequence.push({ setEventTriggered: arguments });
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
                context.alterSequence.push({ setEventLastOccurence: arguments });
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

                new OBJY.EventIntervalSetWrapper(this, property, value, client, context, params);
                context.alterSequence.push({ setEventInterval: arguments });
                return this;
            };

            Object.getPrototypeOf(this).pushToArray = function (array, value) {
                var propKey = Object.keys(value)[0];
                var tmpProp = {};
                var tmpName;
                tmpName = shortid.generate();

                tmpProp[tmpName] = value[propKey];

                this.addPropertyToBag(array, tmpProp);
                context.alterSequence.push({ pushToArray: arguments });
            };

            Object.getPrototypeOf(this).setPropertyPermission = function (property, name, permission) {
                var perm = {};
                perm[name] = permission;
                permission = perm;

                new OBJY.PropertyPermissionSetWrapper(this, property, permission, context, params);
                context.alterSequence.push({ setPropertyPermission: arguments });
                return this;
            };

            Object.getPrototypeOf(this).setPropertyOnCreate = function (property, name, onCreateObj) {
                if (typeof onCreateObj !== 'object') throw new exceptions.InvalidArgumentException();
                var key = name;

                new OBJY.PropertyOnCreateSetWrapper(this, property, key, onCreateObj.value, onCreateObj.trigger, onCreateObj.type, context, params);
                context.alterSequence.push({ setPropertyOnCreate: arguments });
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

                context.alterSequence.push({ removePropertyOnCreate: arguments });

                return this;
            };

            Object.getPrototypeOf(this).removePropertyOnCreateFromBag = function (property, handlerName) {
                this.getProperty(property);
                if (this.role == 'template') ;
                new OBJY.PropertyBagItemOnCreateRemover(this, property, handlerName);
                context.alterSequence.push({ removePropertyOnCreateFromBag: arguments });
                return this;
            };

            Object.getPrototypeOf(this).setPropertyMeta = function (property, meta) {
                new OBJY.PropertyMetaSetWrapper(this, property, meta, params);
                context.alterSequence.push({ setPropertyMeta: arguments });
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

                context.alterSequence.push({ removePropertyMeta: arguments });
                return this;
            };

            Object.getPrototypeOf(this).setPropertyOnChange = function (property, name, onChangeObj) {
                if (typeof onChangeObj !== 'object') throw new exceptions.InvalidArgumentException();
                var key = name; //Object.keys(onChangeObj)[0];

                new OBJY.PropertyOnChangeSetWrapper(this, property, key, onChangeObj.value, onChangeObj.trigger, onChangeObj.type, context, params);
                context.alterSequence.push({ setPropertyOnChange: arguments });
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

                context.alterSequence.push({ removePropertyOnChange: arguments });
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

                new OBJY.PropertyOnDeleteSetWrapper(this, property, key, onDeleteObj.value, onDeleteObj.trigger, onDeleteObj.type, context, params);
                context.alterSequence.push({ setPropertyOnDelete: arguments });
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

                context.alterSequence.push({ removePropertyOnDelete: arguments });
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
                context.alterSequence.push({ setPropertyConditions: arguments });
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
                context.alterSequence.push({ setPropertyQuery: arguments });
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
                new OBJY.PropertyEventIntervalSetWrapper(this, property, interval, context);
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

                context.alterSequence.push({ removePropertyQuery: arguments });

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

                    OBJY.chainPermission(this, context, 'x', 'removePropertyPermission', permissionKey);

                    context.alterSequence.push({ removePropertyPermission: arguments });

                    delete this[propertyName].permissions[permissionKey];
                }

                return this;
            };

            Object.getPrototypeOf(this).setBagPropertyValue = function (bag, property, value, client) {
                new OBJY.PropertySetWrapper(this.getProperty(bag), property, value, context, params);
                return this;
            };

            Object.getPrototypeOf(this).setBagEventDate = function (bag, property, value, client) {
                new OBJY.EventDateSetWrapper(this.getProperty(bag), property, value, context, params);
                return this;
            };

            Object.getPrototypeOf(this).setBagEventAction = function (bag, property, value, client) {
                new OBJY.EventActionSetWrapper(this.getProperty(bag), property, value, context, params);
                return this;
            };

            Object.getPrototypeOf(this).setBagEventInterval = function (bag, property, value, client) {
                new OBJY.EventIntervalSetWrapper(this.getProperty(bag), property, value, context, params);
                return this;
            };

            Object.getPrototypeOf(this).setBagEventTriggered = function (bag, property, value, client) {
                new OBJY.EventTriggeredSetWrapper(this, property, value, client, context, params);
                return this;
            };

            Object.getPrototypeOf(this).setBagEventLastOccurence = function (bag, property, value, client) {
                new OBJY.EventLastOccurenceSetWrapper(this.getProperty(bag), property, value, client, params);
                return this;
            };

            Object.getPrototypeOf(this).addPropertyToBag = function (bag, property) {
                var tmpBag = this.getProperty(bag);

                new OBJY.PropertyCreateWrapper(tmpBag, property, true, context, params, true);

                return this;
            };

            Object.getPrototypeOf(this).removePropertyFromBag = function (property, client) {
                this.getProperty(property);

                new OBJY.PropertyBagItemRemover(this, property, params, context);
                return this;
            };

            Object.getPrototypeOf(this).removePropertyPermissionFromBag = function (property, permissionKey) {
                this.getProperty(property);

                new OBJY.PropertyBagItemPermissionRemover(this, property, permissionKey, context);
                return this;
            };

            Object.getPrototypeOf(this).removeProperty = function (propertyName, client) {
                var thisRef = this;

                if (propertyName.indexOf('.') != -1) {
                    this.removePropertyFromBag(propertyName, client);
                    context.alterSequence.push({ removeProperty: arguments });
                    return this;
                } else {
                    if (!thisRef[propertyName]) throw new exceptions.NoSuchPropertyException(propertyName);

                    var tmpProp = Object.assign({}, thisRef[propertyName]);

                    if (tmpProp.onDelete) {
                        if (Object.keys(tmpProp.onDelete).length > 0) {
                            if (!context.handlerSequence[this._id]) context.handlerSequence[this._id] = {};
                            if (!context.handlerSequence[this._id].onDelete) context.handlerSequence[this._id].onDelete = [];
                            context.handlerSequence[this._id].onDelete.push({
                                handler: tmpProp.onDelete,
                                prop: tmpProp,
                            });
                        }
                    }

                    OBJY.chainPermission(thisRef[propertyName], context, 'd', 'removeProperty', propertyName);

                    context.alterSequence.push({ removeProperty: arguments });

                    /*if (this[propertyName].type == 'date') context.eventAlterationSequence.push({
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

                OBJY.chainPermission(this, context, 'n', 'setName', name);

                context.alterSequence.push({ setName: arguments });

                return this;
            };

            Object.getPrototypeOf(this).setType = function (type) {
                this.type = type;
                OBJY.chainPermission(this, context, 't', 'setType', type);
                context.alterSequence.push({ setType: arguments });
                return this;
            };

            Object.getPrototypeOf(this).getType = function () {
                return this.type;
            };

            Object.getPrototypeOf(this).getRef = function (propertyName) {
                return new OBJY.PropertyRefParser(this, propertyName);
            };

            Object.getPrototypeOf(this).getProperty = function (propertyName) {
                return OBJY.PropertyParser(this, propertyName, context, params);
            };

            Object.getPrototypeOf(this).getProperties = function () {
                return this;
            };

            Object.getPrototypeOf(this).add = function (success, error, client) {
                return new Promise((resolve, reject) => {
                    var client = client || context.activeTenant;
                    var app = context.activeApp;
                    var user = context.activeUser;

                    var thisRef = this;

                    OBJY.applyAffects(thisRef, context, client, params);

                    if (!OBJY.checkAuthroisations(this, user, 'c', app, context)) return error({ error: 'Lack of Permissions' });

                    if (!this._id) this._id = OBJY.ID();

                    

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
                                    context.eventAlterationSequence.push({
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

                                    context.eventAlterationSequence.push({
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

                                    
                                    if (!found && props[p].triggered != true){

                                        thisRef._aggregatedEvents.push({
                                            propName: p,
                                            date: date,
                                        });
                                    }
                                }
                            }
                        });
                    }

                    var mapper = OBJY.observers[thisRef.role];

                    //if (this) aggregateAllEvents(this.properties);

                    aggregateAllEvents(thisRef);     


                    if (app) {
                        if (!this.applications) this.applications = [];
                        if (this.applications) if (this.applications.indexOf(app) == -1) this.applications.push(app);
                    }

                    var addFn = function (obj) {
                        if (!OBJY.checkPermissions(user, app, obj, 'c', false, context)) return error({ error: 'Lack of Permissions' });

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
                                

                                if (mapper.type == 'scheduled') {
                                    context.eventAlterationSequence.forEach(function (evt) {
                                        if (evt.operation == 'add') {
                                            mapper.addEvent(
                                                obj._id,
                                                evt.propName,
                                                evt.property,
                                                function (evtData) {},
                                                function (evtErr) {},
                                                context.activeTenant
                                            );
                                        } else if (evt.operation == 'remove') {
                                            mapper.addEvent(
                                                obj._id,
                                                evt.propName,
                                                function (evtData) {},
                                                function (evtErr) {},
                                                context.activeTenant
                                            );
                                        }
                                    });
                                }

                                context.eventAlterationSequence = [];

                                OBJY.Logger.log('Added Object: ' + JSON.stringify(data, null, 2));

                                // SYNC HANDLER
                                if (data.onCreate && Object.keys(data.onCreate || {}).length > 0) {
                                    var callbackCounter = 0;
                                    var finalCallbackData = {};
                                    Object.keys(data.onCreate).forEach(function (key) {
                                        try {
                                            OBJY.execProcessorAction(
                                                data.onCreate[key].value || data.onCreate[key].action,
                                                null,
                                                data,
                                                null,
                                                function (cbData) {
                                                    callbackCounter++;

                                                    // check if action returns data, then save it to current state
                                                    if (isObjyObject(cbData)) finalCallbackData = cbData;

                                                    if (callbackCounter == Object.keys(data.onCreate || {}).length) {
                                                        if (success) {
                                                            if (isObjyObject(finalCallbackData)) {
                                                                OBJY.unapplyHiddenAffects(finalCallbackData, context, client, params);
                                                                return success(finalCallbackData);
                                                            } else {
                                                                OBJY.unapplyHiddenAffects(data, context, client, params);
                                                                success(data);
                                                            }
                                                        } 
                                                        else {
                                                            resolve(data);
                                                        }
                                                    }
                                                },
                                                client,
                                                null
                                            );
                                        } catch(e){
                                            console.log(e);
                                        }

                                    });
                                } else {
                                    OBJY.unapplyHiddenAffects(data, context, client, params);
                                    if (success) success(data);
                                    else {
                                        resolve(data);
                                    }
                                }


                                delete thisRef.context;
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
                            context
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
                    return this;
                });
            };

            Object.getPrototypeOf(this).update = function (success, error, client) {
                return new Promise((resolve, reject) => {
                    var client = client || context.activeTenant;
                    var app = context.activeApp;
                    var user = context.activeUser;

                    var thisRef = this;

                    OBJY.applyAffects(thisRef, context, client, params);


                    if (!OBJY.checkAuthroisations(this, user, 'u', app, context)) return error({ error: 'Lack of Permissions' });                    


                    if (!OBJY.checkPermissions(user, app, thisRef, 'u', false, context)) return error({ error: 'Lack of Permissions' });

                    if ((context.permissionSequence[thisRef._id] || []).length > 0) {
                        throw new exceptions.LackOfPermissionsException(context.permissionSequence[thisRef._id]);
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

                    var mapper = OBJY.observers[thisRef.role];

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

                                if (context.handlerSequence[thisRef._id]) {
                                    for (var type in context.handlerSequence[thisRef._id]) {
                                        for (var item in context.handlerSequence[thisRef._id][type]) {
                                            var handlerObj = context.handlerSequence[thisRef._id][type][item];
                                            for (var handlerItem in handlerObj.handler) {
                                                OBJY.execProcessorAction(
                                                    handlerObj.handler[handlerItem].value || handlerObj.handler[handlerItem].action,
                                                    thisRef,
                                                    data,
                                                    handlerObj.prop,
                                                    function (data) {},
                                                    client,
                                                    null
                                                );
                                            }
                                        }
                                    }
                                }

                                delete context.handlerSequence[thisRef._id];

                                if (mapper.type == 'scheduled') {
                                    context.eventAlterationSequence.forEach(function (evt) {
                                        if (evt.type == 'add') {
                                            mapper.addEvent(
                                                thisRef._id,
                                                evt.propName,
                                                evt.property,
                                                function (evtData) {},
                                                function (evtErr) {},
                                                context.activeTenant
                                            );
                                        }
                                    });
                                }

                                context.eventAlterationSequence = [];

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
                                //OBJY.deSerializePropsObject(data, params);
                                context.alterSequence = [];



                                // SYNC HANDLER
                                if (data.onChange && Object.keys(data.onChange || {}).length > 0) {
                                    var callbackCounter = 0;
                                    var finalCallbackData = {};
                                    Object.keys(data.onChange).forEach(function (key) {
                                        try {
                                            OBJY.execProcessorAction(
                                                data.onChange[key].value || data.onChange[key].action,
                                                thisRef,
                                                data,
                                                null,
                                                function (cbData) {
                                                    callbackCounter++;

                                                    // check if action returns data, then save it to current state
                                                    if (isObjyObject(cbData)) finalCallbackData = cbData;

                                                    if (callbackCounter == Object.keys(data.onChange || {}).length) {
                                                        if (success) {
                                                            if (isObjyObject(finalCallbackData)) {
                                                                OBJY.unapplyHiddenAffects(finalCallbackData, context, client, params);
                                                                return success(finalCallbackData);
                                                            } else {
                                                                OBJY.unapplyHiddenAffects(data, context, client, params);
                                                                success(data);
                                                            }
                                                        } 
                                                        else {
                                                            resolve(data);
                                                        }
                                                    }
                                                },
                                                client,
                                                null
                                            );
                                        } catch(e){
                                            console.log(e);
                                        }

                                    });
                                } else {
                                    OBJY.unapplyHiddenAffects(data, context, client, params);
                                    if (success) success(data);
                                    else {
                                        resolve(data);
                                    }
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
                            context
                        );
                    }

                    if (context.commandSequence.length > 0 && params.templateMode == CONSTANTS$1.TEMPLATEMODES.STRICT) {
                        var foundCounter = 0;
                        context.commandSequence.forEach(function (i) {
                            if (i.name == 'addInherit' || i.name == 'removeInherit') {
                                foundCounter++;
                            }
                        });

                        if (foundCounter == 0) updateFn();

                        var execCounter = 0;
                        context.commandSequence.forEach(function (i) {
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
                                    context
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
                                    context
                                );
                            }
                        });
                    } else updateFn();

                    context.commandSequence = [];

                    return this;
                });
            };

            Object.getPrototypeOf(this).remove = function (success, error, client) {
                return new Promise((resolve, reject) => {
                    var client = client || context.activeTenant;
                    var app = context.activeApp;
                    var user = context.activeUser;

                    var thisRef = JSON.parse(JSON.stringify(this));

                    OBJY.applyAffects(thisRef, context, client, params);



                    if (!OBJY.checkPermissions(user, app, thisRef, 'd', false, context)) return error({ error: 'Lack of Permissions' });

                    /*if (thisRef.onDelete) {
                        Object.keys(thisRef.onDelete).forEach(function (key) {
                            if (thisRef.onDelete[key].trigger == 'before') {
                                OBJY.execProcessorAction(
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
                    }*/

                    OBJY.getObjectById(
                        this.role,
                        this._id,
                        function (data) {
                            return OBJY.remove(
                                thisRef,
                                function (_data) {
                                    //OBJY.applyAffects(data, null, 'onDelete', context, client, params);

                                    /*if (thisRef.onDelete) {
                                        Object.keys(thisRef.onDelete).forEach(function (key) {
                                            if (thisRef.onDelete[key].trigger == 'after') {
                                                OBJY.execProcessorAction(
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
                                    }*/

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
                                                    context.eventAlterationSequence.push({
                                                        operation: 'remove',
                                                        obj: thisRef,
                                                        propName: prePropsString + '.' + p,
                                                        date: date,
                                                    });
                                                } else {
                                                    context.eventAlterationSequence.push({
                                                        operation: 'remove',
                                                        obj: thisRef,
                                                        propName: p,
                                                        date: date,
                                                    });
                                                }
                                            }
                                        });
                                    }

                                    var mapper = OBJY.observers[thisRef.role];

                                    aggregateAllEvents(data || {});

                                    if (mapper.type == 'scheduled') {
                                        context.eventAlterationSequence.forEach(function (evt) {
                                            if (evt.operation == 'add') {
                                                mapper.addEvent(
                                                    data._id,
                                                    evt.propName,
                                                    evt.property,
                                                    function (evtData) {},
                                                    function (evtErr) {},
                                                    context.activeTenant
                                                );
                                            } else if (evt.operation == 'remove') {
                                                mapper.removeEvent(
                                                    data._id,
                                                    evt.propName,
                                                    function (evtData) {},
                                                    function (evtErr) {
                                                        console.log(evtErr);
                                                    },
                                                    context.activeTenant
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

                                    //OBJY.deSerializePropsObject(data, params);

                                    // SYNC HANDLER
                                    if (data.onDelete && Object.keys(data.onDelete || {}).length > 0) {
                                        var callbackCounter = 0;
                                        var finalCallbackData = {};
                                        Object.keys(data.onDelete).forEach(function (key) {
                                            try {
                                                OBJY.execProcessorAction(
                                                    data.onDelete[key].value || data.onDelete[key].action,
                                                    data,
                                                    null,
                                                    null,
                                                    function (cbData) {
                                                        callbackCounter++;

                                                         // check if action returns data, then save it to current state
                                                        if (isObjyObject(cbData)) finalCallbackData = cbData;

                                                        if (callbackCounter == Object.keys(data.onDelete || {}).length) {
                                                            if (success) {
                                                                if (isObjyObject(finalCallbackData)) {
                                                                    OBJY.unapplyHiddenAffects(finalCallbackData, context, client, params);
                                                                    return success(finalCallbackData);
                                                                } else {
                                                                    OBJY.unapplyHiddenAffects(data, context, client, params);
                                                                    success(data);
                                                                }
                                                            } 
                                                            else {
                                                                resolve(data);
                                                            }
                                                        }
                                                    },
                                                    client,
                                                    null
                                                );
                                            } catch(e){
                                                console.log(e);
                                            }

                                        });
                                    } else {
                                        OBJY.unapplyHiddenAffects(data, context, client, params);
                                        if (success) success(data);
                                        else {
                                            resolve(data);
                                        }
                                    }


                                    /*if (success) success(data);
                                    else {
                                        resolve(data);
                                    }*/
                                },
                                function (err) {
                                    if (error) error(err);
                                    else {
                                        reject(err);
                                    }
                                },
                                app,
                                client,
                                context
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
                        context,
                        params
                    );

                    return this;
                });
            };

            Object.getPrototypeOf(this).get = function (success, error, dontInherit) {
                return new Promise((resolve, reject) => {
                    var client = context.activeTenant;
                    var app = context.activeApp;
                    var user = context.activeUser;

                    var thisRef = this;

                    OBJY.applyAffects(thisRef, context, client, params);


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
                        var returnObject = OBJY[data.role](data);

                        //OBJY.applyAffects(data, null, context, client);

                        if (!OBJY.checkAuthroisations(returnObject, user, 'r', app, context))
                            return error({ error: 'Lack of Permissions', source: 'authorisations' });

                        if (!OBJY.checkPermissions(user, app, data, 'r', false, context))
                            return error({ error: 'Lack of Permissions', source: 'permissions' });

                        if (dontInherit) {
                            OBJY.unapplyHiddenAffects(returnObject, context, client, params);
                            if (success) success(returnObject);
                            else {
                                resolve(returnObject);
                            }
                            return data;
                        }

                        if (params.templateMode == CONSTANTS$1.TEMPLATEMODES.STRICT) {
                            OBJY.unapplyHiddenAffects(returnObject, context, client, params);
                            if (success) success(returnObject);
                            else {
                                resolve(returnObject);
                            }
                            return data;
                        }

                        if ((data.inherits || []).length == 0) {
                            OBJY.unapplyHiddenAffects(returnObject, context, client, params);
                            if (success) success(returnObject);
                            else {
                                resolve(returnObject);
                            }
                            return data;
                        }

                        data.inherits.forEach(function (template) {
                            if (data._id != template) {
                                OBJY.getTemplateFieldsForObject(
                                    data,
                                    template,
                                    function () {
                                        var returnObject = OBJY[data.role](data);

                                        counter++;

                                        if (counter == data.inherits.length) {
                                            OBJY.unapplyHiddenAffects(returnObject, context, client, params);
                                            if (success) success(returnObject);
                                            else {
                                                resolve(returnObject);
                                            }
                                            return data;
                                        }
                                    },
                                    function (err) {
                                        counter++;

                                        var returnObject = OBJY[data.role](data);

                                        if (counter == data.inherits.length) {
                                            OBJY.unapplyHiddenAffects(returnObject, context, client, params);
                                            if (success) success(returnObject);
                                            else {
                                                resolve(returnObject);
                                            }
                                            return data;
                                        }
                                    },
                                    client,
                                    params.templateFamily,
                                    params.templateSource,
                                    params,
                                    context
                                );
                            } else {
                                var returnObject = OBJY[data.role](data);

                                if (thisRef.inherits.length == 1) {
                                    OBJY.unapplyHiddenAffects(returnObject, context, client, params);
                                    if (success) success(returnObject);
                                    else {
                                        resolve(returnObject);
                                    }
                                    return data;
                                } else {
                                    counter++;
                                    return;
                                }
                            }
                        });
                    }

                    if (((context.caches || {})[thisRef.role]?.data || {})[thisRef._id]) {
                        prepareObj(context.caches[thisRef.role].data[thisRef._id]);
                    } else {
                        OBJY.getObjectById(
                            thisRef.role,
                            thisRef._id,
                            function (data) {
                                prepareObj(data);

                                if (!((context.caches || {})[thisRef.role]?.data || {})[thisRef._id]) ;
                            },
                            function (err) {
                                if (error) error(err);
                                else {
                                    reject(err);
                                }
                            },
                            app,
                            client,
                            context,
                            params
                        );
                    }

                    return this;
                });
            };

            /*const validator = {
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
                        context.activeTenant,
                        params.templateFamily,
                        params.templateSource,
                        params,
                        context
                    );
                });

                return new Proxy(this, validator);
            }*/
            return this;
        },
    };
}

/*
var _nodejs = (
    typeof process !== 'undefined' && process.versions && process.versions.node);
if (_nodejs) {
    _nodejs = {
        version: process.versions.node
    };
}
*/


let contextTemplate = {
    activeTenant: null,
    activeUser: null,
    activeApp: null,

    alterSequence: [],
    commandSequence: [],
    permissionSequence: {},
    eventAlterationSequence: [],
    handlerSequence: {},
    familyParams: {}
};


/**
 * OBJY Instance
 */
function OBJY(){
    var _OBJY = {};

    Object.assign(_OBJY, {

        globalCtx: Object.assign({}, contextTemplate),

        ...generalAttributes(),
    
        ...generalFunctions(_OBJY),
    
        ...applyFunctions(_OBJY),
    
        ...permissionFunctions(_OBJY),
    
        ...objectFunctions(_OBJY),
    
        ...mapperFunctions(_OBJY),
    
        ...wrapperFunctions(_OBJY),
    
        ...propertyFunctions(_OBJY),
    
        ...pluralConstructorFunctions(_OBJY),
    
        ...singularConstructorFunctions(_OBJY),
    
        hello: function() {
            _OBJY.Logger.log("Hello from OBJY!");
        }
    });

    return _OBJY
}

/**
 * Transaction instance
 */ 
/*
var Transaction = function(OBJY) {
    OBJY.globalContext = Object.assign({}, contextTemplate)

    var T = {};

    Object.assign(T, {
        ...singularConstructorFunctions(OBJY),
        ...pluralConstructorFunctions(OBJY),
        ...wrapperFunctions(OBJY)
    })

    return T
}
*/

//var objy = OBJY;

//export OBJY

/*if(_nodejs) module.exports = OBJY; 
else if(typeof window !== 'undefined') {
    window.OBJY = OBJY;
}*/

//if(0)typeof await/2//2; export default OBJY

export { OBJY as default };
//# sourceMappingURL=index.js.map
