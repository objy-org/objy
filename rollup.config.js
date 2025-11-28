export default [
    {
        input: 'objy.js',
        output: [
            {
                file: 'dist/index.cjs',
                format: 'cjs',
                sourcemap: true,
            },
            {
                file: 'dist/index.js',
                format: 'esm',
                sourcemap: true,
            },
        ],
    },
];
