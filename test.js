const OBJY = require('./objy.js');

var assert = require('assert');

var Obj;

describe('Object', function() {
    it('should form an object', function(done) {
      
      OBJY.define({
      	name: "Object",
      	pluralName: "Objects"
      });

      Obj = OBJY.Object({});

      done();
      
    });
});