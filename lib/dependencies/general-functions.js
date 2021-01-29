module.exports = {
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
        if (!client) throw new Error("No client specified");
        this.activeTenant = client;
        return this;
    },

    /**
     * Sets user context
     * @param {user} - the user object
     * @returns {this}
     */
    useUser: function(user) {
        this.activeUser = user;
        return this;
    },

    /**
     * Sets app context
     * @param {app} - the app identifier
     * @returns {this}
     */
    app: function(app) {
        //if (!app) throw new Error("No app specified");
        this.activeApp = app;

        return this;
    },

        /**
     * Applies affect rules
     * @param {obj} - the object
     * @param {operation} - the operation (onChange, onCreate and onDelete)
     * @param {insstance} - the current objy instance
     * @param {client} - the active client
     */
    applyAffects: function(obj, operation, instance, client) {
        this.affectables.forEach(function(a) {
            if (Query.query([obj], a.affects, Query.undot).length != 0) {

                var template = a.apply;
                var templateId = a._id;

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
                            if (!obj[h]) obj[h] = {};
                            if (!obj[h][oC]) {
                                obj[h][oC] = template[h][oC];
                                obj[h][oC].template = templateId;
                            }
                        })
                    }
                })

                var isObject = function(a) {
                    return (!!a) && (a.constructor === Object);
                };

                // Properties
                function doTheProps(template, obj) {

                    if (!obj) obj = {}

                    /*if (obj.type == 'bag') {
                        if (!obj.properties) {
                            obj.properties = {};
                        }
                    }*/

                    Object.keys(template || {}).forEach(function(p) {

                        var isO = isObject(template[p]);

                        if ((template[p] || {}).type == 'bag') {

                            if (!obj[p]) {

                                obj[p] = template[p];
                                if (isO) obj[p].template = templateId;
                            } else {
                                if (!obj[p].overwritten && Object.keys(obj[p]).length == 0) {
                                    obj[p] = template[p];
                                }

                                if (isO) obj[p].template = templateId;
                                //obj.properties[p].overwritten = true;
                            }

                            if (!obj[p]) obj[p] = {};

                            doTheProps(template[p], obj[p]);

                        } else if (isObject(template[p])) {

                            if (!obj[p]) {

                                obj[p] = template[p];

                                if (p != 'properties' && isO) obj[p].template = templateId;

                            } else {

                                if (!obj[p].overwritten && Object.keys(obj[p]).length == 0) {
                                    obj[p] = template[p];
                                }

                                if (p != 'properties' && isO) obj[p].template = templateId;
                                //obj[p].overwritten = true;
                            }

                            doTheProps(template[p], obj[p]);
                        }


                        if (!obj[p]) {
                            obj[p] = template[p];
                            if (p != 'properties' && isO) obj[p].template = templateId;
                            if (isO) delete obj[p].overwritten;
                        } else {

                            if (!obj[p].overwritten) {
                                if (p != 'properties' && isO) obj[p].template = templateId;
                                if (obj[p].value == null && isO) obj[p].value = template[p].value;
                                //obj[p].overwritten = true;
                            }

                            if (!obj[p].metaOverwritten) {
                                obj[p].meta = template[p].meta;
                            }

                            /*if (obj[p].type == 'bag') {
                                if (!obj[p].properties) {
                                    obj[p].properties = {};
                                }
                            }*/
                        }


                        if (template.permissions) {
                            if (!obj.permissions) obj.permissions = {};
                            Object.keys(template.permissions).forEach(function(p) {
                                if (!obj.permissions[p]) {
                                    obj.permissions[p] = template.permissions[p];
                                    if (isO) obj.permissions[p].template = templateId;
                                } else {
                                    if (isO) obj.permissions[p].template = templateId;
                                    if (isO) obj.permissions[p].overwritten = true;
                                }
                            })
                        }

                        ['onCreate', 'onChange', 'onDelete'].forEach(function(h) {
                            if (!isObject(template[p])) return;
                            if (template[p][h]) {
                                if (!obj[p][h]) obj[p][h] = {};

                                Object.keys(template[p][h]).forEach(function(oC) {

                                    if (!obj[p][h][oC]) {
                                        obj[p][h][oC] = template[p][h][oC];
                                        obj[p][h][oC].template = templateId;
                                    }
                                })
                            }
                        })
                    })
                }

                doTheProps(template || {}, obj || {});

                // Applications

                if (template.applications) {
                    template.applications.forEach(function(a) {
                        if (obj.applications)
                            if (obj.applications.indexOf(a) == -1) obj.applications.push(a);
                    })
                }


                if (template._clients) {
                    template._clients.forEach(function(a) {
                        if ((obj._clients || []).indexOf(a) == -1)(obj._clients || []).push(a);
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
                        })

                        if (!contains) {
                            obj.privileges[a].push({
                                name: tP.name,
                                template: templateId
                            })
                        }

                    })
                }


            }
        })

        this.applyRules(obj, operation, instance, client);
    },
}