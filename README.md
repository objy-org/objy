# OBJY

A cross-platform JavaScript framework that lets you build software by modelling behaviour-driven objects, that do the work for you, not by writing complex code. 

## Table of Contents

- [Main Concepts](#Main-concepts)
- [Installing](#installing)
- [Getting started](#Getting-started)
	- [Modelling Objects](#Modelling-Objects)
	- [Handling Objects](#Handling-Objects)
- [Adapters](#Adapters)
- [License](#license)

## Main Concepts

OBJY is meant to be simple by abstracting very much of the hard parts and making them available in an easy way through a simple and understandable interface.

### Objects

In OBJY, building software is done by modelling dynamic objects, that have a behaviour. Tell your objects what to do and they'll do the rest.

Objects consist of dynamic attributes and rule based-behaviours


### Adapters

Objects can be very different in their nature. Some objects are big, some are small, some are produced very fast, some not so fast.
This is why you can define how different types of objects are stored, processed or observed, using adapters for third party technologies.


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



## Getting started


```javascript
const OBJY = require('objy');
```

### Modelling Objects

Now comes the fun part. Build an object and tell it what to do.

The base structure of an OBJY object is built up on some always-there attributes, like name, type and some others. Next to these features, there is the dynamic properties part. this is where you define what an object should look like and what it should do.

```javascript
OBJY.MyObject({
	// static part
	name: 'test',
	type: 'test',
	
	// dynamic part
	properties: {
		expired: false,
		expire: {
			type: 'event',
			date: '20.20.2020',
			action: 'this.expired = false'
		}
	}
});
```


### Handling Objects

The philisophy behind OBJY ist to let you define and model aobjects and tell them what to do. In order to do so, all you need is CRUD:

#### Add

```javascript
// add one
OBJY.MyObject({}).add(callback);

// add multiple
OBJY.MyObjects([{}],[{}]).add(callback);
```

#### Get one
```javascript
OBJY.MyObject(id).get(callback);
```

#### Query

```javascript
OBJY.MyObjects({type:'example', 'properties.expired' : false}).get(callback);
```

#### Update

```javascript
// update one
OBJY.MyObject(id)
	.setPropertyValue('expired', false)
	.addProperty('open', false).
	.save(callback)

// replace one
OBJY.MyObject(id).replace(newObject).save(callback);
```

#### Delete

```javascript
// delete one
OBJY.MyObject(id).delete(callback);
```


## Adapters

Objects can be very different in their nature. Some objects are big, some are small, some are produced very vast, some not so fast.
When you define an object family, you can tell OBJY where objects in this family are stored, how they are processed and observed.

### Use an adapter

```javascript
// define a custom object family
OBJY.define({
	name : "InMemObject",
	pluralName: "InMemObjects",
	persistence: new InMemoryMapper(),
	observer: new RealTimeObserver(),
	processor: new RealTimeProcessor()
});

// use the object familys
OBJY.InMemObject({...});
```

### Inline adapter

You can also implement an adapter inline, while you define an object family.

```javascript
OBJY.define({
	name : "Item",
	pluralName: "Items",
	persistence: {
		add: function() { },
		get: function() { },
		...
	},
	observer: {
		initialize: function() { },
		run: function(){ }
	},
	processor: {
		execute: function() { }
	}
})
```

### Contribute an adapter

If you need n adapter that doesn't exist yet, you can simply build it yourself. Each adapter type must follow a predefined structure, that can be found inside the adapter directories. 

#### Why build a new adapter?

Building adapters is the best way to participate to the OBJY Ecosystem. 

Every use case may have different requirements for the technologies used. By matching requirements and technical solutions, the best results can be archieved.

With many different adapters for different technologies, OBJY can be used to build cool things  for a varaity of different use cases and domains.

#### Integrate third party systems

Adapters can also be used to connect to third party systems and introduce third party data as OBJY objects in your project.


## Authors

* **Marco Boelling** - *Creator of OBJY* - [Twitter](https://twitter.com/marcoboelling)

See also the list of [contributors](https://github.com/your/project/contributors) who participated in this project.

## License

This project is licensed under the MIT License - see the [LICENSE.md](LICENSE.md) file for details

## Connect

* [objy.io](https://objy.io) - OBJY's official website
* [Twitter](https://www.twitter.com/objyio) - OBJY's Twitter
* [Medium](https://medium.com/objy-io) - Official OBJY Blog

