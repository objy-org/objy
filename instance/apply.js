//var Query = require('../lib/dependencies/query.js');
import Query from '../lib/dependencies/query.js';

var isObjyObject = function (a) {
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
        applyAffects: function(beforeObj, afterObj, operation, context, client, trigger) {
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

                    var isObject = function(a) {
                        return (!!a) && (a.constructor === Object);
                    };

                    // Properties
                    function doTheProps(template, afterObj) {

                        var propsObj = afterObj;
                        if(!template) return;
                        var propsTmpl = template;

                        if (!propsObj) propsObj = {}

                        /*if (afterObj.type == 'bag') {
                            if (!afterObj.properties) {
                                afterObj.properties = {};
                            }
                        }*/

                        Object.keys(propsTmpl || {}).forEach(function(p) {
                       
                            var isO = isObject(propsTmpl[p]);

                            if ((propsTmpl[p] || {}).type == 'bag') {

                                if (!propsObj[p]) {

                                    propsObj[p] = propsTmpl[p];
                                    if (isO) propsObj[p].propsTmpl = templateId;
                                } else {
                                    if (!propsObj[p].overwritten && Object.keys(propsObj[p]).length == 0) {
                                        propsObj[p] = propsTmpl[p];
                                    }

                                    if (isO) propsObj[p].propsTmpl = templateId;
                                    //propsObj.properties[p].overwritten = true;
                                }

                                if (!propsObj[propsObj]) propsObj[p] = {};

                                doTheProps(propsTmpl[p], propsObj[p]);

                            } else if (isObject(propsTmpl[p])) {

                                if (!propsObj[p]) {

                                    propsObj[p] = propsTmpl[p];

                                    if (p != 'properties' && isO) propsObj[p].propsTmpl = templateId;

                                } else {

                                    if (!propsObj[p].overwritten && Object.keys(propsObj[p]).length == 0) {
                                        propsObj[p] = propsTmpl[p];
                                    }

                                    if (p != 'properties' && isO) propsObj[p].propsTmpl = templateId;
                                    //propsObj[p].overwritten = true;
                                }

                                doTheProps(propsTmpl[p], propsObj[p]);
                            }


                            if (!propsObj[p]) {
                                propsObj[p] = propsTmpl[p];
                                if (p != 'properties' && isO) propsObj[p].propsTmpl = templateId;
                                if (isO) delete propsObj[p].overwritten;
                            } else {

                                if (!propsObj[p].overwritten) {
                                    if (p != 'properties' && isO) propsObj[p].propsTmpl = templateId;
                                    if (propsObj[p].value == null && isO) propsObj[p].value = propsTmpl[p].value;
                                    //afterObj[p].overwritten = true;
                                }

                                if (!propsObj[p].metaOverwritten) {
                                    propsObj[p].meta = propsTmpl[p].meta;
                                }

                                /*if (afterObj[p].type == 'bag') {
                                    if (!afterObj[p].properties) {
                                        afterObj[p].properties = {};
                                    }
                                }*/
                            }


                            if (propsTmpl.permissions) {
                                if (!propsObj.permissions) propsObj.permissions = {};
                                Object.keys(propsTmpl.permissions).forEach(function(p) {
                                    if (!propsObj.permissions[p]) {
                                        propsObj.permissions[p] = propsTmpl.permissions[p];
                                        if (isO) propsObj.permissions[p].propsTmpl = templateId;
                                    } else {
                                        if (isO) propsObj.permissions[p].propsTmpl = templateId;
                                        if (isO) propsObj.permissions[p].overwritten = true;
                                    }
                                })
                            }

                            ['onCreate', 'onChange', 'onDelete'].forEach(function(h) {
                                if (!isObject(propsTmpl[p])) return;
                                if (propsTmpl[p][h]) {
                                    if (!propsObj[p][h]) propsObj[p][h] = {};

                                    Object.keys(propsTmpl[p][h]).forEach(function(oC) {

                                        if (!propsObj[p][h][oC]) {
                                            propsObj[p][h][oC] = propsTmpl[p][h][oC];
                                            propsObj[p][h][oC].propsTmpl = templateId;
                                        }
                                    })
                                }
                            })
                        })
                    }

                    doTheProps(template || {}, afterObj || {});

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

            this.applyRules(beforeObj, afterObj, operation, context, client, trigger);
        },

        /**
         * Applies static rules
         * @param {afterObj} - the afterObject
         * @param {operation} - the operation (onChange, onCreate and onDelete)
         * @param {insstance} - the current afterObjy context
         * @param {client} - the active client
         */

        applyRules: function(beforeObj, afterObj, operation, context, client, trigger) {
            var self = this;
            self.staticRules.forEach(function(a) {

                if (Query.query([afterObj], a.affects, Query.undot).length != 0) {

                    var template = a.apply;
                    var templateId = a._id;

                    console.log(a, operation)


                    // ONCREATE
                    if (operation == 'onCreate'){
                        if (template.onCreate && Object.keys(template.onCreate || {}).length > 0) {
                            var callbackCounter = 0;
                            Object.keys(template.onCreate).forEach(function (key) {
                                try {
                                    OBJY.execProcessorAction(
                                        template.onCreate[key].value || template.onCreate[key].action,
                                        null,
                                        afterObj,
                                        null,
                                        function (cbtemplate) {
                                            callbackCounter++;
                                            if (callbackCounter == Object.keys(template.onCreate || {}).length) {
                                                if (success) {
                                                    if (isObjyObject(cbtemplate)) return success(cbtemplate)
                                                    else success(template);
                                                } 
                                                else {
                                                    resolve(template);
                                                }
                                            }
                                        },
                                        client,
                                        null
                                    );
                                } catch(e){
                                    console.log(e)
                                }

                            });
                        }
                    }


                    // ONCHANGE
                    if (operation == 'onChange'){
                        if (template.onChange && Object.keys(template.onChange || {}).length > 0) {
                            var callbackCounter = 0;
                            Object.keys(template.onChange).forEach(function (key) {
                                try {
                                    OBJY.execProcessorAction(
                                        template.onChange[key].value || template.onChange[key].action,
                                        beforeObj,
                                        afterObj,
                                        null,
                                        function (cbtemplate) {
                                            callbackCounter++;
                                            if (callbackCounter == Object.keys(template.onChange || {}).length) {
                                                if (success) {
                                                    if (isObjyObject(cbtemplate)) return success(cbtemplate)
                                                    else success(template);
                                                } 
                                                else {
                                                    resolve(template);
                                                }
                                            }
                                        },
                                        client,
                                        null
                                    );
                                } catch(e){
                                    console.log(e)
                                }

                            });
                        }
                    }

                    // ONDELETE
                    if (operation == 'onDelete'){
                        if (template.onDelete && Object.keys(template.onDelete || {}).length > 0) {
                            var callbackCounter = 0;
                            Object.keys(template.onDelete).forEach(function (key) {
                                try {
                                    OBJY.execProcessorAction(
                                        template.onDelete[key].value || template.onDelete[key].action,
                                        null,
                                        afterObj,
                                        null,
                                        function (cbtemplate) {
                                            callbackCounter++;
                                            if (callbackCounter == Object.keys(template.onDelete || {}).length) {
                                                if (success) {
                                                    if (isObjyObject(cbtemplate)) return success(cbtemplate)
                                                    else success(template);
                                                } 
                                                else {
                                                    resolve(template);
                                                }
                                            }
                                        },
                                        client,
                                        null
                                    );
                                } catch(e){
                                    console.log(e)
                                }

                            });
                        }
                    }


                    /*['onCreate', 'onChange', 'onDelete'].forEach(function(h) {
                        if (template[h]) {
                            Object.keys(template[h]).forEach(function(oC) {

                                if (operation != h) return;

                                OBJY.execProcessorAction(template[h][oC].value || template[h][oC].action, afterObj, null, null, function(data) {

                                }, client, null);

                            })
                        }
                    })*/

                    if (template._constraints) {
                        if (!Array.isArray(afterObj._constraints)) afterObj._constraints = [];
                        template._constraints.forEach(c => {

                            if (afterObj._constraints.find(el => el.key == c.key)) return;

                            c.templateId = templateId;
                            afterObj._constraints.push(c)
                        })
                    }

                }
            })
        },


    }
}