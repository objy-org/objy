const { VM, VMScript } = require('vm2');

Mapper = function(OBJY) {
    return Object.assign(new OBJY.ProcessorTemplate(OBJY), {

        execute: function(dsl, obj, prop, data, callback, client, app, user, options) {

            var sandBox = new VM({ sandbox: { OBJY: this.OBJY, dsl: this, this: this } });
            if (this.multitenancy == this.CONSTANTS.MULTITENANCY.ISOLATED) {
                sandBox.run(new VMScript(dsl));
            } else {
                sandBox.run(new VMScript(dsl));
            }
        }
    })
}


module.exports = Mapper;