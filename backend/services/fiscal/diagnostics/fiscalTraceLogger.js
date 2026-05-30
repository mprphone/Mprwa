'use strict';

function createTraceLogger(portal, job, customer) {
    const prefix = `[Fiscal:${portal}/${job}]${customer?.nif ? ` NIF=${customer.nif}` : ''}`;
    return function trace(...args) {
        console.error(prefix, ...args);
    };
}

module.exports = { createTraceLogger };
