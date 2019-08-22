# SPOO Mappers

A collection of adapters for using the right technologies for specific use cases and building domain specific object families. 

## Getting Started

SPOO Mappers are written in JavaScript and can be installed along with the SPOO Framework. They are used to define custom Object Families with the fitting technologies underneath.

There are three types of mappers: Persistence, Processing and Observation.


| Mapper Type | Description | Examples
--- | --- | ---
|Persistence| Used to store objects and delegate CRUD operations | Database Systems, File Systems or Caches.
Processor | Used to execute object actions, event actions and handler actions |  Anything that executes JS Code, like eval or the VM Module. Can be proxied with Messaging Systems.
Observer | Observes object events and execute their actions. | Cron-based solutions or event schedulers



## Installing


### NPM


```
npm install spoo-mappers
```


### CDN


```
https://spoo.io/code/spoo-mappers.zip
```

## Example

Let's create an Object Family that uses the following mappers:

```
// Install the mappers
var storage = require('./mappers/persistence/inMemory.js');
var observer = require('./mappers/observer/inMemory.js');
var processor = require('./mappers/processor/inMemory.js');

// Define an object family
SPOO.define({
	name : "Object",
	pluralName: "Objects",
	persistence: new storage(),
	observer: new observer(),
	processor: new processor()
})

// Use the object family's constructor
SPOO.Object({name: "Hello World"}).add(function(data)
{
	console.log(data);
})
```

## Build your own mapper - extend the ecosystem

If you need a mapper that doesn't exist yet, you can simply build it yourself. Each mapper type must follow a predefined structure, that can be found inside the mapper directories (_template.js). You can use this template as a starting point.

### Why build a new mapper?

Building mappers is the best way to participate in the SPOO Ecosystem. 

Every use case may have different requirements for the technologies used. By matching requirements and technical solutions, the best results can be archieved.

With many different mappers for different technologies, SPOO can be used to build platforms for a varaity of different use cases and domains.

### Natively integrate third party systems

Mappers can also be used to connect to third party systems and introduce external data as SPOO objects.


## Contributing

Please read [CONTRIBUTING.md](https://gist.github.com/PurpleBooth/b24679402957c63ec426) for details on our code of conduct, and the process for submitting pull requests to us.



## License

This project is licensed under the MIT License - see the [LICENSE.md](LICENSE.md) file for details
