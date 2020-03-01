var _nodejs = (
    typeof process !== 'undefined' && process.versions && process.versions.node);
if (_nodejs) {
    _nodejs = {
        version: process.versions.node
    };
}

// Dependencies
var moment = require('moment');
var shortid = require('shortid');
var Query = require('./dependencies/query.js');
var Logger = require('./dependencies/logger.js');

// Mapper Templates
var StorageTemplate = require('./mappers/templates/storage.js');
var ProcessorTemplate = require('./mappers/templates/processor.js');
var ObserverTemplate = require('./mappers/templates/observer.js');

// Default Mappers
var DefaultStorageMapper = require('./mappers/storage/inMemory.js');
var DefaultProcessorMapper = require('./mappers/processors/eval.js');
var DefaultObserverMapper = require('./mappers/observers/intervalMapper.js')


var CONSTANTS = {

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
}



function OBJYException(args) {
    this.message = args.join(' ');
    this.name = 'OBJY Exception';
}


function NoOnChangeException(message) {
    this.message = "onChange not found";
    this.name = 'NoOnChangeException';
}

function NoMetaException(message) {
    this.message = "meta not found";
    this.name = 'NoMetaException';
}

function NoOnDeleteException(message) {
    this.message = "onDelete not found";
    this.name = 'NoOnDeleteException';
}

function NoEventIdException(message) {
    this.message = "No Event ID provided";
    this.name = 'NoEventIdException';
}

function InvalidTypeException(message) {
    this.message = message + " is not a valid type";
    this.name = 'InvalidTypeException';
}

function InvalidValueException(value, type) {
    this.message = value + " is not valid. Type must be: " + type;
    this.name = 'InvalidValueException';
}

function InvalidFormatException() {
    this.message = "Invlid format";
    this.name = 'InvalidFormatException';
}

function DuplicatePropertyException(message) {
    this.message = "Property " + message + " already exists in this object";
    this.name = 'DuplicatePropertyException';
}

function DuplicateActionException(message) {
    this.message = "Action " + message + " already exists in this object";
    this.name = 'DuplicateActionException';
}

function DuplicateApplicationException(message) {
    this.message = "Application " + message + " already exists in this object";
    this.name = 'DuplicateApplicationException';
}

function NoSuchApplicationException(message) {
    this.message = "Application " + message + " does not exist in this object";
    this.name = 'NoSuchApplicationException';
}

function NoSuchReminderException(message) {
    this.message = "Reminder " + message + " does not exist in this event";
    this.name = 'NoSuchReminderException';
}

function DuplicateEventException(message) {
    this.message = "Event " + message + " already exists in this object";
    this.name = 'DuplicateEventException';
}

function NoSuchTemplateException(message) {
    this.message = "Template id " + message + " does not exist";
    this.name = 'NoSuchTemplateException';
}

function NotAnEventException(message) {
    this.message = "Property " + message + " is not an event";
    this.name = 'NotAnEventException';
}

function NoSuchObjectException(message) {
    this.message = "Object id " + message + " does not exist";
    this.name = 'NoSuchObjectException';
}

function NoSuchPropertyException(message) {
    this.message = "Property " + message + " does not exist in this object";
    this.name = 'NoSuchPropertyException';
}

function NoSuchEventException(message) {
    this.message = "Event " + message + " does not exist in this object";
    this.name = 'NoSuchEventException';
}

function PropertyNotFoundException(message) {
    this.message = "Property " + message + " does not exist in this object";
    this.name = 'PropertyNotFoundException';
}

function MissingAttributeException(message) {
    this.message = "Missing attibute " + message + " in this object";
    this.name = 'MissingAttributeException';
}

function CallbackErrorException(message) {
    this.message = message;
    this.name = 'CallbackErrorException';
}

function InvalidDateException(message) {
    this.message = message + " is not a valid date";
    this.name = 'InvalidDateException';
}

function InvalidActionException(message) {
    this.message = message + " is not a valid event action";
    this.name = 'InvalidActionException';
}

function InvalidDataTypeException(message, type) {
    this.message = message + " is not of type " + type;
    this.name = 'InvalidDataTypeException';
}

function NotATemplateExteptopn(message) {
    this.message = message + " is not a template";
    this.name = 'NotATemplateExteptopn';
}

function InvalidPrivilegeException(message) {
    this.message = "Invalid privileges format";
    this.name = 'InvalidPrivilegeException';
}

function NoSuchPrivilegeException(message) {
    this.message = "Privilege does not exist";
    this.name = 'NoSuchPrivilegeException';
}

function NoSuchPermissionException(message) {
    this.message = "Permission " + message + " does not exist";
    this.name = 'NoSuchPermissionException';
}

function InvalidPermissionException(message) {
    this.message = "Permission format invalid";
    this.name = 'InvalidPermissionException';
}

function InvalidEventIdException(message) {
    this.message = "Event ID format not valid: " + message;
    this.name = 'InvalidEventIdException';
}


function NoHandlerProvidedException(message) {
    this.message = "No handler provided " + message;
    this.name = 'NoHandlerProvidedException';
}

function HandlerExistsException(message) {
    this.message = "Handler " + message + " already exists";
    this.name = 'HandlerExistsException';
}

function HandlerNotFoundException(message) {
    this.message = "Handler " + message + " not found";
    this.name = 'HandlerNotFoundException';
}

function InvalidArgumentException(message) {
    this.message = "Invalid argument";
    this.name = 'InvalidArgumentException';
}

function InvalidHandlerException(message) {
    this.message = "Invalid handler";
    this.name = 'InvalidHandlerException';
}

function LackOfPermissionsException(message) {

    if (Array.isArray(message)) {
        var result = "No permissions to perform these operations: ";

        message.forEach(function(m) {
            result += "(" + m.name + ": " + m.key + ") ";
        })

        this.message = result;
        this.name = 'LackOfPermissionsException';
    } else {
        this.message = "No permissions to perform this operation";
        this.name = 'LackOfPermissionsException';
    }

}


