import { bootstrap, DefaultJobQueuePlugin } from '@vendure/core';
import { populate } from '@vendure/core/cli';
import path from 'path';
import { config } from '../vendure-config';

const productsCsvFile = path.join(__dirname, '../../data/table.csv');

const populateConfig = {
    ...config,
    apiOptions: {
        ...config.apiOptions,
        port: 0, // Don't start HTTP server
    },
    plugins: (config.plugins || []).filter(
        plugin => plugin !== DefaultJobQueuePlugin,
    ),
};

populate(
    () => bootstrap(populateConfig),
    productsCsvFile,
)
    .then(app => {
        console.log('Import completed successfully!');
        return app.close();
    })
    .then(
        () => process.exit(0),
        err => {
            console.log('Import failed:', err);
            process.exit(1);
        },
    );