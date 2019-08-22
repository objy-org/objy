const OBJY = require('./objy.js');
const MongoMapper = require('node_modules/@spootechnologies/objy-catalog/storage/mongoMapper.js')


OBJY.storage = new MongoMapper();

OBJY.define({
    name: "SensorMeasure",
    pluralName: "SensorMeasures",
    storage = new InfluxMapper();
})


OBJY.SensorMeasure({ name: "hallo" }).add(function(data) {
    console.info(data)
})

