// Estado do formulário de cliente (tipos + factories). Extraído de
// pages/Customers.tsx: é definição de dados module-level, sem estado de React.
import {
  Customer,
  CustomerManager,
  CustomerAccessCredential,
  CustomerHouseholdRelation,
  CustomerRelatedRecord,
  CustomerType,
  SubContact,
} from '../../types';
import { applyAtUsernameFallback, preserveExistingCredentialSecrets } from './customerAccessUtils';
import { normalizeHouseholdRelationTypeValue } from './customerHelpers';

export type CustomerFormState = {
  name: string;
  contactName: string;
  company: string;
  phone: string;
  email: string;
  documentsFolder: string;
  nif: string;
  niss: string;
  senhaFinancas: string;
  senhaSegurancaSocial: string;
  tipoIva: string;
  morada: string;
  codigoPostal: string;
  notes: string;
  certidaoPermanenteNumero: string;
  certidaoPermanenteValidade: string;
  rcbeNumero: string;
  rcbeData: string;
  dataConstituicao: string;
  dataNascimento: string;
  inicioAtividade: string;
  caePrincipal: string;
  caeDescricao: string;
  caeSecundarios: string; // legacy
  infoAtividades: string; // JSON: [{codigo, descricao}] para CAEs secundários
  codigoReparticaoFinancas: string;
  tipoContabilidade: string;
  estadoCliente: string;
  contabilistaCertificado: string;
  managers: CustomerManager[];
  accessCredentials: CustomerAccessCredential[];
  agregadoFamiliar: CustomerHouseholdRelation[];
  fichasRelacionadas: CustomerRelatedRecord[];
  type: CustomerType;
  ownerId: string;
  contacts: SubContact[];
  allowAutoResponses: boolean;
};

export type CustomerSortKey = 'nif' | 'name' | 'type' | 'email' | 'phone' | 'owner' | 'status' | 'subuser';
export type SortDirection = 'asc' | 'desc';

export const emptyFormState = (): CustomerFormState => ({
  name: '',
  contactName: '',
  company: '',
  phone: '',
  email: '',
  documentsFolder: '',
  nif: '',
  niss: '',
  senhaFinancas: '',
  senhaSegurancaSocial: '',
  tipoIva: '',
  morada: '',
  codigoPostal: '',
  notes: '',
  certidaoPermanenteNumero: '',
  certidaoPermanenteValidade: '',
  rcbeNumero: '',
  rcbeData: '',
  dataConstituicao: '',
  dataNascimento: '',
  inicioAtividade: '',
  caePrincipal: '',
  caeDescricao: '',
  caeSecundarios: '',
  infoAtividades: '',
  codigoReparticaoFinancas: '',
  tipoContabilidade: '',
  estadoCliente: '',
  contabilistaCertificado: '',
  managers: [],
  accessCredentials: [],
  agregadoFamiliar: [],
  fichasRelacionadas: [],
  type: CustomerType.ENTERPRISE,
  ownerId: '',
  contacts: [],
  allowAutoResponses: true,
});

export const formStateFromCustomer = (customer: Customer): CustomerFormState => ({
  name: customer.name,
  contactName: customer.contactName || '',
  company: customer.company,
  phone: customer.phone,
  email: customer.email || '',
  documentsFolder: customer.documentsFolder || '',
  nif: customer.nif || '',
  niss: customer.niss || '',
  senhaFinancas: customer.senhaFinancas || '',
  senhaSegurancaSocial: customer.senhaSegurancaSocial || '',
  tipoIva: customer.tipoIva || '',
  morada: customer.morada || '',
  codigoPostal: customer.codigoPostal || '',
  notes: customer.notes || '',
  certidaoPermanenteNumero: customer.certidaoPermanenteNumero || '',
  certidaoPermanenteValidade: customer.certidaoPermanenteValidade || '',
  rcbeNumero: customer.rcbeNumero || '',
  rcbeData: customer.rcbeData || '',
  dataConstituicao: customer.dataConstituicao || '',
  dataNascimento: customer.dataNascimento || '',
  inicioAtividade: customer.inicioAtividade || '',
  caePrincipal: customer.caePrincipal || '',
  caeDescricao: customer.caeDescricao || '',
  caeSecundarios: (customer as any).caeSecundarios || '',
  infoAtividades: (customer as any).infoAtividades || '',
  codigoReparticaoFinancas: customer.codigoReparticaoFinancas || '',
  tipoContabilidade: customer.tipoContabilidade || '',
  estadoCliente: customer.estadoCliente || '',
  contabilistaCertificado: customer.contabilistaCertificado || '',
  managers: Array.isArray(customer.managers) ? customer.managers.map((manager) => ({ ...manager })) : [],
  accessCredentials: preserveExistingCredentialSecrets(
    applyAtUsernameFallback(
      Array.isArray(customer.accessCredentials)
        ? customer.accessCredentials.map((credential) => ({ ...credential }))
        : [],
      customer.nif || ''
    ),
    [],
    customer.niss || ''
  ),
  agregadoFamiliar: Array.isArray(customer.agregadoFamiliar)
    ? customer.agregadoFamiliar.map((item) => ({
        ...item,
        relationType: normalizeHouseholdRelationTypeValue(String(item?.relationType || '')),
      }))
    : [],
  fichasRelacionadas: Array.isArray(customer.fichasRelacionadas)
    ? customer.fichasRelacionadas.map((item) => ({ ...item }))
    : [],
  type: customer.type,
  ownerId: customer.ownerId || '',
  contacts: customer.contacts ? [...customer.contacts] : [],
  allowAutoResponses: customer.allowAutoResponses !== undefined ? customer.allowAutoResponses : true,
});

export const serializeCustomerFormState = (state: CustomerFormState): string => JSON.stringify(state);
