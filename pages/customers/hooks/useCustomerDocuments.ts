import { useCallback, useReducer, useRef } from 'react';
import { mockService } from '../../../services/mockData';

export type CustomerDocumentEntry = {
  type: 'file' | 'directory';
  name: string;
  relativePath: string;
  size?: number;
  updatedAt: string;
};

type CustomerDocumentsState = {
  entries: CustomerDocumentEntry[];
  folderPath: string;
  currentPath: string;
  canGoUp: boolean;
  configured: boolean;
  loading: boolean;
  uploading: boolean;
  error: string | null;
};

type CustomerDocumentsAction =
  | { type: 'reset'; initialPath: string }
  | { type: 'load_start'; targetPath: string }
  | {
      type: 'load_success';
      entries: CustomerDocumentEntry[];
      folderPath: string;
      currentPath: string;
      canGoUp: boolean;
      configured: boolean;
    }
  | { type: 'load_error'; targetPath: string; error: string }
  | { type: 'upload_start' }
  | { type: 'upload_success' }
  | { type: 'upload_error'; error: string };

type UseCustomerDocumentsOptions = {
  initialPath?: string;
  basePath?: string;
  loadErrorMessage?: string;
  uploadErrorMessage?: string;
};

function buildInitialState(initialPath = ''): CustomerDocumentsState {
  return {
    entries: [],
    folderPath: '',
    currentPath: initialPath,
    canGoUp: false,
    configured: false,
    loading: false,
    uploading: false,
    error: null,
  };
}

function documentsReducer(
  state: CustomerDocumentsState,
  action: CustomerDocumentsAction
): CustomerDocumentsState {
  switch (action.type) {
    case 'reset':
      return buildInitialState(action.initialPath);
    case 'load_start':
      return {
        ...state,
        currentPath: action.targetPath,
        loading: true,
        error: null,
      };
    case 'load_success':
      return {
        ...state,
        entries: action.entries,
        folderPath: action.folderPath,
        currentPath: action.currentPath,
        canGoUp: action.canGoUp,
        configured: action.configured,
        loading: false,
        error: null,
      };
    case 'load_error':
      return {
        ...state,
        entries: [],
        folderPath: '',
        currentPath: action.targetPath,
        canGoUp: false,
        configured: false,
        loading: false,
        error: action.error,
      };
    case 'upload_start':
      return {
        ...state,
        uploading: true,
        error: null,
      };
    case 'upload_success':
      return {
        ...state,
        uploading: false,
      };
    case 'upload_error':
      return {
        ...state,
        uploading: false,
        error: action.error,
      };
    default:
      return state;
  }
}

function clampPath(path: string, basePath: string): string {
  const normalizedPath = String(path || basePath || '').trim();
  const normalizedBase = String(basePath || '').trim();
  if (!normalizedBase) return normalizedPath;
  if (normalizedPath === normalizedBase || normalizedPath.startsWith(`${normalizedBase}/`)) {
    return normalizedPath;
  }
  return normalizedBase;
}

export function useCustomerDocuments(options: UseCustomerDocumentsOptions = {}) {
  const initialPath = String(options.initialPath || options.basePath || '').trim();
  const basePath = String(options.basePath || '').trim();
  const loadErrorMessage = options.loadErrorMessage || 'Falha ao carregar documentos.';
  const uploadErrorMessage = options.uploadErrorMessage || 'Falha ao guardar documento.';

  const [state, dispatch] = useReducer(documentsReducer, initialPath, buildInitialState);
  const requestRef = useRef(0);
  const uploadRequestRef = useRef(0);

  const reset = useCallback(() => {
    requestRef.current += 1;
    uploadRequestRef.current += 1;
    dispatch({ type: 'reset', initialPath });
  }, [initialPath]);

  const load = useCallback(
    async (customerId: string, relativePath = initialPath) => {
      const normalizedCustomerId = String(customerId || '').trim();
      if (!normalizedCustomerId) return;

      const targetPath = clampPath(relativePath, basePath);
      const requestId = requestRef.current + 1;
      requestRef.current = requestId;
      dispatch({ type: 'load_start', targetPath });

      try {
        const payload = await mockService.getCustomerDocumentsAtPath(normalizedCustomerId, targetPath);
        if (requestRef.current !== requestId) return;
        dispatch({
          type: 'load_success',
          entries: Array.isArray(payload.entries) ? payload.entries : [],
          folderPath: String(payload.folderPath || ''),
          currentPath: String(payload.currentRelativePath || targetPath),
          canGoUp: Boolean(payload.canGoUp),
          configured: Boolean(payload.configured),
        });
      } catch (error) {
        if (requestRef.current !== requestId) return;
        dispatch({
          type: 'load_error',
          targetPath,
          error: error instanceof Error ? error.message : loadErrorMessage,
        });
      }
    },
    [basePath, initialPath, loadErrorMessage]
  );

  const goUp = useCallback(
    async (customerId: string) => {
      const current = clampPath(state.currentPath, basePath);
      if (basePath && (!current || current === basePath)) {
        await load(customerId, basePath);
        return;
      }

      const parts = current.split('/').filter(Boolean);
      parts.pop();
      const nextPath = clampPath(parts.join('/'), basePath);
      await load(customerId, nextPath);
    },
    [basePath, load, state.currentPath]
  );

  const upload = useCallback(
    async (customerId: string, file: File, relativePath = state.currentPath) => {
      const normalizedCustomerId = String(customerId || '').trim();
      if (!normalizedCustomerId || !file) return;

      const targetPath = clampPath(relativePath, basePath);
      const requestId = uploadRequestRef.current + 1;
      uploadRequestRef.current = requestId;
      dispatch({ type: 'upload_start' });

      try {
        await mockService.uploadCustomerDocument(normalizedCustomerId, file, targetPath);
        if (uploadRequestRef.current !== requestId) return;
        await load(normalizedCustomerId, targetPath);
        if (uploadRequestRef.current !== requestId) return;
        dispatch({ type: 'upload_success' });
      } catch (error) {
        if (uploadRequestRef.current !== requestId) return;
        dispatch({
          type: 'upload_error',
          error: error instanceof Error ? error.message : uploadErrorMessage,
        });
      }
    },
    [basePath, load, state.currentPath, uploadErrorMessage]
  );

  return {
    state,
    reset,
    load,
    goUp,
    upload,
  };
}
