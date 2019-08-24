const OBJY = require('@spootechnologies/objy');

//const MongoMapper = require('node_modules/@spootechnologies/objy-catalog/storage/mongoMapper.js')

//OBJY.storage = new MongoMapper();

OBJY.define({
    name: "SensorMeasure",
    pluralName: "SensorMeasures"
})


OBJY.SensorMeasure({ name: "hallo" }).add(function(data) {
    console.info(data)
})

