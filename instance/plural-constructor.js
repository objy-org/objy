var CONSTANTS = require('../lib/dependencies/constants.js')

module.exports = function(OBJY) {
    return {

        Objs: function(objs, role, instance, params, flags) {
            var self = this;

            if (typeof objs === "object" && !Array.isArray(objs)) {

                var flags = flags || {};

                Object.keys(objs).forEach(function(oK) {
                    if (["$page", "$sort", "$pageSize"].indexOf(oK) != -1) {
                        flags[oK] = objs[oK];
                        delete objs[oK]
                    }
                })

                objs = OBJY.buildAuthroisationQuery(objs, instance.activeUser, 'r', instance.activeApp, instance)

                if (instance.activeUser) objs = OBJY.buildPermissionQuery(objs, instance.activeUser, instance.activeApp, instance);

                Object.getPrototypeOf(this).get = function(success, error, _client, _app) {
                return new Promise((resolve, reject) => {

                    var client = _client || instance.activeTenant;
                    var app = _app || instance.activeApp;

                    var thisRef = this;

                    var allCounter = 0;

                    OBJY.findObjects(objs, role, function(data) {

                        var i;
                        for (i = 0; i < data.length; i++) {
                            if (OBJY[data[i].role]) data[i] = OBJY[data[i].role](OBJY.deserialize(data[i]))
                        }


                        // TODO : change!!!

                        if (params.templateMode == CONSTANTS.TEMPLATEMODES.STRICT) {

                            if(success) success(OBJY.deSerializePropsObjectMulti(data, params));
                            else {
                                    resolve(OBJY.deSerializePropsObjectMulti(data, params));
                            }
                            return;
                        }

                        if (data.length == 0) {
                            //console.info(data)

                            if(success) success(OBJY.deSerializePropsObjectMulti(data, params));
                            else {
                                    resolve(OBJY.deSerializePropsObjectMulti(data, params));
                            }
                            return;
                        }

                        data.forEach(function(d) {

                            OBJY.applyAffects(d, null, instance, client)

                            if (!d.inherits) d.inherits = [];

                            /*d.inherits = d.inherits.filter(function(item, pos) {
                                return d.inherits.indexOf(item) == pos;
                            });*/


                            var counter = 0;



                            if (d.inherits.length == 0) {
                                allCounter++;

                                if (allCounter == data.length) {

                                    if(success) success(OBJY.deSerializePropsObjectMulti(data, params));
                                    else {
                                            resolve(OBJY.deSerializePropsObjectMulti(data, params));
                                    }
                                    return d;
                                }
                            }

                            d.inherits.forEach(function(template) {

                                if (d._id != template) {

                                    OBJY.getTemplateFieldsForObject(d, template, function() {


                                            counter++;

                                            if (counter == d.inherits.length) allCounter++;


                                            if (allCounter == data.length) {

                                                if(success) success(OBJY.deSerializePropsObjectMulti(data, params));
                                                else {
                                                        resolve(OBJY.deSerializePropsObjectMulti(data, params));
                                                }
                                                return d;
                                            }
                                        },
                                        function(err) {
                                            counter++;

                                            if (counter == d.inherits.length) allCounter++;


                                            if (allCounter == data.length) {

                                                if(success) success(OBJY.deSerializePropsObjectMulti(data, params));
                                                else {
                                                        resolve(OBJY.deSerializePropsObjectMulti(data, params));
                                                }
                                                return d;
                                            }

                                        }, client, params.templateFamily, params.templateSource, params, instance)
                                } else {

                                    if (d.inherits.length == 1) {

                                        if(success) success(OBJY.deSerializePropsObjectMulti(data, params));
                                        else {
                                                resolve(OBJY.deSerializePropsObjectMulti(data, params));
                                        }
                                        return d;
                                    } else {
                                        counter++;
                                        return;
                                    }

                                }
                            });

                        })

                    }, function(err) {
                        if(error) error(err);
                        else {
                                reject(err);
                        }
                    }, app, client, flags || {}, params, instance);

                });

                }

                Object.getPrototypeOf(this).count = function(success, error) {
                return new Promise((resolve, reject) => {

                    var client = instance.activeTenant;
                    var app = instance.activeApp;

                    var thisRef = this;
                    var counter = 0;


                    OBJY.countObjects(objs, role, function(data) {
                        if(success) success(data);
                        else {
                                resolve(data);
                        }

                    }, function(err) {
                        if(error) error(err);
                        else {
                                reject(err);
                        }
                    }, app, client, flags || {}, params, instance);

                    return;

                });
                }


            } else if (Array.isArray(objs)) {

                Object.getPrototypeOf(this).add = function(success, error) {
                return new Promise((resolve, reject) => {

                    var client = instance.activeTenant;
                    var app = instance.activeApp;


                    var i;
                    var allCounter = 0;
                    for (i = 0; i < objs.length; i++) {
                        objs[i] = OBJY[role](objs[i]).add(function(data) {

                            OBJY.applyAffects(data, 'onCreate', instance, client)

                            if (params.templateMode == CONSTANTS.TEMPLATEMODES.STRICT) {

                                var counter = 0;

                                if (data.inherits.length == 0) {

                                    allCounter++;
                                    if (allCounter == objs.length) {
                                        if(success) success(objs);
                                        else {
                                                resolve(objs);
                                        }
                                        return data;
                                    }
                                }



                                data.inherits.forEach(function(template) {

                                    if (data._id != template) {

                                        OBJY.getTemplateFieldsForObject(data, template, function() {

                                                counter++;

                                                if (counter == data.inherits.length) allCounter++;

                                                if (allCounter == objs.length) {
                                                    if(success) success(objs);
                                                    else {
                                                            resolve(objs);
                                                    }
                                                    return data;
                                                }
                                            },
                                            function(err) {
                                                if(error) error(err);
                                                else {
                                                        reject(err);
                                                }
                                                return data;
                                            }, client, params.templateFamily, params.templateSource, params, instance)
                                    } else {

                                        if (data.inherits.length == 1) {
                                            if(success) success(objs);
                                            else {
                                                    resolve(objs);
                                            }
                                            return data;
                                        } else {
                                            counter++;
                                            return;
                                        }
                                    }
                                });

                            } else {
                                allCounter++;
                                if (allCounter == objs.length) {
                                    if(success) success(objs);
                                    else {
                                            resolve(objs);
                                    }
                                    return data;
                                }
                            }

                        }, function(err) {
                            //counter++;
                            /*if (objs.length == counter)*/
                            if(error) error(err);
                            else {
                                    reject(err);
                            }
                        });
                    }
                });
                }

                return this;
            } else {

                if (params.authMethod) Object.getPrototypeOf(this).auth = params.authMethod;
                else {
                    Object.getPrototypeOf(this).auth = function(userObj, callback, error, client, app) {
                    return new Promise((resolve, reject) => {
                        var query = { username: userObj.username };

                        if (instance.authableFields) {
                            query = { $or: [] };
                            instance.authableFields.forEach(function(field) {
                                var f = {};
                                f[field] = userObj[field];
                                if (f[field]) query.$or.push(f)
                            })
                            if (Object.keys(query.$or).length == 0) query = { username: userObj.username }
                        }


                        instance[params.pluralName](query).get(function(data) {
                            if (data.length == 0) error("User not found");
                            
                            if(callback) callback(data[0]);
                            else {
                                    resolve(data[0]);
                            }

                        }, function(err) {
                            if(error) error(err);
                            else {
                                    reject(err);
                            }
                        }, client, app)

                    });
                    };

                }
            }

        },


    }
}