var OBJY = {

    self: this,

    Logger: Logger,

    // maybe remove...
    Mapper: {
        Storage: {
            Mongo: require('./mappers/storage/mongoMapper.js'),
            //GridFS: require('./mappers/storage/gridFSMapper.js'),
        },
    },

    metaProperties: ['id', 'role', 'applications', 'inherits', 'onCreate', 'onChange', 'onDelete', 'permissions', 'privileges', 'created', 'lastModified'],

    metaPropPrefix: '',

    instance: this,

    activeTenant: null,

    activeUser: null,

    activeApp: null,

    schema: {

    },

    handlerSequence: [],
    permissionSequence: [],
    commandSequence: [],
    eventAlterationSequence: [],

    storage: null,
    processor: null,
    observer: null,

    StorageTemplate: StorageTemplate,
    ProcessorTemplate: ProcessorTemplate,
    ObserverTemplate: ObserverTemplate,

    serialize: function(obj) {
        return obj;
    },

    deserialize: function(obj) {
        return obj;
    },

    tenant: function(tenant) {
        if (!tenant) throw new Error("No tenant specified");
        this.activeTenant = tenant;

        return this;
    },

    // @TOTO: remove this
    client: function(tenant) {
        if (!tenant) throw new Error("No tenant specified");
        this.activeTenant = tenant;

        return this;
    },

    useClient: function(tenant) {
        if (!tenant) throw new Error("No tenant specified");
        this.activeTenant = tenant;

        return this;
    },

    useUser: function(user) {
        this.activeUser = user;
        return this;
    },

     useApp: function(app) {
        //if (!app) throw new Error("No app specified");
        this.activeApp = app;

        return this;
    },

    // @TOTO: remove this
    app: function(app) {
        //if (!app) throw new Error("No app specified");
        this.activeApp = app;

        return this;
    },

    checkPermissions: function(user, app, obj, permission, soft) {

        return true;

        var result = false;

        if (!user) return true;

        var privileges = user.privileges;
        var permissions = obj.permissions;

        // if permissions present and user has no privileges
        if (!privileges && permissions) {
            if (!soft) throw new LackOfPermissionsException();
            else return false;
        }

        var allowed = false;

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
                    })

                })

                if (allowed) return true;

            } else if (privileges[app]) {

                privileges[app].forEach(function(item) {
                    if (permissions[item.name]) {

                        if (((permissions[item.name] || {}).value || "").indexOf(permission) != -1 || (permissions[item.name] || {}).value == "*") allowed = true;
                    }

                    if (permissions["*"]) {
                        if (((permissions['*'] || {}).value || "").indexOf(permission) != -1 || (permissions['*'] || {}).value == "*") allowed = true;
                    }
                })

                if (!allowed) throw new LackOfPermissionsException();
                else return true

            } else throw new LackOfPermissionsException();

        } else throw new LackOfPermissionsException();

    },

    checkAuthroisations: function(obj, user, condition, app) {

        var authorisations;
        if (!user) return;

        function throwError() {
            throw new Error("Lack of permissions")
        }

        if (Object.keys(user.authorisations || {}).length == 0) throwError();

        if (!app && !user.authorisations['*']) {
            console.warn('app, !authorisationsapp');
            throwError();
        }

        if (user.authorisations['*']) authorisations = user.authorisations['*'];
        else if (app && !user.authorisations[app]) {
            console.warn('app, !authorisationsapp')
            throwError();
        } else authorisations = user.authorisations[app];

        var permCheck = [obj];

        var query = { $or: [] }

        authorisations.forEach(function(a) {
            console.warn('_a', a, condition)
            if (a.perm.indexOf(condition) != -1 || a.perm.indexOf("*") != -1) query.$or.push(a.query)
        })

        if (query.$or.length == 0) throwError();

        // CONSOLE LOGGING FOR TESTING PURPOSES!

        console.log('query', query)

        console.log('perm result', Query.query(permCheck, query, Query.undot))

        if (Query.query(permCheck, query, Query.undot).length == 0) throw new Error("Lack of permissions")
    },


    buildAuthroisationQuery: function(obj, user, condition, app) {

        var authorisations;
        if (!user) return obj;

        function throwError() {
            throw new Error("Lack of permissions")
        }

        if (Object.keys(user.authorisations || {}).length == 0) throwError();

        if (!app && !user.authorisations['*']) {
            console.warn('app, !authorisationsapp');
            throwError();
        }

        if (user.authorisations['*']) authorisations = user.authorisations['*'];
        else if (app && !user.authorisations[app]) {
            console.warn('app, !authorisationsapp')
            throwError();
        } else authorisations = user.authorisations[app];

        var permCheck = [obj];

        var query = []
        var wildcard = false;

        authorisations.forEach(function(a) {
            console.warn('_a', a, condition)
            if (a.perm.indexOf(condition) != -1 || a.perm.indexOf("*") != -1) {
                if (Object.keys(a.query).length == 0) wildcard = true;
                else {
                    console.log([a.query, obj])
                    query.push({ '$and': [a.query, obj] })
                }
            }
        })

        if (query.length == 0 && !wildcard) throw new Error("Lack of permissions")

        // CONSOLE LOGGING FOR TESTING PURPOSES!

        query = { $or: query };

        console.log('build query', query)

        console.log('query', query)

        console.log('perm result', Query.query(permCheck, query, Query.undot))

        return query;
    },

    chainPermission: function(obj, instance, code, name, key) {
        if (obj.permissions) {
            if (Object.keys(obj.permissions).length > 0) {
                if (!instance.permissionSequence[obj._id]) instance.permissionSequence[obj._id] = [];

                if (!OBJY.checkPermissions(instance.activeUser, instance.activeApp, obj, code, true))
                    instance.permissionSequence[obj._id].push({
                        name: name,
                        key: key
                    });
            }
        }
    },

    chainCommand: function(obj, instance, key, value) {
        instance.commandSequence.push({
            name: key,
            value: value
        });
    },

    objectFamilies: [],

    getObjectFamilies: function() {
        return this.objectFamilies;
    },

    defineGlobal: function(params)
    {

    },

    define: function(params) {

        var thisRef = this;

        if (!params.name || !params.pluralName) {
            throw new Error("Invalid arguments");
        }

        this[params.name] = function(obj) {
            return new OBJY.Obj(obj, params.name, this, params);
        }

        if (this.objectFamilies.indexOf(params.name) == -1) this.objectFamilies.push(params.name);

        this[params.pluralName] = function(objs, flags) {
            return new OBJY.Objs(objs, params.name, this, params, flags);
        }

        if (params.storage) this.plugInPersistenceMapper(params.name, params.storage);
        else this.plugInPersistenceMapper(params.name, thisRef.storage || new DefaultStorageMapper(thisRef));

        if (params.processor) this.plugInProcessor(params.name, params.processor);
        else this.plugInProcessor(params.name, thisRef.processor || new DefaultProcessorMapper(thisRef));

        if (params.observer) {
            this.plugInObserver(params.name, params.observer);
            if (params.observer.initialize) params.observer.initialize();
        } else {
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

    ObjectFamily: function(params) {
        return this.define(params);
    },

    mappers: {},

    caches: {},

    getConstructor: function(role) {
        if (this.mappers[role]) return OBJY[role];
        throw new Error("No constructor");
    },

    getPersistenceMapper: function(family) {
        if (!this.mappers[family]) throw new Error("No such Object Family");
        return this.mappers[family];
    },

    getPersistence: function(family) {
        if (!this.mappers[family]) throw new Error("No such Object Family: " + family);
        return this.mappers[family];
    },

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

    processors: {},

    getProcessor: function(family) {
        if (!this.processors[family]) throw new Error("No such Object Family");
        return this.processors[family];
    },

    plugInProcessor: function(name, processor) {
        if (!name) throw new Error("No mapper name provided");
        this.processors[name] = processor;
        this.processors[name].setObjectFamily(name);
    },

    observers: {},

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

    ConditionsChecker: function(property, value) {

        if (property.hasOwnProperty('conditions')) {

            //new ConditionEngine(undefined, property, undefined, value).execute(property.conditions);
        }
    },

    execProcessorAction: function(dsl, obj, prop, data, callback, client, options) {
        Logger.log("triggering dsl")
        this.processors[obj.role].execute(dsl, obj, prop, data, callback, client, this.instance.activeUser, options);
    },

    getElementPermisson: function(element) {
        if (!element) return {};
        else if (!element.permissions) return {};
        else return element.permissions;
    },

    updateInheritedObjs: function(templ, pluralName, success, error, client, params) { //@TPDO: Fix this!
        var templateFamily;

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

        }, client, {})
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

        }, client, {})
    },


    prepareObjectDelta: function(oldObj, newObj) {

        var meta = ['name', 'type'];
        meta.forEach(function(p) {
            if (newObj[p] != oldObj[p]) oldObj[p] = newObj[p];
        })

        /*Object.keys(newObj).forEach(function(p)
        {
            if(typeof newObj[p] !== "object")
                if(newObj[p] != oldObj[p]) oldObj[p] = newObj[p];
        })*/

        var handlers = ['onCreate', 'onChange', 'onDelete'];
        handlers.forEach(function(h) {
            if (newObj[h]) {
                Object.keys(newObj[h]).forEach(function(oC) {
                    if (newObj[h][oC]) {
                        if (newObj[h][oC].value != oldObj[h][oC].value)
                            oldObj[h][oC].value = newObj[h][oC].value;
                        oldObj[h][oC].overwritten = true;
                    }
                })
            }
        })

        // Properties
        function doTheProps(newObj) {

            Object.keys(newObj.properties).forEach(function(p) {

                if (newObj.properties[p].type == 'bag') {
                    doTheProps(newObj.properties[p]);
                }

                if (newObj.properties[p]) {
                    if (newObj.properties[p].template && oldObj.properties[p]) {

                        if (newObj.properties[p].value != oldObj.properties[p].value) {

                            oldObj.properties[p].value = newObj.properties[p].value;
                            oldObj.properties[p].overwritten = true;
                        }

                        if (newObj.properties[p].action != oldObj.properties[p].action) {

                            oldObj.properties[p].action = newObj.properties[p].action;
                            oldObj.properties[p].overwritten = true;
                        }

                        if (newObj.properties[p].date != oldObj.properties[p].date) {

                            oldObj.properties[p].date = newObj.properties[p].date;
                            oldObj.properties[p].overwritten = true;
                        }

                        if (newObj.properties[p].interval != oldObj.properties[p].interval) {

                            oldObj.properties[p].interval = newObj.properties[p].interval;
                            oldObj.properties[p].overwritten = true;
                        }

                        if (JSON.stringify(newObj.properties[p].meta) != JSON.stringify(oldObj.properties[p].interval)) {

                            oldObj.properties[p].meta = newObj.properties[p].meta;
                            oldObj.properties[p].overwritten = true;
                        }
                    }

                }

                if (!oldObj.properties[p]) oldObj.properties[p] = newObj.properties[p];


                if (newObj.permissions) {
                    Object.keys(newObj.permissions).forEach(function(p) {
                        if (newObj.permissions[p]) {
                            if (JSON.stringify(newObj.permissions[p]) != JSON.stringify(oldObj.permissions[p]))
                                oldObj.permissions[p] = newObj.permissions[p]
                            oldObj.permissions[p].overwritten = true;
                        }
                    })
                }

                if (newObj.properties[p]) {
                    handlers.forEach(function(h) {
                        if (newObj.properties[p][h]) {
                            Object.keys(newObj.properties[p][h]).forEach(function(oC) {
                                if (newObj.properties[p][h][oC]) {
                                    if (newObj.properties[p][h][oC].value != oldObj.properties[p][h][oC].value)
                                        oldObj.properties[p][h][oC].value = newObj.properties[p][h][oC].value;
                                    oldObj.properties[p][h][oC].overwritten = true;
                                }
                            })
                        }
                    })
                }

            })
        }

        doTheProps(newObj);

        // Applications TODO

        // Permissions
        if (newObj.permissions) {
            Object.keys(newObj.permissions).forEach(function(p) {
                if (newObj.permissions[p]) {
                    if (newObj.permissions[p].value != oldObj.permissions[p].value)
                        oldObj.permissions[p].value = newObj.permissions[p].value
                    oldObj.permissions[p].overwritten = true;
                }
            })
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

    getTemplateFieldsForObject: function(obj, templateId, success, error, client, templateRole) {

        var self = this;

        function run(template) {

            if (!template) {

            }

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
                        if (!obj[h][oC]) {
                            obj[h][oC] = template[h][oC];
                            obj[h][oC].template = templateId;
                        }
                    })
                }
            })


            // Properties
            function doTheProps(template, obj) {

                if (!obj) obj = {}

                if (!obj.properties) {
                    obj.properties = {};
                }

                //console.info('compare', template, 'obj:', obj)

                if (!template.properties) template.properties = {};

                Object.keys(template.properties).forEach(function(p) {

                    if (template.properties[p].type == 'bag') {

                        if (!obj.properties[p]) {

                            obj.properties[p] = template.properties[p];
                            obj.properties[p].template = templateId;
                        } else {
                            if (!obj.properties[p].overwritten && Object.keys(obj.properties[p]).length == 0) {
                                obj.properties[p] = template.properties[p];
                            }

                            obj.properties[p].template = templateId;
                            //obj.properties[p].overwritten = true;
                        }

                        doTheProps(template.properties[p], obj.properties[p]);
                    }


                    if (!obj.properties[p]) {
                        obj.properties[p] = template.properties[p];
                        obj.properties[p].template = templateId;
                        delete obj.properties[p].overwritten;
                    } else {

                        if (!obj.properties[p].overwritten) {
                            obj.properties[p].template = templateId;
                            if (obj.properties[p].value == null) obj.properties[p].value = template.properties[p].value;
                            //obj.properties[p].overwritten = true;
                        }

                        if (!obj.properties[p].metaOverwritten) {
                            obj.properties[p].meta = template.properties[p].meta;
                        }
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
                        })
                    }

                    ['onCreate', 'onChange', 'onDelete'].forEach(function(h) {
                        if (template.properties[p][h]) {
                            if (!obj.properties[p][h]) obj.properties[p][h] = {};

                            Object.keys(template.properties[p][h]).forEach(function(oC) {

                                if (!obj.properties[p][h][oC]) {
                                    obj.properties[p][h][oC] = template.properties[p][h][oC];
                                    obj.properties[p][h][oC].template = templateId;
                                }
                            })
                        }
                    })

                })
            }


            doTheProps(template, obj);


            // Applications

            if (template.applications) {
                template.applications.forEach(function(a) {
                    if (obj.applications.indexOf(a) == -1) obj.applications.push(a);
                })
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
                })
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
                        })
                    })

                    if (!contains) {
                        obj.privileges[a].push({
                            name: tP.name,
                            template: templateId
                        })
                    }

                })
            }

            success(obj);

        }

        if (self.caches[templateRole || obj.role].get(templateId)) {
            //run(self.caches[templateRole || obj.role].get(templateId))

        } else {

            /*self.getObjectById(templateRole || obj.role, templateId, function(template) {
                run(template);
                //if(!self.caches[templateRole || obj.role].get(templateId)) self.caches[templateRole || obj.role].add(templateId,  template);
            }, function(err) {
                error(err);
            }, undefined, client)*/

            OBJY[templateRole || obj.role](templateId).get(function(template) {

                //if(!self.caches[templateRole || obj.role].get(templateId)) self.caches[templateRole || obj.role].add(templateId,  template);

                run(template)

            }, function(err) {
                error(err);
            })
        }
    },

    removeTemplateFieldsForObject: function(obj, templateId, success, error, client) {

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
                })
            }
        })

        // Properties
        function doTheProps(obj) {

            Object.keys(obj.properties).forEach(function(p) {

                if (obj.properties[p].type == 'bag') {
                    doTheProps(obj.properties[p]);
                }

                if (obj.properties[p]) {
                    if (obj.properties[p].value != null) obj.properties[p].overwritten = true;
                    if (obj.properties[p].template == templateId && !obj.properties[p].overwritten) {
                        //console.info('deleting obj', p, obj.properties[p])
                        delete obj.properties[p];
                    }
                }

                if (obj.permissions) {
                    Object.keys(obj.permissions).forEach(function(p) {
                        if (obj.permissions[p]) {
                            if (obj.permissions[p].template == templateId && !obj.permissions[p].overwritten)
                                delete obj.permissions[p]
                        }
                    })
                }

                if (obj.properties[p]) {
                    ['onCreate', 'onChange', 'onDelete'].forEach(function(h) {
                        if (obj.properties[p][h]) {

                            Object.keys(obj.properties[p][h]).forEach(function(oC) {

                                if (obj.properties[p][h][oC]) {
                                    if (obj.properties[p][h][oC].template == templateId && !obj.properties[p][h][oC].overwritten)
                                        delete obj.properties[p][h][oC];
                                }
                            })
                        }
                    })
                }

            })
        }

        doTheProps(obj);


        // Applications TODO

        // Permissions
        if (obj.permissions) {
            Object.keys(obj.permissions).forEach(function(p) {
                if (obj.permissions[p]) {
                    if (obj.permissions[p].template == templateId && !obj.permissions[p].overwritten)
                        delete obj.permissions[p];
                }
            })
        }

        // Privileges
        if (obj.privileges) {
            Object.keys(obj.privileges).forEach(function(a) {

                obj.privileges[a].forEach(function(tP, i) {
                    if (tP.template == templateId && !tP.overwritten)
                        obj.privileges[a].splice(i, 1);
                })
            })
        }
        success(obj);
    },

    updateObjAfterTemplateChange: function(templateId) {

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

    removeTemplateFieldsToObject: function(obj, templateId) {
        this.getTemplateAsyn(templateId, function(template) {
                var propertyKeys = Object.keys(template.properties);
                propertyKeys.forEach(function(property) {
                    if (obj.properties[property] === undefined) {
                        this.removeTemplateFieldFromObjects(obj.template.properties[property])
                    }
                })
            },
            function(error) {

            })
    },

    addTemplateToObject: function(obj, templateId, instance) {
        var contains = false;
        obj.inherits.forEach(function(templ) {
            if (templ == templateId) contains = true;
        });

        if (!contains) {
            obj.inherits.push(templateId);
            OBJY.chainPermission(obj, instance, 'i', 'addInherit', templateId);
            OBJY.chainCommand(obj, instance, 'addInherit', templateId);
        }

    },

    addApplicationToObject: function(obj, application, instance) {
        var contains = false;
        obj.applications.forEach(function(app) {
            if (app == application) contains = true;
        });
        if (!contains) {
            obj.applications.push(application);
            OBJY.chainPermission(obj, instance, 'a', 'addApplication', application);

        } else throw new DuplicateApplicationException(application);

    },

    removeApplicationFromObject: function(obj, application, instance) {
        var contains = false;
        obj.applications.forEach(function(app, i) {
            if (app == application) {
                obj.applications.splice(i, 1);
                contains = true;
                return;
            }
        });

        OBJY.chainPermission(obj, instance, 'a', 'removeApplication', application);

        if (!contains) {
            throw new NoSuchApplicationException(application);
        }
    },

    removeTemplateFromObject: function(obj, templateId, success, error, instance) {
        var contains = false;

        obj.inherits.forEach(function(templ) {
            if (templ == templateId) contains = true;
        });

        if (obj.inherits.indexOf(templateId) != -1) {
            /*var propKeys = Object.keys(obj.properties);
            var i;
            for (i = 0; i < propKeys.length; i++) {
                console.log("properties inherit");
                console.log(obj.properties[propKeys[i]] + ' . ' + templateId);
                if (obj.properties[propKeys[i]].template == templateId) delete obj.properties[propKeys[i]];
            }
            var permissionKeys = Object.keys(obj.permissions);
            var i;
            for (i = 0; i < permissionKeys.length; i++) {
                console.log("permissions inherit");
                console.log(obj.permissions[permissionKeys[i]] + ' . ' + templateId);
                if (obj.permissions[permissionKeys[i]].template == templateId) delete obj.permissions[permissionKeys[i]];
            }
            var i;
            for (i = 0; i < obj.inherits.length; i++) {
                if (obj.inherits[i] == templateId) obj.inherits.splice(i, 1);
            }*/


            obj.inherits.splice(obj.inherits.indexOf(templateId), 1);

            OBJY.chainPermission(obj, instance, 'i', 'removeInherit', templateId);
            OBJY.chainCommand(obj, instance, 'removeInherit', templateId);

            success(obj);

        } else {
            error('Template not found in object');
        }


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

    add: function(obj, success, error, app, client) {

        if (obj.properties) {

            var propKeys = Object.keys(obj.properties);

            propKeys.forEach(function(property) {

                if (property.template) property = null;

                if (property.type == CONSTANTS.PROPERTY.TYPE_SHORTID) {
                    if (property.value == '' && !property.value)
                        property.value = OBJY.RANDOM();
                }

            })

        }

        this.addObject(obj, success, error, app, client);

    },

    addObject: function(obj, success, error, app, client) {

        this.mappers[obj.role].add(obj, function(data) {
            success(data);

        }, function(err) {
            error(err);
        }, app, client);

    },

    updateO: function(obj, success, error, app, client) {

        var thisRef = this;


        if (obj.inherits.length == 0) thisRef.updateObject(obj, success, error, app, client);

        var counter = 0;
        obj.inherits.forEach(function(template) {

            if (obj._id != template) {

                OBJY.removeTemplateFieldsForObject(obj, template, function() {
                        counter++;
                        if (counter == obj.inherits.length) {

                            thisRef.updateObject(obj, success, error, app, client);

                            return obj;
                        }
                    },
                    function(err) {

                        thisRef.updateObject(obj, success, error, app, client);
                        return obj;
                    }, client)
            } else {
                if (obj.inherits.length == 1) {
                    thisRef.updateObject(obj, success, error, app, client);
                    return obj;
                } else {
                    counter++;
                    return;
                }
            }
        });

        return;

        /*
                var propKeys = Object.keys(obj.properties);
                propKeys.forEach(function(property) {
                    {
                        if (obj.properties[property].template) {
                            if (!obj.properties[property].overwrittenOnCreate) delete obj.properties[property].onCreate;
                            if (!obj.properties[property].overwrittenOnChange) delete obj.properties[property].onChange;
                            if (!obj.properties[property].overwrittenOnDelete) delete obj.properties[property].onDelete;
                            if (!obj.properties[property].meta) delete obj.properties[property].meta;
                            if (!obj.properties[property].overwritten) delete obj.properties[property];
                        }
                    }
                })
                if (obj.privileges) {
                    var appKeys = Object.keys(obj.privileges);
                    appKeys.forEach(function(app) {
                        var k;
                        for (k = 0; k < obj.privileges[app].length; k++) {
                        }
                        if (obj.privileges[app].length == 0) delete obj.privileges[app];
                    })
                }
                this.updateObject(obj, success, error, app, client);*/


        // ADD TENANT AND APPLICATION!!!
    },

    updateObject: function(obj, success, error, app, client) {

        this.mappers[obj.role].update(obj, function(data) {
            success(data);
        }, function(err) {
            error(err);
        }, app, client);
    },

    getObjectById: function(role, id, success, error, app, client) {


        this.mappers[role].getById(id, function(data) {

            //console.log("---" + data)

            if (data == null) {
                error('Error - object not found');
                return;
            }

            success(data);


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


            /*data.forEach(function(obj, i) {
                counter++;
                if (counter == data.length) success(data);
                /*new OBJY.Obj(obj).get(function(ob) {
                        counter++;
                        data[i] = ob
                        if (counter == data.length) success(data);
                    },
                    function(err) {
                        error(err);
                    }, client);*
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

    PropertyRefParser: function(obj, propertyName, success, error) {
        var allProperties = obj.getProperties();

        try {
            propertyToReturn = allProperties[propertyName];
        } catch (e) {

        }

        if (!propertyToReturn) throw new PropertyNotFoundException(propertyName);

        if (!propertyToReturn.type == 'objectRef') throw new PropertyNotFoundException(propertyName);


        return OBJY.getObjectByIdSyn(propertyToReturn.value);

    },

    EventParser: function(obj, eventName) {
        var allEvents = obj.events;
        var thisRef = this;

        var eventToReturn;

        function getValue(obj, access) {
            if (typeof(access) == 'string') {
                access = access.split('.');
            }
            if (access.length > 1) {
                getValue(obj.events[access.shift()], access);
            } else {

                try {
                    var t = obj.events[access[0]].type;
                } catch (e) {
                    throw new NoSuchEventException(propertyName);
                }

                eventToReturn = obj.events[access[0]];
            }
        }

        getValue(obj, eventName);

        return eventToReturn;

    },


    PropertyBagItemQueryRemover: function(obj, propertyName) {
        var allProperties = obj.properties;
        var thisRef = this;


        var propertyToReturn;

        function removeQuery(obj, access) {
            if (typeof(access) == 'string') {
                access = access.split('.');
            }
            if (access.length > 1) {
                removeQuery(obj.properties[access.shift()], access);
            } else {


                try {
                    var t = obj.properties[access[0]].type;
                } catch (e) {
                    throw new NoSuchPropertyException(propertyName);
                }

                if (!obj.properties[access[0]].query) throw new NoSuchPermissionException(permissionKey);


                delete obj.properties[access[0]].query;
                return;
            }
        }

        removeQuery(obj, propertyName);

    },


    PropertyBagItemConditionsRemover: function(obj, propertyName) {
        var allProperties = obj.properties;
        var thisRef = this;


        var propertyToReturn;

        function removeConditions(obj, access) {
            if (typeof(access) == 'string') {
                access = access.split('.');
            }
            if (access.length > 1) {
                removeConditions(obj.properties[access.shift()], access);
            } else {


                try {
                    var t = obj.properties[access[0]].type;
                } catch (e) {
                    throw new NoSuchPropertyException(propertyName);
                }

                if (!obj.properties[access[0]].conditions) throw new NoSuchPermissionException(permissionKey);


                delete obj.properties[access[0]].conditions;
                return;
            }
        }

        removeConditions(obj, propertyName);

    },


    PropertyBagItemOnChangeRemover: function(obj, propertyName, name) {
        var allProperties = obj.properties;
        var thisRef = this;

        var propertyToReturn;

        function removeOnChange(obj, access) {
            if (typeof(access) == 'string') {
                access = access.split('.');
            }
            if (access.length > 1) {
                removeOnChange(obj.properties[access.shift()], access);
            } else {


                try {
                    var t = obj.properties[access[0]].type;
                } catch (e) {
                    throw new NoSuchPropertyException(propertyName);
                }

                if (!obj.properties[access[0]].onChange[name]) throw new HandlerNotFoundException(name);

                delete obj.properties[access[0]].onChange[name];
                return;
            }
        }

        removeOnChange(obj, propertyName);

    },

    PropertyBagItemMetaRemover: function(obj, propertyName) {
        var allProperties = obj.properties;
        var thisRef = this;

        var propertyToReturn;

        function removeOnChange(obj, access) {
            if (typeof(access) == 'string') {
                access = access.split('.');
            }
            if (access.length > 1) {
                removeOnChange(obj.properties[access.shift()], access);
            } else {

                try {
                    var t = obj.properties[access[0]].type;
                } catch (e) {
                    throw new NoSuchPropertyException(propertyName);
                }

                if (!obj.properties[access[0]].meta) throw new NoSuchPermissionException(permissionKey);

                delete obj.properties[access[0]].meta;
                return;
            }
        }

        removeOnChange(obj, propertyName);

    },

    PropertyBagItemOnCreateRemover: function(obj, propertyName, handlerName) {
        var allProperties = obj.properties;
        var thisRef = this;

        var propertyToReturn;

        function removeOnCreate(obj, access) {
            if (typeof(access) == 'string') {
                access = access.split('.');
            }
            if (access.length > 1) {
                removeOnCreate(obj.properties[access.shift()], access);
            } else {

                try {
                    var t = obj.properties[access[0]].type;
                } catch (e) {
                    throw new NoSuchPropertyException(propertyName);
                }

                if (!obj.properties[access[0]].onCreate) throw new HandlerNotFoundException();
                if (!obj.properties[access[0]].onCreate[handlerName]) throw new HandlerNotFoundException();

                delete obj.properties[access[0]].onCreate[handlerName];
                return;
            }
        }

        removeOnCreate(obj, propertyName);

    },

    PropertyBagItemOnDeleteRemover: function(obj, propertyName, name) {
        var allProperties = obj.properties;
        var thisRef = this;

        var propertyToReturn;

        function removeOnDelete(obj, access) {
            if (typeof(access) == 'string') {
                access = access.split('.');
            }
            if (access.length > 1) {
                removeOnDelete(obj.properties[access.shift()], access);
            } else {

                try {
                    var t = obj.properties[access[0]].type;
                } catch (e) {
                    throw new NoSuchPropertyException(propertyName);
                }

                if (!obj.properties[access[0]].onDelete[name]) throw new HandlerNotFoundException(name);

                delete obj.properties[access[0]].onDelete[name];
                return;
            }
        }

        removeOnDelete(obj, propertyName);

    },

    PropertyBagItemPermissionRemover: function(obj, propertyName, permissionKey, instance) {
        var allProperties = obj.properties;
        var thisRef = this;

        var propertyToReturn;

        function removePermission(obj, access) {
            if (typeof(access) == 'string') {
                access = access.split('.');
            }
            if (access.length > 1) {
                removePermission(obj.properties[access.shift()], access);
            } else {


                try {
                    var t = obj.properties[access[0]].type;
                } catch (e) {
                    throw new NoSuchPropertyException(propertyName);
                }

                if (!obj.properties[access[0]].permissions) throw new NoSuchPermissionException(permissionKey);
                if (!obj.properties[access[0]].permissions[permissionKey]) throw new NoSuchPermissionException(permissionKey);

                OBJY.chainPermission(obj, instance, 'x', 'removePropertyPermission', propertyName)

                delete obj.properties[access[0]].permissions[permissionKey];
                return;
            }
        }

        removePermission(obj, propertyName);

    },

    PropertyBagItemRemover: function(obj, propertyName, instance) {
        var allProperties = obj.properties; //obj.getProperties();
        var thisRef = this;


        var propertyToReturn;

        function getValue(obj, access) {
            if (typeof(access) == 'string') {
                access = access.split('.');
            }
            if (access.length > 1) {
                getValue(obj.properties[access.shift()], access);
            } else {


                try {
                    var t = obj.properties[access[0]].type;
                } catch (e) {
                    throw new NoSuchPropertyException(propertyName);
                }


                if (obj.properties[access[0]].onDelete) {
                    if (Object.keys(obj.properties[access[0]].onDelete).length > 0) {
                        if (!instance.handlerSequence[obj._id]) instance.handlerSequence[obj._id] = {};
                        if (!instance.handlerSequence[obj._id].onDelete) instance.handlerSequence[obj._id].onDelete = [];
                        instance.handlerSequence[obj._id].onDelete.push(obj.properties[access[0]].onDelete);
                    }
                }


                OBJY.chainPermission(obj.properties[access[0]], instance, 'd', 'removeProperty', propertyName);

                delete obj.properties[access[0]];

                return;
            }
        }

        getValue(obj, propertyName);

    },

    PropertyParser: function(obj, propertyName) {
        var allProperties = obj.properties;
        var thisRef = this;

        var propertyToReturn;

        function getValue(obj, access) {

           
            if (typeof(access) == 'string') {
                access = access.split('.');
            }
            if (access.length > 1) {
                var k = access.shift();
                if(obj[k]) getValue(obj[k], access);
                else if(obj.properties[k]) getValue(obj.properties[k], access);
            
            } else {

               /* try {
                    var t = obj.properties[access[0]].type;
                } catch (e) {
                    throw new NoSuchPropertyException(propertyName);
                }*/

                if(obj[access[0]]) propertyToReturn = obj[access[0]];
                else if(obj.properties[access[0]]) propertyToReturn = obj.properties[access[0]];
               
            }
        }

        getValue(obj, propertyName);


        if (propertyToReturn.type == "action") {
            propertyToReturn.call = function(callback, client) {
                thisRef.execProcessorAction(propertyToReturn.value, obj, propertyToReturn, {}, callback, client, {});
            }
        }

        return propertyToReturn;

    },


    ValuePropertyMetaSubstituter: function(property) {
        if (typeof property !== 'undefined')
            if (typeof property.value === 'undefined') property.value = null;
    },


    ActionCreateWrapper: function(obj, action, client) {

        action = Object.assign({}, action);

        if (typeof action !== 'object') throw new InvalidFormatException();
        var actionKey = Object.keys(action)[0];

        try {
            existing = obj.actions[actionKey]

        } catch (e) {}

        if (existing) throw new DuplicateActionException(actionKey);
    },



    PropertyCreateWrapper: function(obj, property, isBag, instance) {


        property = Object.assign({}, property);


        var propertyKey = Object.keys(property)[0];

        if (typeof property !== 'object') {
            throw new InvalidFormatException();
            //obj.properties[propertyKey] = property[propertyKey];
            //return;
        }


        try {
            existing = obj.properties[propertyKey]

        } catch (e) {}

        /*iif (!property[propertyKey].type) {
            obj.properties[propertyKey] = property[propertyKey];
           
            f (typeof property[propertyKey].value === 'string') {
                if (property[propertyKey].value.length <= 255) property[propertyKey].type = CONSTANTS.PROPERTY.TYPE_SHORTTEXT;
                else property[propertyKey].type = CONSTANTS.PROPERTY.TYPE_LONGTEXT;
            } else if (typeof property[propertyKey].value === 'boolean')
                property[propertyKey].type = CONSTANTS.PROPERTY.TYPE_BOOLEAN;
            else property[propertyKey].type = CONSTANTS.PROPERTY.TYPE_SHORTTEXT;
        }*/


        if (existing) throw new DuplicatePropertyException(propertyKey);

        //console.debug(property);
        switch ((property[propertyKey] || {}).type) {
            case undefined:
                obj.properties[propertyKey] = property[propertyKey];
                break;

            case CONSTANTS.PROPERTY.TYPE_SHORTTEXT:
                obj.properties[propertyKey] = property[propertyKey];
                OBJY.ValuePropertyMetaSubstituter(obj.properties[propertyKey]);
                break;

            case CONSTANTS.PROPERTY.TYPE_LONGTEXT:
                obj.properties[propertyKey] = property[propertyKey];
                OBJY.ValuePropertyMetaSubstituter(obj.properties[propertyKey]);
                break;

            case CONSTANTS.PROPERTY.TYPE_INDEXEDTEXT:
                obj.properties[propertyKey] = property[propertyKey];
                OBJY.ValuePropertyMetaSubstituter(obj.properties[propertyKey]);
                break;

            case CONSTANTS.PROPERTY.TYPE_JSON:
                if (property[propertyKey].value) {
                    if (typeof property[propertyKey].value === 'string') {
                        try {
                            obj.properties[propertyKey].value = JSON.parse(obj.properties[propertyKey].value);
                        } catch (e) {
                            //throw new InvalidValueException(property[propertyKey].value, CONSTANTS.PROPERTY.TYPE_JSON);
                        }
                    } else {

                    }
                }
                obj.properties[propertyKey] = property[propertyKey];
                OBJY.ValuePropertyMetaSubstituter(obj.properties[propertyKey]);
                break;

            case CONSTANTS.PROPERTY.TYPE_NUMBER:
                if (property[propertyKey].value != '') {
                    if (property[propertyKey].value != null)
                        if (isNaN(property[propertyKey].value)) throw new InvalidValueException(property[propertyKey].value, CONSTANTS.PROPERTY.TYPE_NUMBER);
                }
                obj.properties[propertyKey] = property[propertyKey];
                OBJY.ValuePropertyMetaSubstituter(obj.properties[propertyKey]);
                break;

            case CONSTANTS.PROPERTY.TYPE_EVENT:

                var _event = {};
                var eventKey = propertyKey;
                _event[eventKey] = property[propertyKey];

                if (!_event[eventKey].eventId) _event[eventKey].eventId = OBJY.ID();

                if (!_event[eventKey].reminders) _event[eventKey].reminders = {};


                if (_event[eventKey].interval !== undefined) {

                    if (_event[eventKey].lastOccurence == undefined) _event[eventKey].lastOccurence = null;
                    else if (!moment(_event[eventKey].lastOccurence).isValid()) throw new InvalidDateException(_event[eventKey].lastOccurence);
                    else _event[eventKey].lastOccurence = moment(_event[eventKey].lastOccurence).utc().format();


                    if (_event[eventKey].nextOccurence == undefined)
                        _event[eventKey].nextOccurence = moment().toISOString();

                    if (_event[eventKey].action === undefined) _event[eventKey].action = '';


                    if (_event[eventKey].interval === undefined) throw new MissingAttributeException('interval');

                    _event[eventKey].nextOccurence = moment(_event[eventKey].lastOccurence || moment().utc()).utc().add(_event[eventKey].interval).toISOString();

                   /* instance.eventAlterationSequence.push({
                        operation: 'add',
                        obj: obj,
                        propName: propertyKey,
                        property: property,
                        date: _event[eventKey].nextOccurence
                    })*/

                } else if (_event[eventKey].date !== undefined) {

                    if (_event[eventKey].date == null) _event[eventKey].date = moment().utc().toISOString();

                    if (!_event[eventKey].date) throw new MissingAttributeException('date');

                    try {
                        _event[eventKey].date = moment(_event[eventKey].date).utc().format();
                    } catch (e) {

                    }

                   /* instance.eventAlterationSequence.push({
                        operation: 'add',
                        obj: obj,
                        propName: propertyKey,
                        property: property,
                        date: _event[eventKey].date
                    })*/

                    if (!_event[eventKey].action) _event[eventKey].action = '';
                } else {
                    //throw new InvalidTypeException("No interval or date provided");
                }

                obj.properties[propertyKey] = _event[eventKey];
                break;

            case CONSTANTS.PROPERTY.TYPE_DATE:
                if (!property[propertyKey].value || property[propertyKey].value == '') property[propertyKey].value = null;
                //else property[propertyKey].value = property[propertyKey];
                obj.properties[propertyKey] = property[propertyKey];
                OBJY.ValuePropertyMetaSubstituter(obj.properties[propertyKey]);
                break;


            case CONSTANTS.PROPERTY.TYPE_SHORTID:
                if (!property[propertyKey].value || property[propertyKey].value == '') property[propertyKey].value = OBJY.RANDOM();
                if (obj.role == 'template') property[propertyKey].value = null;
                obj.properties[propertyKey] = property[propertyKey];
                OBJY.ValuePropertyMetaSubstituter(obj.properties[propertyKey]);
                break;

            case CONSTANTS.PROPERTY.TYPE_REF_OBJ:


                // FOR NOW: no checking for existing object, since callback!!!
                obj.properties[propertyKey] = property[propertyKey];
                OBJY.ValuePropertyMetaSubstituter(obj.properties[propertyKey]);
                break;

            case CONSTANTS.PROPERTY.TYPE_REF_USR:



                // FOR NOW: no checking for existing object, since callback!!!
                obj.properties[propertyKey] = property[propertyKey];
                OBJY.ValuePropertyMetaSubstituter(obj.properties[propertyKey]);
                break;

            case CONSTANTS.PROPERTY.TYPE_REF_FILE:



                // FOR NOW: no checking for existing object, since callback!!!
                obj.properties[propertyKey] = property[propertyKey];
                OBJY.ValuePropertyMetaSubstituter(obj.properties[propertyKey]);
                break;

            case CONSTANTS.PROPERTY.TYPE_PROPERTY_BAG:

                if (!property[propertyKey].properties) property[propertyKey].properties = {};

                var innerProperties = property[propertyKey].properties;

                var propertyKeys = Object.keys(innerProperties);

                parentProp = property;

                obj.properties[propertyKey] = property[propertyKey];
                obj.properties[propertyKey].type = CONSTANTS.PROPERTY.TYPE_PROPERTY_BAG;
                obj.properties[propertyKey].properties = {};

                propertyKeys.forEach(function(property) {
                    tmpProp = {};
                    tmpProp[property] = innerProperties[property];

                    new OBJY.PropertyCreateWrapper(obj.properties[propertyKey], Object.assign({}, tmpProp), true, instance);
                })

                break;

            case CONSTANTS.PROPERTY.TYPE_ARRAY:

                if (!property[propertyKey].properties) property[propertyKey].properties = {};

                var innerProperties = property[propertyKey].properties;

                var propertyKeys = Object.keys(innerProperties);

                parentProp = property;

                obj.properties[propertyKey] = {
                    type: CONSTANTS.PROPERTY.TYPE_ARRAY,
                    properties: {},
                    query: property[propertyKey].query,
                    meta: property[propertyKey].meta
                };


                propertyKeys.forEach(function(property) {
                    tmpProp = {};
                    tmpProp[property] = innerProperties[property];

                    new OBJY.PropertyCreateWrapper(obj.properties[propertyKey], Object.assign({}, tmpProp), true, instance);
                })

                break;

            case CONSTANTS.PROPERTY.TYPE_BOOLEAN:
                if (!typeof property[propertyKey].value === 'boolean') throw new InvalidValueException(property[propertyKey].value, CONSTANTS.PROPERTY.TYPE_BOOLEAN);
                obj.properties[propertyKey] = property[propertyKey];
                OBJY.ValuePropertyMetaSubstituter(obj.properties[propertyKey]);
                break;

            case CONSTANTS.PROPERTY.TYPE_ACTION:

                if (property[propertyKey].value) {
                    if (typeof property[propertyKey].value !== 'string') throw new InvalidValueException(property[propertyKey].value, CONSTANTS.PROPERTY.TYPE_ACTION);
                }

                obj.properties[propertyKey] = property[propertyKey];
                OBJY.ValuePropertyMetaSubstituter(obj.properties[propertyKey]);
                break;

            default:
                throw new InvalidTypeException(property[propertyKey].type);
        }

        if ((property[propertyKey] || {}).onCreate) {
            if (Object.keys(property[propertyKey].onCreate).length > 0) {
                if (!instance.handlerSequence[obj._id]) instance.handlerSequence[obj._id] = {};
                if (!instance.handlerSequence[obj._id].onCreate) instance.handlerSequence[obj._id].onCreate = [];
                instance.handlerSequence[obj._id].onCreate.push({
                    handler: property[propertyKey].onCreate,
                    prop: property[propertyKey]
                });
            }
        }


        OBJY.chainPermission(obj, instance, 'p', 'addProperty', propertyKey);

        /*if(obj.permissions) {
            if(Object.keys(obj.permissions).length > 0)  {
                if(!instance.permissionSequence[obj._id]) instance.permissionSequence[obj._id] = [];
                    if(!OBJY.checkPermissions(instance.activeUser, instance.activeApp, obj, 'p', true))
                        instance.permissionSequence[obj._id].push({name:'addProperty', key: propertyKey});
            }
        */

    },


    TemplatesCreateWrapper: function(obj, template) //addTemplateToObject!!!
    {
        var existing = false;
        obj.inherits.forEach(function(_template) {
            if (_template == template) existing = true;
        })
        if (!existing) {
            obj.inherits.push(template);

        }
    },


    ObjectPermissionsCreateWrapper: function(obj, permissions) //addTemplateToObject!!!
    {
        if (!typeof permissions == 'object') throw new InvalidPermissionException();

        if (!permissions) return {};

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
        })
        return permissions;
    },

    ObjectOnCreateSetWrapper: function(obj, name, onCreate, trigger, type, instance) {
        //if (!typeof onchange == 'object') throw new InvalidPermissionException();

        if (!onCreate) throw new InvalidHandlerException();

        if (obj.onCreate[name]) throw new HandlerExistsException(name);

        if (!name) name = OBJY.RANDOM();

        if (!obj.onCreate[name]) obj.onCreate[name] = {}

        obj.onCreate[name].value = onCreate;
        obj.onCreate[name].trigger = trigger || 'after';
        obj.onCreate[name].type = type || 'async';

        if (obj.onCreate[name].templateId) obj.onCreate[name].overwritten = true;

        OBJY.chainPermission(obj, instance, 'v', 'setOnCreateHandler', name);

        return onCreate;
    },

    ObjectOnCreateCreateWrapper: function(obj, onCreate, instance) {
        //if (!typeof onchange == 'object') throw new InvalidPermissionException();


        if (!onCreate) onCreate = {};

        Object.keys(onCreate).forEach(function(oC) {
            if (!onCreate[oC].trigger) oC.trigger = 'after';
            if (!onCreate[oC].trigger) oC.type = 'async';

        })

        return onCreate;
    },

    AffectsCreateWrapper: function(obj, affects) {

        if (!affects) affects = {};

        return affects;
    },

    ObjectOnChangeCreateWrapper: function(obj, onChange, instance) {
        //if (!typeof onchange == 'object') throw new InvalidPermissionException();


        if (!onChange) onChange = {};

        Object.keys(onChange).forEach(function(oC) {
            if (!onChange[oC].trigger) oC.trigger = 'after';
            if (!onChange[oC].trigger) oC.type = 'async';

        })

        return onChange;
    },

    ObjectOnDeleteCreateWrapper: function(obj, onDelete, instance) {
        //if (!typeof onchange == 'object') throw new InvalidPermissionException();


        if (!onDelete) onDelete = {};

        Object.keys(onDelete).forEach(function(oC) {
            if (!onDelete[oC].trigger) oC.trigger = 'after';
            if (!onDelete[oC].trigger) oC.type = 'async';

        })

        return onDelete;
    },

    ObjectOnChangeSetWrapper: function(obj, name, onChange, trigger, type, instance) {
        //if (!typeof onchange == 'object') throw new InvalidPermissionException();

        if (!onChange) throw new InvalidHandlerException();

        if (obj.onChange[name]) throw new HandlerExistsException(name);

        if (!name) name = OBJY.RANDOM();

        if (!obj.onChange[name]) obj.onChange[name] = {}

        obj.onChange[name].value = onChange;
        obj.onChange[name].trigger = trigger || 'after';
        obj.onChange[name].type = type || 'async';

        if (obj.onChange[name].templateId) obj.onChange[name].overwritten = true;

        OBJY.chainPermission(obj, instance, 'w', 'setOnChangeHandler', name);

        return onChange;
    },

    ObjectOnDeleteSetWrapper: function(obj, name, onDelete, trigger, type, isntance) {
        //if (!typeof onchange == 'object') throw new InvalidPermissionException();

        if (!onDelete) throw new InvalidHandlerException();

        if (obj.onDelete[name]) throw new HandlerExistsException(name);

        if (!name) name = OBJY.RANDOM();

        if (!obj.onDelete[name]) obj.onDelete[name] = {}

        obj.onDelete[name].value = onDelete;
        obj.onDelete[name].trigger = trigger || 'after';
        obj.onDelete[name].type = type || 'async';

        if (obj.onDelete[name].templateId) obj.onDelete[name].overwritten = true;

        OBJY.chainPermission(obj, instance, 'z', 'setOnDeleteHandler', name);

        return onDelete;
    },

    ObjectPermissionSetWrapper: function(obj, permission, instance) //addTemplateToObject!!!
    {
        if (!typeof permission == 'object') throw new InvalidPermissionException();

        if (!permission) throw new InvalidPermissionException();

        var permissionKey = Object.keys(permission)[0];

        if (!obj.permissions[permissionKey]) obj.permissions[permissionKey] = permission[permissionKey];
        else {
            obj.permissions[permissionKey] = permission[permissionKey];
        }

        OBJY.chainPermission(obj, instance, 'x', 'setPermission', permissionKey);

        return permission;
    },

    ObjectPermissionRemoveWrapper: function(obj, permissionName, instance) //addTemplateToObject!!!
    {
        if (!permissionName) throw new InvalidPermissionException();

        if (!typeof permissionName == 'string') throw new InvalidPermissionException();

        if (!obj.permissions[permissionName]) throw new NoSuchPermissionException(permissionName);

        OBJY.chainPermission(obj, instance, 'x', 'removePermission', permissionName);

        delete obj.permissions[permissionName];

        return permissionName;
    },


    PropertyQuerySetWrapper: function(obj, propertyKey, query) {
        console.debug(obj);
        console.debug(propertyKey);



        function setValue(obj, access, value) {
            if (typeof(access) == 'string') {
                access = access.split('.');
            }
            if (access.length > 1) {
                setValue(obj[access.shift()], access, value);
            } else {
                //obj[access[0]] = value;
                try {
                    var t = obj[access[0]];
                } catch (e) {
                    throw new NoSuchPropertyException(propertyKey);
                }


                if (typeof value !== 'object') throw new InvalidDataTypeException(value, 'object');

                obj[access[0]].query = query;
            }
        }

        setValue(obj, propertyKey, query);

    },


    PropertyMetaSetWrapper: function(obj, propertyKey, meta) {
        function setOnChange(obj, access, meta) {
            if (typeof(access) == 'string') {
                access = access.split('.');
            }
            if (access.length > 1) {
                setOnChange(obj[access.shift()], access, meta);
            } else {

                try {
                    var t = obj[access[0]];
                } catch (e) {
                    throw new NoSuchPropertyException(propertyKey);
                }

                //if (!obj[access[0]].on) obj[access[0]].on = {};

                if (obj[access[0]].template) obj[access[0]].metaOverwritten = true;
                obj[access[0]].meta = meta;
            }
        }

        setOnChange(obj, propertyKey, meta);
    },


    PropertyOnChangeSetWrapper: function(obj, propertyKey, name, onChange, trigger, type, instance) {
        function setOnChange(obj, access, onChange) {
            if (typeof(access) == 'string') {
                access = access.split('.');
            }
            if (access.length > 1) {
                setOnChange(obj[access.shift()], access, onChange);
            } else {

                try {
                    var t = obj[access[0]];
                } catch (e) {
                    throw new NoSuchPropertyException(propertyKey);
                }

                //if (!obj[access[0]].on) obj.properties[access[0]].on = {};

                if (!obj[access[0]].onChange) obj[access[0]].onChange = {}

                if (!obj[access[0]].onChange[name]) obj[access[0]].onChange[name] = {}

                if (obj[access[0]].onChange[name].template) obj[access[0]].onChange[name].overwritten = true;
                obj[access[0]].onChange[name].value = onChange;
                obj[access[0]].onChange[name].trigger = trigger || 'after';
                obj[access[0]].onChange[name].type = type || 'async';

                OBJY.chainPermission(obj[access[0]], instance, 'w', 'setPropertyOnChangeHandler', name);
            }
        }

        setOnChange(obj, propertyKey, onChange);
    },

    PropertyOnCreateSetWrapper: function(obj, propertyKey, name, onCreate, trigger, type, instance) {
        function setOnCreate(obj, access, onCreate) {
            if (typeof(access) == 'string') {
                access = access.split('.');
            }
            if (access.length > 1) {
                setOnCreate(obj[access.shift()], access, onCreate);
            } else {
                //obj[access[0]] = value;
                try {
                    var t = obj[access[0]];
                } catch (e) {
                    throw new NoSuchPropertyException(propertyKey);
                }

                //if (!obj[access[0]].on) obj[access[0]].on = {};

                if (!obj[access[0]].onCreate) obj[access[0]].onCreate = {};

                if (!obj[access[0]].onCreate[name]) obj[access[0]].onCreate[name] = {};

                if (obj[access[0]].onCreate[name].templateId) obj[access[0]].onCreate[name].overwritten = true;

                obj[access[0]].onCreate[name].value = onCreate;
                obj[access[0]].onCreate[name].trigger = trigger || 'after';
                obj[access[0]].onCreate[name].type = type || 'async';

                OBJY.chainPermission(obj[access[0]], instance, 'v', 'setPropertyOnCreateHandler', name);

            }
        }

        setOnCreate(obj, propertyKey, onCreate);
    },

    PropertyOnDeleteSetWrapper: function(obj, propertyKey, name, onDelete, trigger, type, instance) {
        function setOnDelete(obj, access, onDelete) {
            if (typeof(access) == 'string') {
                access = access.split('.');
            }
            if (access.length > 1) {
                setOnDelete(obj[access.shift()], access, onDelete);
            } else {
                //obj[access[0]] = value;
                try {
                    var t = obj[access[0]];
                } catch (e) {
                    throw new NoSuchPropertyException(propertyKey);
                }

                if (!obj[access[0]].onDelete) obj[access[0]].onDelete = {};
                if (!obj[access[0]].onDelete[name]) obj[access[0]].onDelete[name] = {};

                //if (!obj.properties[access[0]].on) obj.properties[access[0]].on = {};
                if (obj[access[0]].onDelete[name].template) obj[access[0]].onDelete[name].overwritten = true;
                obj[access[0]].onDelete[name].value = onDelete;
                obj[access[0]].onDelete[name].trigger = trigger || 'after';
                obj[access[0]].onDelete[name].type = type || 'async';

                OBJY.chainPermission(obj[access[0]], instance, 'z', 'setPropertyOnDeleteHandler', name);
            }
        }

        setOnDelete(obj, propertyKey, onDelete);
    },

    PropertyConditionsSetWrapper: function(obj, propertyKey, conditions) {

        function setConditions(obj, access, conditions) {
            if (typeof(access) == 'string') {
                access = access.split('.');
            }
            if (access.length > 1) {
                setConditions(obj[access.shift()], access, conditions);
            } else {
                //obj[access[0]] = value;
                try {
                    var t = obj[access[0]];
                } catch (e) {
                    throw new NoSuchPropertyException(propertyKey);
                }

                //if (!obj[access[0]].on) obj[access[0]].on = {};

                obj[access[0]].conditions = conditions;
            }
        }

        setConditions(obj, propertyKey, conditions);
    },

    PropertyPermissionSetWrapper: function(obj, propertyKey, permission, instance) {
        console.debug(obj);
        console.debug(propertyKey);


        function setPermission(obj, access, permission) {
            if (typeof(access) == 'string') {
                access = access.split('.');
            }
            if (access.length > 1) {
                setPermission(obj[access.shift()], access, permission);
            } else {
                //obj[access[0]] = value;
                try {
                    var t = obj[access[0]];
                } catch (e) {
                    throw new NoSuchPropertyException(propertyKey);
                }

                var permissionKey = Object.keys(permission)[0];
                if (!obj[access[0]].permissions) obj[access[0]].permissions = {};

                obj[access[0]].permissions[permissionKey] = permission[permissionKey];

                OBJY.chainPermission(obj[access[0]], instance, 'x', 'setPropertyPermission', propertyKey);
            }
        }

        setPermission(obj, propertyKey, permission);



        /*switch(existingProperty.type)
        {
            case constants.PROPERTY_TYPE_SHORTTEXT:
                obj.properties[propertyKey].value = newValue;
            break;
            default : 
                throw new InvalidTypeException(existingProperty.type);
        }*/

        /*if(obj.role == 'template') 
        {
            OBJY.addTemplateFieldToObjects(obj, propertyKey, function(data)
                {
                    console.log("template added!");
                },
                function(error)
                {
                    throw new NoSuchTemplateException(error);
                });
        }*/
    },


    PropertySetWrapper: function(obj, propertyKey, newValue, instance, notPermitted) {


        function setValue(obj, access, value) {
            if (typeof(access) == 'string') {
                access = access.split('.');
            }
            if (access.length > 1) {

                var shift = access.shift();
                try {
                    if (obj[shift].type) {
                        if (obj[shift].type == CONSTANTS.PROPERTY.TYPE_PROPERTY_BAG) {
                            if (obj[shift].template) obj[shift].overwritten = true;
                            //obj.properties[shift].hello = true;
                        }
                        if (obj[shift].type == CONSTANTS.PROPERTY.TYPE_ARRAY) {
                            if (obj[shift].template) obj[shift].overwritten = true;
                            //obj.properties[shift].hello = true;
                        }
                    }
                } catch (e) {}

                setValue(obj[shift], access, value);
            } else {
                //obj[access[0]] = value;
                try {
                    var t = obj[access[0]];
                } catch (e) {
                    throw new NoSuchPropertyException(propertyKey);
                }

                if (obj[access[0]].type == 'boolean') {
                    if (typeof(newValue) != 'boolean') throw new InvalidValueException(newValue, obj[access[0]].type);
                }
                if (obj[access[0]].type == 'number') {
                    if (isNaN(newValue)) throw new InvalidValueException(newValue, obj[access[0]].type);
                }


                if (obj[access[0]].template) obj[access[0]].overwritten = true;
                obj[access[0]].value = newValue;


                if (obj[access[0]].onChange) {
                    if (Object.keys(obj[access[0]].onChange).length > 0) {
                        if (!instance.handlerSequence[obj._id]) instance.handlerSequence[obj._id] = {};
                        if (!instance.handlerSequence[obj._id].onChange) instance.handlerSequence[obj._id].onChange = [];
                        instance.handlerSequence[obj._id].onChange.push({
                            handler: obj[access[0]].onChange,
                            prop: obj[access[0]]
                        });
                    }
                }

                OBJY.chainPermission(obj[access[0]], instance, 'u', 'setPropertyValue', propertyKey);

            }
        }

        setValue(obj, propertyKey, newValue);



        /*switch(existingProperty.type)
        {
            case constants.PROPERTY_TYPE_SHORTTEXT:
                obj.properties[propertyKey].value = newValue;
            break;
            default : 
                throw new InvalidTypeException(existingProperty.type);
        }*/

        /*if(obj.role == 'template') 
        {
            OBJY.addTemplateFieldToObjects(obj, propertyKey, function(data)
                {
                    console.log("template added!");
                },
                function(error)
                {
                    throw new NoSuchTemplateException(error);
                });
        }*/
    },


    PropertySetFullWrapper: function(obj, propertyKey, newValue, instance, notPermitted) {


        function setValue(obj, access, value) {
            if (typeof(access) == 'string') {
                access = access.split('.');
            }
            if (access.length > 1) {

                var shift = access.shift();
                try {
                    if (obj[shift].type) {
                        if (obj[shift].type == CONSTANTS.PROPERTY.TYPE_PROPERTY_BAG) {
                            if (obj[shift].template) obj[shift].overwritten = true;
                            //obj.properties[shift].hello = true;
                        }
                        if (obj[shift].type == CONSTANTS.PROPERTY.TYPE_ARRAY) {
                            if (obj[shift].template) obj[shift].overwritten = true;
                            //obj.properties[shift].hello = true;
                        }
                    }
                } catch (e) {}

                setValue(obj[shift], access, value);
            } else {
                //obj[access[0]] = value;
                try {
                    var t = obj[access[0]];
                } catch (e) {
                    throw new NoSuchPropertyException(propertyKey);
                }

                if (obj[access[0]].template) {
                    newValue.overwritten = true;
                    newValue.template = obj[access[0]].template
                }

                obj[access[0]] = newValue;

                if (obj[access[0]].onChange) {
                    if (Object.keys(obj[access[0]].onChange).length > 0) {
                        if (!instance.handlerSequence[obj._id]) instance.handlerSequence[obj._id] = {};
                        if (!instance.handlerSequence[obj._id].onChange) instance.handlerSequence[obj._id].onChange = [];
                        instance.handlerSequence[obj._id].onChange.push({
                            handler: obj[access[0]].onChange,
                            prop: obj[access[0]]
                        });
                    }
                }

                OBJY.chainPermission(obj[access[0]], instance, 'u', 'setProperty', propertyKey);


            }
        }

        setValue(obj, propertyKey, newValue);

    },

    EventIntervalSetWrapper: function(obj, propertyKey, newValue, client, instance) {


        var prop = obj.getProperty(propertyKey);

        if (prop.type != CONSTANTS.PROPERTY.TYPE_EVENT) throw new NotAnEventException(propertyKey);



        function setValue(obj, access, value) {
            if (typeof(access) == 'string') {
                access = access.split('.');
            }
            if (access.length > 1) {

                var shift = access.shift();
                try {
                    if (obj[shift].type) {
                        if (obj[shift].type == CONSTANTS.PROPERTY.TYPE_PROPERTY_BAG) {
                            if (obj[shift].template) obj[shift].overwritten = true;
                            //obj.properties[shift].hello = true;
                        }
                        if (obj[shift].type == CONSTANTS.PROPERTY.TYPE_ARRAY) {
                            if (obj[shift].template) obj[shift].overwritten = true;
                            //obj.properties[shift].hello = true;
                        }
                    }
                } catch (e) {}

                setValue(obj[shift], access, value);
            } else {
                //obj[access[0]] = value;
                try {
                    var t = obj[access[0]];
                } catch (e) {
                    throw new NoSuchPropertyException(propertyKey);
                }


                if (obj[access[0]].template) obj[access[0]].overwritten = true;

                delete obj[access[0]].date;
                obj[access[0]].interval = newValue;

                if (obj[access[0]].lastOccurence) {

                    var nextOccurence = moment(obj[access[0]].lastOccurence).utc().add(newValue);
                    
                    /*instance.eventAlterationSequence.push({
                        operation: 'remove',
                        obj: obj,
                        propName: propertyKey,
                        property: obj.properties[access[0]],
                        date: nextOccurence
                    })
                    instance.eventAlterationSequence.push({
                        operation: 'add',
                        obj: obj,
                        propName: propertyKey,
                        property: obj.properties[access[0]],
                        date: nextOccurence
                    })*/
                }

                OBJY.chainPermission(obj[access[0]], instance, 'u', 'setEventInterval', propertyKey);

            }
        }

        setValue(obj, propertyKey, newValue);

    },

    EventTriggeredSetWrapper: function(obj, propertyKey, newValue, client, notPermitted) {

        var prop = obj.getProperty(propertyKey);

        if (prop.type != CONSTANTS.PROPERTY.TYPE_EVENT) throw new NotAnEventException(propertyKey);

        function setValue(obj, access, value) {
            if (typeof(access) == 'string') {
                access = access.split('.');
            }

            if (access.length > 1) {

                var shift = access.shift();
                try {
                    if(obj[shift])
                    {
                        if (obj[shift].template) obj[shift].overwritten = true;
                        setValue(obj[shift], access, value);

                    } else if (obj[shift].type) {
                        if (obj[shift].type == CONSTANTS.PROPERTY.TYPE_PROPERTY_BAG) {
                            if (obj[shift].template) obj[shift].overwritten = true;
                        }

                        setValue(obj[shift], access, value);
                    }
                } catch (e) {}

                
            } else {
                //obj[access[0]] = value;
                try {
    
                        var t = obj[access[0]];
                    
                    
                } catch (e) {
                    throw new NoSuchPropertyException(propertyKey);
                }

                
                    if (obj[access[0]].interval)
                        obj[access[0]].nextOccurence = moment().utc().add(obj[access[0]].interval).toISOString();
                    else obj[access[0]].triggered = newValue;
               
                
                
                //obj.properties[access[0]].overwritten = true;
            }
        }

        setValue(obj, propertyKey, newValue);

    },

    EventLastOccurenceSetWrapper: function(obj, propertyKey, newValue, client, notPermitted) {

        var prop = obj.getProperty(propertyKey);

        if (prop.type != CONSTANTS.PROPERTY.TYPE_EVENT) throw new NotAnEventException(propertyKey);


        function setValue(obj, access, value) {
            if (typeof(access) == 'string') {
                access = access.split('.');
            }
            if (access.length > 1) {

                var shift = access.shift();
                try {
                    if (obj[shift].type) {
                        if (obj[shift].type == CONSTANTS.PROPERTY.TYPE_PROPERTY_BAG) {
                            if (obj[shift].template) obj[shift].overwritten = true;
                            //obj.properties[shift].hello = true;
                        }
                        if (obj[shift].type == CONSTANTS.PROPERTY.TYPE_ARRAY) {
                            if (obj[shift].template) obj[shift].overwritten = true;
                            //obj.properties[shift].hello = true;
                        }
                    }
                } catch (e) {}

                setValue(obj[shift], access, value);
            } else {
                //obj[access[0]] = value;
                try {

                    var t = obj[access[0]];

                } catch (e) {
                    throw new NoSuchPropertyException(propertyKey);
                }


                obj[access[0]].lastOccurence = newValue;

                obj[access[0]].nextOccurence = moment(newValue).utc().add(moment.duration(obj[access[0]].interval)).toISOString();
            }
        }

        setValue(obj, propertyKey, newValue);

    },

    EventReminderSetWrapper: function(obj, propertyKey, reminder, client, notPermitted) {


        var prop = obj.getProperty(propertyKey);

        if (prop.type != CONSTANTS.PROPERTY.TYPE_EVENT) throw new NotAnEventException(propertyKey);

        function setValue(obj, access, value) {
            if (typeof(access) == 'string') {
                access = access.split('.');
            }
            if (access.length > 1) {

                var shift = access.shift();
                try {
                    if (obj[shift].type) {
                        if (obj[shift].type == CONSTANTS.PROPERTY.TYPE_PROPERTY_BAG) {
                            if (obj[shift].template) obj[shift].overwritten = true;
                        }
                        if (obj[shift].type == CONSTANTS.PROPERTY.TYPE_ARRAY) {
                            if (obj[shift].template) obj[shift].overwritten = true;
                        }
                    }
                } catch (e) {}

                setValue(obj[shift], access, value);
            } else {
                //obj[access[0]] = value;
                try {
                    var t = obj[access[0]];
                } catch (e) {
                    throw new NoSuchPropertyException(propertyKey);
                }


                if (obj[access[0]].template) obj[access[0]].overwritten = true;

                if (!obj[access[0]].reminders)
                    obj[access[0]].reminders = {};

                obj[access[0]].reminders[reminder.diff] = {
                    action: reminder.action
                };
            }
        }

        setValue(obj, propertyKey, reminder);

    },


    EventReminderRemover: function(obj, propertyKey, reminder, client, notPermitted) {


        var prop = obj.getProperty(propertyKey);

        if (prop.type != CONSTANTS.PROPERTY.TYPE_EVENT) throw new NotAnEventException(propertyKey);

        function setValue(obj, access, value) {
            if (typeof(access) == 'string') {
                access = access.split('.');
            }
            if (access.length > 1) {

                var shift = access.shift();
                try {
                    if (obj[shift].type) {
                        if (obj[shift].type == CONSTANTS.PROPERTY.TYPE_PROPERTY_BAG) {
                            if (obj[shift].template) obj[shift].overwritten = true;
                            //obj.properties[shift].hello = true;
                        }
                        if (obj[shift].type == CONSTANTS.PROPERTY.TYPE_ARRAY) {
                            if (obj[shift].template) obj[shift].overwritten = true;
                            //obj.properties[shift].hello = true;
                        }
                    }
                } catch (e) {}

                setValue(obj[shift], access, value);
            } else {
                //obj[access[0]] = value;
                try {
                    var t = obj[access[0]];
                } catch (e) {
                    throw new NoSuchPropertyException(propertyKey);
                }


                if (obj[access[0]].reminders) {
                    try {
                        delete obj[access[0]].reminders[reminder];
                    } catch (e) {
                        throw new NoSuchReminderException(reminder);
                    }
                }

            }
        }

        setValue(obj, propertyKey, reminder);

    },


    EventDateSetWrapper: function(obj, propertyKey, newValue, client, instance) {


        function setValue(obj, access, value) {
            if (typeof(access) == 'string') {
                access = access.split('.');
            }
            if (access.length > 1) {

                var shift = access.shift();
                try {
                    if (obj[shift].type) {
                        if (obj[shift].type == CONSTANTS.PROPERTY.TYPE_PROPERTY_BAG) {
                            if (obj[shift].template) obj[shift].overwritten = true;
                            //obj.properties[shift].hello = true;
                        }
                        if (obj[shift].type == CONSTANTS.PROPERTY.TYPE_ARRAY) {
                            if (obj[shift].template) obj[shift].overwritten = true;
                            //obj.properties[shift].hello = true;
                        }
                    }
                } catch (e) {}

                setValue(obj[shift], access, value);
            } else {
                //obj[access[0]] = value;
                try {
                    var t = obj[access[0]];
                } catch (e) {
                    throw new NoSuchPropertyException(propertyKey);
                }


                if (obj[access[0]].template) obj[access[0]].overwritten = true;
                delete obj[access[0]].interval;
                delete obj[access[0]].lastOccurence;
                delete obj[access[0]].nextOccurence;
                obj[access[0]].date = newValue;


                /*instance.eventAlterationSequence.push({
                    operation: 'remove',
                    obj: obj,
                    propName: propertyKey,
                    property: obj.properties[access[0]],
                    date: newValue
                })
                instance.eventAlterationSequence.push({
                    operation: 'add',
                    obj: obj,
                    propName: propertyKey,
                    property: obj.properties[access[0]],
                    date: newValue
                })*/

                OBJY.chainPermission(obj[access[0]], instance, 'u', 'setEventDate', propertyKey);

            }
        }

        setValue(obj, propertyKey, newValue);

    },

    EventActionSetWrapper: function(obj, propertyKey, newValue, client, instance) {

        function setValue(obj, access, value) {
            if (typeof(access) == 'string') {
                access = access.split('.');
            }
            if (access.length > 1) {

                var shift = access.shift();
                try {
                    if (obj[shift].type) {
                        if (obj[shift].type == CONSTANTS.PROPERTY.TYPE_PROPERTY_BAG) {
                            if (obj[shift].template) obj[shift].overwritten = true;
                            //obj.properties[shift].hello = true;
                        }
                        if (obj[shift].type == CONSTANTS.PROPERTY.TYPE_ARRAY) {
                            if (obj[shift].template) obj[shift].overwritten = true;
                            //obj.properties[shift].hello = true;
                        }
                    }
                } catch (e) {}

                setValue(obj[shift], access, value);
            } else {

                try {
                    var t = obj[access[0]];
                } catch (e) {
                    throw new NoSuchPropertyException(propertyKey);
                }



                if (obj[access[0]].template) obj[access[0]].overwritten = true;

                obj[access[0]].action = newValue;

                OBJY.chainPermission(obj[access[0]], instance, 'u', 'setEventAction', propertyKey);

                //instance.eventAlterationSequence.push({ operation: 'remove', obj: obj, propName: propertyKey, property: obj[access[0]], date: newValue })
                //instance.eventAlterationSequence.push({ operation: 'add', obj: obj, propName: propertyKey, property: obj[access[0]], date: newValue })
            }
        }

        setValue(obj, propertyKey, newValue);

    },

    ObjectRoleChecker: function(obj, role) {
        switch (role) {
            case 'object':
                return role;
                break;
            case 'template':
                return role;
                break;
            case 'tenant':
                return role;
                break;
            case 'application':
                return role;
                break;
            case 'user':
                obj.username = '';
                obj.password = '';
                return role;
                break;
            default:
                return 'object';
        }
    },

    PropertiesChecker: function(obj, properties, instance) {
        if (properties === undefined) return {};

        obj.properties = {};
        var propertyKeys = Object.keys(properties);
        propertyKeys.forEach(function(property) {
            var propKey = {};
            propKey[property] = properties[property];
            var newProp = propKey;
            new OBJY.PropertyCreateWrapper(obj, newProp, false, instance);
        })
        return obj.properties;
    },

    ApplicationsChecker: function(obj, applications) {
        if (applications === undefined) return [];

        obj.applications = [];
        applications.forEach(function(application) {
            obj.applications.push(application);
        })
        return obj.applications;
    },

    ActionsChecker: function(obj, actions) {
        if (actions === undefined) return {};

        obj.actions = {};
        var actionKeys = Object.keys(actions);
        actionKeys.forEach(function(action) {
            var actionKey = {};
            actionKey[action] = actions[action];
            var newAction = actionKey;
            new OBJY.ActionCreateWrapper(obj, newAction, false);
        })
        return obj.actions;
    },

    TemplatesChecker: function(obj, templates) {
        if (templates === undefined) return [];
        if (typeof templates !== 'object') return [];
        obj.inherits = [];

        templates.forEach(function(template) {
            if (template != obj._id) new OBJY.TemplatesCreateWrapper(obj, template);
        })

        return obj.inherits;
    },


    PrivilegesChecker: function(obj) {

        //obj = JSON.stringify(obj);
        //var nObj = JSON.parse(obj);

        return obj.privileges;
    },

    PrivilegeChecker: function(obj, privilege) {

        if (!typeof privilege == 'object') throw new InvalidPrivilegeException();
        var privilegeKey = Object.keys(privilege)[0];

        if (!obj.privileges[privilegeKey]) {
            obj.privileges[privilegeKey] = [];
        }

        if (obj.privileges[privilegeKey].indexOf(privilege[privilegeKey]) == -1) obj.privileges[privilegeKey].push(privilege[privilegeKey]);

        return privilege;
    },

    PrivilegeRemover: function(obj, privilege) {

        if (!typeof privilege == 'object') throw new InvalidPrivilegeException();
        var privilegeKey = Object.keys(privilege)[0];

        if (!obj.privileges[privilegeKey]) {
            throw new NoSuchPrivilegeException();
        }

        var i;
        for (i = 0; i < obj.privileges[privilegeKey].length; i++) {
            if (obj.privileges[privilegeKey][i].name == privilege[privilegeKey]) obj.privileges[privilegeKey].splice(i, 1);
        }

        if (obj.privileges[privilegeKey].length == 0) {
            delete obj.privileges[privilegeKey];
        }

        return privilege;
    },

    Objs: function(objs, role, instance, params, flags) {
        var self = this;

        if (typeof objs === "object" && !Array.isArray(objs)) {

            var flags = flags || {};

            Object.keys(objs).forEach(function(oK) {
                if (["$page", "$sort"].indexOf(oK) != -1) {
                    flags[oK] = objs[oK];
                    delete objs[oK]
                }
            })

            objs = OBJY.buildAuthroisationQuery(objs, instance.activeUser, 'r', instance.activeApp)

            this.get = function(success, error) {

                var client = instance.activeTenant;
                var app = instance.activeApp;

                var thisRef = this;

                var allCounter = 0;

                OBJY.findObjects(objs, role, function(data) {

                    // success(data);
                    //    return;

                    // TODO : change!!!



                    if (params.templateMode == CONSTANTS.TEMPLATEMODES.STRICT) {

                        success(data);
                        return;
                    }

                    if (data.length == 0) {
                        //console.info(data)

                        success(data);
                        return;
                    }

                    data.forEach(function(d) {

                        d.inherits = d.inherits.filter(function(item, pos) {
                            return d.inherits.indexOf(item) == pos;
                        });

                        //onsole.info(d)
                        var counter = 0;

                        if (d.inherits.length == 0) {
                            allCounter++;
                            if (allCounter == data.length) {

                                success(data);
                                return d;
                            }
                        }


                        d.inherits.forEach(function(template) {


                            if (d._id != template) {

                                OBJY.getTemplateFieldsForObject(d, template, function() {

                                        counter++;

                                        if (counter == d.inherits.length) allCounter++;


                                        // console.info(d.inherits.length, counter, data.length, allCounter)

                                        if (allCounter == data.length) {

                                            success(data);
                                            return d;
                                        }
                                    },
                                    function(err) {
                                        counter++;

                                        if (counter == d.inherits.length) allCounter++;

                                        //console.info(d.inherits.length, counter, data.length, allCounter)

                                        if (allCounter == data.length) {

                                            success(data);
                                            return d;
                                        }

                                    }, client, params.templateFamily)
                            } else {

                                if (d.inherits.length == 1) {

                                    success(data);
                                    return d;
                                } else {
                                    counter++;
                                    return;
                                }

                            }
                        });

                    })

                }, function(err) {
                    error(err)
                }, app, client, flags || {});

            }

            this.count = function(success, error) {

                var client = instance.activeTenant;
                var app = instance.activeApp;

                var thisRef = this;
                var counter = 0;


                OBJY.countObjects(objs, role, function(data) {
                    success(data);

                }, function(err) {
                    error(err)
                }, app, client, flags || {});

                return;
            }


        } else if (Array.isArray(objs)) {

            this.add = function(success, error) {

                var client = instance.activeTenant;
                var app = instance.activeApp;


                var i;
                var allCounter = 0;
                for (i = 0; i < objs.length; i++) {
                    objs[i] = OBJY[role](objs[i]).add(function(data) {

                        if (params.templateMode == CONSTANTS.TEMPLATEMODES.STRICT) {

                            var counter = 0;

                            if (data.inherits.length == 0) {

                                allCounter++;
                                if (allCounter == objs.length) {
                                    success(objs);
                                    return data;
                                }
                            }

                            data.inherits.forEach(function(template) {

                                if (data._id != template) {

                                    OBJY.getTemplateFieldsForObject(data, template, function() {

                                            counter++;

                                            if (counter == data.inherits.length) allCounter++;

                                            //console.info(data.inherits.length, counter, objs.length, allCounter)

                                            if (allCounter == objs.length) {
                                                success(objs);
                                                return data;
                                            }
                                        },
                                        function(err) {
                                            error(err);
                                            return data;
                                        }, client, params.templateFamily)
                                } else {

                                    if (data.inherits.length == 1) {
                                        success(objs);
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
                                success(objs);
                                return data;
                            }
                        }

                    }, function(err) {
                        counter++;
                        if (objs.length == counter) error(err);
                    });
                }
            }

            return this;
        } else {
            this.auth = function(userObj, callback, error) {

                instance[params.pluralName]({
                    username: userObj.username
                }).get(function(data) {

                    if (data.length == 0) error("User not found");
                    callback(data[0])

                }, function(err) {
                    error(err);
                })
            };
        }

    },

    Obj: function(obj, role, instance, params) {

        Logger.log("Plain Object: " + obj);

        if (instance.metaPropPrefix != '' && typeof obj !== "string") obj = OBJY.serialize(obj);

        if (!obj) throw new Error("Invalid param");

        if (obj._id) this._id = obj._id;

        if (typeof obj === "string") {

            this._id = obj;
        }

        if (obj === undefined) obj = {};

        this.role = role || 'object';

        if (params.customProps) {
            for (var prop in params.customProps) {
                this[prop] = params.customProps[prop];
            }
        }

        if (params.customFuncs) {
            for (var func in params.customFuncs) {
                this[func] = params.customFuncs[func];
            }
        }

        if (params.isRule) {
            this.affects = OBJY.AffectsCreateWrapper(this, obj.affects, instance) || {};
        }

        if (!params.structure) {

            this.type = obj.type || null;

            this.applications = OBJY.ApplicationsChecker(this, obj.applications) || [];

            this.inherits = OBJY.TemplatesChecker(this, obj.inherits) || [];


            this.name = obj.name || null;

            this.onCreate = OBJY.ObjectOnCreateCreateWrapper(this, obj.onCreate, instance) || {};
            this.onChange = OBJY.ObjectOnChangeCreateWrapper(this, obj.onChange, instance) || {};
            this.onDelete = OBJY.ObjectOnDeleteCreateWrapper(this, obj.onDelete, instance) || {};

            this.created = obj.created || moment().utc().toDate().toISOString();
            this.lastModified = obj.lastModified || moment().utc().toDate().toISOString();

            this.properties = OBJY.PropertiesChecker(this, obj.properties, instance) || {};

            this.permissions = new OBJY.ObjectPermissionsCreateWrapper(this, obj.permissions) || {};

            this._aggregatedEvents = obj._aggregatedEvents || [];

            /*if (this.role == 'template') {
                this.privileges = obj.privileges;
                this.addPrivilege = obj.addPrivilege;
                this.removePrivilege = obj.removePrivilege;
            }*/

            if (params.authable) {

                this.username = obj.username || null;
                this.email = obj.email || null;
                this.password = obj.password || null;
                this.privileges = OBJY.PrivilegesChecker(obj) || {};
                this.spooAdmin = obj.spooAdmin || false;
                this._clients = obj._clients || [];
                this.authorisations = obj.authorisations || [];

                this.addClient = function(client) {
                    if (this._clients.indexOf(client) != -1) throw new Error('Client ' + client + ' already exists');
                    this._clients.push(client);
                    return this;
                };

                this.removeClient = function(client) {
                    if (this._clients.indexOf(client) == -1) throw new Error('Client ' + client + ' does not exist');
                    this._clients.splice(this._clients.indexOf(client), 1);
                    return this;
                };

                delete this.name;

                this.addPrivilege = function(privilege) {
                    new OBJY.PrivilegeChecker(this, privilege);
                    return this;
                };

                this.setUsername = function(username) {
                    this.username = username;
                    OBJY.chainPermission(this, this, 'o', 'setUsername', username);
                    return this;
                }

                this.setEmail = function(email) {
                    this.email = email;
                    OBJY.chainPermission(this, this, 'h', 'setEmail', email);
                    return this;
                }

                this.setPassword = function(password) {
                    // should be encrypted at this point
                    this.password = password;
                    return this;
                }

                this.removePrivilege = function(privilege) {
                    new OBJY.PrivilegeRemover(this, privilege);
                    return this;
                };

            }

        } else {
            Object.assign(this, params.structure)
        }

        this.addInherit = function(templateId) {
            OBJY.addTemplateToObject(this, templateId, instance);
            return this;
        };

        this.removeInherit = function(templateId, success, error) {
            OBJY.removeTemplateFromObject(this, templateId, function(data) {
                    if (success) success(templateId);
                },
                function(err) {
                    if (error) error(err);
                }, instance);
            return this;
        };

        this.addApplication = function(application) {
            OBJY.addApplicationToObject(this, application, instance);
            return this;
        };

        this.removeApplication = function(application) {
            OBJY.removeApplicationFromObject(this, application, instance);
            return this;
        };

        this.replace = function(newObj) {

            newObj = OBJY[this.role](newObj);

            var self = this;

            Object.keys(this).forEach(function(k) {
                if (self[k] instanceof Function || k == '_id') return;
                delete self[k]
            })

            function doTheProps(self, o) {
                console.log('dtp', o)
                Object.keys(o).forEach(function(k) {

                    if(o[k] == null || o[k] === undefined) return;

                    self[k] = o[k];
                    if (typeof o[k] === 'object') {
                        console.log('typeof', typeof o[k], o[k])
                        doTheProps(self[k], o[k])
                    }

                    if (self[k].template) self[k].overwritten = true;
                })
            }

            console.log('bdtp', newObj)
            doTheProps(self, newObj);

            return self;

            //OBJY.prepareObjectDelta(this, newObj);
        };

        this.addProperty = function(name, property) {

            var prop = {};
            prop[name] = property;
            property = prop;

            var propertyKey = Object.keys(property)[0];
            if (propertyKey.indexOf('.') != -1) {
                var lastDot = propertyKey.lastIndexOf(".");
                var bag = propertyKey.substring(0, lastDot);
                var newProKey = propertyKey.substring(lastDot + 1, propertyKey.length);
                var newProp = {};
                newProp[newProKey] = property[propertyKey];

                this.addPropertyToBag(bag, newProp);

                return;
            }

            new OBJY.PropertyCreateWrapper(this, property, false, instance);

            return this;
        };

        this.setOnChange = function(name, onChangeObj) {

            if (typeof onChangeObj !== 'object') throw new InvalidArgumentException()
            var key = name; //Object.keys(onChangeObj)[0];

            new OBJY.ObjectOnChangeSetWrapper(this, key, onChangeObj.value, onChangeObj.trigger, onChangeObj.type, instance);
            return this;
        };

        this.setOnDelete = function(name, onDeleteObj) {

            if (typeof onDeleteObj !== 'object') throw new InvalidArgumentException()
            var key = name; //Object.keys(onDeleteObj)[0];

            new OBJY.ObjectOnDeleteSetWrapper(this, key, onDeleteObj.value, onDeleteObj.trigger, onDeleteObj.type, instance);
            return this;
        };

        this.setOnCreate = function(name, onCreateObj) {

            if (typeof onCreateObj !== 'object') throw new InvalidArgumentException()
            var key = name; //Object.keys(onCreateObj)[0];

            new OBJY.ObjectOnCreateSetWrapper(this, key, onCreateObj.value, onCreateObj.trigger, onCreateObj.type, instance);
            return this;
        };

        this.removeOnChange = function(name) {
            if (!this.onChange[name]) throw new HandlerNotFoundException(name);
            else delete this.onChange[name];
            return this;
        };

        this.removeOnDelete = function(name) {
            if (!this.onDelete[name]) throw new HandlerNotFoundException(name);
            else delete this.onDelete[name];
            return this;
        };

        this.removeOnCreate = function(name) {
            if (!this.onCreate[name]) throw new HandlerNotFoundException(name);
            else delete this.onCreate[name];
            return this;
        };

        this.setPermission = function(name, permission) {

            var perm = {};
            perm[name] = permission;
            permission = perm;

            new OBJY.ObjectPermissionSetWrapper(this, permission, instance);
            return this;
        };

        this.removePermission = function(permission) {
            new OBJY.ObjectPermissionRemoveWrapper(this, permission, instance);
            return this;
        };

        this.setPropertyValue = function(property, value, client) {

            /*var propertyKey = Object.keys(property)[0];
            if (propertyKey.indexOf('.') != -1) {
                var lastDot = propertyKey.lastIndexOf(".");
                var bag = propertyKey.substring(0, lastDot);
                var newProKey = propertyKey.substring(lastDot + 1, propertyKey.length);
                var newProp = {};
                this.setBagPropertyValue(bag, newProKey, value,  client);
                return;
            }
            new OBJY.ConditionsChecker(this.getProperty(property), value);*/

            new OBJY.PropertySetWrapper(this, property, value, instance, ['addObject']);


            return this;
        };

        this.setProperty = function(property, value, client) {

            /*var propertyKey = Object.keys(property)[0];
            if (propertyKey.indexOf('.') != -1) {
                var lastDot = propertyKey.lastIndexOf(".");
                var bag = propertyKey.substring(0, lastDot);
                var newProKey = propertyKey.substring(lastDot + 1, propertyKey.length);
                var newProp = {};
                this.setBagPropertyValue(bag, newProKey, value,  client);
                return;
            }
            new OBJY.ConditionsChecker(this.getProperty(property), value);*/

            new OBJY.PropertySetFullWrapper(this, property, value, instance, ['addObject']);


            return this;
        };

        this.setEventDate = function(property, value, client) {

            var propertyKey = Object.keys(property)[0];
            if (propertyKey.indexOf('.') != -1) {
                var lastDot = propertyKey.lastIndexOf(".");
                var bag = propertyKey.substring(0, lastDot);
                var newProKey = propertyKey.substring(lastDot + 1, propertyKey.length);
                var newProp = {};
                this.setBagEventDate(bag, newProKey, value, client);
                return;
            }


            new OBJY.EventDateSetWrapper(this, property, value, client, instance);
            return this;
        };

        this.setEventAction = function(property, value, client) {

            var propertyKey = Object.keys(property)[0];
            if (propertyKey.indexOf('.') != -1) {
                var lastDot = propertyKey.lastIndexOf(".");
                var bag = propertyKey.substring(0, lastDot);
                var newProKey = propertyKey.substring(lastDot + 1, propertyKey.length);
                var newProp = {};
                this.setBagEventAction(bag, newProKey, value, client);
                return;
            }

            // new OBJY.ConditionsChecker(this.getProperty(property), value);

            new OBJY.EventActionSetWrapper(this, property, value, client, instance);
            return this;
        };

        this.setEventTriggered = function(property, value, client) {

            var propertyKey = Object.keys(property)[0];
            if (propertyKey.indexOf('.') != -1) {
                var lastDot = propertyKey.lastIndexOf(".");
                var bag = propertyKey.substring(0, lastDot);
                var newProKey = propertyKey.substring(lastDot + 1, propertyKey.length);
                var newProp = {};
                this.setBagEventTriggered(bag, newProKey, value, client);
                return;
            }

            // new OBJY.ConditionsChecker(this.getProperty(property), value);

            new OBJY.EventTriggeredSetWrapper(this, property, value, client, instance);
            return this;
        };

        this.setEventLastOccurence = function(property, value, client) {

            var propertyKey = Object.keys(property)[0];
            if (propertyKey.indexOf('.') != -1) {
                var lastDot = propertyKey.lastIndexOf(".");
                var bag = propertyKey.substring(0, lastDot);
                var newProKey = propertyKey.substring(lastDot + 1, propertyKey.length);
                var newProp = {};
                this.setBagEventLastOccurence(bag, newProKey, value, client);
                return;
            }

            // new OBJY.ConditionsChecker(this.getProperty(property), value);


            new OBJY.EventLastOccurenceSetWrapper(this, property, value, client, ['addObject']);
            return this;
        };

        this.setEventInterval = function(property, value, client) {

            var propertyKey = Object.keys(property)[0];
            if (propertyKey.indexOf('.') != -1) {
                var lastDot = propertyKey.lastIndexOf(".");
                var bag = propertyKey.substring(0, lastDot);
                var newProKey = propertyKey.substring(lastDot + 1, propertyKey.length);
                var newProp = {};
                this.setBagEventInterval(bag, newProKey, value, client);
                return;
            }

            // new OBJY.ConditionsChecker(this.getProperty(property), value);

            new OBJY.EventIntervalSetWrapper(this, property, value, client, instance);
            return this;
        };

        this.addEventReminder = function(property, reminder, client) {

            var propertyKey = Object.keys(property)[0];
            if (propertyKey.indexOf('.') != -1) {
                var lastDot = propertyKey.lastIndexOf(".");
                var bag = propertyKey.substring(0, lastDot);
                var newProKey = propertyKey.substring(lastDot + 1, propertyKey.length);
                var newProp = {};
                this.addBagEventReminder(bag, newProKey, reminder, client);
                return;
            }

            // new OBJY.ConditionsChecker(this.getProperty(property), value);

            new OBJY.EventReminderSetWrapper(this, property, reminder, client, ['addObject']);
            return this;
        };

        this.removeEventReminder = function(propertyName, reminder) {
            if (propertyName.indexOf('.') != -1) {
                this.removeEventReminderFromBag(propertyName, reminder);
                return;
            } else {

                if (!this.properties[propertyName]) throw new NoSuchPropertyException(propertyName);
                if (!this.properties[propertyName].reminders) throw new NoSuchReminderException(reminder); // CHANGE!!!

                try {
                    delete this.properties[propertyName].reminders[reminder];
                } catch (e) {
                    throw new NoSuchReminderException(reminder);
                }

            }

            return this;
        };

        this.pushToArray = function(array, value) {

            var propKey = Object.keys(value)[0];
            var tmpProp = {};
            var tmpName;
            tmpName = shortid.generate();

            tmpProp[tmpName] = value[propKey];

            this.addPropertyToBag(array, tmpProp);
        };

        this.setPropertyPermission = function(property, name, permission) {

            var perm = {};
            perm[name] = permission;
            permission = perm;

            new OBJY.PropertyPermissionSetWrapper(this, property, permission, instance);
            return this;
        };

        this.setPropertyOnCreate = function(property, name, onCreateObj) {

            if (typeof onCreateObj !== 'object') throw new InvalidArgumentException()
            var key = name;

            new OBJY.PropertyOnCreateSetWrapper(this, property, key, onCreateObj.value, onCreateObj.trigger, onCreateObj.type, instance);
            return this;
        };

        this.removePropertyOnCreate = function(propertyName, handlerName) {
            if (propertyName.indexOf('.') != -1) {
                this.removePropertyOnCreateFromBag(propertyName, handlerName);
                return;
            } else {

                if (!this.properties[propertyName]) throw new NoSuchPropertyException(propertyName);
                if (!this.properties[propertyName].onCreate) throw new NoOnCreateException(); // CHANGE!!!
                if (!this.properties[propertyName].onCreate[handlerName]) throw new NoOnCreateException(); // CHANGE!!!
                delete this.properties[propertyName].onCreate[propertyName];
            }

            return this;
        };

        this.removePropertyOnCreateFromBag = function(property, handlerName) {
            var bag = this.getProperty(property);
            if (this.role == 'template') {

            }
            new OBJY.PropertyBagItemOnCreateRemover(this, property, handlerName);
            return this;
        };

        this.removeEventReminderFromBag = function(property, reminder) {
            var bag = this.getProperty(property);
            new OBJY.EventReminderRemover(this, property, reminder);
            return this;
        };

        this.setPropertyMeta = function(property, meta) {
            new OBJY.PropertyMetaSetWrapper(this, property, meta);
            return this;
        };

        this.removePropertyMetaFromBag = function(property) {
            var bag = this.getProperty(property);
            if (this.role == 'template') {

            }
            new OBJY.PropertyBagItemMetaRemover(this, property);
            return this;
        };

        this.removePropertyMeta = function(propertyName) {
            if (propertyName.indexOf('.') != -1) {
                this.removePropertyMetaFromBag(propertyName);
                return;
            } else {

                if (!this.properties[propertyName]) throw new NoSuchPropertyException(propertyName);
                if (!this.properties[propertyName].meta) throw new NoMetaException(); // CHANGE!!!
                delete this.properties[propertyName].meta;
            }

            return this;
        };


        this.setPropertyOnChange = function(property, name, onChangeObj) {

            if (typeof onChangeObj !== 'object') throw new InvalidArgumentException()
            var key = name; //Object.keys(onChangeObj)[0];

            new OBJY.PropertyOnChangeSetWrapper(this, property, key, onChangeObj.value, onChangeObj.trigger, onChangeObj.type, instance);
            return this;
        };

        this.removePropertyOnChange = function(propertyName, name) {
            if (propertyName.indexOf('.') != -1) {
                this.removePropertyOnChangeFromBag(propertyName, name);
                return;
            } else {

                if (!this.properties[propertyName]) throw new NoSuchPropertyException(propertyName);
                if (!this.properties[propertyName].onDelete[name]) throw new HandlerNotFoundException(name); // CHANGE!!!
                delete this.properties[propertyName][name];
            }

            return this;
        };

        this.removePropertyOnChangeFromBag = function(property, name) {
            var bag = this.getProperty(property);

            new OBJY.PropertyBagItemOnChangeRemover(this, property, name);
            return this;
        };

        this.setPropertyOnDelete = function(property, name, onDeleteObj) {

            if (typeof onDeleteObj !== 'object') throw new InvalidArgumentException()
            var key = name; //Object.keys(onDeleteObj)[0];

            new OBJY.PropertyOnDeleteSetWrapper(this, property, key, onDeleteObj.value, onDeleteObj.trigger, onDeleteObj.type, instance);
            return this;
        };

        this.removePropertyOnDelete = function(propertyName, name) {
            if (propertyName.indexOf('.') != -1) {
                this.removePropertyOnDeleteFromBag(propertyName, name);
                return;
            } else {

                if (!this.properties[propertyName]) throw new NoSuchPropertyException(propertyName);
                if (!this.properties[propertyName].onDelete[name]) throw new HandlerNotFoundException(name); // CHANGE!!!
                delete this.properties[propertyName].onDelete[name]
            }

            return this;
        };

        this.removePropertyOnDeleteFromBag = function(property, name) {
            var bag = this.getProperty(property);

            new OBJY.PropertyBagItemOnDeleteRemover(this, property, name);
            return this;
        };



        this.setPropertyConditions = function(property, conditions) {
            var propertyKey = Object.keys(property)[0];
            if (propertyKey.indexOf('.') != -1) {
                var lastDot = propertyKey.lastIndexOf(".");
                var bag = propertyKey.substring(0, lastDot);
                var newProKey = propertyKey.substring(lastDot + 1, propertyKey.length);
                var newProp = {};
                this.setBagPropertyConditions(bag, newProKey, conditions);
                return;
            }
            new OBJY.PropertyConditionsSetWrapper(this, property, conditions);
            return this;
        };

        this.setBagPropertyConditions = function(bag, property, conditions) {
            new OBJY.PropertyConditionsSetWrapper(this.getProperty(bag), property, conditions);
            return this;
        };


        this.setBagPropertyPermission = function(bag, property, permission) {
            new OBJY.PropertyPermissionSetWrapper(this.getProperty(bag), property, permission);
            return this;
        };

        this.setPropertyQuery = function(property, options) {
            var propertyKey = Object.keys(property)[0];
            if (propertyKey.indexOf('.') != -1) {
                var lastDot = propertyKey.lastIndexOf(".");
                var bag = propertyKey.substring(0, lastDot);
                var newProKey = propertyKey.substring(lastDot + 1, propertyKey.length);
                var newProp = {};
                this.setBagPropertyQuery(bag, newProKey, value);
                return;
            }
            new OBJY.PropertyQuerySetWrapper(this, property, options);
            return this;
        };

        this.setPropertyEventInterval = function(property, interval) {
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
        };

        this.removePropertyQuery = function(propertyName) {
            if (propertyName.indexOf('.') != -1) {
                this.removePropertyQueryFromBag(propertyName);
                return;
            } else {

                if (!this.properties[propertyName]) throw new NoSuchPropertyException(propertyName);
                if (!this.properties[propertyName].query) throw new NoSuchPermissionException(permissionKey); // CHANGE!!!
                delete this.properties[propertyName].query;
            }

            return this;
        };

        this.removePropertyQueryFromBag = function(property) {
            var bag = this.getProperty(property);

            new OBJY.PropertyBagItemQueryRemover(this, property);
            return this;
        };

        this.removePropertyConditions = function(propertyName) {
            if (propertyName.indexOf('.') != -1) {
                this.removePropertyConditionsFromBag(propertyName);
                return;
            } else {

                if (!this.properties[propertyName]) throw new NoSuchPropertyException(propertyName);
                if (!this.properties[propertyName].conditions) throw new NoSuchPermissionException(permissionKey); // CHANGE!!!
                delete this.properties[propertyName].conditions;
            }

            return this;
        };

        this.removePropertyConditionsFromBag = function(property) {
            var bag = this.getProperty(property);

            new OBJY.PropertyBagItemConditionsRemover(this, property);
            return this;
        };

        this.setBagPropertyQuery = function(bag, property, options) {
            new OBJY.setBagPropertyQuery(this.getProperty(bag), property, permoptionsission);
            return this;
        };

        this.removePropertyPermission = function(propertyName, permissionKey) {
            if (propertyName.indexOf('.') != -1) {
                this.removePropertyPermissionFromBag(propertyName, permissionKey);
                return;
            } else {
                console.log(permissionKey);
                if (!this.properties[propertyName]) throw new NoSuchPropertyException(propertyName);
                if (!this.properties[propertyName].permissions[permissionKey]) throw new NoSuchPermissionException(permissionKey);

                OBJY.chainPermission(this, instance, 'x', 'removePropertyPermission', permissionKey);


                delete this.properties[propertyName].permissions[permissionKey];
            }

            return this;
        };

        this.setBagPropertyValue = function(bag, property, value, client) {
            new OBJY.PropertySetWrapper(this.getProperty(bag), property, value, instance);
            return this;
        };

        this.setBagEventDate = function(bag, property, value, client) {
            new OBJY.EventDateSetWrapper(this.getProperty(bag), property, value, ['addObject']);
            return this;
        };

        this.setBagEventAction = function(bag, property, value, client) {
            new OBJY.EventActionSetWrapper(this.getProperty(bag), property, value, ['addObject']);
            return this;
        };

        this.setBagEventInterval = function(bag, property, value, client) {
            new OBJY.EventIntervalSetWrapper(this.getProperty(bag), property, value, instance);
            return this;
        };

        this.setBagEventTriggered = function(bag, property, value, client) {
            new OBJY.EventTriggeredSetWrapper(this.getProperty(bag), property, value, ['addObject']);
            return this;
        };

        this.setBagEventLastOccurence = function(bag, property, value, client) {
            new OBJY.EventLastOccurenceSetWrapper(this.getProperty(bag), property, value, ['addObject']);
            return this;
        };

        this.addBagEventReminder = function(bag, property, value, client) {
            new OBJY.EventReminderSetWrapper(this.getProperty(bag), property, value, ['addObject']);
            return this;
        };

        this.addPropertyToBag = function(bag, property) {


            var tmpBag = this.getProperty(bag);
            if (tmpBag.template) tmpBag.overwritten = true;

            new OBJY.PropertyCreateWrapper(tmpBag, property, true, instance);

            return this;
        };

        this.removePropertyFromBag = function(property, client) {
            var bag = this.getProperty(property);

            new OBJY.PropertyBagItemRemover(this, property, instance);
            return this;
        };

        this.removePropertyPermissionFromBag = function(property, permissionKey) {
            var bag = this.getProperty(property);

            new OBJY.PropertyBagItemPermissionRemover(this, property, permissionKey, instance);
            return this;
        };

        this.removeProperty = function(propertyName, client) {


            if (propertyName.indexOf('.') != -1) {
                this.removePropertyFromBag(propertyName, client);
                return;
            } else {
                if (!this.properties[propertyName]) throw new NoSuchPropertyException(propertyName);

                var tmpProp = Object.assign({}, this.properties[propertyName]);

                if (tmpProp.onDelete) {
                    if (Object.keys(tmpProp.onDelete).length > 0) {
                        if (!instance.handlerSequence[this._id]) instance.handlerSequence[this._id] = {};
                        if (!instance.handlerSequence[this._id].onDelete) instance.handlerSequence[this._id].onDelete = [];
                        instance.handlerSequence[this._id].onDelete.push({
                            handler: tmpProp.onDelete,
                            prop: tmpProp
                        });
                    }
                }

                OBJY.chainPermission(this.properties[propertyName], instance, 'd', 'removeProperty', propertyName);

                if (this.properties[propertyName].type == 'date') instance.eventAlterationSequence.push({
                    operation: 'remove',
                    obj: this,
                    propName: propertyName,
                    date: date
                })

                delete this.properties[propertyName];

            }

            return this;
        };


        this.getId = function() {
            return this._id;
        };

        this.getName = function() {
            return this.name;
        };

        this.setName = function(name) {
            this.name = name;

            OBJY.chainPermission(this, instance, 'n', 'setName', name);

            return this;
        };

        this.setType = function(type) {
            this.type = type;
            OBJY.chainPermission(this, instance, 't', 'setType', type);
            return this;
        };

        this.getType = function() {
            return this.type;
        };

        this.getRef = function(propertyName) {
            return new OBJY.PropertyRefParser(this, propertyName);
        };

        this.getProperty = function(propertyName) {
            //return this.properties[propertyName];
            return OBJY.PropertyParser(this, propertyName);
        };

        this.getProperties = function() {
            return this.properties;
        };

        this.add = function(success, error, client) {

            var client = client || instance.activeTenant;
            var app = instance.activeApp;

            var thisRef = this;

            OBJY.checkAuthroisations(this, instance.activeUser, "c", instance.activeApp);

            Object.keys(thisRef.onCreate).forEach(function(key) {

                if (thisRef.onCreate[key].trigger == 'before' || !thisRef.onCreate[key].trigger) {

                    //dsl, obj, prop, data, callback, client, options
                    instance.execProcessorAction(thisRef.onCreate[key].value, thisRef, null, null, function(data) {

                    }, client, null);
                }
            })

            this.created = moment().utc().toDate().toISOString();
            this.lastModified = moment().utc().toDate().toISOString();

            var thisRef = this;

            thisRef._aggregatedEvents = [];

            function aggregateAllEvents(props, prePropsString) {

                Object.keys(props).forEach(function(p) {

                    if (props[p].type == CONSTANTS.PROPERTY.TYPE_PROPERTY_BAG){
                        if (prePropsString) {
                            aggregateAllEvents(props[p].properties, prePropsString + "." + p)
                        }
                    }
                    else if(typeof props[p] == 'object') {
                        aggregateAllEvents(props[p], p)
                    }

                    if (props[p].type == CONSTANTS.PROPERTY.TYPE_EVENT) {

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
                                propName: prePropsString + "." + p,
                                property: props[p],
                                date: date
                            })

                            var found = false;
                            thisRef._aggregatedEvents.forEach(function(aE) {
                                if (aE.propName == prePropsString + "." + p) found = true;
                            })

                            if (!found && props[p].triggered != true)
                                //if(moment().toISOString() >= moment(date).toISOString()) 
                                thisRef._aggregatedEvents.push({
                                    propName: prePropsString + "." + p,
                                    date: date
                                });

                        } else {

                            instance.eventAlterationSequence.push({
                                operation: 'add',
                                obj: thisRef,
                                propName: p,
                                property: props[p],
                                date: date
                            })

                            var found = false;
                            thisRef._aggregatedEvents.forEach(function(aE) {
                                if (aE.propName == p) found = true;
                            })

                            if (!found && props[p].triggered != true)
                                //if(moment().toISOString() >= moment(date).toISOString()) 
                                thisRef._aggregatedEvents.push({
                                    propName: p,
                                    date: date
                                });
                        }
                    }

                })
            }

            var mapper = instance.observers[thisRef.role];

            if (this.properties) aggregateAllEvents(this.properties);

            if (!this._id) this._id = OBJY.ID();

            if (app)
                if (this.applications.indexOf(app) == -1) this.applications.push(app);

            var addFn = function(obj) {
                OBJY.add(obj, function(data) {

                        obj._id = data._id;

                        Object.keys(data.onCreate || {}).forEach(function(key) {
                            if (data.onCreate[key].trigger == 'after') {
                                //dsl, obj, prop, data, callback, client, options
                                instance.execProcessorAction(data.onCreate[key].value, data, null, null, function(data) {

                                }, client, null);
                            }
                        })

                        if (mapper.type == 'scheduled') {

                            instance.eventAlterationSequence.forEach(function(evt) {

                                if (evt.operation == 'add') {
                                    mapper.addEvent(obj._id, evt.propName, evt.property, function(evtData) {

                                    }, function(evtErr) {

                                    }, instance.activeTenant)
                                } else if (evt.operation == 'remove') {
                                    mapper.removeEvent(obj._id, evt.propName, function(evtData) {

                                    }, function(evtErr) {

                                    }, instance.activeTenant)
                                }

                            })
                        }

                        instance.eventAlterationSequence = [];

                        Logger.log("Added Object: " + JSON.stringify(data, null, 2));

                        success(OBJY.deserialize(data));

                        delete thisRef.instance;

                    },
                    function(err) {
                        error(err);
                    }, app, client);
            }


            if (params.templateMode == CONSTANTS.TEMPLATEMODES.STRICT) {

                if (this.inherits.length == 0) addFn(thisRef);

                var counter = 0;
                this.inherits.forEach(function(template) {

                    if (thisRef._id != template) {

                        OBJY.getTemplateFieldsForObject(thisRef, template, function() {
                                counter++;
                                if (counter == thisRef.inherits.length) {

                                    addFn(thisRef)
                                    return this;
                                }
                            },
                            function(err) {

                                error(thisRef);
                                return this;
                            }, client, params.templateFamily)
                    }
                });

            } else {

                addFn(thisRef);
            }
            return OBJY.deserialize(this);
        };



        this.update = function(success, error, client) {

            var client = client || instance.activeTenant;
            var app = instance.activeApp;

            OBJY.checkAuthroisations(this, instance.activeUser, "u", instance.activeApp);

            var thisRef = this;

            OBJY.checkPermissions(instance.activeUser, instance.activeApp, thisRef, 'u')

            if ((instance.permissionSequence[thisRef._id] || []).length > 0) {
                throw new LackOfPermissionsException(instance.permissionSequence[thisRef._id]);
            }

            Object.keys(thisRef.onChange || {}).forEach(function(key) {
                if (thisRef.onChange[key].trigger == 'before') {
                    instance.execProcessorAction(thisRef.onChange[key].action, thisRef, null, null, function(data) {

                    }, client, null);
                }
            })

            if (instance.handlerSequence[this._id]) {
                for (var type in instance.handlerSequence[this._id]) {
                    for (var item in instance.handlerSequence[this._id][type]) {
                        var handlerObj = instance.handlerSequence[this._id][type][item];

                        for (var handlerItem in handlerObj.handler) {
                            if (handlerObj.handler[handlerItem].trigger == 'before') {
                                instance.execProcessorAction(handlerObj.handler[handlerItem].action, thisRef, handlerObj.prop, null, function(data) {

                                }, client, null);
                            }
                        }
                    }
                }
            }


            this.lastModified = moment().toDate().toISOString();

            var thisRef = this;

            thisRef._aggregatedEvents = [];

            function aggregateAllEvents(props, prePropsString) {

                Object.keys(props).forEach(function(p) {
                     if (props[p].type == CONSTANTS.PROPERTY.TYPE_PROPERTY_BAG){
                        if (prePropsString) {
                            aggregateAllEvents(props[p].properties, prePropsString + "." + p)
                        }
                    }
                    else if(typeof props[p] == 'object') {
                        aggregateAllEvents(props[p], p)
                    }

                    console.log('88', props[p])
                    if (props[p].type == CONSTANTS.PROPERTY.TYPE_EVENT) {

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

                            instance.eventAlterationSequence.push({ operation: 'remove', obj: thisRef, propName: prePropsString + "." + p, date: date });

                            var found = false;
                            thisRef._aggregatedEvents.forEach(function(aE) {
                                if (aE.propName == prePropsString + "." + p) found = true;
                            })

                            if (!found && props[p].triggered != true)
                                //if(moment().toISOString() >= moment(date).toISOString())
                                thisRef._aggregatedEvents.push({
                                    propName: prePropsString + "." + p,
                                    date: date
                                });

                        } else {

                        instance.eventAlterationSequence.push({ operation: 'remove', obj: thisRef, propName: p, date: date })

                            var found = false;
                            thisRef._aggregatedEvents.forEach(function(aE) {
                                if (aE.propName == p) found = true;
                            })

                            if (!found && props[p].triggered != true)
                                //if(moment().toISOString() >= moment(date).toISOString())
                                thisRef._aggregatedEvents.push({
                                    propName: p,
                                    date: date
                                });
                        }
                    }

                })
            }

            var mapper = instance.observers[thisRef.role];

            if (this.properties) aggregateAllEvents(this.properties);

            function updateFn() {

                OBJY.updateO(thisRef, function(data) {

                        Object.keys(data.onChange || {}).forEach(function(key) {
                            if (data.onChange[key].trigger == 'after') {
                                //dsl, obj, prop, data, callback, client, options
                                instance.execProcessorAction(data.onChange[key].action, data, null, null, function(data) {

                                }, client, null);
                            }
                        })

                        if (instance.handlerSequence[this._id]) {
                            for (var type in instance.handlerSequence[this._id]) {
                                for (var item in instance.handlerSequence[this._id][type]) {
                                    var handlerObj = instance.handlerSequence[this._id][type][item];

                                    for (var handlerItem in handlerObj.handler) {
                                        if (handlerObj.handler[handlerItem].trigger == 'after') {
                                            instance.execProcessorAction(handlerObj.handler[handlerItem].action, thisRef, handlerObj.prop, null, function(data) {

                                            }, client, null);
                                        }
                                    }
                                }
                            }
                        }

                        delete instance.handlerSequence[this._id];


                        if (mapper.type == 'scheduled') {
                            instance.eventAlterationSequence.forEach(function(evt) {
                                

                                /*if (evt.type == 'add') {
                                    mapper.addEvent(this._id, evt.propName, evt.property, function(evtData) {

                                    }, function(evtErr) {

                                    }, instance.activeTenant)
                                }*/


                                if (evt.operation == 'add') {
                                mapper.addEvent(data._id, evt.propName, evt.property, function(evtData) {

                                }, function(evtErr) {

                                }, instance.activeTenant)
                            } else if (evt.operation == 'remove') {
                                mapper.removeEvent(data._id, evt.propName, function(evtData) {

                                }, function(evtErr) {
                                    console.log(evtErr);
                                }, instance.activeTenant)
                            }

                            })
                        }

                        instance.eventAlterationSequence = [];

                        if (params.templateMode == CONSTANTS.TEMPLATEMODES.STRICT) {
                            OBJY.updateInheritedObjs(thisRef, params.pluralName, function(data) {

                            }, function(err) {

                            }, client, params)
                        }

                        Logger.log("Updated Object: " + data);

                        if (success) success(OBJY.deserialize(data));

                    },
                    function(err) {
                        if (error) error(err);
                    }, app, client);

            }


            if (instance.commandSequence.length > 0 && params.templateMode == CONSTANTS.TEMPLATEMODES.STRICT) {

                var found = false;
                var foundCounter = 0;
                instance.commandSequence.forEach(function(i) {
                    if (i.name == 'addInherit' || i.name == 'removeInherit') {
                        foundCounter++;
                        found = true;
                    }
                })

                if (foundCounter == 0) updateFn(thisRef);

                var execCounter = 0;
                instance.commandSequence.forEach(function(i) {


                    if (i.name == 'addInherit' && thisRef.inherits.indexOf(i.value) != -1) {
                        execCounter++;

                        OBJY.getTemplateFieldsForObject(thisRef, i.value, function() {

                                if (execCounter == foundCounter) {
                                    updateFn(thisRef);
                                }
                            },
                            function(err) {
                                error(thisRef);
                                return thisRef;
                            }, client, params.templateFamily)
                    }

                    if (i.name == 'removeInherit' && thisRef.inherits.indexOf(i.value) == -1) {

                        execCounter++;
                        OBJY.removeTemplateFieldsForObject(thisRef, i.value, function() {

                                if (execCounter == foundCounter) {
                                    updateFn(thisRef);
                                }
                            },
                            function(err) {
                                error(thisRef);
                                return thisRef;
                            }, client)
                    }
                })

            } else updateFn(thisRef);

            instance.commandSequence = [];

            return OBJY.deserialize(this);
        };

        this.remove = function(success, error, client) {

            var client = client || instance.activeTenant;
            var app = instance.activeApp;

            OBJY.checkAuthroisations(this, instance.activeUser, "d", instance.activeApp);

            var thisRef = JSON.parse(JSON.stringify(this));

            OBJY.checkPermissions(instance.activeUser, instance.activeApp, thisRef, 'd');

            Object.keys(thisRef.onDelete || {}).forEach(function(key) {
                if (thisRef.onDelete[key].trigger == 'before') {
                    //dsl, obj, prop, data, callback, client, options
                    instance.execProcessorAction(thisRef.onDelete[key].action, thisRef, null, null, function(data) {

                    }, client, null);
                }
            })

            OBJY.getObjectById(this.role, this._id, function(data) {

                return OBJY.remove(thisRef, function(_data) {

                    Object.keys(thisRef.onDelete || {}).forEach(function(key) {
                        if (thisRef.onDelete[key].trigger == 'after') {

                            instance.execProcessorAction(thisRef.onDelete[key].action, thisRef, null, null, function(data) {

                            }, client, null);
                        }
                    })

                    function aggregateAllEvents(props, prePropsString) {

                        Object.keys(props || {}).forEach(function(p) {
                             if (props[p].type == CONSTANTS.PROPERTY.TYPE_PROPERTY_BAG){
                                    if (prePropsString) {
                                        aggregateAllEvents(props[p].properties, prePropsString + "." + p)
                                    }
                                }
                                else if(typeof props[p] == 'object') {
                                    aggregateAllEvents(props[p], p)
                                }

                            if (props[p].type == CONSTANTS.PROPERTY.TYPE_EVENT) {

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
                                        propName: prePropsString + "." + p,
                                        date: date
                                    });

                                    var found = false;

                                } else {

                                    instance.eventAlterationSequence.push({
                                        operation: 'remove',
                                        obj: thisRef,
                                        propName: p,
                                        date: date
                                    })

                                }
                            }
                        })
                    }

                    var mapper = instance.observers[thisRef.role];


                    aggregateAllEvents(data.properties || {});


                    if (mapper.type == 'scheduled') {

                        instance.eventAlterationSequence.forEach(function(evt) {

                            if (evt.operation == 'add') {
                                mapper.addEvent(data._id, evt.propName, evt.property, function(evtData) {

                                }, function(evtErr) {

                                }, instance.activeTenant)
                            } else if (evt.operation == 'remove') {
                                mapper.removeEvent(data._id, evt.propName, function(evtData) {

                                }, function(evtErr) {
                                    console.log(evtErr);
                                }, instance.activeTenant)
                            }
                        })
                    }

                    if (params.templateMode == CONSTANTS.TEMPLATEMODES.STRICT) {

                        OBJY.removeInheritedObjs(thisRef, params.pluralName, function(data) {

                        }, function(err) {

                        }, client, params);

                    }

                    Logger.log("Removed Object: " + data);

                    success(OBJY.deserialize(data));


                }, function(err) {
                    error(err)
                }, app, client);


            }, function(err) {
                error(err)
            }, app, client);

            return OBJY.deserialize(this);
        };

        this.get = function(success, error, dontInherit) {

            var client = instance.activeTenant;
            var app = instance.activeApp;

            OBJY.checkAuthroisations(this, instance.activeUser, "r", instance.activeApp);

            var thisRef = this;
            var counter = 0;

            function arrayDeserialize(obj, parentArray) {

                if (obj.properties) {
                    var propsArray = [];
                    var propertyKeys = Object.keys(obj.properties);
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

            }


            function prepareObj(data) {

                OBJY.checkPermissions(instance.activeUser, instance.activeApp, data, 'r')

                if (dontInherit) {
                    success(OBJY[data.role](OBJY.deserialize(data)));
                    return data;
                }

                if (params.templateMode == CONSTANTS.TEMPLATEMODES.STRICT) {
                    success(OBJY[data.role](OBJY.deserialize(data)));
                    return data;
                }

                if ((data.inherits || []).length == 0) {
                    success(OBJY[data.role](OBJY.deserialize(data)));
                    return data;
                }


                data.inherits.forEach(function(template) {

                    if (data._id != template) {

                        OBJY.getTemplateFieldsForObject(data, template, function() {

                                counter++;

                                if (counter == data.inherits.length) {

                                    success(OBJY[data.role](OBJY.deserialize(data)));
                                    return data;
                                }
                            },
                            function(err) {

                                counter++;


                                if (counter == data.inherits.length) {
                                    success(OBJY[data.role](OBJY.deserialize(data)));
                                    return data;
                                }
                            }, client, params.templateFamily)
                    } else {

                        if (thisRef.inherits.length == 1) {
                            success(OBJY[data.role](OBJY.deserialize(data)));
                            return data;
                        } else {
                            counter++;
                            return;
                        }
                    }
                });
            }

            //console.warn('cccache', thisRef._id, instance.caches[thisRef.role].data[thisRef._id])
            if (instance.caches[thisRef.role].data[thisRef._id]) {
                prepareObj(instance.caches[thisRef.role].data[thisRef._id]);
            } else {

                OBJY.getObjectById(thisRef.role, thisRef._id, function(data) {

                    prepareObj(data);

                    if (!instance.caches[thisRef.role].data[thisRef._id]) {
                        //console.warn('writing to cache', thisRef._id, data)
                        //instance.caches[thisRef.role].add(thisRef._id, data);
                    }

                }, function(err) {
                    error(err)
                }, app, client);
            }

            return OBJY.deserialize(this);
        }
    },

    hello: function() {
        Logger.log("Hello from OBJY!");
    }
}

if (_nodejs) module.exports = OBJY;
else if (window) window.OBJY = OBJY;