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

OBJY.application({name:"sasf"}).add()
OBJY.application("sasf").remove()