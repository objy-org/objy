const OBJY = require('../objy.js');
var assert = require('assert');

OBJY.Logger.enabled = ["error"];

describe('Affectable', function() {

    OBJY.define({
        name: "Object",
        pluralName: "Objects"
      });

    OBJY.affectables = [{
      _id: 123,
      affects: {},
      apply: {
        permissions: {
          admin: {
            value: "*"
          }
        }
      }
    }]

  	test('should merge structure', function(done) {

  		OBJY.Object({name: "template", properties: {
  			weight: {
  				type: "number",
  				value: 23
  			}, 
  			age: 22
  		}}).add(data => {
  			expect(data.permissions.admin.value).toBe('*');
        done();
  		})
  	});

  });
