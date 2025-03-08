let OBJY = null;
let listOfGeneralFunc = ['test1', 'test2', 'test3'];
let listOfFamilyFunc = ['setPropertyValue', 'update'];

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

OBJY = build();

let updatable = OBJY.object({ _id: '123' });

OBJY.test1(1, 2, 3).test2(4, 5, 6);

updatable.setPropertyValue('properties.prop1', 42);

OBJY.test3(3);

updatable.update();

export default OBJY;
