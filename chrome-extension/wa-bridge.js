'use strict';

window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  const data = event.data || {};
  if (data.source !== 'WA_PRO' || data.type !== 'AUTLOGIN_REQUEST') return;

  chrome.runtime.sendMessage({
    type: 'WA_PRO_AUTLOGIN_REQUEST',
    payload: data.payload || {},
  }, (response) => {
    window.postMessage({
      source: 'WA_PRO_CHROME_EXTENSION',
      type: 'AUTLOGIN_RESPONSE',
      requestId: data.requestId,
      response: response || { success: false, error: chrome.runtime.lastError?.message || 'Sem resposta da extensão.' },
    }, window.location.origin);
  });
});


function sanitizeCustomerForPopup(customer) {
  if (!customer || typeof customer !== 'object') return null;
  return {
    id: String(customer.id || '').trim(),
    name: String(customer.name || '').trim(),
    company: String(customer.company || '').trim(),
    nif: String(customer.nif || '').trim(),
    niss: String(customer.niss || '').trim(),
    email: String(customer.email || '').trim(),
    phone: String(customer.phone || '').trim(),
    senhaFinancas: String(customer.senhaFinancas || '').trim(),
    senhaSegurancaSocial: String(customer.senhaSegurancaSocial || '').trim(),
    certidaoPermanenteNumero: String(customer.certidaoPermanenteNumero || '').trim(),
    certidaoPermanenteValidade: String(customer.certidaoPermanenteValidade || '').trim(),
    caePrincipal: String(customer.caePrincipal || '').trim(),
    caeDescricao: String(customer.caeDescricao || '').trim(),
    accessCredentials: Array.isArray(customer.accessCredentials)
      ? customer.accessCredentials.map((credential) => ({
        service: String(credential?.service || '').trim(),
        credentialType: String(credential?.credentialType || '').trim(),
        username: String(credential?.username || '').trim(),
        password: String(credential?.password || '').trim(),
        emailAssociado: String(credential?.emailAssociado || '').trim(),
        status: String(credential?.status || '').trim(),
        validUntil: String(credential?.validUntil || '').trim(),
      }))
      : [],
  };
}

async function readCustomersFromWaPro() {
  const response = await fetch('/api/import/supabase', {
    method: 'GET',
    headers: { Accept: 'application/json' },
    cache: 'no-store',
  }).catch(() => null);
  if (response?.ok) {
    const payload = await response.json().catch(() => ({}));
    const customers = Array.isArray(payload.customers) ? payload.customers : [];
    return customers.map(sanitizeCustomerForPopup).filter((item) => item?.id);
  }

  const localRaw = window.localStorage.getItem('wa_pro_local_customers_v1');
  const localCustomers = localRaw ? JSON.parse(localRaw) : [];
  return Array.isArray(localCustomers)
    ? localCustomers.map(sanitizeCustomerForPopup).filter((item) => item?.id)
    : [];
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'WA_PRO_COLLECT_CUSTOMERS') return false;
  readCustomersFromWaPro()
    .then((customers) => sendResponse({ success: true, customers }))
    .catch((error) => sendResponse({ success: false, error: String(error?.message || error) }));
  return true;
});
