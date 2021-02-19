var CONSTANTS = require('../lib/dependencies/constants.js')
var moment = require('moment');
var exceptions = require('../lib/dependencies/exceptions.js')

module.exports = function(OBJY) {
    return {

        PropertyRefParser: function(obj, propertyName, success, error) {
            var allProperties = obj.getProperties();

            try {
                propertyToReturn = allProperties[propertyName];
            } catch (e) {

            }

            if (!propertyToReturn) throw new exceptions.PropertyNotFoundException(propertyName);

            if (!propertyToReturn.type == 'objectRef') throw new exceptions.PropertyNotFoundException(propertyName);


            return OBJY.getObjectByIdSyn(propertyToReturn.value);

        },

        EventParser: function(obj, eventName) {

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
                        throw new exceptions.NoSuchEventException(propertyName);
                    }

                    eventToReturn = obj.events[access[0]];
                }
            }

            getValue(obj, eventName);

            return eventToReturn;

        },


        PropertyBagItemQueryRemover: function(obj, propertyName) {

            function removeQuery(obj, access) {
                if (typeof(access) == 'string') {
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


        PropertyBagItemConditionsRemover: function(obj, propertyName) {

            function removeConditions(obj, access) {
                if (typeof(access) == 'string') {
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


        PropertyBagItemOnChangeRemover: function(obj, propertyName, name) {

            function removeOnChange(obj, access) {
                if (typeof(access) == 'string') {
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

        PropertyBagItemMetaRemover: function(obj, propertyName) {

            var thisRef = this;

            var propertyToReturn;

            function removeOnChange(obj, access) {
                if (typeof(access) == 'string') {
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

        PropertyBagItemOnCreateRemover: function(obj, propertyName, handlerName) {

            function removeOnCreate(obj, access) {
                if (typeof(access) == 'string') {
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

        PropertyBagItemOnDeleteRemover: function(obj, propertyName, name) {

            function removeOnDelete(obj, access) {
                if (typeof(access) == 'string') {
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

        PropertyBagItemPermissionRemover: function(obj, propertyName, permissionKey, instance) {

            function removePermission(obj, access) {
                if (typeof(access) == 'string') {
                    access = access.split('.');
                }
                if (access.length > 1) {
                    removePermission(obj[access.shift()], access);
                } else {

                    if (!obj.hasOwnProperty(access[0])) throw new exceptions.NoSuchPropertyException(propertyName);

                    if (!obj[access[0]].permissions) throw new exceptions.NoSuchPermissionException(permissionKey);
                    if (!obj[access[0]].permissions[permissionKey]) throw new exceptions.NoSuchPermissionException(permissionKey);

                    OBJY.chainPermission(obj, instance, 'x', 'removePropertyPermission', propertyName)

                    delete obj[access[0]].permissions[permissionKey];
                    return;
                }
            }

            removePermission(obj, propertyName);

        },

        PropertyBagItemRemover: function(obj, propertyName, instance) {

            function getValue(obj, access) {
                if (typeof(access) == 'string') {
                    access = access.split('.');
                }
                if (access.length > 1) {
                    getValue(obj[access.shift()], access);
                } else {

                    if (!obj.hasOwnProperty(access[0])) throw new exceptions.NoSuchPropertyException(propertyName);

                    if (obj[access[0]].onDelete) {
                        if (Object.keys(obj[access[0]].onDelete).length > 0) {
                            if (!instance.handlerSequence[obj._id]) instance.handlerSequence[obj._id] = {};
                            if (!instance.handlerSequence[obj._id].onDelete) instance.handlerSequence[obj._id].onDelete = [];
                            instance.handlerSequence[obj._id].onDelete.push(obj[access[0]].onDelete);
                        }
                    }


                    OBJY.chainPermission(obj[access[0]], instance, 'd', 'removeProperty', propertyName);

                    delete obj[access[0]];

                    return;
                }
            }

            getValue(obj, propertyName);

        },

        PropertyParser: function(obj, propertyName, instance, params) {
            var thisRef = this;

            var propertyToReturn;

            function getValue(obj, access) {
                var propsObj = obj[params.propsObject] || obj;

                if (typeof(access) == 'string') {
                    access = access.split('.');
                }
                if (access.length > 1) {
                    getValue(propsObj[access.shift()], access);
                } else {

                    if (!propsObj.hasOwnProperty(access[0])) throw new exceptions.NoSuchPropertyException(propertyName);

                    propertyToReturn = propsObj[access[0]];
                }
            }

            getValue(obj, propertyName);


            if (propertyToReturn.type == "action") {
                propertyToReturn.call = function(callback, client) {
                    OBJY.checkAuthroisations(obj, instance.activeUser, "x", instance.activeApp);
                    thisRef.execProcessorAction(propertyToReturn.value || propertyToReturn.action, obj, propertyToReturn, {}, callback, client, {});
                }
            }

            return propertyToReturn;

        },


        ValuePropertyMetaSubstituter: function(property) {
            if (typeof property !== 'undefined')
                if (typeof property.value === 'undefined') property.value = null;
        },


        PropertyCreateWrapper: function(obj, property, isBag, instance, params) {

            if (params.propsObject && !obj[params.propsObject]) obj[params.propsObject] = {};

            property = Object.assign({}, property);

            var propsObj = obj[params.propsObject] || obj;


            var propertyKey = Object.keys(property)[0];
            var existing = null;

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

            if(propsObj.hasOwnProperty(propertyKey) && !OBJY.predefinedProperties.includes(propertyKey)) throw new exceptions.DuplicatePropertyException(propertyKey);

            switch ((property[propertyKey] || {}).type) {
                case undefined:
                    propsObj[propertyKey] = property[propertyKey];
                    break;

                case CONSTANTS.PROPERTY.TYPE_SHORTTEXT:
                    propsObj[propertyKey] = property[propertyKey];
                    OBJY.ValuePropertyMetaSubstituter(propsObj[propertyKey]);
                    break;

                case CONSTANTS.PROPERTY.TYPE_LONGTEXT:
                    propsObj[propertyKey] = property[propertyKey];
                    OBJY.ValuePropertyMetaSubstituter(propsObj[propertyKey]);
                    break;

                case CONSTANTS.PROPERTY.TYPE_INDEXEDTEXT:
                    propsObj[propertyKey] = property[propertyKey];
                    OBJY.ValuePropertyMetaSubstituter(propsObj[propertyKey]);
                    break;

                case CONSTANTS.PROPERTY.TYPE_JSON:
                    if (property[propertyKey].value) {
                        if (typeof property[propertyKey].value === 'string') {
                            try {
                                propsObj[propertyKey].value = JSON.parse(propsObj[propertyKey].value);
                            } catch (e) {
                                //throw new exceptions.InvalidValueException(property[propertyKey].value, CONSTANTS.PROPERTY.TYPE_JSON);
                            }
                        } else {

                        }
                    }
                    propsObj[propertyKey] = property[propertyKey];
                    OBJY.ValuePropertyMetaSubstituter(propsObj[propertyKey]);
                    break;

                case CONSTANTS.PROPERTY.TYPE_NUMBER:
                    if (property[propertyKey].value != '') {
                        if (property[propertyKey].value != null)
                            if (isNaN(property[propertyKey].value)) throw new exceptions.InvalidValueException(property[propertyKey].value, CONSTANTS.PROPERTY.TYPE_NUMBER);
                    }
                    property[propertyKey].value = +property[propertyKey].value;
                    propsObj[propertyKey] = property[propertyKey];
                    OBJY.ValuePropertyMetaSubstituter(propsObj[propertyKey]);
                    break;

                case CONSTANTS.PROPERTY.TYPE_EVENT:

                    OBJY.chainPermission(obj, instance, 'evt', 'addProperty (Event)', propertyKey);

                    var _event = {};
                    var eventKey = propertyKey;
                    _event[eventKey] = property[propertyKey];

                    if (!_event[eventKey].eventId) _event[eventKey].eventId = OBJY.ID();

                    if (!_event[eventKey].reminders) _event[eventKey].reminders = {};


                    if (_event[eventKey].interval !== undefined) {

                        if (_event[eventKey].lastOccurence == undefined) _event[eventKey].lastOccurence = null;
                        else if (!moment(_event[eventKey].lastOccurence).isValid()) throw new exceptions.InvalidDateException(_event[eventKey].lastOccurence);
                        else _event[eventKey].lastOccurence = moment(_event[eventKey].lastOccurence).utc().format();


                        if (_event[eventKey].nextOccurence == undefined)
                            _event[eventKey].nextOccurence = moment().toISOString();

                        if (_event[eventKey].action === undefined) _event[eventKey].action = '';


                        if (_event[eventKey].interval === undefined) throw new exceptions.MissingAttributeException('interval');

                        _event[eventKey].nextOccurence = moment(_event[eventKey].lastOccurence || moment().utc()).utc().add(_event[eventKey].interval).toISOString();

                        instance.eventAlterationSequence.push({
                            operation: 'add',
                            obj: obj,
                            propName: propertyKey,
                            property: property,
                            date: _event[eventKey].nextOccurence
                        })


                    } else if (_event[eventKey].date !== undefined) {

                        if (_event[eventKey].date == null) _event[eventKey].date = moment().utc().toISOString();

                        if (!_event[eventKey].date) throw new exceptions.MissingAttributeException('date');

                        try {
                            _event[eventKey].date = moment(_event[eventKey].date).utc().format();
                        } catch (e) {

                        }

                        instance.eventAlterationSequence.push({
                            operation: 'add',
                            obj: obj,
                            propName: propertyKey,
                            property: property,
                            date: _event[eventKey].date
                        })

                        if (!_event[eventKey].action) _event[eventKey].action = '';
                    } else {
                        //throw new exceptions.InvalidTypeException("No interval or date provided");
                    }

                    propsObj[propertyKey] = _event[eventKey];
                    break;

                case CONSTANTS.PROPERTY.TYPE_DATE:
                    if (!property[propertyKey].value || property[propertyKey].value == '') property[propertyKey].value = null;
                    //else property[propertyKey].value = property[propertyKey];
                    propsObj[propertyKey] = property[propertyKey];
                    OBJY.ValuePropertyMetaSubstituter(propsObj[propertyKey]);
                    break;


                case CONSTANTS.PROPERTY.TYPE_SHORTID:
                    if (!property[propertyKey].value || property[propertyKey].value == '') property[propertyKey].value = OBJY.RANDOM();
                    if (obj.role == 'template') property[propertyKey].value = null;
                    propsObj[propertyKey] = property[propertyKey];
                    OBJY.ValuePropertyMetaSubstituter(propsObj[propertyKey]);
                    break;

                case CONSTANTS.PROPERTY.TYPE_REF_OBJ:


                    // FOR NOW: no checking for existing object, since callback!!!
                    propsObj[propertyKey] = property[propertyKey];
                    OBJY.ValuePropertyMetaSubstituter(propsObj[propertyKey]);
                    break;

                case CONSTANTS.PROPERTY.TYPE_REF_USR:



                    // FOR NOW: no checking for existing object, since callback!!!
                    propsObj[propertyKey] = property[propertyKey];
                    OBJY.ValuePropertyMetaSubstituter(propsObj[propertyKey]);
                    break;

                case CONSTANTS.PROPERTY.TYPE_REF_FILE:



                    // FOR NOW: no checking for existing object, since callback!!!
                    propsObj[propertyKey] = property[propertyKey];
                    OBJY.ValuePropertyMetaSubstituter(propsObj[propertyKey]);
                    break;

                case CONSTANTS.PROPERTY.TYPE_PROPERTY_BAG:

                    if (!property[propertyKey].properties) property[propertyKey].properties = {};

                    var innerProperties = property[propertyKey][params.propsObject] || property[propertyKey];

                    var propertyKeys = Object.keys(innerProperties);

                    parentProp = property;

                    propsObj[propertyKey] = property[propertyKey];
                    propsObj[propertyKey].type = CONSTANTS.PROPERTY.TYPE_PROPERTY_BAG;
                    propsObj[propertyKey].properties = {};

                    propertyKeys.forEach(function(property) {
                        tmpProp = {};
                        tmpProp[property] = innerProperties[property];

                        new OBJY.PropertyCreateWrapper(propsObj[propertyKey], Object.assign({}, tmpProp), true, instance, params);
                    })

                    break;

                case CONSTANTS.PROPERTY.TYPE_ARRAY:

                    if (!property[propertyKey].properties) property[propertyKey].properties = {};

                    var innerProperties = property[propertyKey][params.propsObject] || property[propertyKey];

                    var propertyKeys = Object.keys(innerProperties);

                    parentProp = property;

                    propsObj[propertyKey] = {
                        type: CONSTANTS.PROPERTY.TYPE_ARRAY,
                        properties: {},
                        query: property[propertyKey].query,
                        meta: property[propertyKey].meta
                    };


                    propertyKeys.forEach(function(property) {
                        tmpProp = {};
                        tmpProp[property] = innerProperties[property];

                        new OBJY.PropertyCreateWrapper(propsObj[propertyKey], Object.assign({}, tmpProp), true, instance, params);
                    })

                    break;

                case CONSTANTS.PROPERTY.TYPE_BOOLEAN:
                    if (!typeof property[propertyKey].value === 'boolean') throw new exceptions.InvalidValueException(property[propertyKey].value, CONSTANTS.PROPERTY.TYPE_BOOLEAN);
                    propsObj[propertyKey] = property[propertyKey];
                    OBJY.ValuePropertyMetaSubstituter(propsObj[propertyKey]);
                    break;

                case CONSTANTS.PROPERTY.TYPE_ACTION:

                    OBJY.chainPermission(obj, instance, 'act', 'addProperty (Action)', propertyKey);

                    if (property[propertyKey].value) {
                        if (typeof property[propertyKey].value !== 'string') throw new exceptions.InvalidValueException(property[propertyKey].value, CONSTANTS.PROPERTY.TYPE_ACTION);
                    }

                    propsObj[propertyKey] = property[propertyKey];
                    OBJY.ValuePropertyMetaSubstituter(obj.properties[propertyKey]);
                    break;

                default:
                    throw new exceptions.InvalidTypeException(property[propertyKey].type);
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



        PropertyQuerySetWrapper: function(obj, propertyKey, query, params) {

            function setValue(obj, access, value) {
                var propsObj = obj[params.propsObject] || obj;

                if (typeof(access) == 'string') {
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

            setValue(obj, propertyKey, query);
        },



        PropertyMetaSetWrapper: function(obj, propertyKey, meta, params) {
            
            function setMeta(obj, access, meta) {
                var propsObj = obj[params.propsObject] || obj;
                if (typeof(access) == 'string') {
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

            setMeta(obj, propertyKey, meta);
        },


        PropertyOnChangeSetWrapper: function(obj, propertyKey, name, onChange, trigger, type, instance, params) {
            function setOnChange(obj, access, onChange) {
                var propsObj = obj[params.propsObject] || obj;
                if (typeof(access) == 'string') {
                    access = access.split('.');
                }
                if (access.length > 1) {
                    setOnChange(propsObj[access.shift()], access, onChange);
                } else {

                    if (!propsObj.hasOwnProperty(access[0])) throw new exceptions.NoSuchPropertyException(propertyKey);

                    //if (!obj[access[0]].on) obj[access[0]].on = {};

                    if (!propsObj[access[0]].onChange) propsObj[access[0]].onChange = {}

                    if (!propsObj[access[0]].onChange[name]) propsObj[access[0]].onChange[name] = {}

                    if (propsObj[access[0]].onChange[name].template) propsObj[access[0]].onChange[name].overwritten = true;
                    propsObj[access[0]].onChange[name].value = onChange;
                    propsObj[access[0]].onChange[name].trigger = trigger || 'after';
                    propsObj[access[0]].onChange[name].type = type || 'async';

                    OBJY.chainPermission(propsObj[access[0]], instance, 'w', 'setPropertyOnChangeHandler', name);
                }
            }

            setOnChange(obj, propertyKey, onChange);
        },

        PropertyOnCreateSetWrapper: function(obj, propertyKey, name, onCreate, trigger, type, instance, params) {
            function setOnCreate(obj, access, onCreate) {
                var propsObj = obj[params.propsObject] || obj;
                if (typeof(access) == 'string') {
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

            setOnCreate(obj, propertyKey, onCreate);
        },

        PropertyOnDeleteSetWrapper: function(obj, propertyKey, name, onDelete, trigger, type, instance, params) {
            function setOnDelete(obj, access, onDelete) {
                var propsObj = obj[params.propsObject] || obj;
                if (typeof(access) == 'string') {
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

            setOnDelete(obj, propertyKey, onDelete);
        },

        PropertyConditionsSetWrapper: function(obj, propertyKey, conditions, params) {

            function setConditions(obj, access, conditions) {
                var propsObj = obj[params.propsObject] || obj;
                if (typeof(access) == 'string') {
                    access = access.split('.');
                }
                if (access.length > 1) {
                    setConditions(propsObj[access.shift()], access, conditions);
                } else {

                    if (!propsObj.hasOwnProperty(access[0])) throw new exceptions.NoSuchPropertyException(propertyKey);

                    propsObj[access[0]].conditions = conditions;
                }
            }

            setConditions(obj, propertyKey, conditions);
        },

        PropertyPermissionSetWrapper: function(obj, propertyKey, permission, instance, params) {

            function setPermission(obj, access, permission) {
                var propsObj = obj[params.propsObject] || obj;
                if (typeof(access) == 'string') {
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

            setPermission(obj, propertyKey, permission);

        },


        PropertySetWrapper: function(obj, propertyKey, newValue, instance, params) {


            function setValue(obj, access, value) {
                var propsObj = obj[params.propsObject] || obj;
                if (typeof(access) == 'string') {
                    access = access.split('.');
                }
                if (access.length > 1) {

                    var shift = access.shift();
                    try {
                        if (propsObj[shift].type) {
                            if (propsObj[shift].type == CONSTANTS.PROPERTY.TYPE_PROPERTY_BAG) {
                                if (propsObj[shift].template) propsObj[shift].overwritten = true;

                            }
                            if (propsObj[shift].type == CONSTANTS.PROPERTY.TYPE_ARRAY) {
                                if (propsObj[shift].template) propsObj[shift].overwritten = true;

                            }
                        }
                    } catch (e) {}

                    setValue(propsObj[shift], access, value);
                } else {

                    if (!propsObj.hasOwnProperty(access[0])) throw new exceptions.NoSuchPropertyException(propertyKey);

                    if (propsObj[access[0]].type == 'boolean') {
                        if (typeof(newValue) != 'boolean') throw new exceptions.InvalidValueException(newValue, propsObj[access[0]].type);
                    }
                    if (propsObj[access[0]].type == 'number') {
                        if (isNaN(newValue)) throw new exceptions.InvalidValueException(newValue, propsObj[access[0]].type);
                    }


                    if (propsObj[access[0]].template) propsObj[access[0]].overwritten = true;
                    propsObj[access[0]].value = newValue;


                    if (propsObj[access[0]].onChange) {
                        if (Object.keys(propsObj[access[0]].onChange).length > 0) {
                            if (!instance.handlerSequence[propsObj._id]) instance.handlerSequence[propsObj._id] = {};
                            if (!instance.handlerSequence[propsObj._id].onChange) instance.handlerSequence[propsObj._id].onChange = [];
                            instance.handlerSequence[propsObj._id].onChange.push({
                                handler: propsObj[access[0]].onChange,
                                prop: propsObj[access[0]]
                            });
                        }
                    }

                    OBJY.chainPermission(propsObj[access[0]], instance, 'u', 'setPropertyValue', propertyKey);

                }
            }

            setValue(obj, propertyKey, newValue);


        },


        PropertySetFullWrapper: function(obj, propertyKey, newValue, instance, force, params) {


            function setValue(obj, access, value) {
                var propsObj = obj[params.propsObject] || obj;
                if (typeof(access) == 'string') {
                    access = access.split('.');
                }
                if (access.length > 1) {

                    var shift = access.shift();
                    try {
                        if (propsObj[shift].type) {
                            if (propsObj[shift].type == CONSTANTS.PROPERTY.TYPE_PROPERTY_BAG) {
                                if (propsObj[shift].template) propsObj[shift].overwritten = true;

                            }
                            if (propsObj[shift].type == CONSTANTS.PROPERTY.TYPE_ARRAY) {
                                if (propsObj[shift].template) propsObj[shift].overwritten = true;
                            }
                        }
                    } catch (e) {}

                    setValue(propsObj[shift], access, value);
                } else {

                    if (!force) {
                        try {
                            var t = propsObj[access[0]];
                        } catch (e) {
                            throw new exceptions.NoSuchPropertyException(propertyKey);
                        }
                    }

                    if (isObject(propsObj[access[0]]) && propsObj[access[0]].template) {
                        newValue.overwritten = true;
                        newValue.template = propsObj[access[0]].template
                    }

                    propsObj[access[0]] = newValue;

                    if (isObject(propsObj[access[0]]) && propsObj[access[0]].onChange) {
                        if (Object.keys(propsObj[access[0]].onChange).length > 0) {
                            if (!instance.handlerSequence[propsObj._id]) instance.handlerSequence[propsObj._id] = {};
                            if (!instance.handlerSequence[propsObj._id].onChange) instance.handlerSequence[propsObj._id].onChange = [];
                            instance.handlerSequence[propsObj._id].onChange.push({
                                handler: propsObj[access[0]].onChange,
                                prop: propsObj[access[0]]
                            });
                        }
                    }

                    OBJY.chainPermission(propsObj[access[0]], instance, 'u', 'setProperty', propertyKey);


                }
            }

            setValue(obj, propertyKey, newValue);

        },

        EventIntervalSetWrapper: function(obj, propertyKey, newValue, client, instance, params) {


            var prop = obj.getProperty(propertyKey);

            if (prop.type != CONSTANTS.PROPERTY.TYPE_EVENT) throw new exceptions.NotAnEventException(propertyKey);



            function setValue(obj, access, value) {
                var propsObj = obj[params.propsObject] || obj;
                if (typeof(access) == 'string') {
                    access = access.split('.');
                }
                if (access.length > 1) {

                    var shift = access.shift();
                    try {
                        if (propsObj[shift].type) {
                            if (propsObj[shift].type == CONSTANTS.PROPERTY.TYPE_PROPERTY_BAG) {
                                if (propsObj[shift].template) propsObj[shift].overwritten = true;

                            }
                            if (propsObj[shift].type == CONSTANTS.PROPERTY.TYPE_ARRAY) {
                                if (propsObj[shift].template) propsObj[shift].overwritten = true;

                            }
                        }
                    } catch (e) {}

                    setValue(propsObj[shift], access, value);
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
                            date: nextOccurence
                        })
                        instance.eventAlterationSequence.push({
                            operation: 'add',
                            obj: obj,
                            propName: propertyKey,
                            property: propsObj[access[0]],
                            date: nextOccurence
                        })
                    }

                    OBJY.chainPermission(propsObj[access[0]], instance, 'u', 'setEventInterval', propertyKey);

                }
            }

            setValue(obj, propertyKey, newValue);

        },

        EventTriggeredSetWrapper: function(obj, propertyKey, newValue, client, params) {

            var prop = obj.getProperty(propertyKey);

            if (prop.type != CONSTANTS.PROPERTY.TYPE_EVENT) throw new exceptions.NotAnEventException(propertyKey);

            function setValue(obj, access, value) {
                var propsObj = obj[params.propsObject] || obj;
                if (typeof(access) == 'string') {
                    access = access.split('.');
                }

                if (access.length > 1) {

                    var shift = access.shift();
                    try {
                        if (propsObj[shift].type) {
                            if (propsObj[shift].type == CONSTANTS.PROPERTY.TYPE_PROPERTY_BAG) {
                                if (propsObj[shift].template) propsObj[shift].overwritten = true;

                            }
                            if (propsObj[shift].type == CONSTANTS.PROPERTY.TYPE_ARRAY) {
                                if (propsObj[shift].template) propsObj[shift].overwritten = true;

                            }
                        }
                    } catch (e) {}

                    setValue(propsObj[shift], access, value);
                } else {

                    if (!propsObj.hasOwnProperty(access[0])) throw new exceptions.NoSuchPropertyException(propertyKey);

                    if (propsObj[access[0]].interval)
                        propsObj[access[0]].nextOccurence = moment().utc().add(propsObj[access[0]].interval).toISOString();
                    else propsObj[access[0]].triggered = newValue;
                    //obj[access[0]].overwritten = true;
                }
            }

            setValue(obj, propertyKey, newValue);

        },


        EventLastOccurenceSetWrapper: function(obj, propertyKey, newValue, client, params) {

            var prop = obj.getProperty(propertyKey);

            if (prop.type != CONSTANTS.PROPERTY.TYPE_EVENT) throw new exceptions.NotAnEventException(propertyKey);


            function setValue(obj, access, value) {
                var propsObj = obj[params.propsObject] || obj;
                if (typeof(access) == 'string') {
                    access = access.split('.');
                }
                if (access.length > 1) {

                    var shift = access.shift();
                    try {
                        if (propsObj[shift].type) {
                            if (propsObj[shift].type == CONSTANTS.PROPERTY.TYPE_PROPERTY_BAG) {
                                if (propsObj[shift].template) propsObj[shift].overwritten = true;

                            }
                            if (propsObj[shift].type == CONSTANTS.PROPERTY.TYPE_ARRAY) {
                                if (propsObj[shift].template) propsObj[shift].overwritten = true;

                            }
                        }
                    } catch (e) {}

                    setValue(propsObj[shift], access, value);
                } else {

                    if (!propsObj.hasOwnProperty(access[0])) throw new exceptions.NoSuchPropertyException(propertyKey);

                    propsObj[access[0]].lastOccurence = newValue;

                    propsObj[access[0]].nextOccurence = moment(newValue).utc().add(moment.duration(propsObj[access[0]].interval)).toISOString();
                }
            }

            setValue(obj, propertyKey, newValue);

        },


        EventDateSetWrapper: function(obj, propertyKey, newValue, client, instance, params) {


            function setValue(obj, access, value) {
                var propsObj = obj[params.propsObject] || obj;
                if (typeof(access) == 'string') {
                    access = access.split('.');
                }
                if (access.length > 1) {

                    var shift = access.shift();
                    try {
                        if (propsObj[shift].type) {
                            if (propsObj[shift].type == CONSTANTS.PROPERTY.TYPE_PROPERTY_BAG) {
                                if (propsObj[shift].template) propsObj[shift].overwritten = true;

                            }
                            if (propsObj[shift].type == CONSTANTS.PROPERTY.TYPE_ARRAY) {
                                if (propsObj[shift].template) propsObj[shift].overwritten = true;

                            }
                        }
                    } catch (e) {}

                    setValue(propsObj[shift], access, value);
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
                        date: newValue
                    })
                    instance.eventAlterationSequence.push({
                        operation: 'add',
                        obj: obj,
                        propName: propertyKey,
                        property: propsObj[access[0]],
                        date: newValue
                    })

                    OBJY.chainPermission(propsObj[access[0]], instance, 'u', 'setEventDate', propertyKey);

                }
            }

            setValue(obj, propertyKey, newValue);

        },

        EventActionSetWrapper: function(obj, propertyKey, newValue, client, instance, params) {

            function setValue(obj, access, value) {
                var propsObj = obj[params.propsObject] || obj;

                if (typeof(access) == 'string') {
                    access = access.split('.');
                }
                if (access.length > 1) {

                    var shift = access.shift();
                    try {
                        if (propsObj[shift].type) {
                            if (propsObj[shift].type == CONSTANTS.PROPERTY.TYPE_PROPERTY_BAG) {
                                if (propsObj[shift].template) propsObj[shift].overwritten = true;

                            }
                            if (propsObj[shift].type == CONSTANTS.PROPERTY.TYPE_ARRAY) {
                                if (propsObj[shift].template) propsObj[shift].overwritten = true;

                            }
                        }
                    } catch (e) {}

                    setValue(propsObj[shift], access, value);
                } else {

                    if (!propsObj.hasOwnProperty(access[0])) throw new exceptions.NoSuchPropertyException(propertyKey);

                    if (propsObj[access[0]].template) propsObj[access[0]].overwritten = true;

                    propsObj[access[0]].action = newValue;

                    OBJY.chainPermission(propsObj[access[0]], instance, 'u', 'setEventAction', propertyKey);

                    //instance.eventAlterationSequence.push({ operation: 'remove', obj: obj, propName: propertyKey, property: obj[access[0]], date: newValue })
                    //instance.eventAlterationSequence.push({ operation: 'add', obj: obj, propName: propertyKey, property: obj.properties[access[0]], date: newValue })
                }
            }

            setValue(obj, propertyKey, newValue);

        },


    }
}