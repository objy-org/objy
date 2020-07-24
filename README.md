# OBJY

An object-driven, cross-platform programming framework, written in JavaScript, that uses behaviour-driven objects for modelling use cases.

![OBJY LOGO](assets/objy-icon-full.png "OBJY")

## Installing

OBJY can be used in any JavaScript Environment.

### Node

```shell
npm install @spootechnologies/objy
```

### Deno

```javascript
import { OBJY } from https://raw.githubusercontent.com/spoo-technologies/objy/dev/dist/browser.js;
```

### Browser

```html
<script src="https://raw.githubusercontent.com/spoo-technologies/objy/dev/dist/browser.js">
```



## Programming with OBJY?

The philisophy behind OBJY ist to define objects and tell them what to do. In order to do so, all you need is CRUD.

#### Simple object

```javascript

//Build an object

OBJY.Object({
   name: "Passport",
   properties: {
      expires: "2020-10-10",
      number: "123"
   }
})
```

#### Object with behaviour

```javascript

//Build an object

OBJY.Object({
   ...
   warnMe: {
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


## Object Families

Objects can be grouped into Object Families using the define method. Each Family will have it's own constructor. The default Object Family is "Object" and is already built in.

```javascript
// define a custom object family
OBJY.define({
   name : "User",
   pluralName: "Users"
});

// use the object familys
OBJY.User({...});
```


## Customize

Objects can be very different in their nature. Some objects are big, some are small, some are produced very vast, some not so fast. When you define an object family, you can tell OBJY where objects in this family are stored, how they are processed and observed.

### Use a mapper

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

* **Marco Boelling** - *Initial author* - [Twitter](https://twitter.com/marcoboelling)

## License

This project is licensed under the MIT License - see the [LICENSE.md](LICENSE.md) file for details

## Connect

* [objy.io](https://objy.io) - OBJY's official website
* [Twitter](https://www.twitter.com/objy7) - OBJY's Twitter

