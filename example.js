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


OBJY.define({name: "Permission", pluralName: "Permissions"})

OBJY.define({
    name: "Rule",
    pluralName: "Rules",
    isRule:true,
    storage: {}
})


OBJY.Rule({
    affects: {
        type: 'mav-user',
        privileges: {
            userdirectory: ['mav']
        }
    }
}).add()


OBJY.Rule({
    affects: {
        type: 'bewerber',
        permissions: {
            mav: 'r'
        }
    }
}).add()

OBJY.Rule({
    affects: {},
    onCreate: {
        dsl: {
            value: "email()"
        }
    }
    
}).add()



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