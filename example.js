const OBJY = require('./objy.js');

//const MongoMapper = require('node_modules/@spootechnologies/objy-catalog/storage/mongoMapper.js')

//OBJY.storage = new MongoMapper();

OBJY.metaPropPrefix = '_';

OBJY.define({
    name: "SensorMeasure",
    pluralName: "SensorMeasures"
})


var t = OBJY.SensorMeasure({ name: "hallo", test: 22 }).add(function(data) {
    //console.info('ss', data)
});

console.log('fsgdsd', t)