/*var CONSTANTS = require('../lib/dependencies/constants.js');
var moment = require('moment');*/

import CONSTANTS from '../lib/dependencies/constants.js';
import moment from 'moment';

if (typeof moment == 'object') {
    moment = moment.default;
}

//var exceptions = require('../lib/dependencies/exceptions.js');
import exceptions from '../lib/dependencies/exceptions.js';

var isObject = function (a) {
    return !!a && a.constructor === Object;
};

export default function(OBJY) {
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
            var thisRef = this;

            var propertyToReturn;

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
            var thisRef = this;
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

            if (reallyAdd && propsObj.hasOwnProperty(propertyKey) && !OBJY.predefinedProperties.includes(propertyKey))
                throw new exceptions.DuplicatePropertyException(propertyKey);

            switch ((property[propertyKey] || {}).type) {
                case undefined:
                    propsObj[propertyKey] = property[propertyKey];
                    break;

                case CONSTANTS.PROPERTY.TYPE_SHORTTEXT:
                    propsObj[propertyKey] = property[propertyKey];

                    if (propsObj[propertyKey]?.value){
                        propsObj[propertyKey].value = propsObj[propertyKey].value  + '';
                    }
                    
                    OBJY.ValuePropertyMetaSubstituter(propsObj[propertyKey]);
                    break;

                case CONSTANTS.PROPERTY.TYPE_LONGTEXT:
                    propsObj[propertyKey] = property[propertyKey];

                    if (propsObj[propertyKey]?.value){
                        propsObj[propertyKey].value = propsObj[propertyKey].value  + '';
                    }

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
                            if (isNaN(property[propertyKey].value))
                                throw new exceptions.InvalidValueException(property[propertyKey].value, CONSTANTS.PROPERTY.TYPE_NUMBER);
                    }
                    property[propertyKey].value = +property[propertyKey].value;
                    propsObj[propertyKey] = property[propertyKey];
                    OBJY.ValuePropertyMetaSubstituter(propsObj[propertyKey]);
                    break;

                case CONSTANTS.PROPERTY.TYPE_EVENT:
                    OBJY.chainPermission(obj, context, 'evt', 'addProperty (Event)', propertyKey);

                    var _event = {};
                    var eventKey = propertyKey;
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

                        console.log('AFSFAASF')
                        propsObj[propertyKey].nextOccurence = propsObj[propertyKey].date;

                        context.eventAlterationSequence.push({
                            operation: 'add',
                            obj: obj,
                            propName: propertyKey,
                            property: property,
                            date: propsObj[propertyKey].date,
                        });

                        if (!propsObj[propertyKey].action) propsObj[propertyKey].action = '';
                    } else {
                        //throw new exceptions.InvalidTypeException("No interval or date provided");
                    }

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

                    //parentProp = property;

                    obj[propertyKey] = property[propertyKey];
                    obj[propertyKey].type = CONSTANTS.PROPERTY.TYPE_PROPERTY_BAG;
                    //obj[propertyKey].properties = {};

                    propertyKeys.forEach(function (property) {
                        var tmpProp = {};
                        tmpProp[property] = innerProperties[property];

                        new OBJY.PropertyCreateWrapper(obj[propertyKey], Object.assign({}, tmpProp), true, context, params);
                    });

                    break;

                case CONSTANTS.PROPERTY.TYPE_ARRAY:
                    if (!property[propertyKey].properties) property[propertyKey].properties = {};

                    var innerProperties = property[propertyKey][params.propsObject] || property[propertyKey];

                    var propertyKeys = Object.keys(innerProperties);

                    var parentProp = property;

                    propsObj[propertyKey] = {
                        type: CONSTANTS.PROPERTY.TYPE_ARRAY,
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

                case CONSTANTS.PROPERTY.TYPE_BOOLEAN:
                    if (!typeof property[propertyKey].value === 'boolean')
                        throw new exceptions.InvalidValueException(property[propertyKey].value, CONSTANTS.PROPERTY.TYPE_BOOLEAN);
                    propsObj[propertyKey] = property[propertyKey];
                    OBJY.ValuePropertyMetaSubstituter(propsObj[propertyKey]);
                    break;

                case CONSTANTS.PROPERTY.TYPE_ACTION:
                    OBJY.chainPermission(obj, context, 'act', 'addProperty (Action)', propertyKey);

                    if (property[propertyKey].value) {
                        if (typeof property[propertyKey].value !== 'string')
                            throw new exceptions.InvalidValueException(property[propertyKey].value, CONSTANTS.PROPERTY.TYPE_ACTION);
                    }

                    propsObj[propertyKey] = property[propertyKey];
                    OBJY.ValuePropertyMetaSubstituter(propsObj[propertyKey]);
                    break;

                default:
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

            setValue(propsObj, propertyKey, newValue);
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

            setValue(propsObj, propertyKey, newValue);
        },

        EventIntervalSetWrapper: function (obj, propertyKey, newValue, client, context, params) {
            var propsObj = obj;

            var prop = obj.getProperty(propertyKey);

            if (prop.type != CONSTANTS.PROPERTY.TYPE_EVENT) throw new exceptions.NotAnEventException(propertyKey);

            function setValue(obj, access, value) {
                var propsObj = obj;
                if (typeof access == 'string') {
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

            setValue(propsObj, propertyKey, newValue);
        },

        EventTriggeredSetWrapper: function (obj, propertyKey, newValue, client, params) {
            var propsObj = obj;

            var prop = obj.getProperty(propertyKey);

            if (prop.type != CONSTANTS.PROPERTY.TYPE_EVENT) throw new exceptions.NotAnEventException(propertyKey);

            function setValue(obj, access, value) {
                var propsObj = obj;
                if (typeof access == 'string') {
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

                    if (propsObj[access[0]].interval) propsObj[access[0]].nextOccurence = moment().utc().add(propsObj[access[0]].interval).toISOString();
                    else propsObj[access[0]].triggered = newValue;
                    //obj[access[0]].overwritten = true;
                }
            }

            setValue(propsObj, propertyKey, newValue);
        },

        EventLastOccurenceSetWrapper: function (obj, propertyKey, newValue, client, params) {
            var propsObj = obj;

            var prop = obj.getProperty(propertyKey);

            if (prop.type != CONSTANTS.PROPERTY.TYPE_EVENT) throw new exceptions.NotAnEventException(propertyKey);

            function setValue(obj, access, value) {
                var propsObj = obj;
                if (typeof access == 'string') {
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

            setValue(propsObj, propertyKey, newValue);
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

            setValue(propsObj, propertyKey, newValue);
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

                    OBJY.chainPermission(propsObj[access[0]], context, 'u', 'setEventAction', propertyKey);

                    //context.eventAlterationSequence.push({ operation: 'remove', obj: obj, propName: propertyKey, property: obj[access[0]], date: newValue })
                    //context.eventAlterationSequence.push({ operation: 'add', obj: obj, propName: propertyKey, property: obj.properties[access[0]], date: newValue })
                }
            }

            setValue(propsObj, propertyKey, newValue);
        },
    };
};
