var moment = require("moment");

Mapper = function(OBJY) {
    return Object.assign(new OBJY.ProcessorTemplate(OBJY), {

        initialize: function(millis) {
            var self = this;

            // first run
            console.warn('init observer')
            //self.run(new Date());

            // interval
            this.interval = setInterval(function() {

                self.run(moment().utc());

            }, this.interval)
        },

        run: function(date) {

            var self = this;

            self.OBJY.getPersistence(self.objectFamily).listClients(function(data) {

                //console.log("d", data);

                data.forEach(function(tenant) {

                    OBJY.Logger.log("Running...")

                    self.OBJY.getPersistence(self.objectFamily).getByCriteria({
                        _aggregatedEvents: {
                            $elemMatch: {
                                'date': { $lte: date.toISOString() }
                            }
                        }
                    }, function(objs) {

                        objs.forEach(function(obj) {

                            obj = OBJY[self.objectFamily](obj);

                            obj._aggregatedEvents.forEach(function(aE) {

                                var prop = obj.getProperty(aE.propName);

                                self.OBJY.execProcessorAction(prop.action, obj, prop, null, function() {

                                    obj.setEventTriggered(aE.propName, true, tenant).update(function(d) {

                                    }, function(err) {
                                        OBJY.Logger.error(err)
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