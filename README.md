# OBJY

An object-driven, cross-platform programming framework, written in JavaScript, that uses behaviour-driven objects for modelling use cases.

![OBJY LOGO](assets/objy-icon-full.png "OBJY")

## Installing

OBJY can be used in Node and the Browser.

### Node

```shell
npm install objy
```

### Browser

```html
<script src="https://raw.githubusercontent.com/objy-org/objy/dev/dist/browser.js">
```



## Programming with OBJY

Programming on OBJY is done in two simple steps:

1. Define an Object Family (a bucket of objects) an choose how objects in this family are stored, processed and observed.
2. Build and handle objects and tell them what to do.


### Object Family

```javascript

//Define Object Family

OBJY.define({
	name: "object", // singular constructor name
	pluralName: "objects" // plural constructor name
})

// OBJY now has the contructors:

OBJY.object() // as a wrapper for single objects
OBJY.objects() // as wrapper for multiple objects
```

### Simple object

```javascript

//Build an object

OBJY.object({
   name: "Passport",
   properties: {
      expires: "2020-10-10",
      number: "123"
   }
})
```

### Object with behaviour

```javascript

//Build an object

OBJY.object({
   ...
   warnMe: {
      date: "2020-10-05",
      action: "email('expiring soon!')"
   },
   onChange: "if(this.number.length == 0) return;"
})
```

### Add

```javascript
// add one
OBJY.object({}).add(callback);

// add multiple
OBJY.objects([{}],[{}]).add(callback);
```

### Get one
```javascript
OBJY.object(id).get(callback);
```

### Query

```javascript
OBJY.objects({type:'example', 'properties.expired' : false}).get(callback);
```

### Update

```javascript
// update one
OBJY.object(id)
   .setPropertyValue('expired', false)
   .addProperty('open', false).
   .save(callback)

// replace one
OBJY.Object(id).replace(newObject).save(callback);
```

### Delete

```javascript
// delete one
OBJY.object(id).delete(callback);
```


## Customize

Objects can be very different in their nature. Some objects are big, some are small, some are produced very vast, some not so fast. When you define an object family, you can tell OBJY where objects in this family are stored, how they are processed and observed, along with other options.

```javascript
OBJY.define({
	// manatory
	name: "object",
	pluralName: "objects"
	
	// mappers 
	storage: {}, // defaults to "in memory"
	processor: {}, // defaults to "eval"
	observer: {} // defaults to "interval",
	
	// + other optional options
})
```
> Default mappers are already initialized! If you'd like to work in memory, just ignore the mappers section

### Mapper types

| Type        | Explanation           | 
| ------------- |-------------| 
| `storage`      | Storage mappers can be plugged in to define where and how objects in an object family are persistent. | 
| `processor`      | Processor Mappers define, how object actions are executed. | 
| `observer`      | Observer Mappers define, how object events are observed and time-based actions triggered. | 

### Optional options

| Option        | Explanation           | 
| ------------- |-------------| 
| `authable`      | Defines wether objects in a family can have privileges for access control | 
| `templateFamily`      | Defines from which object family is the source for inheritence. Defaults to the own object family. |
| `staticProps`      | Defines static properties that are preset for all objects in the object family. |
| `staticFuncs`      | Defines static functions that are preset for all objects in the object family. |
| `hasAffects`      | Defines wether the object family serves as bucket for defining affectables |


## Authors

* **Marco Boelling** - *Initial author* - [Twitter](https://twitter.com/marcoboelling)

## License

This project is licensed under the MIT License - see the [LICENSE.md](LICENSE.md) file for details

## Connect

* [objy.io](https://objy.io) - OBJY's official website
* [Twitter](https://www.twitter.com/objy7) - OBJY's Twitter
