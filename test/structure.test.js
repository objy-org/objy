const OBJY = require('../objy.js');
var assert = require('assert');

OBJY.Logger.enabled = ["error"];

describe('Structure', function() {

    test('should form an object', function(done) {

    	OBJY.define({
    		name: "Object",
    		pluralName: "Objects"
    	});

    	Obj = OBJY.Object({});
    	expect(Obj).toBeTruthy();
    	done();

    });


    test('should have added the structure', function(done) {

    	OBJY.app('two'); 
    	var testString = "test";
    	var testNumber = 43;

    	OBJY.Object({name: testString,
    		type: testString, 
    		properties: {
    			weight: {
    				type: "number",
    				value: testNumber
    			}, 
    			age: testNumber
    		},
    		applications: ["one"],
    		permissions: {
    			admin: {
    				value: "*"
    			}
    		}
    	}).add(data => {
    		expect(data.name).toBe(testString);
    		expect(data.type).toBe(testString);
    		expect(data.applications).toContain('one');
    		expect(data.applications).toContain('two');
    		expect(data.properties.age).toBe(testNumber);
    		expect(data.properties.weight.value).toBe(testNumber);
    		expect(data.permissions.admin.value).toBe('*');
    		done();
    	})
    });


    test('should have mutated the structure', function(done) {

    	OBJY.app('two'); 
    	var testString = "test";
    	var testStringFinal = "test";
    	var testNumber = 43;
    	var testNumberFinal = 43;

    	var obj = OBJY.Object({name: testString, 
    		type: testString, 
    		properties: {
    			weight: {
    				type: "number",
    				value: testNumber
    			}, 
    			age: testNumber
    		},
    		applications: ["one"],
    		permissions: {
    			admin: {
    				value: "*"
    			}
    		}
   		});

    	obj
	      .setName(testStringFinal)
	      .setType(testStringFinal)
	      .addProperty('test', testString)
	      .setPropertyValue('weight', testNumberFinal)
	      .addProperty('evt', {type: "event", date: new Date().toISOString()})
	      .setPermission('admin', {value:'r'})
	      .setPermission('admin2', {value:'*'})
	      .addApplication('three')
	      .setOnChange('init', {value: 'test'})
	      .setOnCreate('init', {value: 'test'})
	      .setOnDelete('init', {value: 'test'})

	    expect(obj.name).toBe(testStringFinal);
	    expect(obj.type).toBe(testStringFinal);
	    expect(obj.properties.test).toBe(testString);
	    expect(obj.properties.weight.value).toBe(testNumberFinal);
	    expect(obj.properties.evt.date).toBeTruthy();
	    expect(obj.permissions.admin.value).toBe('r');
	   	expect(obj.permissions.admin2.value).toBe('*');
	   	expect(obj.applications).toContain('three');
	   	expect(obj.onChange.init).toBeTruthy();
	   	expect(obj.onCreate.init).toBeTruthy();
	   	expect(obj.onDelete.init).toBeTruthy();

    	obj
    	  .setProperty('weight', testStringFinal)
    	  .removeProperty('test')
    	  .removePermission('admin')
    	  .removeApplication('one')
    	  .removeOnCreate('init')
    	
    	expect(obj.properties.weight).toBe(testStringFinal);
    	expect(obj.permissions.admin).toBe(undefined);
    	expect(obj.applications).not.toContain('one')
    	expect(obj.onCreate).not.toContain('init')
    	expect(obj.onChange).not.toContain('init')
    	expect(obj.onDelete).not.toContain('init')

    	done();

    });

  

  });


