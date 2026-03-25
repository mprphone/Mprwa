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
      financasAutologin?: (payload: {
        username: string;
        password: string;
        loginUrl?: string;
        targetUrl?: string;
        timeoutMs?: number;
        closeAfterSubmit?: boolean;
        credentialLabel?: string;
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
      }>;
    };
  }
}
