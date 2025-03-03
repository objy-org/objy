export default function (OBJY) {
    return {
        // @TODO make this better!
        predefinedProperties: [
            '_aggregatedEvents',
            'authorisations',
            '_id',
            'role',
            'applications',
            'inherits',
            'onCreate',
            'onChange',
            'onDelete',
            'permissions',
            'privileges',
            'created',
            'lastModified',
        ],

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

        processors: {},
        observers: {},
    };
}
