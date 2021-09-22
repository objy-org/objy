var OBJY = require('./objy.js');




OBJY.define({
    name: "object",
    pluralName: "objects",
    extendedStructure: {
        username: null,
        type: null
    }
})

OBJY.app("test");

OBJY.useUser({username: "benjamin", authorisations: {test: [{query: "{\"username\":\"33\"}", perm: "crud", name: "NNtMriLOU"}]}})

var o = OBJY.object({id: 124, username:"33", test: 'hello', type: 'pile'})

//o.setAuthorisation({query: "{\"$and\":[{\"name\":{\"$regex\":\"e\",\"$options\":\"i\"}}]}", perm: "crud"})

//console.log(JSON.stringify(o, null, 4))



OBJY.object(124).get(ob => {console.log('sing', ob)})

//console.log(JSON.stringify(o, null, 4))

return;
OBJY.affectables.push({
    _id: 123,
    affects: {
        role: "object"
    },
    apply: {
        onCreate: {
            processFiles: {
                trigger: 'after',
                action: 'processPlantFile(obj)'
            }
        }
    }
})

OBJY.define({
    name: "object",
    pluralName: "objects",
    extendedStructure: {
        properties: '$useForProps'
    }
})


var o = OBJY.object({
    properties: {
        advancedView: {
            type: 'bag',
            properties: {
                isActive: {
                    type: 'boolean',
                    value: true
                }
            }
        }
    }
}).add(data => {
    console.log('ddd', data)
})


return;


o.setPropertyValue('advancedView.properties.isActive', false)

o.addProperty('advancedView.properties.hello', { type: 'boolean', value: true })

o.removeProperty('advancedView.properties.hello')

console.log(JSON.stringify(o, null, 4))

return;


OBJY.staticRules = [{
    _id: 123,
    affects: {},
    apply: {
        /*_constraints: {
            "properties.contactPhone.value": (val) => {
                return /^[0-9()-]+$/.test(val)

            },
            "properties.contactMail.value": (val) => {
                return /(.+)@(.+){2,}\.(.+){2,}/.test(val)
            }
        },*/
        _constraints: [{
            key: "properties.contactPhone.value",
            validate: (val) => {
                console.log('dddd', val)
                return false
            }
        }],
    }
}]



OBJY.define({
    name: "user",
    pluralName: "users",
    extendedStructure: {
        email: null
    }
})


OBJY.user({
    properties: {
        contactPhone: {
            value: "sdgsdg@sdgg.deeee"
        }
    }
}).add(d => console.log(d), e => console.log(e))


return;



OBJY.define({
    name: "template",
    pluralName: "templates",
    extendedStructure: {
        properties: '$useForProps'
    }
})


var one = OBJY.template({
    properties: {
        test: {
            type: "shortText",
            value: "sgsdg"
        }
    }
})

console.log('one', one)

var two = OBJY.template({
    inherits: [one._id]
})

console.log('two', two)

return;

OBJY.affectables = [{
    _id: 123,
    affects: {},
    apply: {
        test: 'hh'
    }
}]

OBJY.define({
    //authable:true,
    name: "user",
    pluralName: "users",
    //propsObject: 'properties'
    storage: [
        OBJY.customStorage({
            add: function(elem, success, client, app, prev) {
                console.log('ä', elem)
            },
            get: (elem, success) => {

            }
        }),
        OBJY.customStorage({
            add: function(elem, success, client, app, prev) {
                elem.permissions = prev.permissions
            }
        })
    ]
})

OBJY.define({
    name: "object",
    pluralName: "objects",
    extendedStructure: {
        properties: '$useForProps'
    }
})

OBJY.client('fff')


var oo = OBJY.object({
    properties: {
        attributeGroups: {
            type: "bag"
        }
    }
})

oo.removeProperty('attributeGroups')
oo.update()


console.log(oo)

return;

OBJY.object({
    _id: 'general',
    permissions: {
        admin: {
            value: "crud"
        }
    },
    evt: {
        type: 'event',
        interval: 100,
        action: 'console.log("acrion...")'
    }
})


var kassenautomat = OBJY.object({
    name: "kassenautomat",
    inherits: ['general'],
    constraints: {
        inherits: (val) => {
            //if val.length == 0 alert()
        }
    }
})


console.log(kassenautomat)


return;












var myO = OBJY.user({
    _id: 123,
    username: "sdgdg",
    onCreate: {
        test: {
            action: "console.log('ddddd')"
        }
    }
});

console.log(myO);
console.log('mappers', OBJY.mappers.user, OBJY.mappers.user.database.fff)

myO.type = {};
myO.type.test = true;
delete myO.type.test;

myO.addProperty('ddd', true)

console.log(myO)

//myO.remove();

console.log(OBJY.bucket)

console.log(OBJY.user({ inherits: [123] }))


OBJY.user({
    ac: {
        type: "action",
        value: "console.log('ölölölölö')"
    }
}).getProperty('ac').call();

return;

OBJY.user({
    username: "sdgdg",
    propertiesd: {
        innerProp: {
            type: 'shortText',
            value: 'hello'
        },
        rinnerProp: {
            type: 'shortText',
            value: 'hello'
        }
    },
    onCreate: {
        test: {
            value: "console.log(',,,,,,,')"
        }
    }
}).add(data => {
    //console.log(data);


    data.addProperty('sdgdhdfh__', {
        type: "shortText",
        value: "sgsdg",
        onCreate: {
            test: {
                action: "console.log(',,,####,,,,')"
            }
        }
    });

    data.update(d => {
        console.log('uuud', d)

        OBJY.user(d._id).get(u => {
            console.log('got:', u)
        })
    })

    /*
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
    })*/
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