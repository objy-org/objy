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

let OBJY = {
    Logger: Logger,
    StorageTemplate: StorageTemplate,
    ProcessorTemplate: ProcessorTemplate,
    ObserverTemplate: ObserverTemplate,
};

OBJY = Object.assign(OBJY, {
    ...generalFunctions(OBJY),

    ...applyFunctions(OBJY),

    ...permissionFunctions(OBJY),

    ...objectFunctions(OBJY),

    ...mapperFunctions(OBJY),

    ...wrapperFunctions(OBJY),

    ...propertyFunctions(OBJY),

    ...pluralConstructorFunctions(OBJY),

    ...singularConstructorFunctions(OBJY),

    hello: function () {
        OBJY.Logger.log('Hello from OBJY!');
    },
});

export default OBJY;
