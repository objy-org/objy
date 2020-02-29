var assert = require('assert');
const M = require('./bullJSMapper.js');
const OBJY = require('../../objy.js')

var mapper;
var objectId = "123";
var propName = "prop123";
//var evtProp = {date: new Date().getTime(), action: 'console.log(1)'};
var evtProp = {interval: 1000, action: 'console.log(1)'};

describe('Object', function() {
    it('create Mapper', function(done) {
      mapper = new M(OBJY);
      done();
    });
});

describe('Object', function() {
    it('add event to schedule', async function(done) {
      
      mapper.addEvent(objectId, propName, evtProp, function(evt){

        done();

      }, function(err){}, 'test');
  
    });
});

describe('Object', function() {
    it('remove event from schedule', function(done) {
      
  		mapper.removeEvent(objectId, propName, evtProp, function(evt){

  			console.log(evt);
  			done();

  		}, function(err){
  			console.log(err)
  		}, 'test')
    });
});
