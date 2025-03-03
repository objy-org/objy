export default [
    {
        input: 'objy.js',
        output: [
            {
                file: 'dist/index.cjs',
                format: 'cjs',
                sourcemap: true,
                inlineDynamicImports: true,
            },
            {
                file: 'dist/index.js',
                format: 'esm',
                sourcemap: true,
                inlineDynamicImports: true,
            },
        ],
    },
    /*
    {
        input: 'browser.js',
        output: [
            {
                file: 'dist/browser/index.cjs',
                format: 'cjs',
                sourcemap: true,
            },
            {
                file: 'dist/browser/index.js',
                format: 'esm',
                sourcemap: true,
            },
        ],
    },
    */
];
