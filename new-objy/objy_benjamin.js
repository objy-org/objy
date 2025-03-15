import _general from './general.js';
import _family from './family.js';
import _helpers from './helpers.js';

let OBJY = null;
let listOfGeneralFunc = _helpers.getAllMethods(_general)
let listOfFamilyFunc = _helpers.getAllMethods(_family);

let attributes = [
    'predefinedProperties',
    'activeTenant',
    'activeUser',
    'activeApp',
    'objectFamilies',
    'affectables',
    'staticRules',
    'storages',
    'ignorePermissions',
    'ignoreAuthorisations',
    'handlerSequence',
    'permissionSequence',
    'alterSequence',
    'commandSequence',
    'eventAlterationSequence',
    'StorageTemplate',
    'ProcessorTemplate',
    'ObserverTemplate',
    'processors',
    'observers',
];

function familyBuild(obj, _family, context) {
    let family = { 
        singular: null,
        plural: null,
        context: {
            calls: [],
        },
    };

    let content = {
        _id: null,
        name: null,
        type: null,
        role: _family.singular
    }

    console.log('content', obj)

    family.context = Object.assign(family.context, context);

    family.singular = _family.singular;
    family.plural = _family.plural;

    //family.instance.calls.push({ funcName: _family.singular, params });

    listOfFamilyFunc.forEach((funcName) => {
        family[funcName] = (...params) => {
            family.context.calls.push({ funcName, params });

            console.log(family.context.calls);

            let promise = new Promise(async (resolve, reject) => {
                try {
                    console.log(_family)
                    res = await _family[funcName](params);

                    resolve(res);
                } catch (err) {
                    console.log(err);
                    return reject();
                }
            });

            // Either return family or return promise for methods like OBJY.object(obj).update()

            return family;
        };
    });

    return family;
}

function build() {
    let build = {
        context: {
            families: [{ singular: 'object', plural: 'objects' }],
        },
    };

    listOfGeneralFunc.forEach((funcName) => {
        build[funcName] = (...params) => {
            let promise = new Promise(async (resolve, reject) => {
                try {
                    res = await _general[funcName](params);

                    resolve(res);
                } catch (err) {
                    console.log(err);
                    return reject();
                }
            });

            return build;
        };
    });

    build.context.families.forEach((family) => {
        build[family.singular] = (obj) => {
            return familyBuild(obj, family, build.context);
        };

        build[family.plural] = (obj) => {
            return familyBuild(obj, family, build.context);
        };
    });

    return build;
}

function test() {
    OBJY = build();

    let updatable = OBJY.object({ _id: '123' });


    updatable.setPropertyValue('properties.prop1', 42);


    updatable.update();
}

test();

export default build;
