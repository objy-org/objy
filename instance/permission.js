var Query = require('../lib/dependencies/query.js');
var exceptions = require('../lib/dependencies/exceptions.js');

module.exports = function(OBJY) {
    return {
        /**
         * Check the permissions for an object or object part
         * @param {user} - the user object
         * @param {app} - the current application
         * @param {obj} - the object (or property) in question
         * @param {permission} - the permission code to check for
         * @param {soft} - ...
         * @returns true or false
         */
        checkPermissions: function(user, app, obj, permission, soft, context) {

            if(context.ignorePermissions == true) return true;

            var result = false; 

            if (!user) return true;

            if (user.spooAdmin) return true;

            // A user can always see himself
            if (user._id == obj._id && permission == 'r') return true;

            var privileges = user.privileges;
            var permissions = obj.permissions;

            if (!permissions) return true;

            if (Object.keys(permissions || {}).length == 0) return true;

            // if permissions present and user has no privileges
            if (!privileges && permissions) {
                if (!soft) return false;
                else return false;
            }


            var allowed = false;

            if (Array.isArray(permissions)) {
                var perms = {};

                permissions.forEach(function(p) {
                    perms[p.name] = { value: p.value };
                })

                permissions = perms;
            }

            if (app) {
                if (privileges['*']) {

                    Object.keys(permissions).forEach(function(pKey) {

                        privileges['*'].forEach(function(item) {
                            if (permissions[item.name]) {

                                if (((permissions[item.name] || {}).value || "").indexOf(permission) != -1 || (permissions[item.name] || {}).value == "*") allowed = true;
                            }

                            if (permissions["*"]) {
                                if (((permissions['*'] || {}).value || "").indexOf(permission) != -1 || (permissions['*'] || {}).value == "*") allowed = true;
                            }
                        })

                    })

                    if (allowed) return true;

                } else if (privileges[app]) {

                    privileges[app].forEach(function(item) {
                        if (permissions[item.name]) {

                            if (((permissions[item.name] || {}).value || "").indexOf(permission) != -1 || (permissions[item.name] || {}).value == "*") allowed = true;
                        }

                        if (permissions["*"]) {
                            if (((permissions['*'] || {}).value || "").indexOf(permission) != -1 || (permissions['*'] || {}).value == "*") allowed = true;
                        }
                    })

                    if (!allowed) return false;
                    else return true

                } else return false;

            } else return false;

        },

        /**
         * Check the authorisations for an object
         * @param {obj} - the object in question
         * @param {user} - the user object
         * @param {condition} - the condition to check for
         * @param {app} - the current application
         * @returns true or false
         */
        checkAuthroisations: function(obj, user, condition, app, context) {

            if(context.ignoreAuthorisations == true) return true;

            var authorisations;
            if (!user) return true;

            if (user.spooAdmin) return true;

            if (Object.keys(user.authorisations || {}).length == 0) return true; //throwError();

            if (!app && !user.authorisations['*']) {
                return false
            }

            if (user.authorisations['*']) authorisations = user.authorisations['*'];
            else if (app && !user.authorisations[app]) {
                return false
            } else authorisations = user.authorisations[app];

            var permCheck = [obj];

            var query = { $or: [] }

            authorisations.forEach(function(a) {

                if (typeof a.query === "string") {
                    try {
                        a.query = JSON.parse(a.query)
                    } catch (e) {
                        a.query = {};
                    }
                }

                if (a.query.$query) {
                    a.query = JSON.parse(JSON.stringify(a.query.$query));
                    delete a.query.$query;
                }

                if (a.perm.indexOf(condition) != -1 || a.perm.indexOf("*") != -1) query.$or.push(a.query)
            })
  
            if (query.$or.length == 0) return false;

            if (Query.query(permCheck, query, Query.undot).length == 0) return false;
            else return true
        },

        /**
         * Add permissions to a query
         * @param {query} - the initial query
         * @param {user} - the user object
         * @param {app} - the current application
         * @returns {query} - the final query with permissions
         */
        buildPermissionQuery: function(query, user, app, context) {

            if(context.ignorePermissions == true) return query;

            if (query.$query) {
                query = JSON.parse(JSON.stringify(query.$query));
                delete query.$query;
            }

            if (!user.spooAdmin) {

                if(query.$sum || query.$count || query.$avg) return query;

                if (!user.privileges) return query;

                if (app && user.privileges[app]) {
                    var privArr = [];
                    user.privileges[app].forEach(function(p) {

                        var inn = {};

                        inn["permissions." + p.name + ".value"] = { $regex: "r" }
                        privArr.push(inn);
                        //inn = {};
                        //inn["permissions." + p.name] = { $regex: "r" }
                        //privArr.push(inn);
                        inn = {};
                        inn["permissions." + p.name + ".value"] = "*";
                        privArr.push(inn);

                        inn = {};
                        inn["permissions.name"] = p.name;
                        privArr.push(inn);
                        //inn = {};
                        //inn["permissions." + p.name] = "*";
                        //privArr.push(inn);
                    })

                    var inn = {};
                    inn["permissions.*" + ".value"] = { $regex: "r" }
                    privArr.push(inn);
                    inn = {};
                    inn["permissions.*"] = { $regex: "r" }
                    privArr.push(inn);
                    inn = {};
                    inn["permissions.*" + ".value"] = "*"
                    privArr.push(inn);
                    //var inn = {};
                    //inn["permissions.*"] = "*"
                    //privArr.push(inn);


                    if (Object.keys(query).length > 0) {

                        return { $and: [query, { $or: privArr }] }
                    } else {
                        return { $or: privArr }
                    }
                } else if (!app) {
                    return query;
                } else return query;

            } else {
                return query
            }
        },

        /**
         * Add authorisations to a query
         * @param {obj} - the object
         * @param {user} - the user object
         * @param {condition} - the condition
         * @param {app} - the current application
         * @returns {query} - the final query with permissions
         */
        buildAuthroisationQuery: function(obj, user, condition, app, context) {

            if(context.ignoreAuthorisations == true) return obj;

            var authorisations;
            if (!user) return obj;

            if (user.spooAdmin) return obj;

            if(obj.$sum || obj.$count || obj.$avg) return obj;
            

            function throwError() {
                throw new exceptions.LackOfPermissionsException("Lack of permissions")
            }

            if (Object.keys(user.authorisations || {}).length == 0) return obj; //throwError();

            if (!app && !user.authorisations['*']) {
                throwError();
            }

            if (user.authorisations['*']) authorisations = user.authorisations['*'];
            else if (app && !user.authorisations[app]) {
                throwError();
            } else authorisations = user.authorisations[app];

            //...
            if (obj.$query) {
               obj = JSON.parse(JSON.stringify(obj.$query));
               delete obj.$query;
            }

            var permCheck = [obj];

            var query = []
            var wildcard = false;

            authorisations.forEach(function(a) {
                try {
                    a.query = JSON.parse(a.query)
                } catch (e) {

                }

                if (a.query.$query) {
                    a.query = JSON.parse(JSON.stringify(a.query.$query));
                    delete a.query.$query;
                }

                if (a.perm.indexOf(condition) != -1 || a.perm.indexOf("*") != -1) {
                    if (Object.keys(a.query).length == 0) wildcard = true;
                    else {
                        query.push({ '$and': [a.query, obj] })
                    }
                }
            })
  
            if (query.length == 0 && !wildcard) throw new exceptions.LackOfPermissionsException("Lack of permissions")

            query = { $or: query };

            return query;
        },

        /**
         * Chains permission information, when performing multiple operations
         * @param {obj} - the object
         * @param {context} - the OBJY context
         * @param {code} - the permission code
         * @param {name} - the permission name
         * @param {key} - the permission key
         */
        chainPermission: function(obj, context, code, name, key) {

            if (['c', 'r', 'u', 'd', 'x'].includes(code)) {

            } else code = 'u';

            if (obj.permissions) {
                if (Object.keys(obj.permissions).length > 0) {
                    if (!context.permissionSequence[obj._id]) context.permissionSequence[obj._id] = [];

                    if (!OBJY.checkPermissions(context.activeUser, context.activeApp, obj, code, true, context))
                        context.permissionSequence[obj._id].push({
                            name: name,
                            key: key
                        });
                }
            }
        },

        getElementPermisson: function(element) {
            if (!element) return {};
            else if (!element.permissions) return {};
            else return element.permissions;
        },

    }
}