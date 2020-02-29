const OBJY = require('./objy.js');
const stream = require('stream');
const fs = require('fs')
const EventMapper = require('./mappers/observers/inMemoryStream.js')

//OBJY.storage = new MongoMapper();


OBJY.client('mb');

OBJY.useUser({
    authorisations: {
        '*': [{query: {}, perm:'*'}]
    }
})

//OBJY.metaPropPrefix = '_';

OBJY.define({
    name: "SensorMeasure",
    pluralName: "SensorMeasures",
    customProps: {
        assi: null
    },
    observer : new EventMapper(OBJY)
})


OBJY.SensorMeasure({name: "sss", properties: { test: { evt: {type: 'event', interval: 12000, action: "console.log('hit hre')" }}}}).add(function(data1) {

    /*OBJY.SensorMeasure(data1._id).get(function(data) {
        data.replace({name: "sss", evt: {type: 'event', interval: "5s", action: "console.log('hit hre')" }}).update(function(saved){
            console.log(saved)
        })
    })*/

    setTimeout(function()
    {
        data1.remove(function(d){

    })
    console.info(data1)
},15000)
    

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