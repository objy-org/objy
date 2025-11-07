//var _OBJY = require('./objy.js');

import _OBJY from './objy.js'

var OBJY = new _OBJY();

OBJY.Logger.enabled = ['none']

OBJY.useUser({username: "hejh"})

OBJY.define({
    name: 'template',
    pluralName: 'templates',
    
})

OBJY.affectables.push({
        _id: 321,
        affects: {
            role: 'object'
        },
        apply: {
            onCreate: {
                numberCircle: {
                    action: "console.log('created by rule');done()",
                    hidden: true
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
onCreate: {
    bef: {
        action: "console.log('creatediiii');done()"
    }
}, onChange: {
    ch: {
        action: `console.log('CHANGE');done(1);`
    }
},
 onDelete: {
    bef: {
        action: "console.log('deleete')"
    }
}}).add(d => {
    console.log('done-', d)


    d.setName('benjamin').update(u => {
        console.log('updated.....')
    }, err => console.log(err))

    d.remove()

   /* d.setName('newname,,,').update(u => {
        console.log('u updated', u)
    })

    d.remove()*/
})