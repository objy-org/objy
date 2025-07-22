import _OBJY from './objy.js'

var OBJY = new _OBJY();

OBJY.Logger.enabled = ['none']

OBJY.useUser({username: "hejh"})

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
    evt: {
        type: "event",
        interval: "P1Y",
        action: "console.log(1)"
    },
    properties: {
        lastnam: "sgsg",
        supername: {
            type: "event",
            date: '2024-05-15T13:49:01.704Z',
            action: 'hello'
        }
    }
}).add(data => {
    console.log('added', data)

    data.addProperty('properties.hello', {type: "number", value: "1"}).update(d => {
        console.log('updated', d)
    })

    OBJY.object({inherits: [data._id]}).add((o) => {
        OBJY.object(o._id).get(o2 => {
            console.log('o2', o2)
        })
    })
});