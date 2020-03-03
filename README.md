# OBJY

An object-driven, cross-platform programming framework, written in JavaScript, that uses behaviour-driven objects for modelling use cases.

![OBJY LOGO](objy-icon-full.png "OBJY")

## Installing

### For Node

```shell
npm install objy
```

## Programming with OBJY?

The philisophy behind OBJY ist to define objects and tell them what to do. In order to do so, all you need is CRUD.

#### Simple object

```javascript

//Build an object

OBJY.Object({ name: "Passport", expires: { date: "2020-10-05", action: "delete this;" }})
```

#### Object with behaviour

```javascript

//Build an object

OBJY.Object({
   ...
   expires: {
      date: "2020-10-05",
      action: "email('expiring soon!')"
   },
   onChange: "if(this.number.length == 0) return;"
})
```

#### Add

```javascript
// add one
OBJY.Object({}).add(callback);

// add multiple
OBJY.Objects([{}],[{}]).add(callback);
```

#### Get one
```javascript
OBJY.Object(id).get(callback);
```

#### Query

```javascript
OBJY.Objects({type:'example', 'properties.expired' : false}).get(callback);
```

#### Update

```javascript
// update one
OBJY.Object(id)
   .setPropertyValue('expired', false)
   .addProperty('open', false).
   .save(callback)

// replace one
OBJY.Object(id).replace(newObject).save(callback);
```

#### Delete

```javascript
// delete one
OBJY.Object(id).delete(callback);
```

## Customize

Objects can be very different in their nature. Some objects are big, some are small, some are produced very vast, some not so fast. When you define an object family, you can tell OBJY where objects in this family are stored, how they are processed and observed.

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

## Authors

* **Marco Boelling** - *Creator of OBJY* - [Twitter](https://twitter.com/marcoboelling)

## License

This project is licensed under the MIT License - see the [LICENSE.md](LICENSE.md) file for details

## Connect

* [objy.io](https://objy.io) - OBJY's official website
* [Twitter](https://www.twitter.com/objy7) - OBJY's Twitter

