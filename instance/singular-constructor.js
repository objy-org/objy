import moment from 'moment';

if (typeof moment == 'object') {
    moment = moment.default;
}

import CONSTANTS from '../lib/dependencies/constants.js';
import exceptions from '../lib/dependencies/exceptions.js';

var isObject = function (a) {
    return !!a && a.constructor === Object;
};

export default function(OBJY) {
    return {
        Obj: function (obj, role, context, params) {
            if (OBJY.metaPropPrefix != '' && typeof obj !== 'string') obj = OBJY.serialize(obj);

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

                    return this;
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
                    var newProp = {};
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
                    var newProp = {};
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
                    var newProp = {};
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
                    var newProp = {};
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
                    var newProp = {};
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
                var bag = this.getProperty(property);
                if (this.role == 'template') {
                }
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
                var bag = this.getProperty(property);
                if (this.role == 'template') {
                }
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
                var bag = this.getProperty(property);

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
                var bag = this.getProperty(property);

                new OBJY.PropertyBagItemOnDeleteRemover(this, property, name);

                return this;
            };

            Object.getPrototypeOf(this).setPropertyConditions = function (property, conditions) {
                var propertyKey = Object.keys(property)[0];
                if (propertyKey.indexOf('.') != -1) {
                    var lastDot = propertyKey.lastIndexOf('.');
                    var bag = propertyKey.substring(0, lastDot);
                    var newProKey = propertyKey.substring(lastDot + 1, propertyKey.length);
                    var newProp = {};
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
                    var newProp = {};
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
                var bag = this.getProperty(property);

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
                var bag = this.getProperty(property);

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
                var bag = this.getProperty(property);

                new OBJY.PropertyBagItemRemover(this, property, params, context);
                return this;
            };

            Object.getPrototypeOf(this).removePropertyPermissionFromBag = function (property, permissionKey) {
                var bag = this.getProperty(property);

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

                    //OBJY.applyAffects(thisRef, 'onCreate', context, client);

                    if (!OBJY.checkAuthroisations(this, user, 'c', app, context)) return error({ error: 'Lack of Permissions' });

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

                                delete thisRef.context;
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
                                OBJY.execProcessorAction(
                                    thisRef.onCreate[key].value || thisRef.onCreate[key].action,
                                    thisRef,
                                    null,
                                    null,
                                    function (data) {},
                                    context,
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

                                OBJY.applyAffects(thisRef, 'onCreate', context, client);
                                
                                if (data.onCreate) {
                                    Object.keys(data.onCreate).forEach(function (key) {
                                        try {
                                            if (data.onCreate[key].trigger == 'after') {
                                                OBJY.execProcessorAction(
                                                    data.onCreate[key].value || data.onCreate[key].action,
                                                    data,
                                                    null,
                                                    null,
                                                    function (data) {},
                                                    context,
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

                                //delete thisRef.context;
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
                    var client = client || context.activeTenant;
                    var app = context.activeApp;
                    var user = context.activeUser;

                    OBJY.applyAffects(this, 'onChange', context, client, 'before');

                    if (!OBJY.checkAuthroisations(this, user, 'u', app, context)) return error({ error: 'Lack of Permissions' });

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
                                delete context.handlerSequence[this._id];

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

                        return OBJY.deserialize(this);
                    }

                    if (!OBJY.checkPermissions(user, app, thisRef, 'u', false, context)) return error({ error: 'Lack of Permissions' });

                    if ((context.permissionSequence[thisRef._id] || []).length > 0) {
                        throw new exceptions.LackOfPermissionsException(context.permissionSequence[thisRef._id]);
                    }

                    if (thisRef.onChange) {
                        Object.keys(thisRef.onChange).forEach(function (key) {
                            if (thisRef.onChange[key].trigger == 'before') {
                                OBJY.execProcessorAction(
                                    thisRef.onChange[key].value || thisRef.onChange[key].action,
                                    thisRef,
                                    null,
                                    null,
                                    function (data) {},
                                    context,
                                    client,
                                    null
                                );
                            }
                        });
                    }

                    if (context.handlerSequence[this._id]) {
                        for (var type in context.handlerSequence[this._id]) {
                            for (var item in context.handlerSequence[this._id][type]) {
                                var handlerObj = context.handlerSequence[this._id][type][item];

                                for (var handlerItem in handlerObj.handler) {
                                    if (handlerObj.handler[handlerItem].trigger == 'before') {
                                        OBJY.execProcessorAction(
                                            handlerObj.handler[handlerItem].value || handlerObj.handler[handlerItem].action,
                                            thisRef,
                                            handlerObj.prop,
                                            null,
                                            function (data) {},
                                            context,
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
                                OBJY.applyAffects(data, 'onChange', context, client, 'after');

                                if (data.onChange) {
                                    Object.keys(data.onChange).forEach(function (key) {
                                        if (data.onChange[key].trigger == 'after') {
                                            OBJY.execProcessorAction(
                                                data.onChange[key].value || data.onChange[key].action,
                                                data,
                                                null,
                                                null,
                                                function (data) {},
                                                context,
                                                client,
                                                null
                                            );
                                        }
                                    });
                                }

                                if (context.handlerSequence[thisRef._id]) {
                                    for (var type in context.handlerSequence[thisRef._id]) {
                                        for (var item in context.handlerSequence[thisRef._id][type]) {
                                            var handlerObj = context.handlerSequence[thisRef._id][type][item];
                                            for (var handlerItem in handlerObj.handler) {
                                                if (handlerObj.handler[handlerItem].trigger == 'after' || !handlerObj.handler[handlerItem].trigger) {
                                                    OBJY.execProcessorAction(
                                                        handlerObj.handler[handlerItem].value || handlerObj.handler[handlerItem].action,
                                                        thisRef,
                                                        handlerObj.prop,
                                                        null,
                                                        function (data) {},
                                                        context,
                                                        client,
                                                        null
                                                    );
                                                }
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

                                if (params.templateMode == CONSTANTS.TEMPLATEMODES.STRICT) {
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

                        if (foundCounter == 0) updateFn(thisRef);

                        var execCounter = 0;
                        context.commandSequence.forEach(function (i) {
                            if (i.name == 'addInherit' && thisRef.inherits.indexOf(i.value) != -1) {
                                execCounter++;

                                OBJY.getTemplateFieldsForObject(
                                    thisRef,
                                    i.value,
                                    function () {
                                        if (execCounter == foundCounter) {
                                            updateFn(thisRef);
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
                                            updateFn(thisRef);
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
                    } else updateFn(thisRef);

                    context.commandSequence = [];

                    return OBJY.deserialize(this);
                });
            };

            Object.getPrototypeOf(this).remove = function (success, error, client) {
                return new Promise((resolve, reject) => {
                    var client = client || context.activeTenant;
                    var app = context.activeApp;
                    var user = context.activeUser;

                    var thisRef = JSON.parse(JSON.stringify(this));

                    OBJY.applyAffects(thisRef, 'onDelete', context, client);

                    if (params.dirty) {
                        OBJY.getObjectById(
                            this.role,
                            this._id,
                            function (data) {
                                if (!OBJY.checkAuthroisations(data, user, 'd', app, context)) return error({ error: 'Lack of Permissions' });

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
                            context,
                            params
                        );

                        return OBJY.deserialize(this);
                    }

                    if (!OBJY.checkPermissions(user, app, thisRef, 'd', false, context)) return error({ error: 'Lack of Permissions' });

                    if (thisRef.onDelete) {
                        Object.keys(thisRef.onDelete).forEach(function (key) {
                            if (thisRef.onDelete[key].trigger == 'before') {
                                OBJY.execProcessorAction(
                                    thisRef.onDelete[key].value || thisRef.onDelete[key].action,
                                    thisRef,
                                    null,
                                    null,
                                    function (data) {},
                                    context,
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
                                    OBJY.applyAffects(data, 'onDelete', context, client);

                                    if (thisRef.onDelete) {
                                        Object.keys(thisRef.onDelete).forEach(function (key) {
                                            if (thisRef.onDelete[key].trigger == 'after') {
                                                OBJY.execProcessorAction(
                                                    thisRef.onDelete[key].value || thisRef.onDelete[key].action,
                                                    thisRef,
                                                    null,
                                                    null,
                                                    function (data) {},
                                                    context,
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
                                                        obj: thisRef,
                                                        propName: prePropsString + '.' + p,
                                                        date: date,
                                                    });

                                                    var found = false;
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

                                    var mapper = context.observers[thisRef.role];

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

                    return OBJY.deserialize(this);
                });
            };

            Object.getPrototypeOf(this).get = function (success, error, dontInherit) {
                return new Promise((resolve, reject) => {
                    var client = context.activeTenant;
                    var app = context.activeApp;
                    var user = context.activeUser;

                    var thisRef = this;

                    if (params.dirty) {
                        OBJY.getObjectById(
                            thisRef.role,
                            thisRef._id,
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

                    if (OBJY.caches[thisRef.role].data[thisRef._id]) {
                        prepareObj(OBJY.caches[thisRef.role].data[thisRef._id]);
                    } else {
                        OBJY.getObjectById(
                            thisRef.role,
                            thisRef._id,
                            function (data) {
                                prepareObj(data);

                                if (!OBJY.caches[thisRef.role].data[thisRef._id]) {
                                    //context.caches[thisRef.role].add(thisRef._id, data);
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

                    return OBJY.deserialize(this);
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

            return OBJY.deserialize(this);
        },
    };
};
