var CONSTANTS = require('../dependencies/constants.js')
var moment = require('moment');
var exceptions = require('../dependencies/exceptions.js')

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

        PropertyParser: function(obj, propertyName) {
            var thisRef = this;

            var propertyToReturn;

            function getValue(obj, access) {
                if (typeof(access) == 'string') {
                    access = access.split('.');
                }
                if (access.length > 1) {
                    getValue(obj[access.shift()], access);
                } else {

                    if (!obj.hasOwnProperty(access[0])) throw new exceptions.NoSuchPropertyException(propertyName);

                    propertyToReturn = obj[access[0]];
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


        ActionCreateWrapper: function(obj, action, client) {

            action = Object.assign({}, action);

            if (typeof action !== 'object') throw new exceptions.InvalidFormatException();
            var actionKey = Object.keys(action)[0];
            var existing = null;
            try {
                existing = obj.actions[actionKey]

            } catch (e) {}

            if (existing) throw new exceptions.DuplicateActionException(actionKey);
        },



        PropertyCreateWrapper: function(obj, property, isBag, instance, params) {

            // if (!obj) obj = {};


            property = Object.assign({}, property);


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

            if (obj.hasOwnProperty(propertyKey) && !OBJY.predefinedProperties.includes(propertyKey)) throw new exceptions.DuplicatePropertyException(propertyKey);


            switch ((property[propertyKey] || {}).type) {
                case undefined:
                    obj[propertyKey] = property[propertyKey];
                    break;

                case CONSTANTS.PROPERTY.TYPE_SHORTTEXT:
                    obj[propertyKey] = property[propertyKey];
                    OBJY.ValuePropertyMetaSubstituter(obj[propertyKey]);
                    break;

                case CONSTANTS.PROPERTY.TYPE_LONGTEXT:
                    obj[propertyKey] = property[propertyKey];
                    OBJY.ValuePropertyMetaSubstituter(obj[propertyKey]);
                    break;

                case CONSTANTS.PROPERTY.TYPE_INDEXEDTEXT:
                    obj[propertyKey] = property[propertyKey];
                    OBJY.ValuePropertyMetaSubstituter(obj[propertyKey]);
                    break;

                case CONSTANTS.PROPERTY.TYPE_JSON:
                    if (property[propertyKey].value) {
                        if (typeof property[propertyKey].value === 'string') {
                            try {
                                obj[propertyKey].value = JSON.parse(obj[propertyKey].value);
                            } catch (e) {
                                //throw new exceptions.InvalidValueException(property[propertyKey].value, CONSTANTS.PROPERTY.TYPE_JSON);
                            }
                        } else {

                        }
                    }
                    obj[propertyKey] = property[propertyKey];
                    OBJY.ValuePropertyMetaSubstituter(obj[propertyKey]);
                    break;

                case CONSTANTS.PROPERTY.TYPE_NUMBER:
                    if (property[propertyKey].value != '') {
                        if (property[propertyKey].value != null)
                            if (isNaN(property[propertyKey].value)) throw new exceptions.InvalidValueException(property[propertyKey].value, CONSTANTS.PROPERTY.TYPE_NUMBER);
                    }
                    property[propertyKey].value = +property[propertyKey].value;
                    obj[propertyKey] = property[propertyKey];
                    OBJY.ValuePropertyMetaSubstituter(obj[propertyKey]);
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

                    obj[propertyKey] = _event[eventKey];
                    break;

                case CONSTANTS.PROPERTY.TYPE_DATE:
                    if (!property[propertyKey].value || property[propertyKey].value == '') property[propertyKey].value = null;
                    //else property[propertyKey].value = property[propertyKey];
                    obj[propertyKey] = property[propertyKey];
                    OBJY.ValuePropertyMetaSubstituter(obj[propertyKey]);
                    break;


                case CONSTANTS.PROPERTY.TYPE_SHORTID:
                    if (!property[propertyKey].value || property[propertyKey].value == '') property[propertyKey].value = OBJY.RANDOM();
                    if (obj.role == 'template') property[propertyKey].value = null;
                    obj[propertyKey] = property[propertyKey];
                    OBJY.ValuePropertyMetaSubstituter(obj[propertyKey]);
                    break;

                case CONSTANTS.PROPERTY.TYPE_REF_OBJ:


                    // FOR NOW: no checking for existing object, since callback!!!
                    obj[propertyKey] = property[propertyKey];
                    OBJY.ValuePropertyMetaSubstituter(obj[propertyKey]);
                    break;

                case CONSTANTS.PROPERTY.TYPE_REF_USR:



                    // FOR NOW: no checking for existing object, since callback!!!
                    obj[propertyKey] = property[propertyKey];
                    OBJY.ValuePropertyMetaSubstituter(obj[propertyKey]);
                    break;

                case CONSTANTS.PROPERTY.TYPE_REF_FILE:



                    // FOR NOW: no checking for existing object, since callback!!!
                    obj[propertyKey] = property[propertyKey];
                    OBJY.ValuePropertyMetaSubstituter(obj[propertyKey]);
                    break;

                case CONSTANTS.PROPERTY.TYPE_PROPERTY_BAG:

                    if (!property[propertyKey]) property[propertyKey] = {};

                    var innerProperties = property[propertyKey];

                    var propertyKeys = Object.keys(innerProperties);

                    parentProp = property;

                    obj[propertyKey] = property[propertyKey];
                    obj[propertyKey].type = CONSTANTS.PROPERTY.TYPE_PROPERTY_BAG;
                    obj[propertyKey] = {};

                    propertyKeys.forEach(function(property) {
                        tmpProp = {};
                        tmpProp[property] = innerProperties[property];

                        new OBJY.PropertyCreateWrapper(obj[propertyKey], Object.assign({}, tmpProp), true, instance, params);
                    })

                    break;

                case CONSTANTS.PROPERTY.TYPE_ARRAY:

                    if (!property[propertyKey]) property[propertyKey] = {};

                    var innerProperties = property[propertyKey];

                    var propertyKeys = Object.keys(innerProperties);

                    parentProp = property;

                    obj[propertyKey] = {
                        type: CONSTANTS.PROPERTY.TYPE_ARRAY,
                        properties: {},
                        query: property[propertyKey].query,
                        meta: property[propertyKey].meta
                    };


                    propertyKeys.forEach(function(property) {
                        tmpProp = {};
                        tmpProp[property] = innerProperties[property];

                        new OBJY.PropertyCreateWrapper(obj[propertyKey], Object.assign({}, tmpProp), true, instance, params);
                    })

                    break;

                case CONSTANTS.PROPERTY.TYPE_BOOLEAN:
                    if (!typeof property[propertyKey].value === 'boolean') throw new exceptions.InvalidValueException(property[propertyKey].value, CONSTANTS.PROPERTY.TYPE_BOOLEAN);
                    obj[propertyKey] = property[propertyKey];
                    OBJY.ValuePropertyMetaSubstituter(obj[propertyKey]);
                    break;

                case CONSTANTS.PROPERTY.TYPE_ACTION:

                    OBJY.chainPermission(obj, instance, 'act', 'addProperty (Action)', propertyKey);

                    if (property[propertyKey].value) {
                        if (typeof property[propertyKey].value !== 'string') throw new exceptions.InvalidValueException(property[propertyKey].value, CONSTANTS.PROPERTY.TYPE_ACTION);
                    }

                    obj[propertyKey] = property[propertyKey];
                    OBJY.ValuePropertyMetaSubstituter(obj[propertyKey]);
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



        PropertyQuerySetWrapper: function(obj, propertyKey, query) {

            function setValue(obj, access, value) {
                if (typeof(access) == 'string') {
                    access = access.split('.');
                }
                if (access.length > 1) {
                    setValue(obj[access.shift()], access, value);
                } else {
                    //obj[access[0]] = value;
                    if (!obj.hasOwnProperty(access[0])) throw new exceptions.NoSuchPropertyException(propertyKey);

                    if (typeof value !== 'object') throw new exceptions.InvalidDataTypeException(value, 'object');

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

                    if (!obj.hasOwnProperty(access[0])) throw new exceptions.NoSuchPropertyException(propertyKey);

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

                    if (!obj.hasOwnProperty(access[0])) throw new exceptions.NoSuchPropertyException(propertyKey);

                    //if (!obj[access[0]].on) obj[access[0]].on = {};

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

                    if (!obj.hasOwnProperty(access[0])) throw new exceptions.NoSuchPropertyException(propertyKey);

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

                    if (!obj.hasOwnProperty(access[0])) throw new exceptions.NoSuchPropertyException(propertyKey);

                    if (!obj[access[0]].onDelete) obj[access[0]].onDelete = {};
                    if (!obj[access[0]].onDelete[name]) obj[access[0]].onDelete[name] = {};


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

                    if (!obj.hasOwnProperty(access[0])) throw new exceptions.NoSuchPropertyException(propertyKey);

                    obj[access[0]].conditions = conditions;
                }
            }

            setConditions(obj, propertyKey, conditions);
        },

        PropertyPermissionSetWrapper: function(obj, propertyKey, permission, instance) {

            function setPermission(obj, access, permission) {
                if (typeof(access) == 'string') {
                    access = access.split('.');
                }
                if (access.length > 1) {
                    setPermission(obj[access.shift()], access, permission);
                } else {

                    if (!obj.hasOwnProperty(access[0])) throw new exceptions.NoSuchPropertyException(propertyKey);

                    var permissionKey = Object.keys(permission)[0];
                    if (!obj[access[0]].permissions) obj[access[0]].permissions = {};

                    obj[access[0]].permissions[permissionKey] = permission[permissionKey];

                    OBJY.chainPermission(obj[access[0]], instance, 'x', 'setPropertyPermission', propertyKey);
                }
            }

            setPermission(obj, propertyKey, permission);

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

                            }
                            if (obj[shift].type == CONSTANTS.PROPERTY.TYPE_ARRAY) {
                                if (obj[shift].template) obj[shift].overwritten = true;

                            }
                        }
                    } catch (e) {}

                    setValue(obj[shift], access, value);
                } else {

                    if (!obj.hasOwnProperty(access[0])) throw new exceptions.NoSuchPropertyException(propertyKey);

                    if (obj[access[0]].type == 'boolean') {
                        if (typeof(newValue) != 'boolean') throw new exceptions.InvalidValueException(newValue, obj[access[0]].type);
                    }
                    if (obj[access[0]].type == 'number') {
                        if (isNaN(newValue)) throw new exceptions.InvalidValueException(newValue, obj[access[0]].type);
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


        },


        PropertySetFullWrapper: function(obj, propertyKey, newValue, instance, notPermitted, force) {


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

                    if (!force) {
                        try {
                            var t = obj[access[0]];
                        } catch (e) {
                            throw new exceptions.NoSuchPropertyException(propertyKey);
                        }
                    }

                    if (isObject(obj[access[0]]) && obj[access[0]].template) {
                        newValue.overwritten = true;
                        newValue.template = obj[access[0]].template
                    }

                    obj[access[0]] = newValue;

                    if (isObject(obj[access[0]]) && obj[access[0]].onChange) {
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

            if (prop.type != CONSTANTS.PROPERTY.TYPE_EVENT) throw new exceptions.NotAnEventException(propertyKey);



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

                    if (!obj.hasOwnProperty(access[0])) throw new exceptions.NoSuchPropertyException(propertyKey);

                    if (obj[access[0]].template) obj[access[0]].overwritten = true;

                    delete obj[access[0]].date;
                    obj[access[0]].interval = newValue;

                    if (obj[access[0]].lastOccurence) {

                        var nextOccurence = moment(obj[access[0]].lastOccurence).utc().add(newValue);
                        instance.eventAlterationSequence.push({
                            operation: 'remove',
                            obj: obj,
                            propName: propertyKey,
                            property: obj[access[0]],
                            date: nextOccurence
                        })
                        instance.eventAlterationSequence.push({
                            operation: 'add',
                            obj: obj,
                            propName: propertyKey,
                            property: obj[access[0]],
                            date: nextOccurence
                        })
                    }

                    OBJY.chainPermission(obj[access[0]], instance, 'u', 'setEventInterval', propertyKey);

                }
            }

            setValue(obj, propertyKey, newValue);

        },

        EventTriggeredSetWrapper: function(obj, propertyKey, newValue, client, notPermitted) {

            var prop = obj.getProperty(propertyKey);

            if (prop.type != CONSTANTS.PROPERTY.TYPE_EVENT) throw new exceptions.NotAnEventException(propertyKey);

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

                    if (!obj.hasOwnProperty(access[0])) throw new exceptions.NoSuchPropertyException(propertyKey);

                    if (obj[access[0]].interval)
                        obj[access[0]].nextOccurence = moment().utc().add(obj[access[0]].interval).toISOString();
                    else obj[access[0]].triggered = newValue;
                    //obj[access[0]].overwritten = true;
                }
            }

            setValue(obj, propertyKey, newValue);

        },


        EventLastOccurenceSetWrapper: function(obj, propertyKey, newValue, client, notPermitted) {

            var prop = obj.getProperty(propertyKey);

            if (prop.type != CONSTANTS.PROPERTY.TYPE_EVENT) throw new exceptions.NotAnEventException(propertyKey);


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

                    if (!obj.hasOwnProperty(access[0])) throw new exceptions.NoSuchPropertyException(propertyKey);

                    obj[access[0]].lastOccurence = newValue;

                    obj[access[0]].nextOccurence = moment(newValue).utc().add(moment.duration(obj[access[0]].interval)).toISOString();
                }
            }

            setValue(obj, propertyKey, newValue);

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

                            }
                            if (obj[shift].type == CONSTANTS.PROPERTY.TYPE_ARRAY) {
                                if (obj[shift].template) obj[shift].overwritten = true;

                            }
                        }
                    } catch (e) {}

                    setValue(obj[shift], access, value);
                } else {

                    if (!obj.hasOwnProperty(access[0])) throw new exceptions.NoSuchPropertyException(propertyKey);


                    if (obj[access[0]].template) obj[access[0]].overwritten = true;
                    delete obj[access[0]].interval;
                    delete obj[access[0]].lastOccurence;
                    delete obj[access[0]].nextOccurence;
                    obj[access[0]].date = newValue;


                    instance.eventAlterationSequence.push({
                        operation: 'remove',
                        obj: obj,
                        propName: propertyKey,
                        property: obj[access[0]],
                        date: newValue
                    })
                    instance.eventAlterationSequence.push({
                        operation: 'add',
                        obj: obj,
                        propName: propertyKey,
                        property: obj[access[0]],
                        date: newValue
                    })

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

                            }
                            if (obj[shift].type == CONSTANTS.PROPERTY.TYPE_ARRAY) {
                                if (obj[shift].template) obj[shift].overwritten = true;

                            }
                        }
                    } catch (e) {}

                    setValue(obj[shift], access, value);
                } else {

                    if (!obj.hasOwnProperty(access[0])) throw new exceptions.NoSuchPropertyException(propertyKey);

                    if (obj[access[0]].template) obj[access[0]].overwritten = true;

                    obj[access[0]].action = newValue;

                    OBJY.chainPermission(obj[access[0]], instance, 'u', 'setEventAction', propertyKey);

                    //instance.eventAlterationSequence.push({ operation: 'remove', obj: obj, propName: propertyKey, property: obj[access[0]], date: newValue })
                    //instance.eventAlterationSequence.push({ operation: 'add', obj: obj, propName: propertyKey, property: obj.properties[access[0]], date: newValue })
                }
            }

            setValue(obj, propertyKey, newValue);

        },


    }
}