import _OBJY from './objy.js';

var OBJY = new _OBJY();

OBJY.Logger.enabled = ['none'];

var s1 = [];
var s2 = [{ secondo: 'piano' }];

var cache = OBJY.customStorage({
    createClient: function (client, success, error) {},

    getDBByMultitenancy: function (client) {},

    listClients: function (success, error) {},

    getById: function (id, success, error, app, client) {
        success(s2[0], 'return');
    },

    getByCriteria: function (criteria, success, error, app, client, flags) {
        success(s2);
    },

    count: function (criteria, success, error, app, client, flags) {},

    update: function (spooElement, success, error, app, client) {},

    add: function (spooElement, success, error, app, client) {
        console.log('getting from chain', spooElement);

        s2.push(spooElement);

        success(spooElement);

        console.log(s1, s2);
    },

    remove: function (spooElement, success, error, app, client) {},
});

var db = OBJY.customStorage({
    getById: function (id, success, error, app, client, chain) {
        s1[0].getbyid = 1;

        success(s1[0]);
    },

    getByCriteria: function (criteria, success, error, app, client, flags) {
        success(s1);
    },

    count: function (criteria, success, error, app, client, flags) {},

    update: function (spooElement, success, error, app, client) {},

    add: function (spooElement, success, error, chain, app, client) {
        spooElement.hello = 'sagasgd';
        spooElement.getbyid = 1;

        s1.push(spooElement);

        success(spooElement);
    },

    remove: function (spooElement, success, error, app, client) {},
});

OBJY.define({
    name: 'object',
    pluralName: 'objects',
    storage: [cache, db],
});

console.log(OBJY.mappers);

OBJY.object({ name: 'grace' }).add((data) => {
    console.log('ID', data._id);

    OBJY.objects({}).get((_d) => {
        console.log('GOT:', _d);
    });
});
