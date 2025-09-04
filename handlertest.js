//var _OBJY = require('./objy.js');

import _OBJY from './objy.js'

var OBJY = new _OBJY();

//OBJY.Logger.enabled = ['none']

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


OBJY.object({name: "hello", onCreate: {
    bef: {
        trigger: "after",
        action: (callback) => {
            console.log(111);
            callback(1);
        }
    }
}, onChange: {
    bef: {
        trigger: "after",
        action: (callback) => {
            console.log('CHANGE');
            callback(1);
        }
    }
},
 onDelete: {
    bef: {
        trigger: "after",
        action: (callback) => {
            console.log('DELETE');
            callback(1);
        }
    }
}}).add(d => {
    console.log('d', d)

    d.setName('newname,,,').update(u => {
        console.log('u updated', u)
    })

    d.remove()
})