var _nodejs = (
    typeof process !== 'undefined' && process.versions && process.versions.node);
if (_nodejs) {
    _nodejs = {
        version: process.versions.node
    };
}

var isObject = function(a) {
    return (!!a) && (a.constructor === Object);
};

var generalAttributes = require('./instance/attributes.js')
var generalFunctions = require('./instance/general.js')
var applyFunctions = require('./instance/apply.js')
var permissionFunctions = require('./instance/permission.js')
var objectFunctions = require('./instance/object.js')
var mapperFunctions = require('./instance/mapper.js')
var wrapperFunctions = require('./instance/wrapper.js')
var propertyFunctions = require('./instance/property.js')
var pluralConstructorFunctions = require('./instance/plural-constructor.js')
var singularConstructorFunctions = require('./instance/singular-constructor.js')

/**
 * OBJY Instance
 */
var OBJY = function(){
    var _OBJY = {};

    Object.assign(_OBJY, {

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
            OBJY.Logger.log("Hello from OBJY!");
        }
    })

    return _OBJY
}

var objy = OBJY;

if(_nodejs) module.exports = OBJY; 
else if(typeof window !== 'undefined') {
    window.OBJY = OBJY;
}

if(0)typeof await/2//2; export default OBJY