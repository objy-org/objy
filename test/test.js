const OBJY = require('../objy.js');

var assert = require('assert');

var Obj;


describe('Object', function() {
    
    // Basic
    test('should form an object', function(done) {
      
      OBJY.define({
      	name: "Object",
      	pluralName: "Objects"
      });

      Obj = OBJY.Object({});
      expect(Obj).toBeTruthy();
      done();
      
    });


  	// Inheritance
    test('should inherit form object', function(done) {
      
   	  OBJY.Object({name: "template", properties: {
   	  	weight: {
   	  		type: "number",
   	  		value: 23
   	  	}, 
   	  	age: 22
   	  }}).add(data => {
   	  	 OBJY.Object({inherits: [data._id]}).add(data => {

   	  	 	OBJY.Object(data).get(obj => {
   	  	 		console.log(obj)
   	  	 		expect(obj.properties.weight.value).toBe(23);
   	  	 		expect(obj.properties.age).toBe(22);
   	  	 		done();
   	  	 	})
	   	  })
   	  })
    });


});


