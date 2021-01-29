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


var generalAttributes = require('./lib/instance/attributes.js')(OBJY)
var generalFunctions = require('./lib/instance/general.js')(OBJY)
var applyFunctions = require('./lib/instance/apply.js')(OBJY)
var permissionFunctions = require('./lib/instance/permission.js')(OBJY)
var objectFunctions = require('./lib/instance/object.js')(OBJY)
var mapperFunctions = require('./lib/instance/mapper.js')(OBJY)
var wrapperFunctions = require('./lib/instance/wrapper.js')(OBJY)
var propertyFunctions = require('./lib/instance/property.js')(OBJY)
var pluralConstructorFunctions = require('./lib/instance/plural-constructor.js')(OBJY)
var singularConstructorFunctions = require('./lib/instance/singular-constructor.js')(OBJY)

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

if (_nodejs) module.exports = OBJY;
else if (window) window.OBJY = OBJY;