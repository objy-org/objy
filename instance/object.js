var exceptions = require('../lib/dependencies/exceptions.js')

module.exports = function(OBJY) {
    return {

        updateInheritedObjs: function(templ, pluralName, success, error, client, params) {
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

            }, client, {})
        },


        prepareObjectDelta: function(oldObj, newObj, params) {

            var meta = ['name', 'type'];
            meta.forEach(function(p) {
                if (newObj[p] != oldObj[p]) oldObj[p] = newObj[p];
            })


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

                var propsObj = obj[params.propsObject] || obj;

                Object.keys(propsObj).forEach(function(p) {

                    if (propsObj[p].type == 'bag') {
                        doTheProps(propsObj[p]);
                    }

                    if (propsObj[p]) {
                        if (propsObj[p].template && oldObj[p]) {

                            if (propsObj[p].value != oldObj[p].value) {

                                oldObj[p].value = propsObj[p].value;
                                oldObj[p].overwritten = true;
                            }

                            if (propsObj[p].action != oldObj[p].action) {

                                oldObj[p].action = propsObj[p].action;
                                oldObj[p].overwritten = true;
                            }

                            if (propsObj[p].date != oldObj[p].date) {

                                oldObj[p].date = propsObj[p].date;
                                oldObj[p].overwritten = true;
                            }

                            if (propsObj[p].interval != oldObj[p].interval) {

                                oldObj[p].interval = propsObj[p].interval;
                                oldObj[p].overwritten = true;
                            }

                            if (JSON.stringify(propsObj[p].meta) != JSON.stringify(oldObj[p].interval)) {

                                oldObj[p].meta = propsObj[p].meta;
                                oldObj[p].overwritten = true;
                            }
                        }

                    }

                    if (!oldObj[p]) oldObj[p] = propsObj[p];


                    if (propsObj.permissions) {
                        Object.keys(propsObj.permissions).forEach(function(p) {
                            if (propsObj.permissions[p]) {
                                if (JSON.stringify(propsObj.permissions[p]) != JSON.stringify(oldObj.permissions[p]))
                                    oldObj.permissions[p] = propsObj.permissions[p]
                                oldObj.permissions[p].overwritten = true;
                            }
                        })
                    }

                    if (propsObj[p]) {
                        handlers.forEach(function(h) {
                            if (propsObj[p][h]) {
                                Object.keys(propsObj[p][h]).forEach(function(oC) {
                                    if (propsObj[p][h][oC]) {
                                        if (propsObj[p][h][oC].value != oldObj[p][h][oC].value)
                                            oldObj[p][h][oC].value = propsObj[p][h][oC].value;
                                        oldObj[p][h][oC].overwritten = true;
                                    }
                                })
                            }
                        })
                    }

                })
            }

            doTheProps(newObj);

            // Applications: TODO!!!

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

        getTemplateFieldsForObject: function(obj, templateId, success, error, client, templateRole, templateSource, params) {

            var self = this;


            var isObject = function(a) {
                return (!!a) && (a.constructor === Object);
            };

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


                            if (!template[h][oC] || !isObject(template[h][oC])) return;
                            if (!obj[h]) obj[h] = {};
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

                    if (!template) template = {};

                    var propsObj = obj[params.propsObject] || obj;


                    Object.keys(template).forEach(function(p) {

                        if (OBJY.predefinedProperties.includes(p) || (isObject(template[p]) || Array.isArray(template[p]))) return;

                        if (!template[p]) return;

                        var cloned = JSON.parse(JSON.stringify(template[p]));

                        if (!propsObj[p]) {
                            propsObj[p] = cloned;
                            propsObj[p].template = templateId;
                            delete propsObj[p].overwritten;
                        } else {


                            if (cloned.meta) {
                                if (!propsObj[p].meta) {
                                    propsObj[p].meta = cloned.meta;
                                    propsObj[p].meta.overwritten = true;
                                } else {
                                    if (!propsObj[p].meta.overwritten) {
                                        propsObj[p].meta = cloned.meta;
                                        propsObj[p].meta.overwritten = true;
                                    }
                                }
                            }
                            if (!propsObj[p].type) propsObj[p].type = cloned.type;

                            propsObj[p].template = templateId;
                            propsObj[p].overwritten = true;

                        }

                        if (template.permissions) {
                            if (!propsObj.permissions) propsObj.permissions = {};
                            Object.keys(template.permissions).forEach(function(p) {
                                if (!propsObj.permissions[p]) {
                                    propsObj.permissions[p] = template.permissions[p];
                                    propsObj.permissions[p].template = templateId;
                                } else {
                                    propsObj.permissions[p].template = templateId;
                                    propsObj.permissions[p].overwritten = true;
                                }
                            })
                        }

                        ['onCreate', 'onChange', 'onDelete'].forEach(function(h) {
                            if (template[p][h]) {
                                if (!propsObj[p][h]) propsObj[p][h] = {};

                                Object.keys(template[p][h]).forEach(function(oC) {

                                    if (!propsObj[p][h][oC]) {
                                        propsObj[p][h][oC] = template[p][h][oC];
                                        if (propsObj[p][h][oC]) propsObj[p][h][oC].template = templateId;
                                    }
                                })
                            }
                        })

                        if (template[p].type == 'bag') {


                            doTheProps(cloned, propsObj[p]);
                        }

                    })
                }


                doTheProps(template, obj);

                // Applications

                if (template.applications) {
                    template.applications.forEach(function(a) {
                        if (obj.applications)
                            if (obj.applications.indexOf(a) == -1) obj.applications.push(a);
                    })
                }

                if (template.authorisations) {
                    var keys = Object.keys(template.authorisations);

                    if (keys.length > 0) {
                        if (!obj.authorisations) obj.authorisations = {};
                    }

                    keys.forEach(function(k) {


                        if (!obj.authorisations[k]) {
                            obj.authorisations[k] = template.authorisations[k]

                            obj.authorisations[k].forEach(function(a) {
                                a.template = template._id;
                            })

                        } else {
                            template.authorisations[k].forEach(function(a) {

                                var f = false;
                                obj.authorisations[k].forEach(function(objA) {
                                    if (JSON.stringify(objA.query) == JSON.stringify(a.query)) f = true;
                                })

                                if (f) {
                                    a.overwritten = true;
                                } else {
                                    a.template = template._id;
                                    a.test = 'has'
                                    obj.authorisations[k].push(a)
                                }
                            })
                        }
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

                            if (!contains) {
                                23
                                obj.privileges[a].push({
                                    name: tP.name,
                                    template: templateId
                                })
                            }

                        })


                    })
                }

                success(obj);

            }

            if (self.caches[templateRole || obj.role].get(templateId)) {
                //run(self.caches[templateRole || obj.role].get(templateId))

            } else {



                OBJY.getObjectById(templateRole || obj.role, templateId, function(template) {

                    //if (!self.caches[templateRole || obj.role].get(templateId)) self.caches[templateRole || obj.role].add(templateId, template);

                    var counter = 0;


                    if ((template.inherits || []).length == 0) run(template)
                    else {


                        template.inherits.forEach(function(i) {



                            OBJY.getTemplateFieldsForObject(template, i, function() {

                                    counter++;

                                    // console.log('counter', counter, template, i);

                                    if (counter == template.inherits.length) run(template);;

                                },
                                function(err) {
                                    counter++;

                                    if (counter == template.inherits.length) run(template);


                                }, client, templateRole || obj.role, templateSource || OBJY.activeTenant, params)


                        })


                    }

                    //run(template)

                }, function(err) {
                    error(err);
                }, OBJY.activeApp, templateSource || OBJY.activeTenant)


                /*OBJY[templateRole || obj.role](templateId).get(function(template) {

                    //if(!self.caches[templateRole || obj.role].get(templateId)) self.caches[templateRole || obj.role].add(templateId,  template);

                    run(template)

                }, function(err) {
                    error(err);
                }, templateSource)*/
            }


        },

        removeTemplateFieldsForObject: function(obj, templateId, success, error, client, params) {


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

            var isObject = function(a) {
                return (!!a) && (a.constructor === Object);
            };


            function doTheProps(obj) {

                var propsObj = obj[params.propsObject] || obj;

                if (propsObj) {

                    Object.keys(propsObj).forEach(function(p) {

                        if (!isObject(propsObj[p])) return;

                        /*if (obj.permissions) {
                            Object.keys(obj.permissions).forEach(function(p) {
                                if (obj.permissions[p]) {
                                    if (obj.permissions[p].template == templateId && !obj.permissions[p].overwritten)
                                        delete obj.permissions[p]
                                }
                            })
                        }*/

                        if (propsObj[p]) {
                            ['onCreate', 'onChange', 'onDelete'].forEach(function(h) {
                                if (propsObj[p][h]) {

                                    propsObject.keys(propsObj[p][h]).forEach(function(oC) {

                                        if (propsObj[p][h][oC]) {
                                            if (propsObj[p][h][oC].template == templateId && !propsObj[p][h][oC].overwritten)
                                                delete propsObj[p][h][oC];
                                        }
                                    })
                                }
                            })
                        }

                        if (propsObj[p].type == 'bag') {
                            return doTheProps(propsObj[p]);
                        }

                        if (propsObj[p]) {
                            if (propsObj[p].value != null) propsObj[p].overwritten = true;
                            if (propsObj[p].template == templateId && !propsObj[p].overwritten) {
                                console.info('deleting propsObj', p, propsObj[p])
                                delete propsObj[p];
                            }
                        }

                    })

                }


            }

            doTheProps(obj);


            // Applications: TODO!!!

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
                    if (!Array.isArray(obj.privileges[a])) return;
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



        removeTemplateFieldsToObject: function(obj, templateId) {
            this.getTemplateAsyn(templateId, function(template) {
                    var propertyKeys = Object.keys(template);
                    propertyKeys.forEach(function(property) {
                        if (obj[property] === undefined) {
                            this.removeTemplateFieldFromObjects(obj.template[property])
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

            if (!obj.applications) obj.applications = [];

            obj.applications.forEach(function(app) {
                if (app == application) contains = true;
            });
            if (!contains) {
                obj.applications.push(application);
                OBJY.chainPermission(obj, instance, 'a', 'addApplication', application);

            } else throw new exceptions.DuplicateApplicationException(application);

        },

        removeApplicationFromObject: function(obj, application, instance) {
            var contains = false;
            obj.applications.forEach(function(app, i) {
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

        removeTemplateFromObject: function(obj, templateId, success, error, instance) {
            var contains = false;

            obj.inherits.forEach(function(templ) {
                if (templ == templateId) contains = true;
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
            })
            return permissions;
        },

        ObjectOnCreateSetWrapper: function(obj, name, onCreate, trigger, type, instance) {
            //if (!typeof onchange == 'object') throw new exceptions.InvalidPermissionException();

            if (!onCreate) throw new exceptions.InvalidHandlerException();

            if (!obj.onCreate) obj.onCreate = {};

            if (obj.onCreate[name]) throw new exceptions.HandlerExistsException(name);

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
            //if (!typeof onchange == 'object') throw new exceptions.InvalidPermissionException();


            if (!onCreate) return;

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

        ApplyCreateWrapper: function(obj, apply) {

            if (!apply) apply = {};

            return apply;
        },

        ObjectOnChangeCreateWrapper: function(obj, onChange, instance) {
            //if (!typeof onchange == 'object') throw new exceptions.InvalidPermissionException();

            if (!onChange) return;

            Object.keys(onChange).forEach(function(oC) {
                if (!onChange[oC].trigger) oC.trigger = 'after';
                if (!onChange[oC].trigger) oC.type = 'async';

            })

            return onChange;
        },

        ObjectAuthorisationSetWrapper: function(obj, authorisationObj, instance) {

            var app = instance.activeApp || '*';

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

        ObjectAuthorisationRemoveWrapper: function(obj, authorisationId, instance) {

            var app = instance.activeApp || '*';

            if (!obj.authorisations) throw new Error('No authorisations present')

            if (!obj.authorisations[app]) throw new Error('No authorisations for this app present')

            obj.authorisations[app].forEach((au, i) => {
                if (au.name == authorisationId) obj.authorisations[app].splice(i, 1)
            })

            if (Object.keys(obj.authorisations[app]).length == 0) delete obj.authorisations[app];

            return authorisationId;
        },

        ObjectOnDeleteCreateWrapper: function(obj, onDelete, instance) {
            //if (!typeof onchange == 'object') throw new exceptions.InvalidPermissionException();

            if (!onDelete) return;

            Object.keys(onDelete).forEach(function(oC) {
                if (!onDelete[oC].trigger) oC.trigger = 'after';
                if (!onDelete[oC].trigger) oC.type = 'async';

            })

            return onDelete;
        },

        ObjectOnChangeSetWrapper: function(obj, name, onChange, trigger, type, instance) {
            //if (!typeof onchange == 'object') throw new exceptions.InvalidPermissionException();

            if (!onChange) throw new exceptions.InvalidHandlerException();

            if (!obj.onChange) obj.onChange = {};

            if (obj.onChange[name]) throw new exceptions.HandlerExistsException(name);

            if (!name) name = OBJY.RANDOM();

            if (!obj.onChange[name]) obj.onChange[name] = {}

            obj.onChange[name].value = onChange;
            obj.onChange[name].trigger = trigger || 'after';
            obj.onChange[name].type = type || 'async';

            if (obj.onChange[name].templateId) obj.onChange[name].overwritten = true;

            OBJY.chainPermission(obj, instance, 'w', 'setOnChangeHandler', name);

            return onChange;
        },

        ObjectOnDeleteSetWrapper: function(obj, name, onDelete, trigger, type, instance) {
            //if (!typeof onchange == 'object') throw new InvalidPermissionException();

            if (!onDelete) throw new exceptions.InvalidHandlerException();

            if (!obj.onDelete) obj.onDelete = {};

            if (obj.onDelete[name]) throw new exceptions.HandlerExistsException(name);

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

        ObjectPermissionRemoveWrapper: function(obj, permissionName, instance) //addTemplateToObject!!!
        {
            if (!permissionName) throw new exceptions.InvalidPermissionException();

            if (!typeof permissionName == 'string') throw new exceptions.InvalidPermissionException();

            if (!obj.permissions[permissionName]) throw new exceptions.NoSuchPermissionException(permissionName);

            OBJY.chainPermission(obj, instance, 'x', 'removePermission', permissionName);

            delete obj.permissions[permissionName];

            return permissionName;
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

        PropertiesChecker: function(obj, properties, instance, params) {
            if (properties === undefined) return;

            //obj.properties = {};

            if (params.propsObject) obj[params.propsObject] = {};

            var propertyKeys = Object.keys(properties);
            propertyKeys.forEach(function(property) {
                var propKey = {};
                propKey[property] = properties[property];
                var newProp = propKey;
                new OBJY.PropertyCreateWrapper(obj, newProp, false, instance, params);
            })
            return obj[params.propsObject] || obj;
        },

        ApplicationsChecker: function(obj, applications) {
            if (applications === undefined) return;

            obj.applications = [];
            applications.forEach(function(application) {
                obj.applications.push(application);
            })

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
            })
            return obj.actions;
        },

        InheritsChecker: function(obj, templates) {
            if (templates === undefined) return;
            if (typeof templates !== 'object') return;
            obj.inherits = [];

            templates.forEach(function(template) {
                if (template != obj._id) new OBJY.TemplatesCreateWrapper(obj, template);
            })

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
            })

            if (!contains) obj.privileges[privilegeKey].push({ name: privilege[privilegeKey].name });
            else throw new Error('Privilege already exists')

            return privilege;
        },

        PrivilegeRemover: function(obj, privilege, instance) {


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


    }
}