const OBJY = require('./objy.js');

//const MongoMapper = require('node_modules/@spootechnologies/objy-catalog/storage/mongoMapper.js')

//OBJY.storage = new MongoMapper();

OBJY.metaPropPrefix = '_';

OBJY.define({
    name: "SensorMeasure",
    pluralName: "SensorMeasures",
    customProps: {
        assi: null
    }
})

var t = OBJY.SensorMeasure({
    name: "hallo",
    test: 22,
    mybag: {
        type: 'bag',
        properties: {
            test: {
                type: 'shortText',
                value: 'asaf',
                onCreate: {}
            }
        }
    }
}).add(function(data) {
    console.info('_', data)

    OBJY.SensorMeasures({}).get(function(data) {
        console.info('ddd', data)
    })
});

var t2 = t.replace({
    name: "hallo",
    test222: 22,
    mybag: {
        type: 'bag',
        properties: {
            test2: {
                type: 'shortText',
                value: 'asaf',
                onCreate: {}
            }
        }
    }
})

console.log('fsgdsd', t2)