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
    }
})

OBJY.objects({}).get().then(d => {
    console.log('pdata:', d)
})