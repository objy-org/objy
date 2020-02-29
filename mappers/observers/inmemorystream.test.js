var assert = require('assert');
const M = require('./inMemoryStream.js');
const OBJY = require('../../objy.js')

var mapper;
var objectId = "123";
var propName = "prop123";

describe('Object', function() {
    it('create Mapper', function(done) {
      mapper = new M(OBJY);
      done();
    });
});

describe('Object', function() {
    it('add event to schedule', function(done) {
      
      mapper.addEvent(objectId, propName, {interval: 1000, action: 'console.log(1)'}, function(evt){console.log(evt); done()}, function(err){}, 'test');
  
    });
});

describe('Object', function() {
    it('get event from schedule', function(done) {
      
  		mapper.getEvent(objectId, propName, function(evt){

  			console.log(evt);
  			done();

  		}, function(err){
  			console.log(err)
  		}, 'test')
    });
});


describe('Object', function() {
    it('remove event from schedule', function(done) {
      
  		mapper.removeEvent(objectId, propName, function(evt){

  			console.log(evt);
  			done();

  		}, function(err){
  			console.log(err)
  		}, 'test')
    });
});
