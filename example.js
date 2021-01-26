var OBJY = require('./objy.js');

OBJY.define({
    //authable:true,
    name: "user",
    pluralName: "users",
    propsObject: 'properties'
    /*storage: OBJY.customStorage({
    	add: function(elem){
    		console.log('ä', elem)
    	}
    })*/
})



OBJY.user({ username: "sdgdg", properties: {
	innerProp: {
		type: 'shortText',
		value: 'hello'
	}
}, onCreate: {
	test: {
		value: "console.log(',,,,,,,')"
	}
}, evt: {
	type: "event",
	date: "100000",
	action: "console.log(1)"
} }).add(data => {
    //console.log(data);

    data.addProperty('sdgdhdfh__', { type: "shortText", value: "sgsdg", onCreate: {
	test: {
		action: "console.log(',,,####,,,,')"
	}
}});
    data.addProperty('sdgdhdfh__bag', {

            inner: {
                type: "boolean",
                value: true
            }
        
    });
    data.setPropertyValue('sdgdhdfh__', 'new');
    data.setPropertyValue('sdgdhdfh__bag.inner', false);
    data.setProperty('ddd', 'dddd')

    data.update(d => {
    	console.log('uuu', d)
    })
    console.log('__data', data);
})




return;

OBJY.user({ username: "test" }).add(data => {
    data.setEmail('sdgdg');
    data.addApplication("one");
    OBJY.app('one')
    data.addPrivilege('admin')

    data.update()
    console.log(data)
})