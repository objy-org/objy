import generalAttributes from './instance/attributes.js';
import generalFunctions from './instance/general.js';
import applyFunctions from './instance/apply.js';
import permissionFunctions from './instance/permission.js';
import objectFunctions from './instance/object.js';
import mapperFunctions from './instance/mapper.js';
import wrapperFunctions from './instance/wrapper.js';
import propertyFunctions from './instance/property.js';
import pluralConstructorFunctions from './instance/plural-constructor.js';
import singularConstructorFunctions from './instance/singular-constructor.js';
import StorageMapperTemplate from './mappers/templates/storage.js';
import ProcessorMapperTemplate from './mappers/templates/processor.js';
import ObserverMapperTemplate from './mappers/templates/observer.js';
import Logger from './lib/dependencies/logger.js';

const StorageTemplate = StorageMapperTemplate;
const ProcessorTemplate = ProcessorMapperTemplate;
const ObserverTemplate = ObserverMapperTemplate;

const clone = (orgOBJY) => {
    let clonedOBJY = {};
    let clonedAttributesMap = [
        'Logger',
        'predefinedProperties',
        'metaPropPrefix',
        //'instance',
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

    Object.assign(clonedOBJY, {
        ...generalFunctions(clonedOBJY),

        ...applyFunctions(clonedOBJY),

        ...permissionFunctions(clonedOBJY),

        ...objectFunctions(clonedOBJY),

        ...mapperFunctions(clonedOBJY),

        ...wrapperFunctions(clonedOBJY),

        ...propertyFunctions(clonedOBJY),

        ...pluralConstructorFunctions(clonedOBJY),

        ...singularConstructorFunctions(clonedOBJY),

        hello: function () {
            clonedOBJY.Logger.log('Hello from OBJY!');
        },

        clone: () => {
            return clone(clonedOBJY);
        },

        Logger: Logger,
        StorageTemplate: StorageTemplate,
        ProcessorTemplate: ProcessorTemplate,
        ObserverTemplate: ObserverTemplate,
    });

    clonedOBJY.instance = orgOBJY.instance;

    return clonedOBJY;
};

/**
 * OBJY Instance
 */
const OBJY = function () {
    let _OBJY = {
        Logger: Logger,
        StorageTemplate: StorageTemplate,
        ProcessorTemplate: ProcessorTemplate,
        ObserverTemplate: ObserverTemplate,
    };
    let instance = Object.assign({}, generalAttributes());

    _OBJY = Object.assign(_OBJY, {
        ...generalFunctions(_OBJY, instance),

        ...applyFunctions(_OBJY, instance),

        ...permissionFunctions(_OBJY, instance),

        ...objectFunctions(_OBJY, instance),

        ...mapperFunctions(_OBJY, instance),

        ...wrapperFunctions(_OBJY, instance),

        ...propertyFunctions(_OBJY, instance),

        ...pluralConstructorFunctions(_OBJY, instance),

        ...singularConstructorFunctions(_OBJY, instance),

        hello: function () {
            _OBJY.Logger.log('Hello from OBJY!');
        },

        clone: () => {
            return clone(_OBJY);
        },

        instance: instance,
    });

    return _OBJY;
};

export default OBJY;
