// This is for building a singular object and validating it's format
import moment from 'moment';
import helpers from './helpers.js';

export default (obj, params, ctx) => {

	// object skelleton
	let skelleton = {
		__ctx: ctx,
		_id: obj._id,
        _clients: [],
		name: obj.name,
		created: obj.created || moment().utc().toDate().toISOString(),
		lastModified: obj.lastModified || moment().utc().toDate().toISOString()
	}



	// Checking dynamic properties
    helpers.PropertiesChecker(skelleton, obj, ctx, params);



	////// CHECKING MANDATORY FIELDS /////

	if (typeof obj === 'string') {
        skelleton._id = obj;
    }

    if (typeof obj === 'object') {
        skelleton.role = obj.role;
    }

    if (obj._aggregatedEvents)
    	skelleton._aggregatedEvents = obj._aggregatedEvents

    if (obj.authorisations)
    	skelleton.authorisations = obj.authorisations

    if (!obj.role)
    	skelleton.role = 'object'




    ////// INHERITS + APPLICATIONS /////


    skelleton.applications = obj.applications || []
    skelleton.inherits = obj.inherits || []


    if (params.hasAffects) {
        skelleton.affects = obj.affecty || {}
        skelleton.apply = obj.apply || {}
    }




    ////// HANDLERS /////

    if(obj.onCreate){
    	Object.keys(obj.onCreate).forEach(function(oC) {
            if (!obj.onCreate[oC].trigger) obj.onCreate[oC].trigger = 'after';
            if (!obj.onCreate[oC].type) obj.onCreate[oC].type = 'async';
        })

        skelleton.onCreate = obj.onCreate
    }

    if(obj.onChange){
    	Object.keys(obj.onChange).forEach(function(oC) {
            if (!obj.onChange[oC].trigger) obj.onChange[oC].trigger = 'after';
            if (!obj.onChange[oC].type) obj.onChange[oC].type = 'async';
        })

        skelleton.onChange = obj.onChange
    }

    if(obj.onDelete){
    	Object.keys(obj.onDelete).forEach(function(oC) {
            if (!obj.onDelete[oC].trigger) obj.onDelete[oC].trigger = 'after';
            if (!obj.onDelete[oC].type) obj.onDelete[oC].type = 'async';
        })

        skelleton.onDelete = obj.onDelete
    }





    /////// PERMISSIONS ///////

  	if (obj.permissions){
  		var permissionKeys = Object.keys(obj.permissions);
	   	permissionKeys.forEach(function(permission) {
	   	    
	   	    if (typeof obj.permissions[permission] == 'string') {
	   	        obj.permissions[permission] = {
	   	            value: obj.permissions[permission]
	   	        };
	   	    } else {
	   	        obj.permissions[permission] = obj.permissions[permission];
	   	    }
	   	})

	   	skelleton.permissions = obj.permissions
  	}
   	


  	////// OBJECT FUNCTIONS /////

    skelleton.setName = (name) => {
    	skelleton.name = name
        ctx.chainPermission(skelleton, 'n', 'setName', name);
        ctx.alterSequence.push({ setName: name });
        return skelleton
    }

    skelleton.setType = (type) => {
        skelleton.type = type;
        ctx.chainPermission(skelleton, 't', 'setType', type);
        ctx.alterSequence.push({ setType: type });
        return skelleton;
    }

    skelleton.getProperty = (propertyName) => {
        return helpers.PropertyParser(skelleton, propertyName, ctx, params);
    }

    skelleton.addInherit = (ineritId) => {
        if (!skelleton.inherits.includes(inheritId)){
            skelleton.inherits.push(inheritId);
            ctx.chainPermission(skelleton, 'i', 'addInherit', inheritId);
            ctx.chainCommand(skelleton, 'addInherit', inheritId);
            ctx.alterSequence.push({ addInherit: ineritId });
        }

        return skelleton;
    }

    skelleton.removeInherit = (ineritId, success, error) => {
        helpers.removeTemplateFromObject(
            skelleton,
            ineritId,
            function (data) {
                if (success) success(ineritId);
            },
            function (err) {
                if (error) error(err);
            },
            ctx
        );

        ctx.alterSequence.push({ removeInherit: ineritId });

        return skelleton;
    }

    skelleton.addApplication = (application) => {
        console.log('.', skelleton)
        if(!skelleton.applications.includes(application)){
            skelleton.applications.push(application);
            ctx.chainPermission(skelleton, 'a', 'addApplication', application);
            ctx.alterSequence.push({ addApplication: application });
        } else throw Error("Application " + application + " already exists in this object")

        return skelleton;
    }

    skelleton.removeApplication = (application) => {
       
        if(!skelleton.applications.includes(application))
            throw Error("Application " + application + " does not exist in this object")
        
        skelleton.applications.splice(skelleton.applications.indexOf(application), 1);
        ctx.chainPermission(skelleton, 'a', 'removeApplication', application);
        ctx.alterSequence.push({ removeApplication: application });

        return skelleton;
    }

    skelleton.addPropertyToBag = (bag, property) => {
        var tmpBag = skelleton.getProperty(bag);

        helpers.PropertyCreateWrapper(tmpBag, property, true, ctx, params, true);

        return skelleton;
    };

    skelleton.addProperty = (name, property) => {
        var prop = {};
        prop[name] = property;
        property = prop;

        var propertyKey = name;
        Object.keys(property)[0];
        if (propertyKey.indexOf('.') != -1) {
            var lastDot = propertyKey.lastIndexOf('.');
            var bag = propertyKey.substring(0, lastDot);
            var newProKey = propertyKey.substring(lastDot + 1, propertyKey.length);
            var newProp = {};
            newProp[newProKey] = property[propertyKey];
            helpers.addPropertyToBag(bag, newProp);
            ctx.alterSequence.push({ addProperty: [name, property] });

            return skelleton;
        }

        helpers.PropertyCreateWrapper(skelleton, property, false, ctx, params, true);
        ctx.alterSequence.push({ addProperty: [name, property] });

        return skelleton;
    }

    skelleton.setHandler = (name, handler, handlerType) => {
        if (typeof handler !== 'object') throw Error("invalid "+ handlerType);
        var key = name;

        if (!skelleton[handlerType]) skelleton[handlerType] = {};

        if (skelleton[handlerType][name]) throw Error(name + ' already exists in this object');

        if (!name) name = helpers.RANDOM();

        if (!skelleton[handlerType][name]) skelleton[handlerType][name] = {}

        skelleton[handlerType][name].value = handler.value;
        skelleton[handlerType][name].trigger = handler.trigger || 'after';
        skelleton[handlerType][name].type = handler.type || 'async';

        if (skelleton[handlerType][name].templateId) skelleton[handlerType][name].overwritten = true;

        ctx.chainPermission(skelleton, 'w', 'set'+handlerType, name);
        var alterO = {}
        alterO['set'+handlerType] = [name, handler]
        ctx.alterSequence.push(alterO);

        return skelleton;
    }

    skelleton.setOnCreate = (name, onCreateObj) => {
        return skelleton.setHandler(name, onCreateObj, 'onCreate')
    }

    skelleton.setOnChange = (name, onChangeObj) => {
        return skelleton.setHandler(name, onChangeObj, 'onChange')
    }

    skelleton.setOnDelete = (name, onDeleteObj) => {
        return skelleton.setHandler(name, onDeleteObj, 'onDelete')
    }

    skelleton.removeHandler = (name, handlerType) => {
        if (!skelleton[handlerType][name]) throw Error(handlerType + ' with name ' + name + ' does not exist in this object')
        else delete skelleton[handlerType][name];

        var alterO = {}
        alterO['remove'+handlerType] = arguments
        ctx.alterSequence.push(alterO);

        return skelleton;
    };

    skelleton.removeOnCreate = (name) => {
        return skelleton.removeHandler(name, 'onCreate')
    };

    skelleton.removeOnChange = (name) => {
        return skelleton.removeHandler(name, 'onChange')
    };

    skelleton.removeOnDelete = (name) => {
        return skelleton.removeHandler(name, 'onDelete')
    };





  	/////// AUTHABLE ////////

  	if (params.authable) {
        skelleton.username = obj.username || null;
        skelleton.email = obj.email || null;
        skelleton.password = obj.password || null;

        skelleton.spooAdmin = obj.spooAdmin;

        delete skelleton.name;

        skelleton.setUsername = (username) => {
            skelleton.username = username;
            ctx.chainPermission(skelleton, 'o', 'setUsername', username);
            ctx.alterSequence.push({ setUsername: username });
            return skelleton;
        };

        skelleton.setEmail = function (email) {
            skelleton.email = email;
            ctx.chainPermission(skelleton, 'h', 'setEmail', email);
            ctx.alterSequence.push({ setEmail: email });
            return skelleton;
        };

        skelleton.setPassword = function (password) {
            // is encrypted at this point by predecessing logic
            skelleton.password = password;
            ctx.alterSequence.push({ setPassword: password });
            return skelleton;
        };

        skelleton.setAuthorisation = function (authorisationObj) {
            helpers.ObjectAuthorisationSetWrapper(skelleton, authorisationObj, ctx);
            ctx.alterSequence.push({ setAuthorisation: authorisationObj });
            return skelleton;
        };

        skelleton.removeAuthorisation = function (authorisationId) {
            helpers.ObjectAuthorisationRemoveWrapper(skelleton, authorisationId, instance);
            ctx.alterSequence.push({ removeAuthorisation: authorisationId });
            return skelleton;
        };
    }

    // TODO: explain this!
    if (params.authable || params.authableTemplate) {
        skelleton.privileges = obj.privileges
        skelleton._clients = obj._clients;

        skelleton.addPrivilege = function (privilege) {
            if (ctx.activeApp) {
                var tmpPriv = {};
                tmpPriv[ctx.activeApp] = { name: privilege };
                helpers.PrivilegeChecker(skelleton, tmpPriv);
                ctx.alterSequence.push({ addPrivilege: privilege });
                return skelleton;
            } else throw new exceptions.General('Invalid app id');

            return skelleton;
        };

        skelleton.removePrivilege = function (privilege) {
            helpers.PrivilegeRemover(skelleton, privilege, ctx);
            ctx.alterSequence.push({ removePrivilege: privilege });
            return skelleton;
        };

        skelleton.addClient = function (client) {
            if (skelleton._clients.indexOf(client) != -1) throw new exceptions.General('Client ' + client + ' already exists');
            skelleton._clients.push(client);
            ctx.alterSequence.push({ addClient: client });
            return skelleton;
        };

        skelleton.removeClient = function (client) {
            if (skelleton._clients.indexOf(client) == -1) throw new exceptions.General('Client ' + client + ' does not exist');
            skelleton._clients.splice(skelleton._clients.indexOf(client), 1);
            ctx.alterSequence.push({ removeClient: client });
            return skelleton;
        };
    }  

	return skelleton;//Object.assign(skelleton, funcs);
}