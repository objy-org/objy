//var Query = require('../lib/dependencies/query.js');
import Query from '../lib/dependencies/query.js';

 var isObject = function(a) {
    return (!!a) && (a.constructor === Object);
};

function isObjyObject (a) {
    if(!isObject(a)) return false;
    if (a._id && a.role) return true;
};

export default function (OBJY) {
    return {

        /**
         * Applies affect rules
         * @param {afterObj} - the afterObject
         * @param {operation} - the operation (onChange, onCreate and onDelete)
         * @param {insstance} - the current afterObjy context
         * @param {client} - the active client
         */
        applyAffects: function(afterObj, context, client, params) {
            this.affectables.forEach(function(a) {
                if (Query.query([afterObj], a.affects, Query.undot).length != 0) {

                    var template = a.apply;
                    var templateId = a._id;

                    if (template.name) {
                        if (!afterObj.name) afterObj.name = template.name;
                    }

                    if (template.type) {
                        if (!afterObj.type) afterObj.type = template.type;
                    }

                    // Object handlers

                    ['onCreate', 'onChange', 'onDelete'].forEach(function(h) {
                        if (template[h]) {
                            Object.keys(template[h]).forEach(function(oC) {
                                if (!afterObj[h]) afterObj[h] = {};
                                if (!afterObj[h][oC]) {
                                    if(!template[h][oC]) return;
                                    afterObj[h][oC] = template[h][oC];
                                    afterObj[h][oC].template = templateId;
                                }
                            })
                        }
                    })

                   
                // Properties
                function doTheProps(template, obj, extendedStructure) {

                    if (!obj) obj = {}

                    if (!template) template = {};

                    //if (params.object && !obj.hasOwnProperty(params.propsObject)) obj[params.propsObject] = {};

                        if(extendedStructure && typeof extendedStructure == "object"){
                            Object.keys(extendedStructure).forEach(k => {
                                if(isObject(extendedStructure[k]) && template[k]){
                                    doTheProps(template[k], obj[k], extendedStructure[k]);
                                }
                            });
                        } else {
                            /*console.log(Object.keys(template))
                            Object.keys(template).forEach(function(p) {
                                if(!OBJY.predefinedProperties.includes(p) && isObject(template[p])){
                                    console.log('predef', p)
                                    doTheProps(template[p], obj[p]);
                                }
                            })*/
                        }

                    Object.keys(template).forEach(function(p) {

                        if ((OBJY.predefinedProperties.includes(p)/* || (isObject(template[p]) || Array.isArray(template[p]))*/)) return;

                        if (!template[p]) return;

                        if(isObject(template[p]))  doTheProps(template[p], obj[p]);

                        var cloned = JSON.parse(JSON.stringify(template[p]));

                        if (!obj.hasOwnProperty(p)) {

                            obj[p] = cloned;
                            if(isObject(obj[p])) obj[p].template = templateId;
                            //delete obj[p].overwritten;

                        } else if (isObject(obj[p])) {

                            if (cloned.meta) {
                                if (!obj[p].meta) {
                                    obj[p].meta = cloned.meta;
                                    //obj[p].meta.overwritten = true;
                                } else {
                                    if (!obj[p].meta.overwritten) {
                                        obj[p].meta = cloned.meta;
                                        //obj[p].meta.overwritten = true;
                                    }
                                }
                            }
                            if (!obj[p].type) obj[p].type = cloned.type;

                            obj[p].template = templateId;
                            //obj[p].overwritten = true;

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
                            if (template[p][h]) {
                                if (!obj[p][h]) obj[p][h] = {};

                                Object.keys(template[p][h]).forEach(function(oC) {

                                    if (!obj[p][h][oC]) {
                                        obj[p][h][oC] = template[p][h][oC];
                                        if (obj[p][h][oC]) obj[p][h][oC].template = templateId;
                                    }
                                })
                            }
                        })

                        if (template[p].type == 'bag') {

                            doTheProps(cloned, obj[p]);
                        }

                        

                    })
                }


                doTheProps(template, afterObj, params.extendedStructure);

                    // Applications

                    if (template.applications) {
                        template.applications.forEach(function(a) {
                            if (afterObj.applications)
                                if (afterObj.applications.indexOf(a) == -1) afterObj.applications.push(a);
                        })
                    }


                    if (template._clients) {
                        template._clients.forEach(function(a) {
                            if ((afterObj._clients || []).indexOf(a) == -1)(afterObj._clients || []).push(a);
                        })
                    }

                    if (template.authorisations) {
                        var keys = Object.keys(template.authorisations);

                        if (keys.length > 0) {
                            if (!afterObj.authorisations) afterObj.authorisations = {};
                        }

                        keys.forEach(function(k) {

                            if (!afterObj.authorisations[k]) {
                                afterObj.authorisations[k] = template.authorisations[k]

                                afterObj.authorisations[k].forEach(function(a) {
                                    a.template = template._id;
                                })

                            } else {
                                template.authorisations[k].forEach(function(a) {

                                    var f = false;
                                    afterObj.authorisations[k].forEach(function(afterObjA) {
                                        if (JSON.stringify(afterObjA.query) == JSON.stringify(a.query)) f = true;
                                    })

                                    if (f) {
                                        a.overwritten = true;
                                    } else {
                                        a.template = template._id;
                                        afterObj.authorisations[k].push(a)
                                    }
                                })
                            }
                        })
                    }

                    // Permissions

                    if (template.permissions) {
                        if (!afterObj.permissions) afterObj.permissions = {};
                        Object.keys(template.permissions).forEach(function(p) {
                            if (!afterObj.permissions[p]) {
                                afterObj.permissions[p] = template.permissions[p];
                                afterObj.permissions[p].template = templateId;
                            } else {
                                afterObj.permissions[p].template = templateId;
                                afterObj.permissions[p].overwritten = true;
                            }
                        })
                    }

                    // Privileges

                    if (template.privileges) {
                        if (!afterObj.privileges) afterObj.privileges = {};
                        Object.keys(template.privileges).forEach(function(a) {
                            if (!afterObj.privileges[a]) afterObj.privileges[a] = [];

                            template.privileges[a].forEach(function(tP) {
                                var contains = false;

                                afterObj.privileges[a].forEach(function(oP) {
                                    if (oP.name == tP.name) contains = true;
                                })
                            })

                            if (!contains) {
                                afterObj.privileges[a].push({
                                    name: tP.name,
                                    template: templateId
                                })
                            }

                        })
                    }

                }
            })

        },

        // THIS IS A PROTOTYPE!!!
        // removes stuff, that was inserted by affects
        // for now, only
        unapplyHiddenAffects: function(afterObj, operation, context, client, params) {
            this.affectables.forEach(function(a) {
                if (Query.query([afterObj], a.affects, Query.undot).length != 0) {

                    var template = a.apply;
                    var templateId = a._id;

                    // Object handlers
                    ['onCreate', 'onChange', 'onDelete'].forEach(function(h) {
                        if (template[h]) {
                            Object.keys(template[h]).forEach(function(oC) {
                                if (afterObj[h][oC]) {
                                    if (afterObj[h][oC].hidden == true)
                                        delete afterObj[h][oC]
                                }
                            })
                        }
                    })

                }
            })

        }

    }
}