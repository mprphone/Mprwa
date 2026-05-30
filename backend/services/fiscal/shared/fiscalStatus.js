'use strict';

const FISCAL_STATUS = Object.freeze({
    COMPLETED: 'completed',
    PENDING: 'pending',
    NEEDS_REVIEW: 'needs_review',
    LOGIN_FAILED: 'login_failed',
    PERMISSION_DENIED: 'permission_denied',
    NOT_AVAILABLE: 'not_available',
    FAILED: 'failed',
});

module.exports = { FISCAL_STATUS };
