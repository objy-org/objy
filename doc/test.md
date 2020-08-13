<a name="OBJY"></a>

## OBJY
Main OBJY Instance

**Kind**: global variable  

* [OBJY](#OBJY)
    * [.lang()](#OBJY.lang) ⇒ <code>this</code>
    * [.serialize()](#OBJY.serialize) ⇒ <code>this</code>
    * [.deserialize()](#OBJY.deserialize) ⇒ <code>this</code>
    * [.tenant()](#OBJY.tenant) ⇒ <code>this</code>
    * [.client()](#OBJY.client) ⇒ <code>this</code>
    * [.useUser()](#OBJY.useUser) ⇒ <code>this</code>
    * [.app()](#OBJY.app) ⇒ <code>this</code>
    * [.applyAffects()](#OBJY.applyAffects)
    * [.checkPermissions()](#OBJY.checkPermissions) ⇒
    * [.checkAuthroisations()](#OBJY.checkAuthroisations) ⇒
    * [.buildPermissionQuery()](#OBJY.buildPermissionQuery) ⇒ <code>query</code>
    * [.buildAuthroisationQuery()](#OBJY.buildAuthroisationQuery) ⇒ <code>query</code>
    * [.chainPermission()](#OBJY.chainPermission)
    * [.chainCommand()](#OBJY.chainCommand)

<a name="OBJY.lang"></a>

### OBJY.lang() ⇒ <code>this</code>
Runs luke code (comming soon)

**Kind**: static method of [<code>OBJY</code>](#OBJY)  

| Type | Description |
| --- | --- |
| <code>code</code> | luke code |

<a name="OBJY.serialize"></a>

### OBJY.serialize() ⇒ <code>this</code>
Serialises ann object into the objy structure (comming soon)

**Kind**: static method of [<code>OBJY</code>](#OBJY)  

| Type | Description |
| --- | --- |
| <code>obj</code> | object |

<a name="OBJY.deserialize"></a>

### OBJY.deserialize() ⇒ <code>this</code>
Deserialises ann object from the objy structure (comming soon)

**Kind**: static method of [<code>OBJY</code>](#OBJY)  

| Type | Description |
| --- | --- |
| <code>obj</code> | object |

<a name="OBJY.tenant"></a>

### OBJY.tenant() ⇒ <code>this</code>
Sets client (workspace) context (deprecated)

**Kind**: static method of [<code>OBJY</code>](#OBJY)  

| Type | Description |
| --- | --- |
| <code>tenant</code> | the tenant identifier |

<a name="OBJY.client"></a>

### OBJY.client() ⇒ <code>this</code>
Sets client (workspace) context

**Kind**: static method of [<code>OBJY</code>](#OBJY)  

| Type | Description |
| --- | --- |
| <code>client</code> | the tenant identifier |

<a name="OBJY.useUser"></a>

### OBJY.useUser() ⇒ <code>this</code>
Sets user context

**Kind**: static method of [<code>OBJY</code>](#OBJY)  

| Type | Description |
| --- | --- |
| <code>user</code> | the user object |

<a name="OBJY.app"></a>

### OBJY.app() ⇒ <code>this</code>
Sets app context

**Kind**: static method of [<code>OBJY</code>](#OBJY)  

| Type | Description |
| --- | --- |
| <code>app</code> | the app identifier |

<a name="OBJY.applyAffects"></a>

### OBJY.applyAffects()
Applies affect rules

**Kind**: static method of [<code>OBJY</code>](#OBJY)  

| Type | Description |
| --- | --- |
| <code>obj</code> | the object |

<a name="OBJY.checkPermissions"></a>

### OBJY.checkPermissions() ⇒
Check the permissions for an object or object part

**Kind**: static method of [<code>OBJY</code>](#OBJY)  
**Returns**: true or false  

| Type | Description |
| --- | --- |
| <code>user</code> | the user object |
| <code>app</code> | the current application |
| <code>obj</code> | the object (or property) in question |
| <code>permission</code> | the permission code to check for |
| <code>soft</code> | ... |

<a name="OBJY.checkAuthroisations"></a>

### OBJY.checkAuthroisations() ⇒
Check the authorisations for an object

**Kind**: static method of [<code>OBJY</code>](#OBJY)  
**Returns**: true or false  

| Type | Description |
| --- | --- |
| <code>obj</code> | the object in question |
| <code>user</code> | the user object |
| <code>condition</code> | the condition to check for |
| <code>app</code> | the current application |

<a name="OBJY.buildPermissionQuery"></a>

### OBJY.buildPermissionQuery() ⇒ <code>query</code>
Add permissions to a query

**Kind**: static method of [<code>OBJY</code>](#OBJY)  
**Returns**: <code>query</code> - - the final query with permissions  

| Type | Description |
| --- | --- |
| <code>query</code> | the initial query |
| <code>user</code> | the user object |
| <code>app</code> | the current application |

<a name="OBJY.buildAuthroisationQuery"></a>

### OBJY.buildAuthroisationQuery() ⇒ <code>query</code>
Add authorisations to a query

**Kind**: static method of [<code>OBJY</code>](#OBJY)  
**Returns**: <code>query</code> - - the final query with permissions  

| Type | Description |
| --- | --- |
| <code>obj</code> | the object |
| <code>user</code> | the user object |
| <code>condition</code> | the condition |
| <code>app</code> | the current application |

<a name="OBJY.chainPermission"></a>

### OBJY.chainPermission()
Chains permission information, when performing multiple operations

**Kind**: static method of [<code>OBJY</code>](#OBJY)  

| Type | Description |
| --- | --- |
| <code>obj</code> | the object |
| <code>instance</code> | the OBJY instance |
| <code>code</code> | the permission code |
| <code>name</code> | the permission name |
| <code>key</code> | the permission key |

<a name="OBJY.chainCommand"></a>

### OBJY.chainCommand()
Chains command information, when performing multiple operations

**Kind**: static method of [<code>OBJY</code>](#OBJY)  

| Type | Description |
| --- | --- |
| <code>obj</code> | the object |
| <code>instance</code> | the OBJY instance |
| <code>key</code> | the command name |
| <code>value</code> | the command value (parameter) |

