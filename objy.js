var _nodejs = (
    typeof process !== 'undefined' && process.versions && process.versions.node);
if (_nodejs) {
    _nodejs = {
        version: process.versions.node
    };
}

var OBJY = {};

var isObject = function(a) {
    return (!!a) && (a.constructor === Object);
};


var generalAttributes = require('./instance/attributes.js')(OBJY)
var generalFunctions = require('./instance/general.js')(OBJY)
var applyFunctions = require('./instance/apply.js')(OBJY)
var permissionFunctions = require('./instance/permission.js')(OBJY)
var objectFunctions = require('./instance/object.js')(OBJY)
var mapperFunctions = require('./instance/mapper.js')(OBJY)
var wrapperFunctions = require('./instance/wrapper.js')(OBJY)
var propertyFunctions = require('./instance/property.js')(OBJY)
var pluralConstructorFunctions = require('./instance/plural-constructor.js')(OBJY)
var singularConstructorFunctions = require('./instance/singular-constructor.js')(OBJY)

/**
 * Main OBJY Instance
 */
Object.assign(OBJY, {

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

objy = OBJY;


if(_nodejs) module.exports = OBJY; 
else if(typeof window !== 'undefined') {
    window.OBJY = OBJY;
}

if(0)typeof await/2//2; export default OBJY