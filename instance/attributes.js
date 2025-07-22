import StorageMapperTemplate from '../mappers/templates/storage.js'
import ProcessorMapperTemplate from '../mappers/templates/processor.js'
import ObserverMapperTemplate from '../mappers/templates/observer.js'
import Logger from '../lib/dependencies/logger.js'


var StorageTemplate = StorageMapperTemplate;
var ProcessorTemplate = ProcessorMapperTemplate;
var ObserverTemplate = ObserverMapperTemplate;

export default function(OBJY) {
    return {

        Logger: Logger,

        // @TODO make this better!
        predefinedProperties: ['_aggregatedEvents', 'authorisations', '_id', 'role', 'applications', 'inherits', 'onCreate', 'onChange', 'onDelete', 'permissions', 'privileges', 'created', 'lastModified'],

        metaPropPrefix: '',

        activeTenant: null,

        activeUser: null,

        activeApp: null,

        objectFamilies: [],

        affectables: [],

        staticRules: [],

        mappers: {},

        caches: {},

        ignorePermissions: false,
        ignoreAuthorisations: false,

        handlerSequence: [],
        permissionSequence: [],
        alterSequence: [],
        commandSequence: [],
        eventAlterationSequence: [],

        storage: null,
        processor: null,
        observer: null,

        StorageTemplate: StorageTemplate,
        ProcessorTemplate: ProcessorTemplate,
        ObserverTemplate: ObserverTemplate,

        processors: {},
        observers: {},

    }
}