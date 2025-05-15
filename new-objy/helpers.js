import CONSTANTS from './constants.js';
let helpers =  {
	ObjectAuthorisationSetWrapper: (obj, authorisationObj, ctx) => {

        var app = ctx.activeApp || '*';

        if (!obj.authorisations) obj.authorisations = {};
        if (!obj.authorisations[app]) obj.authorisations[app] = [];
        if (!authorisationObj.name) authorisationObj.name = OBJY.RANDOM();

        var found = false;
        obj.authorisations[app].forEach(au => {
            if (au.name == authorisationObj.name) {
                au = authorisationObj;
                found = true;
            }
        })

        if (!found) obj.authorisations[app].push(authorisationObj)

        return authorisationObj;
    },
    ObjectAuthorisationRemoveWrapper: (obj, authorisationId, ctx) => {

        var app = ctx.activeApp || '*';

        if (!obj.authorisations) throw new exceptions.General('No authorisations present')

        if (!obj.authorisations[app]) throw new exceptions.General('No authorisations for this app present')

        obj.authorisations[app].forEach((au, i) => {
            if (au.name == authorisationId) obj.authorisations[app].splice(i, 1)
        })

        if (Object.keys(obj.authorisations[app]).length == 0) delete obj.authorisations[app];

        return authorisationId;
    },
    PrivilegeChecker: (obj, privilege) => {

        if (!typeof privilege == 'object') throw new exceptions.InvalidPrivilegeException();
        var privilegeKey = Object.keys(privilege)[0];

        if (!obj.privileges) obj.privileges = {};

        if (!obj.privileges[privilegeKey]) {
            obj.privileges[privilegeKey] = [];
        }

        var contains = false;

        obj.privileges[privilegeKey].forEach(function(oP) {
            if (oP.name == privilege[privilegeKey].name) contains = true;
        })

        if (!contains) obj.privileges[privilegeKey].push({ name: privilege[privilegeKey].name });
        else throw new exceptions.General('Privilege already exists')

        return privilege;
    },
    PrivilegeRemover: (obj, privilege, ctx) => {

            var appId = ctx.activeApp; //Object.keys(privilege)[0];

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
    PropertyParser: (obj, propertyName, ctx, params) => {
            var app = ctx.activeApp;
            var user = ctx.activeUser;

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
                    console.log('ss', propsObj, access[0])
                    if (!propsObj.hasOwnProperty(access[0])) throw new Error(propertyName + ' does not exist in this object');

                    propertyToReturn = propsObj[access[0]];
                }
            }

            getValue(propsObj, propertyName);

            if (propertyToReturn.type == 'action') {
                propertyToReturn.call = function (callback, client) {
                    helpers.checkAuthroisations(obj, user, 'x', app);
                    helpers.execProcessorAction(propertyToReturn.value || propertyToReturn.action, obj, propertyToReturn, {}, callback, client, {});
                };
            }

            return propertyToReturn;
        },

        ValuePropertyMetaSubstituter: (property) => {
            if (typeof property !== 'undefined') if (typeof property.value === 'undefined') property.value = null;
        },

        PropertyCreateWrapper: (obj, property, isBag, ctx, params, reallyAdd) => {
            
            property = Object.assign({}, property);

            var propsObj = obj;

            var propertyKey = Object.keys(property)[0];
            var existing = null;

            if (typeof property !== 'object') {
                throw new Error('Invalid format')
            }

            if (reallyAdd && propsObj.hasOwnProperty(propertyKey) && !helpers.predefinedProperties.includes(propertyKey))
                throw new Error(propertyKey+' already exists in helpers object');

            switch ((property[propertyKey] || {}).type) {
                case undefined:
                    propsObj[propertyKey] = property[propertyKey];
                    break;

                case CONSTANTS.PROPERTY.TYPE_SHORTTEXT:
                    propsObj[propertyKey] = property[propertyKey];

                    if (propsObj[propertyKey]?.value){
                        propsObj[propertyKey].value = propsObj[propertyKey].value  + '';
                    }
                    
                    helpers.ValuePropertyMetaSubstituter(propsObj[propertyKey]);
                    break;

                case CONSTANTS.PROPERTY.TYPE_LONGTEXT:
                    propsObj[propertyKey] = property[propertyKey];

                    if (propsObj[propertyKey]?.value){
                        propsObj[propertyKey].value = propsObj[propertyKey].value  + '';
                    }

                    helpers.ValuePropertyMetaSubstituter(propsObj[propertyKey]);
                    break;

                case CONSTANTS.PROPERTY.TYPE_INDEXEDTEXT:
                    propsObj[propertyKey] = property[propertyKey];
                    helpers.ValuePropertyMetaSubstituter(propsObj[propertyKey]);
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
                    helpers.ValuePropertyMetaSubstituter(propsObj[propertyKey]);
                    break;

                case CONSTANTS.PROPERTY.TYPE_NUMBER:
                    if (property[propertyKey].value != '') {
                        if (property[propertyKey].value != null)
                            if (isNaN(property[propertyKey].value))
                                throw new exceptions.InvalidValueException(property[propertyKey].value, CONSTANTS.PROPERTY.TYPE_NUMBER);
                    }
                    property[propertyKey].value = +property[propertyKey].value;
                    propsObj[propertyKey] = property[propertyKey];
                    helpers.ValuePropertyMetaSubstituter(propsObj[propertyKey]);
                    break;

                case CONSTANTS.PROPERTY.TYPE_EVENT:
                    ctx.chainPermission(obj, ctx, 'evt', 'addProperty (Event)', propertyKey);

                    var _event = {};
                    var eventKey = propertyKey;
                    propsObj[propertyKey] = property[propertyKey];

                    if (!propsObj[propertyKey].eventId) propsObj[propertyKey].eventId = helpers.ID();

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

                        

                        ctx.eventAlterationSequence.push({
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

                        ctx.eventAlterationSequence.push({
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
                    helpers.ValuePropertyMetaSubstituter(propsObj[propertyKey]);
                    break;

                case CONSTANTS.PROPERTY.TYPE_SHORTID:
                    if (!property[propertyKey].value || property[propertyKey].value == '') property[propertyKey].value = helpers.RANDOM();
                    if (obj.role == 'template') property[propertyKey].value = null;
                    propsObj[propertyKey] = property[propertyKey];
                    helpers.ValuePropertyMetaSubstituter(propsObj[propertyKey]);
                    break;

                case CONSTANTS.PROPERTY.TYPE_REF_OBJ:
                    // FOR NOW: no checking for existing object, since callback!!!
                    propsObj[propertyKey] = property[propertyKey];
                    helpers.ValuePropertyMetaSubstituter(propsObj[propertyKey]);
                    break;

                case CONSTANTS.PROPERTY.TYPE_REF_USR:
                    // FOR NOW: no checking for existing object, since callback!!!
                    propsObj[propertyKey] = property[propertyKey];
                    helpers.ValuePropertyMetaSubstituter(propsObj[propertyKey]);
                    break;

                case CONSTANTS.PROPERTY.TYPE_REF_FILE:
                    // FOR NOW: no checking for existing object, since callback!!!
                    propsObj[propertyKey] = property[propertyKey];
                    helpers.ValuePropertyMetaSubstituter(propsObj[propertyKey]);
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

                        helpers.PropertyCreateWrapper(obj[propertyKey], Object.assign({}, tmpProp), true, ctx, params);
                    });

                    break;

                case CONSTANTS.PROPERTY.TYPE_BOOLEAN:
                    if (!typeof property[propertyKey].value === 'boolean')
                        throw new exceptions.InvalidValueException(property[propertyKey].value, CONSTANTS.PROPERTY.TYPE_BOOLEAN);
                    propsObj[propertyKey] = property[propertyKey];
                    helpers.ValuePropertyMetaSubstituter(propsObj[propertyKey]);
                    break;

                case CONSTANTS.PROPERTY.TYPE_ACTION:
                    ctx.chainPermission(obj, ctx, 'act', 'addProperty (Action)', propertyKey);

                    if (property[propertyKey].value) {
                        if (typeof property[propertyKey].value !== 'string')
                            throw new exceptions.InvalidValueException(property[propertyKey].value, CONSTANTS.PROPERTY.TYPE_ACTION);
                    }

                    propsObj[propertyKey] = property[propertyKey];
                    helpers.ValuePropertyMetaSubstituter(propsObj[propertyKey]);
                    break;

                default:
                    break;
            }

            if ((property[propertyKey] || {}).onCreate) {
                if (Object.keys(property[propertyKey].onCreate).length > 0) {
                    if (!ctx.handlerSequence[obj._id]) ctx.handlerSequence[obj._id] = {};
                    if (!ctx.handlerSequence[obj._id].onCreate) ctx.handlerSequence[obj._id].onCreate = [];
                    ctx.handlerSequence[obj._id].onCreate.push({
                        handler: property[propertyKey].onCreate,
                        prop: property[propertyKey],
                    });
                }
            }

            if (reallyAdd) ctx.chainPermission(obj, ctx, 'p', 'addProperty', propertyKey);

        },

        PropertiesChecker: (obj, properties, ctx, params) => {
            if (properties === undefined) return;

            var propertyKeys = Object.keys(properties);
            propertyKeys.forEach(function(property) {
                var propKey = {};
                propKey[property] = properties[property];
                var newProp = propKey;
                helpers.PropertyCreateWrapper(obj, newProp, false, ctx, params);
            })
            return obj;
        },

        checkAuthroisations: (obj, user, permission, app) => {

        },

        execProcessorAction: () => {
            console.log('CALLING!!!')
        },

        removeTemplateFromObject: (obj, inheritId, success, error, ctx) => {
            var contains = false;

            obj.inherits.forEach(function(templ) {
                if (templ == inheritId) contains = true;
            });

            if (obj.inherits.indexOf(inheritId) != -1) {

                obj.inherits.splice(obj.inherits.indexOf(inheritId), 1);

                ctx.chainPermission(ob, 'i', 'removeInherit', inheritId);
                ctx.chainCommand(obj, 'removeInherit', inheritId);

                success(obj);

            } else {
                error('Template not found in object');
            }


        },

}

export default helpers;