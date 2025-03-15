//import _general from './general.js';
import _family from './family.js';
//import _helpers from './helpers.js';

let contextTemplate = {
    activeTenant: null,
    activeUser: null,
    activeApp: null
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
            return Object.assign({}, _family(obj, params, ctx))
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


console.log(OBJY.user({username: "admin"}))

OBJY.useUser('benjamin') 

let o1 = OBJY.object({name: "one"})

OBJY.useUser('admin')

let o2 = OBJY.object({name: "two"})

console.log(o1, o2)

OBJY.useUser('marco')

console.log(o1,o2)