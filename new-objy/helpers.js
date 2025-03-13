export default {
	getAllMethods: (object) => {
	    return Object.getOwnPropertyNames(object).filter(function(property) {
	        return typeof object[property] == 'function';
	    });
	}
}