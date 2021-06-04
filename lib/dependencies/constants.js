var CONSTANTS = {

    EVENT: {
        TYPE_RECURRING: 'recurring',
        TYPE_TERMINATING: 'terminating',
        ACTION: {
            TYPE_AUTORENEW: 'autorenew',
            TYPE_CONFIRM: 'confirm',
            TYPE_PROTOCOL: 'protocol'
        }
    },
    PROPERTY: {
        TYPE_SHORTTEXT: 'shortText',
        TYPE_LONGTEXT: 'longText',
        TYPE_INDEXEDTEXT: 'indexedText',
        TYPE_NUMBER: 'number',
        TYPE_DATE: 'date',
        TYPE_SHORTID: 'shortId',
        TYPE_REF_OBJ: 'objectRef',
        TYPE_REF_USR: 'userRef',
        TYPE_REF_FILE: 'fileRef',
        TYPE_PROPERTY_BAG: 'bag',
        TYPE_BOOLEAN: 'boolean',
        TYPE_ARRAY: 'array',
        TYPE_EVENT: 'event',
        TYPE_ACTION: 'action',
        TYPE_JSON: 'json'
    },
    MULTITENANCY: {
        ISOLATED: "isolated",
        SHARED: "shared"
    },
    TYPES: {
        SCHEDULED: 'scheduled',
        QUERIED: 'queried'
    },
    TEMPLATEMODES: {
        STRICT: 'strict'
    }
}

module.exports = CONSTANTS;