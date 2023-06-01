var OBJY = require('./objy.js');

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

OBJY.objects({}).get(d => {
    console.log(d)
})