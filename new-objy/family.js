// This is for building a singular object and validating it's format
import moment from 'moment';
import helpers from './helpers.js';

export default (obj, params, ctx) => {

	// object skelleton
	let skelleton = {
		__ctx: ctx,
		_id: obj._id,
		name: obj.name,
		created: obj.created || moment().utc().toDate().toISOString(),
		lastModified: obj.lastModified || moment().utc().toDate().toISOString()
	}



	// Checking dynamic properties
	// TODO



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

    if (obj.applications)
    	if(!Array.isArray(obj.applications))
    		skelleton.applications = undefined

    if (obj.inherits)
    	if(!Array.isArray(obj.inherits))
    		skelleton.inherits = undefined







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
        console.log('skel name', skelleton.name)
    }




  	/////// AUTHABLE ////////

  	if (params.authable) {
        skelleton.username = obj.username || null;
        skelleton.email = obj.email || null;
        skelleton.password = obj.password || null;

        skelleton.spooAdmin = obj.spooAdmin;

        delete skelleton.name;

        skelleton.setUsername = (username) => {
            skelleton.username = username;
            ctx.chainPermission(this, 'o', 'setUsername', username);
            ctx.alterSequence.push({ setUsername: arguments });
            return this;
        };

        skelleton.setEmail = function (email) {
            skelleton.email = email;
            ctx.chainPermission(this, 'h', 'setEmail', email);
            ctx.alterSequence.push({ setEmail: arguments });
            return this;
        };

        skelleton.setPassword = function (password) {
            // is encrypted at this point by predecessing logic
            skelleton.password = password;
            ctx.alterSequence.push({ setPassword: arguments });
            return this;
        };

        skelleton.setAuthorisation = function (authorisationObj) {
            helpers.ObjectAuthorisationSetWrapper(this, authorisationObj, ctx);
            ctx.alterSequence.push({ setAuthorisation: arguments });
            return this;
        };

        skelleton.removeAuthorisation = function (authorisationId) {
            helpers.ObjectAuthorisationRemoveWrapper(this, authorisationId, instance);
            ctx.alterSequence.push({ removeAuthorisation: arguments });
            return this;
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
                helpers.PrivilegeChecker(this, tmpPriv);
                ctx.alterSequence.push({ addPrivilege: arguments });
                return this;
            } else throw new exceptions.General('Invalid app id');

            return this;
        };

        skelleton.removePrivilege = function (privilege) {
            helpers.PrivilegeRemover(this, privilege, ctx);
            ctx.alterSequence.push({ removePrivilege: arguments });
            return this;
        };

        skelleton.addClient = function (client) {
            if (this._clients.indexOf(client) != -1) throw new exceptions.General('Client ' + client + ' already exists');
            this._clients.push(client);
            ctx.alterSequence.push({ addClient: arguments });
            return this;
        };

        skelleton.removeClient = function (client) {
            if (this._clients.indexOf(client) == -1) throw new exceptions.General('Client ' + client + ' does not exist');
            this._clients.splice(this._clients.indexOf(client), 1);
            ctx.alterSequence.push({ removeClient: arguments });
            return this;
        };
    }  

	return skelleton;//Object.assign(skelleton, funcs);
}