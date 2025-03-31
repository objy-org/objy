export default {
	ObjectAuthorisationSetWrapper: (obj, authorisationObj, ctx) => {

        var app = ctx.activeApp || '*';

        if (!obj.authorisations) obj.authorisations = {};
        if (!obj.authorisations[app]) obj.authorisations[app] = [];
        if (!authorisationObj.name) authorisationObj.name = OBJY.RANDOM();

        var found = false;
        obj.authorisations[app].forEach(au => {
            if (au.name == authorisationObj.name) {
                au = authorisationObj;
                found = true;
            }
        })

        if (!found) obj.authorisations[app].push(authorisationObj)

        return authorisationObj;
    },
    ObjectAuthorisationRemoveWrapper: (obj, authorisationId, ctx) => {

        var app = ctx.activeApp || '*';

        if (!obj.authorisations) throw new exceptions.General('No authorisations present')

        if (!obj.authorisations[app]) throw new exceptions.General('No authorisations for this app present')

        obj.authorisations[app].forEach((au, i) => {
            if (au.name == authorisationId) obj.authorisations[app].splice(i, 1)
        })

        if (Object.keys(obj.authorisations[app]).length == 0) delete obj.authorisations[app];

        return authorisationId;
    },
    PrivilegeChecker: (obj, privilege) => {

        if (!typeof privilege == 'object') throw new exceptions.InvalidPrivilegeException();
        var privilegeKey = Object.keys(privilege)[0];

        if (!obj.privileges) obj.privileges = {};

        if (!obj.privileges[privilegeKey]) {
            obj.privileges[privilegeKey] = [];
        }

        var contains = false;

        obj.privileges[privilegeKey].forEach(function(oP) {
            if (oP.name == privilege[privilegeKey].name) contains = true;
        })

        if (!contains) obj.privileges[privilegeKey].push({ name: privilege[privilegeKey].name });
        else throw new exceptions.General('Privilege already exists')

        return privilege;
    },
    PrivilegeRemover: (obj, privilege, ctx) => {

            var appId = ctx.activeApp; //Object.keys(privilege)[0];

            if (!obj.privileges[appId]) {
                throw new exceptions.NoSuchPrivilegeException();
            }

            var i;
            for (i = 0; i < obj.privileges[appId].length; i++) {
                if (obj.privileges[appId][i].name == privilege) obj.privileges[appId].splice(i, 1);
            }

            if (obj.privileges[appId].length == 0) {
                delete obj.privileges[appId];
            }

            return privilege;
        }
}