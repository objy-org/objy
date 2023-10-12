var OBJY = require('./objy.js');

OBJY.define({
    name: 'object',
    pluralName: 'objects'
})

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