import OBJY from '../objy.js';
import assert from 'assert';

OBJY.Logger.enabled = ['error'];

describe('Affectable', function () {
    OBJY.define({
        name: 'Object',
        pluralName: 'Objects',
    });

    OBJY.affectables = [
        {
            _id: 123,
            affects: {},
            apply: {
                properties: {
                    hello: 'world',
                    hi: {
                        type: 'shortText',
                        value: 'there',
                    },
                },
                permissions: {
                    admin: {
                        value: '*',
                    },
                },
            },
        },
    ];

    test('should merge structure', function (done) {
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
            expect(data.permissions.admin.value).toBe('*');
            expect(data.properties.hello).toBe('world');
            expect(data.properties.hi.value).toBe('there');
            done();
        });
    });
});
