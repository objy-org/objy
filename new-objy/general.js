
export default {
	define: (params) => {

        if (typeof params == 'string') params = { name: params, pluralName: params + 's' };

        if (!params.name || !params.pluralName) {
            throw new Error("Invalid arguments");
        }

        this[params.name] = function(obj) {
            //return OBJY.SingleProxy(obj, params.name, this, params);
            return new OBJY.Obj(obj, params.name, this, params);
        }

        if (this.objectFamilies.indexOf(params.name) == -1) this.objectFamilies.push(params.name);

        this[params.pluralName] = function(objs, flags) {
            return new OBJY.Objs(objs, params.name, this, params, flags);
        }

        if (params.storage) this.plugInPersistenceMapper(params.name, params.storage);
        else if(params.storage === undefined) this.plugInPersistenceMapper(params.name, thisRef.storage || new DefaultStorageMapper(thisRef));

        if (params.processor) this.plugInProcessor(params.name, params.processor);
        else if(params.processor === undefined) this.plugInProcessor(params.name, thisRef.processor || new DefaultProcessorMapper(thisRef));

        if (params.observer) {
            this.plugInObserver(params.name, params.observer);
            if (params.observer.initialize) params.observer.initialize();
        } else if (params.observer === undefined) {
            this.plugInObserver(params.name, thisRef.observer || new DefaultObserverMapper(thisRef));
            if (this.observers[params.name].initialize) this.observers[params.name].initialize();
        }

        if (params.backend) {
            this.plugInPersistenceMapper(params.name, params.backend.storage);
            this.plugInProcessor(params.name, params.backend.processor);
            this.plugInObserver(params.name, params.backend.observer);
        }

        return this[params.name];
        },
};