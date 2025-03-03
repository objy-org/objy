import DefaultStorageMapper from '../mappers/storage.inmemory.js';
import DefaultProcessorMapper from '../mappers/processor.eval.js';
import DefaultObserverMapper from '../mappers/observer.interval.js';

export default function (OBJY) {
    return {
        /**
         * Defines an Object Family. Creates a constructor with the single name and one with the plural name
         * @param {params} an object containing the information.
         * @returns {this.instance} an array of all object families
         */
        define: function (params) {
            if (typeof params == 'string') params = { name: params, pluralName: params + 's' };

            if (!params.name || !params.pluralName) {
                throw new Error('Invalid arguments');
            }

            this[params.name] = function (obj) {
                //return OBJY.SingleProxy(obj, params.name, this, params);
                return new OBJY.Obj(obj, params.name, JSON.parse(JSON.stringify(this.instance)), params);
            };

            if (this.instance.objectFamilies.indexOf(params.name) == -1) this.instance.objectFamilies.push(params.name);

            this[params.pluralName] = function (objs, flags) {
                return new OBJY.Objs(objs, params.name, JSON.parse(JSON.stringify(this.instance)), params, flags);
            };

            if (params.storage) this.plugInPersistenceMapper(params.name, params.storage);
            else if (params.storage === undefined) this.plugInPersistenceMapper(params.name, this.instance.storage || new DefaultStorageMapper(this));

            if (params.processor) this.plugInProcessor(params.name, params.processor);
            else if (params.processor === undefined) this.plugInProcessor(params.name, this.instance.processor || new DefaultProcessorMapper(this));

            if (params.observer) {
                this.plugInObserver(params.name, params.observer);
                if (params.observer.initialize) params.observer.initialize();
            } else if (params.observer === undefined) {
                this.plugInObserver(params.name, this.instance.observer || new DefaultObserverMapper(this));
                if (this.instance.observers[params.name].initialize) this.instance.observers[params.name].initialize();
            }

            if (params.backend) {
                this.plugInPersistenceMapper(params.name, params.backend.storage);
                this.plugInProcessor(params.name, params.backend.processor);
                this.plugInObserver(params.name, params.backend.observer);
            }

            return this.instance[params.name];
        },

        /**
         * A wrapper for define
         */
        ObjectFamily: function (params) {
            return this.define(params);
        },

        /**
         * Returns the constructor for a specified object family name (singular or plural)
         * @param {role} to object family
         * @returns {constructor} the constructor
         */
        getConstructor: function (role) {
            if (this.instance.mappers[role]) return OBJY[role];
            throw new Error('No constructor');
        },

        /**
         * Returns all defined Object Families from the current instance
         * @returns {objectfamilies} an array of all object families
         */
        getObjectFamilies: function () {
            return this.instance.objectFamilies;
        },
    };
}
