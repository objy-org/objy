const OBJY = require('../objy.js');

var assert = require('assert');
describe('Object', function() {
  describe('#constructor', function() {
    it('should form an object', function(done) {
      
      OBJY.define({
      	name: "Object",
      	pluralName: "Objects"
      });

      var o = OBJY.Object({});

      done();
      
    });
  });
});