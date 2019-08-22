var mongoose = require('mongoose');
var Schema = mongoose.Schema;
var Admin = mongoose.mongo.Admin;

var Global = require('./_template.js')

var clientSchema = {
    name: String
};
var ClientSchema = new Schema(clientSchema);

var generalObjectModel = {
    type: String,
    role: String,
    inherits: [],
    applications: [],
    name: String,
    onDelete: {},
    onCreate: {},
    onChange: {},
    permissions: {},
    properties: {},
    created: String,
    lastModified: String,
    aggregatedEvents: [],
    tenantId: String,
    password:String,
    username:String,
    email:String
};

var ObjSchema = new Schema(generalObjectModel);


Mapper = function(SPOO, options) {
    return Object.assign(new Global(SPOO, options), {

        database: {},
        index: {},
        globalPaging: 20,

        connect: function(connectionString, success, error) {
            this.database = mongoose.createConnection(connectionString);

            this.database.on('error', function(err) {
                error(err)
            });

            this.database.once('open', function() {
                success();
            });

            return this;
        },

        getDBByMultitenancy: function(client) {

            if (this.multitenancy == this.CONSTANTS.MULTITENANCY.SHARED) {
                return this.database.useDb('spoo')
            } else if (this.multitenancy == this.CONSTANTS.MULTITENANCY.ISOLATED) {
                return this.database.useDb(client)
            }
        },

        createClient: function(client, success, error) {

            var db = this.getDBByMultitenancy(client);

            var ClientInfo = db.model('clientinfos', ClientSchema);


            ClientInfo.find({ name: client }).exec(function(err, data) {
                if (err) {
                    error(err);
                    return;
                }
                if (data.length >= 1) {
                    error("client name already taken")
                } else {

                    new ClientInfo({ name: client }).save(function(err, data) {
                        if (err) {

                            error(err);
                            return;
                        }

                        success(data);
                        console.log('SAVED CLIENT TO DB');
                    })
                }

            });
        },


        listClients: function(success, error) {


            if (this.multitenancy == this.CONSTANTS.MULTITENANCY.ISOLATED) {

                new Admin(this.database.db).listDatabases(function(err, result) {
                    if (err) error(err)
                    success(result.databases.map(function(item) {
                        return item.name
                    }));
                });

            } else {
                var db = this.getDBByMultitenancy('spoo');

                var ClientInfo = db.model('clientinfos', ClientSchema);

                ClientInfo.find({}).exec(function(err, data) {

                    if (err) {
                        console.log("err");
                        error(err);
                        return;
                    }
                    console.log(data.map(function(item) {
                        return item.name
                    }));
                    success(data.map(function(item) {
                        return item.name
                    }))

                });

            }
        },

        getById: function(id, success, error, app, client) {

            var db = this.getDBByMultitenancy(client);

            var constrains = { _id: id };
            console.log("app", app)
            if (app) constrains['applications'] = { $in: [app] }

            if (this.multitenancy == this.CONSTANTS.MULTITENANCY.SHARED && client) constrains['tenantId'] = client;

            Obj = db.model(this.objectFamily, ObjSchema);

            console.log(constrains);

            Obj.findOne(constrains, function(err, data) {
                if (err) {
                    error(err);
                    return;
                }
                console.log(data);
                success(data);
                return;
            });
        },

        getByCriteria: function(criteria, success, error, app, client, flags) {

            var db = this.getDBByMultitenancy(client);

            var Obj = db.model(this.objectFamily, ObjSchema);

            if (flags.$page == 1) flags.$page = 0;
            else flags.$page-=1;

            if (this.multitenancy == this.CONSTANTS.MULTITENANCY.SHARED && client) criteria['tenantId'] = client;

          
            Obj.find(criteria).limit(this.globalPaging).skip(this.globalPaging * (flags.$page || 0)).sort(flags.$sort || '_id').exec(function(err, data) {

                if (err) {
                    error(err);
                    return;
                }
                
                success(data);
                return;
            });


        },

        count: function(criteria, success, error, app, client, flags) {

            var db = this.getDBByMultitenancy(client);

            var Obj = db.model(this.objectFamily, ObjSchema);

            if (this.multitenancy == this.CONSTANTS.MULTITENANCY.SHARED && client) criteria['tenantId'] = client;

            Obj.count(criteria).exec(function(err, data) {
                if (err) {
                    error(err);
                    return;
                }
                console.log(data);
                success({ 'result': data });
                return;
            });
        },

        update: function(spooElement, success, error, app, client) {

            var db = this.getDBByMultitenancy(client);

            var Obj = db.model(this.objectFamily, ObjSchema);

            var criteria = { _id: spooElement._id };

            if (this.multitenancy == this.CONSTANTS.MULTITENANCY.SHARED && client) criteria['tenantId'] = client;

            Obj.findOneAndUpdate(criteria, spooElement, function(err, data) {
                if (err) {
                    console.log("update err");
                    error(err);
                    return;
                }
                if (data.n != 0) success(spooElement);
                else error("object not found");
                console.log('UPDATED TO DB');
            })
        },

        add: function(spooElement, success, error, app, client) {

            var db = this.getDBByMultitenancy(client);

            if (app) {
                if (spooElement.applications.indexOf(app) == -1) spooElement.applications.push(app);
            }
            
            console.log(this.objectFamily);
            
            var Obj = db.model(this.objectFamily, ObjSchema);

            delete spooElement._id;

            if (this.multitenancy == this.CONSTANTS.MULTITENANCY.SHARED) spooElement.tenantId = client;

            new Obj(spooElement).save(function(err, data) {
                if (err) {
                    console.log("save err", err);
                    error(err);
                    return;
                }
                console.log(data);
                success(data);
                console.log('SAVED TO DB');
            })


        },
        remove: function(spooElement, success, error, app, client) {

            var db = this.getDBByMultitenancy(client);

            var Obj = db.model(this.objectFamily, ObjSchema);

            var criteria = { _id: spooElement._id };

            if (this.multitenancy == this.CONSTANTS.MULTITENANCY.SHARED && client) criteria['tenantId'] = client;

            Obj.deleteOne(criteria, function(err, data) {
                if (err) {
                    error(err);
                    return;
                }
                if (data.n == 0) error("object not found");
                else {
                    console.log("remove success");
                    success(true);
                }

            })

        }


    })
}



module.exports = Mapper;