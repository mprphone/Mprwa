export {};

declare global {
  interface Window {
    waDesktop?: {
      isDesktop?: boolean;
      platform?: string;
      electronVersion?: string;
      setUnreadCount?: (count: number) => void;
      setUnreadOverlay?: (count: number, dataUrl: string) => void;
      notifyInboundMessage?: (payload: { from: string; body: string; conversationId?: string }) => void;
      readClipboardText?: () => Promise<string>;
      financasAtProfile?: (payload: {
        username: string;
        password: string;
        loginUrl?: string;
        targetUrl?: string;
        profileUrl?: string;
        profileUrls?: string[];
        timeoutMs?: number;
        closeAfterCollect?: boolean;
        credentialLabel?: string;
        activateFinancasNifTab?: boolean;
        browserExecutablePath?: string;
      }) => Promise<{
        success?: boolean;
        message?: string;
        error?: string;
        sourceUrl?: string;
        fields?: {
          morada?: string;
          inicioAtividade?: string;
          tipoIva?: string;
          caePrincipal?: string;
          codigoReparticaoFinancas?: string;
        };
      }>;
      financasAutologin?: (payload: {
        username: string;
        password: string;
        loginUrl?: string;
        targetUrl?: string;
        timeoutMs?: number;
        closeAfterSubmit?: boolean;
        credentialLabel?: string;
        postLoginFlow?: string;
        apiBaseUrl?: string;
        customerName?: string;
        customerCompany?: string;
        subEmail?: string;
        subUsername?: string;
        subPassword?: string;
        tokenDescription?: string;
        usernameSelectors?: string | string[];
        passwordSelectors?: string | string[];
        submitSelectors?: string | string[];
        successSelectors?: string | string[];
        activateFinancasNifTab?: boolean;
        browserExecutablePath?: string;
      }) => Promise<{
        success?: boolean;
        message?: string;
        error?: string;
        loginState?: string;
        manualRequiredReason?: string;
        postLoginFlow?: {
          stage?: string;
          createdUsername?: string;
          activationCode?: string;
          token?: string;
          tokenValidUntil?: string;
          appAuth?: string;
          appAuthValidUntil?: string;
          reason?: string;
        };
      }>;
    };
  }
}
