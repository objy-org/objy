var OBJY = require('./objy.js');

OBJY.define({
	//authable:true,
	name: "user",
	pluralName: "users",
	storage: OBJY.customStorage({
		add: function(elem){
			console.log('ä', elem)
		}
	})
})

OBJY.user({username: "sdgdg", onCreate: {test: {value: function(){console.log('ffff----')}}}}).add(data => {
	console.log(data);
})

return;

OBJY.user({username: "test"}).add(data => {
	data.setEmail('sdgdg');
	data.addApplication("one");
	OBJY.app('one')
	data.addPrivilege('admin')

	data.update()
	console.log(data)
})