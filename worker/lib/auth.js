// Sesion por cookie firmada HMAC-SHA256, 12h de expiracion. Usa Web Crypto
// (crypto.subtle), disponible tanto en Cloudflare Workers como en Node >=19,
// para poder testear con `node --test` sin mocks de runtime.
//
// Formato de la cookie: base64url(payloadJson) + '.' + base64url(firma).
// El wiring con hono/cookie (setCookie/getCookie) y el guard de rutas vive en
// worker/routes/auth.js (Batch 6); este modulo es la primitiva pura de
// firmar/verificar + politica de PIN maestro.

import { timingSafeEqual } from './seguridad.js';

export const MAX_EDAD_MS = 12 * 60 * 60 * 1000; // 12 horas

function base64UrlEncode(bytes) {
  let binario = '';
  for (const b of bytes) binario += String.fromCharCode(b);
  return btoa(binario).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(str) {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/').padEnd(str.length + ((4 - (str.length % 4)) % 4), '=');
  const binario = atob(padded);
  const bytes = new Uint8Array(binario.length);
  for (let i = 0; i < binario.length; i++) bytes[i] = binario.charCodeAt(i);
  return bytes;
}

async function importarClaveHmac(secreto) {
  return crypto.subtle.importKey('raw', new TextEncoder().encode(secreto), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ]);
}

/** Firma un payload de sesion, agregando `exp` (ahora + 12h). Retorna el valor listo para la cookie. */
export async function firmarSesion(payload, secreto, ahora = Date.now()) {
  const data = { ...payload, exp: ahora + MAX_EDAD_MS };
  const payloadTexto = JSON.stringify(data);
  const payloadB64 = base64UrlEncode(new TextEncoder().encode(payloadTexto));

  const clave = await importarClaveHmac(secreto);
  const firma = await crypto.subtle.sign('HMAC', clave, new TextEncoder().encode(payloadB64));
  const firmaB64 = base64UrlEncode(new Uint8Array(firma));

  return `${payloadB64}.${firmaB64}`;
}

/** Verifica la firma y expiracion de una cookie de sesion. Retorna el payload o null. */
export async function verificarSesion(valorCookie, secreto) {
  if (!valorCookie || typeof valorCookie !== 'string' || !valorCookie.includes('.')) {
    return null;
  }

  const [payloadB64, firmaB64] = valorCookie.split('.');
  if (!payloadB64 || !firmaB64) return null;

  try {
    const clave = await importarClaveHmac(secreto);
    const firmaValida = await crypto.subtle.verify(
      'HMAC',
      clave,
      base64UrlDecode(firmaB64),
      new TextEncoder().encode(payloadB64),
    );
    if (!firmaValida) return null;

    const data = JSON.parse(new TextDecoder().decode(base64UrlDecode(payloadB64)));
    if (data.exp && Date.now() > data.exp) return null;
    return data;
  } catch {
    return null;
  }
}

/** true si `pinIngresado` coincide con el PIN maestro configurado (comparacion en tiempo constante). */
export function pinValido(pinIngresado, pinConfigurado) {
  return Boolean(pinConfigurado) && timingSafeEqual(String(pinIngresado), String(pinConfigurado));
}
