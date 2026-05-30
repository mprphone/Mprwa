'use strict';

// Maps fiscal job names to portal and service identifiers.
// Used by collectors to dispatch to the correct portal service.

const JOB_PORTAL_MAP = {
    ies:                'financas',
    modelo22:           'financas',
    certidao_at:        'financas',
    domicilio_fiscal:   'financas',
    certidao_ss:        'seguranca-social',
    bportugal:          'banco-portugal',
    pme:                'iapmei',
    certidao_permanente: 'certidao-permanente',
};

// Portal service types for the financas portal
const FINANCAS_JOB_SERVICE_MAP = {
    ies:              'ies',
    modelo22:         'modelo22',
    irs:              'irs',
    certidao_at:      'certidao_at',
    domicilio_fiscal: 'domicilio_fiscal',
};

function getPortalForJob(job) {
    return JOB_PORTAL_MAP[String(job || '')] || null;
}

function getFinancasServiceForJob(job) {
    return FINANCAS_JOB_SERVICE_MAP[String(job || '')] || null;
}

module.exports = { JOB_PORTAL_MAP, FINANCAS_JOB_SERVICE_MAP, getPortalForJob, getFinancasServiceForJob };
