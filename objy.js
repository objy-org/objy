var _nodejs = (
    typeof process !== 'undefined' && process.versions && process.versions.node);
if (_nodejs) {
    _nodejs = {
        version: process.versions.node
    };
}

var _OBJY = {};

var isObject = function(a) {
    return (!!a) && (a.constructor === Object);
};


var generalAttributes = require('./instance/attributes.js')(_OBJY)
var generalFunctions = require('./instance/general.js')(_OBJY)
var applyFunctions = require('./instance/apply.js')(_OBJY)
var permissionFunctions = require('./instance/permission.js')(_OBJY)
var objectFunctions = require('./instance/object.js')(_OBJY)
var mapperFunctions = require('./instance/mapper.js')(_OBJY)
var wrapperFunctions = require('./instance/wrapper.js')(_OBJY)
var propertyFunctions = require('./instance/property.js')(_OBJY)
var pluralConstructorFunctions = require('./instance/plural-constructor.js')(_OBJY)
var singularConstructorFunctions = require('./instance/singular-constructor.js')(_OBJY)

/**
 * Main _OBJY Object
 */
Object.assign(_OBJY, {

    ...generalAttributes,

    ...generalFunctions,

    ...applyFunctions,

    ...permissionFunctions,

    ...objectFunctions,

    ...mapperFunctions,

    ...wrapperFunctions,

    ...propertyFunctions,

    ...pluralConstructorFunctions,

    ...singularConstructorFunctions,

    hello: function() {
        OBJY.Logger.log("Hello from OBJY!");
    }
})



var OBJY = function(){
    return Object.assign({}, _OBJY);
}

var objy = OBJY;

if(_nodejs) module.exports = OBJY; 
else if(typeof window !== 'undefined') {
    window.OBJY = OBJY;
}

if(0)typeof await/2//2; export default OBJY