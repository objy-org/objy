var moment = require("moment");

Mapper = function(OBJY) {
    return Object.assign(new OBJY.ObserverTemplate(OBJY), {

        initialize: function(millis) {
            var self = this;

            this.interval = setInterval(function() {

                self.run(moment().utc());

            }, this.interval)
        },

        run: function(date) {

            var self = this;

            OBJY.getPersistence(self.objectFamily).listClients(function(data) {

                data.forEach(function(tenant) {

                    OBJY.Logger.log("Running ovserver " + date.toISOString() + " " + tenant)

                    OBJY.getPersistence(self.objectFamily).getByCriteria({
                        _aggregatedEvents: {
                            $elemMatch: {
                                'date': {
                                    $lte: date.toISOString()
                                }
                            }
                        }
                    }, function(objs) {

                        objs.forEach(function(obj) {

                            obj = OBJY[self.objectFamily](obj);

                            obj._aggregatedEvents.forEach(function(aE) {

                                var prop = obj.getProperty(aE.propName);

                                OBJY.execProcessorAction(prop.action, obj, prop, null, function() {

                                    obj.setEventTriggered(aE.propName, true, tenant).update(function(d) {

                                        OBJY.Logger.log('d._aggregatedEvents')
                                        OBJY.Logger.log(d._aggregatedEvents)


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