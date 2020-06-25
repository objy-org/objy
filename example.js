const OBJY = require('./objy.js');
const stream = require('stream');
const fs = require('fs')
const EventMapper = require('./mappers/observers/inMemoryStream.js')
var Processor = require('./mappers/processors/eval.js');



var DefaultProcessor = new Processor(OBJY, {});


DefaultProcessor.pushToWorkspace = function(obj, targetWorkspace) {
    var ws = OBJY.activeTenant;

    console.log('aaaaaaaaaaööööllll--', obj);

    OBJY[obj.role](obj._id).get(function(data) {
        console.log('data:::', data);
        if (data.length == 0) {
            // ADD
            OBJY.client(targetWorkspace);

            OBJY[obj.role](obj).add(function(data) {
                console.log('added', data);
                OBJY.client(ws);
            }, function(e) {
                console.log('e', e);
                OBJY.client(ws);
            }) 
        } else if (data.length > 0) {
            // UPDATE
            OBJY.client(targetWorkspace);

            OBJY[obj.role](data[0]).replace(obj).update(function(data) {
                console.log('updated', data);
                OBJY.client(ws);
            }, function(e) {
                console.log('e', e);
                OBJY.client(ws);
            })

        }
    }, function(err) {
        console.log('err', targetWorkspace, err);
        OBJY.client(targetWorkspace);
        console.log(OBJY.activeTenant);
        OBJY[obj.role](obj).add(function(data) {
            console.log('added', data);
            console.log(OBJY.mappers);
            OBJY.client(ws);
        }, function(e) {
            console.log('e', e);
            OBJY.client(ws);
        })

    })
};



//OBJY.storage = new MongoMapper();

OBJY.affectables = [{
    _id: "user readonly",
    affects: { role: 'user' },
    apply: { permissions: {admin: "*"} }
},{
    _id: "general",
    affects: { role: 'object' },
    apply: { applications: ['ssg'], properties: { firstName: 23 } }
}, {
    _id: "general2",
    affects: {},
    apply: { _clients: ["ssg"], onCreate: { replicate: { value: "console.log('sfsfsf');this.pushToWorkspace({_id:'222', role:'object'}, 'aaa')", trigger: "after" } } }
}];

OBJY.useUser({
    authorisations: {
        '*': [{ query: {}, perm: 'cru' }]
    }
})

OBJY.define({
    name: "object",
    pluralName: "objects",
    templateSource: 'aaa',
    templateFamily: 'object',
    processor: DefaultProcessor,
    authable: true
})


OBJY.define({
    processor: DefaultProcessor,
    name: "affect",
    pluralName: "affects",
    isRule: true
})

OBJY.affect({
    processor: DefaultProcessor,
    name: "Users",
    affects: {
        role: 'user'
    },
    apply: {
        firstName: null,
        lastName: null
    }
}).add((d, e) => {
    console.log('d', d)
})


OBJY.object({
    "authorisations": {
        '*': [{ query: { type: "test", perm: "crud" } }]
    },
    "properties": {
        "timeGroups": {
            "type": "bag",
            "template": "123",
            "properties": {
                test: 124
            }
        },
        stops: {
            type: "bag",
            template: "22424",
            properties: {
                "1131414": {
                    type: "bag",
                    "proeprties": {}
                }
            }
        }
    }
}).add(function(data) {

    console.log('added', data);


    OBJY.object({
        "inherits": [data._id],
        "properties": {
            "timeGroups": {
                "type": "bag",
                "template": "123",
                "properties": {
                    test: 124
                }
            },
            stops: {
                type: "bag",
                template: data._id,
                properties: {
                    "1131414": {
                        type: "bag",
                        "proeprties": {}
                    }
                }
            }
        }
    }).add(function(data) {
        data.addProperty('ttt', 222).update(function(data) {
            console.log('up', JSON.stringify(data, null, 4));
        })
    })



    return;

    OBJY.object({
        "authorisations": {
            '*': [{ query: { type: "test111", perm: "*" } }]
        },
    }).add(function(data5) {

        OBJY.object({
            name: "inherited",
            inherits: [data._id, data5._id]
        }).add(function(d2) {

            OBJY.object(d2).get(function(d3) {
                console.log('Asfafs', JSON.stringify(d3, null, 4));
            })

        })

    })

})


return;

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

    //observer : new EventMapper(OBJY)
})


OBJY.SensorMeasure({ name: "sss", properties: { test: { evt: { type: 'event', interval: 12000, action: "console.log('hit hre')" } } } }).add(function(data1) {

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

    setTimeout(function() {
        data1.remove(function(d) {


        })
        console.info(data1)
    }, 15000)

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