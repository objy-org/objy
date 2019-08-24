# OBJY

A cross-platform JavaScript framework that lets you build software by modelling behaviour-driven objects, that do the work for you, not by writing complex code. 

## Table of Contents

- [Main Concepts](#Model-Objects)
- [Installing](#installing)
- [Example](#quick-example)
- [Object Families](#object-families)
	- [Example](#example)
	- [Contribute](#Contribute-your-own-mapper)
	- [Integrate](#Integrate-third-party-systems)

## Model Objects

In OBJY, building software is done by modelling dynamic objects, that have a behaviour. Tell your objects what to do and they'll do the rest.

Objects consist of

- dynamic attributes
- actions
- rule-based behaviour


## Installing

### For Node

```shell
npm install objy
```

### For the Browser


```shell
https://objy.io/code/objy.js

 - or -

https://objy.io/code/objy.min.js
```



## Quick Example


```javascript
// Include OBJY (Node.js)
const OBJY = require('objy');

// Create an object
OBJY.Object({name: "Hello World"}).add( obj => {
	console.log(data);
}, err => {
	console.error(err);
})

// Query Objects
OBJY.Object({name: "Hello Word"}).get( objs => {
	console.log(objs);
}, err => {
	console.error(err);
})
```


## Object Families

OBJY lets you define multiple object families. They are used to group objects that have a similar nature.

### Example
```javascript
// define it
OBJY.define({
	name : "MyObject",
	pluralName: "MyObjects"
});

// use it
OBJY.MyObject({name: "test"});
```


## Pluggable Technologies

Objects can be very different in their nature. Some objects are big, some are small, some are produced very vast, some not so fast.
When you define an object family, you can tell OBJY where objects in this family are stored, how they are processed and observed.

### Example
```javascript
// define it
OBJY.define({
	name : "InMemObject",
	pluralName: "InMemObjects",
	persistence: new InMemoryMapper(),
	observer: new RealTimeObserver(),
	processor: new RealTimeProcessor()
});

// use it
OBJY.InMemObject({...});
```

### Inline mappers




```javascript
OBJY.define({
	name : "Item",
	pluralName: "Items",
	persistence: {
		add: function() {

		},
		get: function() {

		},
		...
	},
	observer: {
		initialize: function() {

		},
		run: function(){

		}
	},
	processor: {
		execute: function() {

		}
	}
})
```


## Contribute your own mapper

If you need a mapper that doesn't exist yet, you can simply build it yourself. Each mapper type must follow a predefined structure, that can be found inside the mapper directories (_template.js). You can use this template as a starting point.

### Why build a new mapper?

Building mappers is the best way to participate in the OBJY Ecosystem. 

Every use case may have different requirements for the technologies used. By matching requirements and technical solutions, the best results can be archieved.

With many different mappers for different technologies, OBJY can be used to build platforms for a varaity of different use cases and domains.

## Integrate third party systems

Mappers can also be used to connect to third party systems and introduce third party data as OBJY objects in your platform.


## Contributing

Please read [CONTRIBUTING.md](https://gist.github.com/PurpleBooth/b24679402957c63ec426) for details on our code of conduct, and the process for submitting pull requests to us.


## Authors

* **Marco Boelling** - *Creator of OBJY* - [Twitter](https://twitter.com/marcoboelling)

See also the list of [contributors](https://github.com/your/project/contributors) who participated in this project.

## License

This project is licensed under the MIT License - see the [LICENSE.md](LICENSE.md) file for details

## Connect

* [objy.io](https://objy.io) - OBJY's official website
* [Twitter](https://www.twitter.com/objyio) - OBJY's Twitter
* [Medium](https://medium.com/objy-io) - Official OBJY Blog

