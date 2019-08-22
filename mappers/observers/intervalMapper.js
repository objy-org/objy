var Global = require('./_template.js');
var moment = require("moment");

Mapper = function(SPOO) {
    return Object.assign(new Global(SPOO), {

        initialize: function(millis) {
            var self = this;

            // first run
            //self.run(new Date());

            // interval
            this.interval = setInterval(function() {

                self.run(moment().utc());

            }, this.interval)
        },

        run: function(date) {

            var self = this;

            self.SPOO.getPersistence(self.objectFamily).listClients(function(data) {

                //console.log("d", data);

                data.forEach(function(tenant) {

                    console.log("current run: ", date.toISOString(), tenant);


                    self.SPOO.getPersistence(self.objectFamily).getByCriteria({
                        aggregatedEvents: {
                            $elemMatch: {
                                'date': { $lte: date.toISOString() }
                            }
                        }
                    }, function(objs) {

                        objs.forEach(function(obj) {

                            obj = SPOO[self.objectFamily](obj);

                            obj.aggregatedEvents.forEach(function(aE) {

                                var prop = obj.getProperty(aE.propName);

                                self.SPOO.execProcessorAction(prop.action, obj, prop, null, function() {

                                    obj.setEventTriggered(aE.propName, true, tenant).update(function(d) {
                                        console.log("remaining events: ", d.aggregatedEvents);
                                        console.log(obj.getProperty(aE.propName));
                                    }, function(err) {
                                        console.log(err);
                                    }, tenant)


                                }, tenant, {});

                            })


                        })

                    }, function(err) {

                    }, /*app*/ undefined, tenant, {})
                })

            }, function(err) {

            })
        }


    })
}


module.exports = Mapper;