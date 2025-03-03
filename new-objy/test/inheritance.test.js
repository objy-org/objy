import OBJY from '../objy.js';
import assert from 'assert';

OBJY.Logger.enabled = ['error'];

describe('Inheritance', function () {
    OBJY.define({
        name: 'Object',
        pluralName: 'Objects',
    });

    test('should inherit form object', function (done) {
        OBJY.Object({
            name: 'template',
            properties: {
                weight: {
                    type: 'number',
                    value: 23,
                },
                age: 22,
            },
        }).add((data) => {
            OBJY.Object({ inherits: [data._id] }).add((data) => {
                OBJY.Object(data).get((obj) => {
                    expect(obj.properties.weight.value).toBe(23);
                    expect(obj.properties.age).toBe(22);
                    done();
                });
            });
        });
    });
});
