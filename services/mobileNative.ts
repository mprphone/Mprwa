import { Capacitor } from '@capacitor/core';
import { PushNotifications, PushNotificationSchema, Token, ActionPerformed } from '@capacitor/push-notifications';
import { LocalNotifications } from '@capacitor/local-notifications';
import { Device } from '@capacitor/device';
import { App as CapApp } from '@capacitor/app';

const REGISTER_ENDPOINT = '/api/mobile/push/register';
const CHANNEL_ID = 'wa_messages';
const STORAGE_TOKEN_KEY = 'wa_pro_mobile_push_token';

let mobileBootstrapPromise: Promise<void> | null = null;
let isForeground = true;

function isNativePlatform() {
  return Capacitor.isNativePlatform();
}

function currentUserId(): string {
  if (typeof window === 'undefined') return '';
  return String(window.localStorage.getItem('wa_pro_session_user_id') || '').trim();
}

function buildHashRoute(data: Record<string, unknown>): string {
  const route = String(data.route || '/inbox').trim() || '/inbox';
  const conversationId = String(data.conversationId || '').trim();
  if (!conversationId) return route.startsWith('/') ? route : `/${route}`;
  const normalizedRoute = route.startsWith('/') ? route : `/${route}`;
  const params = new URLSearchParams({ conversationId });
  return `${normalizedRoute}?${params.toString()}`;
}

function openRouteFromNotification(data: Record<string, unknown>) {
  if (typeof window === 'undefined') return;
  const route = buildHashRoute(data);
  const hash = `#${route}`;
  if (window.location.hash !== hash) {
    window.location.hash = hash;
  }
}

async function registerDeviceToken(token: string) {
  const cleanToken = String(token || '').trim();
  if (!cleanToken) return;

  const [deviceInfo, deviceId, appInfo] = await Promise.all([
    Device.getInfo().catch(() => null),
    Device.getId().catch(() => null),
    CapApp.getInfo().catch(() => null),
  ]);

  await fetch(REGISTER_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      token: cleanToken,
      platform: Capacitor.getPlatform(),
      deviceId: String(deviceId?.identifier || '').trim() || null,
      deviceModel: String(deviceInfo?.model || '').trim() || null,
      osVersion: String(deviceInfo?.osVersion || '').trim() || null,
      appVersion: String(appInfo?.version || '').trim() || null,
      userId: currentUserId() || null,
      metadata: {
        manufacturer: String(deviceInfo?.manufacturer || '').trim() || null,
        operatingSystem: String(deviceInfo?.operatingSystem || '').trim() || null,
      },
    }),
  }).catch(() => undefined);
}

async function ensureNotificationChannel() {
  if (Capacitor.getPlatform() !== 'android') return;
  await PushNotifications.createChannel({
    id: CHANNEL_ID,
    name: 'Mensagens WA PRO',
    description: 'Notificações de novas mensagens.',
    importance: 5,
    visibility: 1,
    sound: 'default',
  }).catch(() => undefined);
}

function attachPushListeners() {
  PushNotifications.addListener('registration', (token: Token) => {
    const value = String(token?.value || '').trim();
    if (!value) return;
    try {
      window.localStorage.setItem(STORAGE_TOKEN_KEY, value);
    } catch (_) {
      // ignore
    }
    void registerDeviceToken(value);
  });

  PushNotifications.addListener('registrationError', (error) => {
    console.warn('[Mobile] erro registo push:', error);
  });

  PushNotifications.addListener('pushNotificationReceived', async (notification: PushNotificationSchema) => {
    if (!isForeground) return;
    await LocalNotifications.schedule({
      notifications: [
        {
          title: notification.title || 'WA PRO',
          body: notification.body || 'Nova mensagem recebida.',
          id: Date.now() % 2147483647,
          channelId: CHANNEL_ID,
          sound: 'default',
          extra: notification.data || {},
        },
      ],
    }).catch(() => undefined);
  });

  PushNotifications.addListener('pushNotificationActionPerformed', (action: ActionPerformed) => {
    const data = (action?.notification?.data || {}) as Record<string, unknown>;
    openRouteFromNotification(data);
  });
}

async function bootstrapNativeMobileNotifications() {
  if (!isNativePlatform()) return;
  await ensureNotificationChannel();

  CapApp.addListener('appStateChange', ({ isActive }) => {
    isForeground = !!isActive;
  });

  const permissions = await PushNotifications.requestPermissions();
  if (permissions.receive !== 'granted') {
    console.warn('[Mobile] permissao de notificacoes negada.');
    return;
  }
  await LocalNotifications.requestPermissions().catch(() => undefined);

  attachPushListeners();
  await PushNotifications.register();

  const existingToken = String(window.localStorage.getItem(STORAGE_TOKEN_KEY) || '').trim();
  if (existingToken) {
    void registerDeviceToken(existingToken);
  }
}

export function initNativeMobileLayer(): Promise<void> {
  if (!mobileBootstrapPromise) {
    mobileBootstrapPromise = bootstrapNativeMobileNotifications().catch((error) => {
      console.warn('[Mobile] falha na inicializacao nativa:', error);
    });
  }
  return mobileBootstrapPromise;
}
