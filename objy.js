/*
var _nodejs = (
    typeof process !== 'undefined' && process.versions && process.versions.node);
if (_nodejs) {
    _nodejs = {
        version: process.versions.node
    };
}
*/

var isObject = function(a) {
    return (!!a) && (a.constructor === Object);
};

import generalAttributes from './instance/attributes.js'
import generalFunctions from './instance/general.js'
import applyFunctions from './instance/apply.js'
import permissionFunctions from './instance/permission.js'
import objectFunctions from './instance/object.js'
import mapperFunctions from './instance/mapper.js'
import wrapperFunctions from './instance/wrapper.js'
import propertyFunctions from './instance/property.js'
import pluralConstructorFunctions from './instance/plural-constructor.js'
import singularConstructorFunctions from './instance/singular-constructor.js'

let contextTemplate = {
    activeTenant: null,
    activeUser: null,
    activeApp: null,

    alterSequence: [],
    commandSequence: [],
    permissionSequence: {},
    eventAlterationSequence: [],
    handlerSequence: {},
    familyParams: {}
}


/**
 * OBJY Instance
 */
export default function OBJY(){
    var _OBJY = {};

    Object.assign(_OBJY, {

        globalCtx: Object.assign({}, contextTemplate),

        ...generalAttributes(_OBJY),
    
        ...generalFunctions(_OBJY),
    
        ...applyFunctions(_OBJY),
    
        ...permissionFunctions(_OBJY),
    
        ...objectFunctions(_OBJY),
    
        ...mapperFunctions(_OBJY),
    
        ...wrapperFunctions(_OBJY),
    
        ...propertyFunctions(_OBJY),
    
        ...pluralConstructorFunctions(_OBJY),
    
        ...singularConstructorFunctions(_OBJY),
    
        hello: function() {
            _OBJY.Logger.log("Hello from OBJY!");
        }
    })

    return _OBJY
}

/**
 * Transaction instance
 */ 
/*
var Transaction = function(OBJY) {
    OBJY.globalContext = Object.assign({}, contextTemplate)

    var T = {};

    Object.assign(T, {
        ...singularConstructorFunctions(OBJY),
        ...pluralConstructorFunctions(OBJY),
        ...wrapperFunctions(OBJY)
    })

    return T
}
*/

//var objy = OBJY;

//export OBJY

/*if(_nodejs) module.exports = OBJY; 
else if(typeof window !== 'undefined') {
    window.OBJY = OBJY;
}*/

//if(0)typeof await/2//2; export default OBJY