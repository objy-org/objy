var Query = require('../lib/dependencies/query.js');

module.exports = function(OBJY) {
    return {

        /**
         * Applies affect rules
         * @param {obj} - the object
         * @param {operation} - the operation (onChange, onCreate and onDelete)
         * @param {insstance} - the current objy instance
         * @param {client} - the active client
         */
        applyAffects: function(obj, operation, instance, client, params) {
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

                            var propsObj = obj[params.propsObject] || obj;

                            var isO = isObject(template[p]);

                            if ((template[p] || {}).type == 'bag') {

                                if (!propsObj[p]) {

                                    propsObj[p] = template[p];
                                    if (isO) propsObj[p].template = templateId;
                                } else {
                                    if (!propsObj[p].overwritten && Object.keys(propsObj[p]).length == 0) {
                                        propsObj[p] = template[p];
                                    }

                                    if (isO) propsObj[p].template = templateId;
                                    //propsObj.properties[p].overwritten = true;
                                }

                                if (!propsObj[propsObj]) propsObj[p] = {};

                                doTheProps(template[p], propsObj[p]);

                            } else if (isObject(template[p])) {

                                if (!propsObj[p]) {

                                    propsObj[p] = template[p];

                                    if (p != 'properties' && isO) propsObj[p].template = templateId;

                                } else {

                                    if (!propsObj[p].overwritten && Object.keys(propsObj[p]).length == 0) {
                                        propsObj[p] = template[p];
                                    }

                                    if (p != 'properties' && isO) propsObj[p].template = templateId;
                                    //propsObj[p].overwritten = true;
                                }

                                doTheProps(template[p], propsObj[p]);
                            }


                            if (!propsObj[p]) {
                                propsObj[p] = template[p];
                                if (p != 'properties' && isO) propsObj[p].template = templateId;
                                if (isO) delete propsObj[p].overwritten;
                            } else {

                                if (!propsObj[p].overwritten) {
                                    if (p != 'properties' && isO) propsObj[p].template = templateId;
                                    if (propsObj[p].value == null && isO) propsObj[p].value = template[p].value;
                                    //obj[p].overwritten = true;
                                }

                                if (!propsObj[p].metaOverwritten) {
                                    propsObj[p].meta = template[p].meta;
                                }

                                /*if (obj[p].type == 'bag') {
                                    if (!obj[p].properties) {
                                        obj[p].properties = {};
                                    }
                                }*/
                            }


                            if (template.permissions) {
                                if (!propsObj.permissions) propsObj.permissions = {};
                                Object.keys(template.permissions).forEach(function(p) {
                                    if (!propsObj.permissions[p]) {
                                        propsObj.permissions[p] = template.permissions[p];
                                        if (isO) propsObj.permissions[p].template = templateId;
                                    } else {
                                        if (isO) propsObj.permissions[p].template = templateId;
                                        if (isO) propsObj.permissions[p].overwritten = true;
                                    }
                                })
                            }

                            ['onCreate', 'onChange', 'onDelete'].forEach(function(h) {
                                if (!isObject(template[p])) return;
                                if (template[p][h]) {
                                    if (!propsObj[p][h]) propsObj[p][h] = {};

                                    Object.keys(template[p][h]).forEach(function(oC) {

                                        if (!propsObj[p][h][oC]) {
                                            propsObj[p][h][oC] = template[p][h][oC];
                                            propsObj[p][h][oC].template = templateId;
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

        /**
         * Applies static rules
         * @param {obj} - the object
         * @param {operation} - the operation (onChange, onCreate and onDelete)
         * @param {insstance} - the current objy instance
         * @param {client} - the active client
         */

        applyRules: function(obj, operation, instance, client) {
            var self = this;
            self.staticRules.forEach(function(a) {
                if (Query.query([obj], a.affects, Query.undot).length != 0) {

                    var template = a.apply;
                    var templateId = a._id;

                    ['onCreate', 'onChange', 'onDelete'].forEach(function(h) {
                        if (template[h]) {
                            Object.keys(template[h]).forEach(function(oC) {

                                if (operation != h) return;

                                instance.execProcessorAction(template[h][oC].value || template[h][oC].action, obj, null, null, function(data) {

                                }, client, null);

                            })
                        }
                    })
                }
            })
        }
    }
}