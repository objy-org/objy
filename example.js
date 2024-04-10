var _OBJY = require('./objy.js');

var OBJY = new _OBJY();

OBJY.Logger.enabled = ['none']

OBJY.define({
    name: 'template',
    pluralName: 'templates',
    
})

OBJY.define({
    name: 'object',
    pluralName: 'objects',
    templateFamily: 'template',
    
})

OBJY.template({
    name: "template123",
    nested: {
        inner: {
            type: "boolean",
            value: true
        }
    },
    properties: {
        lastnam: "sgsg",
        supername: {
            type: "event",
            date: '',
            action: 'hello'
        }
    }
});

OBJY.templates({}).get(templates => {
    templates.forEach(templ => {
        console.log('t', templ)
        var o = OBJY.object({inherits: [templ._id], marco: 'nicole', properties: {
            evt: {
                type: "event",
                interval: '',
                action: 'hello'
            }
        }});
        o.setEventTriggered('properties.evt', true, 'tenant').setPropertyValue('properties.supername', 456).setPropertyValue('nested.inner', false).addProperty('nested.whatever', 'sgsga').removeProperty('marco').update();

        OBJY.objects({}).get(objs => {
    console.log('all objs', JSON.stringify(objs, null, 4))
})
    })
})


/*

OBJY.object({
    name: "hello",
    interval: {
        type: 'event',
        interval: 1000,
        action: () => {
            console.log('hello')
        }
    },
    properties: {
        age:1111
    }
})


OBJY.objects({}).get().then(d => {
    console.log('pdata:', d)

    d[0].addProperty('properties.innerBag', {type: "bag", properties: {
        size: {
            value: 14124 ,
            type: 'number'
        }
    }});

    console.log('final:',   JSON.stringify(d, false, 4))
}).catch(e => {
    console.log(e)
})
*/