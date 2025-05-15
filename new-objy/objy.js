//import _general from './general.js';
import _family from './family.js';
//import _helpers from './helpers.js';

let contextTemplate = {
    activeTenant: null,
    activeUser: null,
    activeApp: null,

    alterSequence: [],
    commandSequence: [],
    permissionSequence: {},

    chainPermission: (obj, code, name, key) => {

        if (['c', 'r', 'u', 'd', 'x'].includes(code)) {

        } else code = 'u';

        if (obj.permissions) {
            if (Object.keys(obj.permissions).length > 0) {
                if (!this.permissionSequence[obj._id]) this.permissionSequence[obj._id] = [];

                if (!OBJY.checkPermissions(this.activeUser, this.activeApp, obj, code, true, this))
                    this.permissionSequence[obj._id].push({
                        name: name,
                        key: key
                    });
            }
        }
    },

    chainCommand: (obj, key, value) => {
        this.commandSequence.push({
            name: key,
            value: value
        });
    },
}

let OBJY = {

    families: {

    },

    globalCtx: Object.assign({}, contextTemplate),

    useUser: (user) => {
        OBJY.globalCtx.activeUser = user
    },

    define: (params) => {
        
        if (typeof params == 'string') params = { name: params, pluralName: params + 's' };
        
        if (!params.name || !params.pluralName) {
            throw new Error("Invalid arguments");
        }

        OBJY[params.name] = (obj) => {

            // copy current context globally
            let ctx = Object.assign({}, OBJY.globalCtx);

            // return new singular object with it's own context
            return _family(obj, params, ctx)
        }
    }
}; 



//////////// TESTING SECTION ///////////

OBJY.define({
    name: "object",
    pluralName: "objects"
})

OBJY.define({
    name: "user",
    pluralName: "users",
    authable: true
})


OBJY.useUser('benjamin') 

let o1 = OBJY.object({name: "one", ac: {
    type: "action",
    value: "console.log(4711)"
},
    prp: {
    type: "shortText",
    value: "hello fresh"
}})
let usr1 = OBJY.user({username: "peter"})


console.log('got:', o1.getProperty('prp'))

o1.getProperty('ac').call()

usr1.setUsername('peter1')

o1.addApplication('asklfsdjlhfjsdhf').removeApplication('asklfsdjlhfjsdhf')

o1.setOnChange('myfirstOnChange', {value: "console.log('i have been changed')"})

OBJY.useUser('admin')

let o2 = OBJY.object({name: "two"})

console.log(o1, o2)

o1.setName('mirco1').setType('test123')

//o1.name = "mirco"

console.log('with new name', o1)