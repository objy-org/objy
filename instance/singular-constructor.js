var moment = require('moment');
if (typeof moment == 'object') {
    moment = moment.default;
}
var CONSTANTS = require('../lib/dependencies/constants.js');
var exceptions = require('../lib/dependencies/exceptions.js');

var isObject = function (a) {
    return !!a && a.constructor === Object;
};

module.exports = function (OBJY) {
    return {
        Obj: function (obj, role, context, params) {

            if (!obj) obj = {};

            if (context.metaPropPrefix != '' && typeof obj !== 'string') obj = OBJY.serialize(obj);

            if (typeof obj === 'object') {
                obj.role = role;
            }

            let skelleton = {
                __ctx: context,
                _id: obj._id,
                _clients: [],
                name: obj.name,
                created: obj.created || moment().utc().toDate().toISOString(),
                lastModified: obj.lastModified || moment().utc().toDate().toISOString()
            }


            if (obj._id) skelleton._id = obj._id;

            if (typeof obj === 'string') {
                skelleton._id = obj;
            }

            
            skelleton.role = role || 'object';


            if (params.extendedStructure) {
                for (var prop in params.extendedStructure) {
                    if (obj[prop] || params.extendedStructure[prop] === null) skelleton[prop] = obj[prop];
                    else skelleton[prop] = params.extendedStructure[prop];

                    if (!OBJY.predefinedProperties.includes(prop)) OBJY.predefinedProperties.push(prop);
                }
            }

            if (params.hasAffects) {
                skelleton.affects = OBJY.AffectsCreateWrapper(skelleton, obj.affects, context);
                skelleton.apply = OBJY.ApplyCreateWrapper(skelleton, obj.apply, context);
            }

            skelleton._constraints = obj._constraints;

            //@TODO: DEPRECATE skelleton!
            // skelleton.type = obj.type;

            skelleton.applications = OBJY.ApplicationsChecker(skelleton, obj.applications); // || [];

            skelleton.inherits = OBJY.InheritsChecker(skelleton, obj.inherits); // || [];

            //@TODO: DEPRECATE skelleton!
            // skelleton.name = obj.name; // || null;

            skelleton.onCreate = OBJY.ObjectOnCreateCreateWrapper(skelleton, obj.onCreate, context);
            skelleton.onChange = OBJY.ObjectOnChangeCreateWrapper(skelleton, obj.onChange, context);
            skelleton.onDelete = OBJY.ObjectOnDeleteCreateWrapper(skelleton, obj.onDelete, context);

            skelleton.created = obj.created || moment().utc().toDate().toISOString();
            skelleton.lastModified = obj.lastModified || moment().utc().toDate().toISOString();

            //skelleton.properties = OBJY.PropertiesChecker(skelleton, obj.properties, context); // || {};
            OBJY.PropertiesChecker(skelleton, obj, context, params);

            skelleton.permissions = OBJY.ObjectPermissionsCreateWrapper(skelleton, obj.permissions); // || {};

            skelleton._aggregatedEvents = obj._aggregatedEvents;

            skelleton.authorisations = obj.authorisations || undefined;

            if (params.authable) {
                skelleton.username = obj.username || null;
                skelleton.email = obj.email || null;
                skelleton.password = obj.password || null;

                skelleton.spooAdmin = obj.spooAdmin;

                delete skelleton.name;

                skelleton.setUsername = function (username) {
                    skelleton.username = username;
                    OBJY.chainPermission(skelleton, context, 'o', 'setUsername', username);
                    context.alterSequence.push({ setUsername: arguments });
                    return skelleton;
                };

                skelleton.setEmail = function (email) {
                    skelleton.email = email;
                    OBJY.chainPermission(skelleton, context, 'h', 'setEmail', email);
                    context.alterSequence.push({ setEmail: arguments });
                    return skelleton;
                };

                skelleton.setPassword = function (password) {
                    // should be encrypted at skelleton point
                    skelleton.password = password;
                    context.alterSequence.push({ setPassword: arguments });
                    return skelleton;
                };

                skelleton.setAuthorisation = function (authorisationObj) {
                    new OBJY.ObjectAuthorisationSetWrapper(skelleton, authorisationObj, context);
                    context.alterSequence.push({ setAuthorisation: arguments });
                    return skelleton;
                };

                skelleton.removeAuthorisation = function (authorisationId) {
                    new OBJY.ObjectAuthorisationRemoveWrapper(skelleton, authorisationId, context);
                    context.alterSequence.push({ removeAuthorisation: arguments });
                    return skelleton;
                };
            }

            // TODO: explain skelleton!
            if (params.authable || params.authableTemplate) {
                skelleton.privileges = OBJY.PrivilegesChecker(obj) || {};
                skelleton._clients = obj._clients;

                skelleton.addPrivilege = function (privilege) {
                    if (context.activeApp) {
                        var tmpPriv = {};
                        tmpPriv[context.activeApp] = { name: privilege };
                        new OBJY.PrivilegeChecker(skelleton, tmpPriv);
                        context.alterSequence.push({ addPrivilege: arguments });
                        return skelleton;
                    } else throw new exceptions.General('Invalid app id');

                    return skelleton;
                };

                skelleton.removePrivilege = function (privilege) {
                    new OBJY.PrivilegeRemover(skelleton, privilege, context);
                    context.alterSequence.push({ removePrivilege: arguments });
                    return skelleton;
                };

                skelleton.addClient = function (client) {
                    if (skelleton._clients.indexOf(client) != -1) throw new exceptions.General('Client ' + client + ' already exists');
                    skelleton._clients.push(client);
                    context.alterSequence.push({ addClient: arguments });
                    return skelleton;
                };

                skelleton.removeClient = function (client) {
                    if (skelleton._clients.indexOf(client) == -1) throw new exceptions.General('Client ' + client + ' does not exist');
                    skelleton._clients.splice(skelleton._clients.indexOf(client), 1);
                    context.alterSequence.push({ removeClient: arguments });
                    return skelleton;
                };
            }

            /* skelleton.props = function(properties) {
                 skelleton.properties = OBJY.PropertiesChecker(skelleton, properties, context) || {};
                 return skelleton;
             };*/

            skelleton.addInherit = function (templateId) {
                OBJY.addTemplateToObject(skelleton, templateId, context);

                context.alterSequence.push({ addInherit: arguments });

                return skelleton;
            };

            skelleton.removeInherit = function (templateId, success, error) {
                OBJY.removeTemplateFromObject(
                    skelleton,
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

                return skelleton;
            };

            skelleton.addApplication = function (application) {
                OBJY.addApplicationToObject(skelleton, application, context);

                context.alterSequence.push({ addApplication: arguments });

                return skelleton;
            };

            skelleton.removeApplication = function (application) {
                OBJY.removeApplicationFromObject(skelleton, application, context);

                context.alterSequence.push({ removeApplication: arguments });

                return skelleton;
            };

            skelleton.replace = function (newObj) {
                newObj = OBJY[skelleton.role](newObj);

                if (skelleton.role != newObj.role) throw new exceptions.General('cannot alter role');

                Object.keys(skelleton).forEach(function (k) {
                    if (skelleton[k] contextof Function || k == '_id') return;
                    delete skelleton[k];
                });

                function doTheProps(skelleton, o) {
                    Object.keys(o).forEach(function (k) {
                        if (o[k] == null || o[k] === undefined) return;

                        skelleton[k] = o[k];
                        if (typeof o[k] === 'object') {
                            doTheProps(skelleton[k], o[k]);
                        }
                    });
                }

                doTheProps(skelleton, newObj);

                return skelleton;

                //OBJY.prepareObjectDelta(skelleton, newObj);
            };

            skelleton.addProperty = function (name, property) {
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

                    skelleton.addPropertyToBag(bag, newProp);
                    //new OBJY.PropertyCreateWrapper(skelleton[bag], prop, false, context, params, true);

                    context.alterSequence.push({ addProperty: arguments });

                    return skelleton;
                }

                new OBJY.PropertyCreateWrapper(skelleton, property, false, context, params, true);

                context.alterSequence.push({ addProperty: arguments });
                return skelleton;
            };

            skelleton.setOnChange = function (name, onChangeObj) {
                if (typeof onChangeObj !== 'object') throw new exceptions.InvalidArgumentException();
                var key = name;

                new OBJY.ObjectOnChangeSetWrapper(skelleton, key, onChangeObj.value, onChangeObj.trigger, onChangeObj.type, context);

                context.alterSequence.push({ setOnChange: arguments });

                return skelleton;
            };

            skelleton.setOnDelete = function (name, onDeleteObj) {
                if (typeof onDeleteObj !== 'object') throw new exceptions.InvalidArgumentException();
                var key = name;

                new OBJY.ObjectOnDeleteSetWrapper(skelleton, key, onDeleteObj.value, onDeleteObj.trigger, onDeleteObj.type, context);

                context.alterSequence.push({ setOnDelete: arguments });

                return skelleton;
            };

            skelleton.setOnCreate = function (name, onCreateObj) {
                if (typeof onCreateObj !== 'object') throw new exceptions.InvalidArgumentException();
                var key = name;

                new OBJY.ObjectOnCreateSetWrapper(skelleton, key, onCreateObj.value, onCreateObj.trigger, onCreateObj.type, context);

                context.alterSequence.push({ setOnCreate: arguments });

                return skelleton;
            };

            skelleton.removeOnChange = function (name) {
                if (!skelleton.onChange[name]) throw new exceptions.HandlerNotFoundException(name);
                else delete skelleton.onChange[name];
                context.alterSequence.push({ removeOnChange: arguments });
                return skelleton;
            };

            skelleton.removeOnDelete = function (name) {
                if (!skelleton.onDelete[name]) throw new exceptions.HandlerNotFoundException(name);
                else delete skelleton.onDelete[name];
                context.alterSequence.push({ removeOnDelete: arguments });
                return skelleton;
            };

            skelleton.removeOnCreate = function (name) {
                if (!skelleton.onCreate[name]) throw new exceptions.HandlerNotFoundException(name);
                else delete skelleton.onCreate[name];
                context.alterSequence.push({ removeOnCreate: arguments });
                return skelleton;
            };

            skelleton.setPermission = function (name, permission) {
                var perm = {};
                perm[name] = permission;
                permission = perm;

                new OBJY.ObjectPermissionSetWrapper(skelleton, permission, context);
                context.alterSequence.push({ setPermission: arguments });
                return skelleton;
            };

            skelleton.removePermission = function (permission) {
                new OBJY.ObjectPermissionRemoveWrapper(skelleton, permission, context);
                context.alterSequence.push({ removePermission: arguments });
                return skelleton;
            };

            skelleton.setPropertyValue = function (property, value, client) {
                new OBJY.PropertySetWrapper(skelleton, property, value, context, params);
                context.alterSequence.push({ setPropertyValue: arguments });

                return skelleton;
            };

            skelleton.setProperty = function (property, value, client) {
                new OBJY.PropertySetFullWrapper(skelleton, property, value, context, false, params);
                context.alterSequence.push({ setProperty: arguments });
                return skelleton;
            };

            skelleton.makeProperty = function (property, value, client) {
                new OBJY.PropertySetFullWrapper(skelleton, property, value, context, true, params);
                context.alterSequence.push({ makeProperty: arguments });
                return skelleton;
            };

            skelleton.setEventDate = function (property, value, client) {
                var propertyKey = Object.keys(property)[0];
                if (propertyKey.indexOf('.') != -1) {
                    var lastDot = propertyKey.lastIndexOf('.');
                    var bag = propertyKey.substring(0, lastDot);
                    var newProKey = propertyKey.substring(lastDot + 1, propertyKey.length);
                    var newProp = {};
                    skelleton.setBagEventDate(bag, newProKey, value, client);
                    return;
                }

                new OBJY.EventDateSetWrapper(skelleton, property, value, client, context, params);
                context.alterSequence.push({ setEventDate: arguments });
                return skelleton;
            };

            skelleton.setEventAction = function (property, value, client) {
                var propertyKey = Object.keys(property)[0];
                if (propertyKey.indexOf('.') != -1) {
                    var lastDot = propertyKey.lastIndexOf('.');
                    var bag = propertyKey.substring(0, lastDot);
                    var newProKey = propertyKey.substring(lastDot + 1, propertyKey.length);
                    var newProp = {};
                    skelleton.setBagEventAction(bag, newProKey, value, client);
                    return;
                }

                new OBJY.EventActionSetWrapper(skelleton, property, value, client, context, params);
                context.alterSequence.push({ setEventAction: arguments });
                return skelleton;
            };

            skelleton.setEventTriggered = function (property, value, client) {
                var propertyKey = Object.keys(property)[0];
                if (propertyKey.indexOf('.') != -1) {
                    var lastDot = propertyKey.lastIndexOf('.');
                    var bag = propertyKey.substring(0, lastDot);
                    var newProKey = propertyKey.substring(lastDot + 1, propertyKey.length);
                    var newProp = {};
                    skelleton.setBagEventTriggered(bag, newProKey, value, client);
                    return;
                }

                new OBJY.EventTriggeredSetWrapper(skelleton, property, value, client, context, params);
                context.alterSequence.push({ setEventTriggered: arguments });
                return skelleton;
            };

            skelleton.setEventLastOccurence = function (property, value, client) {
                var propertyKey = Object.keys(property)[0];
                if (propertyKey.indexOf('.') != -1) {
                    var lastDot = propertyKey.lastIndexOf('.');
                    var bag = propertyKey.substring(0, lastDot);
                    var newProKey = propertyKey.substring(lastDot + 1, propertyKey.length);
                    var newProp = {};
                    skelleton.setBagEventLastOccurence(bag, newProKey, value, client);
                    return;
                }

                new OBJY.EventLastOccurenceSetWrapper(skelleton, property, value, client, params);
                context.alterSequence.push({ setEventLastOccurence: arguments });
                return skelleton;
            };

            skelleton.setEventInterval = function (property, value, client) {
                var propertyKey = Object.keys(property)[0];
                if (propertyKey.indexOf('.') != -1) {
                    var lastDot = propertyKey.lastIndexOf('.');
                    var bag = propertyKey.substring(0, lastDot);
                    var newProKey = propertyKey.substring(lastDot + 1, propertyKey.length);
                    var newProp = {};
                    skelleton.setBagEventInterval(bag, newProKey, value, client);
                    return;
                }

                new OBJY.EventIntervalSetWrapper(skelleton, property, value, client, context, params);
                context.alterSequence.push({ setEventInterval: arguments });
                return skelleton;
            };

            skelleton.pushToArray = function (array, value) {
                var propKey = Object.keys(value)[0];
                var tmpProp = {};
                var tmpName;
                tmpName = shortid.generate();

                tmpProp[tmpName] = value[propKey];

                skelleton.addPropertyToBag(array, tmpProp);
                context.alterSequence.push({ pushToArray: arguments });
            };

            skelleton.setPropertyPermission = function (property, name, permission) {
                var perm = {};
                perm[name] = permission;
                permission = perm;

                new OBJY.PropertyPermissionSetWrapper(skelleton, property, permission, context, params);
                context.alterSequence.push({ setPropertyPermission: arguments });
                return skelleton;
            };

            skelleton.setPropertyOnCreate = function (property, name, onCreateObj) {
                if (typeof onCreateObj !== 'object') throw new exceptions.InvalidArgumentException();
                var key = name;

                new OBJY.PropertyOnCreateSetWrapper(skelleton, property, key, onCreateObj.value, onCreateObj.trigger, onCreateObj.type, context, params);
                context.alterSequence.push({ setPropertyOnCreate: arguments });
                return skelleton;
            };

            skelleton.removePropertyOnCreate = function (propertyName, handlerName) {
                if (propertyName.indexOf('.') != -1) {
                    skelleton.removePropertyOnCreateFromBag(propertyName, handlerName);
                    return;
                } else {
                    if (!skelleton[propertyName]) throw new exceptions.NoSuchPropertyException(propertyName);
                    if (!skelleton[propertyName].onCreate) throw new exceptions.NoOnCreateException(); // CHANGE!!!
                    if (!skelleton[propertyName].onCreate[handlerName]) throw new exceptions.NoOnCreateException(); // CHANGE!!!
                    delete skelleton[propertyName].onCreate[propertyName];
                }

                context.alterSequence.push({ removePropertyOnCreate: arguments });

                return skelleton;
            };

            skelleton.removePropertyOnCreateFromBag = function (property, handlerName) {
                var bag = skelleton.getProperty(property);
                if (skelleton.role == 'template') {
                }
                new OBJY.PropertyBagItemOnCreateRemover(skelleton, property, handlerName);
                context.alterSequence.push({ removePropertyOnCreateFromBag: arguments });
                return skelleton;
            };

            skelleton.setPropertyMeta = function (property, meta) {
                new OBJY.PropertyMetaSetWrapper(skelleton, property, meta, params);
                context.alterSequence.push({ setPropertyMeta: arguments });
                return skelleton;
            };

            skelleton.removePropertyMetaFromBag = function (property) {
                var bag = skelleton.getProperty(property);
                if (skelleton.role == 'template') {
                }
                new OBJY.PropertyBagItemMetaRemover(skelleton, property);

                return skelleton;
            };

            skelleton.removePropertyMeta = function (propertyName) {
                if (propertyName.indexOf('.') != -1) {
                    skelleton.removePropertyMetaFromBag(propertyName);
                    return;
                } else {
                    if (!skelleton[propertyName]) throw new exceptions.NoSuchPropertyException(propertyName);
                    if (!skelleton[propertyName].meta) throw new exceptions.NoMetaException(); // CHANGE!!!
                    delete skelleton[propertyName].meta;
                }

                context.alterSequence.push({ removePropertyMeta: arguments });
                return skelleton;
            };

            skelleton.setPropertyOnChange = function (property, name, onChangeObj) {
                if (typeof onChangeObj !== 'object') throw new exceptions.InvalidArgumentException();
                var key = name; //Object.keys(onChangeObj)[0];

                new OBJY.PropertyOnChangeSetWrapper(skelleton, property, key, onChangeObj.value, onChangeObj.trigger, onChangeObj.type, context, params);
                context.alterSequence.push({ setPropertyOnChange: arguments });
                return skelleton;
            };

            skelleton.removePropertyOnChange = function (propertyName, name) {
                if (propertyName.indexOf('.') != -1) {
                    skelleton.removePropertyOnChangeFromBag(propertyName, name);
                    return;
                } else {
                    if (!skelleton[propertyName]) throw new exceptions.NoSuchPropertyException(propertyName);
                    if (!skelleton[propertyName].onDelete[name]) throw new exceptions.HandlerNotFoundException(name); // CHANGE!!!
                    delete skelleton[propertyName][name];
                }

                context.alterSequence.push({ removePropertyOnChange: arguments });
                return skelleton;
            };

            skelleton.removePropertyOnChangeFromBag = function (property, name) {
                var bag = skelleton.getProperty(property);

                new OBJY.PropertyBagItemOnChangeRemover(skelleton, property, name);

                return skelleton;
            };

            skelleton.setPropertyOnDelete = function (property, name, onDeleteObj) {
                if (typeof onDeleteObj !== 'object') throw new exceptions.InvalidArgumentException();
                var key = name;

                new OBJY.PropertyOnDeleteSetWrapper(skelleton, property, key, onDeleteObj.value, onDeleteObj.trigger, onDeleteObj.type, context, params);
                context.alterSequence.push({ setPropertyOnDelete: arguments });
                return skelleton;
            };

            skelleton.removePropertyOnDelete = function (propertyName, name) {
                if (propertyName.indexOf('.') != -1) {
                    skelleton.removePropertyOnDeleteFromBag(propertyName, name);
                    return;
                } else {
                    if (!skelleton[propertyName]) throw new exceptions.NoSuchPropertyException(propertyName);
                    if (!skelleton[propertyName].onDelete[name]) throw new exceptions.HandlerNotFoundException(name); // CHANGE!!!
                    delete skelleton[propertyName].onDelete[name];
                }

                context.alterSequence.push({ removePropertyOnDelete: arguments });
                return skelleton;
            };

            skelleton.removePropertyOnDeleteFromBag = function (property, name) {
                var bag = skelleton.getProperty(property);

                new OBJY.PropertyBagItemOnDeleteRemover(skelleton, property, name);

                return skelleton;
            };

            skelleton.setPropertyConditions = function (property, conditions) {
                var propertyKey = Object.keys(property)[0];
                if (propertyKey.indexOf('.') != -1) {
                    var lastDot = propertyKey.lastIndexOf('.');
                    var bag = propertyKey.substring(0, lastDot);
                    var newProKey = propertyKey.substring(lastDot + 1, propertyKey.length);
                    var newProp = {};
                    skelleton.setBagPropertyConditions(bag, newProKey, conditions);
                    return;
                }
                new OBJY.PropertyConditionsSetWrapper(skelleton, property, conditions, params);
                context.alterSequence.push({ setPropertyConditions: arguments });
                return skelleton;
            };

            skelleton.setBagPropertyConditions = function (bag, property, conditions) {
                new OBJY.PropertyConditionsSetWrapper(skelleton.getProperty(bag), property, conditions, params);
                return skelleton;
            };

            skelleton.setBagPropertyPermission = function (bag, property, permission) {
                new OBJY.PropertyPermissionSetWrapper(skelleton.getProperty(bag), property, permission, params);
                return skelleton;
            };

            skelleton.setPropertyQuery = function (property, options) {
                var propertyKey = Object.keys(property)[0];
                if (propertyKey.indexOf('.') != -1) {
                    var lastDot = propertyKey.lastIndexOf('.');
                    var bag = propertyKey.substring(0, lastDot);
                    var newProKey = propertyKey.substring(lastDot + 1, propertyKey.length);
                    var newProp = {};
                    skelleton.setBagPropertyQuery(bag, newProKey, value);
                    return;
                }
                new OBJY.PropertyQuerySetWrapper(skelleton, property, options, params);
                context.alterSequence.push({ setPropertyQuery: arguments });
                return skelleton;
            };

            /*skelleton.setPropertyEventInterval = function(property, interval) {
                var propertyKey = Object.keys(property)[0];
                if (propertyKey.indexOf('.') != -1) {
                    var lastDot = propertyKey.lastIndexOf(".");
                    var bag = propertyKey.substring(0, lastDot);
                    var newProKey = propertyKey.substring(lastDot + 1, propertyKey.length);
                    var newProp = {};
                    skelleton.setBagPropertyEventInterval(bag, newProKey, value);
                    return;
                }
                new OBJY.PropertyEventIntervalSetWrapper(skelleton, property, interval, context);
                return skelleton;
            };*/

            skelleton.removePropertyQuery = function (propertyName) {
                if (propertyName.indexOf('.') != -1) {
                    skelleton.removePropertyQueryFromBag(propertyName);
                    return;
                } else {
                    if (!skelleton[propertyName]) throw new exceptions.NoSuchPropertyException(propertyName);
                    if (!skelleton[propertyName].query) throw new exceptions.NoSuchPermissionException(permissionKey); // CHANGE!!!
                    delete skelleton[propertyName].query;
                }

                context.alterSequence.push({ removePropertyQuery: arguments });

                return skelleton;
            };

            skelleton.removePropertyQueryFromBag = function (property) {
                var bag = skelleton.getProperty(property);

                new OBJY.PropertyBagItemQueryRemover(skelleton, property);
                return skelleton;
            };

            skelleton.removePropertyConditions = function (propertyName) {
                if (propertyName.indexOf('.') != -1) {
                    skelleton.removePropertyConditionsFromBag(propertyName);
                    return;
                } else {
                    if (!skelleton[propertyName]) throw new exceptions.NoSuchPropertyException(propertyName);
                    if (!skelleton[propertyName].conditions) throw new exceptions.NoSuchPermissionException(permissionKey); // CHANGE!!!
                    delete skelleton[propertyName].conditions;
                }

                return skelleton;
            };

            skelleton.removePropertyConditionsFromBag = function (property) {
                var bag = skelleton.getProperty(property);

                new OBJY.PropertyBagItemConditionsRemover(skelleton, property);
                return skelleton;
            };

            skelleton.setBagPropertyQuery = function (bag, property, options) {
                // @TODO ...
                //new OBJY.setBagPropertyQuery(skelleton.getProperty(bag), property, permoptionsission);
                return skelleton;
            };

            skelleton.removePropertyPermission = function (propertyName, permissionKey) {
                if (propertyName.indexOf('.') != -1) {
                    skelleton.removePropertyPermissionFromBag(propertyName, permissionKey);
                    return;
                } else {
                    if (!skelleton[propertyName]) throw new exceptions.NoSuchPropertyException(propertyName);
                    if (!skelleton[propertyName].permissions[permissionKey]) throw new exceptions.NoSuchPermissionException(permissionKey);

                    OBJY.chainPermission(skelleton, context, 'x', 'removePropertyPermission', permissionKey);

                    context.alterSequence.push({ removePropertyPermission: arguments });

                    delete skelleton[propertyName].permissions[permissionKey];
                }

                return skelleton;
            };

            skelleton.setBagPropertyValue = function (bag, property, value, client) {
                new OBJY.PropertySetWrapper(skelleton.getProperty(bag), property, value, context, params);
                return skelleton;
            };

            skelleton.setBagEventDate = function (bag, property, value, client) {
                new OBJY.EventDateSetWrapper(skelleton.getProperty(bag), property, value, context, params);
                return skelleton;
            };

            skelleton.setBagEventAction = function (bag, property, value, client) {
                new OBJY.EventActionSetWrapper(skelleton.getProperty(bag), property, value, context, params);
                return skelleton;
            };

            skelleton.setBagEventInterval = function (bag, property, value, client) {
                new OBJY.EventIntervalSetWrapper(skelleton.getProperty(bag), property, value, context, params);
                return skelleton;
            };

            skelleton.setBagEventTriggered = function (bag, property, value, client) {
                new OBJY.EventTriggeredSetWrapper(skelleton, property, value, client, context, params);
                return skelleton;
            };

            skelleton.setBagEventLastOccurence = function (bag, property, value, client) {
                new OBJY.EventLastOccurenceSetWrapper(skelleton.getProperty(bag), property, value, client, params);
                return skelleton;
            };

            skelleton.addPropertyToBag = function (bag, property) {
                var tmpBag = skelleton.getProperty(bag);

                new OBJY.PropertyCreateWrapper(tmpBag, property, true, context, params, true);

                return skelleton;
            };

            skelleton.removePropertyFromBag = function (property, client) {
                var bag = skelleton.getProperty(property);

                new OBJY.PropertyBagItemRemover(skelleton, property, params, context);
                return skelleton;
            };

            skelleton.removePropertyPermissionFromBag = function (property, permissionKey) {
                var bag = skelleton.getProperty(property);

                new OBJY.PropertyBagItemPermissionRemover(skelleton, property, permissionKey, context);
                return skelleton;
            };

            skelleton.removeProperty = function (propertyName, client) {
                var skelletonRef = skelleton;

                if (propertyName.indexOf('.') != -1) {
                    skelleton.removePropertyFromBag(propertyName, client);
                    context.alterSequence.push({ removeProperty: arguments });
                    return skelleton;
                } else {
                    if (!skelletonRef[propertyName]) throw new exceptions.NoSuchPropertyException(propertyName);

                    var tmpProp = Object.assign({}, skelletonRef[propertyName]);

                    if (tmpProp.onDelete) {
                        if (Object.keys(tmpProp.onDelete).length > 0) {
                            if (!context.handlerSequence[skelleton._id]) context.handlerSequence[skelleton._id] = {};
                            if (!context.handlerSequence[skelleton._id].onDelete) context.handlerSequence[skelleton._id].onDelete = [];
                            context.handlerSequence[skelleton._id].onDelete.push({
                                handler: tmpProp.onDelete,
                                prop: tmpProp,
                            });
                        }
                    }

                    OBJY.chainPermission(skelletonRef[propertyName], context, 'd', 'removeProperty', propertyName);

                    context.alterSequence.push({ removeProperty: arguments });

                    /*if (skelleton[propertyName].type == 'date') context.eventAlterationSequence.push({
                        operation: 'remove',
                        obj: skelleton,
                        propName: propertyName,
                        date: date
                    })*/

                    delete skelletonRef[propertyName];
                }

                return skelleton;
            };

            skelleton.getId = function () {
                return skelleton._id;
            };

            skelleton.getName = function () {
                return skelleton.name;
            };

            skelleton.setName = function (name) {
                skelleton.name = name;

                OBJY.chainPermission(skelleton, context, 'n', 'setName', name);

                context.alterSequence.push({ setName: arguments });

                return skelleton;
            };

            skelleton.setType = function (type) {
                skelleton.type = type;
                OBJY.chainPermission(skelleton, context, 't', 'setType', type);
                context.alterSequence.push({ setType: arguments });
                return skelleton;
            };

            skelleton.getType = function () {
                return skelleton.type;
            };

            skelleton.getRef = function (propertyName) {
                return new OBJY.PropertyRefParser(skelleton, propertyName);
            };

            skelleton.getProperty = function (propertyName) {
                return OBJY.PropertyParser(skelleton, propertyName, context, params);
            };

            skelleton.getProperties = function () {
                return skelleton;
            };

            skelleton.add = function (success, error, client) {
                return new Promise((resolve, reject) => {
                    var client = client || context.activeTenant;
                    var app = context.activeApp;
                    var user = context.activeUser;

                    var skelletonRef = skelleton;

                    //OBJY.applyAffects(skelletonRef, 'onCreate', context, client);

                    if (!OBJY.checkAuthroisations(skelleton, user, 'c', app, context)) return error({ error: 'Lack of Permissions' });

                    if (!skelleton._id) skelleton._id = OBJY.ID();

                    if (params.dirty) {
                        var constraints = OBJY.checkConstraints(obj);
                        if (Array.isArray(constraints) && error) {
                            return error({
                                message: 'constraints error: ' + constraints.join(','),
                            });
                        }

                        OBJY.add(
                            skelletonRef,
                            function (data) {
                                skelletonRef._id = data._id;

                                OBJY.deSerializePropsObject(data, params);

                                if (success) success(OBJY.deserialize(data));
                                else {
                                    resolve(OBJY.deserialize(data));
                                }

                                delete skelletonRef.context;
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

                        return OBJY.deserialize(skelleton);
                    }

                    if (skelletonRef.onCreate) {
                        Object.keys(skelletonRef.onCreate).forEach(function (key) {
                            if (skelletonRef.onCreate[key].trigger == 'before' || !skelletonRef.onCreate[key].trigger) {
                                context.execProcessorAction(
                                    skelletonRef.onCreate[key].value || skelletonRef.onCreate[key].action,
                                    skelletonRef,
                                    null,
                                    null,
                                    function (data) {},
                                    client,
                                    null
                                );
                            }
                        });
                    }

                    skelleton.created = moment().utc().toDate().toISOString();
                    skelleton.lastModified = moment().utc().toDate().toISOString();

                    skelletonRef._aggregatedEvents = [];

                    function aggregateAllEvents(props, prePropsString) {
                        Object.keys(props).forEach(function (p) {
                            if (!isObject(props[p])) return;

                            //if (props[p].type == CONSTANTS.PROPERTY.TYPE_PROPERTY_BAG){
                                if (prePropsString) {
                                    aggregateAllEvents(props[p], prePropsString + '.' + p);
                                } else {
                                    aggregateAllEvents(props[p], p)

                                }
                            //}


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
                                    context.eventAlterationSequence.push({
                                        operation: 'add',
                                        obj: skelletonRef,
                                        propName: prePropsString + '.' + p,
                                        property: props[p],
                                        date: date,
                                    });

                                    var found = false;
                                    skelletonRef._aggregatedEvents.forEach(function (aE) {
                                        if (aE.propName == prePropsString + '.' + p) found = true;
                                    });

                                    if (!found && props[p].triggered != true)
                                        skelletonRef._aggregatedEvents.push({
                                            propName: prePropsString + '.' + p,
                                            date: date,
                                        });
                                } else {

                                    context.eventAlterationSequence.push({
                                        operation: 'add',
                                        obj: skelletonRef,
                                        propName: p,
                                        property: props[p],
                                        date: date,
                                    });

                                    var found = false;
                                    skelletonRef._aggregatedEvents.forEach(function (aE) {
                                        if (aE.propName == p) found = true;
                                    });

                                    
                                    if (!found && props[p].triggered != true){

                                        skelletonRef._aggregatedEvents.push({
                                            propName: p,
                                            date: date,
                                        });
                                    }
                                }
                            }
                        });
                    }

                    var mapper = context.observers[skelletonRef.role];

                    //if (skelleton) aggregateAllEvents(skelleton.properties);

                    aggregateAllEvents(skelletonRef);

                    if (app) {
                        if (!skelleton.applications) skelleton.applications = [];
                        if (skelleton.applications) if (skelleton.applications.indexOf(app) == -1) skelleton.applications.push(app);
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

                                OBJY.applyAffects(skelletonRef, 'onCreate', context, client);
                                
                                if (data.onCreate) {
                                    Object.keys(data.onCreate).forEach(function (key) {
                                        try {
                                            if (data.onCreate[key].trigger == 'after') {
                                                context.execProcessorAction(
                                                    data.onCreate[key].value || data.onCreate[key].action,
                                                    data,
                                                    null,
                                                    null,
                                                    function (data) {},
                                                    client,
                                                    null
                                                );
                                            }
                                        } catch(e){
                                            console.log(e)
                                        }

                                    });
                                }

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

                                OBJY.deSerializePropsObject(data, params);

                                if (success) success(OBJY.deserialize(data));
                                else {
                                    resolve(OBJY.deserialize(data));
                                }

                                delete skelletonRef.context;
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

                    if (params.templateMode == CONSTANTS.TEMPLATEMODES.STRICT) {
                        if (skelleton.inherits.length == 0) addFn(skelletonRef);

                        var counter = 0;
                        skelleton.inherits.forEach(function (template) {
                            if (skelletonRef._id != template) {
                                OBJY.getTemplateFieldsForObject(
                                    skelletonRef,
                                    template,
                                    function () {
                                        counter++;
                                        if (counter == skelletonRef.inherits.length) {
                                            addFn(skelletonRef);
                                            return skelleton;
                                        }
                                    },
                                    function (err) {
                                        if (error) error(skelletonRef);
                                        else {
                                            reject(skelletonRef);
                                        }
                                        return skelleton;
                                    },
                                    client,
                                    params.templateFamily,
                                    params.templateSource,
                                    params
                                );
                            }
                        });
                    } else {
                        addFn(skelletonRef);
                    }
                    return OBJY.deserialize(skelleton);
                });
            };

            skelleton.update = function (success, error, client) {
                return new Promise((resolve, reject) => {
                    var client = client || context.activeTenant;
                    var app = context.activeApp;
                    var user = context.activeUser;

                    OBJY.applyAffects(skelleton, 'onChange', context, client, 'before');

                    if (!OBJY.checkAuthroisations(skelleton, user, 'u', app, context)) return error({ error: 'Lack of Permissions' });

                    var skelletonRef = skelleton;

                    if (params.dirty) {
                        var constraints = OBJY.checkConstraints(skelleton);
                        if (Array.isArray(constraints) && error) {
                            return error({
                                message: 'constraints error: ' + constraints.join(','),
                            });
                        }

                        OBJY.updateO(
                            skelletonRef,
                            function (data) {
                                delete context.handlerSequence[skelleton._id];

                                context.eventAlterationSequence = [];

                                OBJY.deSerializePropsObject(data, params);

                                context.alterSequence = [];

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
                            context
                        );

                        return OBJY.deserialize(skelleton);
                    }

                    if (!OBJY.checkPermissions(user, app, skelletonRef, 'u', false, context)) return error({ error: 'Lack of Permissions' });

                    if ((context.permissionSequence[skelletonRef._id] || []).length > 0) {
                        throw new exceptions.LackOfPermissionsException(context.permissionSequence[skelletonRef._id]);
                    }

                    if (skelletonRef.onChange) {
                        Object.keys(skelletonRef.onChange).forEach(function (key) {
                            if (skelletonRef.onChange[key].trigger == 'before') {
                                context.execProcessorAction(
                                    skelletonRef.onChange[key].value || skelletonRef.onChange[key].action,
                                    skelletonRef,
                                    null,
                                    null,
                                    function (data) {},
                                    client,
                                    null
                                );
                            }
                        });
                    }

                    if (context.handlerSequence[skelleton._id]) {
                        for (var type in context.handlerSequence[skelleton._id]) {
                            for (var item in context.handlerSequence[skelleton._id][type]) {
                                var handlerObj = context.handlerSequence[skelleton._id][type][item];

                                for (var handlerItem in handlerObj.handler) {
                                    if (handlerObj.handler[handlerItem].trigger == 'before') {
                                        context.execProcessorAction(
                                            handlerObj.handler[handlerItem].value || handlerObj.handler[handlerItem].action,
                                            skelletonRef,
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

                    skelleton.lastModified = moment().toDate().toISOString();

                    var skelletonRef = skelleton;

                    skelletonRef._aggregatedEvents = [];

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
                                    var found = false;
                                    skelletonRef._aggregatedEvents.forEach(function (aE) {
                                        if (aE.propName == prePropsString + '.' + p) found = true;
                                    });

                                    if (!found && props[p].triggered != true)
                                        skelletonRef._aggregatedEvents.push({
                                            propName: prePropsString + '.' + p,
                                            date: date,
                                        });
                                } else {
                                    var found = false;
                                    skelletonRef._aggregatedEvents.forEach(function (aE) {
                                        if (aE.propName == p) found = true;
                                    });

                                    if (!found && props[p].triggered != true)
                                        skelletonRef._aggregatedEvents.push({
                                            propName: p,
                                            date: date,
                                        });
                                }
                            }
                        });
                    }

                    var mapper = context.observers[skelletonRef.role];

                    //if (mapper.type != 'scheduled' && skelleton) aggregateAllEvents(skelleton.properties);
                    if (mapper.type != 'scheduled') aggregateAllEvents(skelleton);

                    function updateFn() {
                        var constraints = OBJY.checkConstraints(skelletonRef);
                        if (Array.isArray(constraints) && error) {
                            return error({
                                message: 'constraints error: ' + constraints.join(','),
                            });
                        }

                        OBJY.updateO(
                            skelletonRef,
                            function (data) {
                                OBJY.applyAffects(data, 'onChange', context, client, 'after');

                                if (data.onChange) {
                                    Object.keys(data.onChange).forEach(function (key) {
                                        if (data.onChange[key].trigger == 'after') {
                                            context.execProcessorAction(
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

                                if (context.handlerSequence[skelletonRef._id]) {
                                    for (var type in context.handlerSequence[skelletonRef._id]) {
                                        for (var item in context.handlerSequence[skelletonRef._id][type]) {
                                            var handlerObj = context.handlerSequence[skelletonRef._id][type][item];
                                            for (var handlerItem in handlerObj.handler) {
                                                if (handlerObj.handler[handlerItem].trigger == 'after' || !handlerObj.handler[handlerItem].trigger) {
                                                    context.execProcessorAction(
                                                        handlerObj.handler[handlerItem].value || handlerObj.handler[handlerItem].action,
                                                        skelletonRef,
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

                                delete context.handlerSequence[skelletonRef._id];

                                if (mapper.type == 'scheduled') {
                                    context.eventAlterationSequence.forEach(function (evt) {
                                        if (evt.type == 'add') {
                                            mapper.addEvent(
                                                skelletonRef._id,
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

                                if (params.templateMode == CONSTANTS.TEMPLATEMODES.STRICT) {
                                    OBJY.updateInheritedObjs(
                                        skelletonRef,
                                        params.pluralName,
                                        function (data) {},
                                        function (err) {},
                                        client,
                                        params
                                    );
                                }

                                OBJY.Logger.log('Updated Object: ' + data);
                                OBJY.deSerializePropsObject(data, params);
                                context.alterSequence = [];
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
                            context
                        );
                    }

                    if (context.commandSequence.length > 0 && params.templateMode == CONSTANTS.TEMPLATEMODES.STRICT) {
                        var found = false;
                        var foundCounter = 0;
                        context.commandSequence.forEach(function (i) {
                            if (i.name == 'addInherit' || i.name == 'removeInherit') {
                                foundCounter++;
                                found = true;
                            }
                        });

                        if (foundCounter == 0) updateFn(skelletonRef);

                        var execCounter = 0;
                        context.commandSequence.forEach(function (i) {
                            if (i.name == 'addInherit' && skelletonRef.inherits.indexOf(i.value) != -1) {
                                execCounter++;

                                OBJY.getTemplateFieldsForObject(
                                    skelletonRef,
                                    i.value,
                                    function () {
                                        if (execCounter == foundCounter) {
                                            updateFn(skelletonRef);
                                        }
                                    },
                                    function (err) {
                                        if (error) error(skelletonRef);
                                        else {
                                            reject(skelletonRef);
                                        }
                                        return skelletonRef;
                                    },
                                    client,
                                    params.templateFamily,
                                    params.templateSource,
                                    params,
                                    context
                                );
                            }

                            if (i.name == 'removeInherit' && skelletonRef.inherits.indexOf(i.value) == -1) {
                                execCounter++;
                                OBJY.removeTemplateFieldsForObject(
                                    skelletonRef,
                                    i.value,
                                    function () {
                                        if (execCounter == foundCounter) {
                                            updateFn(skelletonRef);
                                        }
                                    },
                                    function (err) {
                                        if (error) error(skelletonRef);
                                        else {
                                            reject(skelletonRef);
                                        }
                                        return skelletonRef;
                                    },
                                    client,
                                    params,
                                    context
                                );
                            }
                        });
                    } else updateFn(skelletonRef);

                    context.commandSequence = [];

                    return OBJY.deserialize(skelleton);
                });
            };

            skelleton.remove = function (success, error, client) {
                return new Promise((resolve, reject) => {
                    var client = client || context.activeTenant;
                    var app = context.activeApp;
                    var user = context.activeUser;

                    var skelletonRef = JSON.parse(JSON.stringify(skelleton));

                    OBJY.applyAffects(skelletonRef, 'onDelete', context, client);

                    if (params.dirty) {
                        OBJY.getObjectById(
                            skelleton.role,
                            skelleton._id,
                            function (data) {
                                if (!OBJY.checkAuthroisations(data, user, 'd', app, context)) return error({ error: 'Lack of Permissions' });

                                return OBJY.remove(
                                    skelletonRef,
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
                            context,
                            params
                        );

                        return OBJY.deserialize(skelleton);
                    }

                    if (!OBJY.checkPermissions(user, app, skelletonRef, 'd', false, context)) return error({ error: 'Lack of Permissions' });

                    if (skelletonRef.onDelete) {
                        Object.keys(skelletonRef.onDelete).forEach(function (key) {
                            if (skelletonRef.onDelete[key].trigger == 'before') {
                                context.execProcessorAction(
                                    skelletonRef.onDelete[key].value || skelletonRef.onDelete[key].action,
                                    skelletonRef,
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
                        skelleton.role,
                        skelleton._id,
                        function (data) {
                            return OBJY.remove(
                                skelletonRef,
                                function (_data) {
                                    OBJY.applyAffects(data, 'onDelete', context, client);

                                    if (skelletonRef.onDelete) {
                                        Object.keys(skelletonRef.onDelete).forEach(function (key) {
                                            if (skelletonRef.onDelete[key].trigger == 'after') {
                                                context.execProcessorAction(
                                                    skelletonRef.onDelete[key].value || skelletonRef.onDelete[key].action,
                                                    skelletonRef,
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
                                                    context.eventAlterationSequence.push({
                                                        operation: 'remove',
                                                        obj: skelletonRef,
                                                        propName: prePropsString + '.' + p,
                                                        date: date,
                                                    });

                                                    var found = false;
                                                } else {
                                                    context.eventAlterationSequence.push({
                                                        operation: 'remove',
                                                        obj: skelletonRef,
                                                        propName: p,
                                                        date: date,
                                                    });
                                                }
                                            }
                                        });
                                    }

                                    var mapper = context.observers[skelletonRef.role];

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

                                    if (params.templateMode == CONSTANTS.TEMPLATEMODES.STRICT) {
                                        OBJY.removeInheritedObjs(
                                            skelletonRef,
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

                    return OBJY.deserialize(skelleton);
                });
            };

            skelleton.get = function (success, error, dontInherit) {
                return new Promise((resolve, reject) => {
                    var client = context.activeTenant;
                    var app = context.activeApp;
                    var user = context.activeUser;

                    var skelletonRef = skelleton;

                    if (params.dirty) {
                        OBJY.getObjectById(
                            skelletonRef.role,
                            skelletonRef._id,
                            function (data) {
                                OBJY.deSerializePropsObject(data, params);
                                if (!OBJY.checkAuthroisations(data, user, 'r', app, context)) return error({ error: 'Lack of Permissions' });

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
                            context,
                            params
                        );

                        return OBJY.deserialize(skelleton);
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

                        OBJY.applyAffects(data, null, context, client);

                        if (!OBJY.checkAuthroisations(returnObject, user, 'r', app, context))
                            return error({ error: 'Lack of Permissions', source: 'authorisations' });

                        if (!OBJY.checkPermissions(user, app, data, 'r', false, context))
                            return error({ error: 'Lack of Permissions', source: 'permissions' });

                        if (dontInherit) {
                            if (success) success(returnObject);
                            else {
                                resolve(returnObject);
                            }
                            return data;
                        }

                        if (params.templateMode == CONSTANTS.TEMPLATEMODES.STRICT) {
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
                                    context
                                );
                            } else {
                                var returnObject = OBJY[data.role](OBJY.deserialize(data));

                                if (skelletonRef.inherits.length == 1) {
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

                    if (context.caches[skelletonRef.role].data[skelletonRef._id]) {
                        prepareObj(context.caches[skelletonRef.role].data[skelletonRef._id]);
                    } else {
                        OBJY.getObjectById(
                            skelletonRef.role,
                            skelletonRef._id,
                            function (data) {
                                prepareObj(data);

                                if (!context.caches[skelletonRef.role].data[skelletonRef._id]) {
                                    //context.caches[skelletonRef.role].add(skelletonRef._id, data);
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
                            context,
                            params
                        );
                    }

                    return OBJY.deserialize(skelleton);
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
                    skelleton.update();
                    return true;
                },

                deleteProperty: (obj, prop, value) => {
                    delete obj[prop];
                    skelleton.update();
                    return true;
                },
            };

            if (!params.storage) {
                skelleton.add();
                var skelletonRef = skelleton;
                (skelleton.inherits || []).forEach(function (template) {
                    OBJY.getTemplateFieldsForObject(
                        skelletonRef,
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

                return new Proxy(skelleton, validator);
            }
            return OBJY.deserialize(skelleton);
        },
    };
};
