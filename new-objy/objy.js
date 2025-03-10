import _general from './general.js';
import _family from './family.js';

let OBJY = null;
let listOfGeneralFunc = ['test1', 'test2', 'test3'];
//let listOfGeneralFunc = Object.keys(_general);
let listOfFamilyFunc = ['setPropertyValue', 'update'];
//let listOfFamilyFunc = Object.keys(_family);
let attributes = [
    'Logger',
    'predefinedProperties',
    'metaPropPrefix',
    'activeTenant',
    'activeUser',
    'activeApp',
    'objectFamilies',
    'affectables',
    'staticRules',
    'mappers',
    'caches',
    'ignorePermissions',
    'ignoreAuthorisations',
    'handlerSequence',
    'permissionSequence',
    'alterSequence',
    'commandSequence',
    'eventAlterationSequence',
    'storage',
    'processor',
    'observer',
    'StorageTemplate',
    'ProcessorTemplate',
    'ObserverTemplate',
    'processors',
    'observers',
];

function familyBuild(params, _family, _instance) {
    let family = {
        singular: null,
        plural: null,
        instance: {
            calls: [],
        },
    };

    family.instance = Object.assign(family.instance, _instance);

    family.singular = _family.singular;
    family.plural = _family.plural;

    family.instance.calls.push({ funcName: _family.singular, params });

    listOfFamilyFunc.forEach((funcName) => {
        family[funcName] = (...params) => {
            family.instance.calls.push({ funcName, params });

            console.log(family.instance.calls);

            // OBJY method calls here,,,

            /*
                let promise = new Promise(async (resolve, reject) => {
                    try {
                        res = await _family[funcName](params)

                        resolve(res)
                    } catch(err){
                        console.log(err)
                        return reject()
                    }
                })
            */

            // Either return family or return promise for methods like OBJY.object(obj).update()

            return family;
        };
    });

    return family;
}

function build() {
    let build = {
        instance: {
            families: [{ singular: 'object', plural: 'objects' }],
        },
    };

    listOfGeneralFunc.forEach((funcName) => {
        build[funcName] = (...params) => {
            // OBJY method calls here,,,

            /*
                let promise = new Promise(async (resolve, reject) => {
                    try {
                        res = await _general[funcName](params)

                        resolve(res)
                    } catch(err){
                        console.log(err)
                        return reject()
                    }
                })
            */

            return build;
        };
    });

    build.instance.families.forEach((family) => {
        build[family.singular] = (...params) => {
            return familyBuild(params, family, build.instance);
        };

        build[family.plural] = (...params) => {
            return familyBuild(params, family, build.instance);
        };
    });

    return build;
}

function test() {
    OBJY = build();

    let updatable = OBJY.object({ _id: '123' });

    OBJY.test1(1, 2, 3).test2(4, 5, 6);

    updatable.setPropertyValue('properties.prop1', 42);

    OBJY.test3(3);

    updatable.update();
}

test();

export default build;
