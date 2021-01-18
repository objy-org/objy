const exceptions = {
    NoOnChangeException: function(message) {
        this.message = "onChange not found";
        this.name = 'NoOnChangeException';
    },

    NoMetaException: function(message) {
        this.message = "meta not found";
        this.name = 'NoMetaException';
    },

    NoOnDeleteException: function(message) {
        this.message = "onDelete not found";
        this.name = 'NoOnDeleteException';
    },

    NoEventIdException: function(message) {
        this.message = "No Event ID provided";
        this.name = 'NoEventIdException';
    },

    InvalidTypeException: function(message) {
        this.message = message + " is not a valid type";
        this.name = 'InvalidTypeException';
    },

    InvalidValueException: function(value, type) {
        this.message = value + " is not valid. Type must be: " + type;
        this.name = 'InvalidValueException';
    },

    InvalidFormatException: function() {
        this.message = "Invlid format";
        this.name = 'InvalidFormatException';
    },

    DuplicatePropertyException: function(message) {
        this.message = "Property " + message + " already exists in this object";
        this.name = 'DuplicatePropertyException';
    },

    DuplicateActionException: function(message) {
        this.message = "Action " + message + " already exists in this object";
        this.name = 'DuplicateActionException';
    },

    DuplicateApplicationException: function(message) {
        this.message = "Application " + message + " already exists in this object";
        this.name = 'DuplicateApplicationException';
    },

    NoSuchApplicationException: function(message) {
        this.message = "Application " + message + " does not exist in this object";
        this.name = 'NoSuchApplicationException';
    },

    NoSuchReminderException: function(message) {
        this.message = "Reminder " + message + " does not exist in this event";
        this.name = 'NoSuchReminderException';
    },

    DuplicateEventException: function(message) {
        this.message = "Event " + message + " already exists in this object";
        this.name = 'DuplicateEventException';
    },

    NoSuchTemplateException: function(message) {
        this.message = "Template id " + message + " does not exist";
        this.name = 'NoSuchTemplateException';
    },

    NotAnEventException: function(message) {
        this.message = "Property " + message + " is not an event";
        this.name = 'NotAnEventException';
    },

    NoSuchObjectException: function(message) {
        this.message = "Object id " + message + " does not exist";
        this.name = 'NoSuchObjectException';
    },

    NoSuchPropertyException: function(message) {
        this.message = "Property " + message + " does not exist in this object";
        this.name = 'NoSuchPropertyException';
    },

    NoSuchEventException: function(message) {
        this.message = "Event " + message + " does not exist in this object";
        this.name = 'NoSuchEventException';
    },

    PropertyNotFoundException: function(message) {
        this.message = "Property " + message + " does not exist in this object";
        this.name = 'PropertyNotFoundException';
    },

    MissingAttributeException: function(message) {
        this.message = "Missing attibute " + message + " in this object";
        this.name = 'MissingAttributeException';
    },

    CallbackErrorException: function(message) {
        this.message = message;
        this.name = 'CallbackErrorException';
    },

    InvalidDateException: function(message) {
        this.message = message + " is not a valid date";
        this.name = 'InvalidDateException';
    },

    InvalidActionException: function(message) {
        this.message = message + " is not a valid event action";
        this.name = 'InvalidActionException';
    },

    InvalidDataTypeException: function(message, type) {
        this.message = message + " is not of type " + type;
        this.name = 'InvalidDataTypeException';
    },

    NotATemplateExteptopn: function(message) {
        this.message = message + " is not a template";
        this.name = 'NotATemplateExteptopn';
    },

    InvalidPrivilegeException: function(message) {
        this.message = "Invalid privileges format";
        this.name = 'InvalidPrivilegeException';
    },

    NoSuchPrivilegeException: function(message) {
        this.message = "Privilege does not exist";
        this.name = 'NoSuchPrivilegeException';
    },

    NoSuchPermissionException: function(message) {
        this.message = "Permission " + message + " does not exist";
        this.name = 'NoSuchPermissionException';
    },

    InvalidPermissionException: function(message) {
        this.message = "Permission format invalid";
        this.name = 'InvalidPermissionException';
    },

    InvalidEventIdException: function(message) {
        this.message = "Event ID format not valid: " + message;
        this.name = 'InvalidEventIdException';
    },


    NoHandlerProvidedException: function(message) {
        this.message = "No handler provided " + message;
        this.name = 'NoHandlerProvidedException';
    },

    HandlerExistsException: function(message) {
        this.message = "Handler " + message + " already exists";
        this.name = 'HandlerExistsException';
    },

    HandlerNotFoundException: function(message) {
        this.message = "Handler " + message + " not found";
        this.name = 'HandlerNotFoundException';
    },

    InvalidArgumentException: function(message) {
        this.message = "Invalid argument";
        this.name = 'InvalidArgumentException';
    },

    InvalidHandlerException: function(message) {
        this.message = "Invalid handler";
        this.name = 'InvalidHandlerException';
    },

    LackOfPermissionsException: function(message) {

        if (Array.isArray(message)) {
            var result = "No permissions to perform these operations: ";

            message.forEach(function(m) {
                result += "(" + m.name + ": " + m.key + ") ";
            })

            this.message = result;
            this.name = 'LackOfPermissionsException';
        } else {
            this.message = "No permissions to perform this operation";
            this.name = 'LackOfPermissionsException';
        }

    }
}

module.exports = exceptions;