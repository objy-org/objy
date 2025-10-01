//var _OBJY = require('./objy.js');

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


OBJY.object({name: "hello", 
onCreate: {
    bef: {
        action: "console.log('created');done(1)"/*(done, obj) => {
            console.log('created!!!', obj);
            done(1);
        }*/
    }
}, onChange: {
    bef: {
        action: (done) => {
            console.log('CHANGE');
            done(1);
        }
    }
},
 onDelete: {
    bef: {
        action: (done) => {
            console.log('ddd', obj);
            done(1);
        }
    }
}}).add(d => {
    console.log('d', d)

   /* d.setName('newname,,,').update(u => {
        console.log('u updated', u)
    })

    d.remove()*/
})