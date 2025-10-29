//var _OBJY = require('./objy.js');

import _OBJY from './objy.js'

var OBJY = new _OBJY();

OBJY.Logger.enabled = ['none']

OBJY.useUser({username: "hejh"})

OBJY.define({
    name: 'template',
    pluralName: 'templates',
    
})

OBJY.staticRules.push({
        _id: 321,
        affects: {
            role: 'object'
        },
        apply: {
            onCreate: {
                numberCircle: {
                    action: "console.log('created');done({name:1, _id: 2, role:23})",
                },
            },
        },
    });


OBJY.define({
    name: 'object',
    pluralName: 'objects',
    templateFamily: 'template',
    
})


OBJY.object({name: "hello", 
    role: "object",
/*onCreate: {
    bef: {
        action: "console.log('created');done({name:1, _id: 2, role:2})"/*(done, obj) => {
            console.log('created!!!', obj);
            done(1);
        }*
    }
}, */onChange: {
    bef: {
        action: `console.log('CHANGE');
            done(1);
        `
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


    d.setName('benjamin').update(u => {
        console.log('updated...')
    }, err => console.log(err))

    d.remove()

   /* d.setName('newname,,,').update(u => {
        console.log('u updated', u)
    })

    d.remove()*/
})