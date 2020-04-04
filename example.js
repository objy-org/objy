const OBJY = require('./objy.js');
const stream = require('stream');
const fs = require('fs')
const EventMapper = require('./mappers/observers/inMemoryStream.js')

//OBJY.storage = new MongoMapper();


OBJY.client('mb');

OBJY.useUser({
    authorisations: {
        '*': [{ query: {}, perm: '*' }]
    }
})

OBJY.Logger.enabled = ['error'];
//OBJY.metaPropPrefix = '_';

OBJY.define({
    name: "SensorMeasure",
    dirty: true,
    pluralName: "SensorMeasures",
    customProps: {
        assi: null
    },
    observer: new EventMapper(OBJY)
})


OBJY.SensorMeasure({ name: "sss", properties: { groups: { one: { o: 1 }, two: { t: 2 } } } }).add(function(data1) {

    console.log('added', data1);

    OBJY.SensorMeasure(data1._id).get(function(f) {
        console.log('f', f)
    })


});

return;

OBJY.SensorMeasure({ name: "sss", properties: { groups: { one: { o: 1 }, two: { t: 2 } } } }).add(function(data1) {

    /*OBJY.SensorMeasure(data1._id).get(function(data) {
        data.replace({name: "sss", evt: {type: 'event', interval: "5s", action: "console.log('hit hre')" }}).update(function(saved){
            console.log(saved)
        })
    })*/

    OBJY.SensorMeasure({ inherits: [data1._id], name: 'underobject' }).add(function(data2) {

        OBJY.SensorMeasure(data2._id).get(function(data3) {
            //console.log('d3', data3)

            //data3 = OBJY.SensorMeasure(data3);

            //data3.addProperty('groups.three', { type: 'shortText', value: 'fff' });

            //console.log('zwische', data3)

            data3.properties.groups.three = { t: 3 }
            //data3.addProperty('three', { t: 3 })

            data3.replace(data3).update(function(d4) {
                data1.replace({ name: "sss", properties: { groups: { one: { o: 1 }, two: { t: 2 }, four: { f: 4 } } } }).update(function(data5) {
                    console.warn('REPLACED THAT SHIT', data5);
                    OBJY.SensorMeasure(d4._id).get(function(d6) {
                        console.warn('d6', d6)
                    })

                });


            })

        })

    })

})


return;


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