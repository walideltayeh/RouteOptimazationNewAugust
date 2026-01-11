import type { FingerprintSignals } from '@shared/schema';

const DEVICE_ID_KEY = 'fp_device_id';
const SESSION_ID_KEY = 'fp_session_id';
const COOKIE_ID_KEY = 'fp_cookie_id';

function generateUUID(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

async function sha256(message: string): Promise<string> {
  const msgBuffer = new TextEncoder().encode(message);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(16).padStart(8, '0');
}

function collectBrowserSignals(): Pick<FingerprintSignals, 'userAgent' | 'platform' | 'language' | 'languages' | 'timezone' | 'timezoneOffset'> {
  return {
    userAgent: navigator.userAgent || '',
    platform: navigator.platform || '',
    language: navigator.language || '',
    languages: (navigator.languages || []).join(','),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || '',
    timezoneOffset: new Date().getTimezoneOffset(),
  };
}

function collectScreenSignals(): Pick<FingerprintSignals, 'screenWidth' | 'screenHeight' | 'screenColorDepth' | 'devicePixelRatio'> {
  return {
    screenWidth: screen.width || 0,
    screenHeight: screen.height || 0,
    screenColorDepth: screen.colorDepth || 0,
    devicePixelRatio: window.devicePixelRatio || 1,
  };
}

function collectHardwareSignals(): Pick<FingerprintSignals, 'hardwareConcurrency' | 'deviceMemory' | 'maxTouchPoints'> {
  return {
    hardwareConcurrency: navigator.hardwareConcurrency || 0,
    deviceMemory: (navigator as any).deviceMemory ?? null,
    maxTouchPoints: navigator.maxTouchPoints || 0,
  };
}

function getCanvasFingerprint(): string {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 200;
    canvas.height = 50;
    const ctx = canvas.getContext('2d');
    if (!ctx) return 'no-canvas';

    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#f60';
    ctx.fillRect(125, 1, 62, 20);
    
    ctx.fillStyle = '#069';
    ctx.font = '14px Arial';
    ctx.fillText('Fingerprint', 2, 15);
    
    ctx.fillStyle = 'rgba(102, 204, 0, 0.7)';
    ctx.font = '18px Times New Roman';
    ctx.fillText('Test123', 4, 45);
    
    ctx.strokeStyle = 'rgb(120, 186, 176)';
    ctx.arc(50, 50, 50, 0, Math.PI * 2, true);
    ctx.stroke();

    const dataUrl = canvas.toDataURL();
    return simpleHash(dataUrl);
  } catch {
    return 'canvas-error';
  }
}

function getWebGLFingerprint(): { vendor: string; renderer: string; hash: string } {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
    if (!gl) return { vendor: 'no-webgl', renderer: 'no-webgl', hash: 'no-webgl' };

    const glContext = gl as WebGLRenderingContext;
    const debugInfo = glContext.getExtension('WEBGL_debug_renderer_info');
    
    let vendor = 'unknown';
    let renderer = 'unknown';
    
    if (debugInfo) {
      vendor = glContext.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL) || 'unknown';
      renderer = glContext.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) || 'unknown';
    }

    const params = [
      glContext.getParameter(glContext.VERSION),
      glContext.getParameter(glContext.SHADING_LANGUAGE_VERSION),
      glContext.getParameter(glContext.MAX_TEXTURE_SIZE),
      glContext.getParameter(glContext.MAX_VERTEX_ATTRIBS),
      glContext.getParameter(glContext.MAX_VERTEX_UNIFORM_VECTORS),
      glContext.getParameter(glContext.MAX_VARYING_VECTORS),
      glContext.getParameter(glContext.MAX_COMBINED_TEXTURE_IMAGE_UNITS),
      glContext.getParameter(glContext.MAX_VERTEX_TEXTURE_IMAGE_UNITS),
      glContext.getParameter(glContext.MAX_TEXTURE_IMAGE_UNITS),
      glContext.getParameter(glContext.MAX_FRAGMENT_UNIFORM_VECTORS),
      glContext.getParameter(glContext.MAX_RENDERBUFFER_SIZE),
      vendor,
      renderer,
    ].join('|');

    return {
      vendor,
      renderer,
      hash: simpleHash(params),
    };
  } catch {
    return { vendor: 'webgl-error', renderer: 'webgl-error', hash: 'webgl-error' };
  }
}

async function getAudioFingerprint(): Promise<string> {
  try {
    const AudioContext = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioContext) return 'no-audio-context';

    const context = new AudioContext();
    const oscillator = context.createOscillator();
    const analyser = context.createAnalyser();
    const compressor = context.createDynamicsCompressor();
    const gainNode = context.createGain();

    oscillator.type = 'triangle';
    oscillator.frequency.setValueAtTime(10000, context.currentTime);

    compressor.threshold.setValueAtTime(-50, context.currentTime);
    compressor.knee.setValueAtTime(40, context.currentTime);
    compressor.ratio.setValueAtTime(12, context.currentTime);
    compressor.attack.setValueAtTime(0, context.currentTime);
    compressor.release.setValueAtTime(0.25, context.currentTime);

    gainNode.gain.setValueAtTime(0, context.currentTime);

    oscillator.connect(compressor);
    compressor.connect(analyser);
    analyser.connect(gainNode);
    gainNode.connect(context.destination);

    oscillator.start(0);

    await new Promise((resolve) => setTimeout(resolve, 100));

    const frequencyData = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(frequencyData);

    oscillator.stop();
    await context.close();

    const sum = frequencyData.reduce((acc, val) => acc + val, 0);
    return simpleHash(sum.toString() + frequencyData.slice(0, 50).join(','));
  } catch {
    return 'audio-error';
  }
}

