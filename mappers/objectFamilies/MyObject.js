MyObject = function(OBJY, name, pluralName, storageOpts, processorOpts, observerOpts) {

    OBJY.define({
        name: name || 'Object',
        pluralName: pluralName || 'Objects',
        persistence: {
            add: function() {

            },
            update: function() {

            },
            getByCId: function() {

            },
            getByCriteria: function() {

            },
            removeObject: function() {

            }
        },
        processor: {
            execute: function() {

            }
        },
        observer: {
            initialize: function() {

            },
            run: function() {

            }
        }
    })


    return OBJY[name || 'Object'];
}

module.exports = MyObject;