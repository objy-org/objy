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
        age: 3
    }
})


OBJY.objects({}).get().then(d => {
    console.log('pdata:', d)

    d[0].addProperty('propertiefs.asfsfasf', 111);

    console.log(d)
})