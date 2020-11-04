const OBJY = require('../objy.js');
var assert = require('assert');

OBJY.Logger.enabled = ["error"];

describe('Permissions', function() {

    OBJY.define({
        name: "Object",
        pluralName: "Objects"
      });

     var userName = 'peter';

  	test('should set user', function(done) {

        OBJY.useUser(userName);
    		expect(OBJY.activeUser).toBe(userName);
        done();

    });

});
