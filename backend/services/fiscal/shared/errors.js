'use strict';

class FiscalError extends Error {
    constructor(message, code = 'FISCAL_ERROR') {
        super(message);
        this.name = 'FiscalError';
        this.code = code;
    }
}

class FiscalTimeoutError extends FiscalError {
    constructor(message = 'Tempo limite excedido.') {
        super(message, 'FISCAL_TIMEOUT');
        this.name = 'FiscalTimeoutError';
    }
}

class FiscalValidationError extends FiscalError {
    constructor(message = 'Documento inválido ou inesperado.') {
        super(message, 'FISCAL_VALIDATION');
        this.name = 'FiscalValidationError';
    }
}

module.exports = { FiscalError, FiscalTimeoutError, FiscalValidationError };
