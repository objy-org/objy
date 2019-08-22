var Persistence = require('../storage/inMemory.js');
var Processor = require('../processors/eval.js');
var Observer = require('../observers/intervalMapper.js');


InMemoryObject = function(SPOO, name, pluralName, storageOpts, processorOpts, observerOpts) {

	SPOO.ObjectFamily({
		name: name || 'Object',
		pluralName: pluralName || 'Objects',
		persistence: new Persistence(),
		processor: new Processor(SPOO),
		observer: new Observer()
	})

	return SPOO[name || 'Object'];
}

module.exports = InMemoryObject;