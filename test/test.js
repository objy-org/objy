const OBJY = require('./objy.js');

var assert = require('assert');

var Obj;

describe('Object', function() {
    test('should form an object', function(done) {
      
      OBJY.define({
      	name: "Object",
      	pluralName: "Objects"
      });

      Obj = OBJY.Object({});
      expect(Obj).toBeTruthy();
      done();
      
    });
});