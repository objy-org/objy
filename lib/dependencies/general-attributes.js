var StorageMapperTemplate = require('../mappers/templates/storage.js');
var ProcessorMapperTemplate = require('../mappers/templates/processor.js')
var ObserverMapperTemplate = require('../mappers/templates/observer.js')
var Logger = require('./logger.js')

var StorageTemplate = StorageMapperTemplate;
var ProcessorTemplate = ProcessorMapperTemplate;
var ObserverTemplate = ObserverMapperTemplate;

module.exports = {
    self: this,

    Logger: Logger,

    // @TODO make this better!
    predefinedProperties: ['_aggregatedEvents', 'authorisations', '_id', 'properties', 'role', 'applications', 'inherits', 'onCreate', 'onChange', 'onDelete', 'permissions', 'privileges', 'created', 'lastModified'],

    metaPropPrefix: '',

    instance: this,

    activeTenant: null,

    activeUser: null,

    activeApp: null,

    schema: {

    },

    affectables: [],

    staticRules: [],

    backgroundAffectables: this.staticRules,

    handlerSequence: [],
    permissionSequence: [],
    commandSequence: [],
    eventAlterationSequence: [],

    storage: null,
    processor: null,
    observer: null,

    StorageTemplate: StorageTemplate,
    ProcessorTemplate: ProcessorTemplate,
    ObserverTemplate: ObserverTemplate
}