function getFontsFingerprint(): string {
  const baseFonts = ['monospace', 'sans-serif', 'serif'];
  const testFonts = [
    'Arial', 'Arial Black', 'Arial Narrow', 'Calibri', 'Cambria', 'Cambria Math',
    'Comic Sans MS', 'Consolas', 'Courier', 'Courier New', 'Georgia', 'Helvetica',
    'Impact', 'Lucida Console', 'Lucida Sans Unicode', 'Microsoft Sans Serif',
    'Palatino Linotype', 'Segoe UI', 'Tahoma', 'Times', 'Times New Roman',
    'Trebuchet MS', 'Verdana', 'Wingdings', 'Roboto', 'Open Sans', 'Lato',
    'Source Sans Pro', 'Ubuntu', 'Droid Sans', 'Noto Sans'
  ];

  const testString = 'mmmmmmmmmmlli';
  const testSize = '72px';

  const span = document.createElement('span');
  span.style.position = 'absolute';
  span.style.left = '-9999px';
  span.style.fontSize = testSize;
  span.style.lineHeight = 'normal';
  span.innerHTML = testString;
  document.body.appendChild(span);

  const baseWidths: Record<string, number> = {};
  const baseHeights: Record<string, number> = {};

  for (const baseFont of baseFonts) {
    span.style.fontFamily = baseFont;
    baseWidths[baseFont] = span.offsetWidth;
    baseHeights[baseFont] = span.offsetHeight;
  }

  const detectedFonts: string[] = [];

  for (const font of testFonts) {
    let detected = false;
    for (const baseFont of baseFonts) {
      span.style.fontFamily = `'${font}', ${baseFont}`;
      if (span.offsetWidth !== baseWidths[baseFont] || span.offsetHeight !== baseHeights[baseFont]) {
        detected = true;
        break;
      }
    }
    if (detected) {
      detectedFonts.push(font);
    }
  }

  document.body.removeChild(span);
  return simpleHash(detectedFonts.join(','));
}

function getConnectionType(): string | null {
  const connection = (navigator as any).connection || 
                     (navigator as any).mozConnection || 
                     (navigator as any).webkitConnection;
  return connection?.effectiveType || null;
}

export function getOrCreatePersistentId(): string {
  try {
    let id = localStorage.getItem(DEVICE_ID_KEY);
    if (!id) {
      id = generateUUID();
      localStorage.setItem(DEVICE_ID_KEY, id);
    }
    return id;
  } catch {
    return generateUUID();
  }
}

function getSessionStorageId(): string {
  try {
    let id = sessionStorage.getItem(SESSION_ID_KEY);
    if (!id) {
      id = generateUUID();
      sessionStorage.setItem(SESSION_ID_KEY, id);
    }
    return id;
  } catch {
    return generateUUID();
  }
}

function getCookie(name: string): string | null {
  const value = `; ${document.cookie}`;
  const parts = value.split(`; ${name}=`);
  if (parts.length === 2) {
    return parts.pop()?.split(';').shift() || null;
  }
  return null;
}

function setCookie(name: string, value: string, days: number = 365): void {
  const expires = new Date(Date.now() + days * 864e5).toUTCString();
  document.cookie = `${name}=${value}; expires=${expires}; path=/; SameSite=Lax`;
}

function getCookieId(): string {
  let id = getCookie(COOKIE_ID_KEY);
  if (!id) {
    id = generateUUID();
    setCookie(COOKIE_ID_KEY, id);
  }
  return id;
}

export async function collectFingerprint(): Promise<FingerprintSignals> {
  const browserSignals = collectBrowserSignals();
  const screenSignals = collectScreenSignals();
  const hardwareSignals = collectHardwareSignals();
  
  const canvasHash = getCanvasFingerprint();
  const webglData = getWebGLFingerprint();
  const audioHash = await getAudioFingerprint();
  const fontsHash = getFontsFingerprint();
  const connectionType = getConnectionType();
  
  const localStorageId = getOrCreatePersistentId();
  const sessionStorageId = getSessionStorageId();
  const cookieId = getCookieId();

  return {
    ...browserSignals,
    ...screenSignals,
    ...hardwareSignals,
    canvasHash,
    webglVendor: webglData.vendor,
    webglRenderer: webglData.renderer,
    webglHash: webglData.hash,
    audioHash,
    fontsHash,
    connectionType,
    localStorageId,
    sessionStorageId,
    cookieId,
  };
}

export async function generateFingerprintHash(signals: FingerprintSignals): Promise<string> {
  const signalString = [
    signals.userAgent,
    signals.platform,
    signals.language,
    signals.languages,
    signals.timezone,
    signals.timezoneOffset.toString(),
    signals.screenWidth.toString(),
    signals.screenHeight.toString(),
    signals.screenColorDepth.toString(),
    signals.devicePixelRatio.toString(),
    signals.hardwareConcurrency.toString(),
    (signals.deviceMemory ?? 'null').toString(),
    signals.maxTouchPoints.toString(),
    signals.canvasHash,
    signals.webglVendor,
    signals.webglRenderer,
    signals.webglHash,
    signals.audioHash,
    signals.fontsHash,
  ].join('|');

  return sha256(signalString);
}
