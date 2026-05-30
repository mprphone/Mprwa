'use strict';

const { withTimeout } = require('./textHelpers');

async function retryAsync(fn, retries = 2, delayMs = 500) {
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
        try {
            return await fn(attempt);
        } catch (error) {
            lastError = error;
            if (attempt < retries && delayMs > 0) {
                await new Promise((resolve) => setTimeout(resolve, delayMs));
            }
        }
    }
    throw lastError;
}

module.exports = { withTimeout, retryAsync };
