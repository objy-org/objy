var StorageMapperTemplate = require('../mappers/templates/storage.js');
var ProcessorMapperTemplate = require('../mappers/templates/processor.js')
var ObserverMapperTemplate = require('../mappers/templates/observer.js')
var Logger = require('../lib/dependencies/logger.js')

var StorageTemplate = StorageMapperTemplate;
var ProcessorTemplate = ProcessorMapperTemplate;
var ObserverTemplate = ObserverMapperTemplate;

module.exports = function(OBJY) {
    return {

        Logger: Logger,

        // @TODO make this better!
        predefinedProperties: ['_aggregatedEvents', 'authorisations', '_id', 'properties', 'role', 'applications', 'inherits', 'onCreate', 'onChange', 'onDelete', 'permissions', 'privileges', 'created', 'lastModified'],

        metaPropPrefix: '',

        instance: this,

        activeTenant: null,

        activeUser: null,

        activeApp: null,

        objectFamilies: [],

        affectables: [],

        staticRules: [],

        mappers: {},

        caches: {},

        backgroundAffectables: this.staticRules,

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