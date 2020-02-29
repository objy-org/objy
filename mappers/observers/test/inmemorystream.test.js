var assert = require('assert');
const M = require('./inMemoryStream.js');
const OBJY = require('../../objy.js')

var mapper;
var objectId = "123";
var propName = "prop123";


describe('Object', function() {


    test('create Mapper', function(done) {
      mapper = new M(OBJY);
      expect(mapper).toBeTruthy();
      done();
    });

    test('add event to schedule', function(done) {
      
      mapper.addEvent(objectId, propName, {interval: 1000, action: 'console.log(1)'}, function(evt){
        expect(evt).toBeTruthy();
        done()
      }, function(err){}, 'test');
  
    });

    test('get event from schedule', function(done) {
      
  		mapper.getEvent(objectId, propName, function(evt){
        expect(evt).toBeTruthy();
  			done();
  		}, function(err){
  			console.log(err)
  		}, 'test')
    });

    test('remove event from schedule', function(done) {
      
  		mapper.removeEvent(objectId, propName, function(evt){
  			expect(evt).toBeTruthy();
  			done();
  		}, function(err){
  			console.log(err)
  		}, 'test')
    });
});
