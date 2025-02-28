var _OBJY = require('./objy.js');

var OBJY = new _OBJY();

OBJY.Logger.enabled = ['none']


OBJY.define({
    name: 'object',
    pluralName: 'objects',
    extendedStructure: {
        name: null,
        properties: {}
    }
})

var o  =OBJY.object({name: "ksdjk", properties: {


"success": {
          "properties": {
            "_id": {
              "value": null,
              "type": "objectRef"
            },
            "fulfilled": {
              "value": true,
              "type": "boolean"
            }
          },
          "type": "bag"
        }

}})

console.log(JSON.stringify(o, false, 4))