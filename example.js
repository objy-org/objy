var OBJY = require('./objy.js');

OBJY.define({
	authable:true,
	name: "user",
	pluralName: "users"
})

OBJY.user({username: "test"}).add(data => {
	data.addApplication("one");
	OBJY.app('one')
	data.addPrivilege('admin')
	console.log(data)
})