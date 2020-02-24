const OBJY = require('./objy.js');
const stream = require('stream');
const fs = require('fs')
//const MongoMapper = require('node_modules/@spootechnologies/objy-catalog/storage/mongoMapper.js')

//OBJY.storage = new MongoMapper();


OBJY.client('mb');

//OBJY.metaPropPrefix = '_';

OBJY.define({
    name: "SensorMeasure",
    pluralName: "SensorMeasures",
    customProps: {
        assi: null
    },
    observer: null
})



OBJY.define({
    name: "File",
    pluralName: "Files",
    storage: new OBJY.Mapper.Storage.Mongo(OBJY).connect('mongodb://localhost', () => {

        const s = fs.createReadStream('example.js')

        OBJY.File({ properties: { data: s } }).add((d) => {

            OBJY.File(d._id).get((data) => {
                console.log('got file')
                console.log(data)

                /*var ws = fs.createWriteStream(data._id, {
                    flags: 'w'
                });

                data.properties.data.pipe(ws)*/

            }, (e) => {

            })

        }, () => {})
    }, () => {
        console.error('connect error')
    })
})


return;


var t = OBJY.SensorMeasure({
    name: "hallo",
    test: 22,
    _onCreate: {
        test: {
            value: "console.warn(1);"
        }
    },
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

    /*OBJY.SensorMeasures({}).get(function(data) {
        console.info('ddd', data)
    })*/
});

/*
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

console.log('fsgdsd', t2)*/

//OBJY.@Permission({ apps: ['crm'], users: {}, entities: {} })